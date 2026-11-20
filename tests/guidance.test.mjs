import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {hashPassword} from '../src/auth.mjs';
import {uid,now,base64} from '../src/common.mjs';
import {guidanceProtocol,guidanceView} from '../src/guidance-store.mjs';
import {guidanceResult} from '../src/guidance.mjs';
import {encodeEln,decodeEln} from '../src/eln.mjs';

const password='independent guidance fixture password',pepper='guidance-only-fixture-pepper-123456789';
const stored=await hashPassword(password,pepper);
const result={visibility:'unclear',observation:'SIMULATED · 只能看到模拟标记，无法判断动作是否已经执行。',visible_evidence:['可见模拟试管'],uncertainties:['关键动作不在画面内'],suspected_deviations:[],questions:['请人工核对'],readings:[]};
const protocol={title:'SIMULATED · 教学演示',source:'模拟资料，不是真实 SOP',steps:[{title:'核对模拟标记',evidence:'可读的模拟标记'},{title:'记录可见结果',timer_seconds:15}]};
async function fixture(provider){
  const calls=[],env={DB:localDatabase(),AUTH_PEPPER:pepper,BOOTSTRAP_KEY:'fixture',DEEPSEEK_API_KEY:'fake-local-key',GUIDANCE_FETCH:async(url,options)=>{calls.push(JSON.parse(options.body));return provider?provider():new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...result,complete:true,next_step:99})}}]}));}};
  for(const email of ['guide-a@example.test','guide-b@example.test'])env.DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(uid(),uid(),stored,'member',now(),'同名测试用户',email,now());
  async function call(path,payload,identity={},method){const response=await worker.fetch(new Request('https://guide.test'+path,{method:method|| (payload===undefined?'GET':'POST'),headers:{Origin:'https://guide.test','Content-Type':'application/json','X-ColorLens-Token':identity.csrf||'',...identity.cookie?{Cookie:identity.cookie}:{}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  const login=async(email)=>{const logged=await call('/api/auth/login',{email,password});assert.equal(logged.status,200);return {cookie:logged.cookie,csrf:logged.body.csrf};};
  const first=await login('guide-a@example.test'),second=await login('guide-b@example.test');
  const entry=(await call('/api/notebook/create',{data:{title:'SIMULATED guidance acceptance',body:'原始实验记录不得自动改写。',tags:['模拟数据']}},first)).body;
  const create=async()=>{const payload={entry_id:entry.id,operation_id:uid(),protocol,reviewed:true};const response=await call('/api/guidance/create',payload,first);assert.equal(response.status,200);return response.body;};
  const action=async(run,action,extra={})=>call('/api/guidance/action',{run_id:run.id,revision:run.revision,operation_id:uid(),action,...extra},first);
  const nonce='a'.repeat(64);
  const enable=async(run,extra={})=>{const issued=await call('/api/capture/ticket',{id:entry.id,nonce},first);return action(run,'enable',{capture_ticket:issued.body.ticket,source_nonce:nonce,image_consent:true,sop_consent:true,cost_consent:true,interval_s:30,maximum:3,...extra});};
  const frame=run=>({run_id:run.id,epoch:run.monitor.epoch,source_nonce:nonce,operation_id:uid(),captured_at:now(),width:640,height:360,image:base64(new Uint8Array([255,216,255,224,0,0,255,217]))});
  return {env,calls,call,first,second,entry,create,action,enable,frame};
}
test('SOP validation bounds steps and timers; visual schema ignores model control instructions',()=>{
  assert.equal(guidanceProtocol(protocol).steps[0].number,1);assert.throws(()=>guidanceProtocol({...protocol,steps:[]}));assert.throws(()=>guidanceProtocol({...protocol,steps:[{title:'x',timer_seconds:-1}]}));
  assert.throws(()=>guidanceProtocol({...protocol,steps:Array.from({length:31},()=>({title:'x'}))}));
  const validated=guidanceResult({...result,complete:true,next_step:5});assert.equal(Object.hasOwn(validated,'complete'),false);assert.throws(()=>guidanceResult({...result,visibility:'guaranteed'}));
});
test('guidance routes enforce email owner, CSRF, POST and explicit protocol review without AI calls',async()=>{
  const context=await fixture();try{
    assert.equal((await context.call('/api/guidance/list',{entry_id:context.entry.id})).status,401);
    assert.equal((await context.call('/api/guidance/list',{entry_id:context.entry.id},context.second)).status,404);
    assert.equal((await context.call('/api/guidance/list',undefined,context.first)).status,405);
    assert.equal((await context.call('/api/guidance/create',{entry_id:context.entry.id,operation_id:uid(),protocol},context.first)).status,400);
    assert.equal((await context.call('/api/guidance/list',{entry_id:context.entry.id},{cookie:context.first.cookie})).status,403);
    const run=await context.create();assert.equal((await context.call('/api/guidance/get',{run_id:run.id},context.second)).status,404);assert.equal(context.calls.length,0);
  }finally{context.env.DB.close();}
});
test('only explicit human controls change steps, with revision checks, idempotency and visible skip reasons',async()=>{
  const context=await fixture();try{
    let run=await context.create();run=(await context.action(run,'start')).body;
    assert.equal((await context.action(run,'advance')).status,409);
    assert.equal((await context.action(run,'skip',{confirmation:true,reason:''})).status,400);
    const payload={run_id:run.id,revision:run.revision,operation_id:uid(),action:'advance',confirmation:true};
    const advanced=await context.call('/api/guidance/action',payload,context.first);assert.equal(advanced.status,200);assert.equal(advanced.body.step_index,1);
    const replay=await context.call('/api/guidance/action',payload,context.first);assert.equal(replay.body.step_index,1);
    assert.equal((await context.action(run,'pause')).status,409);
    run=(await context.action(advanced.body,'advance',{confirmation:true})).body;assert.equal(run.status,'finished');assert.equal(run.monitor.expires_at,0);assert.equal(context.calls.length,0);
  }finally{context.env.DB.close();}
});
test('visual monitoring needs all three consents and a capture ticket bound to the correct experiment',async()=>{
  const context=await fixture();try{
    let run=(await context.action(await context.create(),'start')).body;
    assert.equal((await context.enable(run,{image_consent:false})).status,400);
    assert.equal((await context.enable(run,{sop_consent:false})).status,400);
    assert.equal((await context.enable(run,{cost_consent:false})).status,400);
    assert.equal((await context.enable(run,{source_nonce:'b'.repeat(64)})).status,403);
    const enabled=await context.enable(run);assert.equal(enabled.status,200);run=enabled.body;
    assert.equal((await context.call('/api/guidance/observe',{...context.frame(run),source_nonce:'b'.repeat(64)},context.first)).status,409);
    const payload=context.frame(run),observed=await context.call('/api/guidance/observe',payload,context.first);assert.equal(observed.status,200);assert.equal(observed.body.event.status,'complete');assert.equal(observed.body.run.step_index,0);assert.equal(context.calls.length,1);
    const replay=await context.call('/api/guidance/observe',payload,context.first);assert.equal(replay.body.replayed,true);assert.equal(context.calls.length,1);
    assert.equal((await context.call('/api/guidance/observe',context.frame(run),context.first)).status,429);
    const saved=(await context.call('/api/notebook/entry/'+context.entry.id,undefined,context.first)).body;assert.equal(saved.data.body,context.entry.data.body);assert.equal(saved.revision,context.entry.revision);
    assert.equal(Object.hasOwn(observed.body.event.data.result,'complete'),false);assert.equal(context.calls[0].messages[1].content.length,2);
  }finally{context.env.DB.close();}
});
test('pausing while vision is in flight makes the late result stale and never advances the workflow',async()=>{
  let release,entered;const gate=new Promise(resolve=>{entered=resolve;});const context=await fixture(()=>{entered();return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})));});});
  try{
    const run=(await context.enable((await context.action(await context.create(),'start')).body)).body;
    const pending=context.call('/api/guidance/observe',context.frame(run),context.first);await gate;
    const paused=await context.action(run,'pause');assert.equal(paused.status,200);release();
    const observed=await pending;assert.equal(observed.body.event.status,'stale');assert.equal(observed.body.run.status,'paused');assert.equal(observed.body.run.step_index,0);assert.equal(observed.body.run.monitor.expires_at,0);
  }finally{context.env.DB.close();}
});
test('failed vision attempts share the existing daily quota and are not silently retried',async()=>{
  const context=await fixture(()=>new Response('unavailable',{status:503}));try{
    const run=(await context.enable((await context.action(await context.create(),'start')).body)).body,payload=context.frame(run);
    const observed=await context.call('/api/guidance/observe',payload,context.first);assert.equal(observed.body.event.status,'failed');
    await context.call('/api/guidance/observe',payload,context.first);assert.equal(context.calls.length,1);
    context.env.DB.raw.prepare('UPDATE guidance_runs SET last_call=0 WHERE id=?').run(run.id);
    context.env.DB.raw.prepare('UPDATE ai_budgets SET used=10 WHERE scope<>?').run('global');
    const limited=await context.call('/api/guidance/observe',context.frame(run),context.first);assert.equal(limited.status,429);assert.equal(context.calls.length,1);
    assert.equal(context.env.DB.raw.prepare('SELECT used FROM guidance_runs WHERE id=?').get(run.id).used,1);
  }finally{context.env.DB.close();}
});
test('guidance archive and standard ELN retain provenance without screenshots, active tickets or monitor authorization',async()=>{
  const context=await fixture();try{
    const run=(await context.enable((await context.action(await context.create(),'start')).body)).body;
    const payload=context.frame(run),observed=await context.call('/api/guidance/observe',payload,context.first);assert.equal(observed.status,200);
    const review=await context.action(observed.body.run,'review',{observation_id:observed.body.event.id,decision:'rejected',note:'模拟画面，不能用于真实判断。'});assert.equal(review.status,200);
    const archive=(await context.call('/api/notebook/archive/'+context.entry.id,undefined,context.first)).body;
    assert.equal(archive.guidance.length,1);assert.equal(archive.guidance[0].protocol.title,protocol.title);assert.equal(Object.hasOwn(archive.guidance[0],'monitor'),false);assert.equal(Object.hasOwn(archive.guidance[0],'source_nonce'),false);
    const serialized=JSON.stringify(archive);assert.ok(!serialized.includes(payload.image));assert.ok(!serialized.includes('data:image'));assert.ok(!serialized.includes('capture_ticket'));
    const packed=await encodeEln([archive],{}),unpacked=await decodeEln(packed.bytes);assert.equal(unpacked.sources[0].guidance[0].protocol.title,protocol.title);
  }finally{context.env.DB.close();}
});

