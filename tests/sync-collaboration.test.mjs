import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,now} from '../src/common.mjs';
import {mergeFields} from '../src/merge.mjs';

async function fixture(){
  const DB=localDatabase(),env={DB},users={};
  for(const [name,role] of [['owner','member'],['editor','member'],['viewer','member'],['outsider','admin']]){
    const id=uid(),token=uid()+uid(),csrf=uid();DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),'unused',role,now(),'同名协作用户',name+'@example.test',now());DB.raw.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) VALUES(?,?,?,?,0)').run(await sha(token),id,csrf,Math.floor(Date.now()/1000)+3600);users[name]={id,cookie:'__Host-ColorLens='+token,csrf};
  }
  async function call(name,route,payload){const user=users[name],response=await worker.fetch(new Request('https://colorlens.test/api/'+route,{method:payload===undefined?'GET':'POST',headers:{Cookie:user.cookie,...payload===undefined?{}:{Origin:'https://colorlens.test','Content-Type':'application/json','X-ColorLens-Token':user.csrf}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,data:await response.json()};}
  async function ok(name,route,payload){const response=await call(name,route,payload);assert.equal(response.status,200,JSON.stringify(response.data));return response.data;}
  async function team(){const team=await ok('owner','teams/create',{name:'模拟协作团队'});for(const role of ['editor','viewer']){await ok('owner','teams/invite',{team_id:team.id,email:role+'@example.test',role});await ok(role,'teams/accept',{invite_id:(await ok(role,'teams')).invites[0].id});}const project=await ok('owner','teams/project',{team_id:team.id,title:'模拟协作项目'});return {team,project};}
  return {DB,env,users,call,ok,team};
}
test('field merge combines disjoint edits and explicitly reports same-field conflicts',()=>{
  assert.deepEqual(mergeFields({body:'A',results:'B'},{body:'local',results:'B'},{body:'A',results:'remote'},['body','results']),{data:{body:'local',results:'remote'},conflicts:[]});
  assert.deepEqual(mergeFields({body:'A'},{body:'local'},{body:'remote'},['body']).conflicts,['body']);assert.deepEqual(mergeFields({body:'A'},{body:'same'},{body:'same'},['body']).conflicts,[]);
});
test('offline synchronization merges disjoint changes, preserves history and replays without duplicate revisions',async()=>{
  const app=await fixture();try{
    const note=await app.ok('owner','notebook/create',{data:{title:'模拟离线',body:'原文',results:'原结果'}}),remote=await app.ok('owner','notebook/save',{id:note.id,revision:1,data:{...note.data,results:'在线结果'}}),payload={entry_id:note.id,base_revision:1,operation_id:uid(),data:{...note.data,body:'离线正文'}};
    const saved=await app.ok('owner','sync/apply',payload);assert.equal(saved.entry.data.body,'离线正文');assert.equal(saved.entry.data.results,'在线结果');assert.equal(saved.entry.revision,3);assert.equal((await app.ok('owner','sync/apply',payload)).replayed,true);assert.equal((await app.ok('owner','notebook/entry/'+note.id)).revision,3);
    assert.equal((await app.call('owner','sync/apply',{...payload,data:{...payload.data,body:'篡改同编号'}})).status,409);assert.equal((await app.call('outsider','sync/apply',{...payload,operation_id:uid()})).status,404);assert.equal(remote.revision,2);
  }finally{app.DB.close();}
});
test('offline same-field conflicts, completion locks and foreign image tokens never overwrite cloud data',async()=>{
  const app=await fixture();try{
    const note=await app.ok('owner','notebook/create',{data:{title:'模拟冲突',body:'原文'}});let remote=await app.ok('owner','notebook/save',{id:note.id,revision:1,data:{...note.data,body:'在线修改'}});
    const conflict=await app.call('owner','sync/apply',{entry_id:note.id,base_revision:1,operation_id:uid(),data:{...note.data,body:'离线修改'}});assert.equal(conflict.status,409);assert.deepEqual(conflict.data.conflict_fields,['body']);assert.equal((await app.ok('owner','notebook/entry/'+note.id)).data.body,'在线修改');
    assert.equal((await app.call('owner','sync/apply',{entry_id:note.id,base_revision:2,operation_id:uid(),data:{...remote.data,body_format:'inline-images-v1',body:'[[colorlens-image:'+uid()+']]'}})).status,200);
    remote=await app.ok('owner','notebook/entry/'+note.id);assert.ok(!remote.data.body_format);
    remote=await app.ok('owner','notebook/save',{id:note.id,revision:remote.revision,data:{...remote.data,status:'complete'}});assert.equal((await app.call('owner','sync/apply',{entry_id:note.id,base_revision:1,operation_id:uid(),data:note.data})).status,409);
  }finally{app.DB.close();}
});
test('offline creation is atomic and idempotent; identity or quota races leave no untracked note',async()=>{
  const app=await fixture();try{
    const payload={entry_id:null,base_revision:0,operation_id:uid(),data:{title:'模拟离线新建',body:'本地草稿'}};const first=await app.ok('owner','sync/apply',payload),again=await app.ok('owner','sync/apply',payload);assert.equal(first.entry.id,again.entry.id);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM entries').get().count,1);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040').run();assert.equal((await app.call('owner','sync/apply',{...payload,operation_id:uid()})).status,413);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM entries').get().count,1);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM sync_operations').get().count,1);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=0').run();const batch=app.DB.batch;app.DB.batch=async statements=>{app.DB.raw.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(app.users.owner.id);return batch(statements);};assert.equal((await app.call('owner','sync/apply',{...payload,operation_id:uid()})).status,409);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM entries').get().count,1);
  }finally{app.DB.close();}
});
test('team collaboration is explicit, versioned, role-bound and independent from private experiments',async()=>{
  const app=await fixture();try{
    const {team,project}=await app.team();const create={team_id:team.id,project_id:project.id,data:{title:'模拟共同编辑',body:'基准',results:'原结果'}};assert.equal((await app.call('owner','collaboration/create',create)).status,400);const document=await app.ok('owner','collaboration/create',{...create,consent:true});
    const first=await app.ok('editor','collaboration/save',{id:document.id,base_revision:1,operation_id:uid(),data:{...document.data,body:'编辑者正文'}});const payload={id:document.id,base_revision:1,operation_id:uid(),data:{...document.data,results:'负责人结果'}};const second=await app.ok('owner','collaboration/save',payload);assert.equal(second.data.body,'编辑者正文');assert.equal(second.data.results,'负责人结果');assert.equal(second.revision,3);assert.equal((await app.ok('owner','collaboration/save',payload)).revision,3);
    const conflict=await app.call('owner','collaboration/save',{id:document.id,base_revision:1,operation_id:uid(),data:{...document.data,body:'负责人并发正文'}});assert.equal(conflict.status,409);assert.deepEqual(conflict.data.conflict_fields,['body']);assert.equal((await app.ok('viewer','collaboration/version',{id:document.id,revision:1})).data.body,'基准');assert.equal(first.revision,2);
    assert.equal((await app.call('viewer','collaboration/save',{...payload,operation_id:uid()})).status,403);assert.equal((await app.call('outsider','collaboration/open',{id:document.id})).status,404);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM entries').get().count,0);
    const presence=await app.ok('editor','collaboration/poll',{id:document.id,field:'body'});assert.equal(presence.presence[0].id,app.users.editor.id);await app.ok('owner','teams/member',{team_id:team.id,user_id:app.users.editor.id,role:'remove'});assert.equal((await app.call('editor','collaboration/open',{id:document.id})).status,404);assert.equal((await app.ok('owner','collaboration/open',{id:document.id})).presence.length,0);
  }finally{app.DB.close();}
});
test('collaboration quota or role races roll back content, history and operation receipts together',async()=>{
  const app=await fixture();try{
    const {team,project}=await app.team(),document=await app.ok('owner','collaboration/create',{team_id:team.id,project_id:project.id,consent:true,data:{title:'模拟事务'}}),payload={id:document.id,base_revision:1,operation_id:uid(),data:{...document.data,body:'修改'}};
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040').run();assert.equal((await app.call('editor','collaboration/save',payload)).status,413);assert.equal((await app.ok('viewer','collaboration/open',{id:document.id})).revision,1);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM collaboration_operations').get().count,0);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=0').run();const batch=app.DB.batch;app.DB.batch=async statements=>{app.DB.raw.prepare("UPDATE team_members SET role='viewer' WHERE user_id=? AND team_id=?").run(app.users.editor.id,team.id);return batch(statements);};assert.equal((await app.call('editor','collaboration/save',payload)).status,409);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM collaboration_versions').get().count,1);
  }finally{app.DB.close();}
});
test('new synchronization and collaboration routes enforce sessions, POST and CSRF',async()=>{
  const app=await fixture();try{
    for(const route of ['sync/apply','collaboration/list','collaboration/create','collaboration/open','collaboration/poll','collaboration/save','collaboration/version'])assert.equal((await app.call('owner',route)).status,405);
    const response=await worker.fetch(new Request('https://colorlens.test/api/sync/apply',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.test',Cookie:app.users.owner.cookie},body:'{}'}),app.env);assert.equal(response.status,403);
    const unauthed=await worker.fetch(new Request('https://colorlens.test/api/collaboration/open',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://colorlens.test'},body:'{}'}),app.env);assert.equal(unauthed.status,401);
  }finally{app.DB.close();}
});
