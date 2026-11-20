import {AppError,check,text,uid,token,now,sha,hmac,safeEqual,encoder,hex,first,rows,execute,query,json,rate} from './common.mjs';
import {mailConfigured,normalizeEmail,displayName,validInvite,issueCode,readCode,consumeCode} from './email.mjs';
export {rate} from './common.mjs';

async function derive(password,salt,pepper) {
  const material=await hmac('colorlens-password-v1\0'+password,pepper);
  const key=await crypto.subtle.importKey('raw',encoder.encode(material),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
}
export async function hashPassword(password,pepper,minimum=12) {
  text(password,128,'密码',true);check(password.length>=minimum,`密码至少 ${minimum} 个字符。`);
  const salt=uid();return `${salt}$${await derive(password,salt,pepper)}`;
}
export async function verifyPassword(password,stored,pepper) {
  text(password,128,'密码',true);
  const [salt,expected]=(stored||`${'0'.repeat(32)}$${'0'.repeat(64)}`).split('$');
  return safeEqual(await derive(password,salt,pepper),expected);
}
export function publicUser(user) {return {id:user.id,username:user.display_name||user.username,email:user.email||null,email_verified:Boolean(user.email_verified_at),role:user.role};}
const cookie=(request,value,seconds)=>`${new URL(request.url).protocol==='https:'?'__Host-':''}ColorLens=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
export async function session(env,request,required=true) {
  const name=new URL(request.url).protocol==='https:'?'__Host-ColorLens':'ColorLens';
  const value=request.headers.get('cookie')?.split(';').map(part=>part.trim()).find(part=>part.startsWith(name+'='))?.slice(name.length+1);
  const found=value&&/^[a-f0-9]{64}$/.test(value)?await first(env,`SELECT users.id,users.username,users.display_name,users.email,users.email_verified_at,users.auth_version,users.role,users.disabled,sessions.csrf,sessions.hash
    FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?
    AND sessions.auth_version=users.auth_version AND (users.email IS NULL OR users.email_verified_at IS NOT NULL)`,await sha(value),Math.floor(Date.now()/1000)):null;
  if(!found||found.disabled){if(required)throw new AppError(401,'请先登录；当前输入未自动丢弃，可复制或下载后重新登录。');return null;}
  return found;
}
export function sameOrigin(request){check(request.headers.get('origin')===new URL(request.url).origin,'请从镜析页面提交操作。',403);}
export function csrf(request,user){sameOrigin(request);check(safeEqual(request.headers.get('X-ColorLens-Token'),user.csrf),'页面身份已过期，请重新登录。',403);}
async function loginResponse(env,request,user) {
  const value=token(),nonce=token();
  await env.DB.batch([
    query(env,'DELETE FROM sessions WHERE expires<=?',Math.floor(Date.now()/1000)),
    query(env,`INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) SELECT ?,id,?,?,auth_version FROM users
      WHERE id=? AND auth_version=? AND disabled=0 AND (email IS NULL OR email_verified_at IS NOT NULL)`,await sha(value),nonce,Math.floor(Date.now()/1000)+604800,user.id,user.auth_version??0),
    query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')
  ]);
  return json({user:publicUser(user),csrf:nonce},200,{'Set-Cookie':cookie(request,value,604800)});
}
async function authLimit(env,request,identity) {
  await rate(env,'auth-ip:'+await hmac(request.headers.get('CF-Connecting-IP')||'local',env.AUTH_PEPPER),30,900);
  await rate(env,'auth-name:'+await hmac(identity,env.AUTH_PEPPER),15,900);
}
const guard=env=>[query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')];
export async function authRoute(env,request,path,payload) {
  if(path==='/api/auth/config')return json({email_enabled:mailConfigured(env),invitation_required:true,shared_invite:Boolean(env.REGISTRATION_CODE),password_minimum:12,version:'0.4.1'});
  if(path==='/api/auth/me'){const user=await session(env,request,false);return json({user:user?publicUser(user):null,csrf:user?.csrf||''});}
  sameOrigin(request);
  if(path==='/api/auth/send-code') {
    const email=normalizeEmail(payload.email),purpose=payload.purpose;
    check(['register','login','reset','bind'].includes(purpose),'邮件操作无效。');
    if(purpose==='bind') {
      const current=await session(env,request);csrf(request,current);
      const user=await first(env,'SELECT * FROM users WHERE id=?',current.id);
      check(await verifyPassword(payload.current,user.password,env.AUTH_PEPPER),'当前密码错误。',403);
      check(!await first(env,'SELECT id FROM users WHERE email=? AND id<>?',email,user.id),'该邮箱已绑定其他账号。',409);
      return json(await issueCode(env,request,email,purpose,user));
    }
    if(purpose==='register')await validInvite(env,payload.invite);
    const user=await first(env,'SELECT * FROM users WHERE email=?',email);
    const eligible=purpose==='register'?!user:Boolean(user&&!user.disabled);
    return json(await issueCode(env,request,email,purpose,purpose==='register'?null:user,eligible));
  }
  if(path==='/api/auth/login') {
    const email=payload.email?normalizeEmail(payload.email):null;
    const legacy=email?null:text(payload.username,40,'旧账号',true).trim().toLowerCase();
    await authLimit(env,request,email||legacy);
    const user=email?await first(env,'SELECT * FROM users WHERE email=?',email):await first(env,'SELECT * FROM users WHERE username=? AND email IS NULL',legacy);
    const valid=await verifyPassword(payload.password,user?.password,env.AUTH_PEPPER);
    check(valid&&user&&!user.disabled,'邮箱或密码错误。',401);
    if(user.email&&!user.email_verified_at)return json({...await issueCode(env,request,user.email,'login',user),needs_email_verification:true,email:user.email});
    return loginResponse(env,request,user);
  }
  if(path==='/api/auth/register') {
    const setup=typeof payload.setup==='string'&&env.BOOTSTRAP_KEY&&safeEqual(await sha(payload.setup),await sha(env.BOOTSTRAP_KEY));
    if(setup || env.ALLOW_LEGACY_REGISTRATION==='true'&&!mailConfigured(env)) {
      const username=text(payload.username,40,'用户名',true).trim().toLowerCase();
      check(/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username),'旧版用户名格式无效。');await authLimit(env,request,username);
      const invitation=setup?null:await validInvite(env,payload.invite);
      const user={id:uid(),username,display_name:username,role:setup?'admin':'member',auth_version:0};
      try{await execute(env,'INSERT INTO users(id,username,password,role,created_at,invite_hash,display_name) VALUES(?,?,?,?,?,?,?)',user.id,username,await hashPassword(payload.password,env.AUTH_PEPPER),user.role,now(),invitation,username);}
      catch{throw new AppError(409,'无法注册：旧账号已存在、邀请码已用完，或管理员已经创建。');}
      return loginResponse(env,request,user);
    }
    const email=normalizeEmail(payload.email),name=displayName(payload.nickname);
    await authLimit(env,request,email);
    const invitation=await validInvite(env,payload.invite),password=await hashPassword(payload.password,env.AUTH_PEPPER);
    const code=await readCode(env,email,'register',payload);
    const user={id:uid(),username:uid(),display_name:name,email,email_verified_at:now(),role:'member',auth_version:0};
    try{await env.DB.batch([...consumeCode(env,code),query(env,'INSERT INTO users(id,username,password,role,created_at,invite_hash,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?,?)',user.id,user.username,password,'member',now(),invitation,name,email,user.email_verified_at)]);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw new AppError(409,'该邮箱已注册，请使用邮箱登录或找回密码。');throw error;}
    return loginResponse(env,request,user);
  }
  if(path==='/api/auth/email-login' || path==='/api/auth/reset-password') {
    const email=normalizeEmail(payload.email),reset=path.endsWith('/reset-password');
    await authLimit(env,request,email);
    const password=reset?await hashPassword(payload.password,env.AUTH_PEPPER):null;
    const code=await readCode(env,email,reset?'reset':'login',payload);
    const user=await first(env,'SELECT * FROM users WHERE id=? AND email=? AND disabled=0',code.user_id,email);
    check(user&&user.auth_version===code.user_version,'请求已失效，请重新获取验证码。');
    const statements=[...consumeCode(env,code)];
    if(reset)statements.push(query(env,'UPDATE users SET password=?,auth_version=auth_version+1,email_verified_at=COALESCE(email_verified_at,?) WHERE id=? AND auth_version=? AND disabled=0',password,now(),user.id,user.auth_version),...guard(env),query(env,'DELETE FROM sessions WHERE user_id=?',user.id),query(env,'UPDATE email_codes SET used=1 WHERE user_id=?',user.id));
    else statements.push(query(env,'UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=? AND email=? AND auth_version=? AND disabled=0',now(),user.id,email,user.auth_version),...guard(env));
    await env.DB.batch(statements);
    if(reset)return json({ok:true,message:'密码已重设，旧设备已退出。请使用邮箱和新密码登录。'});
    return loginResponse(env,request,{...user,email_verified_at:user.email_verified_at||now()});
  }
  const user=await session(env,request);csrf(request,user);
  if(path==='/api/auth/logout'){await execute(env,'DELETE FROM sessions WHERE hash=?',user.hash);return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});}
  if(path==='/api/auth/profile') {
    const name=displayName(payload.nickname);await execute(env,'UPDATE users SET display_name=? WHERE id=?',name,user.id);
    return json({user:publicUser({...user,display_name:name})});
  }
  if(path==='/api/auth/bind-email') {
    const email=normalizeEmail(payload.email),stored=await first(env,'SELECT * FROM users WHERE id=?',user.id);
    check(await verifyPassword(payload.current,stored.password,env.AUTH_PEPPER),'当前密码错误。',403);
    const code=await readCode(env,email,'bind',payload,user.id);check(code.user_version===stored.auth_version,'请求已失效，请重新发送。');
    try{await env.DB.batch([...consumeCode(env,code),query(env,'UPDATE users SET email=?,email_verified_at=?,auth_version=auth_version+1 WHERE id=? AND auth_version=?',email,now(),user.id,stored.auth_version),...guard(env),query(env,'DELETE FROM sessions WHERE user_id=?',user.id),query(env,'UPDATE email_codes SET used=1 WHERE user_id=?',user.id)]);}
    catch(error){if(String(error.message).includes('UNIQUE'))throw new AppError(409,'该邮箱已绑定其他账号。');throw error;}
    return loginResponse(env,request,{...stored,email,email_verified_at:now(),auth_version:stored.auth_version+1});
  }
  if(path==='/api/auth/password') {
    const stored=await first(env,'SELECT * FROM users WHERE id=?',user.id);
    check(await verifyPassword(payload.current,stored.password,env.AUTH_PEPPER),'原密码错误。',403);
    await env.DB.batch([query(env,'UPDATE users SET password=?,auth_version=auth_version+1 WHERE id=? AND auth_version=?',await hashPassword(payload.password,env.AUTH_PEPPER),user.id,stored.auth_version),...guard(env),query(env,'DELETE FROM sessions WHERE user_id=?',user.id),query(env,'UPDATE email_codes SET used=1 WHERE user_id=?',user.id)]);
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
  }
  check(user.role==='admin','仅管理员可以管理成员。',403);
  if(path==='/api/auth/invite') {
    if(env.REGISTRATION_CODE)return json({invite:env.REGISTRATION_CODE,shared:true,expires:null});
    await rate(env,'invite:'+user.id,20,86400);const value=token(),expires=Math.floor(Date.now()/1000)+7*86400;
    await execute(env,'INSERT INTO invites VALUES(?,?,?,?,?)',await sha(value),1,expires,user.id,now());return json({invite:value,expires,shared:false});
  }
  if(path==='/api/auth/members')return json({members:(await rows(env,'SELECT id,username,display_name,email,email_verified_at,role,disabled,created_at FROM users ORDER BY created_at')).map(member=>({...publicUser(member),disabled:member.disabled,created_at:member.created_at}))});
  if(path==='/api/auth/disable') {
    check(payload.id!==user.id,'不能停用自己。');check(typeof payload.disabled==='boolean','成员状态无效。');
    await env.DB.batch([query(env,'UPDATE users SET disabled=?,auth_version=auth_version+1 WHERE id=? AND role<>?',Number(payload.disabled),payload.id,'admin'),query(env,'DELETE FROM sessions WHERE user_id=?',payload.id),query(env,'UPDATE email_codes SET used=1 WHERE user_id=?',payload.id)]);return json({ok:true});
  }
  throw new AppError(404,'接口不存在。');
}
