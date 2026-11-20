import {check,text} from './common.mjs';
import {parseCsv} from './instrument.mjs';

export const qpcrMethods={dct:'内参归一化 · 2^(-ΔCt)',ddct:'相对表达倍数 · 2^(-ΔΔCt)',efficiency:'等效率校正 · (1+效率)^(-ΔΔCt)',pfaffl:'Pfaffl · 目标/内参不同效率',standard:'标准曲线 · 已知标准品模板量'};
export const qpcrAssay={id:'qpcr',name:'qPCR / RT-qPCR 表达量分析',category:'核酸与基因表达',principle:'Ct / ΔCt 归一化、相对表达及标准曲线',wavelength:null,reference:'Livak & Schmittgen 2001；Pfaffl 2001；Thermo Fisher 标准曲线说明',source_url:'https://apps.thermofisher.com/apps/help/MAN0010504/GUID-3B1F905C-88BF-49E0-A1E3-B4C8A2F61AAC.html',note:'相对倍数不是绝对拷贝数。ΔCt 定义为目标 Ct−内参 Ct；不同方法需要不同输入和效率前提。',photo_allowed:false,instrument_allowed:true,preferred_path:'instrument',species:'按实际样本填写',verified_on:'2026-10-20',validation:'已核对公式；未用真实实验验证检测性能',concentration_enabled:false};
export const qpcrNotice='仅根据输入计算。ΔCt=目标基因 Ct−内参 Ct；未检查原始扩增/熔解曲线、NTC、检出限、RNA质量、内参稳定性或实验设计。未计算 p 值或统计显著性，技术孔不等于独立生物重复；非临床用途。';
const average=values=>values.reduce((total,value)=>total+value,0)/values.length;
const deviation=values=>values.length<2?null:Math.sqrt(values.reduce((total,value)=>total+(value-average(values))**2,0)/(values.length-1));
function numeric(value,label,minimum=-100,maximum=100){
  const raw=String(value??'').trim();
  check(raw&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw),label+' 需为有限数值；Undetermined、未扩增、空白不能当作 0。');
  const result=Number(raw);check(Number.isFinite(result)&&result>=minimum&&result<=maximum,label+' 超出本版支持范围。');return result;
}
const ct=(value,label)=>{const result=numeric(value,label,0,100);check(result>0,label+' 必须大于 0，不能用 0 代替未扩增。');return result;};
const finitePositive=value=>{check(Number.isFinite(value)&&value>0,'计算超出数值范围，请检查 Ct、扩增效率和标准曲线。');return value;};
const name=(value,label,defaultValue='')=>text(value??defaultValue,80,label,true).trim();
function csv(raw,columns){return parseCsv(raw,columns,String(raw).split(/\r?\n/)[0].includes('\t')?'\t':',');}
function curveFit(raw,targetDefault){
  const byTarget=new Map();
  for(const row of csv(raw,['quantity','ct'])){
    const target=name(row.target,'标准品目标基因',targetDefault),quantity=numeric(row.quantity,'标准品 quantity',Number.MIN_VALUE,1e15),value=ct(row.ct,'标准品 Ct');
    if(!byTarget.has(target))byTarget.set(target,new Map());const levels=byTarget.get(target);
    if(!levels.has(quantity))levels.set(quantity,[]);levels.get(quantity).push(value);
  }
  return [...byTarget].map(([target,levels])=>{
    check(levels.size>=3,`${target} 至少需要 3 个不同的正数标准品数量；重复同一浓度不算多个浓度。`);
    const points=[...levels].map(([quantity,values])=>({quantity,log10_quantity:Math.log10(quantity),ct:average(values),technical_n:values.length}));
    const meanLog=average(points.map(point=>point.log10_quantity)),meanCt=average(points.map(point=>point.ct));
    const variance=points.reduce((total,point)=>total+(point.log10_quantity-meanLog)**2,0);
    const slope=points.reduce((total,point)=>total+(point.log10_quantity-meanLog)*(point.ct-meanCt),0)/variance,intercept=meanCt-slope*meanLog;
    check(Number.isFinite(slope)&&slope< -1e-8,'标准曲线斜率必须为负数且不能接近 0。');
    const totalSquares=points.reduce((total,point)=>total+(point.ct-meanCt)**2,0),residuals=points.reduce((total,point)=>total+(point.ct-(slope*point.log10_quantity+intercept))**2,0);
    check(totalSquares>0,'标准品 Ct 没有可拟合的变化。');
    const efficiency=(10**(-1/slope)-1)*100;check(Number.isFinite(efficiency)&&efficiency>0,'标准曲线效率超出计算范围。');
    return {target,slope,intercept,r_squared:Math.max(0,Math.min(1,1-residuals/totalSquares)),efficiency_percent:efficiency,min_quantity:Math.min(...points.map(point=>point.quantity)),max_quantity:Math.max(...points.map(point=>point.quantity)),points,fit:'各浓度技术孔先平均 Ct，再按浓度等权最小二乘：Ct=slope×log10(quantity)+intercept'};
  });
}

