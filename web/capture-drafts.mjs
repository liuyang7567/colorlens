const schema='colorlens-capture-draft-1',maximum=32*1048576;
const identity=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const ensure=(value,message)=>{if(!value)throw new Error(message);};
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
const date=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const scopeOK=scope=>identity(scope?.account)&&identity(scope?.entryId);
export function captureImageType(bytes){return bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'?'image/webp':null;}
function itemCopy(item,entryId){
  ensure(item&&identifier(item.id)&&item.entryId===entryId&&['text','image','file'].includes(item.kind),'草稿项目编号或目标实验无效。');
  ensure(typeof item.source==='string'&&item.source.length<=200&&date(item.capturedAt)&&(!item.recordedAt||date(item.recordedAt)),'草稿来源或时间无效。');
  const result={id:item.id,entryId,kind:item.kind,source:item.source,capturedAt:item.capturedAt,...item.recordedAt?{recordedAt:item.recordedAt}:{}};
  if(item.receiptHash){ensure(/^[a-f0-9]{64}$/.test(item.receiptHash),'草稿内容编号无效。');result.receiptHash=item.receiptHash;}
  if(item.kind==='text'){ensure(typeof item.text==='string'&&item.text.length<=12000,'草稿文字超过限制。');result.text=item.text;}
  else{
    ensure(item.bytes instanceof Uint8Array&&item.bytes.length>0&&item.bytes.length<=20*1048576,'草稿附件大小无效。');
    ensure(typeof item.filename==='string'&&item.filename.length>0&&item.filename.length<=255&&!/[\\/\x00-\x1f]/.test(item.filename),'草稿附件名无效。');
    let valid=item.kind==='image'?captureImageType(item.bytes):/\.zip$/i.test(item.filename)&&item.bytes[0]===80&&item.bytes[1]===75;
    if(item.kind==='file'&&/\.json$/i.test(item.filename)){try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(item.bytes));valid=value!==null&&typeof value==='object';}catch{valid=false;}}
    ensure(valid,'草稿附件类型无效。');
    result.filename=item.filename;result.bytes=new Uint8Array(item.bytes);
    if(item.uploadId){ensure(identity(item.uploadId),'草稿附件编号无效。');result.uploadId=item.uploadId;}
  }
  return result;
}
export async function snapshotCaptureDraft(items,scope,id){
  ensure(scopeOK(scope)&&identifier(id),'本机草稿归属无效。');ensure(Array.isArray(items)&&items.length<=10,'本机待保存区最多 10 项。');
  ensure(items.reduce((total,item)=>total+(item?.bytes instanceof Uint8Array?item.bytes.length:0)+(typeof item?.text==='string'?item.text.length*3:0),0)<=maximum,'本机待保存区超过 32 MB。');
  const copies=items.map(item=>itemCopy(item,scope.entryId));ensure(new Set(copies.map(item=>item.id)).size===copies.length,'草稿包含重复采集编号。');
  const size=copies.reduce((total,item)=>total+(item.bytes?.length||0)+(item.text?.length||0)*3,0);ensure(size<=maximum,'本机待保存区超过 32 MB。');
  for(const item of copies)if(item.bytes)item.bytesHash=await hash(item.bytes);
  const payloadHash=await hash(new TextEncoder().encode(JSON.stringify({id,account:scope.account,entryId:scope.entryId,items:copies.map(({bytes,...item})=>item)})));
  return {schema,id,account:scope.account,entryId:scope.entryId,entryTitle:String(scope.entryTitle||'').slice(0,200),updatedAt:new Date().toISOString(),size,payloadHash,items:copies};
}
export async function restoreCaptureDraft(record,scope){
  ensure(scopeOK(scope)&&record?.schema===schema&&record.account===scope.account&&record.entryId===scope.entryId&&identifier(record.id)&&date(record.updatedAt),'本机草稿不属于当前账号和实验，或格式无效。');
  const result=await snapshotCaptureDraft(record.items,scope,record.id);ensure(result.size===record.size,'本机草稿大小校验失败。');ensure(result.payloadHash===record.payloadHash,'本机草稿文字或元数据校验失败，请保留副本检查。');
  for(let index=0;index<result.items.length;index++)if(result.items[index].bytes)ensure(result.items[index].bytesHash===record.items[index].bytesHash,'本机草稿附件校验失败，请保留副本检查。');
  return result.items.map(({bytesHash,...item})=>({...item,reviewed:false}));
}
export function helperDraftSelection(items){
  ensure(Array.isArray(items)&&items.length<=2,'采集窗口草稿最多包含一段文字和上一张截图。');
  ensure(items.every(item=>['text','image'].includes(item?.kind))&&new Set(items.map(item=>item.kind)).size===items.length,'采集窗口草稿类型或数量无效。');
  const text=items.find(item=>item.kind==='text')||null,image=items.find(item=>item.kind==='image')||null;
  for(const item of items)ensure(identifier(item.id)&&typeof item.source==='string'&&item.source.length<=100&&date(item.capturedAt)&&(!item.recordedAt||date(item.recordedAt)),'采集窗口草稿来源或编号无效。');
  if(text)ensure(typeof text.text==='string'&&text.text.trim().length>0&&text.text.length<=12000,'采集窗口文字无效。');
  if(image)ensure(image.bytes instanceof Uint8Array&&image.bytes.length<=8*1048576&&captureImageType(image.bytes)==='image/jpeg','采集窗口截图须为 8 MB 以内的 JPEG。');
  return {text,image};
}
export function captureTranscriptSource({restoredSource='',restoredEdited=false,recognised=false,origin=null}){
  if(restoredSource){const suffix=' · 恢复后人工编辑';return restoredEdited?restoredSource.slice(0,100-suffix.length)+suffix:restoredSource.slice(0,100);}
  if(!recognised)return '本机手动录入（未运行语音识别）';
  const prefix='眼镜音轨 · ',duration=Number.isFinite(origin.durationSeconds)&&origin.durationSeconds>0&&origin.durationSeconds<=60?' · 实际约 '+origin.durationSeconds.toFixed(1)+' 秒':'';
  const suffix=duration+' · '+(origin.edited?'离线转写后人工编辑':'本机离线转写')+'（待人工复核）';
  return prefix+origin.label.slice(0,Math.max(0,100-prefix.length-suffix.length))+suffix;
}
function database(){return new Promise((resolve,reject)=>{const opened=indexedDB.open('colorlens-capture-drafts-v1',1);opened.onupgradeneeded=()=>opened.result.createObjectStore('drafts',{keyPath:['account','entryId','id']});opened.onsuccess=()=>resolve(opened.result);opened.onerror=()=>reject(new Error('浏览器未允许本机草稿存储，内容仍在当前页面。'));opened.onblocked=()=>reject(new Error('本机草稿库正在被其他窗口使用，请稍后重试。'));});}
async function transaction(mode,operation){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=mode==='readwrite'?db.transaction('drafts',mode,{durability:'strict'}):db.transaction('drafts',mode),store=tx.objectStore('drafts');let value,error;tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(error||new Error('本机暂存失败或空间不足；内容仍在当前页面，请勿直接关闭。'));try{operation(store,tx,result=>{value=result;},reason=>{error=new Error(reason);tx.abort();});}catch(reason){error=reason;tx.abort();}});}finally{db.close();}}
const key=(scope,id)=>[scope.account,scope.entryId,id];
export const captureDraftStore={
  async write(record){return transaction('readwrite',(store,tx,done,fail)=>{let total=record.size,count=1;const cursor=store.openCursor(IDBKeyRange.bound([record.account],[record.account,'\uffff']));cursor.onsuccess=()=>{try{const item=cursor.result;if(item){const old=item.value;if(old.entryId!==record.entryId||old.id!==record.id){total+=Number.isFinite(old.size)?old.size:maximum;count++;}item.continue();}else if(total>64*1048576||count>20)fail('本机草稿达到 64 MB 或 20 份，请先恢复或明确删除不需要的副本；当前内容仍在页面。');else store.put(record);}catch{fail('本机暂存失败或空间不足；内容仍在当前页面，请勿直接关闭。');}};});},
  async list(scope){ensure(scopeOK(scope),'请选择当前账号的目标实验。');return transaction('readonly',(store,tx,done)=>{const rows=[],request=store.openCursor(IDBKeyRange.bound(key(scope,''),key(scope,'\uffff')));request.onsuccess=()=>{const cursor=request.result;if(cursor){const value=cursor.value;rows.push({id:value.id,updatedAt:value.updatedAt,payloadHash:value.payloadHash,size:value.size,count:value.items?.length||0});cursor.continue();}else done(rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))));};});},
  async read(scope,id){ensure(scopeOK(scope)&&identifier(id),'草稿编号无效。');return transaction('readonly',(store,tx,done)=>{store.get(key(scope,id)).onsuccess=event=>done(event.target.result||null);});},
  async remove(scope,id,expected){ensure(scopeOK(scope)&&identifier(id),'草稿编号无效。');return transaction('readwrite',(store,tx,done,fail)=>{store.get(key(scope,id)).onsuccess=event=>{const old=event.target.result;if(expected&&old&&(old.updatedAt!==expected.updatedAt||old.payloadHash!==expected.payloadHash)){fail('另一窗口已经更新这份草稿，未删除；请刷新列表。');return;}store.delete(key(scope,id));};});}
};

