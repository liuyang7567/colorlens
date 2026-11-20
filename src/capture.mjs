import { check, encoder, base64, unbase64, first } from './common.mjs';
import { detail } from './notebook.mjs';

const maximumAge = 10 * 60 * 1000;
const encode = (bytes) => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value) => unbase64(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
const noncePattern = /^[a-f0-9]{64}$/;

async function key(env) {
  check(typeof env.AUTH_PEPPER === 'string' && env.AUTH_PEPPER.length >= 20, '采集签名尚未配置。', 503);
  return crypto.subtle.importKey('raw', encoder.encode('colorlens-capture-ticket-v1:' + env.AUTH_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueCaptureTicket(env, user, payload, issuer) {
  check(noncePattern.test(payload.nonce || ''), '采集会话编号无效。');
  const entry = await detail(env, user, payload.id);
  check(!entry.deleted && entry.data.status === 'draft', '请先选择可编辑的实验记录。', 409);
  const issued = Date.now();
  const claims = { version: 1, issuer, user_id: user.id, auth_version: user.auth_version || 0, entry_id: entry.id, revision: entry.revision, nonce: payload.nonce, issued_at: issued, expires_at: issued + maximumAge };
  const content = encode(encoder.encode(JSON.stringify(claims)));
  const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(content))));
  return { ticket: content + '.' + signature, expires_at: claims.expires_at, user_id: user.id, entry_id: entry.id };
}

export async function verifyCaptureTicket(env, payload, issuer) {
  check(typeof payload.ticket === 'string' && payload.ticket.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.ticket) && noncePattern.test(payload.nonce || ''), '采集凭据无效。', 403);
  const [content, signature] = payload.ticket.split('.');
  let claims;
  try {
    check(await crypto.subtle.verify('HMAC', await key(env), decode(signature), encoder.encode(content)), '采集凭据校验失败。', 403);
    claims = JSON.parse(new TextDecoder().decode(decode(content)));
  } catch {
    check(false, '采集凭据校验失败。', 403);
  }
  const timestamp = Date.now();
  check(claims.version === 1 && claims.issuer === issuer && claims.nonce === payload.nonce && Number.isSafeInteger(claims.issued_at) && Number.isSafeInteger(claims.expires_at) && claims.expires_at > timestamp && claims.issued_at <= timestamp + 30000 && claims.expires_at - claims.issued_at === maximumAge && /^[a-f0-9]{32}$/.test(claims.user_id) && /^[a-f0-9]{32}$/.test(claims.entry_id), '采集凭据已过期或来源不匹配，请重新配对。', 403);
  const owner = await first(env, 'SELECT auth_version,disabled,email_verified_at FROM users WHERE id=?', claims.user_id);
  check(owner && !owner.disabled && owner.email_verified_at && owner.auth_version === claims.auth_version, '账号授权已变化，请重新登录并配对。', 403);
  const entry = await detail(env, { id: claims.user_id }, claims.entry_id);
  check(!entry.deleted && entry.data.status === 'draft', '目标实验已不可编辑，请重新选择。', 409);
  return { version: 1, issuer, user_id: claims.user_id, entry_id: claims.entry_id, entry_title: entry.data.title, nonce: claims.nonce, expires_at: claims.expires_at };
}
