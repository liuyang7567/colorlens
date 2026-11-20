import {renderRecord} from './reporting.mjs';
import {saveBlob} from './transport.mjs';
const value=location.hash.slice(1);
const status=document.getElementById('share-status');
const urls=[];
async function shared(payload) {
  const response=await fetch('/api/public/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value,...payload})});
  if(!response.ok)throw new Error((await response.json()).error||'分享不可用。');
  return response;
}
(async()=>{
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error('缺少有效分享链接。');
  const result=await (await shared({})).json();
  document.getElementById('share-notice').textContent=result.notice+' 有效至 '+new Date(result.expires*1000).toLocaleString();
  renderRecord(document.getElementById('shared-record'),result.entry);
  for(const image of document.querySelectorAll('[data-attachment]')){
    try{const blob=await (await shared({attachment_id:image.dataset.attachment,preview:true})).blob();const url=URL.createObjectURL(blob);urls.push(url);image.src=url;}
    catch{image.alt='图片不可用或分享已过期。';}
  }
  for(const file of result.entry.attachments){const button=document.createElement('button');button.textContent=`下载 ${file.filename} · ${(file.size/1024).toFixed(1)} KB`;button.onclick=async()=>{try{saveBlob(await (await shared({attachment_id:file.id})).blob(),file.filename);}catch(error){status.textContent=error.message;}};document.getElementById('share-files').append(button);}
  status.textContent='已加载只读快照。原记录后续修改不会自动更新本链接。';
})().catch(error=>{status.textContent=error.message;document.getElementById('share-notice').textContent='分享不可用';});
window.addEventListener('pagehide',()=>urls.forEach(url=>URL.revokeObjectURL(url)));
