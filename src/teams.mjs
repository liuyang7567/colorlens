import {check,text,uid,now,sha,encoder,first,rows,query,json} from './common.mjs';
import {normalizeEmail} from './email.mjs';
import {detail} from './notebook.mjs';

const roles=['editor','reviewer','viewer'];
const guard=env=>[query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')];
function identifier(value){check(typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),'内容不存在或没有访问权限。',404);return value;}
export async function membership(env,user,teamId,allowed){
  identifier(teamId);
  const member=await first(env,`SELECT teams.*,team_members.role FROM teams JOIN team_members ON team_members.team_id=teams.id
    JOIN users founder ON founder.id=teams.owner WHERE teams.id=? AND team_members.user_id=? AND founder.disabled=0`,teamId,user.id);
  check(member,'团队不存在或没有访问权限。',404);
  check(!allowed||allowed.includes(member.role),'当前团队角色不允许此操作。',403);
  return member;
}
export function accessGuard(env,user,team){
  return [query(env,`INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM team_members
    JOIN users actor ON actor.id=team_members.user_id JOIN teams ON teams.id=team_members.team_id
    JOIN users founder ON founder.id=teams.owner WHERE team_id=? AND user_id=? AND team_members.role=?
    AND actor.disabled=0 AND founder.disabled=0) THEN 1 ELSE 0 END`,team.id,user.id,team.role),query(env,'DELETE FROM mutation_guard')];
}
async function submission(env,user,id){
  identifier(id);
  const record=await first(env,`SELECT team_submissions.*,team_projects.team_id FROM team_submissions
    JOIN team_projects ON team_projects.id=project_id WHERE team_submissions.id=?`,id);
  check(record,'提交记录不存在或没有访问权限。',404);
  const team=await membership(env,user,record.team_id);
  return {record,team};
}
async function viewSubmission(env,user,id,version){
  const {record,team}=await submission(env,user,id);
  check(version===undefined||Number.isSafeInteger(version)&&version>=1&&version<=record.version,'提交版本无效。');
  const withdrawn=record.status==='withdrawn';
  const current=withdrawn?null:await first(env,'SELECT snapshot,sha256 FROM team_versions WHERE submission_id=? AND version=?',id,version??record.version);
  check(withdrawn||current&&await sha(current.snapshot)===current.sha256,'提交副本完整性校验失败，请联系管理员。',503);
  const versions=withdrawn?[]:await rows(env,'SELECT version,sha256,created_at FROM team_versions WHERE submission_id=? ORDER BY version DESC',id);
  const events=await rows(env,'SELECT id,owner,actor_name,version,kind,text,created_at FROM team_events WHERE submission_id=? ORDER BY created_at,rowid',id);
  return {id,project_id:record.project_id,team_id:record.team_id,owner:record.owner,title:record.title,revision:record.revision,version:record.version,status:record.status,updated_at:record.updated_at,role:team.role,...record.owner===user.id&&!withdrawn?{source_id:record.source_id}:{},snapshot:current?JSON.parse(current.snapshot):null,sha256:current?.sha256??null,versions,events};
}
function eventStatement(env,user,record,kind,value){return query(env,'INSERT INTO team_events VALUES(?,?,?,?,?,?,?,?)',uid(),record.id,user.id,user.display_name||user.username,record.version,kind,value,now());}
function currentRevision(record,value){check(Number.isSafeInteger(value)&&value===record.revision,'团队记录已更新，请保留输入后刷新再试。',409);check(record.status!=='withdrawn','该提交已撤回，不能继续修改或评阅。',409);}
function snapshot(entry){
  const data=Object.fromEntries(['title','date','project','operator','kind','tags','purpose','materials','procedure','results','discussion','body'].map(key=>[key,entry.data[key]]));
  data.body=(data.body||'').replace(/\[\[colorlens-image:[^\]]+\]\]/g,'［图片未提交；原附件仍私有］');
  if(entry.data.template_binding)data.template_fields=entry.data.template_binding.definition.fields.map(field=>({label:field.label,unit:field.unit,value:entry.data.template_values?.[field.key]??''}));
  const result={schema:'colorlens-team-text-1',data,source_revision:entry.revision,submitted_at:now(),notice:'主动提交的冻结文字副本。不包含原附件、图片、AI、修改历史或可打开的分析快照；评阅不是电子签名。'};
  check(encoder.encode(JSON.stringify(result)).length<=200000,'提交文字超过 200 KB，请整理后再提交；原笔记未改变。',413);
  return result;
}
export async function teamsRoute(env,user,path,payload){
  if(path==='/api/teams')return json({user_id:user.id,items:await rows(env,`SELECT teams.id,teams.name,teams.created_at,team_members.role FROM teams
    JOIN team_members ON teams.id=team_id JOIN users founder ON founder.id=teams.owner WHERE user_id=? AND founder.disabled=0 ORDER BY teams.created_at DESC`,user.id),
    invites:user.email&&user.email_verified_at?await rows(env,`SELECT team_invites.id,team_id,teams.name,team_invites.role,expires FROM team_invites JOIN teams ON teams.id=team_id
      JOIN users founder ON founder.id=teams.owner WHERE team_invites.email=? AND expires>? AND founder.disabled=0 ORDER BY team_invites.created_at DESC`,user.email,Math.floor(Date.now()/1000)):[]});
  const input=payload??{};
  if(path==='/api/teams/create'){
    check(user.email&&user.email_verified_at,'请先绑定并验证邮箱，再创建团队。',403);
    const id=uid(),created=now();
    await env.DB.batch([query(env,'INSERT INTO teams VALUES(?,?,?,?)',id,user.id,text(input.name,100,'团队名称',true).trim(),created),query(env,'INSERT INTO team_members VALUES(?,?,?,?)',id,user.id,'owner',created)]);
    return json({id});
  }
  if(path==='/api/teams/accept'){
    check(user.email&&user.email_verified_at,'需要已验证的邀请邮箱。',403);
    const invite=await first(env,`SELECT team_invites.* FROM team_invites JOIN teams ON teams.id=team_id JOIN users ON users.id=teams.owner
      WHERE team_invites.id=? AND team_invites.email=? AND expires>? AND users.disabled=0`,identifier(input.invite_id),user.email,Math.floor(Date.now()/1000));
    check(invite,'邀请不存在、已过期或不属于当前邮箱。',404);
    check(!await first(env,'SELECT 1 FROM team_members WHERE team_id=? AND user_id=?',invite.team_id,user.id),'已经加入该团队。',409);
    await env.DB.batch([query(env,`DELETE FROM team_invites WHERE id=? AND email=? AND role=? AND expires>?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND email_verified_at IS NOT NULL AND disabled=0)
      AND EXISTS(SELECT 1 FROM teams JOIN users ON users.id=teams.owner WHERE teams.id=? AND users.disabled=0)`,invite.id,user.email,invite.role,Math.floor(Date.now()/1000),user.id,user.email,invite.team_id),...guard(env),query(env,'INSERT INTO team_members VALUES(?,?,?,?)',invite.team_id,user.id,invite.role,now())]);
    return json({team_id:invite.team_id});
  }
  if(path==='/api/teams/submission')return json(await viewSubmission(env,user,input.id,input.version));
  if(path==='/api/teams/archive'){
    const record=await viewSubmission(env,user,input.id);
    const versions=record.status==='withdrawn'?[]:await rows(env,'SELECT version,snapshot,sha256,created_at FROM team_versions WHERE submission_id=? ORDER BY version',record.id);
    for(const version of versions)check(await sha(version.snapshot)===version.sha256,'历史副本完整性校验失败，未导出。',503);
    await membership(env,user,record.team_id);
    return json({schema:'colorlens-team-submission-1',exported_at:now(),notice:'仅此团队提交的文字版本与动态；不是全团队备份，也不能恢复成员权限或私人原件。',record,versions:versions.map(item=>({...item,snapshot:JSON.parse(item.snapshot)}))});
  }
  if(path==='/api/teams/preview'){
    const project=await first(env,'SELECT team_id FROM team_projects WHERE id=?',identifier(input.project_id));check(project,'项目不存在。',404);
    await membership(env,user,project.team_id,['owner','editor']);
    const entry=await detail(env,user,input.entry_id);check(!entry.deleted,'回收站笔记不能提交。',409);
    return json({entry_id:entry.id,entry_revision:entry.revision,snapshot:snapshot(entry)});
  }
  if(['/api/teams/submit','/api/teams/comment','/api/teams/review','/api/teams/withdraw'].includes(path)){
    let record,team;
    if(input.id){({record,team}=await submission(env,user,input.id));currentRevision(record,input.revision);}
    if(path==='/api/teams/submit'){
      const project=await first(env,'SELECT * FROM team_projects WHERE id=?',identifier(input.project_id));check(project,'项目不存在。',404);
      team=await membership(env,user,project.team_id,['owner','editor']);
      check(input.consent===true,'请先确认主动向整个团队提交文字副本。');
      const entry=await detail(env,user,input.entry_id);check(!entry.deleted&&entry.revision===input.entry_revision,'私人笔记已更新或被移至回收站，请重新选择已保存版本。',409);
      if(record)check(record.owner===user.id&&record.source_id===entry.id&&record.project_id===project.id,'只能更新自己向同一项目提交的原笔记。',403);
      const frozen=snapshot(entry),serialized=JSON.stringify(frozen),digest=await sha(serialized),created=now();
      const statements=[...accessGuard(env,user,team),query(env,'INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM entries WHERE id=? AND owner=? AND revision=?) THEN 1 ELSE 0 END',entry.id,user.id,entry.revision),query(env,'DELETE FROM mutation_guard')];
      if(record){statements.push(query(env,"UPDATE team_submissions SET revision=revision+1,version=version+1,status='pending',title=?,updated_at=? WHERE id=? AND revision=?",entry.data.title,created,record.id,record.revision),...guard(env));record={...record,version:record.version+1};}
      else{record={id:uid(),version:1};statements.push(query(env,"INSERT INTO team_submissions VALUES(?,?,?,?,?,1,1,'pending',?)",record.id,project.id,user.id,entry.id,entry.data.title,created));}
      statements.push(query(env,'INSERT INTO team_versions VALUES(?,?,?,?,?,?)',record.id,record.version,user.id,serialized,digest,created),eventStatement(env,user,record,'submit','主动提交文字副本；不共享原附件或 AI。'));
      await env.DB.batch(statements);return json(await viewSubmission(env,user,record.id));
    }
    check(record,'提交记录不存在。',404);
    if(path==='/api/teams/withdraw')check(record.owner===user.id||team.role==='owner','只能撤回自己的提交。',403);
    else if(path==='/api/teams/review')check(['owner','reviewer'].includes(team.role)&&record.owner!==user.id,'需要团队负责人或评阅者，且不能评阅自己的提交。',403);
    else check(['owner','editor','reviewer'].includes(team.role),'只读成员不能评论。',403);
    const value=text(input.text,2000,'评语或说明',true).trim();
    let kind='comment',status=record.status;
    if(path==='/api/teams/withdraw')kind=status='withdrawn';
    if(path==='/api/teams/review'){check(['approved','changes_requested'].includes(input.status),'评阅状态无效。');kind=status=input.status;}
    await env.DB.batch([...accessGuard(env,user,team),query(env,'UPDATE team_submissions SET revision=revision+1,status=?,updated_at=? WHERE id=? AND revision=?',status,now(),record.id,record.revision),...guard(env),eventStatement(env,user,record,kind,value)]);
    return json(await viewSubmission(env,user,record.id));
  }
  const team=await membership(env,user,input.team_id,path==='/api/teams/detail'?undefined:path==='/api/teams/project'?['owner','editor']:['owner']);
  if(path==='/api/teams/detail')return json({id:team.id,name:team.name,role:team.role,user_id:user.id,
    members:await rows(env,`SELECT users.id,COALESCE(users.display_name,users.username) AS name,team_members.role,users.disabled FROM team_members
      JOIN users ON users.id=user_id WHERE team_id=? ORDER BY team_members.created_at`,team.id),
    invites:team.role==='owner'?await rows(env,'SELECT id,email,role,expires FROM team_invites WHERE team_id=? AND expires>?',team.id,Math.floor(Date.now()/1000)):[],
    projects:await rows(env,'SELECT id,title,description,created_at FROM team_projects WHERE team_id=? ORDER BY created_at DESC',team.id),
    submissions:await rows(env,`SELECT team_submissions.id,project_id,team_submissions.owner,team_submissions.title,revision,version,status,updated_at FROM team_submissions
      JOIN team_projects ON team_projects.id=project_id WHERE team_id=? ORDER BY updated_at DESC`,team.id)});
  const statements=accessGuard(env,user,team);
  if(path==='/api/teams/project'){
    const id=uid();statements.push(query(env,'INSERT INTO team_projects VALUES(?,?,?,?,?,?)',id,team.id,text(input.title,100,'项目名称',true).trim(),text(input.description??'',2000,'项目说明'),user.id,now()));await env.DB.batch(statements);return json({id});
  }
  if(path==='/api/teams/invite'){
    const email=normalizeEmail(input.email);check(roles.includes(input.role),'只能邀请为编辑者、评阅者或只读成员。');
    check(!await first(env,'SELECT 1 FROM team_members JOIN users ON users.id=user_id WHERE team_id=? AND email=?',team.id,email),'该邮箱已经加入团队。',409);
    statements.push(query(env,'DELETE FROM team_invites WHERE team_id=? AND expires<=?',team.id,Math.floor(Date.now()/1000)),query(env,`INSERT INTO team_invites VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,email)
      DO UPDATE SET id=excluded.id,role=excluded.role,expires=excluded.expires,created_at=excluded.created_at`,uid(),team.id,email,input.role,Math.floor(Date.now()/1000)+604800,now()));
  }else if(path==='/api/teams/cancel')statements.push(query(env,'DELETE FROM team_invites WHERE id=? AND team_id=?',identifier(input.invite_id),team.id),...guard(env));
  else if(path==='/api/teams/member'){
    const target=identifier(input.user_id);check(target!==team.owner,'不能移除负责人或变更负责人的角色。');check([...roles,'remove'].includes(input.role),'成员角色无效。');
    statements.push(input.role==='remove'?query(env,'DELETE FROM team_members WHERE team_id=? AND user_id=?',team.id,target):query(env,'UPDATE team_members SET role=? WHERE team_id=? AND user_id=?',input.role,team.id,target),...guard(env));
  }else check(false,'接口不存在。',404);
  await env.DB.batch(statements);return json({ok:true});
}
