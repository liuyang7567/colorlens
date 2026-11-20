import referenceAssays from './assays.json' with {type:'json'};
import {check,text,uid,now,sha,query,first,rows,json} from './common.mjs';
import {detail,editable,save,create,fileRow} from './notebook.mjs';
import {analyzeInstrument,instrumentDemo} from './instrument.mjs';
import {analyzeQpcr,qpcrAssay,qpcrDemo} from './qpcr.mjs';
import {analyzeElisa,elisaDemo} from './elisa.mjs';
const assays=[...referenceAssays,qpcrAssay];
const calculate=payload=>payload.assay_id==='qpcr'?analyzeQpcr(payload):payload.quantification==='elisa'?analyzeElisa(payload,assays):analyzeInstrument(payload,assays);
export {assays};

export async function analysisRecord(env,user,id) {
  const record=await first(env,'SELECT entry_id,data,sha256 FROM analyses WHERE id=? AND owner=?',id,user.id);
  check(record,'分析快照不存在或无权访问。',404);
  check(await sha(record.data)===record.sha256,'分析快照校验失败。',409);
  return {...JSON.parse(record.data),entry_id:record.entry_id};
}
export async function analysisRoute(env,user,path,payload) {
  if (path==='/api/assays') return json({assays,catalog_version:'2026.10.19'});
  if (path==='/api/records') {
    const records=await rows(env,'SELECT id,data FROM analyses WHERE owner=? ORDER BY created_at DESC LIMIT 100',user.id);
    return json(records.map(record=>{const data=JSON.parse(record.data);return {id:record.id,name:data.experiment.name,valid:true,simulated:data.result.simulated,roi_count:data.result.rows?.length||data.result.results?.length||0,analysis_type:data.analysis_type,measurement:data.result.measurement||null};}));
  }
  if (path.startsWith('/api/notebook/analysis/')) {
    const record=await analysisRecord(env,user,path.split('/').at(-1));
    return json({analysis_type:record.analysis_type,assay_name:record.result.assay.name,simulated:record.result.simulated,algorithm:record.result.algorithm});
  }
  if (path==='/api/restore') return json(await analysisRecord(env,user,payload.id));
  if (path==='/api/instrument/demo') return json(payload.assay_id==='qpcr'?qpcrDemo(payload.input_type):payload.quantification==='elisa'?elisaDemo(payload.assay_id):instrumentDemo(assays.find(item=>item.id===payload.assay_id)));
  if (path==='/api/instrument/analyze') return json(calculate(payload));
  check(['/api/instrument/export','/api/analysis/photo'].includes(path),'接口不存在。',404);
  const computedResult=path==='/api/instrument/export'&&(payload.assay_id==='qpcr'||payload.quantification==='elisa')?calculate(payload):null;
  if(computedResult)check(new TextEncoder().encode(JSON.stringify({result:computedResult,input:payload})).length<440000,'定量输入与结果快照过大，请分批分析后保存。');
  let entry=payload.entry_id?await detail(env,user,payload.entry_id):await create(env,user,{title:payload.experiment?.name||'仪器分析',tags:payload.simulated?['模拟数据']:[]});
  const previous=payload.entry_id?payload.entry_revision:entry.revision;
  editable(entry,previous);
  check(entry.analyses.length<100,'每条实验最多 100 个分析快照。');
  const experiment={};
  for (const [key,value] of Object.entries(payload.experiment||{})) experiment[text(key,40,'实验字段')]=text(value,4000,'实验信息');
  experiment.name ||= entry.data.title;
  let result,input,original=null,annotated=null;
  if (path==='/api/instrument/export') {
    result=computedResult||calculate(payload);
    input={};
    const fields=payload.assay_id==='qpcr'?['csv','assay_id','method','input_type','target_gene','reference_gene','control_group','calibration','replicate_kind','target_efficiency','reference_efficiency','standards_csv','quantity_unit','assumptions_confirmed','simulated','filename']:['csv','assay_id','wavelength','reference_wavelength','unit','subtract_blank','simulated','filename'];
    for (const key of fields) input[key]=payload[key]??null;
    if(result.measurement==='elisa')for(const key of ['quantification','model','curve_direction','assumptions_confirmed'])input[key]=payload[key];
    if(result.measurement==='qpcr'){
      if(result.input_type==='multi_ct')input.reference_genes_csv=payload.reference_genes_csv;
      for(const key of ['method','input_type','reference_gene','control_group','calibration','replicate_kind','target_efficiency','reference_efficiency','quantity_unit','simulated'])input[key]=result[key];
      if(result.method!=='standard')input.standards_csv=null;
    }
  } else {
    original=await fileRow(env,user,payload.original_attachment_id);
    check(original.entry_id===entry.id && /\.(jpe?g|png|webp)$/i.test(original.filename),'分析原图必须是本条实验的图片附件。');
    const assay=assays.find(item=>item.id===payload.assay_id);
    check(assay?.photo_allowed,'此方法需要仪器读数，照片不能替代吸光度。');
    result=payload.result;
    check(result && result.algorithm==='browser-srgb-lab-de00-1' && typeof result.simulated==='boolean','照片结果格式无效。');
    check(Array.isArray(result.results)&&result.results.length>0&&result.results.length<=32 && Array.isArray(result.rois) && result.rois.length===result.results.length,'照片区域结果无效。');
    check(result.image?.sha256===original.sha256,'分析原图与附件校验值不一致。');
    for (const row of result.results) {
      check(['ok','caution','invalid'].includes(row.status)&&Array.isArray(row.warnings)&&row.warnings.length<=10,'照片质量标记无效。');
      for (const key of ['rgb','hsv','lab']) check(row[key]===null || Array.isArray(row[key])&&row[key].length===3&&row[key].every(Number.isFinite),'照片颜色数据无效。');
      check(row.delta_e===null || Number.isFinite(row.delta_e)&&row.delta_e>=0,'色差数据无效。');
    }
    if (payload.annotated_attachment_id) { annotated=await fileRow(env,user,payload.annotated_attachment_id);check(annotated.entry_id===entry.id,'标注图不属于本实验。'); }
    result={...result,assay,provenance:'用户浏览器计算后上传的结果；云端保存与哈希校验，不认证测量真实性。'};
    input={assay_id:assay.id,rois:result.rois,control_id:result.control_id,parameters:result.parameters,simulated:result.simulated};
  }
  const id=uid();
  const record={id,analysis_type:result.analysis_type,result,instrument_input:result.analysis_type==='instrument'?input:undefined,photo_input:result.analysis_type==='photo'?input:undefined,original_attachment_id:original?.id||null,annotated_attachment_id:annotated?.id||null,experiment,mode:payload.mode==='research'?'research':'teaching',created_at:now()};
  const serialized=JSON.stringify(record);
  check(new TextEncoder().encode(serialized).length<=450000,'分析快照过大，请分批整理仪器数据。');
  entry.analyses.push({entry_id:entry.id,record_id:id,created_at:record.created_at});
  if (result.simulated && !entry.data.tags.includes('模拟数据') && entry.data.tags.length<12) entry.data.tags.push('模拟数据');
  await save(env,user,entry,'保存分析快照',previous,[query(env,'INSERT INTO analyses VALUES(?,?,?,?,?,?)',id,user.id,entry.id,serialized,await sha(serialized),record.created_at)]);
  return json({id,entry_id:entry.id,path:'云端私有记录 / '+entry.id,download_url:'/api/download/'+id,simulated:result.simulated});
}
