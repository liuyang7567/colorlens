import { captureProtocol } from '/capture-bridge.mjs';
import {mountHandsFree} from '/handsfree.js';
import {createReceiptSender} from '/capture-receipts.mjs';
import {mountCaptureDrafts,helperDraftSelection,captureTranscriptSource} from '/capture-drafts.mjs';

const element = (identifier) => document.getElementById(identifier);
const parentWindow = window.opener;
const issuer = new URL(location.href).searchParams.get('parent');
const nonce = location.hash.slice(1);
const clientId=crypto.randomUUID();
let csrf = '', token = '', state = null, peer = null, mediaResource = null, selectedDevice = '', polling = false, connecting = false, pollTimer = null, speechController = null, speechCancelling = false, recognisedSpeech = false;
let lastVideoFrameAt=0,observationEpoch='',observationDevice='',lastObservationTime=-1,polledVideoTime=-1;
let stoppingForParent=false;
let leaseReady=false,leaseController=null,leaseToken='',leaseEpoch=0,authorising=Promise.resolve();
let transcriptOrigin=null,transcriptDirty=false;
let transcriptId=null,transcriptSending=false,frameSending=false,lastSnapshot=null,parentEnded=false,pairedTitle='';
let draftScope=null,transcriptDraftAt=null,restoredTranscriptSource='',restoredTranscriptEdited=false;
const receipts=createReceiptSender({nonce,post:(value,transfers)=>send(value,transfers)});
const transfer=(value,transfers=[])=>parentEnded||!parentWindow||parentWindow.closed?Promise.reject(new Error('主页面已关闭或配对已结束，未传回内容仍保留，可先导出到本机。')):receipts.send(value,transfers);
const transcriptNote=document.createElement('p');transcriptNote.id='speech-origin';transcriptNote.className='muted';transcriptNote.setAttribute('role','status');element('speech-text').after(transcriptNote);
const retrySnapshot=document.createElement('button');retrySnapshot.id='snapshot-retry';retrySnapshot.className='secondary';retrySnapshot.textContent='重传上一张截图';
const exportSnapshot=document.createElement('button');exportSnapshot.id='snapshot-export';exportSnapshot.className='secondary';exportSnapshot.textContent='上一张截图存到本机';element('snapshot').after(retrySnapshot,exportSnapshot);
const exportTranscript=document.createElement('button');exportTranscript.id='speech-export';exportTranscript.className='secondary';exportTranscript.textContent='导出当前文字草稿';element('speech-transfer').after(exportTranscript);
const snapshotPreview=document.createElement('img');snapshotPreview.id='snapshot-local';snapshotPreview.hidden=true;snapshotPreview.style.maxWidth='240px';snapshotPreview.style.width='100%';snapshotPreview.alt='本窗口保留的上一张截图，可重传或另存本机';element('capture-status').closest('div').after(snapshotPreview);
retrySnapshot.disabled=true;exportSnapshot.disabled=true;exportTranscript.disabled=true;element('speech-text').disabled=true;
function refreshDraftControls(){retrySnapshot.disabled=!lastSnapshot||frameSending||parentEnded||!parentWindow||parentWindow.closed;exportSnapshot.disabled=!lastSnapshot;exportTranscript.disabled=!element('speech-text').value.trim();element('capture-draft-clear').disabled=frameSending||transcriptSending||Boolean(speechController)||speechCancelling;}
function hasUnsentDraft(){return Boolean(frameSending||transcriptSending||lastSnapshot&&!lastSnapshot.accepted||transcriptDirty&&element('speech-text').value.trim());}
function saveLocal(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
const note=document.createElement('p');note.id='observation-status';note.className='muted';note.setAttribute('role','status');note.textContent='操作指导默认关闭；只有镜析主页面明确授权后，才按次请求新的截帧。';element('stream').after(note);
const handsfree=mountHandsFree({root:document,api,getState:()=>({state,token:stoppingForParent||!leaseReady?'':token,selectedDevice,speechBusy:Boolean(speechController)}),transfer});
function transcriptSource(){return captureTranscriptSource({restoredSource:restoredTranscriptSource,restoredEdited:restoredTranscriptEdited,recognised:recognisedSpeech,origin:transcriptOrigin});}
function helperItems(){
  if(!draftScope)return [];const items=[],text=element('speech-text').value;
  if(text.trim()){transcriptId??=crypto.randomUUID();transcriptDraftAt??=new Date().toISOString();items.push({kind:'text',id:transcriptId,entryId:draftScope.entryId,source:transcriptSource(),capturedAt:transcriptDraftAt,...transcriptOrigin?{recordedAt:transcriptOrigin.capturedAt}:{},text});}
  if(lastSnapshot)items.push({kind:'image',id:lastSnapshot.id,entryId:draftScope.entryId,source:lastSnapshot.source,capturedAt:lastSnapshot.recordedAt,recordedAt:lastSnapshot.recordedAt,bytes:lastSnapshot.bytes,filename:'眼镜截帧-'+lastSnapshot.id+'.jpg'});
  return items;
}
function draftOperationBusy(){return frameSending||transcriptSending||Boolean(speechController)||speechCancelling;}
const drafts=mountCaptureDrafts({root:document,anchor:element('stream').closest('section'),destination:'本窗口草稿',getScope:()=>draftScope,getItems:helperItems,validateTarget:async entryId=>{if(!draftScope||draftScope.entryId!==entryId||!token||!leaseReady||parentEnded)throw new Error('请先从原账号的原实验重新打开采集窗口，再查找草稿。');await api('/api/state');},restoreItems:async items=>{
  if(draftOperationBusy())throw new Error('请先等待或取消正在处理的截图、转写和传回。');const scope=draftScope,{text,image}=helperDraftSelection(items);let restoredImage=null;
  if(image){const blob=new Blob([image.bytes],{type:'image/jpeg'});let bitmap;try{bitmap=await createImageBitmap(blob);}catch{throw new Error('本机草稿截图无法读取，请保留副本检查。');}const width=bitmap.width,height=bitmap.height;bitmap.close();if(!width||!height||width>4096||height>4096)throw new Error('本机草稿截图尺寸超过采集限制。');restoredImage={id:image.id,recordedAt:image.recordedAt||image.capturedAt,source:image.source,width,height,blob,bytes:new Uint8Array(image.bytes),accepted:false};}
  if(draftScope!==scope||draftOperationBusy()||helperItems().length)throw new Error('窗口内容或目标实验已变化，未恢复。');
  if(text){element('speech-text').value=text.text;transcriptId=text.id;transcriptDraftAt=text.capturedAt;transcriptDirty=true;recognisedSpeech=false;restoredTranscriptSource=text.source;restoredTranscriptEdited=false;transcriptOrigin=text.recordedAt?{label:text.source,capturedAt:text.recordedAt,edited:false}:null;transcriptNote.textContent='从本机草稿恢复 · 原来源：'+text.source+(text.recordedAt?' · 音轨采样完成于 '+new Date(text.recordedAt).toLocaleString():'');element('speech-status').textContent='文字已恢复到本窗口，尚未传回。请核对来源、术语与数值后再传回。';}
  if(restoredImage){lastSnapshot={...restoredImage,url:URL.createObjectURL(restoredImage.blob)};snapshotPreview.src=lastSnapshot.url;snapshotPreview.hidden=false;element('capture-status').textContent='上一张截图已恢复，尚未传回；可重传或导出到本机。';}
  if(state)render();refreshDraftControls();drafts.changed();await drafts.flush();return '草稿已恢复到本窗口，尚未传回或写入实验；请核对后主动传回。原暂存副本仍保留。';
}});
element('capture-draft-protection').querySelector('label').lastChild.textContent='允许在当前浏览器暂存本窗口的文字和上一张截图，用于意外退出后恢复。';
const clearDraft=document.createElement('button');clearDraft.id='capture-draft-clear';clearDraft.className='secondary';clearDraft.textContent='清空本窗口已处理草稿';clearDraft.disabled=true;element('capture-draft-protection').append(clearDraft);
clearDraft.onclick=()=>void action(async()=>{if(draftOperationBusy())throw new Error('请先等待或取消正在处理的内容。');if(!confirm('请先确认主页面已保存，或已导出到本机。清空本窗口的文字和上一张截图，继续吗？'))return;element('speech-text').value='';transcriptId=null;transcriptDraftAt=null;transcriptOrigin=null;transcriptDirty=false;recognisedSpeech=false;restoredTranscriptSource='';restoredTranscriptEdited=false;transcriptNote.textContent='';if(lastSnapshot?.url)URL.revokeObjectURL(lastSnapshot.url);lastSnapshot=null;snapshotPreview.removeAttribute('src');snapshotPreview.hidden=true;element('speech-status').textContent='本窗口文字已清空。';element('capture-status').textContent='本窗口截图已清空。';drafts.changed();await drafts.flush();if(state)render();refreshDraftControls();});
element('stream').addEventListener('loadeddata',()=>{lastVideoFrameAt=performance.now();});
async function observationFrame(data){
  try{
    if(!token||!state?.running)throw new Error('本机接收尚未开启，未请求 AI。');
    const device=state.devices.find(item=>item.id===selectedDevice),video=element('stream');
    if(data.epoch!==observationEpoch){observationEpoch=data.epoch;observationDevice=selectedDevice;lastObservationTime=-1;}
    if(observationDevice!==selectedDevice)throw new Error('当前设备已切换，请返回主页面重新授权观察。');
    if(!device?.ready||!peer||video.readyState<2||!video.videoWidth||video.paused||performance.now()-lastVideoFrameAt>5000||video.currentTime===lastObservationTime)throw new Error('没有新鲜的直播画面，观察已停止；请检查直播后重新授权。');
    lastObservationTime=video.currentTime;
    const ratio=Math.min(1,960/video.videoWidth,720/video.videoHeight),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.8));if(!blob||blob.size>512*1024)throw new Error('当前截帧超过观察体积限制，未发送。');
    const image=await blob.arrayBuffer();send({type:'observation',requestId:data.requestId,id:crypto.randomUUID(),capturedAt:new Date().toISOString(),source:('操作指导截帧 · '+device.label).slice(0,100),width:canvas.width,height:canvas.height,image},[image]);note.textContent='已按主页面本次授权传回一帧；不连续录像，不在本窗口调用模型。';
  }catch(error){send({type:'observation-unavailable',requestId:data.requestId,reason:error.message.slice(0,300)});note.textContent=error.message;}
}
const send = (message, transfers = []) => parentWindow.postMessage({ protocol: captureProtocol, nonce, ...message }, issuer, transfers);
const message = (value) => { element('status').textContent = value; };
async function api(endpoint, payload = {}, options = {}) {
  const response = await fetch(endpoint, { method: options.method || 'POST', headers: { 'Content-Type': options.type || 'application/json', 'X-Capture-CSRF': csrf, 'X-Capture-Session': token }, body: options.raw ?? JSON.stringify(payload), ...options.signal ? { signal: options.signal } : {}, ...options.keepalive ? { keepalive: true } : {} });
  if (!response.ok) { const result = await response.json().catch(() => ({}));const error=new Error(result.error || '本机接收端请求失败。');error.status=response.status;throw error; }
  return options.responseType==='blob'?response.blob():options.type ? response : response.json();
}
async function connectLease(){
  if(leaseReady&&leaseToken===token)return;
  leaseEpoch++;const epoch=leaseEpoch;leaseController?.abort();const controller=new AbortController();leaseController=controller;leaseReady=false;leaseToken=token;const connectingToken=token;
  const endpoint=new URL('/api/connection',location.href);endpoint.protocol='ws:';const socket=new WebSocket(endpoint);
  controller.signal.addEventListener('abort',()=>socket.close(),{once:true});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{reject(new Error('本机连接未能建立，请重新打开采集窗口。'));controller.abort();},8000);
    socket.onopen=()=>socket.send(JSON.stringify({type:'authenticate',csrf,token:connectingToken,clientId}));
    socket.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.type!=='connected'||Object.keys(value).length!==1)throw new Error();clearTimeout(timer);if(epoch!==leaseEpoch||controller.signal.aborted)return;leaseReady=true;resolve();}catch{clearTimeout(timer);reject(new Error('本机连接校验失败。'));controller.abort();}};
    socket.onerror=()=>{clearTimeout(timer);reject(new Error('本机连接未能建立，请确认当前助手仍在运行。'));};
    socket.onclose=()=>{clearTimeout(timer);reject(new Error('本机连接已关闭。'));if(epoch!==leaseEpoch||controller.signal.aborted||stoppingForParent)return;leaseReady=false;speechController?.abort();handsfree.connectionLost('采集页面连接已断开，请从主页面重新打开。已保存资料保留。');if(state)render();message('采集连接已断开，本窗口已停用。请从主页面重新打开，不会自动恢复记录。');void disconnectPreview();};
  });
}
async function disconnectPreview() {
  const closing = peer; peer = null;
  if (closing) closing.close();
  element('stream').srcObject = null;
  element('snapshot').disabled = true;
  const resource = mediaResource; mediaResource = null;
  if (resource && token) await api(resource, {}, { method: 'DELETE' }).catch(() => {});
}
async function connectPreview() {
  const device = state?.devices.find((item) => item.id === selectedDevice);
  if (connecting || peer || !device?.ready || !leaseReady || stoppingForParent) return;
  connecting = true;
  try {
    const connection = new RTCPeerConnection({ iceServers: [] }); peer = connection;
    const stream = new MediaStream(); element('stream').srcObject = stream;
    connection.addTransceiver('video', { direction: 'recvonly' }); connection.addTransceiver('audio', { direction: 'recvonly' });
    connection.ontrack = (event) => { if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track); void element('stream').play().catch(() => {}); };
    connection.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(connection.connectionState)) { message('预览连接中断，请检查官方 App 直播状态，再点击“重新连接预览”。'); void disconnectPreview(); } };
    await connection.setLocalDescription(await connection.createOffer());
    if (connection.iceGatheringState !== 'complete') await new Promise((resolve) => { const timer = setTimeout(resolve, 4000); connection.addEventListener('icegatheringstatechange', () => { if (connection.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } }); });
    if (connection !== peer) return;
    const response = await api('/api/whep/' + selectedDevice, {}, { type: 'application/sdp', raw: connection.localDescription.sdp });
    if (connection !== peer) return;
    mediaResource = response.headers.get('Location');
    await connection.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) { message(error.message); await disconnectPreview(); }
  finally { connecting = false; }
}
function render() {
  if(stoppingForParent)return;
  const paired=Boolean(token)&&leaseReady;
  handsfree.availability();
  const deviceSelect = element('device'), previous = selectedDevice;
  const ids = state.devices.map((item) => item.id).join(',');
  if (deviceSelect.dataset.ids !== ids) {
    deviceSelect.replaceChildren(...state.devices.map((item) => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option; }));
    deviceSelect.dataset.ids = ids;
    selectedDevice = state.devices.some((item) => item.id === previous) ? previous : state.devices[0]?.id || '';
    deviceSelect.value = selectedDevice;
  }
  const networkSelect = element('network'), addresses = state.networks.map((item) => item.address).join(',');
  if (networkSelect.dataset.addresses !== addresses) {
    const previousAddress = networkSelect.value;
    networkSelect.replaceChildren(...state.networks.map((item) => { const option = document.createElement('option'); option.value = item.address; option.textContent = item.name + ' · ' + item.address; return option; }));
    networkSelect.dataset.addresses = addresses;
    if (state.networks.some((item) => item.address === previousAddress)) networkSelect.value = previousAddress;
  }
  const device = state.devices.find((item) => item.id === selectedDevice);
  element('network').disabled = state.running || state.busy;
  element('device').disabled = !paired||frameSending||Boolean(speechController)||speechCancelling||handsfree.isRecording()||handsfree.isBusyAudio()||handsfree.isBusy();
  element('speech-language').disabled=transcriptSending||Boolean(speechController)||speechCancelling;
  element('speech-text').disabled=transcriptSending||Boolean(speechController)||speechCancelling;
  element('speech-transfer').disabled=transcriptSending||Boolean(speechController)||speechCancelling||parentEnded||!parentWindow||parentWindow.closed||!element('speech-text').value.trim();
  element('speech-transfer').textContent=transcriptId&&!transcriptDirty?'再次传回当前文字':'将确认后的文字传回镜析';refreshDraftControls();
  element('new-device-name').disabled = !paired || state.devices.length >= 3;
  element('add-device').disabled = !paired || state.devices.length >= 3;
  element('start').disabled = !paired || state.running || state.busy || !networkSelect.value;
  element('stop').disabled = !paired || state.busy || !state.running && !state.cleanupPending;
  element('unbind').disabled = !paired || state.busy;
  element('publish-url').value = paired?device?.publishUrl||'':'';
  element('copy-url').disabled = !paired||!device?.publishUrl;
  element('reconnect').disabled = !paired||!device?.ready;
  element('snapshot').disabled = frameSending||!paired||!peer || element('stream').readyState < 2;
  element('speech-start').disabled = transcriptSending||!paired || !device?.online || !state.offlineSpeech || Boolean(speechController) || speechCancelling || handsfree.isBusyAudio() || !element('speech-consent').checked || !device.tracks.some((track) => /Audio|Opus|AAC/i.test(track.codec));
  element('device-state').textContent = !paired?'本窗口采集连接未就绪或已结束，请从主页面重新打开；本机已保存资料保留。':device?.error || (state.running ? device?.ready ? '当前设备已入流，可以预览、截图与读取音轨。' : device?.online ? '已收到设备直播，正在准备音视频桥接…' : '等待官方 App 推流。请确认手机、眼镜和电脑同一 Wi-Fi，并使用上方本次地址。' : '接收端未启动；旧推流地址不会被当作当前连接。');
  if (state.error) message(state.error);
}
async function finishCaptureWindow(){
  await disconnectPreview();leaseEpoch++;leaseController?.abort();leaseReady=false;token='';stoppingForParent=false;
  if(hasUnsentDraft()){handsfree.connectionLost('配对已结束，记录已停止；本机已保存资料保留。');if(state){state={...state,running:false,busy:false,devices:state.devices.map(device=>({...device,online:false,ready:false,publishUrl:null}))};render();}refreshDraftControls();if(transcriptDirty&&element('speech-text').value.trim())element('speech-status').textContent='配对已结束，文字未传回。可导出草稿，或复制到重新打开的实验记录。';if(lastSnapshot&&!lastSnapshot.accepted)element('capture-status').textContent='配对已结束，上一张截图未确认收到，可先存到本机。';element('account-state').textContent='已结束：'+pairedTitle;element('device-state').textContent='本窗口已停止采集，未传回草稿仍保留。';message('配对已结束，采集已停止。本窗口还有未传回内容，可先导出截图或文字草稿。');}else window.close();
}
async function stopForParent(){
  if(stoppingForParent)return;stoppingForParent=true;parentEnded=true;receipts.cancel('主页面已关闭或配对已结束，未确认内容仍保留，可先导出本机。');clearInterval(pollTimer);pollTimer=null;speechController?.abort();document.querySelectorAll('button').forEach(button=>{button.disabled=true;});handsfree.availability();
  try{if(token)await api('/api/unpair');await finishCaptureWindow();}
  catch(error){if(error.status===403){await finishCaptureWindow();return;}stoppingForParent=false;message('主页面已关闭，尚未确认后台停止：'+error.message+' 可在启动器点“停止并退出”。');if(!pollTimer)pollTimer=setInterval(()=>void poll(),1200);}
}
async function poll() {
  if (!token || !leaseReady||polling) return;
  polling = true;const requestedToken=token,requestedEpoch=leaseEpoch,valid=()=>!stoppingForParent&&leaseReady&&token===requestedToken&&leaseEpoch===requestedEpoch;
  try {
    if(parentWindow?.closed){await stopForParent();return;}
    const updated=await api('/api/state');if(!valid())return;state=updated;render();
    const video=element('stream');if(video.readyState>=2&&video.currentTime!==polledVideoTime){polledVideoTime=video.currentTime;lastVideoFrameAt=performance.now();}
    const device = state.devices.find((item) => item.id === selectedDevice);
    if (!state.running || !device?.ready) { if (peer) await disconnectPreview(); }
    else if (!peer) await connectPreview();
  } catch (error) { if(valid()){message(error.message);await disconnectPreview();} }
  finally { polling = false; }
}
async function action(operation) { try { await operation(); } catch (error) { message(error.message); } }

