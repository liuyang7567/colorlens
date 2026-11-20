import {request,uploadFile,getBytes,saveBlob,sha,unbase64} from './transport.mjs';
import {downloadAnalysis,downloadNotebook,importBackup} from './archives.mjs';
import {analyzePixels} from '../src/photo.mjs';
import {mountAccounts} from './accounts.mjs';
import {motionButton} from './motion.mjs';
import {mountAnalysisView} from './analysis-view.mjs';
import {mountWorkspacePages} from './pages.mjs';
import {mountQpcr} from './qpcr.mjs';
import {mountTemplates} from './templates.mjs';
import {mountElisa} from './elisa.mjs';
import {mountTeams} from './teams.mjs';
import {mountSamples} from './samples.mjs';
import {mountInventory} from './inventory.mjs';
import {mountEquipment} from './equipment.mjs';
import {mountCollaboration} from './collaboration.mjs';
import {mountInteroperability} from './interoperability.mjs';
import {mountAiWorkspace} from './ai-workspace.mjs';
import {mountGlasses} from './glasses.mjs';
import {notebookDataMatches} from '../src/notebook.mjs';

window.COLORLENS={runtime:'web',token:'',version:'0.10.0-preview.19'};
const element=id=>document.getElementById(id);
const safe=operation=>Promise.resolve().then(operation).catch(error=>window.toast?toast(error.message,true):alert(error.message));
let resolveReady,asset=null,aiPrepared=null,aiParent=null,lastAi=null;
const ready=new Promise(resolve=>{resolveReady=resolve;});
const notify=message=>{if(window.toast)toast(message);};
const bytesBlob=async id=>new Blob([await getBytes(id)]);

