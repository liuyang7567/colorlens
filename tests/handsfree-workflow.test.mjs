import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {HandsFreeRecorder} from '../scripts/capture/handsfree.mjs';
import {createCaptureGateway} from '../scripts/capture/gateway.mjs';
import {openCaptureConnection} from './capture-lease-fixture.mjs';
import {captureMessage,captureProtocol,captureNonce} from '../web/capture-bridge.mjs';

const claims={user_id:'a'.repeat(32),entry_id:'b'.repeat(32),entry_title:'SIMULATED workflow',nonce:'c'.repeat(64),expires_at:Date.now()+600000};
const gray=Buffer.from(Array.from({length:160*90},(_,index)=>index%2?80:180));
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function fixture(){const engine={state:mkdtempSync(path.join(tmpdir(),'colorlens-workflow-')),runtime:'unused-test-runtime',running:true,children:new Set(),devices:new Map([['fixture',{id:'fixture',ready:true,online:true,tracks:[{codec:'AAC'}]}]]),outputUrl:()=> 'local-fixture',collect:async(filename,args)=>args.includes('rawvideo')?gray:Buffer.from([255,216,255,224,255,217])};return {engine,recorder:new HandsFreeRecorder(engine)};}
const payload={deviceId:'fixture',interval:20,voice:false,language:'zh',imageConsent:true};
test('complete record ZIP has stable bytes and a stable modification date across exports',async()=>{
  const {recorder}=fixture();try{await recorder.start(claims,payload);await delay(10);await recorder.stop();recorder.active.endedAt='2020-01-02T03:04:06.000Z';const first=recorder.export(claims,recorder.active.id),second=recorder.export(claims,recorder.active.id);assert.deepEqual(first,second);assert.equal((first.readUInt16LE(12)>>9)+1980,2020);assert.equal(recorder.status(claims,'invalid-or-deleted-record').record,null);assert.equal(recorder.status({...claims,user_id:'d'.repeat(32)},recorder.active.id).record,null);}finally{await recorder.stop();}
});
test('archive messages are bounded, source-bound and retryable with a new transfer ID',()=>{
  const source={},session={source,origin:'http://127.0.0.1:49186',nonce:captureNonce(),expiresAt:Date.now()+10000,seen:new Set()},bytes=new Uint8Array(22);bytes.set([80,75,5,6]);
  const message={protocol:captureProtocol,nonce:session.nonce,type:'archive',id:crypto.randomUUID(),capturedAt:new Date().toISOString(),source:'SIMULATED archive',filename:'镜析-免手动-'+crypto.randomUUID()+'.zip',sha256:'a'.repeat(64),archive:bytes.buffer},event=data=>({source,origin:session.origin,data});
  for(const extra of [{filename:'../private.zip'},{sha256:'not-a-hash'},{archive:new ArrayBuffer(20*1048576+1)},{unexpected:'field'}])assert.equal(captureMessage(event({...message,...extra}),session),null);
  assert.equal(captureMessage({...event(message),source:{}},session),null);assert.equal(captureMessage(event(message),session).type,'archive');assert.equal(captureMessage(event(message),session),null);assert.equal(captureMessage(event({...message,id:crypto.randomUUID()}),session).type,'archive');
});

test('reviewing older audio retains its sample time without bypassing fresh message validation',()=>{
  const source={},session={source,origin:'http://127.0.0.1:49186',nonce:captureNonce(),expiresAt:Date.now()+10000,seen:new Set()},oldTime=new Date(Date.now()-600000).toISOString();
  const value={protocol:captureProtocol,nonce:session.nonce,type:'transcript',id:crypto.randomUUID(),capturedAt:new Date().toISOString(),recordedAt:oldTime,source:'SIMULATED reviewed audio',text:'SIMULATED reviewed text'},event=data=>({source,origin:session.origin,data});
  assert.equal(captureMessage(event({...value,recordedAt:'invalid'}),session),null);assert.equal(captureMessage(event({...value,recordedAt:new Date(Date.now()+60000).toISOString()}),session),null);assert.equal(captureMessage(event({...value,capturedAt:oldTime}),session),null);assert.equal(captureMessage(event(value),session).recordedAt,oldTime);
});

