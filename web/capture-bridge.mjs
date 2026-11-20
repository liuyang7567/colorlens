export const captureProtocol = 'colorlens-capture-v1';
export function captureNonce() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, '0')).join(''); }
export function captureOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('本机助手地址必须是带端口的 127.0.0.1 回环地址。');
  return url.origin;
}
export function captureArchivePart(filename){
  if(typeof filename!=='string')return null;const found=filename.match(/^镜析-免手动-([a-f0-9-]{36})(?:-part-(\d{2})-of-(\d{2}))?\.zip$/);if(!found)return null;
  const number=Number(found[2]||1),total=Number(found[3]||1);if(number<1||number>total||total>99||found[2]&&total<2)return null;return {recordId:found[1],number,total};
}
export function captureMessage(event, session) {
  if (!session?.source || event.source !== session.source || event.origin !== session.origin || Date.now() >= session.expiresAt) return null;
  const message = event.data;
  if (!message || typeof message !== 'object' || message.protocol !== captureProtocol || message.nonce !== session.nonce) return null;
  if (['ready', 'closed'].includes(message.type)) return Object.keys(message).every((key) => ['protocol', 'nonce', 'type'].includes(key)) ? message : null;
  if(message.type==='observation-unavailable')return Object.keys(message).every(key=>['protocol','nonce','type','requestId','reason'].includes(key))&&/^[a-f0-9]{32}$/.test(message.requestId||'')&&typeof message.reason==='string'&&message.reason.length<=300?message:null;
  if (!['frame', 'transcript','observation','archive'].includes(message.type) || typeof message.id !== 'string' || !/^[a-f0-9-]{36}$/.test(message.id) || session.seen.has(message.id) || typeof message.capturedAt !== 'string' || Math.abs(Date.now() - Date.parse(message.capturedAt)) > 5 * 60 * 1000 || !Number.isFinite(Date.parse(message.capturedAt))) return null;
  if(message.captureId!==undefined&&(typeof message.captureId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.captureId)))return null;
  if(message.recordedAt!==undefined&&(typeof message.recordedAt!=='string'||message.recordedAt.length>40||!Number.isFinite(Date.parse(message.recordedAt))||Date.parse(message.recordedAt)>Date.parse(message.capturedAt)+5000))return null;
  if (['frame','observation'].includes(message.type)) {
    if (Object.keys(message).some((key) => !['protocol', 'nonce', 'type', 'id', 'capturedAt', 'source', 'image', 'width', 'height',...message.type==='observation'?['requestId']:['captureId','recordedAt']].includes(key))) return null;
    if(message.type==='observation'&&(!/^[a-f0-9]{32}$/.test(message.requestId||'')||message.image?.byteLength>512*1024||message.width>1280||message.height>1280))return null;
    if (!(message.image instanceof ArrayBuffer) || message.image.byteLength < 6 || message.image.byteLength > 8 * 1048576 || ![message.width, message.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 4096)) return null;
    const bytes = new Uint8Array(message.image);
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  } else if(message.type==='archive'){
    if(Object.keys(message).some(key=>!['protocol','nonce','type','id','capturedAt','source','archive','filename','sha256'].includes(key))||!(message.archive instanceof ArrayBuffer)||message.archive.byteLength<22||message.archive.byteLength>20*1048576||!captureArchivePart(message.filename)||!/^[a-f0-9]{64}$/.test(message.sha256||''))return null;
    const bytes=new Uint8Array(message.archive);if(bytes[0]!==80||bytes[1]!==75||!((bytes[2]===3&&bytes[3]===4)||(bytes[2]===5&&bytes[3]===6)))return null;
  } else if (Object.keys(message).some((key) => !['protocol', 'nonce', 'type', 'id', 'captureId', 'capturedAt', 'recordedAt', 'source', 'text'].includes(key)) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 12000) return null;
  if (typeof message.source !== 'string' || message.source.length > 100 || /[\x00-\x1f]/.test(message.source)) return null;
  session.seen.add(message.id);
  return message;
}
