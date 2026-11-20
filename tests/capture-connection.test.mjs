import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createCaptureGateway} from '../scripts/capture/gateway.mjs';
import WebSocket from 'ws';
import {openCaptureConnection} from './capture-lease-fixture.mjs';
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(check){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await delay(10);}throw new Error('Expected connection cleanup did not finish');}
async function fixture(options={}){
  let instant=Date.now(),fixtureUser='a'.repeat(32);const issuer='https://connection.example.test',nonce='c'.repeat(64),stops=[],offers=[];
  const engine={owner:null,running:true,busy:false,bind(claims){this.owner=claims.user_id;},status(){return {running:this.running};},async stop(){this.running=false;},async unbind(){await this.stop();this.owner=null;},async closeOffer(location){offers.push(location);},handsfree:{nonce,async stop(reason){stops.push(reason);}}};
  const server=createCaptureGateway({root:path.resolve(import.meta.dirname,'..'),engine,allowedOrigins:[issuer],clock:()=>instant,heartbeatMs:100,...options,verify:async(url,options)=>new Response(JSON.stringify({issuer,user_id:fixtureUser,entry_id:'b'.repeat(32),entry_title:'SIMULATED connection',nonce:JSON.parse(options.body).nonce,expires_at:instant+600000}))});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,config=await (await fetch(origin+'/api/config')).json(),clients=new Map();
  const call=(route,value={},token,options={})=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Capture-CSRF':config.csrf,...token?{'X-Capture-Session':token}:{},...options.headers},body:options.body??JSON.stringify(value),...options.signal?{signal:options.signal}:{},...options.duplex?{duplex:options.duplex}:{}});
  const pair=async(clientId=crypto.randomUUID(),windowNonce=nonce)=>{const result=await call('/api/pair',{issuer,nonce:windowNonce,clientId,ticket:'fixture'});assert.equal(result.status,200);const token=(await result.json()).token;clients.set(token,clientId);return token;};
  const lease=(token,options={})=>openCaptureConnection(origin,config.csrf,token,clients.get(token),options);
  return {engine,stops,offers,server,origin,config,issuer,nonce,call,pair,lease,clients,asUser:user=>{fixtureUser=user;},advance:milliseconds=>{instant+=milliseconds;},close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('a disconnected window revokes only its token and stops its own audio job', {timeout:10000},async()=>{
  const value=await fixture();let announce;const entered=new Promise(resolve=>{announce=resolve;});let cancelled=false;
  value.engine.transcribe=async(device,language,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{cancelled=true;reject(new Error('cancelled'));},{once:true});announce();});
  try{const token=await value.pair(),connection=await value.lease(token),pending=value.call('/api/transcribe',{consent:true,deviceId:'fixture'},token);await entered;const started=Date.now();await connection.close();await until(()=>!value.engine.running);assert.ok(Date.now()-started<2000);assert.equal(cancelled,true);assert.equal((await pending).status,400);assert.equal((await value.call('/api/state',{},token)).status,403);assert.equal(value.stops.length,1);}finally{await value.close();}
});

test('a background window with a live connection survives paused polls, but expiry still stops it', {timeout:10000},async()=>{
  const value=await fixture();try{const clientId=crypto.randomUUID(),token=await value.pair(clientId);await value.lease(token);value.advance(130000);await delay(1100);assert.equal((await value.call('/api/state',{},token)).status,200);assert.equal(value.stops.length,0);assert.equal(await value.pair(clientId),token);value.advance(480000);await delay(1100);assert.equal((await value.call('/api/state',{},token)).status,200);value.advance(120001);await delay(1100);assert.equal((await value.call('/api/state',{},token)).status,403);assert.equal(value.stops.length,1);assert.equal(value.engine.running,false);}finally{await value.close();}
});

test('reload creates a new token; late closure of the old window cannot revoke it', {timeout:10000},async()=>{
  const value=await fixture();try{const first=await value.pair(),oldConnection=await value.lease(first),second=await value.pair();assert.notEqual(second,first);assert.equal(value.stops.length,1);assert.equal((await value.call('/api/state',{},first)).status,403);const current=await value.lease(second);await oldConnection.close();assert.equal((await value.call('/api/unpair',{},first)).status,403);assert.equal((await value.call('/api/state',{},second)).status,200);assert.equal(value.stops.length,1);assert.equal(value.engine.running,true);await current.close();await until(()=>!value.engine.running);assert.equal(value.stops.length,2);}finally{await value.close();}
});

test('simultaneous reload requests leave one current pairing', {timeout:10000},async()=>{
  const value=await fixture();try{const stop=value.engine.handsfree.stop;value.engine.handsfree.stop=async reason=>{await delay(10);await stop(reason);};const tokens=await Promise.all(Array.from({length:6},()=>value.pair()));const statuses=await Promise.all(tokens.map(async token=>(await value.call('/api/state',{},token)).status));assert.equal(statuses.filter(status=>status===200).length,1);assert.equal(statuses.filter(status=>status===403).length,5);await value.lease(tokens[statuses.indexOf(200)]);}finally{await value.close();}
});

test('closing one window leaves another valid window and its record running', {timeout:10000},async()=>{
  const value=await fixture();try{const first=await value.pair(),firstLease=await value.lease(first),secondNonce='d'.repeat(64),second=await value.pair(crypto.randomUUID(),secondNonce),secondLease=await value.lease(second);value.engine.handsfree.nonce=secondNonce;await firstLease.close();await until(async()=>(await value.call('/api/state',{},first)).status===403);assert.equal((await value.call('/api/state',{},second)).status,200);assert.equal(value.stops.length,0);assert.equal(value.engine.running,true);await secondLease.close();await until(()=>!value.engine.running);assert.equal(value.stops.length,1);}finally{await value.close();}
});