test('frame retries keep a stable capture ID and original capture time, while observations stay strict',()=>{
  const source={},session={source,origin:'http://127.0.0.1:49186',nonce:captureNonce(),expiresAt:Date.now()+10000,seen:new Set()},value={protocol:captureProtocol,nonce:session.nonce,type:'frame',id:crypto.randomUUID(),captureId:crypto.randomUUID(),capturedAt:new Date().toISOString(),recordedAt:new Date(Date.now()-600000).toISOString(),source:'SIMULATED retained frame',image:new Uint8Array([255,216,255,224,255,217]).buffer,width:1,height:1},event=data=>({source,origin:session.origin,data});
  assert.equal(captureMessage(event({...value,captureId:'../invalid'}),session),null);assert.equal(captureMessage(event({...value,type:'observation',requestId:'a'.repeat(32)}),session),null);assert.equal(captureMessage(event(value),session).captureId,value.captureId);assert.equal(captureMessage(event({...value,id:crypto.randomUUID()}),session).recordedAt,value.recordedAt);
});
test('voice diagnostics report silence and recognition, and late audio cannot refill a stopped session',async()=>{
  const {engine,recorder}=fixture(),child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.exitCode=0;child.emit('close');};engine.spawnAudio=()=>child;
  try{await recorder.start(claims,{...payload,voice:true,audioConsent:true});child.stdout.write(Buffer.alloc(32000*14+1));assert.ok(recorder.voiceState.droppedAudioSeconds>=2);assert.ok(recorder.audioBuffer.length<=32000*12+1);await recorder.recognize(recorder.revision);assert.equal(recorder.voiceState.phase,'quiet');const pcm=Buffer.alloc(32000*4);for(let index=0;index<pcm.length;index+=2)pcm.writeInt16LE(index%4?1200:-1200,index);recorder.audioBuffer=pcm;recorder.transcribe=async()=> '实验助手，标记 SIMULATED diagnostic';await recorder.recognize(recorder.revision);assert.equal(recorder.voiceState.phase,'waiting');assert.ok(recorder.voiceState.lastCommandAt);assert.ok(Number.isFinite(recorder.voiceState.lastRecognitionMs));await recorder.stop();child.stdout.write(pcm);assert.equal(recorder.audioBuffer.length,0);}finally{await recorder.stop();}
});

test('a short command straddling consecutive recognition windows is preserved and executed once',async()=>{
  const {recorder}=fixture(),prefix=Buffer.alloc(32000*1.4),suffix=Buffer.alloc(32000*0.6);for(let index=0;index<prefix.length;index+=2)prefix.writeInt16LE(index%4?1500:-1500,index);for(let index=0;index<suffix.length;index+=2)suffix.writeInt16LE(index%4?3000:-3000,index);const phrase=Buffer.concat([prefix,suffix]);
  recorder.transcribe=async wave=>wave.subarray(44).indexOf(phrase)>=0?'实验助手，标记 SIMULATED boundary':'unrelated partial speech';
  try{await recorder.start(claims,payload);await delay(10);recorder.audioBuffer=Buffer.concat([Buffer.alloc(32000*2.5),phrase.subarray(0,32000*1.5)]);await recorder.recognize(recorder.revision);assert.equal(recorder.active.events.some(item=>item.kind==='note'),false);recorder.audioBuffer=Buffer.concat([recorder.audioBuffer,phrase.subarray(32000*1.5),Buffer.alloc(32000*2.5)]);await recorder.recognize(recorder.revision);assert.equal(recorder.active.events.filter(item=>item.kind==='note').length,1);recorder.audioBuffer=Buffer.concat([Buffer.alloc(32000),phrase,Buffer.alloc(32000)]);await recorder.recognize(recorder.revision);assert.equal(recorder.active.events.filter(item=>item.kind==='note').length,1);}finally{await recorder.stop();}
});
test('expiry watchdog stops an unattended session and preserves its record',async()=>{
  const {recorder}=fixture();try{await recorder.start(claims,payload);recorder.expires=Date.now()-1;await delay(1100);assert.equal(recorder.active.status,'ended');assert.match(recorder.active.events.at(-1).text,/授权到期/);assert.ok(recorder.read(claims,recorder.active.id));}finally{await recorder.stop();}
});

test('failed initial disk write stops initialization and allows a fresh attempt after repair',async()=>{
  const {recorder,engine}=fixture(),persist=recorder.persist.bind(recorder);let obstacle;
  recorder.persist=()=>{obstacle=path.join(recorder.folder(recorder.active.id),'record.tmp');mkdirSync(obstacle,{recursive:true});persist();};
  try{await assert.rejects(recorder.start(claims,payload),/无法写入本机记录/);assert.equal(recorder.active.status,'ended');assert.equal(recorder.controller.signal.aborted,true);assert.equal(recorder.audio,null);assert.equal(engine.children.size,0);assert.match(recorder.error,/存储写入失败/);rmdirSync(obstacle);recorder.persist=persist;await recorder.start(claims,payload);await delay(10);assert.equal(recorder.active.status,'recording');assert.equal(recorder.active.frames.length,1);}finally{await recorder.stop();}
});

