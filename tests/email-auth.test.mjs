import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {hashPassword} from '../src/auth.mjs';
import {normalizeEmail,displayName} from '../src/email.mjs';
import {uid,now} from '../src/common.mjs';

const pepper='email-fixture-pepper-that-is-not-a-real-key-123456';
const password='a long synthetic laboratory password';
const stored=await hashPassword(password,pepper);
function fixture() {
  const DB=localDatabase(),mails=[];
  const env={DB,AUTH_PEPPER:pepper,BOOTSTRAP_KEY:'test-bootstrap-key',RESEND_API_KEY:'mock-mail-key',MAIL_FROM:'Lab <lab@example.test>',REGISTRATION_CODE:'synthetic-invite',MAIL_FETCH:async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');const message=JSON.parse(options.body);mails.push({...message,code:message.text.match(/验证码：(\d{6})/)[1]});return new Response('{"id":"mock-delivery-id"}');}};
  async function call(path,payload,identity={}) {
    const response=await worker.fetch(new Request('https://lab.test'+path,{method:payload===undefined?'GET':'POST',headers:{...payload===undefined?{}:{'Content-Type':'application/json',Origin:'https://lab.test','X-ColorLens-Token':identity.csrf||''},...identity.cookie?{Cookie:identity.cookie}:{}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const identity=result=>({cookie:result.cookie,csrf:result.body.csrf});
  function seed(email='admin@example.test',name='刘洋',role='admin',verified=true){const id=uid();DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),stored,role,now(),name,email,verified?now():null);return id;}
  function releaseCooldown(){DB.raw.prepare("DELETE FROM rate_limits WHERE key LIKE 'mail-minute:%'").run();}
  async function code(email,purpose='register',extra={}){const response=await call('/api/auth/send-code',{email,purpose,invite:env.REGISTRATION_CODE,...extra});assert.equal(response.status,200,JSON.stringify(response.body));return {...response.body,code:mails.at(-1)?.code};}
  async function register(email,name='刘洋'){const challenge=await code(email);const response=await call('/api/auth/register',{email,nickname:name,password,invite:env.REGISTRATION_CODE,challenge_id:challenge.challenge_id,code:challenge.code});assert.equal(response.status,200,JSON.stringify(response.body));return response;}
  return {DB,env,mails,call,identity,seed,releaseCooldown,code,register};
}
test('email migration preserves original account IDs, passwords, roles and ownership',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec(readFileSync(new URL('../migrations/0001_cloud.sql',import.meta.url),'utf8'));
    db.prepare('INSERT INTO users(id,username,password,role,created_at) VALUES(?,?,?,?,?)').run('existing-id','old-admin','old-hash','admin','original-date');
    db.exec(readFileSync(new URL('../migrations/0002_email_accounts.sql',import.meta.url),'utf8'));
    const user=db.prepare('SELECT * FROM users').get();assert.equal(user.id,'existing-id');assert.equal(user.password,'old-hash');assert.equal(user.role,'admin');assert.equal(user.display_name,'old-admin');assert.equal(user.email,null);assert.equal(user.auth_version,0);
  }finally{db.close();}
});
test('emails normalize independently from unrestricted Chinese duplicate nicknames',()=>{
  assert.equal(normalizeEmail('  Student.A+lab@EXAMPLE.COM '),'student.a+lab@example.com');
  assert.equal(displayName(' 刘洋 '),'刘洋');
  for(const address of ['a\r\nb@example.com','a..b@example.com','a@example..com','a@-domain.com','not-mail'])assert.throws(()=>normalizeEmail(address));
  assert.throws(()=>displayName('管理员\u202e'));
});
test('shared invite is server-only and still requires verified email; names confer no admin power',async()=>{
  const app=fixture();try{
    assert.equal((await app.call('/api/auth/send-code',{email:'first@example.test',purpose:'register',invite:'wrong'})).status,400);assert.equal(app.mails.length,0);
    const first=await app.register('first@example.test'),second=await app.register('second@example.test');
    assert.equal(first.body.user.username,'刘洋');assert.equal(second.body.user.username,'刘洋');assert.notEqual(first.body.user.id,second.body.user.id);assert.equal(first.body.user.role,'member');assert.ok(first.body.user.email_verified);
    const visible=await app.call('/api/auth/config');assert.equal(visible.body.shared_invite,true);assert.equal(JSON.stringify(visible.body).includes(app.env.REGISTRATION_CODE),false);
    assert.equal((await app.call('/api/auth/members',{},app.identity(first))).status,403);
    assert.notEqual(app.DB.raw.prepare('SELECT code_hash FROM email_codes LIMIT 1').get().code_hash,app.mails[0].code);
  }finally{app.DB.close();}
});
test('same-name users keep private notes under different IDs and login only by unique email',async()=>{
  const app=fixture();try{
    const first=await app.register('first@example.test'),second=await app.register('second@example.test');
    const entry=await app.call('/api/notebook/create',{data:{title:'private synthetic note'}},app.identity(first));
    assert.equal((await app.call('/api/notebook/entry/'+entry.body.id,undefined,app.identity(second))).status,404);
    assert.equal((await app.call('/api/auth/login',{email:'FIRST@EXAMPLE.TEST',password})).body.user.id,first.body.user.id);
    assert.equal((await app.call('/api/auth/login',{username:'刘洋',password})).status,401);
    app.releaseCooldown();const challenge=await app.code('first@example.test');assert.equal(app.mails.length,2);
    assert.equal((await app.call('/api/auth/register',{email:'first@example.test',nickname:'another',password,invite:app.env.REGISTRATION_CODE,challenge_id:challenge.challenge_id,code:'000000'})).status,400);
  }finally{app.DB.close();}
});
test('registration code is purpose/email-bound, atomic and single use under concurrency',async()=>{
  const app=fixture();try{
    const challenge=await app.code('race@example.test');
    assert.equal((await app.call('/api/auth/email-login',{email:'race@example.test',challenge_id:challenge.challenge_id,code:challenge.code})).status,400);
    assert.equal((await app.call('/api/auth/register',{email:'other@example.test',nickname:'刘洋',password,invite:app.env.REGISTRATION_CODE,challenge_id:challenge.challenge_id,code:challenge.code})).status,400);
    const payload={email:'race@example.test',nickname:'刘洋',password,invite:app.env.REGISTRATION_CODE,challenge_id:challenge.challenge_id,code:challenge.code};
    const results=await Promise.all([app.call('/api/auth/register',payload),app.call('/api/auth/register',payload)]);
    assert.equal(results.filter(result=>result.status===200).length,1);assert.equal(app.DB.raw.prepare('SELECT count(*) AS count FROM users').get().count,1);
    assert.notEqual((await app.call('/api/auth/register',payload)).status,200);
  }finally{app.DB.close();}
});
test('five bad attempts, expiry and resend limits fail closed',async()=>{
  const app=fixture();try{
    const challenge=await app.code('limited@example.test');
    const bad=challenge.code==='000000'?'999999':'000000';
    const payload={email:'limited@example.test',nickname:'test',password,invite:app.env.REGISTRATION_CODE,challenge_id:challenge.challenge_id,code:bad};
    for(let attempt=0;attempt<5;attempt++)assert.equal((await app.call('/api/auth/register',payload)).status,400);
    assert.equal((await app.call('/api/auth/register',{...payload,code:challenge.code})).status,400);
    assert.equal((await app.call('/api/auth/send-code',{email:payload.email,purpose:'register',invite:app.env.REGISTRATION_CODE})).status,429);
    const expired=await app.code('expired@example.test');app.DB.raw.prepare('UPDATE email_codes SET expires=0 WHERE id=?').run(expired.challenge_id);
    assert.equal((await app.call('/api/auth/register',{...payload,email:'expired@example.test',challenge_id:expired.challenge_id,code:expired.code})).status,400);
  }finally{app.DB.close();}
});
test('unverified administrator gets no session until mailbox ownership is proved',async()=>{
  const app=fixture();try{
    const id=app.seed('owner@example.test','刘洋','admin',false);
    const login=await app.call('/api/auth/login',{email:'owner@example.test',password});assert.equal(login.status,200);assert.equal(login.body.needs_email_verification,true);assert.ok(!login.cookie);
    assert.equal((await app.call('/api/auth/me')).body.user,null);
    const verified=await app.call('/api/auth/email-login',{email:'owner@example.test',challenge_id:login.body.challenge_id,code:app.mails.at(-1).code});assert.equal(verified.status,200);assert.equal(verified.body.user.id,id);assert.equal(verified.body.user.role,'admin');
    const invitation=await app.call('/api/auth/invite',{},app.identity(verified));assert.equal(invitation.body.invite,app.env.REGISTRATION_CODE);assert.equal(invitation.body.shared,true);
  }finally{app.DB.close();}
});
test('email OTP login works without password but cannot create unknown accounts or replay',async()=>{
  const app=fixture();try{
    app.seed('known@example.test','同名','member');const challenge=await app.code('known@example.test','login');
    const payload={email:'known@example.test',challenge_id:challenge.challenge_id,code:challenge.code},login=await app.call('/api/auth/email-login',payload);assert.equal(login.status,200);
    assert.equal((await app.call('/api/auth/email-login',payload)).status,400);
    const count=app.mails.length,unknown=await app.code('unknown@example.test','login');assert.equal(app.mails.length,count);assert.equal((await app.call('/api/auth/email-login',{email:'unknown@example.test',challenge_id:unknown.challenge_id,code:'123456'})).status,400);
  }finally{app.DB.close();}
});
test('password recovery revokes existing sessions and outstanding old login codes',async()=>{
  const app=fixture();try{
    app.seed('recover@example.test','学生','member');const login=await app.call('/api/auth/login',{email:'recover@example.test',password});const oldIdentity=app.identity(login);
    const stale=await app.code('recover@example.test','login');app.releaseCooldown();const reset=await app.code('recover@example.test','reset');
    const newPassword='a newly chosen long password';const result=await app.call('/api/auth/reset-password',{email:'recover@example.test',password:newPassword,challenge_id:reset.challenge_id,code:reset.code});assert.equal(result.status,200);
    assert.equal((await app.call('/api/notebook',undefined,oldIdentity)).status,401);
    assert.equal((await app.call('/api/auth/email-login',{email:'recover@example.test',challenge_id:stale.challenge_id,code:stale.code})).status,400);
    assert.equal((await app.call('/api/auth/login',{email:'recover@example.test',password})).status,401);assert.equal((await app.call('/api/auth/login',{email:'recover@example.test',password:newPassword})).status,200);
  }finally{app.DB.close();}
});
test('nickname changes preserve sessions and notes; mailbox change requires current password and a bound code',async()=>{
  const app=fixture();try{
    const id=app.seed('old@example.test','旧昵称','member'),login=await app.call('/api/auth/login',{email:'old@example.test',password}),identity=app.identity(login);
    const entry=await app.call('/api/notebook/create',{data:{title:'retained synthetic record'}},identity);
    const profile=await app.call('/api/auth/profile',{nickname:'刘洋'},identity);assert.equal(profile.body.user.id,id);assert.equal(profile.body.user.username,'刘洋');
    assert.equal((await app.call('/api/auth/send-code',{email:'new@example.test',purpose:'bind',current:'bad'},identity)).status,403);
    const sent=await app.call('/api/auth/send-code',{email:'new@example.test',purpose:'bind',current:password},identity);assert.equal(sent.status,200);
    const bound=await app.call('/api/auth/bind-email',{email:'new@example.test',current:password,challenge_id:sent.body.challenge_id,code:app.mails.at(-1).code},identity);assert.equal(bound.status,200);assert.equal(bound.body.user.id,id);
    assert.equal((await app.call('/api/notebook',undefined,identity)).status,401);assert.equal((await app.call('/api/notebook/entry/'+entry.body.id,undefined,app.identity(bound))).status,200);
    assert.equal((await app.call('/api/auth/login',{email:'old@example.test',password})).status,401);assert.equal((await app.call('/api/auth/login',{email:'new@example.test',password})).status,200);
  }finally{app.DB.close();}
});
test('disabled accounts cannot redeem previously issued email codes',async()=>{
  const app=fixture();try{
    app.seed();const id=app.seed('member@example.test','刘洋','member'),admin=await app.call('/api/auth/login',{email:'admin@example.test',password}),challenge=await app.code('member@example.test','login');
    assert.equal((await app.call('/api/auth/disable',{id,disabled:true},app.identity(admin))).status,200);assert.notEqual((await app.call('/api/auth/email-login',{email:'member@example.test',challenge_id:challenge.challenge_id,code:challenge.code})).status,200);
  }finally{app.DB.close();}
});
test('provider failure invalidates challenge and never leaks raw error or grants a session',async()=>{
  const app=fixture();try{
    app.env.MAIL_FETCH=async()=>new Response('provider-private-error',{status:401});const response=await app.call('/api/auth/send-code',{email:'new@example.test',purpose:'register',invite:app.env.REGISTRATION_CODE});assert.equal(response.status,503);assert.ok(!JSON.stringify(response.body).includes('provider-private-error'));assert.equal(app.DB.raw.prepare('SELECT used FROM email_codes').get().used,1);assert.equal(app.DB.raw.prepare('SELECT count(*) AS count FROM sessions').get().count,0);
  }finally{app.DB.close();}
});
test('password change racing after OTP verification cannot mint a post-reset session',async()=>{
  const app=fixture();try{
    const id=app.seed('race-login@example.test','学生','member'),challenge=await app.code('race-login@example.test','login');
    const original=app.env.DB.batch.bind(app.env.DB);let armed=true;
    app.env.DB.batch=async statements=>{const result=await original(statements);if(armed){armed=false;app.DB.raw.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(id);}return result;};
    const response=await app.call('/api/auth/email-login',{email:'race-login@example.test',challenge_id:challenge.challenge_id,code:challenge.code});assert.equal(response.status,409);assert.ok(!response.cookie);assert.equal(app.DB.raw.prepare('SELECT count(*) AS count FROM sessions').get().count,0);
  }finally{app.DB.close();}
});
test('mailbox change racing a credential reset also refuses stale session creation',async()=>{
  const app=fixture();try{
    const id=app.seed('race-bind@example.test','学生','member'),login=await app.call('/api/auth/login',{email:'race-bind@example.test',password}),identity=app.identity(login);
    const sent=await app.call('/api/auth/send-code',{email:'new-race@example.test',purpose:'bind',current:password},identity),code=app.mails.at(-1).code;
    const original=app.env.DB.batch.bind(app.env.DB);let armed=true;
    app.env.DB.batch=async statements=>{const result=await original(statements);if(armed){armed=false;app.DB.raw.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(id);}return result;};
    const response=await app.call('/api/auth/bind-email',{email:'new-race@example.test',current:password,challenge_id:sent.body.challenge_id,code},identity);assert.equal(response.status,409);assert.ok(!response.cookie);
  }finally{app.DB.close();}
});
