import {check,text} from './common.mjs';
import {analyzeInstrument,parseCsv} from './instrument.mjs';

export const elisaAssays=['il6','il10','tnfa','il1b','ifng'];
export const elisaFormula='y = A + (D − A) / (1 + (C / x)^B)^G；4PL 固定 G=1；C 为尺度参数，5PL 时不一定为半最大浓度。';
const average=values=>values.reduce((total,value)=>total+value,0)/values.length;
function numeric(value,label,minimum,maximum){
  const raw=String(value??'').trim();check(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw),label+'需要十进制数值。');
  const number=Number(raw);check(Number.isFinite(number)&&number>=minimum&&number<=maximum,label+'超出支持范围。');return number;
}
function fraction(logConcentration,parameters){
  if(logConcentration===-Infinity)return 0;
  const exponent=Math.exp(parameters[1])*(parameters[0]-logConcentration);
  const softplus=Math.max(0,exponent)+Math.log1p(Math.exp(-Math.abs(exponent)));
  return Math.exp(-Math.exp(parameters[2]??0)*softplus);
}
export function elisaResponse(concentration,curve){
  const proportion=fraction(concentration===0?-Infinity:Math.log(concentration),[Math.log(curve.C),Math.log(curve.B),Math.log(curve.G)]);
  return curve.A+(curve.D-curve.A)*proportion;
}
function simplex(initial,objective){
  let vertices=[initial,...initial.map((value,index)=>initial.map((other,position)=>other+(index===position?0.35:0)))].map(parameters=>({parameters,score:objective(parameters).score}));
  let converged=false;
  for(let iteration=0;iteration<260;iteration++){
    vertices.sort((first,second)=>first.score-second.score);const best=vertices[0],worst=vertices.at(-1),dimensions=initial.length;
    if(worst.score-best.score<1e-13&&Math.max(...vertices.flatMap(vertex=>vertex.parameters.map((value,index)=>Math.abs(value-best.parameters[index]))))<0.0001){converged=true;break;}
    const center=initial.map((value,index)=>average(vertices.slice(0,-1).map(vertex=>vertex.parameters[index])));
    const candidate=factor=>{const parameters=center.map((value,index)=>value+factor*(value-worst.parameters[index]));return {parameters,score:objective(parameters).score};};
    const reflected=candidate(1);
    if(reflected.score<best.score){const expanded=candidate(2);vertices[dimensions]=expanded.score<reflected.score?expanded:reflected;}
    else if(reflected.score<vertices[dimensions-1].score)vertices[dimensions]=reflected;
    else{
      const contracted=candidate(reflected.score<worst.score?0.5:-0.5);
      if(contracted.score<Math.min(worst.score,reflected.score))vertices[dimensions]=contracted;
      else vertices=vertices.map((vertex,index)=>{if(!index)return vertex;const parameters=vertex.parameters.map((value,position)=>(value+best.parameters[position])/2);return {parameters,score:objective(parameters).score};});
    }
  }
  vertices.sort((first,second)=>first.score-second.score);return {...vertices[0],converged};
}
function fitCurve(points,model,direction){
  const positives=points.filter(point=>point.concentration>0),logs=positives.map(point=>Math.log(point.concentration)),minimum=Math.min(...logs),maximum=Math.max(...logs);
  const responses=points.map(point=>point.mean_od),offset=Math.min(...responses),scale=Math.max(...responses)-offset;
  check(scale>1e-10,'标准品响应无有效变化，不能拟合曲线。');
  const normalized=responses.map(value=>(value-offset)/scale),meanY=average(normalized),coordinates=points.map(point=>point.concentration===0?-Infinity:Math.log(point.concentration));
  const limits=[[minimum-6.9,maximum+6.9],[Math.log(0.1),Math.log(10)],[Math.log(0.2),Math.log(5)]];
  function objective(parameters){
    if(parameters.some((value,index)=>!Number.isFinite(value)||value<limits[index][0]||value>limits[index][1]))return {score:Infinity};
    const fractions=coordinates.map(value=>fraction(value,parameters)),meanX=average(fractions),variance=fractions.reduce((total,value)=>total+(value-meanX)**2,0);
    if(variance<1e-15)return {score:Infinity};
    const span=fractions.reduce((total,value,index)=>total+(value-meanX)*(normalized[index]-meanY),0)/variance;
    if(direction==='increasing'?span<=0:span>=0)return {score:Infinity};
    const intercept=meanY-span*meanX,score=fractions.reduce((total,value,index)=>total+(normalized[index]-intercept-span*value)**2,0);
    return {score,A:offset+scale*intercept,D:offset+scale*(intercept+span)};
  }
  const seeds=[0.25,0.5,0.75].flatMap(position=>[0.8,1.6].map(slope=>[minimum+(maximum-minimum)*position,Math.log(slope)]));
  let fitted=seeds.map(seed=>simplex(seed,objective)).filter(item=>item.converged&&Number.isFinite(item.score)).sort((first,second)=>first.score-second.score)[0];
  check(fitted,'4PL 数值拟合未收敛，请检查标准品或补充浓度范围。');
  if(model==='5pl'){
    const seed=fitted.parameters;
    fitted=[0.4,1,2.5].map(shape=>simplex([...seed,Math.log(shape)],objective)).filter(item=>item.converged&&Number.isFinite(item.score)).sort((first,second)=>first.score-second.score)[0];
    check(fitted,'5PL 数值拟合未收敛；请检查数据，或在实验前提允许时选择 4PL。');
  }
  check(!fitted.parameters.some((value,index)=>Math.min(value-limits[index][0],limits[index][1]-value)<0.002),'拟合参数达到工程约束边界，当前数据不足以稳定估计此模型。');
  const profile=objective(fitted.parameters),parameters=fitted.parameters;
  const residualSS=profile.score*scale**2,totalSS=responses.reduce((total,value)=>total+(value-average(responses))**2,0);
  return {model,A:profile.A,D:profile.D,C:Math.exp(parameters[0]),B:Math.exp(parameters[1]),G:model==='4pl'?1:Math.exp(parameters[2]),r_squared:1-residualSS/totalSS,rmse:Math.sqrt(residualSS/points.length),residual_ss:residualSS,weighting:'unweighted_concentration_means',converged:true,min_concentration:points[0].concentration,max_concentration:points.at(-1).concentration,positive_min_concentration:positives[0].concentration,points};
}
function inverse(response,curve){
  const proportion=(response-curve.A)/(curve.D-curve.A);
  if(proportion===0&&curve.min_concentration===0)return 0;
  if(!(proportion>0&&proportion<1))return null;
  const value=Math.exp(Math.log(curve.C)-Math.log(Math.expm1(-Math.log(proportion)/curve.G))/curve.B);
  return Number.isFinite(value)?value:null;
}
export function analyzeElisa(payload,assays){
  check(elisaAssays.includes(payload.assay_id),'ELISA 曲线模式仅支持细胞因子 ELISA，不可用于细胞活性或酶活性换算。');
  check(['4pl','5pl'].includes(payload.model),'请选择 4PL 或 5PL。');check(['increasing','decreasing'].includes(payload.curve_direction),'请选择曲线方向。');
  check(payload.assumptions_confirmed===true,'请先确认实际试剂盒的曲线、数据校正与稀释前提。');
  const unit=text(payload.unit,40,'浓度单位',true).trim(),raw=text(payload.csv,200000,'ELISA 数据',true);
  const source=parseCsv(raw,['sample_id','role','od','standard_concentration','dilution'],raw.split(/\r?\n/)[0].includes('\t')?'\t':',');check(source.length<=512,'ELISA 每批最多 512 条读数。');
  const keys=Object.keys(source[0]),csv=[keys,...source.map(row=>keys.map(key=>row[key]))].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\n');
  const base=analyzeInstrument({...payload,csv},assays),dilutions=new Map();
  for(const row of source){
    if(!['sample','control'].includes(row.role.trim().toLowerCase()))continue;
    const id=row.sample_id.trim(),dilution=numeric(row.dilution,'样本稀释倍数',1,1e9);
    check(!dilutions.has(id)||dilutions.get(id)===dilution,'同一样本 ID 的稀释倍数不一致，请使用不同 ID 记录不同稀释。');dilutions.set(id,dilution);
  }
  check(dilutions.size>0,'请至少提供一个未知样本或对照，并明确稀释倍数（未稀释填 1）。');
  const levels=new Map();for(const row of base.rows.filter(row=>row.role==='standard')){const concentration=row.standard_concentration;if(!levels.has(concentration))levels.set(concentration,[]);levels.get(concentration).push(row.corrected_od);}
  const points=[...levels].sort((first,second)=>first[0]-second[0]).map(([concentration,values])=>({concentration,mean_od:average(values),n:values.length}));
  const required=payload.model==='4pl'?6:8;
  check(points.length>=required&&points.length<=32&&points.filter(point=>point.concentration>0).length>=required-1,`${payload.model.toUpperCase()} 需至少 ${required} 个不同浓度（最多 32 个），其中至少 ${required-1} 个为正浓度；blank 不自动算作零标准。`);
  const curve=fitCurve(points,payload.model,payload.curve_direction),sign=payload.curve_direction==='increasing'?1:-1;
  const minimumResponse=elisaResponse(curve.min_concentration,curve),maximumResponse=elisaResponse(curve.max_concentration,curve);
  for(const point of points){point.fitted_od=elisaResponse(point.concentration,curve);point.residual=point.mean_od-point.fitted_od;point.back_calculated_concentration=inverse(point.mean_od,curve);point.recovery_percent=point.concentration>0&&point.back_calculated_concentration!==null?point.back_calculated_concentration/point.concentration*100:null;}
  const groups=base.groups.map(group=>{
    const dilution=dilutions.get(group.sample_id)??null,result={...group,dilution,curve_concentration:null,concentration:null,range_status:'not_applicable'};
    if(dilution===null)return result;
    const tolerance=1e-9*Math.max(1,Math.abs(minimumResponse),Math.abs(maximumResponse));
    if(sign*(group.mean_od-minimumResponse)<-tolerance)result.range_status='below_standard_range';
    else if(sign*(group.mean_od-maximumResponse)>tolerance)result.range_status='above_standard_range';
    else{const concentration=inverse(group.mean_od,curve);if(concentration!==null&&concentration>=0&&concentration>=curve.min_concentration-1e-6&&concentration<=curve.max_concentration*(1+1e-6)){result.range_status='within_standard_range';result.curve_concentration=Math.max(curve.min_concentration,Math.min(curve.max_concentration,concentration));result.concentration=result.curve_concentration*dilution;}else result.range_status='not_invertible';}
    if(result.concentration===null)result.warnings.push('不在本批次标准曲线可反算范围内；未外推、未填 0，请按实际方案调整稀释或复测。');return result;
  });
  const warnings=[...base.warnings.filter(warning=>warning!==base.disclaimer),'仅对同一批次的各标准浓度平均 OD 等权拟合；先平均样本技术孔 OD，再反算并乘稀释倍数，不提供浓度 SD、置信区间或生物学显著性。','标准浓度区间不是经验证的 LLOQ / ULOQ；R² 高不代表试剂盒有效。没有自动剔除异常孔、拟合加权、回收率合格判定或跨批次校准。'];
  if(curve.r_squared<0.98)warnings.push('R² < 0.98 工程提醒：请检查残差与标准品；此阈值不是检测合格标准。');
  if(points.some((point,index)=>index>0&&sign*(point.mean_od-points[index-1].mean_od)<0))warnings.push('标准浓度与响应存在逆序，请检查标准品和读数；未自动删除数据。');
  return {...base,measurement:'elisa',algorithm:'elisa-js-1',model:payload.model,curve_direction:payload.curve_direction,unit,formula:elisaFormula,curve,groups,warnings,concentration_estimation:'current_batch_standard_curve',disclaimer:'本批次标准品数学反算，不认证试剂盒或实验有效性。非临床用途。',provenance:'服务器独立重新计算标准曲线、样本平均 OD 反算及用户声明的稀释换算；不是 AI 生成数据。'};
}
export function elisaDemo(assayId='il6'){
  check(elisaAssays.includes(assayId),'请选择支持的细胞因子 ELISA 方法。');
  const rows=['sample_id,role,well,od,reference_od,standard_concentration,dilution','Blank,blank,A1,0.05,,,'];
  let serial=1;for(const concentration of [0,1,5,15,50,150,500,2000])for(let replicate=0;replicate<2;replicate++){const well=String.fromCharCode(65+Math.floor(serial/12))+(serial%12+1);serial++;rows.push(`STD-${concentration},standard,${well},${0.15+1.8*concentration/(50+concentration)},,${concentration},`);}
  rows.push('Sample-A,sample,C1,0.75,,,4','Sample-A,sample,C2,0.75,,,4','Too-high,sample,C3,2.3,,,1');
  return {assay_id:assayId,quantification:'elisa',model:'4pl',curve_direction:'increasing',csv:rows.join('\n'),unit:'pg/mL',wavelength:450,reference_wavelength:null,subtract_blank:true,simulated:true,assumptions_confirmed:false,filename:'SIMULATED-ELISA.csv'};
}
