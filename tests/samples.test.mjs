import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,now} from '../src/common.mjs';

async function fixture(){
  const DB=localDatabase(),env={DB},users={};
  for(const [name,role] of [['owner','member'],['editor','member'],['viewer','member'],['reviewer','member'],['outsider','admin']]){
    const id=uid(),token=uid()+uid(),csrf=uid();DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),'unused',role,now(),'同名同学',name+'@example.test',now());
    DB.raw.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) VALUES(?,?,?,?,0)').run(await sha(token),id,csrf,Math.floor(Date.now()/1000)+3600);users[name]={id,cookie:'__Host-ColorLens='+token,csrf};
  }
  async function call(name,action,payload){const user=users[name],response=await worker.fetch(new Request('https://colorlens.test/api/'+action,{method:payload===undefined?'GET':'POST',headers:{Cookie:user.cookie,...payload===undefined?{}:{Origin:'https://colorlens.test','Content-Type':'application/json','X-ColorLens-Token':user.csrf}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,data:await response.json()};}
  async function ok(name,action,payload){const result=await call(name,action,payload);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function team(){const created=await ok('owner','teams/create',{name:'模拟样本团队'});for(const role of ['editor','viewer','reviewer']){await ok('owner','teams/invite',{team_id:created.id,email:role+'@example.test',role});const invites=(await ok(role,'teams')).invites;await ok(role,'teams/accept',{invite_id:invites[0].id});}return created.id;}
  const create=(name,data={})=>ok(name,'samples/create',{code:'S-001',name:'模拟样本',kind:'核酸',unit:'µL',quantity:'1',...data});
  return {DB,env,users,call,ok,team,create};
}

test('samples remain private unless explicitly registered in a team, with server-enforced roles',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),privateSample=await app.create('editor');assert.equal((await app.call('owner','samples/detail',{id:privateSample.id})).status,404);assert.equal((await app.call('outsider','samples/detail',{id:privateSample.id})).status,404);
    assert.equal((await app.call('editor','samples/create',{team_id:teamId,code:'T-1',name:'模拟团队样本',kind:'核酸',unit:'µL',quantity:'1'})).status,400);
    const sample=await app.create('editor',{team_id:teamId,consent:true});assert.equal((await app.ok('viewer','samples/detail',{id:sample.id})).name,'模拟样本');
    for(const role of ['viewer','reviewer'])assert.equal((await app.call(role,'samples/action',{id:sample.id,revision:1,action:'consume',quantity:'0.1',reason:'不允许修改'})).status,403);
    assert.equal((await app.call('outsider','samples/list',{team_id:teamId})).status,404);
    await app.ok('owner','teams/member',{team_id:teamId,user_id:app.users.viewer.id,role:'remove'});assert.equal((await app.call('viewer','samples/detail',{id:sample.id})).status,404);
    assert.equal((await app.ok('editor','samples/list',{})).samples.length,1);assert.equal((await app.ok('editor','samples/list',{team_id:teamId})).samples.length,1);
  }finally{app.DB.close();}
});