try {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('本机助手配置不可用。');
  const configuration = await response.json(); csrf = configuration.csrf;
  if(configuration.connectionLease!=='websocket')throw new Error('本机助手版本不匹配，请启动当前 V0.10 应用。');
  if (!parentWindow || !configuration.allowedOrigins.includes(issuer) || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error('请从已登录镜析的“眼镜采集”页面打开本窗口。');
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parentWindow || event.origin !== issuer || !data || data.protocol !== captureProtocol || data.nonce !== nonce) return;
    if(data.type==='parent-closing'){if(Object.keys(data).every(key=>['protocol','nonce','type'].includes(key)))void stopForParent();return;}
    if(data.type==='transfer-result'){receipts.receive(data);return;}
    if(data.type==='request-observation'){
      if(Object.keys(data).every(key=>['protocol','nonce','type','requestId','epoch'].includes(key))&&/^[a-f0-9]{32}$/.test(data.requestId||'')&&/^[a-f0-9]{32}$/.test(data.epoch||''))void observationFrame(data);
      return;
    }
    if(data.type!=='authorise'||typeof data.ticket!=='string')return;
    authorising=authorising.catch(()=>{}).then(async()=>{
      if(stoppingForParent||parentEnded||parentWindow.closed)return;
      const paired = await api('/api/pair', { ticket: data.ticket, nonce, issuer,clientId }); token = paired.token;
      if(!/^[a-f0-9]{32}$/.test(paired.userId||'')||!/^[a-f0-9]{32}$/.test(paired.entryId||'')||draftScope&&(draftScope.account!==paired.userId||draftScope.entryId!==paired.entryId)){parentEnded=true;await api('/api/unpair').catch(()=>{});token='';leaseEpoch++;leaseController?.abort();leaseReady=false;speechController?.abort();await disconnectPreview();handsfree.connectionLost('账号或实验归属已变化，已停止本窗口采集；原草稿仍保留。');if(state)render();throw new Error('账号或实验归属已变化，本窗口未复用。请从主页面重新打开采集窗口。');}
      if(!draftScope)draftScope={account:paired.userId,entryId:paired.entryId,entryTitle:paired.entryTitle};else draftScope.entryTitle=paired.entryTitle;
      await connectLease();drafts.scopeChanged();
      pairedTitle=paired.entryTitle;element('account-state').textContent = '已绑定：' + paired.entryTitle;
      message('镜析账号与目标实验配对成功。请显式开始接收，再在官方 App 开播。');
      if (!pollTimer) pollTimer = setInterval(() => { void poll(); }, 1200);
      await poll();
    });void authorising.catch(error=>message(error.message));
  });
  send({ type: 'ready' });
  message('本机窗口已打开，正在等待镜析提供有时效的采集授权。');
} catch (error) { message(error.message); }