test('disconnect, stopped receiver and duration limit retain photos and report distinct reasons',async t=>{
  for(const condition of [
    {name:'disconnect',change:({engine})=>{engine.devices.get('fixture').online=false;},reason:/直播连接断开/},
    {name:'receiver stopped',change:({engine})=>{engine.running=false;},reason:/本机接收已停止/},
    {name:'duration limit',change:({recorder})=>{recorder.started=Date.now()-3600001;},reason:/已满一小时/},
  ])await t.test(condition.name,async()=>{const value=fixture();try{await value.recorder.start(claims,payload);await delay(10);condition.change(value);await delay(1100);const record=value.recorder.active;assert.equal(record.status,'ended');assert.equal(record.frames.length,1);assert.match(record.events.at(-1).text,condition.reason);assert.ok(value.recorder.export(claims,record.id).length>0);}finally{await value.recorder.stop();}});
});
test('a rejected ninth pairing cannot rebind the engine; command self-test never executes an action',async()=>{
  const issuer='https://workflow.example.test';let binds=0,calls=0,release;const entered=new Promise(resolve=>{release=resolve;});
  const engine={owner:null,running:false,bind(value){this.owner=value.user_id;binds++;},async stop(){},async unbind(){this.owner=null;await this.stop();},async transcribe(deviceId,language,signal,duration){calls++;assert.equal(duration,6);if(deviceId==='cancel'){release();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}return {text:'實驗助手 拍照',needsReview:true};}};
  const server=createCaptureGateway({root:path.resolve(import.meta.dirname,'..'),engine,allowedOrigins:[issuer],verify:async(url,options)=>{const request=JSON.parse(options.body);return new Response(JSON.stringify({...claims,issuer,nonce:request.nonce}));}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  try{const config=await (await fetch(origin+'/api/config')).json(),clientId=crypto.randomUUID();const call=(route,data,token)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Capture-CSRF':config.csrf,...token?{'X-Capture-Session':token}:{}},body:JSON.stringify({...route==='/api/pair'?{clientId}:{},...data})});let token;
    for(let index=0;index<8;index++){const result=await call('/api/pair',{issuer,nonce:index.toString(16).padStart(64,'0'),ticket:'fixture'});assert.equal(result.status,200);token=(await result.json()).token;}
    assert.equal((await call('/api/pair',{issuer,nonce:'f'.repeat(64),ticket:'fixture'})).status,400);assert.equal(binds,8);await openCaptureConnection(origin,config.csrf,token,clientId);
    assert.equal((await call('/api/transcribe',{deviceId:'fixture',mode:'command-test',consent:false},token)).status,400);assert.equal(calls,0);
    const response=await call('/api/transcribe',{deviceId:'fixture',mode:'command-test',consent:true},token),result=await response.json();assert.equal(result.testOnly,true);assert.deepEqual(result.command,{action:'photo'});assert.equal(engine.running,false);
    assert.deepEqual(await (await call('/api/speech-state',{},token)).json(),{phase:'idle'});
    const pending=call('/api/transcribe',{deviceId:'cancel',mode:'command-test',consent:true},token);await entered;engine.speechProgress={phase:'listening',duration:6,capturedMs:1000};assert.deepEqual(await (await call('/api/speech-state',{},token)).json(),engine.speechProgress);assert.equal((await call('/api/speech-cancel',{},token)).status,200);assert.equal((await pending).status,400);assert.deepEqual(await (await call('/api/speech-state',{},token)).json(),{phase:'idle'});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('closing a pairing cancels its audio job before revoking the token',async()=>{
  const issuer='https://close.example.test';let announce,aborted=false,recordStopped=false;const entered=new Promise(resolve=>{announce=resolve;});
  const engine={owner:null,running:true,bind(value){this.owner=value.user_id;},async stop(){this.running=false;},async unbind(){await this.stop();this.owner=null;},handsfree:{nonce:claims.nonce,async stop(){recordStopped=true;}},async transcribe(device,language,signal){return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));},{once:true});announce();});}};
  const server=createCaptureGateway({root:path.resolve(import.meta.dirname,'..'),engine,allowedOrigins:[issuer],verify:async()=>new Response(JSON.stringify({...claims,issuer}))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  try{const config=await (await fetch(origin+'/api/config')).json(),clientId=crypto.randomUUID();let token;const call=(route,value)=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Capture-CSRF':config.csrf,...token?{'X-Capture-Session':token}:{}},body:JSON.stringify({...route==='/api/pair'?{clientId}:{},...value})});token=(await (await call('/api/pair',{issuer,nonce:claims.nonce,ticket:'fixture'})).json()).token;await openCaptureConnection(origin,config.csrf,token,clientId);const pending=call('/api/transcribe',{deviceId:'fixture',mode:'command-test',consent:true});await entered;assert.equal((await call('/api/unpair',{})).status,200);assert.equal((await pending).status,400);assert.equal(aborted,true);assert.equal(recordStopped,true);assert.equal(engine.running,false);assert.equal((await call('/api/state',{})).status,403);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
