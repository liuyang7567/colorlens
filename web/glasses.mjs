import {request,uploadFile,sha} from './transport.mjs';
import {captureProtocol,captureNonce,captureOrigin,captureMessage,captureArchivePart} from './capture-bridge.mjs';
import {mountGuidance} from './guidance.mjs';
import {mountColorTrend} from './color-trend.mjs';
import {mountCaptureDrafts,captureImageType} from './capture-drafts.mjs';

async function readCaptureBitmap(blob){try{return await createImageBitmap(blob);}catch{throw new Error('图片无法读取，可能文件损坏或格式不受浏览器支持。请选择其他原图，原文件未改动。');}}

export function mountGlasses(){
  const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/glasses.css';document.head.append(stylesheet);
  const guidanceStyle=document.createElement('link');guidanceStyle.rel='stylesheet';guidanceStyle.href='/guidance.css';document.head.append(guidanceStyle);
  const page=document.createElement('section');page.id='glasses-page';page.className='workspace-page';page.hidden=true;page.tabIndex=-1;
  page.innerHTML='<div class="dialog-header"><div><div class="eyebrow">GLASSES / FIRST-PERSON LAB NOTES</div><h1>眼镜实验记录</h1></div><a class="button secondary" href="#notebook">返回我的实验</a></div><p class="dialog-description">无线直播在本机窗口查看。只有你确认的截图、原图或转写文字才写入当前账号的实验记录，不持续录像、不自动发送 AI。</p><section class="panel capture-entry-panel"><h2>1. 选择目标实验</h2><div class="cloud-actions"><label>搜索可编辑实验<input id="capture-search" type="search" maxlength="200"></label><button id="capture-search-button" class="button secondary">搜索 / 刷新</button></div><label>当前账号的草稿实验<select id="capture-entry" disabled></select></label><div class="cloud-actions"><button id="capture-prev" class="button secondary" disabled>上一页</button><button id="capture-next" class="button secondary" disabled>下一页</button></div><p id="capture-target-status" class="cloud-status" role="status"></p><label>Windows 本机助手地址<input id="capture-helper" value="http://127.0.0.1:49186" autocomplete="off" spellcheck="false"></label><div class="cloud-actions"><button id="capture-open" class="button primary" disabled>2. 打开本机采集窗口</button><button id="capture-import" class="button secondary" disabled>导入官方 App 导出的原图</button><button id="capture-ai" class="button secondary" disabled>本实验的文字 / 图片 AI</button></div><input id="capture-files" type="file" accept="image/jpeg,image/png,image/webp" multiple hidden><p id="capture-connection" class="cloud-status" role="status" aria-live="polite">请先启动 Windows 接收助手；本页不会直接访问或扫描局域网设备。</p><p class="cloud-warning">视频截图不是原生高清照片；照片导入保留原文件，不代表设备自动同步。多张关键帧可在 AI 助手中明确选择，不是持续视频上传。音频转写在本机窗口处理，文字仍需人工核对。</p></section><section class="capture-review-section"><div class="cloud-actions"><h2>3. 确认后插入正文</h2><button id="capture-discard-all" class="button secondary" disabled>丢弃全部待保存内容</button></div><p id="capture-pending-status" role="status" aria-live="polite">尚无待保存内容。</p><div id="capture-pending" class="capture-review-grid"></div></section>';
  const captureLayout=document.createElement('div');
  captureLayout.className='capture-layout';
  const entryPanel=page.querySelector('.capture-entry-panel');
  entryPanel.before(captureLayout);
  captureLayout.insertAdjacentHTML('beforeend',`<section class="capture-observation" aria-labelledby="capture-observation-title"><div class="capture-observation-heading"><h2 id="capture-observation-title">采集画面</h2><span id="capture-observation-source">待回传</span></div><div class="capture-observation-stage"><p id="capture-observation-empty">实时画面在本机采集窗口查看<br>回传或导入的图片会在这里预览</p><img id="capture-observation-image" alt="最近一张待核对图片" hidden></div></section>`);
  captureLayout.append(entryPanel);
  document.querySelector('main').append(page);
  const navigation=document.createElement('button');navigation.id='nav-glasses';navigation.className='nav-button';navigation.dataset.view='glasses';navigation.textContent='眼镜采集';document.getElementById('nav-ai').after(navigation);
  const mobile=document.createElement('button');mobile.dataset.view='glasses';mobile.textContent='眼镜采集';const mobileNav=document.querySelector('.mobile-nav');mobileNav.insertBefore(mobile,mobileNav.children[1]||null);
  navigation.textContent='眼镜实验记录';mobile.textContent='眼镜记录';
  const toolbar=document.createElement('button');toolbar.id='note-glasses';toolbar.className='button secondary';toolbar.textContent='眼镜采集 / 原图';document.querySelector('.note-toolbar').prepend(toolbar);
  const element=(identifier)=>page.querySelector('#'+identifier),pending=[];
  let selected=null,account=null,session=null,offset=0,sequence=0,renewal=null,watcher=null,saving=false;
  const guidance=mountGuidance({root:page,getEntryId:()=>selected?.id,getCapture:()=>session,queue});window.ColorLensGuidance=guidance;
  const colorTrend=mountColorTrend({root:page,getCapture:()=>session,getEntryId:()=>selected?.id,queue});
  const openColor=document.createElement('button');openColor.className='button secondary';openColor.textContent='实验后：显色复核';page.querySelector('.dialog-header').append(openColor);openColor.onclick=()=>page.querySelector('#color-trend').scrollIntoView({behavior:'smooth',block:'start'});
  const openRecorder=document.createElement('button');openRecorder.className='button primary';openRecorder.textContent='实验前：开启免手动记录';page.querySelector('.dialog-header').append(openRecorder);openRecorder.onclick=()=>element('capture-open').click();
  const notify=(text)=>{element('capture-connection').textContent=text;};
  const safe=(operation)=>Promise.resolve().then(operation).catch(error=>notify(error.message));
  const drafts=mountCaptureDrafts({root:page,getScope:()=>({account,entryId:selected?.id,entryTitle:selected?.data.title}),getItems:()=>pending,validateTarget:async id=>{const entry=await request('/api/notebook/entry/'+id);if(entry.deleted||entry.data.status!=='draft')throw new Error('目标实验已只读或删除，请先恢复为草稿。');},restoreItems:async(items)=>{
    const owner=account,target=selected?.id,restored=[];
    try{for(const item of items){if(item.kind==='image'){const blob=new Blob([item.bytes],{type:captureImageType(item.bytes)}),bitmap=await readCaptureBitmap(blob);const valid=bitmap.width*bitmap.height<=32000000;bitmap.close();if(!valid)throw new Error('草稿原图超过 3200 万像素，未恢复。');restored.push({...item,url:URL.createObjectURL(blob)});}else restored.push(item);}
      if(owner!==account||target!==selected?.id||pending.length)throw new Error('账号、目标实验或待保存区已变化，未恢复。');pending.push(...restored);render();drafts.changed();await drafts.flush();
    }catch(error){for(const item of restored)if(item.url&&!pending.includes(item))URL.revokeObjectURL(item.url);throw error;}
  }});
  function disconnect(text){
    guidance.disconnect();
    colorTrend.disconnect();
    const closing=session;session=null;clearInterval(renewal);clearInterval(watcher);
    if(closing?.source&&!closing.source.closed)closing.source.postMessage({protocol:captureProtocol,nonce:closing.nonce,type:'parent-closing'},closing.origin);
    if(text)notify(text);
  }
  function remove(item){const index=pending.indexOf(item);if(index>=0)pending.splice(index,1);if(item.url)URL.revokeObjectURL(item.url);render();drafts.changed();}
  function clear(preserve=false){for(const item of pending)if(item.url)URL.revokeObjectURL(item.url);pending.length=0;render();if(!preserve)drafts.changed();}
  function render(){
    const preview=pending.findLast(item=>item.kind==='image');
    const image=element('capture-observation-image');
    if(preview)image.src=preview.url;else image.removeAttribute('src');
    image.hidden=!preview;
    element('capture-observation-empty').hidden=Boolean(preview);
    element('capture-observation-source').textContent=preview?'待核对 · '+preview.source:'待回传';
    const list=element('capture-pending');list.replaceChildren();element('capture-discard-all').disabled=!pending.length||saving;
    element('capture-pending-status').textContent=pending.length?`${pending.length} 项仍待确认，尚未全部写入实验记录。${drafts.enabled()?'本机暂存状态见下方草稿保护。':'保存失败会保留本页内容，请勿刷新；可开启本机草稿保护。'}`:'尚无待保存内容。';
    element('capture-entry').disabled=Boolean(pending.length)||!selected;
    for(const item of pending){
      const card=document.createElement('article');card.className='panel capture-review-card';
      const heading=document.createElement('h3');heading.textContent=item.source+' · 待核对';
      const meta=document.createElement('p');meta.className='cloud-status';meta.textContent=(item.recordedAt?(item.kind==='image'?'截图采集：':'音轨采样：')+new Date(item.recordedAt).toLocaleString('zh-CN')+' · 传回：':'')+new Date(item.capturedAt).toLocaleString('zh-CN')+' · 仅待保存区';card.append(heading,meta);
      if(item.kind==='image'){const image=document.createElement('img');image.src=item.url;image.alt=item.source;image.loading='lazy';card.append(image);}
      else if(item.kind==='file'){const description=document.createElement('p');const group=captureArchivePart(item.filename);description.textContent=item.filename+' · '+Math.ceil(item.bytes.length/1024)+' KB，确认后作为实验附件保存。'+(group?.total>1?' 本记录共 '+group.total+' 组，这是第 '+group.number+' 组，请保存全部组才能保留所有照片。':'');const label=document.createElement('label'),review=document.createElement('input');review.type='checkbox';review.checked=Boolean(item.reviewed);label.append(review,document.createTextNode('我已核对目标实验，可以保存本附件。'));review.onchange=()=>{item.reviewed=review.checked;save.disabled=saving||!item.reviewed;};card.append(description,label);}
      else{const editor=document.createElement('textarea');editor.value=item.text;editor.rows=6;editor.maxLength=12000;editor.setAttribute('aria-label','核对并编辑本段语音转写');editor.oninput=()=>{item.text=editor.value;item.reviewed=false;review.checked=false;save.disabled=true;drafts.changed();};const reviewLabel=document.createElement('label'),review=document.createElement('input');review.type='checkbox';review.checked=Boolean(item.reviewed);reviewLabel.append(review,document.createTextNode('我已核对转写中的术语、数值与隐私，可以写入实验记录。'));card.append(editor,reviewLabel);review.onchange=()=>{item.reviewed=review.checked;save.disabled=saving||!item.reviewed;};}
      const actions=document.createElement('div');actions.className='cloud-actions';const save=document.createElement('button');save.className='button primary';save.textContent=item.saved?'已写入正文，移除待保存项':item.uploadId?'继续将已上传图片插入正文':'确认并插入实验正文';save.disabled=saving||['text','file'].includes(item.kind)&&!item.reviewed;save.onclick=()=>safe(()=>saveItem(item));const discard=document.createElement('button');discard.className='button secondary';discard.textContent=item.saved?'完成':'丢弃';discard.disabled=saving;discard.onclick=()=>{if(!item.saved&&item.uploadId&&!confirm('图片可能已上传为此实验的附件，丢弃只移除待保存项，不会删除云端附件。继续吗？'))return;remove(item);};actions.append(save,discard);card.append(actions);
      if(item.error){const error=document.createElement('p');error.className='cloud-warning';error.textContent=item.error;card.append(error);}list.append(card);
    }
  }
  async function saveItem(item){
    if(saving)return;
    if(item.saved){remove(item);return;}
    if(!selected||selected.id!==item.entryId)throw new Error('待保存内容属于原目标实验，请恢复原目标后再保存。');
    if(item.kind==='text'&&(!item.reviewed||!item.text.trim())||item.kind==='file'&&!item.reviewed)throw new Error('请先核对并确认待保存内容。');
    saving=true;item.error='';render();
    try{
      await window.ColorLensNotebook.flush();
      let entry=await request('/api/notebook/entry/'+item.entryId);
      if(entry.deleted||entry.data.status!=='draft')throw new Error('目标实验已只读或删除，请恢复为草稿后重试。');
      const marker='[镜析采集编号：'+item.id+']';
      if(entry.data.body.includes(marker)){item.saved=true;remove(item);return;}
      let addition;
      if(['image','file'].includes(item.kind)){
        const checksum=await sha(item.bytes);
        let file=entry.attachments.find(file=>file.filename===item.filename&&file.sha256===checksum);
        if(!file){const result=await uploadFile(entry,item.filename,item.bytes);entry=result.entry;file=result.file;if(!file)throw new Error('附件已上传但返回信息缺失，请保留本页后重试。');}
        item.uploadId=file.id;
        const group=item.kind==='file'?captureArchivePart(file.filename):null;addition=item.kind==='image'?`\n[[colorlens-image:${file.id}]]\n${item.source.replaceAll('[[','［［')} · ${item.recordedAt?'截图采集：'+item.recordedAt+' · 传回：':'采集/导入时间：'}${item.capturedAt}\n${marker}\n`:`\n${item.source.replaceAll('[[','［［')} · ${item.capturedAt}\n${group?.total>1?'记录分组附件（第 '+group.number+'/'+group.total+' 组，请保留全部组）：':'完整结果已保存为附件：'}${file.filename}（${file.id}）\n${marker}\n`;
      }else addition=`\n${item.source.replaceAll('[[','［［')} · ${item.recordedAt?'音轨采样完成：'+item.recordedAt+' · 传回：':''}${item.capturedAt}\n${item.text.trim()}\n${marker}\n`;
      if(entry.data.body.length+addition.length>100000)throw new Error('实验正文接近长度上限，请先整理或拆分记录；待保存内容仍在。');
      const body=entry.data.body+addition;
      await request('/api/notebook/save',{id:entry.id,revision:entry.revision,data:{...entry.data,body,...item.kind==='image'?{body_format:'inline-images-v1'}:{}}});
      item.saved=true;remove(item);notify('已确认写入目标实验正文，可重新打开核对；没有自动发送给 AI。');
      if(window.ColorLensNotebook.getEntry()?.id===entry.id)await window.ColorLensNotebook.openEntry(entry.id);
    }catch(error){
      try{const current=await request('/api/notebook/entry/'+item.entryId);if(current.data.body.includes('[镜析采集编号：'+item.id+']')){item.saved=true;remove(item);notify('已核对服务器：这项内容已经保存，没有重复插入。');return;}}catch{}
      item.error=error.message+' 待保存内容仍在本页；重试会核对附件与采集编号，不重复插入。';
    }finally{saving=false;render();}
  }
  async function queue(item){
    if(!selected||item.entryId&&selected.id!==item.entryId){if(item.url)URL.revokeObjectURL(item.url);throw new Error('目标实验已变化，请重新采集。');}
    const previous=pending.find(current=>current.id===item.id);if(previous){if(item.url)URL.revokeObjectURL(item.url);if(item.receiptHash&&previous.receiptHash&&item.receiptHash!==previous.receiptHash)throw new Error('同一采集编号的内容已变化，请作为新内容重新传回。');await drafts.flush();notify('此项已在待保存区，没有重复添加。');return;}
    if(pending.length>=10||pending.reduce((total,current)=>total+(current.bytes?.length||0),0)+(item.bytes?.length||0)>32*1048576){if(item.url)URL.revokeObjectURL(item.url);throw new Error('待保存区最多 10 项/32 MB，请先保存或丢弃已有内容。');}
    item.entryId=selected.id;pending.push(item);render();drafts.changed();await drafts.flush();notify('收到新的待保存内容，请核对后逐项确认；尚未上传。');
  }
  async function list(preferred){
    const serial=++sequence;const result=await request('/api/notebook?status=draft&offset='+offset+'&q='+encodeURIComponent(element('capture-search').value));if(serial!==sequence)return;
    const selector=element('capture-entry'),entries=result.entries.filter(entry=>entry.data.status==='draft'&&!entry.deleted);selector.replaceChildren();
    if(preferred&&!entries.some(entry=>entry.id===preferred)){const entry=await request('/api/notebook/entry/'+preferred);if(!entry.deleted&&entry.data.status==='draft')entries.unshift(entry);}
    for(const entry of entries){const option=document.createElement('option');option.value=entry.id;option.textContent=entry.data.title;selector.append(option);}
    if(preferred&&entries.some(entry=>entry.id===preferred))selector.value=preferred;
    else if(selected&&entries.some(entry=>entry.id===selected.id))selector.value=selected.id;
    if(!pending.length)selected=entries.find(entry=>entry.id===selector.value)||null;
    selector.disabled=!entries.length||Boolean(pending.length);if(pending.length&&selected)selector.value=selected.id;
    element('capture-open').disabled=!selected;element('capture-import').disabled=!selected;element('capture-ai').disabled=!selected;
    element('capture-prev').disabled=offset===0;element('capture-next').disabled=offset+result.entries.length>=result.total;
    element('capture-target-status').textContent=selected?'当前目标：'+selected.data.title+'。待保存内容存在时不会悄悄切换目标。':'没有可编辑实验，请先新建一条实验记录。';
    await guidance.select(selected?.id||null);
    drafts.scopeChanged();
  }
  async function authorise(active){
    const issued=await request('/api/capture/ticket',{id:active.entryId,nonce:active.nonce});
    if(session!==active||active.source.closed)return;
    if(active.userId&&issued.user_id!==active.userId)throw new Error('登录账号已变化，采集窗口已关闭。');
    active.userId=issued.user_id;active.expiresAt=issued.expires_at;active.ticket=issued.ticket;
    active.source.postMessage({protocol:captureProtocol,nonce:active.nonce,type:'authorise',ticket:issued.ticket},active.origin);
  }
  element('capture-open').onclick=()=>{void safe(async()=>{
    if(!selected)throw new Error('请先选择目标实验。');const origin=captureOrigin(element('capture-helper').value.trim());disconnect();
    const source=window.open('about:blank','_blank','popup,width=1240,height=980');if(!source)throw new Error('浏览器阻止了窗口，请允许本次用户主动打开的采集窗口。');
    try{await window.ColorLensNotebook.flush();const nonce=captureNonce();session={source,origin,nonce,entryId:selected.id,userId:null,expiresAt:Date.now()+600000,seen:new Set()};const active=session;const issued=await request('/api/capture/ticket',{id:active.entryId,nonce});if(source.closed)throw new Error('采集窗口已关闭。');active.ticket=issued.ticket;active.userId=issued.user_id;active.expiresAt=issued.expires_at;const target=new URL('/capture.html',origin);target.searchParams.set('parent',location.origin);target.hash=nonce;source.location=target.href;notify('正在打开本机助手。若未启动，请先运行新版采集助手，再重试。');renewal=setInterval(()=>{void authorise(active).catch(error=>disconnect(error.message));},240000);watcher=setInterval(()=>{if(session===active&&(source.closed||Date.now()>=active.expiresAt))disconnect('采集窗口已关闭或授权已过期；待保存内容仍保留。');},1000);}catch(error){source.close();disconnect();throw error;}
  });};
  window.addEventListener('message',event=>{void safe(async()=>{
    const active=session,message=captureMessage(event,active);if(!message)return;
    if(message.type==='ready'){active.source.postMessage({protocol:captureProtocol,nonce:active.nonce,type:'authorise',ticket:active.ticket},active.origin);notify('本机窗口来源已校验，正在核对账号与实验授权。');return;}
    if(message.type==='closed'){disconnect('采集窗口已关闭；待保存内容没有自动上传。');return;}
    if(message.type==='observation-unavailable'){guidance.receive(message);colorTrend.receive(message);return;}
    const target=()=>{if(session!==active||!selected||active.entryId!==selected.id)throw new Error('目标实验已改变，未接收这项内容，请重新配对。');};
    if(message.type==='observation'){target();const bitmap=await createImageBitmap(new Blob([message.image],{type:'image/jpeg'})),valid=bitmap.width===message.width&&bitmap.height===message.height;bitmap.close();target();if(!valid)throw new Error('观察截图尺寸不匹配。');guidance.receive(message);colorTrend.receive(message);return;}
    const reply=(accepted,text)=>{try{active.source.postMessage({protocol:captureProtocol,nonce:active.nonce,type:'transfer-result',requestId:message.id,accepted,message:String(text).slice(0,300)},active.origin);}catch{}};
    const fingerprint=value=>sha(new TextEncoder().encode(JSON.stringify(value)));
    try{
      target();
      if(message.type==='archive'){
        const bytes=new Uint8Array(message.archive),checksum=await sha(bytes);if(checksum!==message.sha256)throw new Error('资料包校验失败，请重新传入。');target();const key=checksum.slice(0,32),id=[key.slice(0,8),key.slice(8,12),key.slice(12,16),key.slice(16,20),key.slice(20)].join('-');await queue({kind:'file',id,entryId:active.entryId,source:message.source,capturedAt:message.capturedAt,bytes,filename:message.filename,receiptHash:checksum,reviewed:false});
      }else if(message.type==='frame'){
        const bytes=new Uint8Array(message.image),blob=new Blob([bytes],{type:'image/jpeg'}),bitmap=await readCaptureBitmap(blob),valid=bitmap.width===message.width&&bitmap.height===message.height;bitmap.close();if(!valid)throw new Error('截图尺寸校验失败，未接收。');const checksum=await sha(bytes),receiptHash=await fingerprint(['frame',checksum,message.width,message.height,message.recordedAt||null,message.source]);target();const id=message.captureId||message.id;await queue({kind:'image',id,entryId:active.entryId,source:message.source,capturedAt:message.capturedAt,recordedAt:message.recordedAt,bytes,url:URL.createObjectURL(blob),filename:'眼镜截帧-'+id+'.jpg',receiptHash});
      }else{
        const receiptHash=await fingerprint(['transcript',message.text,message.recordedAt||null,message.source]);target();await queue({kind:'text',id:message.captureId||message.id,entryId:active.entryId,source:message.source,capturedAt:message.capturedAt,recordedAt:message.recordedAt,text:message.text,receiptHash,reviewed:false});
      }
      target();reply(true,'已进入「'+selected.data.title+'」的待保存区，仍需核对并确认保存。');
    }catch(error){reply(false,error.message);throw error;}
  });});
  element('capture-import').onclick=()=>element('capture-files').click();
  element('capture-files').onchange=()=>{void safe(async()=>{try{for(const file of element('capture-files').files){if(!selected||!file.size||file.size>20*1048576||!/\.(jpe?g|png|webp)$/i.test(file.name))throw new Error('原图请选择 20 MB 以内的 JPEG、PNG 或 WebP。');const bytes=new Uint8Array(await file.arrayBuffer());const mime=bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10'?'image/png':new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'?'image/webp':null;if(!mime)throw new Error('文件内容不是支持的原图类型。');const blob=new Blob([bytes],{type:mime}),bitmap=await readCaptureBitmap(blob);const valid=bitmap.width*bitmap.height<=32000000;bitmap.close();if(!valid)throw new Error('原图超过 3200 万像素，请另选图片；原文件未修改。');await queue({kind:'image',id:crypto.randomUUID(),source:'官方 App 导出原图（用户选择，拍摄时间未验证）',capturedAt:new Date().toISOString(),bytes,url:URL.createObjectURL(blob),filename:file.name});}}finally{element('capture-files').value='';}});};
  element('capture-entry').onchange=()=>{void safe(async()=>{if(pending.length){element('capture-entry').value=selected.id;throw new Error('请先保存或丢弃原实验的待保存内容，再切换目标。');}disconnect('目标实验已切换，请重新打开采集窗口。');selected=await request('/api/notebook/entry/'+element('capture-entry').value);await guidance.select(selected.id);drafts.scopeChanged();});};
  element('capture-discard-all').onclick=()=>{if(confirm('丢弃全部未保存内容？已上传的附件不会因此删除。')){clear();void safe(()=>list(selected?.id));}};
  element('capture-search-button').onclick=()=>{offset=0;void safe(()=>list(selected?.id));};element('capture-prev').onclick=()=>{offset=Math.max(0,offset-40);void safe(()=>list(selected?.id));};element('capture-next').onclick=()=>{offset+=40;void safe(()=>list(selected?.id));};
  element('capture-ai').onclick=()=>{void safe(()=>window.ColorLensNotebook.openPage('ai',selected.id));};
  toolbar.onclick=()=>{void safe(()=>window.ColorLensNotebook.openPage('glasses',window.ColorLensNotebook.getEntry()?.id));};navigation.onclick=mobile.onclick=()=>{void safe(()=>window.ColorLensNotebook.openPage('glasses'));};
  window.addEventListener('beforeunload',event=>{if(pending.length||saving){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',()=>{const active=session;if(active?.source&&!active.source.closed)active.source.postMessage({protocol:captureProtocol,nonce:active.nonce,type:'parent-closing'},active.origin);});
  setInterval(()=>{guidance.connected();colorTrend.connected();},2000);
  navigation.textContent='眼镜实验记录';mobile.textContent='眼镜记录';toolbar.textContent='眼镜实验记录';page.querySelector('h1').textContent='眼镜实验记录';page.querySelector('.dialog-description').textContent='实验前在电脑选好实验并开启免手动记录，手机只需完成官方 App 开播。实验中用眼镜口令拍照和标记；结束后在电脑核对时间线、照片和显色结果。';
  return {async open(preferred){await list(preferred||selected?.id);render();},onAccount(user){const identity=user?.id||user?.email;if(account&&account!==identity){disconnect();guidance.reset();colorTrend.reset();clear(true);selected=null;}account=identity;drafts.scopeChanged();},confirmExit(){if(pending.length&&!confirm(drafts.enabled()?'仍有尚未写入实验的内容。只有显示“已暂存”的修改可从本浏览器恢复，请核对暂存状态后再退出，确定继续吗？':'仍有未保存的采集内容，退出将丢失本机待保存区。确定退出吗？'))return false;if(!colorTrend.confirmExit())return false;disconnect();clear(true);return true;}};
}