test('invalid, old or oversized frames and exhausted grants cannot spend a provider call',async()=>{
  const context=await fixture();try{
    const run=(await context.enable((await context.action(await context.create(),'start')).body,{maximum:1})).body;
    for(const extra of [{captured_at:'invalid'},{captured_at:new Date(Date.now()-100000).toISOString()},{width:2000},{image:base64(new Uint8Array([1,2,3,4,5,6]))}])assert.equal((await context.call('/api/guidance/observe',{...context.frame(run),...extra},context.first)).status,400);
    assert.equal(context.calls.length,0);assert.equal((await context.call('/api/guidance/observe',context.frame(run),context.first)).status,200);
    assert.equal((await context.call('/api/guidance/observe',context.frame(run),context.first)).status,429);assert.equal(context.calls.length,1);
  }finally{context.env.DB.close();}
});

test('a second in-flight frame cannot create a concurrent charge and recovery revokes observation grants',async()=>{
  let release,entered;const gate=new Promise(resolve=>{entered=resolve;});const context=await fixture(()=>{entered();return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})));});});
  try{
    const run=(await context.enable((await context.action(await context.create(),'start')).body)).body;
    const pending=context.call('/api/guidance/observe',context.frame(run),context.first);await gate;
    assert.equal((await context.call('/api/guidance/observe',context.frame(run),context.first)).status,409);assert.equal(context.calls.length,1);
    const {invalidateRecoveredSessions}=await import('../src/recovery.mjs');invalidateRecoveredSessions(context.env.DB.raw);
    assert.equal(context.env.DB.raw.prepare('SELECT consent_until FROM guidance_runs WHERE id=?').get(run.id).consent_until,0);
    release();assert.equal((await pending).body.event.status,'stale');
  }finally{context.env.DB.close();}
});
