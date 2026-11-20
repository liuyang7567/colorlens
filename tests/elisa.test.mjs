import test from 'node:test';
import assert from 'node:assert/strict';
import assays from '../src/assays.json' with {type:'json'};
import {analyzeElisa,elisaDemo} from '../src/elisa.mjs';

const near=(actual,expected,tolerance=0.001)=>assert.ok(Math.abs(actual-expected)<=Math.max(1,Math.abs(expected))*tolerance,`${actual} != ${expected}`);
function fixture(model='4pl',decreasing=false){
  const shape=model==='4pl'?1:0.6,response=concentration=>decreasing?2-1.8/(1+(70/concentration)**1.3)**shape:0.1+1.8/(1+(70/concentration)**1.3)**shape;
  const csv=['sample_id,role,od,standard_concentration,dilution',...[0,0.2,1,3,10,40,100,400,2000,10000].map((concentration,index)=>`STD${index},standard,${response(concentration)},${concentration},`),`Sample,sample,${response(25)},,4`].join('\n');
  return {assay_id:'il10',quantification:'elisa',model,curve_direction:decreasing?'decreasing':'increasing',csv,unit:'pg/mL',wavelength:450,subtract_blank:false,simulated:true,assumptions_confirmed:true};
}
for(const model of ['4pl','5pl'])for(const decreasing of [false,true])test(`ELISA ${model} ${decreasing?'decreasing':'increasing'} recovers closed-form calibration and dilution`,()=>{
  const result=analyzeElisa(fixture(model,decreasing),assays),sample=result.groups.find(row=>row.sample_id==='Sample');
  near(sample.curve_concentration,25);near(sample.concentration,100);near(result.curve.C,70);near(result.curve.B,1.3);near(result.curve.G,model==='4pl'?1:0.6);
  assert.equal(sample.range_status,'within_standard_range');assert.ok(result.curve.r_squared>0.99999);assert.equal(result.curve.points[0].concentration,0);
});
test('ELISA blank and reference processing precedes calibration; out-of-range concentrations stay null',()=>{
  const demo=elisaDemo(),result=analyzeElisa({...demo,assumptions_confirmed:true},assays);near(result.groups.find(row=>row.sample_id==='Sample-A').concentration,100);
  assert.equal(result.groups.find(row=>row.sample_id==='Too-high').concentration,null);assert.equal(result.groups.find(row=>row.sample_id==='Too-high').range_status,'above_standard_range');near(result.blank_mean,0.05);
  const input=fixture(),rows=input.csv.split('\n');rows.push('Low,sample,0.001,,1');const low=analyzeElisa({...input,csv:rows.join('\n')},assays).groups.find(row=>row.sample_id==='Low');assert.equal(low.concentration,null);assert.equal(low.range_status,'below_standard_range');
  const reference=rows.map((line,index)=>index===0?line+',reference_od':line.replace(/,([^,]+),([^,]*),([^,]*)$/,(_,od,concentration,dilution)=>','+(Number(od)+0.02)+','+concentration+','+dilution)+',0.02').join('\n');
  near(analyzeElisa({...input,csv:reference,reference_wavelength:570},assays).groups.find(row=>row.sample_id==='Sample').concentration,100);
});
test('ELISA TSV and unequal standard replicate counts use concentration means, not repeated wells as biological samples',()=>{
  const input=fixture(),lines=input.csv.split('\n');lines.push(lines[2].replace('STD1','Extra'));const result=analyzeElisa({...input,csv:lines.join('\n').replaceAll(',','\t')},assays);near(result.curve.C,70);assert.equal(result.curve.points[1].n,2);assert.equal(result.curve.weighting,'unweighted_concentration_means');
});
test('ELISA validates method, explicit dilution, standards and fit identifiability without invented results',()=>{
  const input=fixture();
  for(const change of [{assumptions_confirmed:false},{model:'linear'},{assay_id:'cck8'},{unit:''},{curve_direction:'unknown'}])assert.throws(()=>analyzeElisa({...input,...change},assays));
  assert.throws(()=>elisaDemo('cck8'));
  assert.throws(()=>analyzeElisa({...input,csv:input.csv.replace(',,4',',,')},assays),/稀释倍数/);
  assert.throws(()=>analyzeElisa({...input,csv:input.csv+'\nSample,sample,0.7,,2'},assays),/稀释倍数不一致/);
  assert.throws(()=>analyzeElisa({...input,csv:input.csv.split('\n').filter((line,index)=>index<5||line.startsWith('Sample')).join('\n')},assays),/至少/);
  assert.throws(()=>analyzeElisa({...input,csv:input.csv.split('\n').map((line,index)=>index?line.split(',').map((value,position)=>position===2?'0.4':value).join(','):line).join('\n')},assays),/无有效变化/);
});
test('ELISA noisy asymmetric calibration estimates a known withheld concentration without claiming experimental validity',()=>{
  const concentrations=[0,0.5,1,3,10,30,100,300,1000,3000],noise=[0,0.001,-0.002,0.001,0.003,-0.004,0.002,-0.001,0.003,-0.002];
  const response=concentration=>0.12+2.2/(1+(85/concentration)**1.4)**0.7;
  const csv=['sample_id,role,od,standard_concentration,dilution',...concentrations.map((concentration,index)=>`STD${index},standard,${response(concentration)+noise[index]},${concentration},`),`S,sample,${response(75)},,3`].join('\n');
  const result=analyzeElisa({...fixture('5pl'),csv},assays);near(result.groups.at(-1).concentration,225,0.01);assert.ok(result.curve.rmse>0);assert.ok(result.warnings.some(value=>value.includes('R² 高不代表')));
});
