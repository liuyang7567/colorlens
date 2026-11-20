import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createCaptureGateway} from '../scripts/capture/gateway.mjs';
import {openCaptureConnection} from './capture-lease-fixture.mjs';

test('loopback capture gateway rejects foreign origins, forged credentials and unapproved issuers',async()=>{
  const issuer='https://main.example.test',nonce='a'.repeat(64),owner='b'.repeat(32),entry='c'.repeat(32);
  let verificationCalls=0,starts=0;
  const engine={owner:null,running:false,bind(claims){this.owner=claims.user_id;},status(){return {running:this.running};},async start(){starts++;this.running=true;},async stop(){this.running=false;},async unbind(){this.owner=null;await this.stop();}};
  const server=createCaptureGateway({root:path.resolve(import.meta.dirname,'..'),engine,allowedOrigins:[issuer],verify:async(url)=>{verificationCalls++;assert.equal(url,issuer+'/api/capture/verify');return new Response(JSON.stringify({issuer,nonce,user_id:owner,entry_id:entry,entry_title:'SIMULATED',expires_at:Date.now()+600000}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    const config=await (await fetch(origin+'/api/config')).json();
    const clientId=crypto.randomUUID(),call=(route,payload,headers={})=>fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Capture-CSRF':config.csrf,...headers},body:JSON.stringify({...route==='/api/pair'?{clientId}:{},...payload})});
    assert.equal((await call('/api/pair',{issuer,nonce,ticket:'fixture'},{Origin:'https://evil.invalid'})).status,403);
    assert.equal((await call('/api/pair',{issuer,nonce,ticket:'fixture'},{'X-Capture-CSRF':'forged'})).status,403);
    assert.equal((await call('/api/pair',{issuer:'https://evil.invalid',nonce,ticket:'fixture'})).status,403);assert.equal(verificationCalls,0);
    const paired=await call('/api/pair',{issuer,nonce,ticket:'fixture'});assert.equal(paired.status,200);const {token,userId,entryId}=await paired.json();assert.equal(userId,owner);assert.equal(entryId,entry);
    assert.equal((await call('/api/start',{address:'127.0.0.1'})).status,403);assert.equal(starts,0);
    assert.equal((await call('/api/state',{}, {'X-Capture-Session':'0'.repeat(64)})).status,403);
    assert.equal((await call('/api/start',{address:'127.0.0.1'},{'X-Capture-Session':token})).status,400);assert.equal(starts,0);
    await openCaptureConnection(origin,config.csrf,token,clientId);
    assert.equal((await call('/api/start',{address:'127.0.0.1'},{'X-Capture-Session':token})).status,200);assert.equal(starts,1);
    const replay=await (await call('/api/pair',{issuer,nonce,ticket:'fixture'})).json();assert.equal(replay.token,token);
    assert.equal((await call('/api/unbind',{}, {'X-Capture-Session':token})).status,200);assert.equal(engine.running,false);
    assert.equal((await call('/api/state',{}, {'X-Capture-Session':token})).status,403);
    const headers=(await fetch(origin+'/capture.html')).headers;assert.ok(headers.get('Content-Security-Policy').includes('frame-ancestors'));assert.equal(headers.get('Access-Control-Allow-Origin'),null);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
