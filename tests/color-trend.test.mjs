import test from 'node:test';
import assert from 'node:assert/strict';
import {correctColor} from '../web/color-trend.mjs';

test('reference correction preserves the baseline and offsets common linear-light exposure changes',()=>{
  assert.deepEqual(correctColor([64,128,192],[120,120,120],[120,120,120]).rgb.map(Math.round),[64,128,192]);
  const result=correctColor([89,89,89],[137,137,137],[100,100,100]);
  assert.ok(Math.abs(result.rgb[0]-64)<2);
  assert.equal(result.clipped,false);
});
test('reference correction rejects dark, saturated or excessive changes and flags clipped output',()=>{
  assert.throws(()=>correctColor([50,50,50],[255,100,100],[100,100,100]),/饱和/);
  assert.throws(()=>correctColor([50,50,50],[20,100,100],[200,100,100]),/变化过大/);
  assert.equal(correctColor([250,250,250],[100,100,100],[130,130,130]).clipped,true);
});