async function loadImage(bytes,filename,simulated=false) {
  if (!bytes.length || bytes.length>20*1048576) throw new Error('请选择 20 MB 以内的静态实验照片。');
  if (asset) URL.revokeObjectURL(asset.image_url);
  let mime;
  if (bytes[0]===255&&bytes[1]===216) mime='image/jpeg';
  else if (bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10') mime='image/png';
  else if (new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP') mime='image/webp';
  else throw new Error('只支持 JPEG、PNG、WebP。');
  const animation= mime==='image/png' && new TextDecoder('latin1').decode(bytes).includes('acTL') || mime==='image/webp' && Boolean(bytes[20]&2) && new TextDecoder().decode(bytes.slice(12,16))==='VP8X';
  if(animation) throw new Error('请选择静态图片，不支持动画。');
  const url=URL.createObjectURL(new Blob([bytes],{type:mime})),image=new Image();
  image.src=url;
  try { await image.decode(); } catch { URL.revokeObjectURL(url);throw new Error('无法解码照片，文件可能已损坏。'); }
  if (image.naturalWidth*image.naturalHeight>32000000) {URL.revokeObjectURL(url);throw new Error('照片超过 3200 万像素，请先缩小。');}
  const surface=document.createElement('canvas');surface.width=image.naturalWidth;surface.height=image.naturalHeight;
  const context=surface.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'});context.drawImage(image,0,0);
  const imageData=context.getImageData(0,0,surface.width,surface.height);
  for (let position=3;position<imageData.data.length;position+=4) if(imageData.data[position]!==255){URL.revokeObjectURL(url);throw new Error('图片包含透明像素，请使用带完整背景的照片。');}
  asset={image_id:crypto.randomUUID(),image_url:url,image:{filename:filename.replaceAll('\\','/').split('/').at(-1).slice(0,160),width:surface.width,height:surface.height,sha256:await sha(bytes),has_icc_profile:false,color_interpretation:'浏览器 sRGB Canvas'},simulated,bytes,surface,pixels:imageData.data};
  return {...asset,bytes:undefined,surface:undefined,pixels:undefined};
}
async function attachBase64(payload) {
  const entry=await request('/api/notebook/entry/'+payload.id);
  if (entry.revision!==payload.revision) throw new Error('记录已更新，请保留输入后刷新。');
  return (await uploadFile(entry,payload.filename,unbase64(payload.data))).entry;
}
async function cloudApi(path,payload) {
  if(path==='/api/demo') {
    const response=await fetch('/samples/simulated_tubes_5.png');
    if(!response.ok) throw new Error('模拟图片未载入。');
    const data=await loadImage(new Uint8Array(await response.arrayBuffer()),'SIMULATED-tubes.png',true);
    return {...data,rois:Array.from({length:5},(_,index)=>({id:'R'+(index+1),label:index?'样本 '+(index+1):'对照组',role:index?'sample':'control',x:225+index*247-34,y:410,w:68,h:180})),control_id:'R1'};
  }
  if(path==='/api/import') return loadImage(unbase64(payload.data),payload.filename,payload.simulated);
  if(path==='/api/mark-simulated') {if(!asset)throw new Error('请先载入照片。');asset.simulated=true;return {simulated:true};}
  if(path==='/api/analyze') {
    if(!asset||payload.image_id!==asset.image_id)throw new Error('照片已变更，请重新载入。');
    await new Promise(resolve=>setTimeout(resolve,0));
    const result=analyzePixels(asset.image.width,asset.image.height,asset.pixels,payload.rois,payload.control_id,payload.parameters,asset.simulated,asset.image);
    const data=await request('/api/assays');
    const assay=data.assays.find(item=>item.id===(payload.assay_id||'generic'));
    if(!assay?.photo_allowed)throw new Error('所选方法需要仪器读数，照片不能替代吸光度。');
    return {...result,assay};
  }
  if(path==='/api/notebook/attach') return attachBase64(payload);
  if(path==='/api/notebook/photo') {
    const entry=window.ColorLensNotebook.getEntry(),file=entry.attachments.find(item=>item.id===payload.attachment_id);
    if(!file)throw new Error('附件不属于当前实验。');
    const data=await loadImage(await getBytes(file.id),file.filename,payload.simulated);asset.attachment_id=file.id;
    return data;
  }
  if(path==='/api/export') {
    if(!asset||asset.image_id!==payload.image_id)throw new Error('照片已变更，请重新载入。');
    if(!confirm('保存分析会将当前原图与标注图上传到你自己的云端账号。不发送给 DeepSeek。继续吗？'))throw new Error('已取消上传，照片仍只在当前浏览器。');
    let entry=payload.entry_id?await request('/api/notebook/entry/'+payload.entry_id):await request('/api/notebook/create',{data:{title:payload.experiment.name,tags:asset.simulated?['模拟数据']:[]}});
    if(payload.entry_id && entry.revision!==payload.entry_revision)throw new Error('实验已更新，请保留输入后刷新。');
    const result=await cloudApi('/api/analyze',payload);
    let originalId=asset.attachment_id;
    if(!entry.attachments.some(item=>item.id===originalId)) {
      const uploaded=await uploadFile(entry,asset.image.filename,asset.bytes);entry=uploaded.entry;originalId=uploaded.file.id;
    }
    const annotated=await new Promise(resolve=>document.getElementById('specimen-canvas').toBlob(resolve,'image/png'));
    if(!annotated)throw new Error('标注图生成失败。');
    const uploaded=await uploadFile(entry,'annotated-'+Date.now()+'.png',new Uint8Array(await annotated.arrayBuffer()));entry=uploaded.entry;
    const saved=await request('/api/analysis/photo',{...payload,entry_id:entry.id,entry_revision:entry.revision,result,original_attachment_id:originalId,annotated_attachment_id:uploaded.file.id});
    asset.attachment_id=originalId;
    return saved;
  }
  if(path==='/api/restore') {
    const record=await request(path,payload);
    if(record.analysis_type==='instrument')return record;
    const reuse=asset?.attachment_id===record.original_attachment_id&&asset.image.sha256===record.result.image.sha256&&asset.simulated===record.result.simulated;
    const data=reuse?{...asset,bytes:undefined,surface:undefined,pixels:undefined}:await loadImage(await getBytes(record.original_attachment_id),record.result.image.filename,record.result.simulated);
    if(data.image.sha256!==record.result.image.sha256)throw new Error('原图完整性校验失败，已停止复核。');
    asset.attachment_id=record.original_attachment_id;
    return {...data,...record.photo_input,experiment:record.experiment,mode:record.mode};
  }
  if(path==='/api/notebook/restore') {
    if(!confirm('导入会上传所选 ZIP 的实验文字、原件与来源历史，在本账号创建新副本，不覆盖旧记录。相同备份重复选择会产生副本。继续吗？'))throw new Error('已取消导入。');
    return importBackup(unbase64(payload.data),message=>{element('note-backup-status').textContent=message;});
  }
  return request(path,payload);
}

async function download(path,filename) {
  const status=message=>{element('note-backup-status').textContent=message;};
  if(path==='/api/notebook/backup') return downloadNotebook(null,filename,status);
  if(path.startsWith('/api/notebook/export/'))return downloadNotebook(path.split('/').at(-1),filename,status);
  throw new Error('未知导出类型。');
}
window.ColorLensCloud={ready,api:cloudApi,download,notebookDataMatches};

function dialog(id,title,html) {
  const node=document.createElement('dialog');node.id=id;node.className='cloud-dialog';
  node.innerHTML=`<div class="dialog-header"><h2>${title}</h2><button class="icon-button" type="button" aria-label="关闭">×</button></div>${html}`;
  node.querySelector('.icon-button').onclick=()=>node.close();document.body.append(node);return node;
}
function updateCloudLabels() {
  document.querySelector('#analysis-view .page-heading h1').firstChild.textContent='实验分析工作台';
  document.querySelector('#analysis-view .page-heading p').textContent='照片颜色比较、仪器读数整理，以及 qPCR / RT-qPCR 表达量计算。';
  document.querySelector('.method-heading p').textContent='保留原有 18 个参考模板与通用比较，新增 qPCR / RT-qPCR 多方法分析';
  document.querySelector('.analysis-type small').textContent='Notebook + assay references + qPCR';
  document.querySelector('.workspace-label span').textContent='CLOUD';
  document.querySelector('.tiny-label').textContent='你的私有联网实验空间';
  document.querySelector('.mini-badge').textContent='V0.10';
  document.querySelector('.version').textContent='V0.10 · HANDS-FREE LAB NOTES';
  document.querySelector('.privacy-label').textContent='账号私有 · 主动分享';
  document.querySelector('.sidebar-footer').firstChild.after(document.createTextNode('云端保存 · 浏览器计算'));
  document.querySelector('.sidebar-footer').childNodes.forEach(node=>{if(node.nodeType===Node.TEXT_NODE&&node.textContent.includes('本机离线处理'))node.textContent='';});
  document.querySelector('.notebook-footer span:last-child').textContent='云端私有保存 · AI 按次确认 · 非临床用途';
  document.querySelector('.page-footer span:last-child').textContent='联网试用版 · 非临床用途';
  document.querySelector('#notebook-guide-dialog .guide-warning').textContent='正式联网部署的笔记和附件保存在独立 Cloudflare 云端；V0.5 本机验收版保存在当前 Windows 用户的独立测试库。记录默认仅本人可见。AI 只发送预览并确认的文字、统计与单独授权的已选图片。不自动发送其他附件、持续视频或音频。不要上传受试者身份、临床病历或未获授权数据。历史、哈希和 AI 结果不是合规电子签名。重要资料请定期离线备份。';
  document.querySelectorAll('#note-backup-dialog .dialog-description').forEach((node,index)=>{node.textContent=[
    '联网版与旧本地版分开，旧 D 盘数据不会自动上传或改动。导出仅包含当前账号资料；ZIP 中可能有敏感实验信息，请妥善保存。',
    '支持镜析 V0.3 / V0.4 ZIP。导入为新副本：正文图片保留；原始时间线追加到讨论，历史、AI 与原分析保存在“导入来源”附件中，不伪装成新版本的原生历史。相同 ZIP 重复导入会生成副本；中断后请检查已导入记录。ZIP ≤128 MB、展开 ≤256 MB。',
    '试用限额：每人附件 50 MB、文字与历史 10 MB；全站附件 150 MB、文字与历史 40 MB。达到限制会拒绝新写入，不自动删除资料，不自动开通付费套餐。可导出后联系管理员扩容。'
  ][index]||'';});
  element('note-import-legacy').hidden=true;
  element('note-backup-import').textContent='导入镜析 ZIP 为新副本';
  document.querySelector('.note-events-panel .note-hint').textContent='服务器记录时间 · 北京时间显示';
  document.querySelector('#note-backup-dialog label').firstChild.textContent='当前私有云端空间';
  document.querySelector('#export-dialog .saved-path-label').firstChild.textContent='云端记录位置';
  document.querySelector('#records-dialog .dialog-description').textContent='点击“在线查看”直接阅读已保存结果，不下载 ZIP、不自动加载原图。需要复核或备份时再主动选择。';
}
function accepted(result) {
  window.COLORLENS.token=result.csrf;
  window.COLORLENS.user=result.user;window.ColorLensGlasses?.onAccount(result.user);
  resolveReady();
}
function outputAi(container,result) {
  container.replaceChildren();
  const labels={summary:'摘要 · AI 草稿',evidence:'提供的事实与依据',issues:'异常与注意事项',hypotheses:'待验证原因假设',next_steps:'下一步验证建议',report_draft:'实验报告草稿',missing_info:'还缺哪些信息'};
  for(const [key,title] of Object.entries(labels)){
    const value=result[key];if(!value || Array.isArray(value)&&!value.length)continue;
    const heading=document.createElement('h3');heading.textContent=title;container.append(heading);
    if(Array.isArray(value)){const list=document.createElement('ul');for(const item of value){const row=document.createElement('li');row.textContent=item;list.append(row);}container.append(list);}
    else{const paragraph=document.createElement('p');paragraph.textContent=value;container.append(paragraph);}
  }
}
function aiUi() {
  const button=document.createElement('button');button.id='note-ai';button.className='button primary';button.textContent='✧ DeepSeek AI 分析';document.querySelector('.note-toolbar').prepend(button);
  const view=dialog('ai-dialog','DeepSeek · 实验复盘助手',`<div class="cloud-warning">AI 不是仪器。照片不换算 OD / 浓度，技术重复不等于生物学重复，原因分析仅是待验证假设。AI 草稿单独保存，不自动写入原始笔记。</div><p class="cloud-status" id="ai-quota"></p><label>本次需要什么帮助<select id="ai-task"><option value="full">完整复盘：解释＋异常＋原因假设＋下一步＋报告草稿</option><option value="interpret">结果解释</option><option value="anomaly">异常检查</option><option value="failure">失败原因假设</option><option value="next">下一步建议</option><option value="report">实验报告草稿</option><option value="chat">针对已选 AI 回复追问</option></select></label><label>选择本次允许发送的文字字段</label><div id="ai-fields" class="cloud-checks">${Object.entries({title:'标题',body:'正文',purpose:'目的',materials:'材料试剂',procedure:'步骤',results:'结果',discussion:'讨论'}).map(([key,title])=>`<label><input type="checkbox" value="${key}" checked>${title}</label>`).join('')}</div><label>选择本实验的数值分析快照（最多 3 个）</label><div id="ai-analyses" class="cloud-checks"></div><label>问题或补充说明（可选）<textarea id="ai-question" rows="3" maxlength="2000" placeholder="例如：重复孔差异较大，先检查哪些环节？请不要输入个人身份信息。"></textarea></label><div class="cloud-actions"><button class="button secondary" id="ai-preview">1. 预览本次发送内容</button></div><pre id="ai-preview-content" hidden></pre><label class="cloud-consent"><input type="checkbox" id="ai-consent">我确认上方所选文字与统计可发送给 DeepSeek，未包含敏感身份或未授权资料；本次不发送照片、其他附件、其他实验或密码。</label><div class="cloud-actions"><button class="button primary" id="ai-send" disabled>2. 确认发送并分析</button><button class="button secondary" id="ai-download" hidden>下载 AI 草稿与来源</button></div><p id="ai-status" class="cloud-status" role="status"></p><div id="ai-output" class="ai-output" hidden></div><h3>本实验的 AI 记录</h3><div id="ai-history"></div>`);
  const source=document.createElement('p');source.id='ai-source';source.className='cloud-status';view.querySelector('.dialog-header').after(source);
  const imageLabel=document.createElement('p');imageLabel.textContent='选择本实验允许发送给 DeepSeek 的图片（最多 3 张，单张 4 MB、合计 8 MB；默认不选）';
  const imageList=document.createElement('div');imageList.id='ai-images';imageList.className='cloud-checks';
  element('ai-question').closest('label').before(imageLabel,imageList);
  const imageConsent=document.createElement('label');imageConsent.className='cloud-consent';
  const imageCheckbox=document.createElement('input');imageCheckbox.type='checkbox';imageCheckbox.id='ai-image-consent';
  imageConsent.append(imageCheckbox,document.createTextNode('我单独同意把勾选的图片原文件发送给 DeepSeek，已检查隐私和实验资料授权；未选择图片时不需要勾选。'));
  element('ai-consent').closest('label').before(imageConsent);
  for(const node of element('ai-consent').parentElement.childNodes)if(node.nodeType===Node.TEXT_NODE)node.textContent='我确认本次预览的文字与统计可以发送给 DeepSeek；只发送本次选择的内容，不发送其他实验或密码。图片需要另行勾选授权。';
  let busy=false,opening=false;
  const invalidate=()=>{aiPrepared=null;element('ai-consent').checked=false;imageCheckbox.checked=false;element('ai-send').disabled=true;element('ai-preview-content').hidden=true;};
  for(const id of ['ai-task','ai-fields','ai-analyses','ai-images','ai-question'])element(id).addEventListener('input',invalidate);
  const updateConsent=()=>{element('ai-send').disabled=!aiPrepared||!element('ai-consent').checked||Boolean(aiPrepared.image_ids.length&&!imageCheckbox.checked)||busy;};
  element('ai-consent').onchange=updateConsent;imageCheckbox.onchange=updateConsent;
  function selected(){const entry=window.ColorLensNotebook.getEntry();return {id:entry.id,revision:entry.revision,task:element('ai-task').value,fields:[...element('ai-fields').querySelectorAll('input:checked')].map(input=>input.value),analysis_ids:[...element('ai-analyses').querySelectorAll('input:checked')].map(input=>input.value),image_ids:[...imageList.querySelectorAll('input:checked')].map(input=>input.value),question:element('ai-question').value,parent_id:aiParent};}
  async function historyAi(){const entry=window.ColorLensNotebook.getEntry(),result=await request('/api/ai/list',{id:entry.id}),list=element('ai-history');list.replaceChildren();
    for(const run of result.items){const row=document.createElement('article');row.className='ai-run';const title=document.createElement('strong');title.textContent=run.status==='complete'?'AI 草稿':run.status==='failed'?'调用失败':'请求处理中 / 中断（请勿立即重复付费请求）';const meta=document.createElement('small');meta.textContent=`${run.model} · 原记录版本 ${run.revision} · ${run.created_at} · 输入 ${run.input_hash.slice(0,12)}`;row.append(title,meta);
      if(run.status==='complete'){const show=document.createElement('button');show.className='text-button';show.textContent='查看并追问';show.onclick=()=>{lastAi={...run,result:JSON.parse(run.result)};aiParent=run.id;outputAi(element('ai-output'),lastAi.result);element('ai-output').hidden=false;element('ai-download').hidden=false;element('ai-task').value='chat';invalidate();element('ai-status').textContent='已选上一条 AI 回复作为追问上下文。重新预览后才会发送。';};row.append(show);}else if(run.status==='failed'){const error=document.createElement('p');try{error.textContent=JSON.parse(run.result).error;}catch{error.textContent='调用失败，原记录未修改。';}row.append(error);}list.append(row);}
  }
  async function quota(){const result=await request('/api/ai/status',{});element('ai-quota').textContent=`${result.model} · 当前账号今日 ${result.user_used}/${result.user_limit} 次 · 全站 ${result.global_used}/${result.global_limit} 次（UTC 日期）${result.configured?'':' · 尚未配置密钥'}`;}
  button.onclick=()=>safe(async()=>{
    if(busy||opening)return;opening=true;
    try{
      await window.ColorLensNotebook.flush();const entry=window.ColorLensNotebook.getEntry();if(!entry)throw new Error('请先打开一条实验。');
      invalidate();aiParent=null;lastAi=null;source.textContent='当前实验：'+entry.data.title+' · 版本 '+entry.revision;element('ai-output').hidden=true;element('ai-download').hidden=true;element('ai-question').value='';element('ai-task').value='full';element('ai-status').textContent='正在读取服务状态与本实验的 AI 历史，尚未发送资料。';element('ai-quota').textContent='';element('ai-history').replaceChildren();element('ai-preview').disabled=true;element('ai-analyses').replaceChildren();
      for(const item of entry.analyses){const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=item.record_id;label.append(checkbox,document.createTextNode(item.record_id.slice(0,12)+' · '+item.created_at.slice(0,10)));element('ai-analyses').append(label);}
      imageList.replaceChildren();
      for(const item of entry.attachments.filter(file=>/\.(jpe?g|png|webp)$/i.test(file.filename))){const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=item.id;label.append(checkbox,document.createTextNode(item.filename+' · '+(item.size/1048576).toFixed(2)+' MB'));imageList.append(label);}
      if(!imageList.childElementCount)imageList.textContent='这条实验暂无图片附件；不会发送图片。';
      view.showModal();await Promise.all([quota(),historyAi()]);element('ai-status').textContent='选择内容后先预览，再授权发送。打开助手本身不调用 DeepSeek。';
    }catch(error){if(view.open)element('ai-status').textContent='服务或历史读取失败：'+error.message+' 可关闭后重试；尚未发送资料。';else throw error;}
    finally{opening=false;element('ai-preview').disabled=false;}
  });
  element('ai-preview').onclick=()=>safe(async()=>{await window.ColorLensNotebook.flush();const payload=selected();const prepared=await request('/api/ai/preview',payload);aiPrepared={...payload,preview_hash:prepared.preview_hash};element('ai-preview-content').textContent=JSON.stringify(prepared.context,null,2);element('ai-preview-content').hidden=false;element('ai-consent').checked=false;element('ai-send').disabled=true;element('ai-status').textContent='以上就是本次发送的完整上下文。请检查后勾选确认。';});
  element('ai-send').onclick=async()=>{
    if(!aiPrepared||!element('ai-consent').checked||busy)return;
    busy=true;element('ai-send').disabled=true;element('ai-preview').disabled=true;element('ai-status').textContent='正在请求 DeepSeek（通常几十秒），请勿重复点击。原始记录保持不变。';
    try{lastAi=await request('/api/ai/run',{...aiPrepared,consent:true,image_consent:imageCheckbox.checked});aiParent=lastAi.id;outputAi(element('ai-output'),lastAi.result);element('ai-output').hidden=false;element('ai-download').hidden=false;element('ai-status').textContent=`AI 草稿已独立保存 · ${lastAi.model} · 原记录版本 ${lastAi.revision}。请人工核对；需要采纳时可复制文字。`;invalidate();}
    catch(error){element('ai-status').textContent=error.message;}
    finally{busy=false;element('ai-preview').disabled=false;await Promise.all([quota(),historyAi()]).catch(()=>{});}
  };
  view.addEventListener('cancel',event=>{if(busy)event.preventDefault();});view.querySelector('.icon-button').onclick=()=>{if(!busy)view.close();};
  element('ai-download').onclick=()=>{if(lastAi)saveBlob(new Blob([JSON.stringify({notice:'AI 草稿，非原始实验结论；请人工核对。',...lastAi},null,2)],{type:'text/plain;charset=utf-8'}),'ColorLens-AI-'+lastAi.id+'.txt');};
}
function shareUi() {
  const button=document.createElement('button');button.id='note-share';button.className='button secondary';button.textContent='只读分享';document.querySelector('.note-toolbar').prepend(button);
  const view=dialog('share-dialog','主动分享 · 可撤销快照',`<p class="cloud-warning">链接持有者可以查看本次笔记与全部原始附件。链接可能被转发，撤销也不能收回已经下载的副本。不含 AI 草稿、修改历史或其他实验；创建后不随正文更新。确认有权分享后再继续。</p><label>有效时间<select id="share-days"><option value="1">1 天</option><option value="7" selected>7 天</option><option value="30">30 天</option></select></label><label class="cloud-consent"><input type="checkbox" id="share-consent">我有权分享此记录及其全部附件，已检查敏感信息。</label><button class="button primary" id="share-create">生成只读链接</button><pre id="share-output" hidden></pre><div id="share-list"></div><p id="share-status" role="status"></p>`);
  async function list(){const entry=window.ColorLensNotebook.getEntry(),result=await request('/api/shares/list',{id:entry.id});const target=element('share-list');target.replaceChildren();for(const item of result.items){const row=document.createElement('div');row.className='cloud-share-row';const text=document.createElement('span');text.textContent=item.id.slice(0,8)+' · '+(item.revoked?'已撤销':item.expires*1000<Date.now()?'已过期':'有效至 '+new Date(item.expires*1000).toLocaleString());row.append(text);if(!item.revoked&&item.expires*1000>Date.now()){const revoke=document.createElement('button');revoke.className='text-button danger';revoke.textContent='撤销';revoke.onclick=()=>safe(async()=>{await request('/api/shares/revoke',{id:entry.id,share_id:item.id});await list();});row.append(revoke);}target.append(row);}}
  button.onclick=()=>safe(async()=>{await window.ColorLensNotebook.flush();element('share-consent').checked=false;element('share-output').hidden=true;await list();view.showModal();});
  element('share-create').onclick=()=>safe(async()=>{if(!element('share-consent').checked)throw new Error('请先确认分享权限与附件内容。');const entry=window.ColorLensNotebook.getEntry(),result=await request('/api/shares/create',{id:entry.id,revision:entry.revision,days:Number(element('share-days').value)});element('share-output').textContent=location.origin+'/share#'+result.token;element('share-output').hidden=false;await list();});
}

document.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('.topbar-right').prepend(motionButton());
  updateCloudLabels();
  window.ColorLensCloud.updateStorage=mountWorkspacePages();
  const snapshots=mountAnalysisView();window.ColorLensCloud.openRecord=snapshots.open;window.ColorLensCloud.closeRecord=snapshots.clear;
  window.ColorLensQpcr=mountQpcr();
  window.ColorLensElisa=mountElisa();
  window.ColorLensTemplates=mountTemplates();
  window.ColorLensTeams=mountTeams();
  window.ColorLensSamples=mountSamples();
  window.ColorLensInventory=mountInventory();
  window.ColorLensEquipment=mountEquipment();
  window.ColorLensCollaboration=mountCollaboration();
  mountInteroperability();
  window.ColorLensAiWorkspace=mountAiWorkspace();
  window.ColorLensGlasses=mountGlasses();
  aiUi();shareUi();mountAccounts(accepted);
  document.addEventListener('click',event=>{const link=event.target.closest('a[href^="/api/download/"]');if(!link||event.ctrlKey||event.metaKey)return;event.preventDefault();safe(async()=>{notify('正在校验并打包分析快照…');await downloadAnalysis(link.getAttribute('href').split('/').at(-1));notify('ZIP 已交给浏览器下载。');});});
});
