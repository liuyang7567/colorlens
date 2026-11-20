import {check,uid,now,sha,encoder,first,query,json} from './common.mjs';
import {identifier} from './lab.mjs';
import {cleanData,detail,validateImages,updateStatements} from './notebook.mjs';
import {mergeFields,sameValue} from './merge.mjs';

export const syncFields=['title','date','operator','project','kind','template','body','purpose','materials','procedure','results','discussion','tags','event_draft','template_values','template_checks'];
const identityGuard=(env,user)=>[query(env,'INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0 AND auth_version=?) THEN 1 ELSE 0 END',user.id,user.auth_version),query(env,'DELETE FROM mutation_guard')];
export async function syncRoute(env,user,path,input){
  check(path==='/api/sync/apply','接口不存在。',404);
  const operation=identifier(input.operation_id),entryId=input.entry_id===null?null:identifier(input.entry_id);
  check(input.data&&typeof input.data==='object'&&!Array.isArray(input.data),'离线记录数据无效。');
  check(entryId===null?input.base_revision===0:Number.isSafeInteger(input.base_revision)&&input.base_revision>0,'离线基准版本无效。');
  const fingerprint=await sha(JSON.stringify([entryId,input.base_revision,input.data])),previous=await first(env,'SELECT * FROM sync_operations WHERE owner=? AND operation_id=?',user.id,operation);
  if(previous){
    check(previous.fingerprint===fingerprint,'同一同步编号不能提交不同内容。请保留本地资料。',409);
    const applied=await first(env,'SELECT snapshot FROM revisions WHERE entry_id=? AND owner=? AND revision=?',previous.entry_id,user.id,previous.revision);
    check(applied,'已同步版本缺失，请联系管理员；本地资料未清除。',503);return json({entry:JSON.parse(applied.snapshot),replayed:true});
  }
  let entry,statements;
  if(entryId===null){
    check(!input.data.template_binding,'离线新建暂不绑定模板；可同步后在线选择。');
    const data=cleanData({...input.data,status:'draft',body_format:undefined});validateImages(data,[]);
    entry={id:uid(),data,created_at:now(),updated_at:now(),revision:1,deleted:0,attachments:[],events:[],analyses:[]};
    const serialized=JSON.stringify(entry);check(encoder.encode(serialized).length<=450000,'离线记录过大。',413);
    statements=[query(env,'INSERT INTO entries VALUES(?,?,?,?,?,?)',entry.id,user.id,serialized,1,'离线新建同步',entry.updated_at)];
  }else{
    entry=await detail(env,user,entryId);check(!entry.deleted&&entry.data.status==='draft','云端记录已完成或在回收站；请保留本地修改并另存新记录。',409);
    const baseline=await first(env,'SELECT snapshot FROM revisions WHERE entry_id=? AND owner=? AND revision=?',entryId,user.id,input.base_revision);check(baseline,'离线基准历史不存在，不能自动覆盖。',409);
    const base=JSON.parse(baseline.snapshot);check(!base.deleted&&base.data.status==='draft','此基准版本不允许离线修改。',409);
    const proposed=cleanData({...input.data,status:'draft',body_format:base.data.body_format},base.data.template_binding??null);
    const merged=mergeFields(base.data,proposed,entry.data,syncFields);
    if(merged.conflicts.length)return json({error:'相同字段在云端和本地均有修改，请逐项确认；未覆盖云端。',conflict_fields:merged.conflicts,remote:entry},409);
    const data=cleanData({...merged.data,status:'draft'},entry.data.template_binding??null);validateImages(data,entry.attachments);
    const revision=entry.revision,unchanged=sameValue(data,entry.data);entry={...entry,data};
    statements=unchanged?[query(env,'INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM entries WHERE id=? AND owner=? AND revision=?) THEN 1 ELSE 0 END',entryId,user.id,revision),query(env,'DELETE FROM mutation_guard')]:updateStatements(env,user,entry,'离线编辑同步',revision);
  }
  await env.DB.batch([...identityGuard(env,user),...statements,query(env,'INSERT INTO sync_operations VALUES(?,?,?,?,?,?)',user.id,operation,fingerprint,entry.id,entry.revision,now())]);
  return json({entry,replayed:false});
}
