import {check,text,uid,now,sha,first,rows,query,json,encoder} from './common.mjs';

const sections=['purpose','materials','procedure','results','discussion'];
const plainObject=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
export function cleanTemplate(input){
  check(plainObject(input),'模板格式无效。');
  const result={title:text(input.title,100,'模板名称',true).trim(),description:text(input.description??'',1000,'模板说明'),kind:input.kind??'course',sections:{},fields:[],steps:[]};
  check(['course','research','general'].includes(result.kind),'模板实验类别无效。');
  check(plainObject(input.sections??{}),'模板栏目格式无效。');
  for(const key of sections)result.sections[key]=text(input.sections?.[key]??'',6000,'模板栏目');
  check(Array.isArray(input.fields??[])&&(input.fields??[]).length<=12,'每个模板最多 12 个结构化字段。');
  const keys=new Set();
  for(const item of input.fields??[]){
    check(plainObject(item),'模板字段格式无效。');
    check(typeof item.key==='string'&&/^[a-z][a-z0-9_]{0,39}$/.test(item.key)&&!['constructor','prototype','__proto__'].includes(item.key)&&!keys.has(item.key),'字段标识必须唯一，使用小写英文字母、数字和下划线。');keys.add(item.key);
    check(['text','number','date','select','checkbox'].includes(item.type),'不支持此字段类型。');
    check(typeof item.required==='boolean','请明确字段是否必填。');
    const field={key:item.key,label:text(item.label,80,'字段名称',true).trim(),type:item.type,required:item.required,unit:text(item.unit??'',30,'单位'),description:text(item.description??'',240,'字段说明'),options:[]};
    if(field.type==='select'){
      check(Array.isArray(item.options)&&item.options.length>=2&&item.options.length<=30,'下拉字段需要 2–30 个选项。');
      field.options=item.options.map(option=>text(option,80,'选项',true).trim());check(new Set(field.options).size===field.options.length,'下拉选项不能重复。');
    }
    result.fields.push(field);
  }
  check(Array.isArray(input.steps??[])&&(input.steps??[]).length<=16,'每个模板最多 16 个检查项。');
  result.steps=(input.steps??[]).map(step=>text(step,160,'检查项',true).trim());check(new Set(result.steps).size===result.steps.length,'检查项不能重复。');
  check(encoder.encode(JSON.stringify(result)).length<=50000,'模板过大，请简化栏目和字段。');return result;
}

const field=(key,label,type='text',required=false,unit='')=>({key,label,type,required,unit});
export const builtinTemplates=[
  {id:'builtin-qpcr',revision:1,definition:cleanTemplate({title:'qPCR / RT-qPCR 实验记录',description:'记录样本、内参、原始读数和计算前提；不是仪器说明书或显著性判定。',kind:'research',sections:{purpose:'记录本次比较的目标基因、组别及问题。',materials:'记录试剂、引物、内参选择依据、厂家货号与批次。',procedure:'按已验证的本实验室方案操作。记录对照、技术孔与独立样本的对应关系，保留原始扩增和熔解资料。',results:'填写真实 Ct / ΔCt 或关联分析快照；不要把未扩增填为 0。',discussion:'检查效率、内参稳定性、异常与未满足的前提；假设与事实分开记录。'},fields:[field('sample_batch','样本批次','text',true),field('reference_gene','内参名称','text',true),field('instrument','仪器'),field('kit_lot','试剂批号')],steps:['已区分独立样本和技术重复','已检查对照及原始曲线','已保留原始数据和所用计算方法']})},
  {id:'builtin-elisa',revision:1,definition:cleanTemplate({title:'ELISA 实验记录',description:'用于规范记录实际试剂盒和本批次标准品；当前常规 OD 工具不自动反算未知浓度。',kind:'research',sections:{purpose:'记录待测指标、样本与比较目的。',materials:'按实际试剂盒填写厂家、货号、物种、批号和说明书版本。',procedure:'记录本批次标准品、空白、对照、板位、稀释及仪器读数设置。操作条件以实际说明书和实验室方案为准。',results:'保存原始 OD、背景处理和重复孔数据；未经校准不得填入推测浓度。',discussion:'记录异常、范围限制与后续复测计划。'},fields:[field('analyte','检测指标','text',true),field('kit_lot','试剂盒批号','text',true),field('sample_batch','样本批次'),field('dilution','稀释倍数','number',false,'倍')],steps:['已记录实际说明书版本','已保留标准品、空白与板位','已检查背景校正是否重复执行']})},
  {id:'builtin-bca',revision:1,definition:cleanTemplate({title:'BCA 蛋白测定记录',description:'规范记录标准品、样本与读数；不提供替代实际试剂盒的固定操作条件。',kind:'course',sections:{purpose:'记录本次测定目标和样本来源。',materials:'记录标准品、样本缓冲液、试剂批号与实际操作方案。',procedure:'按说明书和实验室方案操作，记录空白、标准系列、重复孔及样本稀释。',results:'保留实际读数和处理过程，说明是否已在仪器端扣除空白。',discussion:'记录干扰因素、测定范围和需复测的样本。'},fields:[field('sample_batch','样本批次','text',true),field('standard_lot','标准品批次'),field('dilution','样本稀释倍数','number',false,'倍')],steps:['已记录样本缓冲液','已区分标准品、空白和未知样本','已保存原始读数']})}
];

