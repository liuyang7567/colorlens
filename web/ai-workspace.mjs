import {request} from './transport.mjs';

export function mountAiWorkspace(){
  const page=document.createElement('section');page.id='ai-page';page.className='workspace-page';page.hidden=true;page.tabIndex=-1;page.setAttribute('aria-labelledby','ai-page-title');
  page.innerHTML = `
    <header class="dialog-header">
      <div><h1 id="ai-page-title">AI 分析</h1><p>用 DeepSeek 解读结果、排查异常或起草实验报告。</p></div>
      <a class="button secondary" href="#notebook">返回我的实验</a>
    </header>
    <div class="ai-workspace-body">
      <section class="ai-entry-panel">
        <h2>选择实验记录</h2>
        <div class="cloud-actions ai-search-row">
          <label class="ai-entry-search">搜索我的实验<input id="ai-entry-search" type="search" maxlength="200" placeholder="输入标题、正文或标签…"></label>
          <button id="ai-entry-refresh" type="button" class="button secondary">搜索</button>
        </div>
        <label>当前账号的实验<select id="ai-entry-select" disabled><option value="">正在读取…</option></select></label>
        <p id="ai-entry-status" class="cloud-status" role="status"></p>
        <div class="cloud-actions" id="ai-entry-pagination" hidden>
          <button id="ai-entry-prev" class="button secondary" disabled>上一页</button>
          <button id="ai-entry-next" class="button secondary" disabled>下一页</button>
        </div>
        <div class="cloud-actions"><button id="ai-entry-open" class="button primary" disabled>打开 AI 助手</button><a class="button secondary" href="#notebook">去记录实验</a></div>
      </section>
      <aside class="ai-service-details">
        <h2>服务状态</h2><p id="ai-service-status" class="cloud-status" role="status">正在检查服务端配置…</p>
        <h2>发送前确认</h2><p>选择文字、数值快照或图片，预览内容并授权本次发送。图片需要单独授权。AI 草稿保存在实验记录旁，可随时核对原始结果。</p>
      </aside>
    </div>`;
  document.querySelector('main').append(page);
  const element=id=>page.querySelector('#'+id),search=element('ai-entry-search'),select=element('ai-entry-select'),status=element('ai-entry-status'),launch=element('ai-entry-open');
  let offset=0,sequence=0,preferred=null;
  async function list(){
    const ticket=++sequence;launch.disabled=true;select.disabled=true;element('ai-entry-prev').disabled=true;element('ai-entry-next').disabled=true;status.textContent='正在读取当前账号的实验…';
    try{
      const query=new URLSearchParams({q:search.value.trim(),offset:String(offset)}),result=await request('/api/notebook?'+query);
      if(ticket!==sequence)return;
      select.replaceChildren(new Option('请选择一条实验记录',''));
      for(const entry of result.entries)select.add(new Option(entry.data.title+' · '+entry.data.date+' · '+(entry.data.status==='complete'?'已完成':'进行中'),entry.id));
      if(preferred&&!result.entries.some(entry=>entry.id===preferred)){
        const entry=await request('/api/notebook/entry/'+preferred);
        if(ticket!==sequence)return;
        if(!entry.deleted)select.add(new Option(entry.data.title+' · 当前选择',entry.id));
      }
      select.value=preferred||'';preferred=null;select.disabled=select.options.length<2;launch.disabled=!select.value;
      element('ai-entry-prev').disabled=offset===0;element('ai-entry-next').disabled=offset+40>=result.total;
      element('ai-entry-pagination').hidden = offset === 0 && result.total <= 40;
      status.textContent=result.total?`找到 ${result.total} 条实验，本页 ${result.entries.length} 条。选择后可查看该实验的 AI 历史，不会自动发起付费请求。`:search.value.trim()?'没有找到匹配的实验，请修改搜索条件。':'暂无实验。请先记录实验或在分析工具中保存一次结果，再回来选择。';
    }catch(error){if(ticket===sequence){select.replaceChildren(new Option('读取失败，请搜索 / 刷新重试',''));status.textContent=error.message;}}
  }
  select.onchange=()=>{launch.disabled=!select.value;};
  const refresh=()=>{offset=0;preferred=null;return list();};
  element('ai-entry-refresh').onclick=refresh;search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();refresh();}});
  element('ai-entry-prev').onclick=()=>{offset=Math.max(0,offset-40);list();};element('ai-entry-next').onclick=()=>{offset+=40;list();};
  launch.onclick=async()=>{
    if(!select.value||launch.disabled)return;
    const id=select.value;launch.disabled=true;
    try{await window.ColorLensNotebook.openEntry(id);document.getElementById('note-ai').click();}
    catch(error){status.textContent=error.message;}
    finally{launch.disabled=!select.value;}
  };
  async function service(){
    element('ai-service-status').textContent='正在检查服务端配置…';
    try{const result=await request('/api/ai/status',{});element('ai-service-status').textContent=(result.configured?'服务端已配置 DeepSeek':'服务端尚未配置 DeepSeek，请联系管理员')+` · ${result.model} · 今日账号 ${result.user_used}/${result.user_limit} 次，全站 ${result.global_used}/${result.global_limit} 次（UTC 日期）。配置状态不代表本次请求一定成功。`;}
    catch(error){element('ai-service-status').textContent='服务状态读取失败：'+error.message;}
  }
  return {async open(id){offset=0;preferred=id||window.ColorLensNotebook.getEntry()?.id||null;search.value='';await Promise.all([list(),service()]);}};
}