test('fixed decimal stock movements preserve exact balances, history and optimistic concurrency',async()=>{
  const app=await fixture();try{
    let sample=await app.create('owner',{quantity:'0.3'});sample=await app.ok('owner','samples/action',{id:sample.id,revision:sample.revision,action:'consume',quantity:'0.1',reason:'模拟领用'});assert.equal(sample.quantity,'0.2');assert.equal(sample.events[1].delta,'-0.1');
    assert.equal((await app.call('owner','samples/action',{id:sample.id,revision:1,action:'consume',quantity:'0.1',reason:'旧修订'})).status,409);
    assert.equal((await app.call('owner','samples/action',{id:sample.id,revision:sample.revision,action:'consume',quantity:'0.3',reason:'超领'})).status,400);
    sample=await app.ok('owner','samples/action',{id:sample.id,revision:sample.revision,action:'add',quantity:'0.000001',reason:'模拟补入'});assert.equal(sample.quantity,'0.200001');
    sample=await app.ok('owner','samples/action',{id:sample.id,revision:sample.revision,action:'correct',quantity:'0',reason:'盘点发现耗尽'});assert.equal(sample.quantity,'0');assert.equal(sample.events.length,4);assert.equal(sample.events[3].delta,'-0.200001');
    for(const value of ['-1','1e3','NaN','0.0000001','1000000000',1])assert.equal((await app.call('owner','samples/create',{code:uid(),name:'模拟非法数量',kind:'核酸',unit:'µL',quantity:value})).status,400);
    assert.equal((await app.call('owner','samples/create',{code:'COUNT',name:'模拟管数',kind:'其他',unit:'支',quantity:'0.1'})).status,400);
    assert.equal((await app.call('owner','samples/action',{id:sample.id,revision:sample.revision,action:'add',quantity:'1',reason:''})).status,400);
  }finally{app.DB.close();}
});

test('freezer slots are scope-bound and uniquely occupied; failed moves leave old positions intact',async()=>{
  const app=await fixture();try{
    const box=await app.ok('owner','samples/box-create',{freezer:'-80 冰箱',rack:'架 1',name:'盒 1',rows:2,columns:3});
    let first=await app.create('owner',{box_id:box.id,slot:'A1'});const second=await app.create('owner',{code:'S-002',box_id:box.id,slot:'A2'});
    assert.equal((await app.call('owner','samples/action',{id:first.id,revision:first.revision,action:'move',box_id:box.id,slot:'A2',reason:'占用冲突'})).status,409);
    assert.equal((await app.ok('owner','samples/detail',{id:first.id})).slot,'A1');assert.equal((await app.ok('owner','samples/detail',{id:second.id})).slot,'A2');
    assert.equal((await app.call('owner','samples/action',{id:first.id,revision:first.revision,action:'move',box_id:box.id,slot:'C1',reason:'越界'})).status,400);
    assert.equal((await app.call('editor','samples/create',{code:'FOREIGN',name:'模拟越权',kind:'核酸',quantity:'1',unit:'µL',box_id:box.id,slot:'B1'})).status,404);
    first=await app.ok('owner','samples/action',{id:first.id,revision:first.revision,action:'move',box_id:box.id,slot:'B3',reason:'模拟移库'});assert.equal(first.slot,'B3');
    const map=await app.ok('owner','samples/box',{id:box.id});assert.equal(map.occupants.length,2);assert.ok(map.occupants.some(sample=>sample.slot==='B3'));
  }finally{app.DB.close();}
});

test('aliquots preserve lineage and atomically transfer stock without changing units',async()=>{
  const app=await fixture();try{
    let parent=await app.create('owner',{quantity:'1.5'});
    const child=await app.ok('owner','samples/aliquot',{id:parent.id,revision:parent.revision,code:'S-001-A',name:'模拟分装',quantity:'0.4',reason:'首次分装'});assert.equal(child.quantity,'0.4');assert.equal(child.parent.id,parent.id);
    parent=await app.ok('owner','samples/detail',{id:parent.id});assert.equal(parent.quantity,'1.1');assert.equal(parent.children[0].id,child.id);assert.equal(parent.events[1].kind,'aliquot');
    assert.equal((await app.call('owner','samples/aliquot',{id:parent.id,revision:parent.revision,code:'S-001-A',name:'重复编号',quantity:'0.4',reason:'冲突'})).status,409);assert.equal((await app.ok('owner','samples/detail',{id:parent.id})).quantity,'1.1');
    assert.equal((await app.call('owner','samples/action',{id:parent.id,revision:parent.revision,action:'retire',reason:'有余量不能归档'})).status,400);
    const empty=await app.ok('owner','samples/action',{id:parent.id,revision:parent.revision,action:'consume',quantity:'1.1',reason:'模拟耗尽'}),retired=await app.ok('owner','samples/action',{id:parent.id,revision:empty.revision,action:'retire',reason:'归档空管'});assert.equal(retired.status,'archived');assert.equal(retired.box_id,null);
    assert.equal((await app.call('owner','samples/action',{id:parent.id,revision:retired.revision,action:'add',quantity:'1',reason:'归档后'})).status,409);
  }finally{app.DB.close();}
});