export function analyzeQpcr(payload){return payload.input_type==='multi_ct'?analyzeMultiQpcr(payload):analyzeQpcrCore(payload);}
function analyzeQpcrCore(payload,referenceFactors=null){
  check(typeof payload.method==='string'&&Object.hasOwn(qpcrMethods,payload.method),'请选择支持的 qPCR 计算方法。');
  const method=payload.method,absolute=method==='standard',comparison=['ddct','efficiency','pfaffl'].includes(method),inputType=payload.input_type;
  check(['dct','ct'].includes(inputType),'输入类型应为 ΔCt 或原始 Ct。');
  check(!['pfaffl','standard'].includes(method)||inputType==='ct','Pfaffl 和标准曲线法需要原始 Ct，不能只用 ΔCt。');
  check(payload.assumptions_confirmed===true,'请先确认 ΔCt 定义、所选方法的效率前提及数据来源。');
  check(typeof payload.simulated==='boolean','请明确数据是否为模拟。');
  const targetDefault=name(payload.target_gene,'目标基因','目标基因'),referenceGene=absolute?'':text(payload.reference_gene??'',80,'内参基因').trim();
  check(!(!absolute&&inputType==='ct'&&!referenceGene),'使用原始 Ct 归一化时请填写内参基因。');
  const replicateKind=payload.replicate_kind??'unknown';check(['biological','technical','unknown'].includes(replicateKind),'请选择重复类型。');
  const calibration=payload.calibration??'group';check(['group','paired'].includes(calibration),'请选择组均值或配对校准。');
  const controlGroup=comparison?name(payload.control_group,'对照组名称'):null;
  const targetEfficiency=['efficiency','pfaffl'].includes(method)?numeric(payload.target_efficiency,'目标扩增效率（百分数）',Number.MIN_VALUE,200):100;
  const referenceEfficiency=method==='pfaffl'?numeric(payload.reference_efficiency,'内参扩增效率（百分数）',Number.MIN_VALUE,200):targetEfficiency;
  const source=csv(payload.csv,inputType==='dct'?['sample_id','group','delta_ct']:absolute?['sample_id','group','ct_target']:['sample_id','group','ct_target','ct_reference']);
  check(source.length<=512,'qPCR 每次最多 512 行输入，请分批分析。');
  const samples=new Map();
  for(const row of source){
    const target=name(row.target,'目标基因',targetDefault),sampleId=name(row.sample_id,'样本 ID'),group=name(row.group,'组名'),pairId=text(row.pair_id??'',80,'配对 ID').trim();
    const targetCt=inputType==='ct'?ct(row.ct_target,'目标 Ct'):null,referenceCt=inputType==='ct'&&!absolute?ct(row.ct_reference,'内参 Ct'):null;
    const deltaCt=absolute?null:inputType==='dct'?numeric(row.delta_ct,'ΔCt'):targetCt-referenceCt;
    const key=JSON.stringify([target,sampleId]);
    if(!samples.has(key))samples.set(key,{target,sample_id:sampleId,group,pair_id:pairId,values:[],target_values:[],reference_values:[]});
    const sample=samples.get(key);check(sample.group===group&&sample.pair_id===pairId,'同一目标基因的同一样本 ID 不能跨组或使用不同配对 ID；独立样本请使用不同 ID。');
    if(deltaCt!==null)sample.values.push(deltaCt);if(targetCt!==null)sample.target_values.push(targetCt);if(referenceCt!==null)sample.reference_values.push(referenceCt);
  }
  const rows=[...samples.values()].map(sample=>({target:sample.target,sample_id:sample.sample_id,group:sample.group,pair_id:sample.pair_id,technical_n:Math.max(sample.values.length,sample.target_values.length),ct_target:sample.target_values.length?average(sample.target_values):null,ct_reference:sample.reference_values.length?average(sample.reference_values):null,delta_ct:sample.values.length?average(sample.values):null,technical_delta_ct_sd:deviation(sample.values),normalized_expression:null,calibrator_delta_ct:null,delta_delta_ct:null,fold_change:null,log2_fold_change:null,quantity:null,extrapolated:false,warnings:[]}));
  check(!['efficiency','pfaffl'].includes(method)||new Set(rows.map(row=>row.target)).size===1,'不同目标基因的效率不能混用；效率校正法本版请逐个目标基因分析。');
  const curves=absolute?curveFit(payload.standards_csv,targetDefault):[],calibrators=[];
  for(const row of rows){
    if(absolute){
      const curve=curves.find(item=>item.target===row.target);check(curve,`${row.target} 缺少本基因的标准曲线，不能借用其他基因的曲线。`);
      row.quantity=finitePositive(10**((row.ct_target-curve.intercept)/curve.slope));row.extrapolated=row.quantity<curve.min_quantity*(1-1e-10)||row.quantity>curve.max_quantity*(1+1e-10);
      if(row.extrapolated)row.warnings.push('超出标准品范围，是外推值；应稀释/重测或验证范围，不能当作已验证定量。');
      continue;
    }
    if(method!=='pfaffl')row.normalized_expression=finitePositive((1+targetEfficiency/100)**(-row.delta_ct));
    if(!comparison)continue;
    if(calibration==='paired')check(row.pair_id,'配对校准要求每个样本有 pair_id，不能按行号猜测配对。');
    const controls=rows.filter(item=>item.target===row.target&&item.group===controlGroup&&(calibration!=='paired'||item.pair_id===row.pair_id));
    check(controls.length,`${row.target} / ${row.pair_id||'本组'} 找不到对照组“${controlGroup}”。`);
    if(calibration==='paired')check(controls.length===1,'每个目标基因、每个配对 ID 应只有一个对照样本 ID；技术孔请使用相同样本 ID。');
    const calibrator={target:row.target,pair_id:calibration==='paired'?row.pair_id:'',sample_count:controls.length,delta_ct:average(controls.map(item=>item.delta_ct)),ct_target:inputType==='ct'?average(controls.map(item=>item.ct_target)):null,ct_reference:inputType==='ct'?average(controls.map(item=>item.ct_reference)):null};
    if(!calibrators.some(item=>item.target===calibrator.target&&item.pair_id===calibrator.pair_id))calibrators.push(calibrator);
    row.calibrator_delta_ct=calibrator.delta_ct;row.delta_delta_ct=row.delta_ct-calibrator.delta_ct;
    const referenceTerm=referenceFactors?average(controls.map(item=>referenceFactors.get(item.sample_id)))-referenceFactors.get(row.sample_id):(calibrator.ct_reference-row.ct_reference)*Math.log2(1+referenceEfficiency/100);
    row.log2_fold_change=method==='pfaffl'?(calibrator.ct_target-row.ct_target)*Math.log2(1+targetEfficiency/100)-referenceTerm:-row.delta_delta_ct*Math.log2(1+targetEfficiency/100);
    row.fold_change=finitePositive(2**row.log2_fold_change);
  }
  const grouped=new Map();for(const row of rows){const key=JSON.stringify([row.target,row.group]);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
  const groups=[...grouped.values()].map(values=>{
    const deltas=values.map(row=>row.delta_ct).filter(value=>value!==null),folds=values.map(row=>row.fold_change).filter(value=>value!==null),quantities=values.map(row=>row.quantity).filter(value=>value!==null),expressions=values.map(row=>row.normalized_expression).filter(value=>value!==null);
    return {target:values[0].target,group:values[0].group,n:values.length,biological_n:replicateKind==='biological'?values.length:null,mean_delta_ct:deltas.length?average(deltas):null,sd_delta_ct:deviation(deltas),mean_normalized_expression:expressions.length?average(expressions):null,mean_fold_change:folds.length?average(folds):null,geometric_fold_change:folds.length?finitePositive(2**average(values.map(row=>row.log2_fold_change))):null,sd_fold_change:deviation(folds),mean_quantity:quantities.length?average(quantities):null,sd_quantity:deviation(quantities),warnings:[...(values.length<2?['仅一个样本 ID，不能估计组内样本 SD。']:[]),...(replicateKind!=='biological'?['未确认独立生物重复，n 仅表示输入样本 ID 数。']:[])]};
  });
  const warnings=[qpcrNotice,'相同 target + sample_id 的行先合并技术重复；组均值对样本 ID 等权，不按技术孔数加权。均值、SD 和倍数只作描述统计；不含对照估计不确定性的置信区间。'];
  if(!absolute&&!referenceGene)warnings.push('未填写内参名称；已输入的 ΔCt 仍须由你确认基于稳定、合适的内参。');
  if(['dct','ddct'].includes(method))warnings.push('基数 2 假设目标和内参扩增效率均接近 100% 且相近；只有 ΔCt 不能验证这一前提。');
  if(method==='efficiency')warnings.push('目标和内参必须具有相同的已验证扩增效率；效率不同请改用 Pfaffl 并提供原始 Ct。');
  if(method==='dct')warnings.push('2^(-ΔCt) 只是内参归一化的相对量，不是相对处理/对照倍数，更不是绝对拷贝数。');
  if(method==='pfaffl')warnings.push('Pfaffl 使用目标与内参各自的 Ct 差和扩增效率；不把单独的 ΔCt 转成 2^(-ΔCt)。');
  if(absolute)warnings.push('标准曲线输出与标准品相同单位的模板量，未校正提取、逆转录、上样稀释或样本质量；不能直接称为每细胞 mRNA 表达量。');
  if(['efficiency','pfaffl'].includes(method)&&(targetEfficiency<90||targetEfficiency>110||referenceEfficiency<90||referenceEfficiency>110))warnings.push('输入效率在常见 90–110% 范围外，请核查标准曲线；此提示不是通用合格判定。');
  for(const curve of curves)if(curve.r_squared<0.99||curve.efficiency_percent<90||curve.efficiency_percent>110)warnings.push(`${curve.target} 的 R²/效率需要人工核查；数学拟合成功不代表定量性能合格。`);
  const unit=absolute?text(payload.quantity_unit,40,'标准品数量单位',true).trim():null;
  return {analysis_type:'instrument',measurement:'qpcr',assay:qpcrAssay,method,method_name:qpcrMethods[method],input_type:inputType,calibration:comparison?calibration:null,control_group:controlGroup,reference_gene:referenceGene,replicate_kind:replicateKind,target_efficiency:targetEfficiency,reference_efficiency:referenceEfficiency,quantity_unit:unit,rows,groups,calibrators,curves,warnings,simulated:payload.simulated,algorithm:'qpcr-js-1',significance:null,concentration_estimation:null,disclaimer:qpcrNotice,provenance:'服务器根据输入 Ct/ΔCt 重新计算；原始曲线和检测有效性未由软件验证。',formula:method==='standard'?'Ct=slope×log10(quantity)+intercept；quantity=10^((Ct−intercept)/slope)':method==='pfaffl'?'RQ=Et^(Ct目标对照−Ct目标样本)/Er^(Ct内参对照−Ct内参样本)，E=1+效率百分数/100':method==='dct'?'归一化相对量=2^(-ΔCt)':'ΔΔCt=ΔCt样本−ΔCt对照；RQ=(1+效率百分数/100)^(-ΔΔCt)；log2FC=log2(RQ)'};
}

function analyzeMultiQpcr(payload){
  check(['dct','ddct','efficiency','pfaffl'].includes(payload.method),'多内参原始 Ct 支持相对归一化；标准曲线法不使用此模式。');
  const referenceSource=csv(text(payload.reference_genes_csv,20000,'多内参配置',true),['gene','efficiency_percent']);
  check(referenceSource.length>=2&&referenceSource.length<=5,'请选择 2–5 个已验证的内参基因。');
  const references=new Map();
  for(const row of referenceSource){const gene=name(row.gene,'内参基因');check(!references.has(gene),'内参基因不能重复。');references.set(gene,{gene,efficiency_percent:numeric(row.efficiency_percent,'内参效率（百分数）',0.000001,200)});}
  const commonEfficiency=payload.method==='efficiency'?numeric(payload.target_efficiency,'共同扩增效率（百分数）',0.000001,200):100;
  if(['dct','ddct'].includes(payload.method))check([...references.values()].every(item=>item.efficiency_percent===100),'2^(-ΔCt) / 2^(-ΔΔCt) 要求每个内参的模型效率为 100%；实际效率不同请选 Pfaffl。');
  if(payload.method==='efficiency')check([...references.values()].every(item=>item.efficiency_percent===commonEfficiency),'等效率方法要求目标与每个内参具有相同效率；不同效率请选 Pfaffl。');
  const source=csv(text(payload.csv,200000,'多内参原始 Ct',true),['sample_id','group','gene','ct']);check(source.length<=512,'qPCR 每次最多 512 行输入，请分批分析。');
  const samples=new Map(),wells=new Set(),geneRows=[];
  for(const row of source){
    const sampleId=name(row.sample_id,'样本 ID'),group=name(row.group,'组名'),gene=name(row.gene,'基因名'),pairId=text(row.pair_id??'',80,'配对 ID').trim(),value=ct(row.ct,'原始 Ct');
    const plateId=text(row.plate_id??'',80,'板次').trim(),rawWell=text(row.well??'',30,'孔位').trim().toUpperCase();let well=rawWell;
    if(well){const match=/^([A-P])0*([1-9]|1\d|2[0-4])$/.exec(well);check(match,'孔位需为 A1–P24 范围内的常规孔号。');well=match[1]+Number(match[2]);const key=JSON.stringify([plateId,well]);check(!wells.has(key),'同一板次孔位重复，请检查导入表。');wells.add(key);}
    if(!samples.has(sampleId))samples.set(sampleId,{sample_id:sampleId,group,pair_id:pairId,genes:new Map()});const sample=samples.get(sampleId);
    check(sample.group===group&&sample.pair_id===pairId,'同一样本 ID 跨基因的组名与配对 ID 必须一致。');
    if(!sample.genes.has(gene))sample.genes.set(gene,[]);sample.genes.get(gene).push(value);
    geneRows.push({sample_id:sampleId,group,pair_id:pairId,gene,role:references.has(gene)?'reference':'target',ct:value,plate_id:plateId,well});
  }
  const targets=[...new Set(geneRows.filter(row=>row.role==='target').map(row=>row.gene))];check(targets.length>0,'长表需至少包含一个非内参的目标基因。');
  check(!['efficiency','pfaffl'].includes(payload.method)||targets.length===1,'效率校正模式请逐个目标基因分析，避免混用目标效率。');
  const referenceSummary=[],geneSummary=[],factors=new Map(),normalizedRows=[];
  for(const sample of samples.values()){
    for(const gene of [...references.keys(),...targets])check(sample.genes.has(gene),`${sample.sample_id} 缺少 ${gene} 的有效原始 Ct，不能跳过或用其他样本代替。`);
    for(const [gene,values] of sample.genes){const summary={sample_id:sample.sample_id,group:sample.group,pair_id:sample.pair_id,gene,role:references.has(gene)?'reference':'target',mean_ct:average(values),technical_n:values.length,ct_sd:deviation(values)};geneSummary.push(summary);if(references.has(gene))referenceSummary.push({...summary,efficiency_percent:references.get(gene).efficiency_percent});}
    const referenceMeans=[...references.values()].map(reference=>({ct:average(sample.genes.get(reference.gene)),efficiency:reference.efficiency_percent}));
    const meanReferenceCt=average(referenceMeans.map(reference=>reference.ct));factors.set(sample.sample_id,average(referenceMeans.map(reference=>reference.ct*Math.log2(1+reference.efficiency/100))));
    for(const target of targets)normalizedRows.push([sample.sample_id,sample.group,target,sample.pair_id,average(sample.genes.get(target)),meanReferenceCt]);
  }
  const quoted=value=>'"'+String(value).replaceAll('"','""')+'"';
  const normalizedCsv=[['sample_id','group','target','pair_id','ct_target','ct_reference'],...normalizedRows].map(row=>row.map(quoted).join(',')).join('\n');
  const result=analyzeQpcrCore({...payload,csv:normalizedCsv,input_type:'ct',reference_gene:'多内参综合值（见逐基因表）',reference_efficiency:100},payload.method==='pfaffl'?factors:null);
  for(const row of result.rows){
    row.technical_n=samples.get(row.sample_id).genes.get(row.target).length;row.technical_delta_ct_sd=null;
    row.reference_normalization_log2=-factors.get(row.sample_id);
    if(payload.method==='pfaffl')for(const key of ['ct_reference','delta_ct','calibrator_delta_ct','delta_delta_ct'])row[key]=null;
  }
  if(payload.method==='pfaffl'){
    for(const group of result.groups){group.mean_delta_ct=null;group.sd_delta_ct=null;}
    for(const calibrator of result.calibrators){calibrator.delta_ct=null;calibrator.ct_reference=null;}
  }
  result.warnings.push('多内参按每个样本、每个基因先平均技术孔 Ct，再对内参的相对量取等权几何均值；不是对 Ct 本身取几何均值，也不按各内参孔数加权。','内参配置由用户指定，未运行 geNorm / NormFinder 或自动验证内参稳定性；选择多个基因不等于已经消除偏差。','逐基因技术孔可不等数，未按孔号配对或推算 ΔCt 技术 SD；技术孔汇总表与原始长表保留。');
  if(payload.method==='pfaffl')result.warnings.push('多内参效率不同：按每个内参效率分别计算几何归一化；不报告单一内参效率、平均内参 Ct 或传统 ΔCt/ΔΔCt。');
  if([...references.values()].some(reference=>reference.efficiency_percent<90||reference.efficiency_percent>110))result.warnings.push('至少一个内参效率在常见 90–110% 外；请核查实际实验验证，此范围不是通用合格判定。');
  if(new Set(geneRows.map(row=>row.plate_id).filter(Boolean)).size>1)result.warnings.push('长表包含多个板次：板次/孔位仅用于追溯，未做跨板校准。请确认这些 Ct 已按实际实验设计验证可比较，不能由此宣称批次效应已消除。');
  return {...result,input_type:'multi_ct',algorithm:'qpcr-multiref-js-1',method_name:result.method_name+' · 多内参',reference_gene:[...references.keys()].join(' + '),reference_efficiency:null,reference_config:[...references.values()],reference_summary:referenceSummary,gene_summary:geneSummary,gene_rows:geneRows,raw_input_rows:source.length,normalization:'geometric_reference_quantities',formula:payload.method==='pfaffl'?'RQ = Et^(Ct目标对照−Ct目标样本) / GM_j(Er_j^(Ct内参j对照−Ct内参j样本))；每个基因先平均技术孔 Ct，内参等权几何归一化。':payload.method==='dct'?'归一化相对量 = 2^(-(平均Ct目标−内参Ct算术均值))；等价于目标相对量 / GM(各内参相对量)，不是绝对表达量。':'ΔCt = 平均Ct目标−内参Ct算术均值；ΔΔCt = ΔCt样本−ΔCt对照；RQ = E^(-ΔΔCt)，E=1+共同效率百分数/100；等价于相对量的多内参几何归一化。',provenance:'服务器根据原始长表及用户声明的逐内参效率计算；未自动选择/验证稳定内参，未传播效率误差或校正跨板偏差。'};
}

export function qpcrDemo(inputType){
  if(inputType==='multi_ct'){
    const lines=['sample_id,group,gene,ct,pair_id,plate_id,well'];let serial=0;
    for(const [sample,group,pair,genes] of [['C1','对照组','P1',{IL6:[25.9,26.1],GAPDH:[20,20,20],ACTB:[22]}],['C2','对照组','P2',{IL6:[27],GAPDH:[21],ACTB:[23]}],['T1','处理组','P1',{IL6:[24,24],GAPDH:[21],ACTB:[21]}],['T2','处理组','P2',{IL6:[25],GAPDH:[22],ACTB:[22]}]])for(const [gene,values] of Object.entries(genes))for(const value of values){const well=String.fromCharCode(65+Math.floor(serial/12))+(serial%12+1);serial++;lines.push([sample,group,gene,value,pair,'SIMULATED-plate',well].join(','));}
    return {...qpcrDemo(),input_type:'multi_ct',csv:lines.join('\n'),reference_genes_csv:'gene,efficiency_percent\nGAPDH,100\nACTB,100',filename:'SIMULATED-qpcr-multiref.csv'};
  }
  return {csv:'sample_id,group,target,delta_ct\nC1,对照组,IL6,6\nC2,对照组,IL6,6\nT1,处理组,IL6,4\nT2,处理组,IL6,4',assay_id:'qpcr',method:'ddct',input_type:'dct',target_gene:'IL6',reference_gene:'GAPDH',control_group:'对照组',replicate_kind:'biological',calibration:'group',target_efficiency:100,reference_efficiency:100,assumptions_confirmed:true,simulated:true,filename:'SIMULATED-qpcr.csv'};
}
