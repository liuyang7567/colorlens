import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,base64} from '../src/common.mjs';
import {hashPassword} from '../src/auth.mjs';
import {analyzeInstrument,instrumentDemo,parseCsv} from '../src/instrument.mjs';
import {analyzePixels,deltaE,rgbLab} from '../src/photo.mjs';
import assays from '../src/assays.json' with {type:'json'};
import photoGolden from './photo-golden.json' with {type:'json'};
import instrumentGolden from './instrument-golden.json' with {type:'json'};
import {qpcrDemo} from '../src/qpcr.mjs';
import {builtinTemplates} from '../src/templates.mjs';

const pepper='local-test-only-pepper-not-a-real-secret-12345';
const password='correct horse battery staple 123';
const stored=await hashPassword(password,pepper);
test('template library versions, ownership, note snapshots, imported provenance and completion checks stay isolated',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member'),definition=structuredClone(builtinTemplates[0].definition);
    const created=await app.call('/api/templates/save',{definition},admin);assert.equal(created.status,200);const template=created.json;
    assert.equal((await app.call('/api/templates/version',{id:template.id,revision:1},member)).status,404);
    assert.equal((await app.call('/api/templates/save',{id:template.id,revision:1,definition},member)).status,404);
    const note=await app.note(admin,{template_ref:{id:template.id,revision:1}});assert.equal(note.data.template_binding.revision,1);
    const complete=await app.call('/api/notebook/save',{id:note.id,revision:note.revision,data:{...note.data,status:'complete'}},admin);assert.equal(complete.status,400);
    const updated=await app.call('/api/templates/save',{id:template.id,revision:1,definition:{...definition,title:'第二版模板'}},admin);assert.equal(updated.json.revision,2);
    assert.equal((await app.call('/api/templates/save',{id:template.id,revision:1,definition},admin)).status,409);
    const unchanged=(await app.call('/api/notebook/entry/'+note.id,undefined,admin)).json;assert.equal(unchanged.data.template_binding.definition.title,definition.title);
    const values={sample_batch:'S-1',reference_gene:'GAPDH',instrument:'模拟仪器',kit_lot:'L-1'};
    const saved=await app.call('/api/notebook/save',{id:note.id,revision:note.revision,data:{...note.data,status:'complete',template_values:values,template_checks:[true]}},admin);assert.equal(saved.status,200);assert.equal(saved.json.data.template_checks.length,3);
    const duplicate=await app.call('/api/notebook/duplicate',{id:note.id},admin);assert.equal(duplicate.status,200);assert.equal(duplicate.json.data.template_binding.revision,1);assert.equal(duplicate.json.data.template_values.sample_batch,'');assert.equal(duplicate.json.data.template_checks[0],false);
    const imported=await app.note(admin,{...saved.json.data,title:'导入新副本'});assert.equal(imported.data.template_binding.source,'imported');assert.equal(imported.data.template_values.reference_gene,'GAPDH');
    const changed=await app.call('/api/notebook/save',{id:imported.id,revision:imported.revision,data:{...imported.data,template_binding:{...imported.data.template_binding,revision:99}}},admin);assert.equal(changed.status,409);
    assert.equal((await app.call('/api/templates/archive',{id:template.id,revision:2},admin)).status,200);
    const denied=await app.call('/api/notebook/create',{data:{template_ref:{id:template.id,revision:2}}},admin);assert.equal(denied.status,409);
    assert.equal((await app.call('/api/templates/version',{id:template.id,revision:1},admin)).json.definition.title,definition.title);
    assert.ok(app.DB.raw.prepare("SELECT COUNT(*) AS count FROM document_usage WHERE key LIKE 'template:%'").get().count>=2);
  }finally{app.DB.close();}
});
test('clean static URLs are forwarded unchanged to avoid Pages canonical redirect loops',async()=>{
  const response=await worker.fetch(new Request('https://colorlens.test/share'),{ASSETS:{fetch:async request=>{assert.equal(new URL(request.url).pathname,'/share');return new Response('read-only viewer');}}});
  assert.equal(response.status,200);assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
});
function fixture(mock) {
  const DB=localDatabase();
  const env={DB,AUTH_PEPPER:pepper,BOOTSTRAP_KEY:'setup-test-key',DEEPSEEK_API_KEY:'mock-private-key',AI_FETCH:mock,ALLOW_LEGACY_REGISTRATION:'true'};
  const users=[{id:uid(),username:'admin',role:'admin'},{id:uid(),username:'member',role:'member'}];
  for(const user of users)DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run(user.id,user.username,stored,user.role,new Date().toISOString());
  async function call(path,payload,identity={},options={}){
    const headers={...identity.cookie?{cookie:identity.cookie}:{},...payload!==undefined?{'Content-Type':'application/json',Origin:'https://colorlens.test','X-ColorLens-Token':identity.csrf||''}:{},...options.headers};
    const response=await worker.fetch(new Request('https://colorlens.test'+path,{method:payload===undefined?'GET':'POST',headers,...payload===undefined?{}:{body:JSON.stringify(payload)}}),env,{waitUntil:promise=>promise.catch(()=>{})});
    const json=await response.json().catch(()=>null);
    return {status:response.status,json,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  async function login(username){const response=await call('/api/auth/login',{username,password});assert.equal(response.status,200);return {cookie:response.cookie,csrf:response.json.csrf};}
  async function note(identity,data={}){const response=await call('/api/notebook/create',{data:{title:'SIMULATED notebook',body:'模拟记录',...data}},identity);assert.equal(response.status,200,JSON.stringify(response.json));return response.json;}
  return {env,DB,users,call,login,note};
}
test('saved analysis views return verified results and their trusted parent without changing records',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member'),entry=await app.note(admin);
    const input=instrumentDemo(assays.find(item=>item.id==='il6'));
    const saved=await app.call('/api/instrument/export',{...input,assay_id:'il6',unit:'模拟单位',subtract_blank:false,entry_id:entry.id,entry_revision:entry.revision,experiment:{name:'SIMULATED snapshot'}},admin);
    assert.equal(saved.status,200,JSON.stringify(saved.json));
    const storedRecord=app.DB.raw.prepare('SELECT data FROM analyses WHERE id=?').get(saved.json.id);
    const revision=(await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json.revision;
    for(let attempt=0;attempt<2;attempt++){
      const opened=await app.call('/api/restore',{id:saved.json.id,entry_id:'untrusted-parent'},admin);
      assert.equal(opened.status,200);assert.equal(opened.json.entry_id,entry.id);
      assert.deepEqual(opened.json.result,JSON.parse(storedRecord.data).result);
      assert.equal((await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json.revision,revision);
    }
    assert.equal((await app.call('/api/restore',{id:saved.json.id},member)).status,404);
    app.DB.raw.prepare('UPDATE analyses SET data=? WHERE id=?').run('{}',saved.json.id);
    assert.equal((await app.call('/api/restore',{id:saved.json.id},admin)).status,409);
  }finally{app.DB.close();}
});

test('ELISA curve quantification is server-calculated, private and preserved in snapshots and AI preview',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member');
    const csv=['sample_id,role,od,standard_concentration,dilution',...[0,1,5,15,50,150,500,2000].map((concentration,index)=>`STD${index},standard,${0.1+1.8*concentration/(50+concentration)},${concentration},`),'S1,sample,0.7,,4'].join('\n');
    const input={assay_id:'il6',quantification:'elisa',model:'4pl',curve_direction:'increasing',csv,wavelength:450,subtract_blank:false,unit:'pg/mL',simulated:true,assumptions_confirmed:true};
    const calculated=await app.call('/api/instrument/analyze',input,admin);assert.equal(calculated.status,200);assert.equal(calculated.json.measurement,'elisa');
    assert.ok(Math.abs(calculated.json.groups.find(row=>row.sample_id==='S1').concentration-100)<0.01);
    const invalid=await app.call('/api/instrument/export',{...input,assumptions_confirmed:false},admin);assert.equal(invalid.status,400);assert.equal((await app.call('/api/notebook',undefined,admin)).json.total,0);
    const entry=await app.note(admin),saved=await app.call('/api/instrument/export',{...input,entry_id:entry.id,entry_revision:entry.revision,result:{concentration:999}},admin);assert.equal(saved.status,200);
    const record=(await app.call('/api/restore',{id:saved.json.id},admin)).json;assert.equal(record.instrument_input.quantification,'elisa');assert.ok(Math.abs(record.result.groups.find(row=>row.sample_id==='S1').concentration-100)<0.01);
    assert.equal((await app.call('/api/restore',{id:saved.json.id},member)).status,404);
    const latest=(await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json;
    const preview=await app.call('/api/ai/preview',{id:entry.id,revision:latest.revision,task:'interpret',fields:['title'],analysis_ids:[saved.json.id]},admin);assert.equal(preview.status,200);assert.equal(preview.json.context.analyses[0].measurement,'elisa');assert.equal(preview.json.context.analyses[0].curve.model,'4pl');
  }finally{app.DB.close();}
});

test('multi-reference qPCR persists raw configuration and server results under existing owner and consent controls',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member'),input={...qpcrDemo('multi_ct'),assumptions_confirmed:true};
    const invalid=await app.call('/api/instrument/export',{...input,reference_genes_csv:'gene,efficiency_percent\nGAPDH,100'},admin);assert.equal(invalid.status,400);assert.equal((await app.call('/api/notebook',undefined,admin)).json.total,0);
    const entry=await app.note(admin),saved=await app.call('/api/instrument/export',{...input,entry_id:entry.id,entry_revision:entry.revision,result:{fold_change:999}},admin);assert.equal(saved.status,200,JSON.stringify(saved.json));
    const record=(await app.call('/api/restore',{id:saved.json.id},admin)).json;assert.equal(record.instrument_input.input_type,'multi_ct');assert.equal(record.instrument_input.reference_genes_csv,input.reference_genes_csv);assert.equal(record.result.rows[2].fold_change,4);assert.equal(record.result.rows[0].technical_n,2);assert.equal(record.result.reference_summary[0].technical_n,3);assert.equal(record.result.reference_efficiency,null);
    assert.equal((await app.call('/api/restore',{id:saved.json.id},member)).status,404);assert.equal((await app.call('/api/instrument/analyze',input)).status,401);
    const latest=(await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json,preview=await app.call('/api/ai/preview',{id:entry.id,revision:latest.revision,task:'interpret',fields:['title'],analysis_ids:[saved.json.id]},admin);assert.equal(preview.status,200);assert.equal(preview.json.context.analyses[0].normalization,'geometric_reference_quantities');assert.equal(preview.json.context.analyses[0].reference_config.length,2);assert.equal(preview.json.context.analyses[0].gene_rows,undefined);
  }finally{app.DB.close();}
});

