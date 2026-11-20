import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CaptureEngine} from '../scripts/capture/engine.mjs';

function fixture(){const state=mkdtempSync(path.join(tmpdir(),'colorlens-shutdown-'));return new CaptureEngine({runtime:'unused-runtime',state,testMode:true,allowFirewall:()=>assert.fail('No firewall changes')});}
const claims={user_id:'a'.repeat(32),entry_id:'b'.repeat(32),nonce:'c'.repeat(64),expires_at:Date.now()+600000};

test('unwritable stop marker cannot skip stopping media children',async()=>{
  const engine=fixture();engine.sessionDirectory=path.join(engine.state,'session');mkdirSync(engine.sessionDirectory);mkdirSync(path.join(engine.sessionDirectory,'stop.signal'));
  let killed=0;engine.children.add({kill(){killed++;}});engine.running=true;await engine.stop();
  assert.equal(engine.running,false);assert.equal(killed,1);assert.equal(engine.children.size,0);assert.equal(engine.media,null);assert.match(engine.error,/不可写/);
});
test('failure to persist the stopped record cannot leave media children running',async()=>{
  const engine=fixture();engine.handsfree.stop=async()=>{throw new Error('SIMULATED disk error');};let killed=0;engine.children.add({kill(){killed++;}});engine.running=true;await engine.stop();
  assert.equal(killed,1);assert.equal(engine.running,false);assert.match(engine.error,/无法写入/);
});
test('late media status cannot spawn a new transcoder after stop',async()=>{
  const engine=fixture();engine.bind(claims);engine.running=true;engine.startedAt=Date.now();let finish;engine.api=()=>new Promise(resolve=>{finish=resolve;});
  const polling=engine.tick();assert.equal(typeof finish,'function');await engine.stop();const device=[...engine.devices.values()][0];
  finish({items:[{name:device.raw,ready:true,tracks2:[]}]});await polling;assert.equal(engine.children.size,0);assert.equal(device.transcoder,null);assert.equal(engine.running,false);
});
test('concurrent stops share cleanup and starting is blocked until cleanup finishes',async()=>{
  const engine=fixture();engine.bind(claims);let release,count=0;engine.handsfree.stop=()=>{count++;return new Promise(resolve=>{release=resolve;});};
  const first=engine.stop(),second=engine.stop();assert.equal(count,1);assert.equal(engine.status().busy,true);await assert.rejects(engine.start('127.0.0.1'),/切换状态/);
  release();await Promise.all([first,second]);assert.equal(engine.status().busy,false);
});

test('a shorter observer ticket cannot shorten the same account media authorization',async()=>{
  const engine=fixture();try{const expires=Date.now()+120000;engine.bind({...claims,expires_at:expires});engine.bind({...claims,nonce:'d'.repeat(64),expires_at:expires-60000});assert.equal(engine.ownerExpires,expires);engine.bind({...claims,expires_at:expires+60000});assert.equal(engine.ownerExpires,expires+60000);assert.throws(()=>engine.bind({...claims,user_id:'e'.repeat(32)}),/另一个账号/);assert.equal(engine.ownerExpires,expires+60000);}finally{await engine.unbind();}
});
test('a newly bound account cannot inherit the previous account longer media deadline',async()=>{
  const engine=fixture();try{engine.bind({...claims,expires_at:Date.now()+600000});await engine.unbind();const expires=Date.now()+60000;engine.bind({...claims,user_id:'e'.repeat(32),expires_at:expires});assert.equal(engine.ownerExpires,expires);}finally{await engine.unbind();}
});