export async function loadTemplate(env,user,id,revision){
  const builtin=builtinTemplates.find(item=>item.id===id);
  if(builtin){check(revision===undefined||revision===1,'模板版本不存在。',404);return {...builtin,builtin:true,archived:false,sha256:await sha(JSON.stringify(builtin.definition))};}
  check(typeof id==='string'&&/^[a-f0-9]{32}$/.test(id),'模板不存在。',404);
  const current=await first(env,'SELECT * FROM experiment_templates WHERE id=? AND owner=?',id,user.id);check(current,'模板不存在或无权访问。',404);
  const selected=revision??current.revision;check(Number.isSafeInteger(selected)&&selected>0,'模板版本无效。');
  const record=await first(env,'SELECT * FROM template_versions WHERE template_id=? AND owner=? AND revision=?',id,user.id,selected);check(record,'模板版本不存在。',404);
  check(await sha(record.data)===record.sha256,'模板完整性校验失败。',409);
  return {id,revision:selected,archived:Boolean(current.archived),builtin:false,definition:JSON.parse(record.data),sha256:record.sha256};
}

export async function templateBinding(env,user,payload,trusted){
  if(trusted)return structuredClone(trusted);
  if(payload.template_ref){
    check(plainObject(payload.template_ref),'模板引用无效。');
    const loaded=await loadTemplate(env,user,payload.template_ref.id,payload.template_ref.revision);check(!loaded.archived,'此模板已归档，不能用于新建记录。',409);
    return {id:loaded.id,revision:loaded.revision,sha256:loaded.sha256,source:'library',definition:loaded.definition};
  }
  if(payload.template_binding){
    const source=payload.template_binding;check(plainObject(source)&&Number.isSafeInteger(source.revision)&&source.revision>0,'导入模板来源无效。');
    const definition=cleanTemplate(source.definition);return {id:text(source.id,80,'来源模板标识',true),revision:source.revision,sha256:await sha(JSON.stringify(definition)),source:'imported',definition};
  }
  return null;
}

export function templateData(payload,binding,complete=false){
  if(!binding)return {};
  check(!payload.template_binding||JSON.stringify(payload.template_binding)===JSON.stringify(binding),'记录的模板来源不能直接修改。',409);
  check(plainObject(payload.template_values??{}),'模板字段值无效。');
  const values={};
  for(const field of binding.definition.fields){
    let value=payload.template_values?.[field.key]??(field.type==='checkbox'?false:'');
    if(field.type==='checkbox')check(typeof value==='boolean',field.label+' 必须是勾选状态。');
    else{
      value=text(value,500,field.label).trim();
      if(value&&field.type==='number')check(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)&&Number.isFinite(Number(value)),field.label+' 需要有限数值。');
      if(value&&field.type==='date'){const parsed=new Date(value);check(/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value,field.label+' 日期无效。');}
      if(value&&field.type==='select')check(field.options.includes(value),field.label+' 不在允许选项中。');
    }
    if(complete&&field.required)check(value!==''&&value!==false,'完成记录前请填写：'+field.label);
    values[field.key]=value;
  }
  const checks=payload.template_checks??[];check(Array.isArray(checks)&&checks.length<=binding.definition.steps.length&&checks.every(value=>typeof value==='boolean'),'模板检查项无效。');
  return {template_binding:binding,template_values:values,template_checks:binding.definition.steps.map((step,index)=>checks[index]??false)};
}

export async function templatesRoute(env,user,path,payload){
  if(path==='/api/templates/version')return json(await loadTemplate(env,user,payload.id,payload.revision));
  if(path==='/api/templates'){
    const owned=await rows(env,'SELECT current.id,current.revision,current.archived,current.updated_at,version.data,version.sha256 FROM experiment_templates current JOIN template_versions version ON version.template_id=current.id AND version.revision=current.revision WHERE current.owner=? AND version.owner=? ORDER BY current.updated_at DESC LIMIT 100',user.id,user.id);
    const items=[];for(const item of builtinTemplates)items.push({...await loadTemplate(env,user,item.id,item.revision),updated_at:null});
    for(const item of owned){check(await sha(item.data)===item.sha256,'模板完整性校验失败。',409);items.push({id:item.id,revision:item.revision,archived:Boolean(item.archived),builtin:false,updated_at:item.updated_at,sha256:item.sha256,definition:JSON.parse(item.data)});}
    return json({items});
  }
  check(['/api/templates/save','/api/templates/archive'].includes(path),'模板接口不存在。',404);
  let current=null;
  if(payload.id){current=await loadTemplate(env,user,payload.id);check(!current.builtin,'内置模板不能覆盖，请另存为个人模板。');check(current.revision===payload.revision,'模板已在其他窗口更新，请保留输入后重新打开。',409);check(!current.archived,'归档模板不能修改。',409);}
  if(path.endsWith('/archive')){
    check(current,'请选择自己的模板。');await env.DB.batch([query(env,'UPDATE experiment_templates SET archived=1,updated_at=? WHERE id=? AND owner=? AND revision=? AND archived=0',now(),current.id,user.id,current.revision),query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')]);return json({ok:true});
  }
  const definition=cleanTemplate(payload.definition),serialized=JSON.stringify(definition),id=current?.id??uid(),revision=(current?.revision??0)+1,date=now();
  check(revision<=100,'一个模板最多保留 100 个版本，请另存为新模板。');
  if(!current)check((await first(env,'SELECT COUNT(*) AS count FROM experiment_templates WHERE owner=?',user.id)).count<100,'每个账号最多 100 个个人模板（含归档）。');
  const statements=current?[query(env,'UPDATE experiment_templates SET revision=?,updated_at=? WHERE id=? AND owner=? AND revision=? AND archived=0',revision,date,id,user.id,current.revision),query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')]:[query(env,'INSERT INTO experiment_templates VALUES(?,?,?,0,?)',id,user.id,revision,date)];
  statements.push(query(env,'INSERT INTO template_versions VALUES(?,?,?,?,?,?)',id,user.id,revision,serialized,await sha(serialized),date));await env.DB.batch(statements);
  return json(await loadTemplate(env,user,id,revision));
}
