import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeQpcr,qpcrDemo} from '../src/qpcr.mjs';

const run=overrides=>analyzeQpcr({...qpcrDemo(),...overrides});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=Math.max(1e-10,Math.abs(expected)*1e-10),`${actual} != ${expected}`);
test('qPCR ΔΔCt yields 1x controls, 4x treatment and log2FC=2 without absolute quantities',()=>{
  const result=run();assert.equal(result.measurement,'qpcr');assert.equal(result.rows.length,4);
  assert.deepEqual(result.rows.map(row=>row.fold_change),[1,1,4,4]);assert.equal(result.rows[2].delta_delta_ct,-2);assert.equal(result.rows[2].log2_fold_change,2);
  assert.equal(result.rows[2].quantity,null);assert.equal(result.significance,null);assert.equal(result.groups[1].biological_n,2);
});
test('qPCR ΔCt-only keeps valid zero and negative values, no invented control or fold change',()=>{
  const result=run({method:'dct',control_group:'',csv:'sample_id,group,delta_ct\nS1,实验,0\nS2,实验,-2\nS3,实验,40'});
  assert.deepEqual(result.rows.map(row=>row.normalized_expression),[1,4,2**-40]);assert.ok(result.rows.every(row=>row.fold_change===null&&row.calibrator_delta_ct===null));assert.equal(result.calibrators.length,0);
});
test('qPCR raw Ct normalization matches previously computed ΔCt',()=>{
  const result=run({input_type:'ct',csv:'sample_id,group,ct_target,ct_reference\nC1,对照组,26,20\nT1,处理组,24,20'});
  assert.equal(result.rows[1].delta_ct,4);assert.equal(result.rows[1].fold_change,4);
});
test('qPCR equal-efficiency correction uses a percent, not a factor',()=>{
  const result=run({method:'efficiency',target_efficiency:90});near(result.rows[2].fold_change,1.9**2);near(result.rows[2].log2_fold_change,2*Math.log2(1.9));
});
test('Pfaffl uses separate target/reference Ct differences and efficiencies',()=>{
  const result=run({method:'pfaffl',input_type:'ct',target_efficiency:90,reference_efficiency:100,csv:'sample_id,group,ct_target,ct_reference\nC1,对照组,25,20\nT1,处理组,23,19'});
  near(result.rows[1].fold_change,1.9**2/2);assert.equal(result.rows[1].normalized_expression,null);
  assert.throws(()=>run({method:'pfaffl'}),/原始 Ct/);
});
test('qPCR technical rows aggregate before equally weighting independent sample IDs',()=>{
  const result=run({csv:'sample_id,group,delta_ct\nC1,对照组,6\nC1,对照组,6\nC1,对照组,6\nC2,对照组,8\nT1,处理组,5'});
  assert.equal(result.rows[0].technical_n,3);assert.equal(result.calibrators[0].delta_ct,7);assert.equal(result.rows[2].fold_change,4);assert.equal(result.groups[0].n,2);assert.equal(result.groups[1].sd_fold_change,null);
  const unknown=run({replicate_kind:'unknown'});assert.equal(unknown.groups[0].biological_n,null);
});
test('qPCR paired matching uses explicit IDs and rejects missing or ambiguous controls',()=>{
  const csv='sample_id,group,pair_id,delta_ct\nC1,对照组,A,6\nC2,对照组,B,8\nT1,处理组,A,4\nT2,处理组,B,9';
  const result=run({calibration:'paired',csv});assert.deepEqual(result.rows.map(row=>row.fold_change),[1,1,4,0.5]);
  assert.throws(()=>run({calibration:'paired'}),/pair_id/);
  assert.throws(()=>run({calibration:'paired',csv:csv.replace('C2,对照组,B','C2,对照组,A')}),/只有一个对照/);
});
test('qPCR multiple genes use separate calibrators and never mix amplification efficiencies',()=>{
  const csv='sample_id,group,target,delta_ct\nC1,对照组,IL6,6\nT1,处理组,IL6,4\nC1,对照组,IL10,10\nT1,处理组,IL10,10';
  assert.deepEqual(run({csv}).rows.map(row=>row.fold_change),[1,4,1,1]);
  assert.throws(()=>run({csv:csv.replace('C1,对照组,IL10,10\n','')}),/找不到对照/);
  assert.throws(()=>run({method:'efficiency',target_efficiency:100,csv}),/逐个目标基因/);
});
test('qPCR controls retain their variation; arithmetic and geometric fold means stay distinct',()=>{
  const result=run({csv:'sample_id,group,delta_ct\nC1,对照组,5\nC2,对照组,7\nT1,处理组,4'});
  near(result.groups[0].geometric_fold_change,1);near(result.groups[0].mean_fold_change,1.25);assert.notEqual(result.groups[0].sd_fold_change,0);
});
const standard=()=>({method:'standard',input_type:'ct',csv:`sample_id,group,ct_target\nS1,样本,${40-Math.log2(20)}`,standards_csv:`quantity,ct\n1,40\n10,${40-Math.log2(10)}\n100,${40-Math.log2(100)}`,quantity_unit:'copies/反应'});
test('qPCR standard curve recovers analytical quantities, slope, R² and efficiency',()=>{
  const result=run(standard());near(result.rows[0].quantity,20);near(result.curves[0].slope,-Math.log2(10));near(result.curves[0].r_squared,1);near(result.curves[0].efficiency_percent,100);
  assert.equal(result.quantity_unit,'copies/反应');assert.equal(result.rows[0].fold_change,null);assert.equal(result.rows[0].extrapolated,false);
  assert.ok(run({...standard(),csv:'sample_id,group,ct_target\nS1,样本,20'}).rows[0].extrapolated);
});
test('qPCR standard curves require known positive levels, a descending slope and matching targets',()=>{
  assert.throws(()=>run({...standard(),standards_csv:'quantity,ct\n1,30\n1,31\n10,28'}),/3 个不同/);
  assert.throws(()=>run({...standard(),standards_csv:'quantity,ct\n1,20\n10,25\n100,30'}),/斜率/);
  assert.throws(()=>run({...standard(),standards_csv:'quantity,ct\n0,30\n10,25\n100,20'}),/范围/);
  assert.throws(()=>run({...standard(),csv:'sample_id,group,target,ct_target\nS1,样本,other,30'}),/缺少本基因/);
  assert.throws(()=>run({...standard(),quantity_unit:''}),/单位/);
});
test('qPCR rejects invalid values, unsupported methods and invalid identity/assumption declarations',()=>{
  for(const value of ['','Undetermined','NaN','Infinity','1e999'])assert.throws(()=>run({csv:'sample_id,group,delta_ct\nC1,对照组,'+value}));
  assert.throws(()=>run({input_type:'ct',csv:'sample_id,group,ct_target,ct_reference\nC1,对照组,0,20'}),/大于 0/);
  assert.throws(()=>run({assumptions_confirmed:false}),/确认/);assert.throws(()=>run({method:'constructor'}));assert.throws(()=>run({method:['ddct']}));
  assert.throws(()=>run({csv:'sample_id,group,delta_ct\nC1,对照组,6\nC1,处理组,4'}),/不能跨组/);
});
test('qPCR supports tab-separated pasted tables and preserves quoted identifiers',()=>{
  const result=run({csv:'sample_id\tgroup\ttarget\tdelta_ct\nC1\t对照组\t"IL6, A"\t6\nT1\t处理组\t"IL6, A"\t4'});assert.equal(result.rows[1].target,'IL6, A');assert.equal(result.rows[1].fold_change,4);
});
