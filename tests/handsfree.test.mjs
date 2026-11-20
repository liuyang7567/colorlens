import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {HandsFreeRecorder,voiceCommand,frameQuality} from '../scripts/capture/handsfree.mjs';

const claims={user_id:'a'.repeat(32),entry_id:'b'.repeat(32),entry_title:'SIMULATED handsfree',nonce:'c'.repeat(64),expires_at:Date.now()+600000};
const gray=Buffer.from(Array.from({length:160*90},(_,index)=>index%2?80:180));
const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture(){const state=mkdtempSync(path.join(tmpdir(),'colorlens-handsfree-test-'));const engine={state,runtime:'unused-test-runtime',running:true,children:new Set(),devices:new Map([['test-device',{id:'test-device',ready:true,online:true,tracks:[]}]]),outputUrl:()=> 'local-fixture',collect:async(filename,args)=>args.includes('rawvideo')?gray:Buffer.from([255,216,255,224,255,217])};return {engine,recorder:new HandsFreeRecorder(engine)};}
test('voice commands require an explicit prefix and never execute unrelated speech or SOP completion',()=>{
  assert.deepEqual(voiceCommand('实验助手，拍照。'),{action:'photo'});assert.deepEqual(voiceCommand('实验助手，标记 二号试管反光较强'),{action:'note',text:'二号试管反光较强'});assert.deepEqual(voiceCommand('Lab assistant, stop recording.'),{action:'stop'});
  assert.deepEqual(voiceCommand('實驗助手 拍照'),{action:'photo'});assert.deepEqual(voiceCommand('實驗助手 繼續記錄'),{action:'resume'});
  for(const text of ['请不要执行实验助手拍照','实验助手，删除所有实验','实验助手，下一步','没有人说话','实验助手','照片已保存'])assert.equal(voiceCommand(text),null);
});
test('automatic frames reject blank, dark and duplicate views while retaining detailed images',()=>{
  assert.equal(frameQuality(gray).usable,true);assert.equal(frameQuality(gray,gray).duplicate,true);assert.equal(frameQuality(Buffer.alloc(160*90)).usable,false);assert.equal(frameQuality(Buffer.alloc(160*90,255)).usable,false);
});
test('one-time authorization produces durable scoped photos and notes, with pause, stop and ZIP export',async()=>{
  const {recorder}=fixture();try{
    const payload={deviceId:'test-device',interval:20,voice:false,language:'zh',imageConsent:true};await assert.rejects(recorder.start(claims,{...payload,imageConsent:false}),/确认/);await recorder.start(claims,payload);
    for(let attempt=0;attempt<50&&!recorder.active.frames.length;attempt++)await pause();assert.equal(recorder.active.frames.length,1);const id=recorder.active.id;
    await recorder.capture(false);assert.equal(recorder.active.frames.length,1);await recorder.command({action:'note',text:'SIMULATED observation'});await recorder.command({action:'note',text:'SIMULATED observation'});assert.equal(recorder.active.events.filter(event=>event.kind==='note').length,1);
    await recorder.command({action:'pause'});assert.equal(recorder.active.status,'paused');await recorder.capture(true);assert.equal(recorder.active.frames.length,1);await recorder.command({action:'resume'});await recorder.command({action:'photo'});assert.equal(recorder.active.frames.length,2);
    assert.throws(()=>recorder.read({...claims,user_id:'d'.repeat(32)},id),/不属于/);assert.throws(()=>recorder.read({...claims,entry_id:'d'.repeat(32)},id),/不属于/);await recorder.command({action:'stop'});const zip=unzipSync(recorder.export(claims,id)),record=JSON.parse(strFromU8(zip['record.json']));assert.equal(record.frames.length,2);assert.equal('owner' in record,false);assert.ok(!JSON.stringify(record).includes(claims.nonce));
    const restored=new HandsFreeRecorder(recorder.engine);assert.equal(restored.read(claims,id).events.some(event=>event.kind==='note'),true);const image=record.frames[0];writeFileSync(path.join(recorder.folder(id),image.id+'.jpg'),'corrupted');assert.throws(()=>restored.image(claims,id,image.id),/完整性/);restored.remove(claims,id);assert.deepEqual(restored.list(claims),[]);
  }finally{await recorder.stop();}
});
test('a stopped in-flight frame cannot be persisted and interrupted records stay exportable',async()=>{
  const {engine,recorder}=fixture();let release;engine.collect=()=>new Promise(resolve=>{release=resolve;});await recorder.start(claims,{deviceId:'test-device',interval:20,voice:false,language:'zh',imageConsent:true});const id=recorder.active.id;await recorder.stop();release(Buffer.from([255,216,255,224,255,217]));await pause();assert.equal(recorder.active.frames.length,0);
  const filename=path.join(recorder.folder(id),'record.json'),stored=JSON.parse(readFileSync(filename));stored.status='recording';writeFileSync(filename,JSON.stringify(stored));const restored=new HandsFreeRecorder(engine);assert.equal(restored.read(claims,id).status,'interrupted');assert.ok(restored.export(claims,id).length>0);
});
test('streaming audio preserves 16-bit alignment when a pipe splits an odd byte boundary',async()=>{
  const {recorder}=fixture();try{await recorder.start(claims,{deviceId:'test-device',interval:20,voice:false,language:'zh',imageConsent:true});await pause();const pcm=Buffer.alloc(32000*4+1);for(let position=0;position+1<pcm.length;position+=2)pcm.writeInt16LE(position%4?1000:-1000,position);recorder.audioBuffer=pcm;let observed=false;recorder.transcribe=async input=>{observed=true;assert.equal(input.readUInt32LE(40)%2,0);assert.equal(input.subarray(44).length%2,0);assert.equal(input.readInt16LE(44),-1000);return 'unrelated background speech';};await recorder.recognize(recorder.revision);assert.equal(observed,true);assert.equal(recorder.audioBuffer.length%2,1);}finally{await recorder.stop();}
});

