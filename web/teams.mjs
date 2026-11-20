import {request,saveBlob} from './transport.mjs';

const element=id=>document.getElementById(id);
const roleNames={owner:'负责人',editor:'编辑者',reviewer:'评阅者',viewer:'只读成员'};
const statusNames={pending:'待评阅',changes_requested:'需修改',approved:'已通过评阅',withdrawn:'已撤回'};
const fieldNames={title:'实验标题',date:'实验日期',project:'原课程 / 课题',operator:'记录的操作者',kind:'实验类别',tags:'标签',purpose:'目的',materials:'材料',procedure:'步骤',results:'结果',discussion:'讨论',body:'正文',template_fields:'结构化字段'};
function node(tag,text,className){const result=document.createElement(tag);if(text!==undefined)result.textContent=text;if(className)result.className=className;return result;}
function option(value,label){const result=node('option',label);result.value=value;return result;}
function button(label,action,className='button secondary'){const result=node('button',label,className);result.type='button';result.onclick=action;return result;}
function roleSelect(value){const select=node('select');for(const role of ['editor','reviewer','viewer'])select.append(option(role,roleNames[role]));select.value=value;return select;}
export function mountTeams(){
  const page=node('section');page.id='teams-page';page.className='workspace-page';page.hidden=true;page.tabIndex=-1;page.setAttribute('aria-labelledby','teams-title');
  page.innerHTML=`<div class="dialog-header"><div><h1 id="teams-title">团队与评阅</h1><p>私人记录不自动公开；主动提交文字副本，按版本讨论。</p></div><a class="button secondary" href="#notebook">返回我的实验</a></div>
    <p class="cloud-warning">编辑者提交自己的笔记，评阅者给出意见，只读成员仅查看。原附件、正文图片、AI 草稿和修改历史不共享；评阅通过不锁定私人原件，也不是电子签名。团队内的文字可被复制，撤回或移除成员不能收回已复制内容。</p>
    <p id="teams-status" class="cloud-status" role="status" aria-live="polite"></p>
    <div id="team-inbox"></div><div class="team-grid"><form id="team-create-form"><h2>创建团队</h2><label>团队名称<input id="team-name" maxlength="100" required></label><button class="button primary">创建团队</button></form><section><h2>我的团队</h2><label>选择团队<select id="team-select"><option value="">请选择团队</option></select></label><button id="teams-refresh" type="button" class="button secondary">刷新团队与邀请</button></section></div>
    <section id="team-detail" hidden><h2 id="team-heading"></h2><p id="team-role"></p><details><summary>成员与邀请</summary><div id="team-members"></div><form id="team-invite-form" hidden><h3>邀请已验证邮箱的用户</h3><p>邀请在对方的“团队与评阅”页面出现，7 天有效，不发送邮件。新用户仍需先按实验室注册邀请制创建账号，团队邀请不等于注册邀请码。</p><label>对方邮箱<input id="team-invite-email" type="email" maxlength="254" required></label><label>团队角色<select id="team-invite-role"><option value="editor">编辑者</option><option value="reviewer">评阅者</option><option value="viewer">只读成员</option></select></label><button class="button secondary">创建团队邀请</button></form><div id="team-pending-invites"></div></details>
    <form id="team-project-form" hidden><h3>新建项目</h3><label>项目名称<input id="team-project-title" maxlength="100" required></label><label>项目说明<textarea id="team-project-description" rows="2" maxlength="2000"></textarea></label><button class="button secondary">新建项目</button></form>
    <label>项目筛选<select id="team-project-filter"><option value="">全部项目</option></select></label><p id="team-project-description-view"></p><div class="cloud-actions"><button id="team-new-submission" type="button" class="button primary" hidden>提交我的实验文字</button></div>
    <form id="team-submit-form" hidden><h3 id="team-submit-heading">主动提交文字副本</h3><p>仅提交下方预览；引用不会随原笔记自动更新。每次发布新版本会重置为“待评阅”。</p><label>目标团队项目<select id="team-submit-project" required></select></label><div id="team-note-picker"><label>搜索自己的实验<input id="team-note-query" maxlength="200" type="search"></label><button id="team-find-notes" type="button" class="button secondary">搜索已保存笔记</button><label>笔记（最多显示前 40 条，请用标题缩小范围）<select id="team-submit-note" required></select></label></div><button id="team-preview" type="button" class="button secondary">预览将提交的文字</button><div id="team-preview-content"></div><label class="cloud-consent"><input id="team-consent" type="checkbox"> 我有权将以上文字提交给当前团队的所有成员，并了解团队角色与成员今后可能变更。</label><div class="cloud-actions"><button id="team-publish" class="button primary" disabled>确认提交文字副本</button><button id="team-cancel-submit" type="button" class="button secondary">取消</button></div></form>
    <h3>项目提交</h3><div id="team-submissions" class="template-catalog"></div>
    <section id="team-record" hidden><div class="dialog-header"><h2 id="team-record-title"></h2><button id="team-record-refresh" type="button" class="button secondary">刷新此提交</button></div><p id="team-record-meta"></p><label id="team-version-label">查看提交版本<select id="team-version"></select></label><div id="team-record-content"></div><div class="cloud-actions"><button id="team-update" type="button" class="button secondary" hidden>从我的原笔记发布新版本</button></div><form id="team-comment-form" hidden><label>评语 / 撤回说明（最多 2000 字，按所示版本保存）<textarea id="team-comment" rows="4" maxlength="2000" required></textarea></label><div class="cloud-actions"><button id="team-comment-send" class="button secondary" type="submit">添加评论</button><button id="team-review-changes" type="button" class="button secondary" hidden>要求修改</button><button id="team-review-approve" type="button" class="button primary" hidden>通过评阅</button><button id="team-withdraw" type="button" class="button secondary" hidden>撤回此提交</button></div></form><h3>按版本保留的动态</h3><div id="team-events"></div></section></section>`;
  document.querySelector('main').append(page);
  const navigation=button('团队与评阅',()=>window.ColorLensNotebook.openPage('teams').catch(error=>toast(error.message,true)),'nav-button');navigation.id='nav-teams';navigation.dataset.view='teams';element('nav-archive').before(navigation);
  const mobile=button('团队与评阅',navigation.onclick);mobile.dataset.view='teams';document.querySelector('.mobile-nav').append(mobile);
  let current=null,record=null,prepared=null,updating=null,userId=null,busy=false,dirty=false,displayedVersion=null;
  const status=value=>{element('teams-status').textContent=value;};
  const mayReplace=()=>!busy&&(!dirty||confirm('团队页面有尚未提交的输入。确定放弃这些输入并切换吗？'));
  async function run(operation){if(busy)return;busy=true;page.inert=true;try{await operation();}catch(error){status(error.message);toast(error.message,true);}finally{busy=false;page.inert=false;}}
  function clearPrepared(){prepared=null;element('team-consent').checked=false;element('team-publish').disabled=true;element('team-preview-content').replaceChildren();}
  function renderText(target,snapshot){
    target.replaceChildren();if(!snapshot){target.append(node('p','已撤回：不再显示提交正文或历史版本。团队内已复制的内容无法远程收回。'));return;}
    target.append(node('p',snapshot.notice,'cloud-warning'),node('p',`私人原件版本 ${snapshot.source_revision} · 提交于 ${snapshot.submitted_at}`));
    for(const [key,value] of Object.entries(snapshot.data)){
      if(value===''||value===null||value===undefined)continue;
      target.append(node('h3',fieldNames[key]??key),node('pre',key==='template_fields'?value.map(field=>`${field.label}${field.unit?'（'+field.unit+'）':''}：${String(field.value)}`).join('\n'):Array.isArray(value)?value.join('、'):String(value)));
    }
  }
  function renderSubmissions(){
    const target=element('team-submissions'),projectId=element('team-project-filter').value;target.replaceChildren();element('team-project-description-view').textContent=current.projects.find(project=>project.id===projectId)?.description??'';
    for(const item of current.submissions.filter(item=>!projectId||item.project_id===projectId)){
      const article=node('article',undefined,'template-card');article.dataset.submissionId=item.id;
      article.append(node('h3',item.title),node('p',`${current.projects.find(project=>project.id===item.project_id)?.title??'项目'} · 提交者 ${memberName(item.owner)} · v${item.version} · ${statusNames[item.status]}`),button('在线查看 / 评阅',()=>{if(mayReplace())run(()=>loadRecord(item.id));}));target.append(article);
    }
    if(!target.children.length)target.append(node('p','此项目还没有提交。私人实验不会自动出现在这里。'));
  }
  function memberName(id){return (current.members.find(member=>member.id===id)?.name??'已移除成员')+' · '+id.slice(0,8);}
  async function loadTeam(id){
    const result=await request('/api/teams/detail',{team_id:id});current=result;record=null;dirty=false;clearPrepared();element('team-detail').hidden=false;element('team-record').hidden=true;element('team-submit-form').hidden=true;element('team-select').value=id;renderTeam();status('团队资料已读取；只包含主动提交的文字。');
  }
  function renderTeam(){
    element('team-heading').textContent=current.name;element('team-role').textContent='我的角色：'+roleNames[current.role]+'。同名用户用独立账号编号区分，平台管理员并不自动获得团队访问权限。';
    const owner=current.role==='owner',editor=['owner','editor'].includes(current.role);element('team-invite-form').hidden=!owner;element('team-project-form').hidden=!editor;element('team-new-submission').hidden=!editor||!current.projects.length;
    const members=element('team-members');members.replaceChildren();
    for(const member of current.members){
      const row=node('div',undefined,'team-member');row.append(node('span',`${memberName(member.id)} · ${roleNames[member.role]}${member.disabled?' · 账号已停用':''}`));
      if(owner&&member.role!=='owner'){
        const select=roleSelect(member.role);select.setAttribute('aria-label','成员角色 '+member.id.slice(0,8));row.append(select,button('保存角色',()=>run(async()=>{await request('/api/teams/member',{team_id:current.id,user_id:member.id,role:select.value});await loadTeam(current.id);status('角色已更新，后续请求立即按新角色鉴权。');})),button('移除成员',()=>run(async()=>{if(!confirm('移除后该用户不能再访问团队，已复制的文字不会被收回。确定移除？'))return;await request('/api/teams/member',{team_id:current.id,user_id:member.id,role:'remove'});await loadTeam(current.id);})));}
      members.append(row);
    }
    const pending=element('team-pending-invites');pending.replaceChildren();
    for(const invite of current.invites){const row=node('p',`${invite.email} · ${roleNames[invite.role]} · 到期 ${new Date(invite.expires*1000).toLocaleDateString()}`);row.append(button('取消邀请',()=>run(async()=>{await request('/api/teams/cancel',{team_id:current.id,invite_id:invite.id});await loadTeam(current.id);})));pending.append(row);}
    for(const id of ['team-project-filter','team-submit-project']){const select=element(id),old=select.value;select.replaceChildren();if(id==='team-project-filter')select.append(option('','全部项目'));for(const project of current.projects)select.append(option(project.id,project.title));if([...select.options].some(item=>item.value===old))select.value=old;}
    renderSubmissions();
  }
  async function open(){
    const result=await request('/api/teams');userId=result.user_id;const select=element('team-select');select.replaceChildren(option('','请选择团队'));for(const team of result.items)select.append(option(team.id,team.name+' · '+roleNames[team.role]));if(current)select.value=current.id;
    const inbox=element('team-inbox');inbox.replaceChildren();for(const invite of result.invites){const row=node('p',`团队邀请：${invite.name} · ${roleNames[invite.role]} · 7 天内接受`);row.append(button('接受邀请',()=>{if(mayReplace())run(async()=>{await request('/api/teams/accept',{invite_id:invite.id});dirty=false;await open();await loadTeam(invite.team_id);});}));inbox.append(row);}
    if(current&&!result.items.some(team=>team.id===current.id)){current=null;record=null;element('team-detail').hidden=true;status('原团队已不可访问，页面中的团队内容已收起。');}
    else if(current&&!dirty)await loadTeam(current.id);
    else status('选择团队，或创建新的实验室团队。团队邀请不会发送邮件。');
  }
  async function loadRecord(id,version){
    const value=await request('/api/teams/submission',{id,...version?{version}:{}});record=value;dirty=false;element('team-comment').value='';element('team-record').hidden=false;element('team-record-title').textContent=value.title;
    const displayed=version??value.version,latest=displayed===value.version,active=value.status!=='withdrawn';displayedVersion=displayed;element('team-record-meta').textContent=`${statusNames[value.status]} · 当前提交 v${value.version} · 正在查看 v${displayed} · SHA-256 ${value.sha256??'已撤回'}`;
    const select=element('team-version');select.replaceChildren();for(const item of value.versions)select.append(option(item.version,'版本 '+item.version+' · '+item.created_at));select.value=String(displayed);element('team-version-label').hidden=!active;
    renderText(element('team-record-content'),value.snapshot);const own=value.owner===userId,owner=current.role==='owner',comment=['owner','editor','reviewer'].includes(current.role),review=['owner','reviewer'].includes(current.role)&&!own;
    element('team-comment-form').hidden=!active||!latest||!(comment||own);element('team-comment-send').hidden=!comment;element('team-review-changes').hidden=element('team-review-approve').hidden=!review;element('team-withdraw').hidden=!(own||owner);element('team-update').hidden=!own||!active||!latest||!['owner','editor'].includes(current.role);
    const target=element('team-events');target.replaceChildren();for(const event of value.events){const article=node('article',undefined,'team-event');article.append(node('strong',`${event.actor_name} · ${event.owner.slice(0,8)} · v${event.version} · ${statusNames[event.kind]??(event.kind==='submit'?'提交':'评论')}`),node('small',event.created_at),node('pre',event.text));target.append(article);}
    element('team-record').scrollIntoView({block:'start'});status('正在查看团队文字副本；没有读取原附件或 AI。');
  }
  async function findNotes(){const result=await request('/api/notebook?'+new URLSearchParams({q:element('team-note-query').value,offset:'0'}));const select=element('team-submit-note');select.replaceChildren(option('','请选择笔记'));for(const entry of result.entries)select.append(option(entry.id,entry.data.title+' · 原件 v'+entry.revision));clearPrepared();status('读取了 '+result.entries.length+' / '+result.total+' 条符合条件的已保存笔记。');}
  async function beginSubmit(update=null){updating=update;clearPrepared();element('team-submit-form').hidden=false;element('team-submit-heading').textContent=update?'向同一项目发布新版本':'主动提交文字副本';element('team-note-picker').hidden=Boolean(update);element('team-submit-note').required=!update;element('team-submit-project').disabled=Boolean(update);if(update)element('team-submit-project').value=update.project_id;else{if(element('team-project-filter').value)element('team-submit-project').value=element('team-project-filter').value;await findNotes();}element('team-submit-form').scrollIntoView({block:'start'});}
  element('teams-refresh').onclick=()=>{if(mayReplace())run(async()=>{dirty=false;await open();});};
  element('team-select').onchange=()=>{const id=element('team-select').value;if(!mayReplace()){element('team-select').value=current?.id??'';return;}if(id)run(()=>loadTeam(id));else{current=null;element('team-detail').hidden=true;}};
  element('team-create-form').onsubmit=event=>{event.preventDefault();run(async()=>{const result=await request('/api/teams/create',{name:element('team-name').value});element('team-create-form').reset();dirty=false;await open();await loadTeam(result.id);});};
  element('team-invite-form').onsubmit=event=>{event.preventDefault();run(async()=>{await request('/api/teams/invite',{team_id:current.id,email:element('team-invite-email').value,role:element('team-invite-role').value});element('team-invite-form').reset();await loadTeam(current.id);status('已创建团队内邀请；对方登录后进入“团队与评阅”接受，不会发送邮件。');});};
  element('team-project-form').onsubmit=event=>{event.preventDefault();run(async()=>{const created=await request('/api/teams/project',{team_id:current.id,title:element('team-project-title').value,description:element('team-project-description').value});element('team-project-form').reset();await loadTeam(current.id);element('team-project-filter').value=created.id;renderSubmissions();});};
  element('team-project-filter').onchange=renderSubmissions;
  element('team-new-submission').onclick=()=>{if(mayReplace())run(()=>beginSubmit());};element('team-update').onclick=()=>{if(mayReplace())run(()=>beginSubmit(record));};
  element('team-find-notes').onclick=()=>run(findNotes);
  for(const id of ['team-submit-note','team-submit-project'])element(id).onchange=clearPrepared;
  element('team-preview').onclick=()=>run(async()=>{prepared=await request('/api/teams/preview',{project_id:element('team-submit-project').value,entry_id:updating?.source_id??element('team-submit-note').value});element('team-consent').checked=false;element('team-publish').disabled=true;renderText(element('team-preview-content'),prepared.snapshot);status('请核对预览文字，确认后再提交。');});
  element('team-consent').onchange=()=>{element('team-publish').disabled=!prepared||!element('team-consent').checked;};
  element('team-cancel-submit').onclick=()=>{if(!mayReplace())return;clearPrepared();updating=null;element('team-submit-form').hidden=true;dirty=false;};
  element('team-submit-form').onsubmit=event=>{event.preventDefault();run(async()=>{if(!prepared||!element('team-consent').checked)throw new Error('请先预览并确认本次提交。');const saved=await request('/api/teams/submit',{...updating?{id:updating.id,revision:updating.revision}:{},entry_id:prepared.entry_id,entry_revision:prepared.entry_revision,project_id:element('team-submit-project').value,consent:true});await loadTeam(current.id);await loadRecord(saved.id);status('文字副本已提交；私人笔记与原始文件保持私有。');});};
  async function recordAction(action,decision){
    if(!element('team-comment-form').reportValidity())return;
    if(action==='withdraw'&&!confirm('撤回后团队不再显示正文与历史版本，但不能收回已复制的内容。确定撤回？'))return;
    const result=await request('/api/teams/'+action,{id:record.id,revision:record.revision,text:element('team-comment').value,...decision?{status:decision}:{}});await loadTeam(current.id);await loadRecord(result.id);status(action==='withdraw'?'已撤回；私人原件未改变。':'已保存到提交 v'+result.version+' 的团队动态。');
  }
  element('team-comment-form').onsubmit=event=>{event.preventDefault();run(()=>recordAction('comment'));};element('team-review-changes').onclick=()=>run(()=>recordAction('review','changes_requested'));element('team-review-approve').onclick=()=>run(()=>recordAction('review','approved'));element('team-withdraw').onclick=()=>run(()=>recordAction('withdraw'));
  element('team-record-refresh').onclick=()=>{if(mayReplace())run(()=>loadRecord(record.id));};element('team-version').onchange=()=>{const version=Number(element('team-version').value);if(mayReplace())run(()=>loadRecord(record.id,version));else element('team-version').value=String(displayedVersion);};
  const exportButton=button('导出此提交 JSON',()=>run(async()=>{const archive=await request('/api/teams/archive',{id:record.id});saveBlob(new Blob([JSON.stringify(archive,null,2)],{type:'application/json'}),'ColorLens-team-submission-'+record.id+'.json');status('已主动导出此提交的文字版本与动态；不是全团队备份。');}));exportButton.id='team-record-export';element('team-record-refresh').after(exportButton);
  page.addEventListener('input',event=>{if(event.target.closest('form')&&event.target.id!=='team-note-query')dirty=true;});
  window.addEventListener('beforeunload',event=>{if(dirty||busy){event.preventDefault();event.returnValue='';}});
  return {open};
}
