import {sha,base64,unbase64} from '../src/common.mjs';
export async function request(path,payload,options={}) {
  const response=await fetch(path,{...payload===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-ColorLens-Token':window.COLORLENS?.token||''},body:JSON.stringify(payload)},...options.signal?{signal:options.signal}:{}});
  let content;
  try {content=await response.json();} catch {throw new Error('服务器未返回有效内容，请检查网络后重试。');}
  if (!response.ok) {const error=new Error(content.error||'请求未完成。');error.status=response.status;error.detail=content;throw error;}
  return content;
}
export async function uploadFile(entry,filename,bytes) {
  const ticket=await request('/api/files/begin',{id:entry.id,revision:entry.revision,filename,size:bytes.length,sha256:await sha(bytes)});
  try {
    for (let position=0;position<ticket.chunks;position++) await request('/api/files/chunk',{upload_id:ticket.id,position,data:base64(bytes.subarray(position*786432,(position+1)*786432))});
    const result=await request('/api/files/finish',{upload_id:ticket.id,revision:entry.revision});
    return {entry:result,file:result.attachments.find(item=>item.id===ticket.id)};
  } catch(error) {await request('/api/files/cancel',{upload_id:ticket.id}).catch(()=>{});throw error;}
}
export async function getBytes(id) {
  const response=await fetch('/api/notebook/attachment/'+id,{cache:'no-store'});
  if (!response.ok) throw new Error((await response.json()).error||'附件读取失败。');
  return new Uint8Array(await response.arrayBuffer());
}
export function saveBlob(blob,filename) {
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export {sha,base64,unbase64};
