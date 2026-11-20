import {AppError,check,text,uid,now,sha,hmac,safeEqual,first,execute,query,rate} from './common.mjs';

export const mailConfigured=env=>Boolean(env.RESEND_API_KEY && env.MAIL_FROM && /^[^\r\n]+<[^<>\s]+@[^<>\s]+>$/.test(env.MAIL_FROM));
export function normalizeEmail(value) {
  const email=text(value,254,'邮箱',true).trim().toLowerCase();
  const parts=email.split('@');
  check(parts.length===2 && parts[0].length<=64 && /^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/.test(parts[0]) && !parts[0].startsWith('.') && !parts[0].endsWith('.') && !parts[0].includes('..'),'请填写有效邮箱地址。');
  check(parts[1].includes('.') && parts[1].split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),'请填写有效邮箱域名。');
  return email;
}
export function displayName(value) {
  const name=text(value,40,'昵称',true).trim().normalize('NFC');
  check(!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name),'昵称不能包含控制字符。');
  return name;
}
export async function validInvite(env,value) {
  const invitation=text(value||'',100,'邀请码',true).trim();
  if(env.REGISTRATION_CODE){check(safeEqual(await sha(invitation),await sha(env.REGISTRATION_CODE)),'邀请码无效，请向管理员索取当前实验室邀请码。');return null;}
  const digest=await sha(invitation);
  check(await first(env,'SELECT hash FROM invites WHERE hash=? AND remaining>0 AND expires>?',digest,Math.floor(Date.now()/1000)),'邀请码无效或已过期。');
  return digest;
}
const codeDigest=(env,id,email,purpose,code)=>hmac(`mail-code-v1\0${id}\0${email}\0${purpose}\0${code}`,env.AUTH_PEPPER);
function randomCode() {
  const value=new Uint32Array(1);
  do { crypto.getRandomValues(value); } while(value[0]>=4294000000);
  return String(value[0]%1000000).padStart(6,'0');
}
export async function issueCode(env,request,email,purpose,user,shouldSend=true) {
  check(mailConfigured(env),'邮箱服务尚未配置，请联系管理员。',503);
  await rate(env,'mail-ip:'+await hmac(request.headers.get('CF-Connecting-IP')||'local',env.AUTH_PEPPER),15,900);
  const emailKey=await hmac('mail:'+email,env.AUTH_PEPPER);
  await rate(env,'mail-minute:'+emailKey,1,60);
  await rate(env,'mail-quarter:'+emailKey,5,900);
  await rate(env,'mail-day:'+now().slice(0,10),50,90000);
  await execute(env,'DELETE FROM email_codes WHERE expires<?',Math.floor(Date.now()/1000)-86400);
  const id=uid(),code=randomCode();
  await execute(env,'INSERT INTO email_codes(id,email,purpose,user_id,user_version,code_hash,expires,used,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id,email,purpose,user?.id||null,user?.auth_version??null,await codeDigest(env,id,email,purpose,code),Math.floor(Date.now()/1000)+600,shouldSend?0:1,now());
  if(shouldSend) {
    const action={register:'注册验证',login:'邮箱登录验证',reset:'重设密码',bind:'绑定邮箱'}[purpose];
    const loginLink=purpose==='login'?`\n邮箱验证入口（打开后仍需输入验证码）：${new URL(request.url).origin}/#email-login/${id}/${encodeURIComponent(email)}\n`:'';
    const message=`你正在操作镜析 ColorLens 的${action}。\n\n验证码：${code}\n${loginLink}\n10 分钟内有效，仅供本次页面请求使用。请在你自己打开的镜析页面输入，不要发给任何人或在聊天中转发。\n如果不是你本人发起，请忽略此邮件；原账号和密码不会因此自动改变。\n镜析不会通过邮件索要邮箱密码、实验原件或 API 密钥。`;
    try {
      const response=await (env.MAIL_FETCH||fetch)('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.RESEND_API_KEY,'Idempotency-Key':'colorlens-'+id},body:JSON.stringify({from:env.MAIL_FROM.replace(/^[^<]*/,'镜析 ColorLens '),to:[email],subject:'镜析 ColorLens · '+action,text:message}),signal:AbortSignal.timeout(15000)});
      check(response.ok,'邮件服务暂不可用。',503);
    } catch {
      await execute(env,'UPDATE email_codes SET used=1 WHERE id=?',id);
      throw new AppError(503,'邮件暂未发送成功，请稍后重试。请勿重复点击；账号资料未改变。');
    }
  }
  return {challenge_id:id,expires_in:600,retry_after:60,message:'如果邮箱及本次操作符合条件，验证码已发送。请检查收件箱和垃圾邮件，10 分钟内在当前页面使用；已有账号请直接登录。'};
}
export async function readCode(env,email,purpose,payload,userId) {
  const id=text(payload.challenge_id,32,'验证码请求编号',true);
  check(/^[a-f0-9]{32}$/.test(id) && typeof payload.code==='string' && /^\d{6}$/.test(payload.code),'请输入本次邮件中的 6 位验证码。');
  const found=await first(env,`UPDATE email_codes SET attempts=attempts+1 WHERE id=? AND email=? AND purpose=?
    AND used=0 AND expires>? AND attempts<5 RETURNING *`,id,email,purpose,Math.floor(Date.now()/1000));
  check(found && (userId===undefined || found.user_id===userId) && safeEqual(await codeDigest(env,id,email,purpose,payload.code),found.code_hash),'验证码无效、已过期或尝试次数过多，请重新获取。');
  return found;
}
export const consumeCode=(env,code)=>[
  query(env,'UPDATE email_codes SET used=1 WHERE id=? AND code_hash=? AND used=0 AND expires>? AND attempts<=5',code.id,code.code_hash,Math.floor(Date.now()/1000)),
  query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')
];