test('another paired window neither stops the recorder nor renews its authorization',async()=>{
  const {recorder}=fixture();try{await recorder.start(claims,{deviceId:'test-device',interval:20,voice:false,imageConsent:true});const expires=recorder.expires;
    recorder.renew({...claims,nonce:'d'.repeat(64),expires_at:expires+60000});assert.equal(recorder.active.status,'recording');assert.equal(recorder.expires,expires);
    recorder.renew({...claims,nonce:'d'.repeat(64),entry_id:'e'.repeat(32),expires_at:expires+120000});assert.equal(recorder.active.status,'recording');assert.equal(recorder.expires,expires);assert.equal(recorder.status({...claims,entry_id:'e'.repeat(32)}).record,null);
    recorder.renew({...claims,expires_at:expires+30000});assert.equal(recorder.expires,expires+30000);
  }finally{await recorder.stop();}
});
test('changing the original recording window scope still stops its recorder',async()=>{
  const {recorder}=fixture();try{await recorder.start(claims,{deviceId:'test-device',interval:20,voice:false,imageConsent:true});recorder.renew({...claims,entry_id:'e'.repeat(32)});assert.equal(recorder.active.status,'ended');assert.match(recorder.active.events.at(-1).text,/归属变化/);}finally{await recorder.stop();}
});

test('a record with failed metadata storage cannot be overwritten by another account or experiment',async()=>{
  const {recorder}=fixture(),payload={deviceId:'test-device',interval:20,voice:false,imageConsent:true};try{await recorder.start(claims,payload);for(let count=0;count<50&&!recorder.active.frames.length;count++)await pause();mkdirSync(path.join(recorder.folder(recorder.active.id),'record.tmp'));await recorder.stop();assert.match(recorder.error,/存储写入失败/);const original=JSON.stringify(recorder.active);
    for(const scope of [{...claims,user_id:'d'.repeat(32)},{...claims,entry_id:'e'.repeat(32)}]){await assert.rejects(recorder.start(scope,payload),/原账号.*原实验/);assert.equal(JSON.stringify(recorder.active),original);}assert.ok(unzipSync(recorder.export(claims,recorder.active.id))['record.json']);
  }finally{await recorder.stop();}
});
test('the original experiment can export an unpersisted event and explicitly start a new local record',async()=>{
  const {recorder}=fixture(),payload={deviceId:'test-device',interval:20,voice:false,imageConsent:true};try{await recorder.start(claims,payload);for(let count=0;count<50&&!recorder.active.frames.length;count++)await pause();const id=recorder.active.id;mkdirSync(path.join(recorder.folder(id),'record.tmp'));assert.throws(()=>recorder.event('note','SIMULATED unpersisted note'));await recorder.stop();const exported=JSON.parse(strFromU8(unzipSync(recorder.export(claims,id))['record.json']));assert.ok(exported.events.some(event=>event.text==='SIMULATED unpersisted note'));await recorder.start(claims,payload);assert.notEqual(recorder.active.id,id);assert.equal(recorder.error,'');
  }finally{await recorder.stop();}
});
