import {elisaAssays} from '../src/elisa.mjs';
import {saveBlob} from './transport.mjs';

const element=id=>document.getElementById('elisa-'+id);
const number=value=>value===null||value===undefined?'—':typeof value==='number'?String(Number(value.toPrecision(7))):String(value);
function append(target,tag,value){const node=document.createElement(tag);if(value!==undefined)node.textContent=value;target.append(node);return node;}
function table(target,headings,rows){
  const scroll=append(target,'div');scroll.className='table-scroll';scroll.tabIndex=0;const grid=append(scroll,'table'),head=append(grid,'thead'),header=append(head,'tr'),body=append(grid,'tbody');
  for(const title of headings)append(header,'th',title).scope='col';for(const values of rows){const row=append(body,'tr');for(const value of values)append(row,'td',number(value));}
}
const svgNamespace='http://www.w3.org/2000/svg';
function svgNode(parent,tag,attributes={},value){const node=document.createElementNS(svgNamespace,tag);for(const [key,current] of Object.entries(attributes))node.setAttribute(key,current);if(value!==undefined)node.textContent=value;parent.append(node);return node;}
function chart(target,result){
  const curve=result.curve,viewport=append(target,'div');viewport.className='qpcr-chart-viewport';viewport.tabIndex=0;
  const svg=svgNode(viewport,'svg',{width:760,height:390,viewBox:'0 0 760 390',role:'img','aria-label':'ELISA 本批次标准曲线、标准均值点与未知样本上板浓度'});
  svgNode(svg,'title',{},(result.simulated?'模拟数据 · ':'')+result.assay.name+' '+result.model.toUpperCase());svgNode(svg,'metadata',{},JSON.stringify({algorithm:result.algorithm,formula:result.formula,unit:result.unit,curve,samples:result.groups.filter(group=>group.dilution!==null)}));
  svgNode(svg,'rect',{width:760,height:390,fill:'#ffffff'});
  const minimum=Math.log10(curve.positive_min_concentration),maximum=Math.log10(curve.max_concentration),minY=Math.min(...curve.points.map(point=>Math.min(point.mean_od,point.fitted_od))),maxY=Math.max(...curve.points.map(point=>Math.max(point.mean_od,point.fitted_od))),range=maxY-minY;
  const xPosition=value=>100+(Math.log10(value)-minimum)/(maximum-minimum)*620,yPosition=value=>300-(value-minY+range*0.06)/(range*1.12)*240;
  const style={'font-family':'Arial, Microsoft YaHei, sans-serif','font-size':12,fill:'#234335'};
  svgNode(svg,'text',{...style,x:100,y:26,'font-size':17},(result.simulated?'模拟数据 · ':'')+result.assay.name+' · '+result.model.toUpperCase());
  svgNode(svg,'text',{...style,x:100,y:48},'实心点＝标准浓度均值；空心点＝范围内样本；横轴为上板浓度（未乘稀释倍数）');
  for(let tick=0;tick<=4;tick++){
    const concentration=10**(minimum+(maximum-minimum)*tick/4),response=minY+range*tick/4,position=yPosition(response);
    svgNode(svg,'line',{x1:100,y1:position,x2:720,y2:position,stroke:'#e1e8df'});svgNode(svg,'text',{...style,x:88,y:position+4,'text-anchor':'end'},String(Number(response.toPrecision(3))));
    svgNode(svg,'text',{...style,x:xPosition(concentration),y:324,'text-anchor':'middle'},String(Number(concentration.toPrecision(3))));
  }
  const path=[];for(let index=0;index<=120;index++){const concentration=10**(minimum+(maximum-minimum)*index/120),response=curve.A+(curve.D-curve.A)/(1+(curve.C/concentration)**curve.B)**curve.G;path.push((index?'L':'M')+xPosition(concentration)+','+yPosition(response));}
  svgNode(svg,'path',{d:path.join(' '),fill:'none',stroke:'#315d49','stroke-width':2});
  for(const point of curve.points.filter(point=>point.concentration>0)){const circle=svgNode(svg,'circle',{cx:xPosition(point.concentration),cy:yPosition(point.mean_od),r:4,fill:'#315d49'});svgNode(circle,'title',{},'标准 '+point.concentration+' '+result.unit+'；n='+point.n+'；OD='+number(point.mean_od));}
  for(const group of result.groups.filter(group=>group.curve_concentration>=curve.positive_min_concentration&&group.curve_concentration!==null)){const circle=svgNode(svg,'circle',{cx:xPosition(group.curve_concentration),cy:yPosition(group.mean_od),r:5,fill:'#ffffff',stroke:'#b77639','stroke-width':2});svgNode(circle,'title',{},group.sample_id+' 上板浓度 '+number(group.curve_concentration)+' '+result.unit);}
  svgNode(svg,'text',{...style,x:12,y:58},'处理后 OD');svgNode(svg,'text',{...style,x:100,y:353},'标准浓度（'+result.unit+'），log₁₀ 横轴；零标准见表，不放在对数轴上。');
  svgNode(svg,'text',{...style,x:100,y:376},'零标准与对数轴显示范围外的样本见表；不输出显著性或定量有效性结论。');
  const button=append(target,'button','导出标准曲线 SVG');button.type='button';button.className='button secondary';button.onclick=()=>saveBlob(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml;charset=utf-8'}),'ColorLens-ELISA-'+result.assay.id+'.svg');
}
export function renderElisaResult(target,result){
  target.replaceChildren();target.classList.add('qpcr-output');append(target,'h3',result.model.toUpperCase()+' 标准曲线与未知浓度');append(target,'p',result.formula);
  append(target,'p',`${result.simulated?'模拟数据 · ':''}浓度单位：${result.unit}；方向：${result.curve_direction==='increasing'?'随浓度增加而升高':'随浓度增加而降低'}；主 / 参考波长：${result.wavelength} / ${result.reference_wavelength??'无'} nm；统一空白扣除：${result.subtract_blank?'已执行一次':'未执行'}。`);
  append(target,'p','每个标准浓度的平均 OD 等权拟合。各样本先平均技术孔 OD，再反算上板浓度，最后乘用户填写的稀释倍数；不同稀释请使用不同样本 ID。');
  chart(target,result);
  const curve=result.curve;table(target,['A（左端）','D（右端）','C（尺度）','B','G','R²','OD RMSE','标准浓度区间'],[[curve.A,curve.D,curve.C,curve.B,curve.G,curve.r_squared,curve.rmse,`${curve.min_concentration}–${curve.max_concentration} ${result.unit}`]]);
  const status={within_standard_range:'标准区间内（不等于定量合格）',below_standard_range:'低于标准区间',above_standard_range:'高于标准区间',not_invertible:'无法稳定反算'};
  append(target,'h3','样本与对照结果');table(target,['样本 ID','角色','技术孔数','平均 OD','OD SD','OD CV %','稀释倍数','上板浓度','稀释换算浓度（'+result.unit+'）','范围提示','检查提示'],result.groups.filter(group=>group.dilution!==null).map(group=>[group.sample_id,group.role==='control'?'对照':'样本',group.n,group.mean_od,group.sd,group.cv_percent,group.dilution,group.curve_concentration,group.concentration,status[group.range_status],group.warnings.join('；')]));
  append(target,'h3','标准品反算与残差');table(target,['已知浓度','技术孔数','平均 OD','拟合 OD','残差 OD','反算浓度','反算 / 已知 %（非合格判定）'],curve.points.map(point=>[point.concentration,point.n,point.mean_od,point.fitted_od,point.residual,point.back_calculated_concentration,point.recovery_percent]));
  const details=append(target,'details');append(details,'summary','查看全部原始读数与校正');table(details,['样本','角色','孔位','原始 OD','参考 OD','参考校正后 OD','空白处理后 OD'],result.rows.map(row=>[row.sample_id,row.role,row.well,row.od,row.reference_od,row.reference_corrected,row.corrected_od]));
  for(const warning of result.warnings)append(target,'p',warning);append(target,'p',result.disclaimer);
}
export function mountElisa(){
  const selector=document.createElement('section');selector.id='elisa-selector';selector.className='panel qpcr-workspace';selector.hidden=true;
  selector.innerHTML='<h3>ELISA 分析方式</h3><label>选择用途<select id="elisa-mode"><option value="od">仅整理 OD 与技术重复（原功能）</option><option value="curve">本批次标准曲线定量 · 4PL / 5PL</option></select></label><p>曲线定量需要实际标准品、明确的浓度单位和样本稀释倍数；不能用照片代替仪器 OD。</p>';
  const panel=document.createElement('section');panel.id='elisa-workspace';panel.className='panel qpcr-workspace';panel.hidden=true;
  panel.innerHTML='<h2>ELISA · 从本批次标准品计算浓度</h2><p class="cloud-warning">4PL 至少 6 个不同浓度，5PL 至少 8 个，其中至多一个为 0。blank 不自动当作零标准。只在标准区间内反算，不自动外推或把缺失结果填为 0；不是试剂盒有效性或临床判定。</p><div class="qpcr-fields"><label>拟合模型<select id="elisa-model"><option value="4pl">4PL · 对称曲线</option><option value="5pl">5PL · 含非对称参数</option></select></label><label>响应方向<select id="elisa-curve-direction"><option value="increasing">浓度增加，OD 升高</option><option value="decreasing">浓度增加，OD 降低</option></select></label><label>标准品与结果浓度单位<input id="elisa-unit" maxlength="40" placeholder="例如 pg/mL，必须与标准品一致"></label><label>主波长 nm<input id="elisa-wavelength" type="number" min="200" max="1000" value="450"></label><label>参考波长 nm（无参考则留空）<input id="elisa-reference-wavelength" type="number" min="200" max="1000"></label></div><label class="cloud-consent"><input id="elisa-subtract" type="checkbox">本软件统一扣除本批次 blank 平均值（仅在此前未扣空白时选择）</label><label>CSV / TSV / Excel 粘贴表格<textarea id="elisa-csv" rows="10" maxlength="200000" spellcheck="false" placeholder="sample_id,role,od,standard_concentration,dilution"></textarea></label><p>必需列：sample_id,role,od,standard_concentration,dilution；可选 well,reference_od。role 使用 standard / blank / sample / control。标准品填已知浓度；sample / control 必须填稀释倍数，未稀释填 1。同 ID 为技术孔，不是独立生物重复。不同板次 / 批次须分开计算。</p><div class="cloud-actions"><button id="elisa-import" class="button secondary">导入 CSV / TSV</button><button id="elisa-demo" class="button secondary">载入模拟数据</button><button id="elisa-clear" class="button secondary">清空并开始新数据</button><span id="elisa-filename">也可粘贴带英文表头的 Excel 数据</span></div><label class="cloud-consent"><input id="elisa-assumptions" type="checkbox">我确认模型、单位、波长、标准品与稀释来自实际方案，已核对是否扣过参考 / 空白；理解本软件未验证试剂盒、定量限或实验有效性。</label><label class="cloud-consent"><input id="elisa-simulated" type="checkbox">这是模拟 / 演示数据</label><div class="cloud-actions"><button id="elisa-calculate" class="button primary">计算标准曲线与浓度</button><button id="elisa-save" class="button secondary">保存 ELISA 分析快照</button></div><p id="elisa-status" class="cloud-status" role="status" aria-live="polite"></p><div id="elisa-result"></div><input id="elisa-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" hidden>';
  document.getElementById('instrument-workspace').before(selector);selector.after(panel);
  const insert=append(element('save').parentElement,'button','将已保存结果摘要追加到原实验');insert.id='elisa-insert';insert.type='button';insert.className='button secondary';insert.disabled=true;
  let previousAssay=state.assayId,filename='pasted-elisa.csv',simulatedLocked=false,lastSaved=null;
  const active=()=>elisaAssays.includes(state.assayId)&&element('mode').value==='curve'&&state.path==='instrument';
  function invalidate(){state.instrumentResult=null;lastSaved=null;insert.disabled=true;element('result').replaceChildren();element('status').textContent='输入已更改，请重新计算；原快照不会覆盖。';}
  function clear(){for(const id of ['csv','unit','reference-wavelength'])element(id).value='';element('subtract').checked=false;element('simulated').checked=false;element('assumptions').checked=false;simulatedLocked=false;filename='pasted-elisa.csv';element('filename').textContent='也可粘贴带英文表头的 Excel 数据';invalidate();}
  function sync(){
    const eligible=elisaAssays.includes(state.assayId)&&state.path==='instrument';selector.hidden=!eligible;panel.hidden=!active();
    if(previousAssay!==state.assayId){previousAssay=state.assayId;clear();}
    document.getElementById('instrument-workspace').hidden=state.path!=='instrument'||state.assayId==='qpcr'||active();
    for(const input of [...panel.querySelectorAll('input,textarea,select,button'),element('mode')])input.disabled=state.busy;
    element('simulated').disabled=state.busy||simulatedLocked;
    insert.disabled=state.busy||!lastSaved;
  }
  function payload(){return {assay_id:state.assayId,quantification:'elisa',model:element('model').value,curve_direction:element('curve-direction').value,unit:element('unit').value.trim(),csv:element('csv').value,wavelength:element('wavelength').value,reference_wavelength:element('reference-wavelength').value||null,subtract_blank:element('subtract').checked,assumptions_confirmed:element('assumptions').checked,simulated:element('simulated').checked,filename,experiment:experiment(),mode:state.mode,...window.ColorLensNotebook.analysisLink()};}
  async function calculate(){if(state.busy)return;setBusy(true,'拟合 ELISA…');try{state.instrumentResult=await api('/api/instrument/analyze',payload());renderElisaResult(element('result'),state.instrumentResult);element('status').textContent='计算完成 · 尚未保存 · 范围外浓度留空。';}catch(error){invalidate();element('status').textContent=error.message;}finally{setBusy(false);}}
  async function save(){
    if(state.busy)return;if(state.instrumentResult?.measurement!=='elisa'){element('status').textContent='请先计算当前 ELISA 输入。';return;}
    try{await window.ColorLensNotebook.prepareAnalysis();}catch(error){element('status').textContent=error.message;return;}
    setBusy(true,'保存 ELISA…');try{const saved=await api('/api/instrument/export',payload());await window.ColorLensNotebook.analysisSaved(saved);lastSaved=saved;state.savedId=saved.id;element('status').textContent='已保存原始读数、标准曲线、稀释参数和结果；可在“分析快照”在线查看，无需下载。';toast('ELISA 分析快照已保存。');}catch(error){element('status').textContent=error.message;}finally{setBusy(false);}
  }
  insert.onclick=async()=>{
    if(state.busy||!lastSaved)return;const saved=lastSaved;
    setBusy(true,'追加结果摘要…');
    try{
      await window.ColorLensNotebook.flush();const record=await api('/api/restore',{id:saved.id}),entry=await api('/api/notebook/entry/'+saved.entry_id),result=record.result;
      if(entry.data.results.includes(saved.id))throw new Error('此快照摘要已在原实验结果中，不重复追加。');
      if(entry.data.status!=='draft')throw new Error('原实验已完成，请先恢复编辑；本操作不会绕过记录锁定。');
      if(!confirm('将已保存结果摘要追加到原实验“'+entry.data.title+'”的结果栏目？保留原文字，不自动填入讨论或 AI 结论。'))return;
      const samples=result.groups.filter(group=>group.dilution!==null),lines=[`${result.simulated?'模拟数据 · ':''}ELISA ${result.model.toUpperCase()} · ${result.assay.name}`,`来源：分析快照 ${saved.id}；${record.created_at}；${result.algorithm}`,`标准区间 ${result.curve.min_concentration}–${result.curve.max_concentration} ${result.unit}；R²=${number(result.curve.r_squared)}；等权浓度均值拟合；先平均 OD 再反算。`,...samples.slice(0,20).map(group=>`${group.sample_id}：平均 OD=${number(group.mean_od)}；稀释=${group.dilution}；上板浓度=${number(group.curve_concentration)}；稀释换算浓度=${number(group.concentration)} ${result.unit}；${group.range_status}`),...(samples.length>20?['仅列前 20 个样本，完整结果见原快照。']:[]),'范围外浓度留空，不是零；标准区间不是定量限，未提供显著性或实验有效性结论。'];
      const results=[entry.data.results,lines.join('\n')].filter(Boolean).join('\n\n');if(results.length>40000)throw new Error('结果栏目容量不足，未覆盖原文。请保留快照或手动整理。');
      await api('/api/notebook/save',{id:entry.id,revision:entry.revision,data:{...entry.data,results}});await window.ColorLensNotebook.openEntry(entry.id);toast('已追加带来源的结果摘要，原结果保留。');
    }catch(error){element('status').textContent=error.message;toast(error.message,true);}finally{setBusy(false);}
  };
  function loadCsv(raw,name,simulated){clear();element('csv').value=raw;filename=name;element('filename').textContent=name;simulatedLocked=Boolean(simulated);element('simulated').checked=simulatedLocked;sync();element('status').textContent='请填写单位、检查标准品与稀释列，确认校正和方法前提后计算。';}
  element('mode').onchange=()=>{invalidate();window.ColorLensMethods.renderPath();};
  panel.addEventListener('input',event=>{if(event.target.matches('input,textarea,select'))invalidate();});
  for(const id of ['model','curve-direction','unit','wavelength','reference-wavelength','subtract'])element(id).addEventListener('change',()=>{element('assumptions').checked=false;});
  element('calculate').onclick=calculate;element('save').onclick=save;element('clear').onclick=()=>{if(confirm('清空本页 ELISA 输入？已保存的记录不删除。')){clear();sync();}};
  element('import').onclick=()=>element('file').click();element('file').onchange=async()=>{try{const file=element('file').files[0];if(!file)return;if(file.size>200000)throw new Error('请选择 200 KB 以内、最多 512 条读数的文件。');const bytes=await file.arrayBuffer();let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{raw=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}loadCsv(raw,file.name,simulatedLocked||element('simulated').checked);}catch(error){element('status').textContent=error.message;}finally{element('file').value='';}};
  function apply(input){for(const [id,key] of [['csv','csv'],['model','model'],['curve-direction','curve_direction'],['unit','unit'],['wavelength','wavelength'],['reference-wavelength','reference_wavelength']])element(id).value=input[key]??'';element('subtract').checked=input.subtract_blank;simulatedLocked=input.simulated;element('simulated').checked=input.simulated;element('assumptions').checked=input.assumptions_confirmed;filename=input.filename||'restored-elisa.csv';element('filename').textContent=filename;sync();}
  element('demo').onclick=async()=>{if(state.busy)return;setBusy(true,'载入模拟数据…');try{const input=await api('/api/instrument/demo',{assay_id:state.assayId,quantification:'elisa'});apply(input);invalidate();element('status').textContent='模拟数据：Sample-A 上板浓度 25 pg/mL，稀释 4 倍后为 100 pg/mL；Too-high 应留空。请先确认方法前提。';}catch(error){element('status').textContent=error.message;}finally{setBusy(false);}};
  async function restore(record){element('mode').value='curve';previousAssay=state.assayId;apply(record.instrument_input);for(const [key,value] of Object.entries(record.experiment)){const input=document.getElementById('experiment-'+key.replaceAll('_','-'));if(input)input.value=value;}document.getElementById('shared-experiment-name').value=record.experiment.name||'';state.instrumentResult=await api('/api/instrument/analyze',payload());renderElisaResult(element('result'),state.instrumentResult);element('status').textContent='已按保存的读数与模型重新计算，原快照没有被覆盖。';}
  sync();return {active,sync,save,restore,loadCsv};
}
