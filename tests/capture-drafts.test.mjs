import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCaptureDraft,restoreCaptureDraft,captureImageType} from '../web/capture-drafts.mjs';

const scope={account:'a'.repeat(32),entryId:'b'.repeat(32),entryTitle:'SIMULATED 原目标实验'},id=crypto.randomUUID();
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64'));
const text=()=>({id:crypto.randomUUID(),entryId:scope.entryId,kind:'text',text:'SIMULATED：人工修订浓度 0.01；<script>只是文字</script>',source:'人工核对草稿',capturedAt:new Date().toISOString(),reviewed:true,receiptHash:'c'.repeat(64)});
const image=()=>({id:crypto.randomUUID(),entryId:scope.entryId,kind:'image',source:'SIMULATED image',capturedAt:new Date().toISOString(),recordedAt:new Date(Date.now()-60000).toISOString(),bytes:png,filename:'模拟原图.png',url:'blob:memory-only',uploadId:'d'.repeat(32)});

test('draft round trip preserves edited text, stable identity and sampling time but requires review again',async()=>{
  const items=[text(),image()],stored=await snapshotCaptureDraft(items,scope,id),restored=await restoreCaptureDraft(stored,scope);
  assert.equal(stored.schema,'colorlens-capture-draft-1');assert.equal('url' in stored.items[1],false);assert.equal('reviewed' in stored.items[0],false);
  assert.equal(restored[0].text,items[0].text);assert.equal(restored[0].id,items[0].id);assert.equal(restored[0].receiptHash,items[0].receiptHash);assert.equal(restored[0].reviewed,false);assert.equal(restored[1].recordedAt,items[1].recordedAt);assert.equal(restored[1].uploadId,items[1].uploadId);assert.deepEqual(restored[1].bytes,png);
});
test('draft recovery rejects a different account or experiment before returning content',async()=>{
  const stored=await snapshotCaptureDraft([text()],scope,id);for(const wrong of [{...scope,account:'d'.repeat(32)},{...scope,entryId:'e'.repeat(32)}])await assert.rejects(restoreCaptureDraft(stored,wrong),/不属于/);
});
test('binary corruption and text or source corruption cannot be presented as an intact draft',async()=>{
  const stored=await snapshotCaptureDraft([text(),image()],scope,id);
  for(const change of [record=>{record.items[1].bytes[20]^=1;},record=>{record.items[0].text+=' changed';},record=>{record.items[0].source+=' changed';}]){const damaged=structuredClone(stored);change(damaged);await assert.rejects(restoreCaptureDraft(damaged,scope),/校验失败/);}
});
test('snapshot owns its bytes and text even when the live pending row changes during hashing',async()=>{
  const item=image(),bytes=new Uint8Array(png);item.bytes=bytes;const original=text(),expected=original.text,pending=snapshotCaptureDraft([item,original],scope,id);bytes[20]^=1;original.text='changed after snapshot started';const stored=await pending,restored=await restoreCaptureDraft(stored,scope);assert.deepEqual(restored[0].bytes,png);assert.equal(restored[1].text,expected);
});
test('existing color result JSON and grouped ZIP attachments remain recoverable',async()=>{
  for(const [filename,bytes] of [['显色完整结果.json',new TextEncoder().encode('{"schema":"simulated-color-result","rows":[]}')],['镜析-免手动-'+id+'-part-01-of-02.zip',new Uint8Array([80,75,3,4])]]){const item={...image(),kind:'file',filename,bytes};const restored=await restoreCaptureDraft(await snapshotCaptureDraft([item],scope,id),scope);assert.equal(restored[0].filename,filename);assert.deepEqual(restored[0].bytes,bytes);}
  await assert.rejects(snapshotCaptureDraft([{...image(),kind:'file',filename:'bad.json',bytes:new TextEncoder().encode('not json')}],scope,id),/类型无效/);
});
test('draft limits reject duplicates, wrong ownership, unsafe file names and unsupported bytes',async()=>{
  const item=text();await assert.rejects(snapshotCaptureDraft([item,item],scope,id),/重复/);await assert.rejects(snapshotCaptureDraft(Array.from({length:11},text),scope,id),/10 项/);await assert.rejects(snapshotCaptureDraft([{...text(),entryId:'e'.repeat(32)}],scope,id),/目标实验/);
  for(const invalid of [{...image(),filename:'../outside.png'},{...image(),bytes:new Uint8Array([1,2,3])},{...image(),bytes:new Uint8Array(20*1048576+1)},{...text(),text:'x'.repeat(12001)}])await assert.rejects(snapshotCaptureDraft([invalid],scope,id));
  assert.equal(captureImageType(png),'image/png');assert.equal(captureImageType(new Uint8Array([1])),null);
});
test('draft aggregate limit prevents several valid-sized photos from exceeding the pending budget',async()=>{
  const bytes=new Uint8Array(17*1048576);bytes.set(png.subarray(0,8));await assert.rejects(snapshotCaptureDraft([{...image(),bytes},{...image(),bytes}],scope,id),/32 MB/);
});
