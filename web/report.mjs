import {request,getBytes,saveBlob,base64,sha} from './transport.mjs';
import {renderRecord} from './reporting.mjs';
const status=document.getElementById('report-status');
document.getElementById('report-print').onclick=()=>window.print();
(async()=>{
  const id=location.hash.slice(1);
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('实验编号无效。');
  const entry=await request('/api/notebook/entry/'+id);
  document.title=entry.data.title+' · 实验报告';
  renderRecord(document.getElementById('report-record'),entry);
  for(const image of document.querySelectorAll('[data-attachment]')){
    const file=entry.attachments.find(item=>item.id===image.dataset.attachment),bytes=await getBytes(file.id);
    if(await sha(bytes)!==file.sha256)throw new Error('正文图片完整性校验失败。');
    const mime=/\.png$/i.test(file.filename)?'image/png':/\.webp$/i.test(file.filename)?'image/webp':'image/jpeg';
    image.src=`data:${mime};base64,${base64(bytes)}`;
  }
  const label=document.createElement('h2');label.textContent='附件索引';document.getElementById('report-record').append(label);
  for(const file of entry.attachments){const paragraph=document.createElement('p');paragraph.textContent=`${file.filename} · ${file.size} bytes · SHA-256 ${file.sha256}`;document.getElementById('report-record').append(paragraph);}
  status.textContent='图文已加载。此报告不自动插入 AI 草稿，也不包含原件下载；完整原件请导出实验 ZIP。';
  document.getElementById('report-save').onclick=()=>{
    const styles='body{max-width:880px;margin:35px auto;padding:24px;font:15px/1.9 sans-serif;color:#263b2c}img{max-width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h2{font-size:18px}small{overflow-wrap:anywhere}';
    saveBlob(new Blob(['<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>镜析实验记录</title><style>'+styles+'</style>'+document.getElementById('report-record').outerHTML+'</html>'],{type:'text/html;charset=utf-8'}),'ColorLens-report-'+id+'.html');
  };
})().catch(error=>{status.textContent=error.message;document.getElementById('report-save').disabled=true;});
