export const encoder = new TextEncoder();
export const uid = () => crypto.randomUUID().replaceAll('-', '');
export const now = () => new Date().toISOString();
export const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export const sha = async value => hex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value));
export const token = () => uid() + uid();
export function unbase64(value) {
  if (typeof Uint8Array.fromBase64==='function') return Uint8Array.fromBase64(value);
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for (let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return bytes;
}
export function base64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) result += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(result);
}
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function check(condition, message, status = 400) { if (!condition) throw new AppError(status, message); }
export function text(value, maximum, label = '内容', required = false) {
  check(typeof value === 'string' && value.length <= maximum && !value.includes('\0') && (!required || value.trim()), `${label}格式错误或超出 ${maximum} 字。`);
  return value;
}
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json;charset=utf-8', ...headers}});
export const query = (env, sql, ...values) => env.DB.prepare(sql).bind(...values);
export const first = (env, sql, ...values) => query(env, sql, ...values).first();
export const rows = async (env, sql, ...values) => (await query(env, sql, ...values).all()).results;
export const execute = (env, sql, ...values) => query(env, sql, ...values).run();
export async function rate(env, key, limit, seconds) {
  const timestamp = Math.floor(Date.now()/1000);
  const result = await first(env, `INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
    expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END RETURNING count`, key, timestamp+seconds, timestamp, timestamp);
  check(result.count <= limit, '尝试过于频繁，请稍后再试。', 429);
}
export function safeEqual(firstValue, secondValue) {
  if (typeof firstValue !== 'string' || typeof secondValue !== 'string') return false;
  let difference = firstValue.length ^ secondValue.length;
  for (let index = 0; index < Math.max(firstValue.length, secondValue.length); index++) difference |= (firstValue.charCodeAt(index) || 0) ^ (secondValue.charCodeAt(index) || 0);
  return difference === 0;
}
export async function hmac(value, pepper) {
  check(typeof pepper === 'string' && pepper.length >= 32, '账号服务尚未配置。', 503);
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
export async function body(request, maximum = 500000) {
  check(Number(request.headers.get('content-length') || 0) <= maximum, '请求过大。', 413);
  check(request.headers.get('content-type')?.startsWith('application/json'), '需要 JSON 请求。', 415);
  const reader = request.body?.getReader();
  check(reader, '请求为空。');
  let size = 0;
  const chunks = [];
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new AppError(413, '请求过大。'); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let result;
  try { result = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch { throw new AppError(400, 'JSON 格式无效。'); }
  check(result && typeof result === 'object' && !Array.isArray(result), '请求格式错误。');
  return result;
}
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
