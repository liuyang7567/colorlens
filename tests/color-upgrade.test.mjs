import test from 'node:test';
import assert from 'node:assert/strict';
import {applyColorMatrix,fitColorMatrix,plateProjection,projectedWells} from '../src/color-calibration.mjs';
import {validateColorSession} from '../src/color-session.mjs';

test('multi-patch fit recovers known linear-light mixing on an independent sample',()=>{
  const current=[[60,90,120],[180,70,80],[70,180,90],[80,90,180],[170,160,80],[170,80,160],[90,165,175]],matrix=[[0.8,0.05,0.02,0.01],[0.03,0.9,0.02,0.005],[0.02,0.03,0.85,0.01]];
  const baseline=current.map(rgb=>applyColorMatrix(rgb,matrix).rgb),fit=fitColorMatrix(current,baseline),expected=applyColorMatrix([130,120,100],matrix).rgb,actual=applyColorMatrix([130,120,100],fit.matrix).rgb;
  assert.ok(fit.residual<1e-5);actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<1e-5));
  assert.throws(()=>fitColorMatrix([[60,60,60],[80,80,80],[100,100,100],[120,120,120],[140,140,140],[160,160,160]],baseline.slice(0,6)),/信息不足/);
  assert.throws(()=>fitColorMatrix(current.slice(0,3),baseline.slice(0,3)),/6–24/);
});
test('perspective mapping retains corners and extracts all supported plate labels without mixing padding',()=>{
  const width=640,height=360,corners=[{x:40,y:40},{x:580,y:70},{x:500,y:330},{x:80,y:310}],project=plateProjection(corners,width,height);
  for(const [index,coordinates] of [[0,0],[1,0],[1,1],[0,1]].entries()){const point=project(...coordinates);assert.ok(Math.abs(point.x-corners[index].x)<1e-6);assert.ok(Math.abs(point.y-corners[index].y)<1e-6);}
  const pixels=new Uint8ClampedArray(width*height*4).fill(128);
  for(const [rows,columns] of [[2,3],[3,4],[4,6],[6,8],[8,12]]){const wells=projectedWells(width,height,pixels,corners,rows,columns);assert.equal(wells.length,rows*columns);assert.deepEqual(wells[0].rgb,[128,128,128]);assert.equal(wells.at(-1).label,String.fromCharCode(64+rows)+columns);}
  assert.throws(()=>plateProjection([corners[0],corners[2],corners[1],corners[3]],width,height),/交叉/);
  assert.throws(()=>plateProjection([{x:-1,y:1},...corners.slice(1)],width,height),/四角/);
});
const fixture=()=>({schema:'colorlens-color-session-1',method:'gray',createdAt:new Date().toISOString(),baseline:{reference:[120,120,120],sample:[80,90,100],patches:[]},rows:[{time:new Date().toISOString(),raw:0,adjusted:0,reference:[120,120,120],sample:[80,90,100],corrected:[80,90,100],wells:Array.from({length:6},(_,index)=>({label:String.fromCharCode(65+Math.floor(index/3))+(index%3+1),rgb:[80,90,100],corrected:[80,90,100],clipped:0}))}]});
test('complete color results round-trip numbers while rejecting malformed records and discarding authority',()=>{
  const input=fixture(),validated=validateColorSession({...input,capture_ticket:'not-exported',owner:'not-exported'});assert.deepEqual(validateColorSession(JSON.parse(JSON.stringify(validated))),validated);assert.equal('capture_ticket' in validated,false);assert.equal('owner' in validated,false);
  for(const mutate of [value=>{value.rows[0].sample=[Infinity,0,0];},value=>{value.rows[0].time='not-a-date';},value=>{value.rows[0].wells.push(value.rows[0].wells[0]);},value=>{value.rows[0].raw=-1;},value=>{value.rows=Array(201).fill(value.rows[0]);}]){const value=fixture();mutate(value);assert.throws(()=>validateColorSession(value));}
});
