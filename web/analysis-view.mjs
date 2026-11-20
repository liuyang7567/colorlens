import {request} from './transport.mjs';
import {downloadAnalysis} from './archives.mjs';
import {renderQpcrResult} from './qpcr.mjs';
import {renderElisaResult} from './elisa.mjs';

const format=value=>value===null||value===undefined?'—':Array.isArray(value)?value.map(format).join(' / '):typeof value==='number'?String(Number(value.toFixed(5))):String(value);
function appendText(target,tag,value){const node=document.createElement(tag);node.textContent=value;target.append(node);return node;}
function table(target,headings,rows){
  const scroll=document.createElement('div');scroll.className='table-scroll';scroll.tabIndex=0;
  const grid=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),header=document.createElement('tr');
  for(const heading of headings){const cell=appendText(header,'th',heading);cell.scope='col';}
  head.append(header);
  for(const values of rows){const row=document.createElement('tr');for(const value of values)appendText(row,'td',format(value));body.append(row);}
  grid.append(head,body);scroll.append(grid);target.append(scroll);
}
function render(target,record){
  const result=record.result;
  appendText(target,'h3',record.experiment.name||'未命名实验');
  appendText(target,'p',`${result.simulated?'模拟数据 · ':''}${result.assay.name} · ${record.created_at} · ${result.algorithm}`);
  const metadata=document.createElement('dl');metadata.className='analysis-snapshot-meta';
  const labels={date:'实验日期',operator:'操作者',manufacturer:'厂家',catalog_number:'货号',species:'物种',lot:'批号',protocol_version:'说明书版本',device:'设备',lighting:'光照',reaction_time:'反应时间',notes:'备注'};
  for(const [key,label] of Object.entries(labels))if(record.experiment[key]){appendText(metadata,'dt',label);appendText(metadata,'dd',record.experiment[key]);}
  target.append(metadata);
  if(result.measurement==='qpcr'){const section=document.createElement('section');target.append(section);renderQpcrResult(section,result);return;}
  if(result.measurement==='elisa'){const section=document.createElement('section');target.append(section);renderElisaResult(section,result);return;}
  if(record.analysis_type==='instrument'){
    appendText(target,'h3','已保存的重复孔统计');
    appendText(target,'p',`主波长 ${result.wavelength} nm · 参考波长 ${format(result.reference_wavelength)} nm · 统一空白扣除：${result.subtract_blank?'已执行一次':'未执行'}`);
    table(target,['样本','角色','孔数 n','平均 OD','样本 SD','CV %','已知标准浓度','检查提示'],result.groups.map(group=>[group.sample_id,group.role,group.n,group.mean_od,group.sd,group.cv_percent,group.standard_concentration,group.warnings.join('；')]));
    const details=document.createElement('details');appendText(details,'summary','查看已保存的逐孔读数');
    table(details,['样本','孔位','原始 OD','参考 OD','参考校正后 OD','处理后 OD'],result.rows.map(row=>[row.sample_id,row.well,row.od,row.reference_od,row.reference_corrected,row.corrected_od]));target.append(details);
    if(record.instrument_input.unit)appendText(target,'p','已知标准浓度单位：'+record.instrument_input.unit);
  }else{
    appendText(target,'h3','已保存的照片颜色结果');
    appendText(target,'p',`原图 ${result.image.filename} · ${result.image.width} × ${result.image.height} px · SHA-256 ${result.image.sha256}`);
    table(target,['区域','状态','RGB','HSV','Lab','对照 ΔE₀₀','检查提示'],result.results.map(row=>[row.label,{ok:'可用',caution:'需复核',invalid:'不可用'}[row.status]||row.status,row.rgb,row.hsv,row.lab,row.delta_e,row.warnings.join('；')]));
    const details=document.createElement('details');appendText(details,'summary','查看保存的色差矩阵与测量参数');
    table(details,['ΔE₀₀',...result.results.map(row=>row.label)],result.matrix.map((row,index)=>[result.results[index].label,...row]));
    appendText(details,'pre',JSON.stringify({parameters:result.parameters,control_id:result.control_id,rois:result.rois},null,2));target.append(details);
    if(result.closest)appendText(target,'p',`最接近的两组：${result.closest.labels.join(' / ')} · ΔE₀₀ ${format(result.closest.delta_e)}`);
  }
  for(const warning of result.warnings||[])appendText(target,'p',warning);
  if(result.provenance)appendText(target,'p',result.provenance);
  appendText(target,'p',result.disclaimer);
}

export function mountAnalysisView(){
  const view=document.createElement('section');view.id='analysis-record-view';view.className='workspace-page';view.hidden=true;view.tabIndex=-1;view.setAttribute('aria-labelledby','analysis-view-title');
  view.innerHTML='<div class="dialog-header"><h1 id="analysis-view-title">在线查看分析记录</h1><a id="analysis-view-back" class="button secondary" href="#snapshots">返回快照列表</a></div><p class="cloud-warning">默认只读取已保存的结果，不下载 ZIP、不自动加载原图，也不重新计算。需要检查原始数据时再选择“载入工具复核”；保存的原快照不会被覆盖。</p><p id="analysis-view-status" class="cloud-status" role="status" aria-live="polite"></p><div id="analysis-view-content" class="analysis-snapshot"></div><div class="cloud-actions"><button id="analysis-view-review" class="button secondary" disabled>载入工具复核</button><button id="analysis-view-download" class="button secondary" disabled>下载 ZIP（可选）</button></div>';
  document.querySelector('main').append(view);
  const ai=document.createElement('a');ai.id='analysis-view-ai';ai.className='button primary';ai.textContent='用 DeepSeek AI 解读';ai.hidden=true;view.querySelector('.cloud-actions').prepend(ai);
  const content=view.querySelector('#analysis-view-content'),status=view.querySelector('#analysis-view-status'),review=view.querySelector('#analysis-view-review'),download=view.querySelector('#analysis-view-download');
  let current=null,sequence=0;
  const clear=()=>{sequence++;current=null;content.replaceChildren();status.textContent='';review.disabled=true;download.disabled=true;ai.hidden=true;ai.removeAttribute('href');};
  review.onclick=async()=>{
    const record=current;if(!record)return;
    try{await window.ColorLensNotebook.reviewAnalysis(record.id,record.entry_id);}catch(error){toast(error.message,true);}
  };
  download.onclick=async()=>{
    if(!current||download.disabled)return;
    const id=current.id;download.disabled=true;status.textContent='正在按你的选择校验并导出 ZIP…';
    try{await downloadAnalysis(id);if(current?.id===id)status.textContent='ZIP 已交给浏览器下载，请确认保存完成。';}
    catch(error){if(current?.id===id)status.textContent=error.message;}
    finally{if(current?.id===id)download.disabled=false;}
  };
  const open=async id=>{
    const ticket=++sequence;current=null;content.replaceChildren();review.disabled=true;download.disabled=true;ai.hidden=true;status.textContent='正在读取已保存结果，不下载原件…';
    try{
      await window.ColorLensNotebook.flush();
      const record=await request('/api/restore',{id});
      if(ticket!==sequence||view.hidden)return;
      render(content,record);current=record;review.disabled=false;download.disabled=false;
      ai.href='#ai/'+record.entry_id;ai.hidden=false;
      status.textContent=record.analysis_type==='photo'?'云端快照完整性校验通过 · 只读查看 · 未自动加载原图':'云端快照完整性校验通过 · 只读查看 · 未重新计算';
    }catch(error){if(ticket===sequence&&!view.hidden){content.replaceChildren();status.textContent=error.message;}}
  };
  return {open,clear};
}
