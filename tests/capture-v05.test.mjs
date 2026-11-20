import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {hashPassword} from '../src/auth.mjs';
import {uid,now,sha,base64} from '../src/common.mjs';
import {subnet,CaptureEngine} from '../scripts/capture/engine.mjs';
import {captureNonce,captureProtocol,captureMessage,captureOrigin} from '../web/capture-bridge.mjs';

const password='independent v05 synthetic password';
const pepper='v05-only-fixture-pepper-not-production-123456789';
const stored=await hashPassword(password,pepper);
async function fixture(){
  const env={DB:localDatabase(),AUTH_PEPPER:pepper,BOOTSTRAP_KEY:'fixture-only',DEEPSEEK_API_KEY:'mock-only',AI_FETCH:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'SIMULATED image test',report_draft:'',evidence:[],issues:[],hypotheses:[],next_steps:[],missing_info:[]})}}]}));}};
  const calls=[];
  for(const email of ['capture-a@example.test','capture-b@example.test'])env.DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(uid(),uid(),stored,'member',now(),'同名测试用户',email,now());
  async function call(path,payload,identity={}){const response=await worker.fetch(new Request('https://lab.test'+path,{method:payload===undefined?'GET':'POST',headers:{...payload===undefined?{}:{'Content-Type':'application/json',Origin:'https://lab.test','X-ColorLens-Token':identity.csrf||''},...identity.cookie?{Cookie:identity.cookie}:{}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  const login=async(email)=>{const result=await call('/api/auth/login',{email,password});assert.equal(result.status,200);return {cookie:result.cookie,csrf:result.body.csrf};};
  const first=await login('capture-a@example.test'),second=await login('capture-b@example.test');
  const create=async(identity=first)=>(await call('/api/notebook/create',{data:{title:'SIMULATED capture',body:'真实数据不参与本次测试。',tags:['模拟数据']}},identity)).body;
  const image=async(entry,bytes,identity=first)=>{const ticket=await call('/api/files/begin',{id:entry.id,revision:entry.revision,filename:'synthetic.png',size:bytes.length,sha256:await sha(bytes)},identity);assert.equal(ticket.status,200);assert.equal((await call('/api/files/chunk',{upload_id:ticket.body.id,position:0,data:base64(bytes)},identity)).status,200);const finished=await call('/api/files/finish',{upload_id:ticket.body.id,revision:entry.revision},identity);assert.equal(finished.status,200);return {entry:finished.body,id:ticket.body.id};};
  return {env,calls,call,first,second,create,image};
}

test('capture tickets require login, CSRF, matching owner, nonce, issuer and live account authority',async()=>{
  const context=await fixture();try{
    const entry=await context.create(),nonce=captureNonce();
    assert.equal((await context.call('/api/capture/ticket',{id:entry.id,nonce})).status,401);
    assert.equal((await context.call('/api/capture/ticket',{id:entry.id,nonce},context.second)).status,404);
    const issued=await context.call('/api/capture/ticket',{id:entry.id,nonce},context.first);assert.equal(issued.status,200);
    const verified=await context.call('/api/capture/verify',{ticket:issued.body.ticket,nonce});assert.equal(verified.status,200);assert.equal(verified.body.entry_id,entry.id);
    assert.equal((await context.call('/api/capture/verify',{ticket:issued.body.ticket,nonce:captureNonce()})).status,403);
    assert.equal((await context.call('/api/capture/verify',{ticket:issued.body.ticket.slice(0,-3)+'abc',nonce})).status,403);
    context.env.DB.raw.prepare('UPDATE users SET disabled=1 WHERE id=?').run(issued.body.user_id);
    assert.equal((await context.call('/api/capture/verify',{ticket:issued.body.ticket,nonce})).status,403);
  }finally{context.env.DB.close();}
});
test('image AI previews metadata only and sends only the selected owned image after separate consent',async()=>{
  const context=await fixture();try{
    const original=await context.create();
    const bytes=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64'));
    const {entry,id}=await context.image(original,bytes);
    const payload={id:entry.id,revision:entry.revision,task:'interpret',fields:['title'],analysis_ids:[],image_ids:[id]};
    const prepared=await context.call('/api/ai/preview',payload,context.first);assert.equal(prepared.status,200);assert.equal(prepared.body.context.images[0].id,id);assert.ok(!JSON.stringify(prepared.body).includes('data:image'));
    assert.equal((await context.call('/api/ai/run',{...payload,preview_hash:prepared.body.preview_hash,consent:true},context.first)).status,400);assert.equal(context.calls.length,0);
    const run=await context.call('/api/ai/run',{...payload,preview_hash:prepared.body.preview_hash,consent:true,image_consent:true},context.first);assert.equal(run.status,200);assert.equal(context.calls.length,1);
    const content=context.calls[0].messages[1].content;assert.equal(content.length,2);assert.equal(content[1].image_url.url,'data:image/png;base64,'+base64(bytes));
    const saved=context.env.DB.raw.prepare('SELECT input FROM ai_runs WHERE id=?').get(run.body.id);assert.ok(!saved.input.includes('base64,'));
    assert.equal((await context.call('/api/ai/preview',payload,context.second)).status,404);
    const own=await context.create(context.second);assert.equal((await context.call('/api/ai/preview',{...payload,id:own.id,revision:own.revision},context.second)).status,404);
  }finally{context.env.DB.close();}
});
test('image AI rejects corrupted stored content before a provider call or budget attempt',async()=>{
  const context=await fixture();try{
    const valid=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64'));
    const original=await context.create(),{entry,id}=await context.image(original,valid),corrupted=new Uint8Array([1,2,3,4,5,6,7,8]);
    context.env.DB.raw.prepare('UPDATE file_chunks SET data=? WHERE file_id=?').run(base64(corrupted),id);
    context.env.DB.raw.prepare('UPDATE files SET size=?,sha256=? WHERE id=?').run(corrupted.length,await sha(corrupted),id);
    const payload={id:entry.id,revision:entry.revision,task:'interpret',fields:['title'],image_ids:[id]};
    const prepared=await context.call('/api/ai/preview',payload,context.first);assert.equal(prepared.status,200);
    assert.equal((await context.call('/api/ai/run',{...payload,preview_hash:prepared.body.preview_hash,consent:true,image_consent:true},context.first)).status,400);
    assert.equal(context.calls.length,0);assert.equal(context.env.DB.raw.prepare('SELECT COUNT(*) AS count FROM ai_runs').get().count,0);
  }finally{context.env.DB.close();}
});
test('capture protocol rejects wrong sources, stale messages and duplicate captures; subnet masks are validated',()=>{
  assert.equal(subnet('10.22.126.102','255.255.255.0'),'10.22.126.0/24');assert.equal(subnet('10.61.166.111','255.255.240.0'),'10.61.160.0/20');assert.equal(subnet('127.0.0.1','255.255.255.255'),'127.0.0.1/32');assert.throws(()=>subnet('10.0.0.1','255.0.255.0'));
  assert.equal(captureOrigin('http://127.0.0.1:49136'),'http://127.0.0.1:49136');assert.throws(()=>captureOrigin('http://127.0.0.1.attacker.test:49136'));
  const source={},session={source,origin:'http://127.0.0.1:49136',nonce:captureNonce(),expiresAt:Date.now()+1000,seen:new Set()};
  const event={source,origin:session.origin,data:{protocol:captureProtocol,nonce:session.nonce,type:'transcript',id:crypto.randomUUID(),capturedAt:new Date().toISOString(),source:'人工合成转写',text:'SIMULATED'}};
  assert.equal(captureMessage({...event,source:{}},session),null);assert.equal(captureMessage({...event,origin:'https://attacker.test'},session),null);assert.equal(captureMessage(event,session).type,'transcript');assert.equal(captureMessage(event,session),null);
});