test('qPCR integrates with isolated snapshots and consent preview without trusting client results',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member');
    assert.ok((await app.call('/api/assays',undefined,admin)).json.assays.some(assay=>assay.id==='qpcr'));
    const invalid=await app.call('/api/instrument/export',{...qpcrDemo(),assumptions_confirmed:false},admin);assert.equal(invalid.status,400);
    assert.equal((await app.call('/api/notebook',undefined,admin)).json.total,0);
    const entry=await app.note(admin),saved=await app.call('/api/instrument/export',{...qpcrDemo(),target_efficiency:'90',standards_csv:'unused hidden standards',quantity_unit:'unused unit',entry_id:entry.id,entry_revision:entry.revision,experiment:{name:'SIMULATED qPCR'},result:{fold_change:999}},admin);
    assert.equal(saved.status,200,JSON.stringify(saved.json));
    const record=(await app.call('/api/restore',{id:saved.json.id},admin)).json;assert.equal(record.result.rows[2].fold_change,4);assert.equal(record.instrument_input.method,'ddct');assert.equal(record.result.measurement,'qpcr');
    assert.equal(record.instrument_input.target_efficiency,100);assert.equal(record.instrument_input.standards_csv,null);assert.equal(record.instrument_input.quantity_unit,null);
    assert.equal(record.original_attachment_id,null);assert.equal(record.entry_id,entry.id);assert.equal((await app.call('/api/restore',{id:saved.json.id},member)).status,404);
    const latest=(await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json;
    const preview=await app.call('/api/ai/preview',{id:entry.id,revision:latest.revision,task:'interpret',fields:['title'],analysis_ids:[saved.json.id]},admin);
    assert.equal(preview.status,200);const analysis=preview.json.context.analyses[0];assert.equal(analysis.measurement,'qpcr');assert.equal(analysis.rows[2].fold_change,4);assert.equal(analysis.method,'ddct');assert.equal(analysis.significance,null);
  }finally{app.DB.close();}
});

