import {request} from './transport.mjs';
import {mountAuthStory} from './design-story.mjs';
const element=id=>document.getElementById(id);
const safe=operation=>Promise.resolve().then(operation).catch(error=>toast(error.message,true));

function createDialog(id,title,content) {
  const view=document.createElement('dialog');view.id=id;view.className='cloud-dialog';
  view.innerHTML=`<div class="dialog-header"><h2>${title}</h2><button class="icon-button" type="button" aria-label="关闭">×</button></div>${content}`;
  view.querySelector('button').onclick=()=>view.close();document.body.append(view);return view;
}
function cooldown(button,seconds) {
  const label=button.textContent;button.disabled=true;
  let remaining=seconds;button.textContent=`${remaining} 秒后重发`;
  const timer=setInterval(()=>{remaining--;button.textContent=remaining>0?`${remaining} 秒后重发`:label;if(remaining<=0){clearInterval(timer);button.disabled=false;}},1000);
}
function setWorkspaceInert(locked) {
  for (const area of document.querySelectorAll('.app-shell, .sidebar, .scientific-skip')) area.inert = locked;
}
async function mountGate(accept) {
  const gate=document.createElement('section');gate.id='cloud-auth';gate.className='cloud-gate';
  gate.innerHTML=`<form class="auth-card" id="auth-form"><img src="/favicon.svg" alt="镜析"><div class="eyebrow">COLORLENS</div><h1 id="auth-title">登录镜析</h1><p id="auth-intro">继续记录实验，查看分析与团队协作。</p><input id="auth-mode" type="hidden" value="login"><label id="auth-email-label">邮箱<input id="auth-email" type="email" autocomplete="username" maxlength="254" required placeholder="name@example.com"></label><label id="auth-legacy-label" hidden>旧版登录名<input id="auth-username" autocomplete="username" maxlength="40"></label><label id="auth-nickname-label" hidden>昵称<input id="auth-nickname" autocomplete="nickname" maxlength="40" placeholder="可中文、可重名"></label><label id="auth-password-label"><span id="auth-password-title">密码</span><input id="auth-password" type="password" autocomplete="current-password" maxlength="128" required></label><label id="auth-invite-label" hidden>实验室邀请码<input id="auth-invite" maxlength="100" autocomplete="off"></label><section id="auth-code-section"><label for="auth-code" id="auth-code-title">验证码（选填）</label><div class="auth-code-row"><input id="auth-code" aria-labelledby="auth-code-title" aria-describedby="auth-code-hint" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6 位邮箱验证码"><button class="button secondary" type="button" id="auth-send-code">获取验证码</button></div><p class="auth-code-hint" id="auth-code-hint">留空使用密码；也可填写验证码直接登录。</p></section><button class="button primary full" id="auth-submit">登录</button><p id="auth-status" class="cloud-status" role="status" aria-live="polite"></p><div class="auth-links"><button id="auth-forgot" class="text-button" type="button">找回密码</button><button id="auth-register" class="text-button" type="button">注册账号</button><button id="auth-back-login" class="text-button" type="button" hidden>返回登录</button></div><details class="auth-help" id="auth-help"><summary>旧账号帮助</summary><p>没有绑定邮箱的旧账号可先用原登录名进入，再绑定邮箱。</p><button class="text-button" id="auth-legacy" type="button">使用旧版登录名</button></details><p class="auth-privacy">实验资料按账号隔离保存，AI 分析需另行授权。</p></form>`;
  const card=gate.querySelector('.auth-card');
  const logo=card.querySelector('img');
  const wordmark=card.querySelector('.eyebrow');
  wordmark.className='auth-wordmark';
  wordmark.textContent='镜析 ColorLens';
  logo.alt='';
  wordmark.prepend(logo);
  logo.width=36;logo.height=36;
  for(const input of card.querySelectorAll('input')){input.name=input.id.replace('auth-','');if(['email','code','username','invite'].includes(input.name))input.spellcheck=false;}
  mountAuthStory(gate,wordmark);
  document.body.append(gate);
  setWorkspaceInert(true);
  let challenge=null,verificationRequired=false,generation=0,setup=location.hash.match(/^#setup\/([a-f0-9]{64})$/)?.[1]||'';
  const invitation=location.hash.match(/^#join\/([a-zA-Z0-9_-]{1,100})$/)?.[1];
  if(setup){element('auth-mode').value='setup';history.replaceState(null,'','#notebook');}
  else if(invitation){element('auth-invite').value=invitation;element('auth-mode').value='register';history.replaceState(null,'','#notebook');}
  function modeChanged(clear=true) {
    if(clear){generation++;challenge=null;verificationRequired=false;element('auth-code').value='';element('auth-password').value='';element('auth-status').textContent='';}
    const mode=element('auth-mode').value,legacy=['legacy','setup'].includes(mode),registration=mode==='register',login=mode==='login',code=!legacy,useCode=login&&(verificationRequired||Boolean(element('auth-code').value.trim()));
    element('auth-title').textContent={login:'登录镜析',register:'注册账号',reset:'找回密码',legacy:'旧账号登录',setup:'初始化管理员'}[mode];
    element('auth-intro').textContent={login:'继续记录实验，查看分析与团队协作。',register:'使用实验室邀请码注册，昵称可中文、可重名。',reset:'验证邮箱后设置新密码。',legacy:'登录后可在账号设置中绑定邮箱。',setup:'创建此空间的首个管理员。'}[mode];
    element('auth-email-label').hidden=legacy;element('auth-email').required=!legacy;element('auth-email').disabled=legacy;
    element('auth-legacy-label').hidden=!legacy;element('auth-username').required=legacy;element('auth-username').disabled=!legacy;
    element('auth-nickname-label').hidden=!registration;element('auth-nickname').required=registration;element('auth-nickname').disabled=!registration;
    element('auth-invite-label').hidden=!registration;element('auth-invite').required=registration;element('auth-invite').disabled=!registration;
    element('auth-password').required=!useCode;element('auth-password').minLength=['register','reset','setup'].includes(mode)?12:1;element('auth-password').autocomplete=['register','reset','setup'].includes(mode)?'new-password':'current-password';
    element('auth-password-title').textContent=mode==='reset'?'新密码（至少 12 位）':registration||mode==='setup'?'密码（至少 12 位）':useCode?'密码（验证码登录可不填）':'密码';
    element('auth-code-section').hidden=!code;element('auth-code').required=code&&(!login||verificationRequired);element('auth-code').disabled=!code;
    element('auth-code-title').textContent=login&&!verificationRequired?'验证码（选填）':'邮箱验证码';
    element('auth-code-hint').textContent=verificationRequired?'请填写邮件中的验证码，完成本次邮箱验证。':login?'留空使用密码；也可填写验证码直接登录。':'验证码 10 分钟有效，请在此输入。';
    element('auth-submit').textContent={login:'登录',register:'注册',reset:'重设密码',legacy:'登录旧账号',setup:'创建管理员'}[mode];
    element('auth-forgot').hidden=!login;element('auth-register').hidden=!login;element('auth-back-login').hidden=login||Boolean(setup);element('auth-help').hidden=!login;
  }
  const changeMode=mode=>{element('auth-mode').value=mode;modeChanged();element('auth-title').scrollIntoView({block:'nearest'});};
  element('auth-forgot').onclick=()=>changeMode('reset');element('auth-register').onclick=()=>changeMode('register');element('auth-back-login').onclick=()=>changeMode('login');element('auth-legacy').onclick=()=>changeMode('legacy');
  element('auth-code').addEventListener('input',()=>modeChanged(false));
  element('auth-email').addEventListener('input',()=>{generation++;challenge=null;verificationRequired=false;element('auth-code').value='';modeChanged(false);});
  modeChanged(false);
  function openMailLink(){
    const link=location.hash.match(/^#email-login\/([a-f0-9]{32})\/(.+)$/);if(!link||gate.hidden)return;
    try{generation++;const email=decodeURIComponent(link[2]);element('auth-mode').value='login';element('auth-email').value=email;verificationRequired=true;challenge={id:link[1],email:email.trim().toLowerCase(),purpose:'login'};element('auth-code').value='';element('auth-password').value='';modeChanged(false);element('auth-status').textContent='请填写刚收到的邮箱验证码。';history.replaceState(null,'','#notebook');element('auth-code').focus();}
    catch{element('auth-status').textContent='邮箱验证入口无效，请重新获取验证码。';}
  }
  openMailLink();window.addEventListener('hashchange',openMailLink);
  element('auth-send-code').onclick=async()=>{
    const button=element('auth-send-code');if(!element('auth-email').reportValidity())return;
    const mode=element('auth-mode').value;if(mode==='register'&&!element('auth-invite').reportValidity())return;
    const email=element('auth-email').value.trim().toLowerCase(),purpose=mode==='login'?'login':mode,revision=generation;
    button.disabled=true;element('auth-status').textContent='正在发送验证码…';
    try{const result=await request('/api/auth/send-code',{email,purpose,invite:element('auth-invite').value});cooldown(button,result.retry_after);if(revision!==generation)return;challenge={id:result.challenge_id,email,purpose};element('auth-status').textContent='符合条件时验证码已发送，请检查收件箱或垃圾邮件。';}
    catch(error){if(revision===generation)element('auth-status').textContent=error.message;button.disabled=false;}
  };
  element('auth-form').onsubmit=async event=>{
    event.preventDefault();const button=element('auth-submit'),mode=element('auth-mode').value,email=element('auth-email').value.trim().toLowerCase(),code=element('auth-code').value.trim(),revision=generation;
    button.disabled=true;gate.inert=true;element('auth-status').textContent='正在验证，请稍候…';
    try{
      let result;
      if(mode==='legacy'||mode==='login'&&!code&&!verificationRequired)result=await request('/api/auth/login',{...mode==='legacy'?{username:element('auth-username').value}:{email},password:element('auth-password').value});
      else if(mode==='setup')result=await request('/api/auth/register',{username:element('auth-username').value,password:element('auth-password').value,setup});
      else{const purpose=mode==='login'?'login':mode;if(!challenge||challenge.email!==email||challenge.purpose!==purpose)throw new Error('请先为当前邮箱获取验证码。');const route={login:'email-login',register:'register',reset:'reset-password'}[mode];result=await request('/api/auth/'+route,{email,challenge_id:challenge.id,code,...mode==='login'?{}:{password:element('auth-password').value},...mode==='register'?{nickname:element('auth-nickname').value,invite:element('auth-invite').value}:{}});}
      if(revision!==generation)return;
      if(result.needs_email_verification){verificationRequired=true;challenge={id:result.challenge_id,email:result.email,purpose:'login'};element('auth-password').value='';modeChanged(false);element('auth-status').textContent='首次登录需验证邮箱，验证码已发送，请在上方填写。';cooldown(element('auth-send-code'),result.retry_after);return;}
      element('auth-password').value='';element('auth-code').value='';setup='';
      if(mode==='reset'){changeMode('login');element('auth-status').textContent=result.message;return;}
      accept(result);
    }catch(error){if(revision===generation)element('auth-status').textContent=error.message;}
    finally{button.disabled=false;gate.inert=false;}
  };
  try{const identity=await request('/api/auth/me');if(identity.user)accept(identity);else{const config=await request('/api/auth/config');if(!config.email_enabled)element('auth-status').textContent='邮箱服务暂不可用；已验证账号仍可用密码登录。';}}
  catch(error){element('auth-status').textContent=error.message;}
}

export function mountAccounts(onLogin) {
  let currentUser=null,bindChallenge=null;
  const button=document.createElement('button');button.id='cloud-account';button.className='button secondary cloud-account-button';button.textContent='账号';document.querySelector('.topbar-right').append(button);
  const view=createDialog('account-dialog','账号与联网空间',`<p id="account-name"></p><p id="account-email" class="cloud-status"></p><p class="cloud-warning">昵称可中文、可重名；邮箱是唯一登录标识，数据与权限绑定独立账号 ID。管理员可管理成员登录权限，但应用没有查看他人笔记的入口。</p><h3>修改昵称</h3><form id="nickname-form"><label>昵称<input id="profile-nickname" maxlength="40" required autocomplete="nickname"></label><button class="button secondary">保存昵称</button></form><div id="admin-controls" hidden><h3>邀请实验伙伴</h3><p>注册必须同时持有实验室邀请码，并验证自己的邮箱；同名不会覆盖其他人的记录。</p><button class="button secondary" id="create-invite">查看 / 获取邀请码</button><pre id="invite-output" hidden></pre><h3>成员管理</h3><div class="cloud-members" id="member-list"></div></div><h3>绑定 / 更换登录邮箱</h3><form id="bind-form"><label>新的登录邮箱<input id="bind-email" type="email" required maxlength="254" autocomplete="email"></label><label>当前账号密码<input id="bind-current" type="password" required maxlength="128" autocomplete="current-password"></label><button class="button secondary" type="button" id="bind-send-code">发送新邮箱验证码</button><label>新邮箱收到的验证码<input id="bind-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button class="button secondary">验证并绑定</button></form><h3>更改密码</h3><form id="password-form"><label>当前密码<input id="password-current" type="password" autocomplete="current-password" required maxlength="128"></label><label>新密码（12–128 字符）<input id="password-new" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="button secondary">修改并退出所有设备</button></form><div class="cloud-actions"><button class="button secondary" id="cloud-logout">退出当前账号</button></div><p id="account-status" class="cloud-status" role="status"></p>`);
  const accept=result=>{currentUser=result.user;if(result.csrf)window.COLORLENS.token=result.csrf;element('cloud-auth').hidden=true;button.textContent=currentUser.username+' · 账号';element('account-name').textContent=currentUser.username+(currentUser.role==='admin'?' · 管理员':' · 普通成员');element('account-email').textContent=currentUser.email?currentUser.email+' · '+(currentUser.email_verified?'邮箱已验证':'待验证'):'旧版账号尚未绑定邮箱，请在此验证绑定；已有实验会完整保留。';element('profile-nickname').value=currentUser.username;element('bind-email').value=currentUser.email||'';element('admin-controls').hidden=currentUser.role!=='admin';onLogin({user:currentUser,csrf:window.COLORLENS.token});};
  const status=message=>{element('account-status').textContent=message;};
  async function members(){const result=await request('/api/auth/members',{}),list=element('member-list');list.replaceChildren();for(const user of result.members){const row=document.createElement('div'),label=document.createElement('span');label.textContent=`${user.username} · ${user.email||'旧账号未绑定邮箱'} · ${user.role==='admin'?'管理员':'成员'}${user.disabled?'（已停用）':''}`;row.append(label);if(user.role!=='admin'){const control=document.createElement('button');control.className='text-button';control.textContent=user.disabled?'启用':'停用';control.onclick=()=>safe(async()=>{if(!confirm('确认改变该成员登录权限？不会删除实验资料。'))return;await request('/api/auth/disable',{id:user.id,disabled:!user.disabled});await members();});row.append(control);}list.append(row);}}
  button.onclick=()=>safe(async()=>{await window.ColorLensNotebook.flush();status('');if(currentUser.role==='admin')await members();view.showModal();});
  element('create-invite').onclick=()=>safe(async()=>{const result=await request('/api/auth/invite',{});element('invite-output').textContent=(result.shared?'共享实验室邀请码：':'一次性邀请码：')+result.invite+'\n邀请入口：'+location.origin+'/#join/'+result.invite+'\n'+(result.shared?'可供实验伙伴重复使用；仍需分别验证邮箱。':'7 天有效，仅可使用一次。');element('invite-output').hidden=false;});
  element('nickname-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const result=await request('/api/auth/profile',{nickname:element('profile-nickname').value});accept(result);status('昵称已保存；账号 ID、邮箱和所有实验记录不变。');});};
  element('cloud-logout').onclick=()=>safe(async()=>{await window.ColorLensNotebook.flush();if(window.ColorLensGlasses&&!window.ColorLensGlasses.confirmExit())return;await request('/api/auth/logout',{});location.href='/';});
  element('password-form').onsubmit=event=>{event.preventDefault();safe(async()=>{await window.ColorLensNotebook.flush();await request('/api/auth/password',{current:element('password-current').value,password:element('password-new').value});location.href='/';});};
  for(const id of ['bind-email','bind-current'])element(id).addEventListener('input',()=>{bindChallenge=null;});
  element('bind-send-code').onclick=async()=>{const control=element('bind-send-code');if(!element('bind-email').reportValidity()||!element('bind-current').reportValidity())return;control.disabled=true;try{const result=await request('/api/auth/send-code',{email:element('bind-email').value,purpose:'bind',current:element('bind-current').value});bindChallenge={id:result.challenge_id,email:element('bind-email').value.trim().toLowerCase()};status(result.message);cooldown(control,result.retry_after);}catch(error){status(error.message);control.disabled=false;}};
  element('bind-form').onsubmit=event=>{event.preventDefault();safe(async()=>{const email=element('bind-email').value.trim().toLowerCase();if(!bindChallenge||bindChallenge.email!==email)throw new Error('请先获取当前新邮箱的验证码。');await window.ColorLensNotebook.flush();const result=await request('/api/auth/bind-email',{email,current:element('bind-current').value,challenge_id:bindChallenge.id,code:element('bind-code').value});accept(result);element('bind-current').value='';element('bind-code').value='';bindChallenge=null;status('登录邮箱已绑定，其他设备已退出。原实验记录完整保留。');});};
  safe(()=>mountGate(result => {
    setWorkspaceInert(false);
    accept(result);
  }));
}