export function mountCaptureDrafts({root,anchor=null,destination='待保存区',getScope,getItems,restoreItems,validateTarget}){
  const section=document.createElement('details');section.className='panel';section.id='capture-draft-protection';
  section.innerHTML='<summary>本机草稿保护与恢复</summary><label><input id="capture-draft-enabled" type="checkbox">允许在当前浏览器暂存本账号的采集待保存内容（含原图和文字），用于异常退出后恢复。</label><p class="cloud-status">仅存这台电脑的当前浏览器，不等于已写入实验，也不是云端备份。本机 Windows 用户可访问浏览器资料；公用电脑请自行决定是否开启。</p><div class="cloud-actions"><button id="capture-draft-save" class="button secondary">立即暂存 / 重试</button><button id="capture-draft-list" class="button secondary">查找本实验的本机草稿</button></div><p id="capture-draft-status" class="cloud-status" role="status" aria-live="polite"></p><div id="capture-draft-records"></div>';
  (anchor||root.querySelector('#capture-pending')).before(section);
  const element=id=>section.querySelector('#'+id),enabled=element('capture-draft-enabled'),status=element('capture-draft-status');
  let row=crypto.randomUUID(),scopeKey='',revision=0,timer,writing=Promise.resolve(),loading=false;
  const preference=account=>'colorlens-capture-draft-consent:'+account;
  const say=text=>{status.textContent=text;};
  const usable=()=>scopeOK(getScope());
  function controls(){enabled.disabled=!usable();element('capture-draft-save').disabled=!enabled.checked||!usable();element('capture-draft-list').disabled=!usable()||loading;}
  function scopeChanged(){const scope=getScope(),next=(scope?.account||'')+':'+(scope?.entryId||'');if(next!==scopeKey){scopeKey=next;revision++;clearTimeout(timer);row=crypto.randomUUID();element('capture-draft-records').replaceChildren();try{enabled.checked=localStorage.getItem(preference(scope?.account))==='yes';}catch{enabled.checked=false;}say(enabled.checked?'本机草稿保护已开启，接收和编辑后会暂存。':'本机草稿保护尚未开启，待保存内容仅在当前页面。');}controls();}
  async function flush(){
    clearTimeout(timer);scopeChanged();if(!enabled.checked||!usable())return;
    const scope={...getScope()},items=getItems().map(item=>({...item,bytes:item.bytes?new Uint8Array(item.bytes):undefined})),identifier=row,serial=revision;
    say(items.length?'正在暂存本机草稿…':'正在清理本窗口已处理的暂存副本…');
    const next=writing.catch(()=>{}).then(async()=>{if(items.length)await captureDraftStore.write(await snapshotCaptureDraft(items,scope,identifier));else await captureDraftStore.remove(scope,identifier);if(serial===revision)say(items.length?'已暂存 '+items.length+' 项到本浏览器；仍未写入实验。':'本窗口待保存内容已处理，本机暂存副本已清理。');});
    writing=next;try{await next;}catch(error){if(serial===revision){section.open=true;say(error.message);}throw error;}
  }
  function changed(){scopeChanged();revision++;clearTimeout(timer);if(!enabled.checked)return;say('内容已变化，等待本机暂存；此时关闭仍可能丢失最新修改。');timer=setTimeout(()=>void flush().catch(()=>{}),350);}
  enabled.onchange=()=>{revision++;try{localStorage.setItem(preference(getScope()?.account),enabled.checked?'yes':'no');}catch{}controls();if(enabled.checked)void flush().catch(()=>{});else{clearTimeout(timer);say('已关闭后续自动暂存；已有副本仍保留，可在列表中明确删除。');}};
  element('capture-draft-save').onclick=()=>void flush().catch(()=>{});
  async function list(){
    scopeChanged();if(!usable())return;const scope={...getScope()},serial=revision;loading=true;controls();
    try{await validateTarget(scope.entryId);const rows=await captureDraftStore.list(scope);if(scopeKey!==scope.account+':'+scope.entryId)return;const container=element('capture-draft-records');container.replaceChildren();
      for(const item of rows){const card=document.createElement('article');card.className='panel';const label=document.createElement('p');label.textContent=new Date(item.updatedAt).toLocaleString()+' · '+item.count+' 项 · '+Math.ceil(item.size/1024)+' KB'+(item.id===row?' · 本窗口当前暂存':'');const restore=document.createElement('button');restore.className='button secondary';restore.textContent='恢复到'+destination;restore.disabled=item.id===row&&getItems().length>0;const remove=document.createElement('button');remove.className='button secondary';remove.textContent='删除此本机副本';
        restore.onclick=()=>void (async()=>{if(restore.disabled)return;restore.disabled=true;try{if(getItems().length)throw new Error('请先处理本窗口已有内容，再恢复其他副本。');await validateTarget(scope.entryId);const record=await captureDraftStore.read(scope,item.id);if(!record)throw new Error('这份本机草稿已清理或被其他窗口删除，请刷新列表。');const items=await restoreCaptureDraft(record,scope);if(getScope()?.account!==scope.account||getScope()?.entryId!==scope.entryId||getItems().length)throw new Error('目标实验或窗口内容已变化，未恢复。');const notice=await restoreItems(items);say(notice||'已恢复 '+items.length+' 项，请重新核对后确认保存。原暂存副本仍保留，可在保存后删除。');}catch(error){say(error.message);}finally{restore.disabled=item.id===row&&getItems().length>0;}})();
        remove.onclick=()=>void (async()=>{try{if(item.id===row&&getItems().length)throw new Error('这是当前窗口的保护副本，请先处理这些内容。');if(!confirm('只删除这份本机暂存副本？不会删除实验或附件。'))return;await captureDraftStore.remove(scope,item.id,{updatedAt:item.updatedAt,payloadHash:item.payloadHash});await list();}catch(error){say(error.message);}})();
        card.append(label,restore,remove);container.append(card);
      }say(rows.length?'找到 '+rows.length+' 份本机副本。恢复后仍需确认写入实验；其他活动窗口也可能正在使用其副本。':'当前账号的本实验没有本机暂存副本。');
    }catch(error){if(serial===revision)say(error.message);}finally{loading=false;controls();}
  }
  element('capture-draft-list').onclick=()=>void list();
  scopeChanged();return {changed,flush,scopeChanged,enabled:()=>enabled.checked};
}