test('sessions use secure HttpOnly cookies; invite register is one-use and private',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin');
    assert.match(admin.cookie,/^__Host-ColorLens=/);
    const invite=await app.call('/api/auth/invite',{},admin);
    const result=await app.call('/api/auth/register',{username:'new-user',password,invite:invite.json.invite});assert.equal(result.status,200);
    assert.equal((await app.call('/api/auth/register',{username:'second-user',password,invite:invite.json.invite})).status,400);
    assert.equal((await app.call('/api/auth/register',{username:'bad-user',password,invite:'wrong'})).status,400);
    assert.equal((await app.call('/api/auth/register',{username:'new-admin',password,setup:'setup-test-key'})).status,409);
    const logout=await app.call('/api/auth/logout',{},admin);assert.equal(logout.status,200);assert.equal((await app.call('/api/notebook',undefined,admin)).status,401);
  }finally{app.DB.close();}
});
test('CSRF, cross-origin writes, unsupported methods, unauthenticated reads are blocked',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin');
    assert.equal((await app.call('/api/notebook')).status,401);
    assert.equal((await app.call('/api/notebook/create',{data:{}},{cookie:admin.cookie})).status,403);
    assert.equal((await app.call('/api/notebook/create',{data:{}},admin,{headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await app.call('/api/ai/run',undefined,admin)).status,405);
    assert.equal((await app.call('/api/auth/login',{username:'admin',password:'wrong'})).status,401);
  }finally{app.DB.close();}
});
test('all record, history, snapshot, archive, report, share, AI and file routes isolate owners',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member'),entry=await app.note(admin);
    for(const path of ['/api/notebook/entry/','/api/notebook/history/','/api/notebook/archive/','/api/notebook/report/'])assert.equal((await app.call(path+entry.id,undefined,member)).status,404,path);
    assert.equal((await app.call('/api/notebook/revision/'+entry.id+'/1',undefined,member)).status,404);
    for(const [path,payload] of [['/api/notebook/save',{id:entry.id,revision:1,data:{title:'stolen'}}],['/api/notebook/action',{id:entry.id,revision:1,action:'trash'}],['/api/notebook/duplicate',{id:entry.id}],['/api/files/begin',{id:entry.id,revision:1}],['/api/ai/list',{id:entry.id}],['/api/shares/list',{id:entry.id}]])assert.equal((await app.call(path,payload,member)).status,404,path);
    assert.equal((await app.call('/api/notebook',undefined,member)).json.total,0);
    assert.equal((await app.call('/api/notebook/backup-index',undefined,member)).json.entries.length,0);
    assert.equal((await app.call('/api/auth/members',{},member)).status,403);
  }finally{app.DB.close();}
});
test('optimistic concurrency keeps one winning write, full history, and completed locking',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),entry=await app.note(admin);
    const results=await Promise.all(['first','second'].map(title=>app.call('/api/notebook/save',{id:entry.id,revision:1,data:{...entry.data,title}},admin)));
    assert.deepEqual(results.map(item=>item.status).sort(),[200,409]);
    const saved=(await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json;
    assert.equal(saved.revision,2);assert.equal((await app.call('/api/notebook/history/'+entry.id,undefined,admin)).json.total,2);
    const complete=await app.call('/api/notebook/save',{id:entry.id,revision:2,data:{...saved.data,status:'complete'}},admin);assert.equal(complete.status,200);
    assert.equal((await app.call('/api/notebook/save',{id:entry.id,revision:3,data:{...saved.data,title:'blocked'}},admin)).status,409);
    assert.equal((await app.call('/api/notebook/action',{id:entry.id,revision:3,action:'reopen',reason:''},admin)).status,400);
    assert.equal((await app.call('/api/notebook/action',{id:entry.id,revision:3,action:'reopen',reason:'补充实验条件'},admin)).status,200);
  }finally{app.DB.close();}
});
test('chunk upload integrity, original download isolation and inline image ownership',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),member=await app.login('member'),entry=await app.note(admin),bytes=new Uint8Array(800000).fill(65);
    const begin=await app.call('/api/files/begin',{id:entry.id,revision:1,filename:'original.txt',size:bytes.length,sha256:await sha(bytes)},admin);assert.equal(begin.status,200);
    assert.equal((await app.call('/api/files/chunk',{upload_id:begin.json.id,position:0,data:base64(bytes.slice(0,786432))},admin)).status,200);
    assert.equal((await app.call('/api/files/finish',{upload_id:begin.json.id,revision:1},admin)).status,409);
    assert.equal((await app.call('/api/files/chunk',{upload_id:begin.json.id,position:1,data:base64(bytes.slice(786432))},member)).status,404);
    assert.equal((await app.call('/api/files/chunk',{upload_id:begin.json.id,position:1,data:base64(bytes.slice(786432))},admin)).status,200);
    const finished=await app.call('/api/files/finish',{upload_id:begin.json.id,revision:1},admin);assert.equal(finished.status,200);assert.equal(finished.json.attachments[0].sha256,await sha(bytes));
    assert.equal((await app.call('/api/notebook/attachment/'+begin.json.id,undefined,member)).status,404);
    assert.equal((await app.call('/api/notebook/preview/'+begin.json.id,undefined,admin)).status,400);
    const bad=await app.call('/api/notebook/save',{id:entry.id,revision:2,data:{...entry.data,body_format:'inline-images-v1',body:'[[colorlens-image:'+begin.json.id+']]'}},admin);assert.equal(bad.status,400);
  }finally{app.DB.close();}
});
test('read-only sharing freezes a snapshot, revokes immediately and cannot reach other files',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),entry=await app.note(admin);
    const share=await app.call('/api/shares/create',{id:entry.id,revision:1,days:7},admin);assert.equal(share.status,200);
    await app.call('/api/notebook/save',{id:entry.id,revision:1,data:{...entry.data,title:'updated'}},admin);
    const snapshot=await app.call('/api/public/share',{token:share.json.token});assert.equal(snapshot.json.entry.data.title,entry.data.title);
    assert.equal((await app.call('/api/public/share',{token:share.json.token,attachment_id:uid()})).status,404);
    assert.equal((await app.call('/api/shares/revoke',{id:entry.id,share_id:share.json.id},admin)).status,200);
    assert.equal((await app.call('/api/public/share',{token:share.json.token})).status,404);
    assert.equal(app.DB.raw.prepare('SELECT hash FROM shares').get().hash.includes(share.json.token),false);
  }finally{app.DB.close();}
});
const output={summary:'模拟数据，仅供流程验证。',evidence:['正文提供了模拟观察。'],issues:[],hypotheses:['待验证：需核对空白。'],next_steps:['补充独立重复与本批次标准品。'],report_draft:'未提供真实结果，无法形成真实实验结论。',missing_info:['试剂盒厂家货号和批次']};
test('DeepSeek receives only confirmed selection, stays server-side and stores revision provenance',async()=>{
  let sent;
  const app=fixture(async(url,options)=>{sent={url,options};return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));});
  try{
    const admin=await app.login('admin'),entry=await app.note(admin,{body:'选中的正文',operator:'NEVER-SEND-OPERATOR',discussion:'NEVER-SEND-DISCUSSION'});
    const payload={id:entry.id,revision:1,task:'full',fields:['body'],analysis_ids:[],question:'检查设计'};
    const prepared=await app.call('/api/ai/preview',payload,admin);assert.equal(prepared.status,200);
    assert.equal(JSON.stringify(prepared.json).includes('NEVER-SEND'),false);
    assert.equal((await app.call('/api/ai/run',{...payload,preview_hash:prepared.json.preview_hash},admin)).status,400);
    assert.equal((await app.call('/api/ai/run',{...payload,consent:true,preview_hash:'wrong'},admin)).status,409);
    const result=await app.call('/api/ai/run',{...payload,consent:true,preview_hash:prepared.json.preview_hash},admin);assert.equal(result.status,200,JSON.stringify(result.json));
    assert.equal(sent.url,'https://api.deepseek.com/chat/completions');assert.equal(sent.options.headers.Authorization,'Bearer mock-private-key');
    assert.equal(sent.options.body.includes('NEVER-SEND'),false);assert.equal(JSON.stringify(result.json).includes('mock-private-key'),false);
    assert.equal(result.json.revision,1);assert.equal((await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json.revision,1);
    assert.equal((await app.call('/api/ai/list',{id:entry.id},admin)).json.items[0].status,'complete');
  }finally{app.DB.close();}
});
test('AI provider errors and truncation never become successful reports',async()=>{
  for(const failure of [new Response('SECRET-PROVIDER-ERROR',{status:401}),new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:JSON.stringify(output)}}]})),new Response('not JSON')]){
    const app=fixture(async()=>failure);try{const admin=await app.login('admin'),entry=await app.note(admin),payload={id:entry.id,revision:1,task:'full',fields:['body'],analysis_ids:[]};const preview=await app.call('/api/ai/preview',payload,admin);const result=await app.call('/api/ai/run',{...payload,preview_hash:preview.json.preview_hash,consent:true},admin);assert.equal(result.status,502);assert.equal(JSON.stringify(result.json).includes('SECRET-PROVIDER-ERROR'),false);assert.equal((await app.call('/api/ai/list',{id:entry.id},admin)).json.items[0].status,'failed');}finally{app.DB.close();}
  }
});
test('bounded extra AI list items do not discard a complete valid reply',async()=>{
  const result={...output,issues:Array.from({length:9},(_,index)=>'待人工核对 '+index)};
  const app=fixture(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})));
  try{const admin=await app.login('admin'),entry=await app.note(admin),payload={id:entry.id,revision:1,task:'full',fields:['body'],analysis_ids:[]};const preview=await app.call('/api/ai/preview',payload,admin);const response=await app.call('/api/ai/run',{...payload,preview_hash:preview.json.preview_hash,consent:true},admin);assert.equal(response.status,200);assert.equal(response.json.result.issues.length,9);}finally{app.DB.close();}
});
test('database triggers atomically enforce AI, document and file quotas',async()=>{
  const app=fixture();try{
    const admin=await app.login('admin'),entry=await app.note(admin);
    app.DB.raw.prepare('UPDATE users SET doc_bytes=10485760 WHERE id=?').run(app.users[0].id);
    assert.equal((await app.call('/api/notebook/save',{id:entry.id,revision:1,data:{...entry.data,title:'quota'}},admin)).status,413);
    assert.equal((await app.call('/api/notebook/entry/'+entry.id,undefined,admin)).json.revision,1);
    app.DB.raw.prepare('UPDATE users SET doc_bytes=0,file_bytes=52428800 WHERE id=?').run(app.users[0].id);
    assert.equal((await app.call('/api/files/begin',{id:entry.id,revision:1,filename:'a.txt',size:1,sha256:await sha('a')},admin)).status,413);
    app.DB.raw.prepare('INSERT INTO ai_budgets VALUES(?,?,?)').run(new Date().toISOString().slice(0,10),app.users[0].id,10);
    const payload={id:entry.id,revision:1,task:'full',fields:['body'],analysis_ids:[]},preview=await app.call('/api/ai/preview',payload,admin);
    assert.equal((await app.call('/api/ai/run',{...payload,preview_hash:preview.json.preview_hash,consent:true},admin)).status,429);
    assert.equal(app.DB.raw.prepare('SELECT count(*) AS count FROM ai_runs').get().count,0);
  }finally{app.DB.close();}
});
test('disabled members lose sessions and public shares',async()=>{
  const app=fixture();try{const admin=await app.login('admin'),member=await app.login('member'),entry=await app.note(member),share=await app.call('/api/shares/create',{id:entry.id,revision:1,days:1},member);assert.equal((await app.call('/api/auth/disable',{id:app.users[1].id,disabled:true},admin)).status,200);assert.equal((await app.call('/api/notebook',undefined,member)).status,401);assert.equal((await app.call('/api/public/share',{token:share.json.token})).status,404);}finally{app.DB.close();}
});
test('instrument statistics match analytical values, reference correction and CSV quoting',()=>{
  const payload={assay_id:'il6',wavelength:450,reference_wavelength:null,subtract_blank:true,simulated:true,csv:'sample_id,role,well,od\nBlank,blank,A1,0.1\n"Sample,A",sample,A2,0.5\n"Sample,A",sample,A3,0.7'};
  const result=analyzeInstrument(payload,assays),group=result.groups[1];assert.ok(Math.abs(group.mean_od-.5)<1e-12);assert.ok(Math.abs(group.sd-Math.sqrt(.02))<1e-12);assert.equal(result.concentration_estimation,null);
  assert.throws(()=>analyzeInstrument({...payload,csv:payload.csv+'\nX,sample,A2,0.4'},assays));
  assert.throws(()=>analyzeInstrument({...payload,assay_id:'sod'},assays));
  assert.throws(()=>parseCsv('sample_id,role,od\nA,sample,"1'));
  assert.throws(()=>analyzeInstrument({...payload,csv:'sample_id,role,od\nA,sample,NaN'},assays));
  for(const assay of assays.filter(item=>item.instrument_allowed)){const demo=instrumentDemo(assay);assert.equal(analyzeInstrument({...demo,assay_id:assay.id,subtract_blank:false},assays).rows.length,13);}
});
test('CIEDE2000 reference vectors and Lab standard colors',()=>{
  for(const [first,second,expected] of [[[50,2.6772,-79.7751],[50,0,-82.7485],2.0425],[[50,3.1571,-77.2803],[50,0,-82.7485],2.8615],[[50,2.8361,-74.0200],[50,0,-82.7485],3.4412],[[50,-1.3802,-84.2814],[50,0,-82.7485],1],[[50,0,0],[50,-1,2],2.3669]])assert.ok(Math.abs(deltaE(first,second)-expected)<.0001);
  assert.ok(Math.abs(rgbLab([255,255,255])[0]-100)<.001);assert.deepEqual(rgbLab([0,0,0]),[0,0,0]);
});
test('pixel analysis keeps invalid control null and detects transparent and invalid ROIs',()=>{
  const pixels=new Uint8ClampedArray(40*40*4);for(let offset=0;offset<pixels.length;offset+=4)pixels.set([120,80,40,255],offset);
  const rois=[{id:'R1',label:'blank',x:0,y:0,w:5,h:5},{id:'R2',label:'sample',x:10,y:10,w:25,h:25}];
  const result=analyzePixels(40,40,pixels,rois,'R1',{});assert.equal(result.results[0].status,'invalid');assert.equal(result.results[1].delta_e,null);assert.equal(result.matrix[1][1],0);
  assert.throws(()=>analyzePixels(40,40,pixels,[{...rois[1],x:-1}],'R2',{}));
  pixels[(10*40+10)*4+3]=0;assert.throws(()=>analyzePixels(40,40,pixels,[{id:'R1',x:0,y:0,w:40,h:40}],'R1',{}));
});
test('browser numeric port matches V0.3 Python synthetic reference, with disclosed floating-point tolerance',()=>{
  const result=analyzePixels(photoGolden.width,photoGolden.height,new Uint8ClampedArray(photoGolden.pixels),photoGolden.rois,photoGolden.control_id,{},true);
  for(const [index,row] of result.results.entries()){
    const expected=photoGolden.expected.results[index];assert.equal(row.status,expected.status);
    for(const key of ['rgb','hsv','lab'])if(row[key])row[key].forEach((value,channel)=>assert.ok(Math.abs(value-expected[key][channel])<.002,`${index}.${key}.${channel}: ${value} != ${expected[key][channel]}`));
    for(const key of ['spread','clipped','dark','sharpness','delta_e'])if(row[key]!==null)assert.ok(Math.abs(row[key]-expected[key])<=Math.max(.002,Math.abs(expected[key])*.00001),`${index}.${key}`);
  }
  assert.ok(Math.abs(result.closest.delta_e-photoGolden.expected.closest.delta_e)<.002);
  for(const fixture of instrumentGolden){const actual=analyzeInstrument(fixture.payload,assays);assert.equal(actual.groups.length,fixture.expected.groups.length);actual.groups.forEach((group,index)=>{for(const key of ['mean_od','sd','cv_percent'])if(group[key]!==null)assert.ok(Math.abs(group[key]-fixture.expected.groups[index][key])<1e-9,`${fixture.payload.assay_id} ${key}`);});}
});
