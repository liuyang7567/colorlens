import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeQpcr} from '../src/qpcr.mjs';

const near=(actual,expected)=>assert.ok(Number.isFinite(actual)&&Math.abs(actual-expected)<Math.max(1,Math.abs(expected))*1e-9,`${actual} != ${expected}`);
function input(){return {assay_id:'qpcr',method:'ddct',input_type:'multi_ct',reference_genes_csv:'gene,efficiency_percent\nGAPDH,100\nACTB,100',target_gene:'IL6',control_group:'对照组',calibration:'group',replicate_kind:'biological',target_efficiency:100,assumptions_confirmed:true,simulated:true,csv:'sample_id,group,gene,ct,pair_id\nC1,对照组,IL6,26,P1\nC1,对照组,GAPDH,20,P1\nC1,对照组,ACTB,22,P1\nT1,处理组,IL6,24,P1\nT1,处理组,GAPDH,21,P1\nT1,处理组,ACTB,21,P1'};}

test('qPCR multiple references use a geometric quantity normalizer and preserve raw per-gene means',()=>{
  const result=analyzeQpcr(input());assert.equal(result.input_type,'multi_ct');assert.equal(result.algorithm,'qpcr-multiref-js-1');assert.equal(result.reference_config.length,2);
  near(result.rows[1].fold_change,4);near(result.rows[1].delta_ct,3);near(result.rows[1].ct_reference,21);assert.equal(result.reference_summary.length,4);assert.equal(result.gene_rows.length,6);assert.equal(result.groups[1].biological_n,1);assert.equal(result.significance,null);
});
test('multi-reference Pfaffl uses each reference efficiency instead of a mean efficiency or fake ΔCt',()=>{
  const payload={...input(),method:'pfaffl',target_efficiency:90,reference_genes_csv:'gene,efficiency_percent\nGAPDH,80\nACTB,100'};
  const result=analyzeQpcr(payload),expected=1.9**2/Math.sqrt(1.8**(-1)*2**1);near(result.rows[1].fold_change,expected);near(result.rows[1].log2_fold_change,Math.log2(expected));
  assert.equal(result.rows[1].delta_ct,null);assert.equal(result.rows[1].ct_reference,null);assert.equal(result.groups[1].mean_delta_ct,null);assert.equal(result.reference_efficiency,null);assert.equal(result.rows[1].normalized_expression,null);
});
test('multi-reference input averages technical wells within each gene and weights reference genes equally',()=>{
  const payload=input();payload.csv+='\nC1,对照组,GAPDH,20,P1\nC1,对照组,GAPDH,20,P1\nT1,处理组,IL6,24,P1';
  const result=analyzeQpcr(payload);near(result.rows[1].fold_change,4);assert.equal(result.rows[1].technical_n,2);assert.equal(result.reference_summary.find(row=>row.sample_id==='C1'&&row.gene==='GAPDH').technical_n,3);assert.equal(result.groups[0].n,1);assert.equal(result.rows[1].technical_delta_ct_sd,null);
});
test('multi-reference equal efficiency, no-control normalization and explicit pairing reuse the existing calibrator rules',()=>{
  const payload=input(),paired=analyzeQpcr({...payload,calibration:'paired'});near(paired.rows[1].fold_change,4);
  const relative=analyzeQpcr({...payload,method:'dct'});near(relative.rows[1].normalized_expression,2**(-3));assert.equal(relative.rows[1].fold_change,null);
  const corrected=analyzeQpcr({...payload,method:'efficiency',target_efficiency:90,reference_genes_csv:'gene,efficiency_percent\nGAPDH,90\nACTB,90'});near(corrected.rows[1].fold_change,1.9**2);
  assert.throws(()=>analyzeQpcr({...payload,method:'pfaffl',calibration:'paired',csv:payload.csv.replaceAll('T1,处理组,','T2,处理组,').replaceAll('24,P1','24,P2').replaceAll('21,P1','21,P2')}),/对照/);
});
test('multi-reference data rejects missing genes, invalid efficiencies, mixed identities and unexpanded ΔCt',()=>{
  const payload=input();
  assert.throws(()=>analyzeQpcr({...payload,csv:payload.csv.split('\n').filter(line=>!line.startsWith('T1,处理组,ACTB')).join('\n')}),/缺少.*ACTB/);
  assert.throws(()=>analyzeQpcr({...payload,reference_genes_csv:'gene,efficiency_percent\nGAPDH,100'}),/2.*5/);
  assert.throws(()=>analyzeQpcr({...payload,reference_genes_csv:'gene,efficiency_percent\nGAPDH,100\nGAPDH,100'}),/重复/);
  assert.throws(()=>analyzeQpcr({...payload,reference_genes_csv:'gene,efficiency_percent\nGAPDH,90\nACTB,100'}),/100%/);
  assert.throws(()=>analyzeQpcr({...payload,method:'standard'}),/标准曲线/);
  assert.throws(()=>analyzeQpcr({...payload,csv:payload.csv.replace('IL6,24','IL6,0')}),/大于 0/);
  assert.throws(()=>analyzeQpcr({...payload,csv:payload.csv.replace('T1,处理组,ACTB','T1,另一组,ACTB')}),/组.*配对/);
  assert.throws(()=>analyzeQpcr({...payload,reference_genes_csv:'gene,efficiency_percent\nGAPDH,0\nACTB,100'}),/效率/);
});
test('long-format gene sets and optional plate coordinates remain explicit and cannot silently drop targets or reuse wells',()=>{
  const payload=input();payload.csv+='\nC1,对照组,IL10,25,P1\nT1,处理组,IL10,26,P1';const result=analyzeQpcr(payload);near(result.rows.find(row=>row.target==='IL10'&&row.sample_id==='T1').fold_change,0.5);
  assert.throws(()=>analyzeQpcr({...payload,csv:payload.csv.split('\n').filter(line=>!line.startsWith('T1,处理组,IL10')).join('\n')}),/缺少.*IL10/);
  const source=input(),lines=source.csv.split('\n'),csv=lines.map((line,index)=>line+(index?',P1,A1':',plate_id,well')).join('\n');assert.throws(()=>analyzeQpcr({...source,csv}),/孔位重复/);
});
test('five distinct reference efficiencies and unequal control replicates match a direct ratio oracle',()=>{
  const efficiencies=[85,95,100,105,110],controlCt=[[20,22,24,26,28],[21,22,23,24,25]],treatedCt=[21,21,21,21,21];
  const lines=['sample_id,group,gene,ct,pair_id'];
  for(const [sample,group,targetCt,references] of [['C1','对照组',30,controlCt[0]],['C2','对照组',28,controlCt[1]],['T1','处理组',25,treatedCt]]){
    lines.push([sample,group,'IL6',targetCt,'P1'].join(','));
    for(const [index,value] of references.entries())for(let replicate=0;replicate<(sample==='C1'&&index===0?4:1);replicate++)lines.push([sample,group,'REF'+index,value,'P1'].join(','));
  }
  const result=analyzeQpcr({...input(),csv:lines.join('\n'),method:'pfaffl',target_efficiency:90,reference_genes_csv:['gene,efficiency_percent',...efficiencies.map((value,index)=>'REF'+index+','+value)].join('\n')});
  const denominator=efficiencies.reduce((product,efficiency,index)=>product*(1+efficiency/100)**((controlCt[0][index]+controlCt[1][index])/2-treatedCt[index]),1)**(1/5);
  near(result.rows[2].fold_change,1.9**4/denominator);near(Math.sqrt(result.rows[0].fold_change*result.rows[1].fold_change),1);assert.equal(result.groups[0].n,2);assert.equal(result.reference_config.length,5);
});
