import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,now} from '../src/common.mjs';

async function fixture(){
  const DB=localDatabase(),env={DB},users={};
  for(const [name,role] of [['owner','member'],['editor','member'],['reviewer','member'],['viewer','member'],['outsider','admin']]){
    const id=uid(),token=uid()+uid(),csrf=uid();
    DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),'unused',role,now(),'相同中文昵称',name+'@example.test',now());
    DB.raw.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) VALUES(?,?,?,?,0)').run(await sha(token),id,csrf,Math.floor(Date.now()/1000)+3600);
    users[name]={id,cookie:'__Host-ColorLens='+token,csrf};
  }
  async function call(name,action,payload){
    const user=users[name],response=await worker.fetch(new Request('https://colorlens.test/api/'+action,{method:payload===undefined?'GET':'POST',headers:{Cookie:user.cookie,...payload===undefined?{}:{Origin:'https://colorlens.test','Content-Type':'application/json','X-ColorLens-Token':user.csrf}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);
    return {status:response.status,data:await response.json()};
  }
  async function ok(name,action,payload){const response=await call(name,action,payload);assert.equal(response.status,200,JSON.stringify(response.data));return response.data;}
  async function team(){
    const created=await ok('owner','teams/create',{name:'模拟实验室'});
    for(const role of ['editor','reviewer','viewer']){await ok('owner','teams/invite',{team_id:created.id,email:role+'@example.test',role});const inbox=await ok(role,'teams');await ok(role,'teams/accept',{invite_id:inbox.invites[0].id});}
    const project=await ok('editor','teams/project',{team_id:created.id,title:'模拟课题',description:'仅限团队'});
    return {team:created,project};
  }
  return {DB,users,call,ok,team};
}

test('teams use verified email identity and explicit memberships, not platform admin or duplicate names',async()=>{
  const app=await fixture();try{
    const {team,project}=await app.team();
    assert.equal((await app.call('outsider','teams/detail',{team_id:team.id})).status,404);
    assert.equal((await app.call('viewer','teams/invite',{team_id:team.id,email:'outsider@example.test',role:'owner'})).status,403);
    assert.equal((await app.call('viewer','teams/project',{team_id:team.id,title:'不允许'})).status,403);
    assert.equal((await app.call('editor','teams/member',{team_id:team.id,user_id:app.users.viewer.id,role:'reviewer'})).status,403);
    const detail=await app.ok('viewer','teams/detail',{team_id:team.id});assert.equal(detail.members.length,4);assert.equal(detail.projects[0].id,project.id);assert.ok(detail.members.every(member=>!('email' in member)));assert.deepEqual(detail.invites,[]);
    await app.ok('owner','teams/invite',{team_id:team.id,email:'outsider@example.test',role:'viewer'});
    const invitation=(await app.ok('outsider','teams')).invites[0];
    assert.equal((await app.call('viewer','teams/accept',{invite_id:invitation.id})).status,404);
    app.DB.raw.prepare('UPDATE users SET email_verified_at=NULL WHERE id=?').run(app.users.outsider.id);
    assert.equal((await app.call('outsider','teams/accept',{invite_id:invitation.id})).status,401);
    assert.equal((await app.call('owner','teams/member',{team_id:team.id,user_id:app.users.owner.id,role:'viewer'})).status,400);
  }finally{app.DB.close();}
});

test('team submissions are explicit frozen text copies; review revisions and removal never expose private resources',async()=>{
  const app=await fixture();try{
    const {team,project}=await app.team(),note=await app.ok('editor','notebook/create',{data:{title:'模拟私有记录',body:'原始说明',results:'模拟结果'}});
    assert.equal((await app.call('owner','notebook/entry/'+note.id)).status,404);
    assert.equal((await app.ok('owner','teams/detail',{team_id:team.id})).submissions.length,0);
    assert.equal((await app.call('owner','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1,consent:true})).status,404);
    assert.equal((await app.call('editor','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1})).status,400);
    const submitted=await app.ok('editor','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1,consent:true});
    let shared=await app.ok('viewer','teams/submission',{id:submitted.id});assert.equal(shared.snapshot.data.body,'原始说明');assert.equal(shared.snapshot.source_revision,1);for(const key of ['source_id','entry_id','attachments','analyses','ai_runs'])assert.ok(!(key in shared));assert.ok(!('events' in shared.snapshot));
    assert.equal((await app.call('outsider','teams/submission',{id:submitted.id})).status,404);
    assert.equal((await app.call('viewer','teams/comment',{id:submitted.id,revision:shared.revision,text:'不允许'})).status,403);
    assert.equal((await app.call('editor','teams/review',{id:submitted.id,revision:shared.revision,status:'approved',text:'自己通过'})).status,403);
    shared=await app.ok('reviewer','teams/comment',{id:submitted.id,revision:shared.revision,text:'请补充模拟步骤'});
    assert.equal((await app.call('reviewer','teams/review',{id:submitted.id,revision:1,status:'approved',text:'旧版本'})).status,409);
    shared=await app.ok('reviewer','teams/review',{id:submitted.id,revision:shared.revision,status:'changes_requested',text:'需要补充'});assert.equal(shared.status,'changes_requested');
    const edited=await app.ok('editor','notebook/save',{id:note.id,revision:1,data:{...note.data,body:'修订后的正文'}});
    assert.equal((await app.ok('viewer','teams/submission',{id:submitted.id})).snapshot.data.body,'原始说明');
    shared=await app.ok('editor','teams/submit',{id:submitted.id,revision:shared.revision,project_id:project.id,entry_id:note.id,entry_revision:edited.revision,consent:true});assert.equal(shared.version,2);assert.equal(shared.status,'pending');assert.equal(shared.versions.length,2);assert.equal(shared.events[1].version,1);
    const history=await app.ok('viewer','teams/submission',{id:submitted.id,version:1});assert.equal(history.snapshot.data.body,'原始说明');
    shared=await app.ok('reviewer','teams/review',{id:submitted.id,revision:shared.revision,status:'approved',text:'仅供模拟评阅'});
    const archive=await app.ok('viewer','teams/archive',{id:submitted.id});assert.equal(archive.versions.length,2);assert.equal(archive.versions[0].snapshot.data.body,'原始说明');assert.ok(!('source_id' in archive.record));
    assert.equal((await app.ok('editor','notebook/entry/'+note.id)).data.status,'draft');
    assert.ok(app.DB.raw.prepare("SELECT COUNT(*) AS count FROM document_usage WHERE key LIKE 'team:%'").get().count>=5);
    await app.ok('owner','teams/member',{team_id:team.id,user_id:app.users.viewer.id,role:'remove'});assert.equal((await app.call('viewer','teams/submission',{id:submitted.id,version:1})).status,404);
    shared=await app.ok('editor','teams/withdraw',{id:submitted.id,revision:shared.revision,text:'撤回模拟稿'});assert.equal(shared.status,'withdrawn');assert.equal(shared.snapshot,null);assert.equal((await app.ok('owner','teams/submission',{id:submitted.id,version:1})).snapshot,null);
    assert.equal((await app.call('reviewer','teams/comment',{id:submitted.id,revision:shared.revision,text:'撤回后'})).status,409);
    assert.equal((await app.call('owner','notebook/archive/'+note.id)).status,404);
  }finally{app.DB.close();}
});

test('team invitation expiry, cancellation, replacement and role restrictions fail closed',async()=>{
  const app=await fixture();try{
    const team=await app.ok('owner','teams/create',{name:'邀请测试'});
    await app.ok('owner','teams/invite',{team_id:team.id,email:'EDITOR@EXAMPLE.TEST',role:'viewer'});
    const firstInvite=(await app.ok('editor','teams')).invites[0];
    await app.ok('owner','teams/invite',{team_id:team.id,email:'editor@example.test',role:'editor'});
    assert.equal((await app.call('editor','teams/accept',{invite_id:firstInvite.id})).status,404);
    const second=(await app.ok('editor','teams')).invites[0];app.DB.raw.prepare('UPDATE team_invites SET expires=0 WHERE id=?').run(second.id);
    assert.equal((await app.call('editor','teams/accept',{invite_id:second.id})).status,404);
    await app.ok('owner','teams/invite',{team_id:team.id,email:'editor@example.test',role:'reviewer'});
    const third=(await app.ok('editor','teams')).invites[0];await app.ok('owner','teams/cancel',{team_id:team.id,invite_id:third.id});assert.equal((await app.call('editor','teams/accept',{invite_id:third.id})).status,404);
    assert.equal((await app.call('owner','teams/invite',{team_id:team.id,email:'viewer@example.test',role:'owner'})).status,400);
    app.DB.raw.prepare('UPDATE users SET disabled=1 WHERE id=?').run(app.users.owner.id);
    assert.equal((await app.call('owner','teams/detail',{team_id:team.id})).status,401);
  }finally{app.DB.close();}
});

test('membership downgrade during a submission transaction rolls back the entire write',async()=>{
  const app=await fixture();try{
    const {team,project}=await app.team(),note=await app.ok('editor','notebook/create',{data:{title:'模拟并发'}}),before=app.DB.raw.prepare('SELECT doc_bytes FROM users WHERE id=?').get(app.users.editor.id).doc_bytes;
    const batch=app.DB.batch;let raced=false;
    app.DB.batch=async statements=>{if(!raced){raced=true;app.DB.raw.prepare("UPDATE team_members SET role='viewer' WHERE team_id=? AND user_id=?").run(team.id,app.users.editor.id);}return batch(statements);};
    assert.equal((await app.call('editor','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1,consent:true})).status,409);
    assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM team_submissions').get().count,0);assert.equal(app.DB.raw.prepare('SELECT doc_bytes FROM users WHERE id=?').get(app.users.editor.id).doc_bytes,before);
    assert.equal((await app.call('editor','teams/project',{team_id:team.id,title:'降权后创建'})).status,403);
  }finally{app.DB.close();}
});

test('team copies strip inline image capabilities and never inherit AI, original attachments or source history',async()=>{
  const app=await fixture();try{
    const {project}=await app.team(),note=await app.ok('editor','notebook/create',{data:{title:'模拟隐私边界',body:'正文',results:'已主动写入的人工摘要'}}),imageId=uid();
    const document=structuredClone(note);document.revision=2;document.data.body='前文[[colorlens-image:'+imageId+']]后文';document.attachments=[{id:imageId,filename:'PRIVATE-FILENAME.png'}];document.events=[{text:'PRIVATE-ORIGINAL-EVENT'}];document.analyses=[{id:uid()}];
    app.DB.raw.prepare('UPDATE entries SET doc=?,revision=2 WHERE id=?').run(JSON.stringify(document),note.id);
    const preview=await app.ok('editor','teams/preview',{entry_id:note.id,project_id:project.id});assert.equal(preview.snapshot.data.body,'前文［图片未提交；原附件仍私有］后文');
    const shared=await app.ok('editor','teams/submit',{entry_id:note.id,entry_revision:2,project_id:project.id,consent:true}),read=await app.ok('reviewer','teams/submission',{id:shared.id});const serialized=JSON.stringify(read);
    for(const forbidden of [imageId,note.id,'PRIVATE-FILENAME','PRIVATE-ORIGINAL-EVENT'])assert.ok(!serialized.includes(forbidden));assert.ok(serialized.includes('已主动写入的人工摘要'));
    for(const route of ['entry/','history/','archive/','preview/','attachment/'])assert.equal((await app.call('reviewer','notebook/'+route+(route.includes('view')||route.includes('attachment')?imageId:note.id))).status,404);
    const edited=await app.ok('editor','notebook/save',{id:note.id,revision:2,data:{...note.data,body:'最新私人正文'}});
    assert.equal((await app.call('editor','teams/submit',{entry_id:note.id,entry_revision:2,project_id:project.id,consent:true})).status,409);assert.equal(edited.revision,3);
    const other=await app.ok('editor','notebook/create',{data:{title:'另一私有记录'}});
    assert.equal((await app.call('editor','teams/submit',{id:shared.id,revision:shared.revision,entry_id:other.id,entry_revision:1,project_id:project.id,consent:true})).status,403);
  }finally{app.DB.close();}
});

test('team row limits and quota failures are atomic, while privacy withdrawal remains possible at capacity',async()=>{
  const app=await fixture();try{
    const {project}=await app.team();for(let index=0;index<2;index++)await app.ok('owner','teams/create',{name:'模拟团队 '+index});assert.equal((await app.call('owner','teams/create',{name:'超额团队'})).status,409);
    const note=await app.ok('editor','notebook/create',{data:{title:'模拟配额'}}),submission=await app.ok('editor','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1,consent:true});
    for(let index=0;index<199;index++)app.DB.raw.prepare('INSERT INTO team_events VALUES(?,?,?,?,?,?,?,?)').run(uid(),submission.id,app.users.editor.id,'模拟作者',1,'comment','模拟占位 '+index,now());
    assert.equal((await app.call('reviewer','teams/comment',{id:submission.id,revision:1,text:'超额评论'})).status,409);assert.equal((await app.ok('viewer','teams/submission',{id:submission.id})).revision,1);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();
    const withdrawn=await app.ok('editor','teams/withdraw',{id:submission.id,revision:1,text:'即使满额也需撤回'});assert.equal(withdrawn.status,'withdrawn');assert.equal(withdrawn.events.length,201);
    const before=app.DB.raw.prepare('SELECT COUNT(*) AS count FROM team_projects').get().count;
    assert.equal((await app.call('owner','teams/project',{team_id:withdrawn.team_id,title:'不能绕过文字配额'})).status,413);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM team_projects').get().count,before);
    assert.deepEqual((await app.ok('viewer','teams/archive',{id:submission.id})).versions,[]);
  }finally{app.DB.close();}
});

test('team endpoints require a session and POST plus CSRF for all details and mutations',async()=>{
  const app=await fixture();try{
    assert.equal((await worker.fetch(new Request('https://colorlens.test/api/teams'),{DB:app.DB})).status,401);
    for(const action of ['create','detail','project','invite','accept','cancel','member','preview','submit','submission','archive','comment','review','withdraw'])assert.equal((await app.call('owner','teams/'+action)).status,405);
    const response=await worker.fetch(new Request('https://colorlens.test/api/teams/create',{method:'POST',headers:{Cookie:app.users.owner.cookie,Origin:'https://evil.test','Content-Type':'application/json'},body:JSON.stringify({name:'禁止跨站'})}),{DB:app.DB});assert.equal(response.status,403);
  }finally{app.DB.close();}
});

test('corrupted team text cannot be displayed or exported as an intact submission',async()=>{
  const app=await fixture();try{
    const {project}=await app.team(),note=await app.ok('editor','notebook/create',{data:{title:'模拟完整性'}}),saved=await app.ok('editor','teams/submit',{project_id:project.id,entry_id:note.id,entry_revision:1,consent:true});
    app.DB.raw.prepare('UPDATE team_versions SET snapshot=? WHERE submission_id=?').run('{"corrupted":true}',saved.id);
    assert.equal((await app.call('viewer','teams/submission',{id:saved.id})).status,503);assert.equal((await app.call('viewer','teams/archive',{id:saved.id})).status,503);
  }finally{app.DB.close();}
});
