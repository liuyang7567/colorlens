import {request,saveBlob} from './transport.mjs';

const labels={purpose:'实验目的',materials:'材料与试剂',procedure:'方案与步骤',results:'结果记录提示',discussion:'讨论与偏差提示'};
const element=id=>document.getElementById(id);
function node(tag,text,className){const result=document.createElement(tag);if(text!==undefined)result.textContent=text;if(className)result.className=className;return result;}
export function mountTemplates(){
  const page=node('section');page.id='templates-page';page.className='workspace-page';page.hidden=true;page.tabIndex=-1;page.setAttribute('aria-labelledby','templates-title');
  page.innerHTML='<div class="dialog-header"><div><h1 id="templates-title">实验模板库</h1><p>从实际实验流程开始，而不是从空白记录开始。</p></div><a href="#notebook" class="button secondary">返回我的实验</a></div><p class="cloud-warning">内置模板只提供记录框架，不替代实际说明书。个人模板仅自己可见；历史记录绑定使用当时的模板版本，后续修改不会回写旧实验。必填字段仅在“完成记录”时校验。</p><div class="cloud-actions"><button id="template-new" class="button primary">新建个人模板</button><button id="template-import" class="button secondary">导入模板 JSON</button><label><input id="template-show-archived" type="checkbox"> 显示已归档模板</label></div><p id="templates-status" role="status" aria-live="polite"></p><div id="template-catalog" class="template-catalog"></div><form id="template-editor" hidden><h2 id="template-editor-heading">编辑模板</h2><p id="template-provenance" class="cloud-status"></p><label id="template-version-label">查看版本<select id="template-version" aria-label="模板历史版本"></select></label><label>模板名称<input id="template-title" maxlength="100" required></label><label>模板说明<textarea id="template-description" rows="2" maxlength="1000"></textarea></label><label>实验类别<select id="template-kind"><option value="course">课程实验</option><option value="research">课题研究</option><option value="general">其他实验</option></select></label><div id="template-sections" class="template-sections"></div><h3>结构化字段（最多 12 个）</h3><p>使用独立字段保存样本批次、单位、货号等信息。英文标识用于保存数据，同一模板内不能重复。</p><div id="template-fields"></div><button id="template-add-field" type="button" class="button secondary">＋ 添加字段</button><label>检查清单（每行一项，最多 16 项；勾选状态仅作记录提醒）<textarea id="template-steps" rows="4" maxlength="2600"></textarea></label><p class="cloud-status">模板修改只在点击“保存”后写入。离开本页再返回会保留当前编辑；关闭窗口前仍请保存。</p><div class="cloud-actions"><button id="template-save" class="button primary" type="submit">保存个人模板</button><button id="template-export" type="button" class="button secondary">导出当前模板 JSON</button></div></form><input id="template-file" type="file" accept=".json,application/json" hidden>';
  document.querySelector('main').append(page);
  const navigation=node('button','实验模板','nav-button');navigation.id='nav-templates';navigation.dataset.view='templates';element('nav-archive').before(navigation);
  const mobile=node('button','实验模板');mobile.dataset.view='templates';document.querySelector('.mobile-nav').append(mobile);
  for(const button of [navigation,mobile])button.onclick=()=>window.ColorLensNotebook.openPage('templates').catch(error=>toast(error.message,true));
  const shortcut=node('button','从模板新建','button secondary');shortcut.type='button';shortcut.onclick=()=>window.ColorLensNotebook.openPage('templates').catch(error=>toast(error.message,true));element('note-new').after(shortcut);
  const bindingPanel=node('section');bindingPanel.id='note-template-binding';bindingPanel.hidden=true;element('note-structured').before(bindingPanel);
  for(const [key,title] of Object.entries(labels)){const label=node('label',title),input=node('textarea');input.id='template-section-'+key;input.rows=3;input.maxLength=6000;label.append(input);element('template-sections').append(label);}
  let catalog=[],editing=null,displayed=null,dirty=false,busy=false,serial=0;
  const status=message=>{element('templates-status').textContent=message;};
  const safe=operation=>Promise.resolve().then(operation).catch(error=>status(error.message));
  function fieldRow(field){
    const row=node('fieldset');row.className='template-field-row';row.dataset.templateDefinition='field';
    row.innerHTML='<legend>模板字段</legend><label>英文标识<input data-key="key" maxlength="40" required></label><label>显示名称<input data-key="label" maxlength="80" required></label><label>类型<select data-key="type"><option value="text">文本</option><option value="number">数值</option><option value="date">日期</option><option value="select">下拉选项</option><option value="checkbox">勾选</option></select></label><label>单位<input data-key="unit" maxlength="30"></label><label>填写说明<input data-key="description" maxlength="240"></label><label>下拉选项（每行一个）<textarea data-key="options" rows="2" maxlength="2500"></textarea></label><label><input data-key="required" type="checkbox"> 完成记录时必填</label><button type="button" class="button secondary">移除此字段</button>';
    const value=field??{key:'field_'+(++serial),label:'新字段',type:'text',unit:'',description:'',options:[],required:false};
    for(const input of row.querySelectorAll('[data-key]')){const current=value[input.dataset.key];if(input.type==='checkbox')input.checked=current===true;else input.value=Array.isArray(current)?current.join('\n'):current??'';}
    row.querySelector('button').onclick=()=>{row.remove();dirty=true;};element('template-fields').append(row);
  }
  function definition(){return {title:element('template-title').value,description:element('template-description').value,kind:element('template-kind').value,sections:Object.fromEntries(Object.keys(labels).map(key=>[key,element('template-section-'+key).value])),fields:[...element('template-fields').children].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(input=>[input.dataset.key,input.type==='checkbox'?input.checked:input.dataset.key==='options'?input.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean):input.value]))),steps:element('template-steps').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)};}
  function canReplace(){if(busy){status('正在处理模板，请稍候。');return false;}return !dirty||confirm('当前模板修改尚未保存，确定放弃当前编辑吗？');}
  function edit(record,asCopy=false,latest=record?.revision){
    displayed=record;editing=record&&!record.builtin&&!record.archived&&!asCopy&&latest===record.revision?record:null;
    const data=record?.definition??{title:'',description:'',kind:'course',sections:{},fields:[],steps:[]};
    element('template-editor').hidden=false;element('template-title').value=data.title+(asCopy?'（副本）':'');element('template-description').value=data.description;element('template-kind').value=data.kind;
    for(const key of Object.keys(labels))element('template-section-'+key).value=data.sections[key]??'';
    element('template-fields').replaceChildren();serial=0;for(const field of data.fields)fieldRow(field);serial=data.fields.length+100;
    element('template-steps').value=data.steps.join('\n');element('template-editor-heading').textContent=editing?'修改模板 · 保存为新版本':'另存个人模板';
    element('template-provenance').textContent=record?`${record.builtin?'内置参考':'个人模板'} · 版本 ${record.revision} · SHA-256 ${record.sha256}${record.archived?' · 已归档（只能另存）':''}`:'新模板 · 保存后才建立第一版';
    element('template-version-label').hidden=!record||record.builtin;const versions=element('template-version');versions.replaceChildren();
    for(let revision=latest??1;revision>=1;revision--){const option=node('option','版本 '+revision);option.value=revision;option.selected=revision===record?.revision;versions.append(option);}
    dirty=false;element('template-editor').scrollIntoView({block:'start',behavior:'smooth'});
  }
  async function createFrom(record){
    if(busy)return;busy=true;try{await window.ColorLensNotebook.flush();const entry=await request('/api/notebook/create',{data:{template_ref:{id:record.id,revision:record.revision}}});await window.ColorLensNotebook.openEntry(entry.id);}finally{busy=false;}
  }
  function renderCatalog(){
    const target=element('template-catalog');target.replaceChildren();
    for(const record of catalog.filter(item=>!item.archived||element('template-show-archived').checked)){
      const article=node('article');article.dataset.templateId=record.id;article.className='template-card';article.append(node('h2',record.definition.title),node('p',record.definition.description),node('small',`${record.builtin?'内置记录框架':'个人模板'} · v${record.revision}${record.archived?' · 已归档':''}`));const actions=node('div');actions.className='cloud-actions';
      const inspect=node('button','查看 / 编辑','button secondary');inspect.type='button';inspect.onclick=()=>{if(canReplace())edit(record);};actions.append(inspect);
      if(!record.archived){const use=node('button','使用模板新建','button primary');use.type='button';use.className+=' template-use';use.onclick=()=>safe(()=>createFrom(record));actions.append(use);}
      if(!record.builtin&&!record.archived){const archive=node('button','归档','button secondary');archive.type='button';archive.onclick=()=>safe(async()=>{if(!confirm('归档后不再用于新建，已有实验和模板历史仍保留。确定归档？'))return;await request('/api/templates/archive',{id:record.id,revision:record.revision});await open();status('已归档；旧实验的模板来源不会改变。');});actions.append(archive);}
      article.append(actions);target.append(article);
    }
  }
  async function open(){status('正在读取内置与个人模板…');catalog=(await request('/api/templates')).items;renderCatalog();status('内置模板可另存修改；个人模板仅当前账号可见。');}
  element('template-new').onclick=()=>{if(canReplace())edit(null);};element('template-show-archived').onchange=renderCatalog;
  element('template-add-field').onclick=()=>{if(element('template-fields').children.length>=12){status('最多 12 个字段。');return;}fieldRow();dirty=true;};
  element('template-editor').addEventListener('input',()=>{dirty=true;});
  element('template-editor').onsubmit=event=>{event.preventDefault();safe(async()=>{if(busy)return;const payload={definition:definition(),...(editing?{id:editing.id,revision:editing.revision}:{})};busy=true;for(const input of element('template-editor').elements)input.disabled=true;try{const record=await request('/api/templates/save',payload);edit(record);await open();status('个人模板已保存为版本 '+record.revision+'；旧实验保持原版本。');}finally{busy=false;for(const input of element('template-editor').elements)input.disabled=false;}});};
  element('template-version').onchange=()=>safe(async()=>{if(!canReplace())return;const latest=catalog.find(item=>item.id===displayed.id)?.revision??displayed.revision;const record=await request('/api/templates/version',{id:displayed.id,revision:Number(element('template-version').value)});edit(record,false,latest);});
  element('template-export').onclick=()=>saveBlob(new Blob([JSON.stringify({schema:'colorlens-template-1',definition:definition(),notice:'模板框架，不包含实际实验结果；导入后建立自己的第一版。'},null,2)],{type:'application/json'}),'ColorLens-template.json');
  element('template-import').onclick=()=>{if(canReplace())element('template-file').click();};
  element('template-file').onchange=()=>safe(async()=>{try{const file=element('template-file').files[0];if(!file)return;if(file.size>200000)throw new Error('请选择 200 KB 以内的模板 JSON。');const value=JSON.parse(await file.text());if(value.schema!=='colorlens-template-1'||!value.definition)throw new Error('不是支持的镜析模板文件。');const record=await request('/api/templates/save',{definition:value.definition});edit(record);await open();status('已导入为自己的新模板 v1，原库和记录没有被覆盖。');}finally{element('template-file').value='';}});
  window.addEventListener('beforeunload',event=>{if(dirty||busy){event.preventDefault();event.returnValue='';}});
  function renderNote(entry){
    bindingPanel.replaceChildren();const binding=entry.data.template_binding;bindingPanel.hidden=!binding;if(!binding)return;
    bindingPanel.append(node('h3','模板字段 · '+binding.definition.title),node('p',`使用版本 ${binding.revision} · ${binding.source==='imported'?'导入来源，未绑定当前模板库':'创建时的模板快照'} · 修改模板库不会更新本记录`,'cloud-status'));
    const fields=node('div');fields.className='template-note-fields';
    for(const field of binding.definition.fields){
      const label=node('label',field.label+(field.unit?'（'+field.unit+'）':'')+(field.required?' · 完成时必填':''));let input;
      if(field.type==='select'){input=node('select');input.append(node('option','请选择'));input.firstChild.value='';for(const value of field.options){const option=node('option',value);option.value=value;input.append(option);}}
      else{input=node('input');input.type=field.type==='number'?'number':field.type==='date'?'date':field.type==='checkbox'?'checkbox':'text';if(field.type==='number')input.step='any';input.maxLength=500;}
      input.dataset.templateField=field.key;input.setAttribute('aria-label',field.label);if(field.type==='checkbox')input.checked=entry.data.template_values[field.key]===true;else input.value=entry.data.template_values[field.key]??'';label.append(input);if(field.description)label.append(node('small',field.description));fields.append(label);
    }
    bindingPanel.append(fields);if(binding.definition.steps.length)bindingPanel.append(node('h3','实验检查清单（提醒，不替代实际操作记录）'));
    for(const [index,step] of binding.definition.steps.entries()){const label=node('label',step);label.className='template-step';const checkbox=node('input');checkbox.type='checkbox';checkbox.dataset.templateStep=index;checkbox.checked=entry.data.template_checks[index]===true;label.prepend(checkbox);bindingPanel.append(label);}
  }
  function readNote(entry){if(!entry?.data.template_binding)return {};return {template_binding:entry.data.template_binding,template_values:Object.fromEntries([...bindingPanel.querySelectorAll('[data-template-field]')].map(input=>[input.dataset.templateField,input.type==='checkbox'?input.checked:input.value])),template_checks:[...bindingPanel.querySelectorAll('[data-template-step]')].map(input=>input.checked)};}
  return {open,renderNote,readNote};
}
