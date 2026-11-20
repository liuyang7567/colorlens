import {check,text} from './common.mjs';
export const instrumentNotice='仅整理用户提供的仪器读数与重复孔统计；未计算浓度、细胞活率、抑制率或酶活性。标准品浓度为用户输入，未拟合校准曲线。';
export function parseCsv(raw,requiredColumns=['sample_id','role','od'],delimiter=',') {
  check(typeof raw==='string' && raw.trim() && new TextEncoder().encode(raw).length<=2000000,'请提供 2 MB 以内的 CSV。');
  const records=[];
  let row=[], field='', quoted=false, closed=false;
  const source=raw.replace(/^\uFEFF/,'');
  for (let index=0;index<source.length;index++) {
    const character=source[index];
    if (quoted) {
      if (character==='"' && source[index+1]==='"') { field+='"'; index++; }
      else if (character==='"') { quoted=false; closed=true; }
      else field+=character;
    } else if (character==='"') { check(!field && !closed,'CSV 引号位置错误。'); quoted=true; }
    else if (character===delimiter || character==='\n' || character==='\r') {
      row.push(field); field=''; closed=false;
      if (character!==delimiter) {
        if (character==='\r' && source[index+1]==='\n') index++;
        if (row.some(value=>value.trim())) records.push(row);
        row=[];
      }
    } else { check(!closed,'CSV 引号后有多余字符。'); field+=character; }
    check(records.length<=2049,'最多支持 2048 条读数。');
  }
  check(!quoted,'CSV 引号未闭合。');
  row.push(field);
  if (row.some(value=>value.trim())) records.push(row);
  const header=records.shift()||[];
  check(requiredColumns.every(key=>header.includes(key)) && new Set(header).size===header.length,'CSV 至少需要 '+requiredColumns.join('、')+' 列，列名不能重复。');
  check(records.length>0 && records.length<=2048,'读数条数需为 1–2048。');
  return records.map((record,index)=>{check(record.length===header.length,`CSV 第 ${index+2} 行列数不匹配。`);return Object.fromEntries(header.map((key,position)=>[key,record[position]]));});
}
function numeric(value,label,optional=false) {
  const raw=String(value??'').trim();
  if (optional && !raw) return null;
  check(raw && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw),`${label} 必须为有限十进制数。`);
  const result=Number(raw);
  check(Number.isFinite(result) && Math.abs(result)<=1000000,`${label} 超出范围。`);
  return result;
}
export function analyzeInstrument(payload,assays) {
  const assay=assays.find(item=>item.id===payload.assay_id);
  check(assay?.instrument_allowed,'此方法没有定义仪器读数流程。');
  const wavelength=numeric(payload.wavelength,'主波长');
  const referenceWavelength=numeric(payload.reference_wavelength,'参考波长',true);
  check(wavelength>=200 && wavelength<=1000 && (referenceWavelength===null || referenceWavelength>=200 && referenceWavelength<=1000),'波长应在 200–1000 nm。');
  check(typeof payload.subtract_blank==='boolean' && typeof payload.simulated==='boolean','扣除空白和模拟标记无效。');
  const wells=new Set(), identities=new Map();
  const source=parseCsv(payload.csv);
  const readings=source.map(item=>{
    const sampleId=text(item.sample_id,80,'样本名',true).trim();
    const role=item.role.trim().toLowerCase();
    check(['blank','standard','sample','control'].includes(role),'role 需为 blank / standard / sample / control。');
    const well=(item.well||'').trim().slice(0,30);
    check(!well || !wells.has(well),'孔位重复，请分开不同板次导入。');
    if (well) wells.add(well);
    const concentration=numeric(item.standard_concentration,'标准品浓度',true);
    check(role!=='standard' || concentration!==null && concentration>=0,'标准品需填写非负已知浓度。');
    const identity=JSON.stringify([role,concentration]);
    check(!identities.has(sampleId)||identities.get(sampleId)===identity,'同名样本的角色或标准浓度不一致。');
    identities.set(sampleId,identity);
    const od=numeric(item.od,'OD');
    const reference=numeric(item.reference_od,'参考 OD',true);
    return {sample_id:sampleId,role,well,od,reference_od:reference,standard_concentration:concentration,reference_corrected:od-(reference||0)};
  });
  const references=readings.filter(row=>row.reference_od!==null).length;
  check(references===0||references===readings.length,'参考 OD 需全部填写或全部留空。');
  check(!references || referenceWavelength!==null && referenceWavelength!==wavelength,'参考 OD 需要不同于主波长的参考波长。');
  check(!payload.subtract_blank || assay.id!=='sod','SOD WST 法需要多类专用空白，不能简化为统一空白扣除。');
  const blanks=readings.filter(row=>row.role==='blank');
  check(!payload.subtract_blank||blanks.length,'勾选扣除空白但没有 blank 读数。');
  const blankMean=blanks.length?blanks.reduce((total,row)=>total+row.reference_corrected,0)/blanks.length:null;
  const groups=new Map();
  for (const row of readings) {
    row.corrected_od=row.reference_corrected-(payload.subtract_blank?blankMean:0);
    if (!groups.has(row.sample_id)) groups.set(row.sample_id,[]);
    groups.get(row.sample_id).push(row);
  }
  const summaries=[...groups].map(([sampleId,group])=>{
    const mean=group.reduce((total,row)=>total+row.corrected_od,0)/group.length;
    const deviation=group.length>1?Math.sqrt(group.reduce((total,row)=>total+(row.corrected_od-mean)**2,0)/(group.length-1)):null;
    const cv=deviation!==null && Math.abs(mean)>1e-12 && group[0].role!=='blank'?deviation/Math.abs(mean)*100:null;
    return {sample_id:sampleId,role:group[0].role,standard_concentration:group[0].standard_concentration,n:group.length,mean_od:mean,sd:deviation,cv_percent:cv,warnings:[...(group.length<2?['仅一个孔，不能估计重复孔离散程度']:[]),...(mean<0?['校正后均值为负，请核查空白与数据处理阶段']:[]),...(cv!==null && cv>10?['CV >10% 工程提示，是否合格需按本实验标准判断']:[])]};
  });
  const warnings=[instrumentNotice];
  if (wavelength!==assay.wavelength) warnings.push(`输入波长 ${wavelength} nm 与参考模板 ${assay.wavelength} nm 不同，请核对实际说明书。`);
  if (['sod','nadh'].includes(assay.id)) warnings.push(assay.note);
  warnings.push(payload.subtract_blank?'已执行一次统一空白扣除，请确认此前尚未扣过空白。':'未执行统一空白扣除；请说明是否已在仪器端校正。');
  return {analysis_type:'instrument',assay,catalog_version:'2026.10.19',wavelength,reference_wavelength:referenceWavelength,subtract_blank:payload.subtract_blank,blank_mean:blankMean,rows:readings,groups:summaries,simulated:payload.simulated,warnings,disclaimer:instrumentNotice,concentration_estimation:null,algorithm:'instrument-js-1'};
}
export function instrumentDemo(assay) {
  check(assay?.instrument_allowed,'请选择仪器模板。');
  const lines=['sample_id,role,well,od,reference_od,standard_concentration'];
  for (const [index,concentration] of [0,25,50,100,200].entries()) {
    const signal=.08+(assay.direction==='decreasing'?1/(1+concentration/50):concentration/180);
    for (let replicate=0;replicate<2;replicate++) lines.push(`${index?'STD-'+index:'Blank'},${index?'standard':'blank'},A${index*2+replicate+1},${(signal+replicate*.006).toFixed(4)},,${index?concentration:''}`);
  }
  for (const [index,value] of [.52,.53,.68].entries()) lines.push(`Sample-A,sample,B${index+1},${value},,`);
  return {csv:lines.join('\n'),simulated:true,wavelength:assay.wavelength,filename:'SIMULATED-instrument.csv',note:'任意构造的模拟数字，不是厂家标准曲线。'};
}
