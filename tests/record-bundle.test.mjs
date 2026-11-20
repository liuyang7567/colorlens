import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync,strToU8,unzipSync,strFromU8} from 'fflate';
import {createRecordArchive,createRecordParts} from '../scripts/capture/record-bundle.mjs';
import {HandsFreeRecorder} from '../scripts/capture/handsfree.mjs';
import {captureArchivePart} from '../web/capture-bridge.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(count,size){const images=new Map(),frames=Array.from({length:count},(_,index)=>{const id=randomUUID(),bytes=Buffer.alloc(size,index+1);bytes.set([255,216,255,224]);bytes.set([255,217],bytes.length-2);images.set(id,bytes);return {id,filename:id+'.jpg',sha256:digest(bytes),at:'2026-11-03T00:00:00.000Z'};});return {record:{schema:'colorlens-handsfree-1',id:randomUUID(),owner:'private-owner',entryId:'entry',status:'ended',startedAt:'2026-11-03T00:00:00.000Z',endedAt:'2026-11-03T00:01:00.000Z',events:[{kind:'note',text:'SIMULATED fixture'}],frames},readImage:id=>images.get(id),images};}
test('small records keep the original one-ZIP byte format',()=>{
  const value=fixture(2,1024),metadata=strToU8(JSON.stringify({...value.record,owner:undefined,notice:'本机实验过程资料。口令转写和照片需人工复核；不证明步骤完成。'},null,2)),files={'record.json':metadata};for(const frame of value.record.frames)files['photos/'+frame.id+'.jpg']=value.images.get(frame.id);
  const previous=zipSync(files,{level:0,mtime:new Date(value.record.endedAt)}),archive=createRecordArchive(value.record,value.readImage),plan=createRecordParts(value.record,value.readImage);assert.deepEqual(archive,Buffer.from(previous));assert.equal(plan.parts.length,1);assert.deepEqual(plan.parts[0].bytes,archive);assert.equal(plan.parts[0].filename,'镜析-免手动-'+value.record.id+'.zip');
});
test('every group carries identical full metadata and all photo bytes can be reassembled',()=>{
  const value=fixture(9,200000),plan=createRecordParts(value.record,value.readImage,{maximumBytes:1048576}),merged=new Map();assert.ok(plan.parts.length>1);let firstIndex;
  for(const part of plan.parts){assert.ok(part.size<=1048576);assert.equal(digest(part.bytes),part.sha256);assert.equal(captureArchivePart(part.filename).total,plan.parts.length);const files=unzipSync(part.bytes),record=JSON.parse(strFromU8(files['record.json'])),index=JSON.parse(strFromU8(files['bundle.json']));assert.equal('owner' in record,false);assert.equal(record.frames.length,9);assert.equal(digest(files['record.json']),plan.recordSha256);assert.deepEqual(index.parts.map(item=>item.filename),plan.parts.map(item=>item.filename));if(firstIndex)assert.deepEqual(files['bundle.json'],firstIndex);else firstIndex=files['bundle.json'];
    const photoFiles=Object.keys(files).filter(name=>name.startsWith('photos/'));assert.equal(photoFiles.length,part.photoCount);for(const [name,bytes]of Object.entries(files)){if(merged.has(name))assert.deepEqual(bytes,merged.get(name));else merged.set(name,bytes);}
  }
  assert.equal([...merged.keys()].filter(name=>name.startsWith('photos/')).length,9);for(const [id,bytes]of value.images)assert.deepEqual(Buffer.from(merged.get('photos/'+id+'.jpg')),bytes);
});
test('records above the real 20 MB attachment limit are complete and deterministic',()=>{
  const value=fixture(24,960*1024),first=createRecordParts(value.record,value.readImage),second=createRecordParts(value.record,value.readImage);assert.ok(first.fullBytes>20*1048576);assert.equal(first.parts.length,2);assert.equal(first.parts.reduce((sum,part)=>sum+part.photoCount,0),24);assert.ok(first.parts.every(part=>part.size<=20*1048576));assert.deepEqual(first.parts.map(part=>part.sha256),second.parts.map(part=>part.sha256));assert.equal(new Set(first.parts.flatMap(part=>part.photoIds)).size,24);
});
test('invalid limits, oversized metadata and integrity errors never silently omit files',()=>{
  const value=fixture(1,1000);assert.throws(()=>createRecordParts(value.record,value.readImage,{maximumBytes:1}),/分组大小/);assert.throws(()=>createRecordParts({...value.record,frames:Array(101).fill(value.record.frames[0])},value.readImage),/数量/);assert.throws(()=>createRecordParts(value.record,()=>{throw new Error('integrity failure');}),/integrity/);
  assert.throws(()=>createRecordParts({...value.record,events:[{text:'x'.repeat(2*1048576)}]},value.readImage,{maximumBytes:1048576}),/无法.*分组/);const image=Buffer.alloc(1048576);assert.throws(()=>createRecordParts({...value.record,frames:Array.from({length:33},()=>({id:randomUUID()}))},()=>image),/超过本机上限/);
});
test('file-backed plan and groups enforce owner, final state, index and photo integrity',async()=>{
  const claims={user_id:'a'.repeat(32),entry_id:'b'.repeat(32),entry_title:'SIMULATED group scope',nonce:'c'.repeat(64),expires_at:Date.now()+600000},gray=Buffer.from(Array.from({length:14400},(_,index)=>index%2?80:180)),engine={state:mkdtempSync(path.join(tmpdir(),'colorlens-group-')),runtime:'unused',running:true,children:new Set(),devices:new Map([['fixture',{id:'fixture',ready:true,online:true,tracks:[]}]]),outputUrl:()=> 'fixture',collect:async(filename,args)=>args.includes('rawvideo')?gray:Buffer.from([255,216,255,224,255,217])},recorder=new HandsFreeRecorder(engine);
  try{await recorder.start(claims,{deviceId:'fixture',interval:20,voice:false,imageConsent:true,language:'zh'});assert.throws(()=>recorder.exportPlan(claims,recorder.active.id),/先结束/);await new Promise(resolve=>setTimeout(resolve,10));await recorder.stop();const id=recorder.active.id,plan=recorder.exportPlan(claims,id);assert.equal(plan.parts[0].bytes,undefined);assert.deepEqual(recorder.exportPart(claims,id,1),recorder.export(claims,id));assert.throws(()=>recorder.exportPlan({...claims,user_id:'d'.repeat(32)},id),/不属于/);assert.throws(()=>recorder.exportPart(claims,id,0),/编号/);assert.throws(()=>recorder.exportPart(claims,id,2),/不存在/);const frame=recorder.active.frames[0];writeFileSync(path.join(recorder.folder(id),frame.id+'.jpg'),'broken');assert.throws(()=>recorder.exportPlan(claims,id),/完整性/);}finally{await recorder.stop();if(recorder.active)recorder.remove(claims,recorder.active.id);}
});
test('group filenames are bounded and cannot pretend an invalid or single group sequence',()=>{
  const id=randomUUID();assert.deepEqual(captureArchivePart('镜析-免手动-'+id+'-part-02-of-03.zip'),{recordId:id,number:2,total:3});for(const suffix of ['-part-03-of-02.zip','-part-00-of-02.zip','-part-01-of-01.zip','-part-01-of-100.zip','/part-01-of-02.zip'])assert.equal(captureArchivePart('镜析-免手动-'+id+suffix),null);
});
