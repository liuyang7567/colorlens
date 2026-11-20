import {check,text,uid,now,sha,encoder,first,rows,query,json,rate} from './common.mjs';
import {identifier} from './lab.mjs';
import {membership,accessGuard} from './teams.mjs';
import {mergeFields,sameValue} from './merge.mjs';

export const collaborationFields=['title','purpose','materials','procedure','results','discussion','body'];
function clean(input){check(input&&typeof input==='object'&&!Array.isArray(input),'协作文字格式无效。');const data=Object.fromEntries(collaborationFields.map(field=>[field,text(input[field]??'',field==='title'?200:20000,field,field==='title')]));check(encoder.encode(JSON.stringify(data)).length<=100000,'协作正文最多 100 KB，请拆分文档。',413);return data;}
async function record(env,user,id,write=false){const document=await first(env,'SELECT * FROM collaboration_documents WHERE id=?',identifier(id));check(document,'协作文档不存在或没有权限。',404);const team=await membership(env,user,document.team_id,write?['owner','editor']:undefined);check(await sha(document.data)===document.sha256,'协作文档校验失败。',503);return {document,team};}
async function view(env,user,id){const {document,team}=await record(env,user,id);return {...document,data:JSON.parse(document.data),role:team.role,user_id:user.id,versions:await rows(env,'SELECT revision,actor_name,created_at,sha256 FROM collaboration_versions WHERE document_id=? ORDER BY revision DESC LIMIT 50',id),presence:await rows(env,`SELECT users.id,users.display_name,users.username,collaboration_presence.field,seen_at FROM collaboration_presence JOIN users ON users.id=collaboration_presence.user_id JOIN team_members ON team_members.user_id=users.id AND team_members.team_id=? WHERE document_id=? AND seen_at>? AND users.disabled=0`,team.id,id,Math.floor(Date.now()/1000)-40)};}
function versionStatement(env,user,document){return query(env,'INSERT INTO collaboration_versions VALUES(?,?,?,?,?,?,?)',document.id,document.revision,user.id,user.display_name||user.username,document.data,document.sha256,document.updated_at);}
export async function collaborationRoute(env,user,path,input){
  if(path==='/api/collaboration/list'){const team=await membership(env,user,identifier(input.team_id));return json({role:team.role,documents:await rows(env,"SELECT id,project_id,json_extract(data,'$.title') AS title,revision,updated_at FROM collaboration_documents WHERE team_id=? ORDER BY updated_at DESC",team.id),projects:await rows(env,'SELECT id,title FROM team_projects WHERE team_id=? ORDER BY created_at',team.id)});}
  if(path==='/api/collaboration/create'){
    const team=await membership(env,user,identifier(input.team_id),['owner','editor']);check(input.consent===true,'请明确确认将此协作文字向整个团队公开。');
    const project=await first(env,'SELECT id FROM team_projects WHERE id=? AND team_id=?',identifier(input.project_id),team.id);check(project,'项目不属于此团队。',404);
    const serialized=JSON.stringify(clean(input.data)),created=now(),document={id:uid(),data:serialized,revision:1,sha256:await sha(serialized),updated_at:created};
    await env.DB.batch([...accessGuard(env,user,team),query(env,'INSERT INTO collaboration_documents VALUES(?,?,?,?,?,?,?,?,?)',document.id,team.id,project.id,user.id,serialized,1,document.sha256,created,created),versionStatement(env,user,document)]);return json(await view(env,user,document.id));
  }
  if(path==='/api/collaboration/open')return json(await view(env,user,input.id));
  if(path==='/api/collaboration/poll'){
    const {document,team}=await record(env,user,input.id);check(input.field===''||collaborationFields.includes(input.field),'协作光标字段无效。');await rate(env,'collab-poll:'+user.id,90,60);
    await env.DB.batch([...accessGuard(env,user,team),query(env,'INSERT INTO collaboration_presence VALUES(?,?,?,?) ON CONFLICT(document_id,user_id) DO UPDATE SET field=excluded.field,seen_at=excluded.seen_at',document.id,user.id,input.field,Math.floor(Date.now()/1000))]);return json(await view(env,user,document.id));
  }
  if(path==='/api/collaboration/version'){
    await record(env,user,input.id);check(Number.isSafeInteger(input.revision)&&input.revision>=1,'版本无效。');const version=await first(env,'SELECT * FROM collaboration_versions WHERE document_id=? AND revision=?',input.id,input.revision);check(version,'版本不存在。',404);check(await sha(version.data)===version.sha256,'协作历史校验失败。',503);return json({...version,data:JSON.parse(version.data)});
  }
  check(path==='/api/collaboration/save','接口不存在。',404);
  const {document,team}=await record(env,user,input.id,true),operation=identifier(input.operation_id),data=clean(input.data);check(Number.isSafeInteger(input.base_revision)&&input.base_revision>=1&&input.base_revision<=document.revision,'协作基准版本无效。');
  const fingerprint=await sha(JSON.stringify([document.id,input.base_revision,data])),previous=await first(env,'SELECT * FROM collaboration_operations WHERE owner=? AND operation_id=?',user.id,operation);
  if(previous){check(previous.document_id===document.id&&previous.fingerprint===fingerprint,'协作编号不能重用于其他内容。',409);return json({...await view(env,user,document.id),replayed:true});}
  const baseline=await first(env,'SELECT data,sha256 FROM collaboration_versions WHERE document_id=? AND revision=?',document.id,input.base_revision);check(baseline&&await sha(baseline.data)===baseline.sha256,'协作基准历史校验失败。',503);
  const remote=JSON.parse(document.data),merged=mergeFields(JSON.parse(baseline.data),data,remote,collaborationFields);
  if(merged.conflicts.length)return json({error:'相同字段同时修改，请保留本地输入并解决冲突。',conflict_fields:merged.conflicts,remote:await view(env,user,document.id)},409);
  if(sameValue(merged.data,remote))return json({...await view(env,user,document.id),replayed:false});
  const updated={...document,data:JSON.stringify(clean(merged.data)),revision:document.revision+1,updated_at:now()};updated.sha256=await sha(updated.data);
  await env.DB.batch([...accessGuard(env,user,team),query(env,'UPDATE collaboration_documents SET data=?,revision=?,sha256=?,updated_at=? WHERE id=? AND revision=?',updated.data,updated.revision,updated.sha256,updated.updated_at,updated.id,document.revision),query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard'),versionStatement(env,user,updated),query(env,'INSERT INTO collaboration_operations VALUES(?,?,?,?,?,?)',user.id,operation,document.id,fingerprint,updated.revision,now())]);return json({...await view(env,user,document.id),replayed:false});
}