test('sample associations reveal only the current account private notebook and do not bypass completed locks',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),sample=await app.create('editor',{team_id:teamId,consent:true}),note=await app.ok('editor','notebook/create',{data:{title:'PRIVATE-NOTE-TITLE',body:'PRIVATE-NOTE-BODY'}});
    const completed=await app.ok('editor','notebook/save',{id:note.id,revision:note.revision,data:{...note.data,status:'complete'}});
    const linked=await app.ok('editor','samples/link',{id:sample.id,entry_id:note.id,active:true});assert.equal(linked.linked_notes.length,1);assert.equal(linked.revision,1);
    const others=await app.ok('owner','samples/detail',{id:sample.id});assert.deepEqual(others.linked_notes,[]);assert.ok(!JSON.stringify(others).includes('PRIVATE-NOTE'));assert.ok(!JSON.stringify(others).includes(note.id));
    assert.equal((await app.call('owner','samples/link',{id:sample.id,entry_id:note.id,active:true})).status,404);
    assert.equal((await app.call('owner','samples/for-note',{entry_id:note.id})).status,404);
    assert.equal((await app.ok('editor','samples/for-note',{entry_id:note.id})).samples[0].id,sample.id);
    assert.equal((await app.ok('editor','notebook/entry/'+note.id)).revision,completed.revision);
    await app.ok('editor','samples/link',{id:sample.id,entry_id:note.id,active:false});assert.equal((await app.ok('editor','samples/for-note',{entry_id:note.id})).samples.length,0);
    await app.ok('editor','samples/link',{id:sample.id,entry_id:note.id,active:true});assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_links').get().count,1);
    await app.ok('owner','teams/member',{team_id:teamId,user_id:app.users.editor.id,role:'remove'});assert.equal((await app.ok('editor','samples/for-note',{entry_id:note.id})).samples.length,0);assert.equal((await app.call('editor','samples/archive',{id:sample.id})).status,404);
  }finally{app.DB.close();}
});

test('transaction permission changes and quota failures cannot partially consume or split stock',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),sample=await app.create('editor',{team_id:teamId,consent:true}),batch=app.DB.batch;let raced=false;
    app.DB.batch=async statements=>{if(!raced){raced=true;app.DB.raw.prepare("UPDATE team_members SET role='viewer' WHERE team_id=? AND user_id=?").run(teamId,app.users.editor.id);}return batch(statements);};
    assert.equal((await app.call('editor','samples/aliquot',{id:sample.id,revision:1,code:'S-CHILD',name:'模拟降权',quantity:'0.5',reason:'并发分装'})).status,409);
    app.DB.batch=batch;const unchanged=await app.ok('owner','samples/detail',{id:sample.id});assert.equal(unchanged.quantity,'1');assert.equal(unchanged.events.length,1);assert.equal(unchanged.children.length,0);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();
    assert.equal((await app.call('owner','samples/action',{id:sample.id,revision:1,action:'consume',quantity:'0.1',reason:'配额阻止'})).status,413);assert.equal((await app.ok('owner','samples/detail',{id:sample.id})).quantity,'1');
  }finally{app.DB.close();}
});

