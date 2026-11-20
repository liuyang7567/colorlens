import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceiptSender} from '../web/capture-receipts.mjs';
import {captureProtocol} from '../web/capture-bridge.mjs';
const nonce='a'.repeat(64),reply=(requestId,extra={})=>({protocol:captureProtocol,nonce,type:'transfer-result',requestId,accepted:true,message:'SIMULATED received',...extra});
test('transfers wait for a valid receipt and ignore wrong or stale confirmations',async()=>{
  let sent;const sender=createReceiptSender({nonce,post:value=>{sent=value;}}),job=sender.send({type:'transcript',captureId:crypto.randomUUID(),text:'SIMULATED'});
  for(const extra of [{nonce:'b'.repeat(64)},{protocol:'other'},{accepted:'true'},{unexpected:true},{message:'x'.repeat(301)}])assert.equal(sender.receive(reply(sent.id,extra)),false);
  assert.equal(sender.size,1);assert.equal(sender.receive(reply(crypto.randomUUID())),false);assert.equal(sender.receive(reply(sent.id)),true);assert.equal((await job).accepted,true);assert.equal(sender.receive(reply(sent.id)),false);assert.equal(sender.size,0);
});
test('rejection and retry keep the capture ID but use different transport IDs',async()=>{
  const messages=[],sender=createReceiptSender({nonce,post:value=>messages.push(value)}),captureId=crypto.randomUUID(),first=sender.send({type:'frame',captureId});sender.receive(reply(messages[0].id,{accepted:false,message:'SIMULATED queue full'}));await assert.rejects(first,/queue full/);const second=sender.send({type:'frame',captureId});assert.notEqual(messages[0].id,messages[1].id);assert.equal(messages[1].captureId,captureId);sender.receive(reply(messages[1].id));await second;assert.equal(sender.size,0);
});
test('timeout, post failure and cancellation clean up pending receipts',async()=>{
  const timed=createReceiptSender({nonce,post:()=>{},timeoutMs:10});await assert.rejects(timed.send({type:'transcript'}),/未确认收到/);assert.equal(timed.size,0);
  const failed=createReceiptSender({nonce,post:()=>{throw new Error('SIMULATED closed');}});await assert.rejects(failed.send({type:'frame'}),/closed/);assert.equal(failed.size,0);
  const cancelled=createReceiptSender({nonce,post:()=>{}}),job=cancelled.send({type:'transcript'});cancelled.cancel('SIMULATED cancelled');await assert.rejects(job,/cancelled/);assert.equal(cancelled.size,0);
});
test('in-flight transfers are bounded without dropping accepted work',async()=>{
  let sent;const sender=createReceiptSender({nonce,maximum:1,post:value=>{sent=value;}}),first=sender.send({type:'frame'});await assert.rejects(sender.send({type:'transcript'}),/等待主页面/);sender.receive(reply(sent.id));await first;assert.equal(sender.size,0);
});
