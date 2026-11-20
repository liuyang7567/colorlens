import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,now} from '../src/common.mjs';

async function fixture(){
  const DB=localDatabase(),env={DB},users={};for(const [name,role] of [['owner','member'],['editor','member'],['viewer','member'],['outsider','admin']]){const id=uid(),token=uid()+uid(),csrf=uid();DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),'unused',role,now(),'同名设备同学',name+'@example.test',now());DB.raw.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) VALUES(?,?,?,?,0)').run(await sha(token),id,csrf,Math.floor(Date.now()/1000)+3600);users[name]={id,cookie:'__Host-ColorLens='+token,csrf};}
  async function call(name,route,payload){const user=users[name],response=await worker.fetch(new Request('https://colorlens.test/api/'+route,{method:payload===undefined?'GET':'POST',headers:{Cookie:user.cookie,...payload===undefined?{}:{Origin:'https://colorlens.test','Content-Type':'application/json','X-ColorLens-Token':user.csrf}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,data:await response.json()};}
  async function ok(name,route,payload){const result=await call(name,route,payload);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function team(){const result=await ok('owner','teams/create',{name:'模拟预约团队'});for(const role of ['editor','viewer']){await ok('owner','teams/invite',{team_id:result.id,email:role+'@example.test',role});const invite=(await ok(role,'teams')).invites[0];await ok(role,'teams/accept',{invite_id:invite.id});}return result.id;}
  const create=(data={})=>ok('owner','equipment/create',{code:'EQ-1',name:'模拟 qPCR 仪',location:'实验室 A',...data});
  const stamp=minutes=>new Date(Math.floor(Date.now()/60000)*60000+minutes*60000).toISOString();
  return {DB,env,users,call,ok,team,create,stamp};
}

test('equipment and reservations enforce private/team roles and prevent overlap while allowing adjacent slots',async()=>{
  const app=await fixture();try{
    const privateDevice=await app.create();assert.equal((await app.call('outsider','equipment/detail',{id:privateDevice.id})).status,404);const teamId=await app.team();let device=await app.create({team_id:teamId,code:'TEAM-EQ',consent:true});
    assert.equal((await app.call('editor','equipment/create',{team_id:teamId,code:'FORGED',name:'不允许',consent:true})).status,403);
    const first=await app.ok('editor','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(60),end:app.stamp(120),purpose:'模拟预约'});device=first;
    assert.equal((await app.call('owner','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(90),end:app.stamp(150),purpose:'冲突'})).status,409);
    device=await app.ok('owner','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(120),end:app.stamp(180),purpose:'相邻预约'});assert.equal(device.bookings.length,2);
    assert.equal((await app.call('viewer','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(180),end:app.stamp(200),purpose:'只读'})).status,403);
  }finally{app.DB.close();}
});

test('cancellation, maintenance and actual usage preserve reservation history without pretending to measure hardware',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let device=await app.create({team_id:teamId,consent:true});device=await app.ok('editor','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(60),end:app.stamp(120),purpose:'模拟使用'});const booking=device.bookings[0];
    assert.equal((await app.call('owner','equipment/action',{id:device.id,revision:device.revision,action:'maintenance',reason:'不能静默使预约失效'})).status,409);
    device=await app.ok('editor','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:booking.id,booking_revision:booking.revision,action:'cancel',reason:'主动取消'});assert.equal(device.bookings[0].status,'cancelled');
    device=await app.ok('owner','equipment/action',{id:device.id,revision:device.revision,action:'maintenance',reason:'模拟维护'});assert.equal(device.status,'maintenance');
    assert.equal((await app.call('editor','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(60),end:app.stamp(120),purpose:'维护中'})).status,409);
    device=await app.ok('owner','equipment/action',{id:device.id,revision:device.revision,action:'available',reason:'恢复可预约'});
    device=await app.ok('editor','equipment/book',{id:device.id,revision:device.revision,start:app.stamp(-3),end:app.stamp(30),purpose:'刚开始的实验'});const current=device.bookings.find(item=>item.status==='confirmed');
    device=await app.ok('editor','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:current.id,booking_revision:1,action:'complete',actual_start:app.stamp(-2),actual_end:app.stamp(-1),reason:'人工填写使用记录'});assert.equal(device.bookings.find(item=>item.id===current.id).actual_minutes,1);assert.equal(device.bookings.find(item=>item.id===current.id).status,'completed');
    const archive=await app.ok('viewer','equipment/archive',{id:device.id});assert.equal(archive.device.bookings.length,2);assert.ok(archive.events.length>=6);
  }finally{app.DB.close();}
});

test('concurrent bookings and permission/quota failures never leave partial reservations',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),device=await app.create({team_id:teamId,consent:true}),input={id:device.id,revision:1,start:app.stamp(60),end:app.stamp(120),purpose:'模拟竞争'};
    const responses=await Promise.all(['editor','owner'].map(name=>app.call(name,'equipment/book',input)));assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    let current=await app.ok('owner','equipment/detail',{id:device.id});assert.equal(current.bookings.length,1);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();assert.equal((await app.call('owner','equipment/book',{...input,revision:current.revision,start:app.stamp(180),end:app.stamp(240)})).status,413);current=await app.ok('owner','equipment/detail',{id:device.id});assert.equal(current.bookings.length,1);
    await app.ok('owner','teams/member',{team_id:teamId,user_id:app.users.viewer.id,role:'remove'});assert.equal((await app.call('viewer','equipment/detail',{id:device.id})).status,404);
  }finally{app.DB.close();}
});

test('equipment endpoints validate timestamps, role boundaries, session and CSRF',async()=>{
  const app=await fixture();try{
    assert.equal((await worker.fetch(new Request('https://colorlens.test/api/equipment'),app.env)).status,401);for(const route of ['list','detail','create','action','book','booking-action','archive'])assert.equal((await app.call('owner','equipment/'+route)).status,405);
    const device=await app.create();for(const start of ['2026-02-30T12:00:00Z','2026-10-21T12:00','invalid',app.stamp(-60)])assert.equal((await app.call('owner','equipment/book',{id:device.id,revision:1,start,end:app.stamp(120),purpose:'格式测试'})).status,400);
    const response=await worker.fetch(new Request('https://colorlens.test/api/equipment/book',{method:'POST',headers:{Cookie:app.users.owner.cookie,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'}),app.env);assert.equal(response.status,403);
  }finally{app.DB.close();}
});

test('cancellation remains available at quota capacity and final booking records cannot be overwritten',async()=>{
  const app=await fixture();try{
    let device=await app.create();device=await app.ok('owner','equipment/book',{id:device.id,revision:1,start:app.stamp(60),end:app.stamp(120),purpose:'满额仍可取消'});const booking=device.bookings[0];app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();
    device=await app.ok('owner','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:booking.id,booking_revision:1,action:'cancel',reason:'释放时段'});assert.equal(device.bookings[0].status,'cancelled');assert.equal((await app.call('owner','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:booking.id,booking_revision:2,action:'cancel',reason:'不重复改写'})).status,409);
    assert.equal(device.events_total,3);
  }finally{app.DB.close();}
});

test('non-owners cannot cancel another member reservation or fabricate future usage',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let device=await app.create({team_id:teamId,consent:true});device=await app.ok('owner','equipment/book',{id:device.id,revision:1,start:app.stamp(-3),end:app.stamp(60),purpose:'负责人预约'});const booking=device.bookings[0];
    assert.equal((await app.call('editor','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:booking.id,booking_revision:1,action:'cancel',reason:'不能代取消'})).status,403);
    assert.equal((await app.call('owner','equipment/booking-action',{id:device.id,revision:device.revision,booking_id:booking.id,booking_revision:1,action:'complete',actual_start:app.stamp(-2),actual_end:app.stamp(30),reason:'拒绝未来实际记录'})).status,400);assert.equal((await app.ok('owner','equipment/detail',{id:device.id})).bookings[0].status,'confirmed');
  }finally{app.DB.close();}
});
