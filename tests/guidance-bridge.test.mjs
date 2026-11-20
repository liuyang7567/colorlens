import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProtocol,captureNonce,captureMessage} from '../web/capture-bridge.mjs';

test('guidance bridge accepts only bounded fresh frames from the bound window and request',()=>{
  const source={},session={source,origin:'http://127.0.0.1:49146',nonce:captureNonce(),expiresAt:Date.now()+10000,seen:new Set()};
  const message={protocol:captureProtocol,nonce:session.nonce,type:'observation',requestId:'a'.repeat(32),id:crypto.randomUUID(),capturedAt:new Date().toISOString(),source:'SIMULATED',image:new Uint8Array([255,216,255,224,255,217]).buffer,width:640,height:360};
  const event=data=>({source,origin:session.origin,data});
  for(const extra of [{requestId:'not-valid'},{width:1281},{image:new ArrayBuffer(512*1024+1)},{capturedAt:'invalid'},{unexpected:'field'}])assert.equal(captureMessage(event({...message,...extra}),session),null);
  assert.equal(captureMessage({...event(message),origin:'https://untrusted.test'},session),null);
  assert.equal(captureMessage(event(message),session).type,'observation');assert.equal(captureMessage(event(message),session),null);
  const unavailable={protocol:captureProtocol,nonce:session.nonce,type:'observation-unavailable',requestId:message.requestId,reason:'SIMULATED no live video'};
  assert.equal(captureMessage(event(unavailable),session).type,'observation-unavailable');assert.equal(captureMessage(event({...unavailable,reason:'x'.repeat(301)}),session),null);
});
