import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanData,notebookDataMatches} from '../src/notebook.mjs';
const input={title:'  SIMULATED title  ',project:'  project  ',operator:'  operator  ',body:'body with trailing whitespace  ',date:'2026-11-05',tags:['模拟数据','模拟数据'],status:'draft'};
test('uncertain notebook saves compare canonical fields, including server trimming and duplicate tags',()=>{
  const entry={data:cleanData(input),deleted:0};assert.equal(notebookDataMatches(entry,input),true);
  for(const change of [{body:input.body.trim()},{purpose:'different'},{project:'different'},{event_draft:'not saved'},{tags:['other']}])assert.equal(notebookDataMatches(entry,{...input,...change}),false);
});
test('uncertain notebook saves cannot acknowledge deleted, read-only or invalid input',()=>{
  const data=cleanData(input);assert.equal(notebookDataMatches({data,deleted:1},input),false);assert.equal(notebookDataMatches({data:{...data,status:'complete'}},{...input,status:'complete'}),false);assert.equal(notebookDataMatches({data},{...input,date:'invalid'}),false);assert.equal(notebookDataMatches(null,input),false);
});
test('template values and checks are included in uncertain save confirmation',()=>{
  const binding={definition:{fields:[{key:'batch',type:'text',label:'批次'}],steps:['核对']}};const payload={...input,template_values:{batch:'  sample  '},template_checks:[true],template_binding:binding};const entry={data:cleanData(payload,binding)};assert.equal(notebookDataMatches(entry,payload),true);assert.equal(notebookDataMatches(entry,{...payload,template_values:{batch:'different'}}),false);assert.equal(notebookDataMatches(entry,{...payload,template_checks:[false]}),false);assert.equal(notebookDataMatches(entry,{...payload,template_binding:{definition:{fields:[],steps:[]}}}),false);
});
