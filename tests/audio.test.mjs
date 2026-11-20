import test from 'node:test';
import assert from 'node:assert/strict';
import {trimQuietEdges,pcmWave} from '../scripts/capture/audio.mjs';
const tone=milliseconds=>{const bytes=Buffer.alloc(milliseconds*32);for(let index=0;index<bytes.length;index+=2)bytes.writeInt16LE(index%4?1200:-1200,index);return bytes;};
test('speech trimming keeps inner pauses and surrounding context, without changing samples',()=>{
  const content=Buffer.concat([tone(200),Buffer.alloc(32000),tone(200)]),pcm=Buffer.concat([Buffer.alloc(64000),content,Buffer.alloc(64000)]),trimmed=trimQuietEdges(pcm);
  assert.deepEqual(trimmed,pcm.subarray(64000-8000,64000+content.length+8000));assert.equal(trimmed.length%2,0);
});
test('silence and isolated clicks do not reach the speech model; odd bytes stay aligned',()=>{
  assert.equal(trimQuietEdges(Buffer.alloc(32000*6+1)),null);assert.equal(trimQuietEdges(Buffer.concat([Buffer.alloc(32000),tone(20),Buffer.alloc(32000)])),null);
  const pcm=Buffer.concat([tone(80),Buffer.alloc(1)]);assert.deepEqual(trimQuietEdges(pcm),pcm.subarray(0,pcm.length-1));
  const wave=pcmWave(pcm);assert.equal(wave.readUInt32LE(40),pcm.length-1);assert.equal(wave.readUInt32LE(4),wave.length-8);assert.equal(wave.readUInt32LE(24),16000);assert.deepEqual(wave.subarray(44),pcm.subarray(0,pcm.length-1));
});