test('sample event limits, code identity and location invariants remain bounded',async()=>{
  const app=await fixture();try{
    let sample=await app.create('owner');assert.equal((await app.call('owner','samples/create',{code:'s-001',name:'重复编号',kind:'核酸',unit:'µL',quantity:'1'})).status,409);
    assert.equal((await app.call('owner','samples/create',{code:'ß'.repeat(60),name:'扩展编号',kind:'核酸',unit:'µL',quantity:'1'})).status,400);
    for(const rows of [0,17,1.5,'2'])assert.equal((await app.call('owner','samples/box-create',{freezer:'模拟',rack:'1',name:'1',rows,columns:2})).status,400);
    app.DB.raw.prepare('UPDATE lab_samples SET revision=160 WHERE id=?').run(sample.id);
    assert.equal((await app.call('owner','samples/action',{id:sample.id,revision:160,action:'consume',quantity:'0.1',reason:'流水已满'})).status,409);sample=await app.ok('owner','samples/detail',{id:sample.id});assert.equal(sample.quantity,'1');assert.equal(sample.revision,160);
    const exported=await app.ok('owner','samples/archive',{id:sample.id});assert.equal(exported.schema,'colorlens-sample-1');assert.equal(exported.sample.events.length,1);
    app.DB.raw.prepare('UPDATE users SET disabled=1 WHERE id=?').run(app.users.owner.id);assert.equal((await app.call('owner','samples/detail',{id:sample.id})).status,401);
  }finally{app.DB.close();}
});

test('sample APIs enforce login, POST and CSRF, including read details and exports',async()=>{
  const app=await fixture();try{
    assert.equal((await worker.fetch(new Request('https://colorlens.test/api/samples'),{DB:app.DB})).status,401);
    for(const action of ['list','detail','box','box-create','create','action','aliquot','link','for-note','archive'])assert.equal((await app.call('owner','samples/'+action)).status,405);
    const response=await worker.fetch(new Request('https://colorlens.test/api/samples/create',{method:'POST',headers:{Cookie:app.users.owner.cookie,'Content-Type':'application/json',Origin:'https://evil.test'},body:'{}'}),{DB:app.DB});assert.equal(response.status,403);
  }finally{app.DB.close();}
});

test('racing stock and slot reservations have exactly one winner and no orphaned ledger rows',async()=>{
  const app=await fixture();try{
    const sample=await app.create('owner'),movements=await Promise.all(['一次','二次'].map(reason=>app.call('owner','samples/action',{id:sample.id,revision:1,action:'consume',quantity:'0.6',reason:'模拟并发 '+reason})));assert.deepEqual(movements.map(result=>result.status).sort(),[200,409]);
    const latest=await app.ok('owner','samples/detail',{id:sample.id});assert.equal(latest.quantity,'0.4');assert.equal(latest.events.length,2);
    const box=await app.ok('owner','samples/box-create',{freezer:'模拟并发冰箱',rack:'1',name:'1',rows:1,columns:1});
    const reserved=await Promise.all(['ONE','TWO'].map(code=>app.call('owner','samples/create',{code,name:'模拟抢占',kind:'其他',unit:'支',quantity:'1',box_id:box.id,slot:'A1'})));assert.deepEqual(reserved.map(result=>result.status).sort(),[200,409]);assert.equal((await app.ok('owner','samples/box',{id:box.id})).occupants.length,1);
    assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM lab_samples').get().count,2);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM sample_events').get().count,3);
  }finally{app.DB.close();}
});

test('personal link removal remains possible at document capacity and re-linking does not double-charge',async()=>{
  const app=await fixture();try{
    const sample=await app.create('owner'),note=await app.ok('owner','notebook/create',{data:{title:'模拟关联'}});await app.ok('owner','samples/link',{id:sample.id,entry_id:note.id,active:true});
    const count=app.DB.raw.prepare('SELECT COUNT(*) AS count FROM document_usage').get().count;app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();
    assert.equal((await app.ok('owner','samples/link',{id:sample.id,entry_id:note.id,active:false})).linked_notes.length,0);assert.equal((await app.ok('owner','samples/link',{id:sample.id,entry_id:note.id,active:true})).linked_notes.length,1);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM document_usage').get().count,count);
  }finally{app.DB.close();}
});