element('start').onclick = () => { void action(async () => { element('start').disabled = true; message('正在启动接收端；如果 Windows 弹出管理员确认，请核对后允许本次临时端口放行。'); await api('/api/start', { address: element('network').value }); message('本机接收已开始，请复制设备专用地址到官方 App 并开播。'); await poll(); }); };
element('stop').onclick = () => { void action(async () => { await disconnectPreview(); state = await api('/api/stop'); render(); message(state.error || '本机媒体已停止，临时规则清理已完成。请同时在官方 App 结束直播。'); }); };
element('device').onchange = () => { void action(async () => { await disconnectPreview(); selectedDevice = element('device').value; render(); await connectPreview(); }); };
element('add-device').onclick = () => { void action(async () => { await api('/api/device', { label: element('new-device-name').value }); element('new-device-name').value = ''; await poll(); }); };
element('copy-url').onclick = () => { void action(async () => { await navigator.clipboard.writeText(element('publish-url').value); message('已复制当前设备地址。地址含本次私密口令，请勿公开。'); }); };
element('reconnect').onclick = () => { void action(async () => { await disconnectPreview(); await connectPreview(); }); };
element('stream').onloadeddata = () => render();
async function sendSnapshot(draft){
  await drafts.flush().catch(()=>{});
  draft.accepted=false;element('capture-status').textContent='等待主页面确认接收上一张截图…';const image=await draft.blob.arrayBuffer();
  await transfer({type:'frame',captureId:draft.id,capturedAt:new Date().toISOString(),recordedAt:draft.recordedAt,source:draft.source,width:draft.width,height:draft.height,image},[image]);draft.accepted=true;element('capture-status').textContent='主页面已确认收到截图，仍需核对并确认保存。';
}
async function snapshotAction(operation){if(frameSending)return;frameSending=true;if(state)render();try{await operation();}catch(error){element('capture-status').textContent=error.message+(lastSnapshot?' 上一张截图仍在本窗口，可重传或存到本机。':' 本次未生成可保留的截图。');}finally{frameSending=false;if(state)render();refreshDraftControls();}}
element('snapshot').onclick=()=>void snapshotAction(async()=>{
  if(lastSnapshot&&!lastSnapshot.accepted&&!confirm('上一张截图还没有确认收到。请先重传或存到本机；继续拍新截图会替换本窗口保留的上一张，继续吗？'))return;
  const video=element('stream'),device=state.devices.find(item=>item.id===selectedDevice),recordedAt=new Date().toISOString();
  if(video.readyState<2||!video.videoWidth||!video.videoHeight||video.videoWidth>4096||video.videoHeight>4096)throw new Error('当前没有可截取的有效视频帧。');
  const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.92));if(!blob||blob.size>8*1048576)throw new Error('截图生成失败或超过 8 MB，请调整直播分辨率。');
  const bytes=new Uint8Array(await blob.arrayBuffer());if(lastSnapshot?.url)URL.revokeObjectURL(lastSnapshot.url);lastSnapshot={id:crypto.randomUUID(),recordedAt,source:('视频截帧 · '+device.label).replace(/[\x00-\x1f]/g,' ').slice(0,100),width:canvas.width,height:canvas.height,blob,bytes,accepted:false,url:URL.createObjectURL(blob)};snapshotPreview.src=lastSnapshot.url;snapshotPreview.hidden=false;drafts.changed();await sendSnapshot(lastSnapshot);
});
retrySnapshot.onclick=()=>void snapshotAction(async()=>{if(!lastSnapshot)throw new Error('本窗口还没有保留的截图。');await sendSnapshot(lastSnapshot);});
exportSnapshot.onclick=()=>{if(lastSnapshot)saveLocal(lastSnapshot.blob,'镜析-截图-'+lastSnapshot.id+'.jpg');};
exportTranscript.onclick=()=>{const text=element('speech-text').value;if(text.trim())saveLocal(new Blob(['\uFEFF镜析 · 待核对文字草稿\n原目标实验：'+pairedTitle+'\n来源：'+transcriptSource()+(transcriptOrigin?'\n音轨采样完成：'+transcriptOrigin.capturedAt:'')+'\n\n'+text+'\n'],{type:'text/plain;charset=utf-8'}),'镜析-文字草稿-'+(transcriptId||crypto.randomUUID())+'.txt');};
element('speech-consent').onchange = () => { if(!element('speech-consent').checked&&speechController)element('speech-cancel').click();if (state) render(); };
element('speech-start').onclick = () => { void action(async () => {
  if (!element('speech-consent').checked) throw new Error('请先确认语音读取与在场人员授权。');
  if(transcriptDirty&&element('speech-text').value.trim()&&!confirm('当前文字还没有传回镜析。新转写完成后会替换它，确认继续吗？'))return;
  const requestedDevice=state.devices.find(device=>device.id===selectedDevice);
  speechController = new AbortController(); render(); element('speech-cancel').disabled = false; element('speech-status').textContent = '正在读取最多 30 秒音轨，随后在本机离线转写；请等待或取消。';
  try { const result = await api('/api/transcribe', { deviceId: selectedDevice, language: element('speech-language').value, consent: true }, { signal: speechController.signal });element('speech-text').value=result.text;recognisedSpeech=true;transcriptDirty=true;transcriptId=crypto.randomUUID();transcriptDraftAt=new Date().toISOString();restoredTranscriptSource='';restoredTranscriptEdited=false;transcriptOrigin={label:requestedDevice.label.replace(/[\x00-\x1f]/g,' '),capturedAt:Number.isFinite(Date.parse(result.capturedAt))?result.capturedAt:new Date().toISOString(),durationSeconds:result.durationSeconds,edited:false};transcriptNote.textContent='来源：'+transcriptOrigin.label+' · 音轨采样完成于 '+new Date(transcriptOrigin.capturedAt).toLocaleString()+(Number.isFinite(result.durationSeconds)?' · 实际约 '+result.durationSeconds.toFixed(1)+' 秒':'');element('speech-status').textContent = '本机转写已完成，请人工核对术语和数值，再传回镜析。';drafts.changed(); }
  catch (error) { element('speech-status').textContent = error.name === 'AbortError' ? '本次语音转写已取消。' : error.message; }
  finally { speechController = null; element('speech-cancel').disabled = true; render(); }
}); };
element('speech-cancel').onclick = () => { void action(async () => { speechCancelling = true; render(); speechController?.abort(); try { await api('/api/speech-cancel'); element('speech-status').textContent = '本次语音转写已取消，后台处理已结束。'; } finally { speechCancelling = false; render(); } }); };
element('speech-text').oninput=()=>{const hasText=Boolean(element('speech-text').value.trim());transcriptDirty=hasText;transcriptId=hasText?crypto.randomUUID():null;transcriptDraftAt=hasText?new Date().toISOString():null;if(!hasText){transcriptOrigin=null;recognisedSpeech=false;restoredTranscriptSource='';restoredTranscriptEdited=false;transcriptNote.textContent='';}else if(restoredTranscriptSource){restoredTranscriptEdited=true;if(transcriptOrigin)transcriptOrigin.edited=true;transcriptNote.textContent='从本机草稿恢复后人工编辑 · 原来源：'+restoredTranscriptSource;}else if(transcriptOrigin)transcriptOrigin.edited=true;else{recognisedSpeech=false;transcriptNote.textContent='手动录入文字，未运行语音识别。';}drafts.changed();if(state)render();refreshDraftControls();};
element('speech-transfer').onclick = () => { void action(async () => {
  const text = element('speech-text').value.trim(); if (!text || text.length > 12000) throw new Error('转写文字为空或过长。');
  if(transcriptSending||speechController||speechCancelling)throw new Error('请等待当前传回或转写完成后再操作。');
  transcriptId??=crypto.randomUUID();const captureId=transcriptId;transcriptSending=true;transcriptDirty=true;if(state)render();element('speech-status').textContent='等待主页面确认接收文字…';
  try{await drafts.flush().catch(()=>{});await transfer({type:'transcript',captureId,capturedAt:new Date().toISOString(),...transcriptOrigin?{recordedAt:transcriptOrigin.capturedAt}:{},source:transcriptSource(),text});if(transcriptId===captureId&&element('speech-text').value.trim()===text)transcriptDirty=false;element('speech-status').textContent='主页面已确认收到文字，仍需核对并确认保存。';}
  catch(error){transcriptDirty=true;element('speech-status').textContent=error.message+' 原文字仍保留，可重传或导出草稿。';}
  finally{transcriptSending=false;if(state)render();refreshDraftControls();}
}); };
element('unbind').onclick=()=>{void action(async()=>{stoppingForParent=true;parentEnded=true;receipts.cancel('本机配对已结束，未确认内容仍保留。');try{await disconnectPreview();await api('/api/unbind');clearInterval(pollTimer);send({type:'closed'});await finishCaptureWindow();}catch(error){stoppingForParent=false;if(state)render();throw error;}});};
window.addEventListener('beforeunload',event=>{if(hasUnsentDraft()){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide', () => {
  receipts.cancel('本窗口已离开，未确认的内容尚未保存。');if(lastSnapshot?.url)URL.revokeObjectURL(lastSnapshot.url);
  leaseEpoch++;leaseController?.abort();
  speechController?.abort(); clearInterval(pollTimer); if (peer) peer.close();
  if (token) void api('/api/unpair', {}, { keepalive: true }).catch(() => {});
});
