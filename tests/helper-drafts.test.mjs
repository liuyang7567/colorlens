import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCaptureDraft,restoreCaptureDraft,helperDraftSelection,captureTranscriptSource} from '../web/capture-drafts.mjs';

const scope={account:'a'.repeat(32),entryId:'b'.repeat(32)},recordedAt=new Date(Date.now()-900000).toISOString();
const text=()=>({kind:'text',id:crypto.randomUUID(),entryId:scope.entryId,capturedAt:new Date().toISOString(),recordedAt,text:'SIMULATED 手工核对的试管标记',source:'眼镜音轨 · 模拟眼镜 · 本机离线转写（待人工复核）'});
const image=()=>({kind:'image',id:crypto.randomUUID(),entryId:scope.entryId,capturedAt:new Date().toISOString(),recordedAt,source:'视频截帧 · 模拟眼镜',bytes:new Uint8Array([255,216,255,224,255,217]),filename:'SIMULATED.jpg'});

test('helper draft recovery retains original text, image bytes, capture identities and old audio time',async()=>{
  const original=[text(),image()],stored=await snapshotCaptureDraft(original,scope,crypto.randomUUID()),selection=helperDraftSelection(await restoreCaptureDraft(stored,scope));
  assert.equal(selection.text.id,original[0].id);assert.equal(selection.text.recordedAt,recordedAt);assert.equal(selection.text.text,original[0].text);assert.equal(selection.text.source,original[0].source);assert.equal(selection.image.id,original[1].id);assert.deepEqual(selection.image.bytes,original[1].bytes);
});
test('a recovered unedited transcript preserves its exact source for retry fingerprint matching',()=>{
  for(const origin of [{label:'模拟眼镜 A',edited:false},{label:'模拟眼镜 B',edited:true}]){const source=captureTranscriptSource({recognised:true,origin});assert.equal(captureTranscriptSource({restoredSource:source}),source);}
  const manual=captureTranscriptSource({});assert.equal(captureTranscriptSource({restoredSource:manual}),manual);assert.match(manual,/未运行语音识别/);
});
test('editing a recovered transcript marks the edit without claiming a fresh recognition',()=>{
  const source='眼镜音轨 · 模拟来源 · 本机离线转写（待人工复核）';assert.equal(captureTranscriptSource({restoredSource:source,restoredEdited:true}),source+' · 恢复后人工编辑');const long=captureTranscriptSource({restoredSource:'x'.repeat(100),restoredEdited:true});assert.equal(long.length,100);assert.ok(long.endsWith(' · 恢复后人工编辑'));
});
test('speech source preserves actual sample duration and review status even with a long device label',()=>{
  const source=captureTranscriptSource({recognised:true,origin:{label:'模拟'.repeat(30),durationSeconds:29.7,edited:true}});assert.ok(source.length<=100);assert.ok(source.includes('29.7 秒'));assert.ok(source.endsWith('离线转写后人工编辑（待人工复核）'));assert.equal(captureTranscriptSource({restoredSource:source}),source);
});
test('helper recovery rejects duplicate slots, file archives and images beyond its transfer limits',()=>{
  for(const items of [[text(),text()],[image(),image()],[{...text(),kind:'file'}],[{...image(),bytes:new Uint8Array(8*1048576+1)}],[{...image(),bytes:new Uint8Array([137,80,78,71])}],[text(),image(),text()]])assert.throws(()=>helperDraftSelection(items));
});
test('helper recovery does not accept malformed source, identifiers, timestamps or empty text',()=>{
  for(const item of [{...text(),source:'x'.repeat(101)},{...text(),id:'invalid'},{...text(),capturedAt:'not a date'},{...text(),text:'   '}])assert.throws(()=>helperDraftSelection([item]));
  assert.deepEqual(helperDraftSelection([]),{text:null,image:null});
});
