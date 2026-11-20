import {AppError,check,text,uid,now,sha,token,base64,unbase64,first,rows,execute,query,json,encoder,escapeHtml} from './common.mjs';
import {templateBinding,templateData} from './templates.mjs';
import {archiveGuidance} from './guidance-store.mjs';

const limits = {title:200,project:120,operator:100,body:100000,purpose:20000,materials:20000,procedure:40000,results:40000,discussion:40000,event_draft:4000};
export function cleanData(payload,binding=null) {
  check(payload && typeof payload==='object' && !Array.isArray(payload),'笔记格式无效。');
  const data = Object.fromEntries(Object.entries(limits).map(([key,maximum])=>[key,text(payload[key]??'',maximum,key)]));
  for (const key of ['title','project','operator']) data[key]=data[key].trim();
  data.title ||= '未命名实验';
  data.date = payload.date || now().slice(0,10);
  const parsedDate=new Date(data.date);
  check(/^\d{4}-\d{2}-\d{2}$/.test(data.date) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0,10)===data.date,'实验日期无效。');
  for (const [key,options,defaultValue] of [['kind',['course','research','general'],'general'],['template',['free','report'],'free'],['status',['draft','complete'],'draft']]) {
    data[key] = payload[key] || defaultValue;
    check(options.includes(data[key]),'记录类型无效。');
  }
  check(Array.isArray(payload.tags ?? []) && (payload.tags??[]).length<=12,'标签最多 12 个。');
  data.tags = [...new Set((payload.tags??[]).map(tag=>text(tag,30,'标签',true).trim()))];
  if (payload.body_format!==undefined) { check(payload.body_format==='inline-images-v1','图文格式无效。'); data.body_format=payload.body_format; }
  check(data.status!=='complete' || !data.event_draft.trim(),'请先提交或清空过程草稿。');
  Object.assign(data,templateData(payload,binding,data.status==='complete'));
  return data;
}
export function notebookDataMatches(entry,payload) {
  if(!entry||entry.deleted||entry.data?.status!=='draft')return false;
  try{return JSON.stringify(entry.data)===JSON.stringify(cleanData(payload,entry.data.template_binding??null));}catch{return false;}
}
export function validateImages(data,attachments) {
  if (data.body_format!=='inline-images-v1') return;
  const references = [...data.body.matchAll(/\[\[colorlens-image:([a-f0-9]{32})\]\]/g)].map(match=>match[1]);
  check(references.length<=50 && references.every(reference=>attachments.some(item=>item.id===reference && /\.(jpe?g|png|webp)$/i.test(item.filename))),'正文图片不属于本条记录或数量超过 50 张。');
}
export async function detail(env,user,id) {
  check(typeof id==='string' && /^[a-f0-9]{32}$/.test(id),'记录不存在。',404);
  const entry = await first(env,'SELECT doc FROM entries WHERE id=? AND owner=?',id,user.id);
  check(entry,'记录不存在或无权访问。',404);
  return JSON.parse(entry.doc);
}
export function editable(entry,revision) {
  check(Number.isSafeInteger(revision) && revision===entry.revision,'这条记录已在其他窗口更新。请下载当前输入文本，再重新打开记录。',409);
  check(!entry.deleted && entry.data.status==='draft','记录已完成或在回收站，请先添加修订或恢复。',409);
}
export function updateStatements(env,user,entry,reason,previous) {
  entry.revision = previous+1;
  entry.updated_at = now();
  const serialized = JSON.stringify(entry);
  check(encoder.encode(serialized).length<=450000,'笔记或过程过长，请拆成新的实验记录。');
  return [query(env,'UPDATE entries SET doc=?,revision=?,reason=?,updated_at=? WHERE id=? AND owner=? AND revision=?',serialized,entry.revision,reason,entry.updated_at,entry.id,user.id,previous),
    query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')];
}
export async function save(env,user,entry,reason,previous,extra=[]) {
  await env.DB.batch([...extra,...updateStatements(env,user,entry,reason,previous)]);
  return entry;
}
export async function create(env,user,payload,trustedBinding=null) {
  const binding=await templateBinding(env,user,payload,trustedBinding);
  const initialized=binding?{...binding.definition.sections,kind:binding.definition.kind,template:'report',...payload,template_binding:binding,title:payload.title||binding.definition.title}:payload;
  const data=cleanData({...initialized,status:'draft'},binding);
  data.status='draft';
  validateImages(data,[]);
  const entry={id:uid(),data,created_at:now(),updated_at:now(),revision:1,deleted:0,attachments:[],events:[],analyses:[]};
  await execute(env,'INSERT INTO entries VALUES(?,?,?,?,?,?)',entry.id,user.id,JSON.stringify(entry),1,'创建记录',entry.updated_at);
  return entry;
}
export async function fileRow(env,user,id) {
  const file=await first(env,'SELECT * FROM files WHERE id=? AND owner=? AND ready=1',id,user.id);
  check(file,'附件不存在或无权访问。',404);
  return file;
}
export async function fileBytes(env,file) {
  const bytes=new Uint8Array(file.size);
  let offset=0;
  for (let position=0;position<file.chunks;position++) {
    const chunk=await first(env,'SELECT data FROM file_chunks WHERE file_id=? AND position=?',file.id,position);
    check(chunk,'附件数据块未上传完整。',409);
    const part=unbase64(chunk.data);
    check(offset+part.length<=bytes.length,'附件数据异常。',409);
    bytes.set(part,offset);offset+=part.length;
  }
  check(offset===file.size && await sha(bytes)===file.sha256,'附件完整性校验失败。',409);
  return bytes;
}
export async function fileResponse(env,file,preview=false) {
  const extension=file.filename.split('.').at(-1).toLowerCase();
  const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp'};
  check(!preview || types[extension],'只能预览图片。');
  let position=0;
  const stream=new ReadableStream({async pull(controller) {
    try {
      if (position>=file.chunks) { controller.close(); return; }
      const chunk=await first(env,'SELECT data FROM file_chunks WHERE file_id=? AND position=?',file.id,position++);
      check(chunk,'附件块缺失。',409);
      controller.enqueue(unbase64(chunk.data));
    } catch(error) { controller.error(error); }
  }});
  return new Response(stream,{headers:{'Content-Type':preview?types[extension]:'application/octet-stream','Content-Disposition':`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Content-Length':String(file.size),'X-Content-Type-Options':'nosniff'}});
}
export async function upload(env,user,path,payload) {
  if (path==='/api/files/begin') {
    const entry=await detail(env,user,payload.id);
    editable(entry,payload.revision);
    check(entry.attachments.length<100,'每条记录最多 100 个附件。');
    const filename=text(payload.filename,200,'文件名',true).replace(/[\\/\x00-\x1f\x7f]/g,'_');
    check(/\.(jpe?g|png|webp|csv|pdf|txt|md|xlsx|docx|pptx|json|zip)$/i.test(filename),'不支持此附件类型。');
    check(Number.isSafeInteger(payload.size) && payload.size>0 && payload.size<=20*1024*1024,'附件需在 1 字节至 20 MB 之间。');
    check(/^[a-f0-9]{64}$/.test(payload.sha256),'附件哈希无效。');
    await execute(env,'DELETE FROM files WHERE owner=? AND ready=0 AND expires<?',user.id,Math.floor(Date.now()/1000));
    const id=uid();
    const chunks=Math.ceil(payload.size/786432);
    await execute(env,'INSERT INTO files(id,owner,entry_id,filename,size,sha256,chunks,expires,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,user.id,entry.id,filename,payload.size,payload.sha256,chunks,Math.floor(Date.now()/1000)+3600,now());
    return {id,chunks};
  }
  const file=await first(env,'SELECT * FROM files WHERE id=? AND owner=? AND ready=0 AND expires>?',payload.upload_id,user.id,Math.floor(Date.now()/1000));
  check(file,'上传已完成或已过期，请重试。',404);
  if (path==='/api/files/cancel') { await execute(env,'DELETE FROM files WHERE id=? AND owner=? AND ready=0',file.id,user.id); return {ok:true}; }
  if (path==='/api/files/chunk') {
    check(Number.isInteger(payload.position) && payload.position>=0 && payload.position<file.chunks,'附件块编号无效。');
    const encoded=text(payload.data,1048576,'附件块',true);
    check(encoded.length%4===0 && !/[^A-Za-z0-9+/=]/.test(encoded) && !encoded.slice(0,-2).includes('='),'附件编码无效。');
    const bytes=unbase64(encoded);
    const expected=payload.position===file.chunks-1?file.size-payload.position*786432:786432;
    check(bytes.length===expected,'附件块长度错误。');
    await execute(env,'INSERT INTO file_chunks VALUES(?,?,?) ON CONFLICT(file_id,position) DO UPDATE SET data=excluded.data',file.id,payload.position,encoded);
    return {ok:true};
  }
  check(path==='/api/files/finish','接口不存在。',404);
  const entry=await detail(env,user,file.entry_id);
  editable(entry,payload.revision);
  check(entry.attachments.length<100,'每条记录最多 100 个附件。');
  const bytes=await fileBytes(env,file);
  if (/\.(jpe?g|png|webp)$/i.test(file.filename)) {
    const jpeg=bytes[0]===255 && bytes[1]===216;
    const png=bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10';
    const webp=new TextDecoder().decode(bytes.slice(0,4))==='RIFF' && new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
    const extension=file.filename.split('.').at(-1).toLowerCase();
    check(({jpg:jpeg,jpeg:jpeg,png,webp})[extension],'图片内容与扩展名不匹配。');
  }
  entry.attachments.push({id:file.id,entry_id:entry.id,filename:file.filename,size:file.size,sha256:file.sha256,created_at:file.created_at});
  return save(env,user,entry,'添加原始附件',payload.revision,[query(env,'UPDATE files SET ready=1 WHERE id=? AND owner=? AND ready=0',file.id,user.id)]);
}
export async function notebookRoute(env,user,request,path,payload,url) {
  if (path==='/api/notebook/info') {
    const usage=await first(env,'SELECT doc_bytes,file_bytes FROM users WHERE id=?',user.id);
    return json({data_directory:`独立云端空间 · ${user.username} · 原件 ${(usage.file_bytes/1048576).toFixed(1)}/50 MB · 历史 ${(usage.doc_bytes/1048576).toFixed(1)}/10 MB`,...usage});
  }
  if (path==='/api/notebook') {
    const all=(await rows(env,'SELECT doc FROM entries WHERE owner=? ORDER BY updated_at DESC',user.id)).map(row=>JSON.parse(row.doc));
    const active=all.filter(entry=>!entry.deleted);
    const search=(url.searchParams.get('q')||'').slice(0,200).toLowerCase();
    const trash=url.searchParams.get('trash')==='true' || url.searchParams.get('trash')==='1';
    const selected=all.filter(entry=>Boolean(entry.deleted)===trash).filter(entry=>['status','project','kind'].every(key=>!url.searchParams.get(key)||entry.data[key]===url.searchParams.get(key))).filter(entry=>!search||JSON.stringify(entry.data).toLowerCase().includes(search));
    const offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    return json({entries:selected.slice(offset,offset+40),total:selected.length,counts:{total:active.length,draft:active.filter(entry=>entry.data.status==='draft').length,complete:active.filter(entry=>entry.data.status==='complete').length},projects:[...new Set(active.map(entry=>entry.data.project).filter(Boolean))],offset});
  }
  if (path==='/api/notebook/create') return json(await create(env,user,payload.data||{}));
  if (path.startsWith('/api/notebook/entry/')) return json(await detail(env,user,path.split('/').at(-1)));
  if (path.startsWith('/api/notebook/history/')) {
    const id=path.split('/').at(-1);
    await detail(env,user,id);
    const offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
    return json({items:await rows(env,'SELECT revision,reason,created_at FROM revisions WHERE entry_id=? AND owner=? ORDER BY revision DESC LIMIT 40 OFFSET ?',id,user.id,offset),total:(await first(env,'SELECT COUNT(*) AS count FROM revisions WHERE entry_id=? AND owner=?',id,user.id)).count});
  }
  if (path.startsWith('/api/notebook/revision/')) {
    const parts=path.split('/');
    await detail(env,user,parts.at(-2));
    const revision=await first(env,'SELECT snapshot FROM revisions WHERE entry_id=? AND owner=? AND revision=?',parts.at(-2),user.id,Number(parts.at(-1)));
    check(revision,'该版本不存在。',404);
    return json(JSON.parse(revision.snapshot));
  }
  if (path.startsWith('/api/notebook/attachment/') || path.startsWith('/api/notebook/preview/')) return fileResponse(env,await fileRow(env,user,path.split('/').at(-1)),path.includes('/preview/'));
  if (path==='/api/notebook/backup-index') {
    return json({schema:'colorlens-cloud-1',app_version:'0.4.0',created_at:now(),entries:(await rows(env,'SELECT doc FROM entries WHERE owner=? ORDER BY updated_at',user.id)).map(row=>JSON.parse(row.doc))});
  }
  if (path.startsWith('/api/notebook/archive/')) {
    const entry=await detail(env,user,path.split('/').at(-1));
    const guidance=await archiveGuidance(env,user,entry.id);
    return json({entry,revisions:await rows(env,'SELECT revision,snapshot,reason,created_at FROM revisions WHERE owner=? AND entry_id=? ORDER BY revision',user.id,entry.id),analyses:await rows(env,'SELECT id,data,sha256,created_at FROM analyses WHERE owner=? AND entry_id=?',user.id,entry.id),ai:await rows(env,'SELECT id,revision,input,input_hash,task,result,status,model,created_at,completed_at FROM ai_runs WHERE owner=? AND entry_id=?',user.id,entry.id),...guidance.length?{guidance}:{}});
  }
  if (path==='/api/notebook/import-legacy') throw new AppError(400,'云端不能直接读取你的 D 盘。请在 V0.3 导出 ZIP，然后在此选择该备份导入。');
  if (path==='/api/notebook/duplicate') {
    const source=await detail(env,user,payload.id);
    return json(await create(env,user,{...source.data,title:source.data.title+'（再次实验）',date:now().slice(0,10),body:'',body_format:undefined,results:'',discussion:'',event_draft:'',template_values:{},template_checks:[],tags:source.data.tags.filter(tag=>tag!=='模拟数据')},source.data.template_binding??null));
  }
  if (['/api/notebook/save','/api/notebook/action','/api/notebook/event'].includes(path)) {
    const entry=await detail(env,user,payload.id);
    check(entry.revision===payload.revision,'记录已在其他窗口修改，请先保留输入副本。',409);
    let reason='保存笔记';
    if (path.endsWith('/save')) {
      editable(entry,payload.revision);
      const data=cleanData(payload.data,entry.data.template_binding??null);
      validateImages(data,entry.attachments);
      if (JSON.stringify(data)===JSON.stringify(entry.data)) return json(entry);
      entry.data=data;
    } else if (path.endsWith('/event')) {
      editable(entry,payload.revision);
      check(entry.events.length<1000,'过程记录过多，请建立下一条实验。');
      entry.events.push({id:uid(),entry_id:entry.id,text:text(payload.text,4000,'过程记录',true),created_at:now()});
      entry.data.event_draft='';
      reason='添加过程记录';
    } else {
      check(['trash','recover','reopen'].includes(payload.action),'操作无效。');
      if (payload.action==='reopen') {
        check(!entry.deleted && entry.data.status==='complete','只有已完成记录可以添加修订。');
        reason='重新编辑：'+text(payload.reason,1000,'修订原因',true);
        entry.data.status='draft';
      } else { entry.deleted=payload.action==='trash'?1:0; reason=payload.action==='trash'?'移入回收站':'恢复记录'; }
    }
    return json(await save(env,user,entry,reason,payload.revision));
  }
  throw new AppError(404,'接口不存在。');
}

export async function shareRoute(env,user,path,payload) {
  const entry=await detail(env,user,payload.id);
  if (path==='/api/shares/list') return {items:await rows(env,'SELECT id,expires,revoked,created_at FROM shares WHERE owner=? AND entry_id=? ORDER BY created_at DESC',user.id,entry.id)};
  if (path==='/api/shares/revoke') { await execute(env,'UPDATE shares SET revoked=1 WHERE id=? AND owner=? AND entry_id=?',payload.share_id,user.id,entry.id); return {ok:true}; }
  check(path==='/api/shares/create','接口不存在。',404);
  check(!entry.deleted && entry.revision===payload.revision,'请刷新并保存记录后再分享。',409);
  check(Number.isInteger(payload.days) && [1,7,30].includes(payload.days),'分享时限无效。');
  const active=await first(env,'SELECT COUNT(*) AS count FROM shares WHERE owner=? AND revoked=0 AND expires>?',user.id,Math.floor(Date.now()/1000));
  check(active.count<20,'最多 20 个有效分享，请先撤销旧分享。');
  const value=token(), id=uid(), expires=Math.floor(Date.now()/1000)+payload.days*86400;
  await execute(env,'INSERT INTO shares VALUES(?,?,?,?,?,?,0,?)',id,await sha(value),user.id,entry.id,JSON.stringify(entry),expires,now());
  return {id,token:value,expires};
}
export async function publicShare(env,request,payload) {
  text(payload.token,64,'分享凭证',true);
  const share=await first(env,`SELECT shares.* FROM shares JOIN users ON users.id=shares.owner
    WHERE shares.hash=? AND shares.revoked=0 AND shares.expires>? AND users.disabled=0`,await sha(payload.token),Math.floor(Date.now()/1000));
  check(share,'分享已撤销、过期或不存在。',404);
  const snapshot=JSON.parse(share.snapshot);
  if (payload.attachment_id) {
    check(snapshot.attachments.some(item=>item.id===payload.attachment_id),'附件不属于此分享快照。',404);
    const file=await fileRow(env,{id:share.owner},payload.attachment_id);
    return fileResponse(env,file,Boolean(payload.preview));
  }
  return json({entry:snapshot,expires:share.expires,notice:'只读快照，不随原记录更新；不包含 AI 草稿与修改历史。持链接者可查看原始附件，请勿继续转发。'});
}