test('a preview that finishes after unpairing is closed instead of becoming an orphan', {timeout:10000},async()=>{
  const value=await fixture();let announce,finish;const entered=new Promise(resolve=>{announce=resolve;});value.engine.readOffer=async()=>{announce();return new Promise(resolve=>{finish=()=>resolve({location:'http://fixture.invalid/offer',sdp:'v=0\r\n'});});};
  try{const token=await value.pair();await value.lease(token);const pending=value.call('/api/whep/fixture',{},token,{headers:{'Content-Type':'application/sdp'},body:'v=0\r\n'});await entered;assert.equal((await value.call('/api/unpair',{},token)).status,200);finish();assert.equal((await pending).status,400);assert.deepEqual(value.offers,['http://fixture.invalid/offer']);}finally{finish?.();await value.close();}
});

test('revoking the last window also stops an engine still starting', {timeout:10000},async()=>{
  const value=await fixture();try{const token=await value.pair();await value.lease(token);value.engine.busy=true;assert.equal((await value.call('/api/unpair',{},token)).status,200);assert.equal(value.engine.running,false);assert.equal((await value.call('/api/state',{},token)).status,403);}finally{await value.close();}
});

for(const endpoint of ['/api/unpair','/api/unbind'])test(endpoint+' waits for old account cleanup before accepting the next account', {timeout:10000},async()=>{
  const value=await fixture();let announce,release;const entered=new Promise(resolve=>{announce=resolve;});const original=value.engine.unbind;let first=true;value.engine.unbind=async()=>{if(first){first=false;announce();await new Promise(resolve=>{release=resolve;});}await original.call(value.engine);};
  try{const previous=await value.pair();await value.lease(previous);const closing=value.call(endpoint,{},previous);await entered;value.asUser('d'.repeat(32));let paired=false;const next=value.pair(crypto.randomUUID(),'e'.repeat(64)).then(token=>{paired=true;return token;});await delay(50);assert.equal(paired,false);assert.equal(value.engine.owner,'a'.repeat(32));release();assert.equal((await closing).status,200);const token=await next;assert.equal(value.engine.owner,'d'.repeat(32));assert.equal((await value.call('/api/state',{},token)).status,200);assert.equal((await value.call('/api/state',{},previous)).status,403);await value.lease(token);}finally{release?.();await value.close();}
});

test('foreign origins, invalid page IDs and duplicate connections are rejected', {timeout:10000},async()=>{
  const value=await fixture();try{for(const clientId of ['invalid','-'.repeat(36)])assert.equal((await value.call('/api/pair',{issuer:value.issuer,nonce:value.nonce,clientId,ticket:'fixture'})).status,403);const token=await value.pair();await assert.rejects(value.lease(token,{origin:'https://evil.invalid'}),error=>error.status===403);await assert.rejects(value.lease(token,{authentication:{csrf:'invalid'}}),error=>error.code===1008);await assert.rejects(value.lease(token,{authentication:{clientId:crypto.randomUUID()}}),error=>error.code===1008);assert.equal((await value.call('/api/start',{},token)).status,400);await value.lease(token);await assert.rejects(value.lease(token),error=>error.code===1008);assert.equal((await value.call('/api/state',{},token)).status,200);}finally{await value.close();}
});

test('authentication arriving after revocation cannot create a lingering connection', {timeout:10000},async()=>{
  const value=await fixture();let socket;try{const token=await value.pair();socket=new WebSocket(value.origin.replace('http:','ws:')+'/api/connection',{headers:{Origin:value.origin}});socket.on('error',()=>{});await new Promise(resolve=>socket.once('open',resolve));assert.equal((await value.call('/api/unpair',{},token)).status,200);const closed=new Promise(resolve=>socket.once('close',resolve));socket.send(JSON.stringify({type:'authenticate',csrf:value.config.csrf,token,clientId:value.clients.get(token)}));assert.equal(await closed,1008);assert.equal((await value.call('/api/state',{},token)).status,403);}finally{socket?.terminate();await value.close();}
});

test('a nonresponsive connection is stopped by transport heartbeat', {timeout:10000},async()=>{
  const value=await fixture({heartbeatMs:50});try{const token=await value.pair();await value.lease(token,{autoPong:false});await until(()=>!value.engine.running);assert.equal(value.stops.length,1);assert.equal((await value.call('/api/state',{},token)).status,403);}finally{await value.close();}
});

test('unauthenticated sockets time out and shutdown closes upgraded connections', {timeout:10000},async()=>{
  const value=await fixture({authenticationMs:100});let socket;try{socket=new WebSocket(value.origin.replace('http:','ws:')+'/api/connection',{headers:{Origin:value.origin}});socket.on('error',()=>{});const closed=new Promise(resolve=>socket.once('close',resolve));await new Promise(resolve=>socket.once('open',resolve));assert.equal(await closed,1006);const token=await value.pair(),connection=await value.lease(token);await value.close();await until(()=>connection.socket.readyState===WebSocket.CLOSED);assert.equal(value.engine.running,false);}finally{socket?.terminate();if(value.server.listening)await value.close();}
});
