import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanTemplate,builtinTemplates,templateData} from '../src/templates.mjs';
import {qpcrChartData} from '../web/qpcr-chart.mjs';
import {analyzeQpcr,qpcrDemo} from '../src/qpcr.mjs';

test('original template definitions enforce bounded keys, types, options and size',()=>{
  const definition=builtinTemplates[0].definition;assert.equal(builtinTemplates.length,3);assert.equal(cleanTemplate(definition).fields.length,4);
  for(const key of ['__proto__','constructor','bad key','sampleBatch'])assert.throws(()=>cleanTemplate({...definition,fields:[{key,label:'字段',type:'text',required:false}]}));
  assert.throws(()=>cleanTemplate({...definition,fields:[definition.fields[0],definition.fields[0]]}));
  assert.throws(()=>cleanTemplate({...definition,fields:[{key:'method',label:'方法',type:'select',required:true,options:['a','a']}]}));
  assert.throws(()=>cleanTemplate({...definition,steps:['重复','重复']}));
});
test('template values preserve zero, validate dates and enums, and only require fields on completion',()=>{
  const definition=cleanTemplate({title:'模拟模板',fields:[{key:'quantity',label:'数值',type:'number',required:true},{key:'date',label:'日期',type:'date',required:false},{key:'mode',label:'方法',type:'select',required:false,options:['a','b']},{key:'confirmed',label:'确认',type:'checkbox',required:true}],steps:['检查']});
  const binding={definition},payload={template_values:{quantity:'0',date:'2026-10-20',mode:'a',confirmed:true},template_checks:[true]};
  assert.equal(templateData(payload,binding,true).template_values.quantity,'0');assert.equal(templateData({},binding).template_checks[0],false);
  assert.throws(()=>templateData({},binding,true),/完成记录前/);assert.throws(()=>templateData({...payload,template_values:{...payload.template_values,date:'2026-02-30'}},binding));
  assert.throws(()=>templateData({...payload,template_values:{...payload.template_values,quantity:'Infinity'}},binding));assert.throws(()=>templateData({...payload,template_values:{...payload.template_values,mode:'other'}},binding));
  assert.throws(()=>templateData({...payload,template_binding:{definition:{title:'forged'}}},binding),/不能直接修改/);
});
test('qPCR plots are descriptive, use sample rows rather than technical wells, and preserve small quantities',()=>{
  const result=analyzeQpcr(qpcrDemo()),chart=qpcrChartData(result,'IL6');assert.equal(chart.key,'fold_change');assert.equal(chart.groups[1].mean,4);assert.equal(chart.groups[1].sd,0);assert.equal(chart.groups[1].points.length,2);
  const normalized=analyzeQpcr({...qpcrDemo(),method:'dct',csv:'sample_id,group,delta_ct\nS1,样本,40'});const tiny=qpcrChartData(normalized,'IL6');assert.equal(tiny.groups[0].mean,2**-40);assert.equal(tiny.groups[0].sd,null);
  assert.throws(()=>qpcrChartData(result,'missing'));assert.throws(()=>qpcrChartData({...result,rows:[{target:'IL6',group:'x',sample_id:'x',fold_change:Infinity}]},'IL6'));
});
