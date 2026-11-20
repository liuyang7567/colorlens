import {qpcrMethods} from '../src/qpcr.mjs';
import {renderQpcrChart} from './qpcr-chart.mjs';

const number=value=>value===null||value===undefined?'—':typeof value==='number'?String(Number(value.toPrecision(7))):String(value);
function textNode(target,tag,value){const node=document.createElement(tag);node.textContent=value;target.append(node);return node;}
function resultTable(target,headers,values){
  const scroll=document.createElement('div');scroll.className='table-scroll';scroll.tabIndex=0;
  const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),heading=document.createElement('tr');
  for(const title of headers){const cell=textNode(heading,'th',title);cell.scope='col';}head.append(heading);
  for(const valuesRow of values){const row=document.createElement('tr');for(const value of valuesRow)textNode(row,'td',number(value));body.append(row);}
  table.append(head,body);scroll.append(table);target.append(scroll);
}
export function renderQpcrResult(target,result){
  target.replaceChildren();target.classList.add('qpcr-output');
  textNode(target,'h3',result.method_name);textNode(target,'p',result.formula);
  textNode(target,'p',`${result.simulated?'模拟数据 · ':''}内参：${result.reference_gene||'未填写 / 本方法不使用'} · 对照：${result.control_group||'本方法不使用'} · ${result.calibration==='paired'?'按 pair_id 配对':result.calibration==='group'?'每个目标基因的对照样本均值':'无对照校准'}`);
  textNode(target,'p',`输入：${result.input_type==='multi_ct'?'多内参原始 Ct 长表':result.input_type==='ct'?'原始 Ct':'已有 ΔCt'} · 重复声明：${{biological:'独立生物样本',technical:'仅技术重复',unknown:'未确认'}[result.replicate_kind]}${result.method==='standard'?'':result.input_type==='multi_ct'?` · 目标效率：${number(result.target_efficiency)}%；逐内参效率见配置表`:` · 使用的目标/内参效率：${number(result.target_efficiency)}% / ${number(result.reference_efficiency)}%`}`);
  textNode(target,'p','同一目标基因 + 样本 ID 的技术行先合并；n 是样本 ID 数，只有明确声明独立生物重复时才有生物学 n。组统计不含显著性检验。');
  renderQpcrChart(target,result);
  if(result.input_type==='multi_ct'){
    textNode(target,'h3','多内参配置 · 用户指定，不自动证明稳定');resultTable(target,['内参基因','声明扩增效率 %'],result.reference_config.map(reference=>[reference.gene,reference.efficiency_percent]));
    textNode(target,'p','每个基因先独立平均技术孔 Ct，再将各内参相对量等权几何归一化。目标技术孔数可与内参不同，不按孔号猜测配对。多内参 Pfaffl 不显示传统 ΔCt / ΔΔCt 或单一内参 Ct。');
    const details=document.createElement('details');textNode(details,'summary','查看逐基因 Ct 均值、技术孔数与原始孔位来源');
    resultTable(details,['样本','组','配对 ID','基因','角色','平均 Ct','技术孔数','Ct 样本 SD'],result.gene_summary.map(row=>[row.sample_id,row.group,row.pair_id,row.gene,row.role==='reference'?'内参':'目标',row.mean_ct,row.technical_n,row.ct_sd]));
    resultTable(details,['样本','基因','原始 Ct','板次（不自动校准）','孔位'],result.gene_rows.map(row=>[row.sample_id,row.gene,row.ct,row.plate_id,row.well]));target.append(details);
  }
  if(result.method==='standard'){
    textNode(target,'h3','标准曲线与模板量 · '+result.quantity_unit);
    resultTable(target,['目标','斜率','截距','R²','效率 %','标准下限','标准上限'],result.curves.map(curve=>[curve.target,curve.slope,curve.intercept,curve.r_squared,curve.efficiency_percent,curve.min_quantity,curve.max_quantity]));
    resultTable(target,['样本','目标','组','技术行数','平均 Ct','模板量（'+result.quantity_unit+'）','是否外推','提示'],result.rows.map(row=>[row.sample_id,row.target,row.group,row.technical_n,row.ct_target,row.quantity,row.extrapolated?'是':'否',row.warnings.join('；')]));
  }else{
    textNode(target,'h3','各样本表达量结果');
    resultTable(target,['样本','目标','组','配对 ID',result.input_type==='multi_ct'?'目标技术孔数':'技术行数','平均目标 Ct',result.input_type==='multi_ct'?'综合内参 Ct（等效率时）':'平均内参 Ct','平均 ΔCt','对照 ΔCt','ΔΔCt','内参归一化相对量','表达倍数 RQ','log₂FC'],result.rows.map(row=>[row.sample_id,row.target,row.group,row.pair_id||'—',row.technical_n,row.ct_target,row.ct_reference,row.delta_ct,row.calibrator_delta_ct,row.delta_delta_ct,row.normalized_expression,row.fold_change,row.log2_fold_change]));
  }
  textNode(target,'h3','分组描述统计');
  resultTable(target,['目标','组','样本 ID 数 n','已声明生物学 n','平均 ΔCt','ΔCt SD','平均归一化量','倍数算术均值','倍数几何均值','倍数 SD','平均模板量','提示'],result.groups.map(group=>[group.target,group.group,group.n,group.biological_n,group.mean_delta_ct,group.sd_delta_ct,group.mean_normalized_expression,group.mean_fold_change,group.geometric_fold_change,group.sd_fold_change,group.mean_quantity,group.warnings.join('；')]));
  for(const warning of result.warnings)textNode(target,'p',warning);
}
const element=id=>document.getElementById('qpcr-'+id);
const quoted=value=>'"'+String(value).replaceAll('"','""')+'"';
function quickValues(raw,pairedColumns){
  const content=raw.trim();if(!content)return [];
  return pairedColumns?content.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const values=line.trim().split(/[,\t ]+/);if(values.length!==2)throw new Error('原始 Ct 模式每行需要“目标Ct,内参Ct”两个数值；请先汇总或匹配技术重复。');return values;}):content.split(/[,，;；\s]+/).filter(Boolean).map(value=>[value]);
}

export function mountQpcr(){
  const panel=document.createElement('section');panel.id='qpcr-workspace';panel.className='panel qpcr-workspace';panel.hidden=true;
  panel.innerHTML=`<div class="panel-header"><div><span class="eyebrow">QPCR / RT-QPCR</span><h2>从 Ct / ΔCt 到可追溯的表达量结果</h2></div></div><p class="cloud-warning">快捷与批量两种入口使用同一计算内核。ΔCt＝目标 Ct−内参 Ct。相对表达倍数不是绝对拷贝数；标准曲线法必须提供已知标准品，Pfaffl 必须提供目标和内参原始 Ct。不进行显著性检验。</p><div class="qpcr-fields"><label>输入版本<select id="qpcr-entrymode"><option value="quick">快捷计算 · 少量样本</option><option value="batch">批量分析 · CSV / Excel 粘贴表格</option></select></label><label>计算方法<select id="qpcr-method">${Object.entries(qpcrMethods).map(([key,label])=>`<option value="${key}"${key==='ddct'?' selected':''}>${label}</option>`).join('')}</select></label><label>输入数值类型<select id="qpcr-input-type"><option value="dct">已有 ΔCt</option><option value="ct">原始 Ct（自动计算 ΔCt）</option></select></label><label>目标基因（批量 target 列可覆盖）<input id="qpcr-target-gene" maxlength="80" placeholder="例如 IL6"></label><label id="qpcr-reference-label">内参基因<input id="qpcr-reference-gene" maxlength="80" placeholder="例如 GAPDH；需按实验验证稳定性"></label><label id="qpcr-control-label">对照组名称<input id="qpcr-control-group" maxlength="80" value="对照组"></label><label id="qpcr-treated-label">快捷版处理组名称<input id="qpcr-treated-group" maxlength="80" value="处理组"></label><label id="qpcr-calibration-label">对照校准方式<select id="qpcr-calibration"><option value="group">每个目标基因的对照样本均值</option><option value="paired">配对：批量用 pair_id，快捷按行一一对应</option></select></label><label>重复类型声明<select id="qpcr-replicate-kind"><option value="unknown">未确认 · 不称为生物学 n</option><option value="biological">每个样本 ID 是独立生物样本</option><option value="technical">仅技术重复 · 不能算生物学 n</option></select></label><label id="qpcr-target-efficiency-label">目标扩增效率 %（100 表示每轮翻倍）<input id="qpcr-target-efficiency" type="number" value="100" min="0.000001" max="200" step="any"></label><label id="qpcr-reference-efficiency-label">内参扩增效率 %<input id="qpcr-reference-efficiency" type="number" value="100" min="0.000001" max="200" step="any"></label></div><p id="qpcr-method-help" class="cloud-status"></p><div id="qpcr-quick" class="qpcr-quick"><label>样本 / 处理组数值<textarea id="qpcr-quick-samples" rows="4" maxlength="12000" placeholder="每行一个已合并技术重复的独立样本 ΔCt，例如 4"></textarea></label><label id="qpcr-quick-controls-label">对照组数值（只知道均值就只填一行）<textarea id="qpcr-quick-controls" rows="4" maxlength="12000" placeholder="例如 6"></textarea></label><p>ΔCt 可用换行或逗号分隔；原始 Ct 模式每行填“目标Ct,内参Ct”。快捷版每行会生成一个样本 ID，不把同一行当作多个重复。需要同一样本多个技术孔时请用批量版。</p></div><div id="qpcr-batch" hidden><div class="cloud-actions"><button id="qpcr-import" type="button" class="button secondary">导入 CSV / TSV</button><span id="qpcr-filename">也可直接粘贴带表头的 Excel 表格</span></div><label>批量数据<textarea id="qpcr-csv" rows="9" maxlength="200000" spellcheck="false"></textarea></label><p id="qpcr-csv-help" class="cloud-status"></p><p>每行一条输入；相同 target + sample_id 的多行合并为技术重复。不同独立样本必须用不同 ID；target 可省略，pair_id 仅在配对时必填。最多 512 行，不自动删除异常或未扩增数据。</p></div><section id="qpcr-standards" hidden><h3>本批次已知标准品（不可只填 ΔCt）</h3><label>标准品表格<textarea id="qpcr-standards-csv" rows="5" maxlength="100000" placeholder="quantity,ct&#10;1,40&#10;10,36.6780719051&#10;100,33.3561438102"></textarea></label><label>标准品数量单位<input id="qpcr-quantity-unit" maxlength="40" placeholder="例如 copies/反应 或 ng/反应，必须与标准品一致"></label><p>至少 3 个不同正数量。可加 target 列，为每个目标基因分别提供标准。各数量技术孔先平均 Ct，再按浓度等权拟合；这不代表已验证定量范围。未自动校正提取、逆转录或稀释。</p></section><label class="cloud-consent"><input id="qpcr-assumptions" type="checkbox">我确认输入类型与 ΔCt 定义，理解所选方法的效率、内参、对照/标准品前提；软件无法代替原始曲线与实验有效性检查。</label><label class="cloud-consent"><input id="qpcr-simulated" type="checkbox">这是模拟 / 演示数据</label><div class="cloud-actions"><button id="qpcr-calculate" class="button primary">计算表达量</button><button id="qpcr-save" class="button secondary">保存 qPCR 分析快照</button><button id="qpcr-demo" class="button secondary">载入明确标记的模拟数据</button><button id="qpcr-clear" class="button secondary">清空输入，开始新数据</button></div><p id="qpcr-status" class="cloud-status" role="status" aria-live="polite"></p><div id="qpcr-result" aria-live="polite"></div><input id="qpcr-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" hidden>`;
  document.getElementById('instrument-workspace').after(panel);
  const multiOption=document.createElement('option');multiOption.value='multi_ct';multiOption.textContent='多内参原始 Ct · 长表（2–5 个内参）';element('input-type').append(multiOption);
  const configuration=document.createElement('section');configuration.id='qpcr-multiref-config';configuration.hidden=true;
  configuration.innerHTML='<h3>多内参配置</h3><label>已验证内参及各自效率（CSV / TSV）<textarea id="qpcr-reference-genes-csv" rows="4" maxlength="20000" placeholder="gene,efficiency_percent&#10;GAPDH,100&#10;ACTB,100"></textarea></label><p>明确填写 2–5 个不同内参，100 表示扩增因子 2。所选内参需自行验证稳定性；本功能不自动运行 geNorm / NormFinder。ΔCt / ΔΔCt 模型每个内参填 100；等效率法与目标效率相同；效率不同时用 Pfaffl，并填写目标及每个内参效率。</p><p>原始长表每行为一个样本、一个基因的一条 Ct。所有样本需提供相同目标集合和每个所选内参；缺失、未扩增或 Ct=0 会拒绝，不自动插补。可附 plate_id / well 追溯，但不自动进行跨板校准。</p>';
  element('batch').before(configuration);
  const multiDemo=document.createElement('button');multiDemo.id='qpcr-multiref-demo';multiDemo.className='button secondary';multiDemo.type='button';multiDemo.textContent='载入多内参模拟数据';element('demo').after(multiDemo);
  let filename='pasted-qpcr.csv',simulatedLocked=false,activeInputType='dct';
  function invalidate(){state.instrumentResult=null;element('result').replaceChildren();element('status').textContent='输入已更改，请重新计算；已保存的快照不会改动。';}
  function sync(){
    const method=element('method').value,absolute=method==='standard',comparison=['ddct','efficiency','pfaffl'].includes(method),rawRequired=['pfaffl','standard'].includes(method);
    if(absolute||rawRequired&&element('input-type').value==='dct')element('input-type').value='ct';element('input-type').disabled=state.busy||absolute;element('input-type').querySelector('option[value="dct"]').disabled=rawRequired;multiOption.disabled=absolute;element('simulated').disabled=state.busy||simulatedLocked;
    if(element('input-type').value!==activeInputType){if(activeInputType==='multi_ct')element('reference-gene').value='';activeInputType=element('input-type').value;for(const identifier of ['quick-samples','quick-controls','csv'])element(identifier).value='';element('assumptions').checked=false;element('status').textContent='Ct、ΔCt 与多内参长表不能直接互换；已清空旧数值，请按新输入类型重新填写。';}
    const multi=element('input-type').value==='multi_ct';if(multi)element('entrymode').value='batch';element('entrymode').querySelector('option[value="quick"]').disabled=multi;configuration.hidden=!multi;
    const quick=element('entrymode').value==='quick',raw=element('input-type').value==='ct';
    element('quick').hidden=!quick;element('batch').hidden=quick;element('standards').hidden=!absolute;
    element('reference-label').hidden=absolute||multi;element('target-gene').closest('label').hidden=multi;element('control-label').hidden=!comparison;element('calibration-label').hidden=!comparison;element('quick-controls-label').hidden=!comparison;element('treated-label').hidden=!quick;
    element('target-efficiency-label').hidden=!['efficiency','pfaffl'].includes(method);element('reference-efficiency-label').hidden=method!=='pfaffl'||multi;
    const columns=multi?'sample_id,group,gene,ct':raw?absolute?'sample_id,group,ct_target':'sample_id,group,ct_target,ct_reference':'sample_id,group,delta_ct';element('csv').placeholder=columns;
    element('csv-help').textContent='必需表头：'+columns+'；CSV 或制表符分隔，数字使用小数点。';
    element('method-help').textContent=absolute?'标准曲线计算与标准品同单位的模板量，不是直接由 ΔCt 得到的绝对 mRNA 表达量。':method==='pfaffl'?'Pfaffl 需要目标和内参各自的原始 Ct、各自的扩增效率（百分数），以及本目标基因对照。效率不同不能只用 ΔCt。':method==='efficiency'?'等效率校正要求目标和内参具有相同且已验证的扩增效率；不同效率请选 Pfaffl。':method==='dct'?'没有处理/对照比较，只计算内参归一化相对量 2^(-ΔCt)；基数 2 需要接近 100% 的扩增效率。':'先按目标基因选择对照，再计算 ΔΔCt 和 2^(-ΔΔCt)。目标及内参扩增效率应接近 100% 且相近。';
    if(multi)element('csv-help').textContent+=' 可选 pair_id,plate_id,well；每个样本 ID 必须包含全部目标与所选内参，技术孔先按基因分别汇总。';
    element('quick-samples').placeholder=raw?absolute?'每行一个目标 Ct，例如 35.6780719':'每行 目标Ct,内参Ct，例如 24,20':'每行一个 ΔCt，例如 4';
    if(state.instrumentResult?.measurement==='qpcr')renderQpcrResult(element('result'),state.instrumentResult);else element('result').replaceChildren();
  }
  function payload(){
    const method=element('method').value,raw=element('input-type').value==='ct',absolute=method==='standard',comparison=['ddct','efficiency','pfaffl'].includes(method),target=element('target-gene').value.trim()||'目标基因';
    let csv=element('csv').value;
    if(element('entrymode').value==='quick'){
      const samples=quickValues(element('quick-samples').value,raw&&!absolute),controls=comparison?quickValues(element('quick-controls').value,raw):[];
      if(!samples.length)throw new Error('请至少输入一个样本数值。');if(comparison&&!controls.length)throw new Error('此方法需要对照组数值；没有对照可选择 2^(-ΔCt)。');
      if(comparison&&element('control-group').value.trim()===element('treated-group').value.trim())throw new Error('快捷版的对照组与处理组不能同名，以免混成同一组。');
      if(comparison&&element('calibration').value==='paired'&&controls.length!==samples.length)throw new Error('快捷配对要求对照和样本行数一致，并由你确认按输入顺序一一对应。');
      const lines=[['sample_id','group','target','pair_id',...(raw?absolute?['ct_target']:['ct_target','ct_reference']:['delta_ct'])]];
      for(const [prefix,group,values] of [['C',element('control-group').value,controls],['S',element('treated-group').value,samples]])for(const [index,valuesRow] of values.entries())lines.push([prefix+(index+1),group,target,'P'+(index+1),...valuesRow]);
      csv=lines.map(line=>line.map(quoted).join(',')).join('\n');
    }
    return {assay_id:'qpcr',csv,method,input_type:element('input-type').value,reference_genes_csv:element('input-type').value==='multi_ct'?element('reference-genes-csv').value:null,target_gene:target,reference_gene:element('reference-gene').value.trim(),control_group:element('control-group').value.trim(),calibration:element('calibration').value,replicate_kind:element('replicate-kind').value,target_efficiency:element('target-efficiency').value,reference_efficiency:element('reference-efficiency').value,standards_csv:element('standards-csv').value,quantity_unit:element('quantity-unit').value.trim(),assumptions_confirmed:element('assumptions').checked,simulated:element('simulated').checked,filename,experiment:experiment(),mode:state.mode,...window.ColorLensNotebook.analysisLink()};
  }
  async function calculate(){
    if(state.busy)return;setBusy(true,'计算 qPCR…');
    try{state.instrumentResult=await api('/api/instrument/analyze',payload());renderQpcrResult(element('result'),state.instrumentResult);element('status').textContent='计算完成 · 结果仅根据当前输入，尚未保存。';}
    catch(error){state.instrumentResult=null;element('result').replaceChildren();element('status').textContent=error.message;}
    finally{setBusy(false);}
  }
  async function save(){
    if(state.busy)return;if(state.instrumentResult?.measurement!=='qpcr'){element('status').textContent='请先计算当前 qPCR 输入，再保存。';return;}
    try{await window.ColorLensNotebook.prepareAnalysis();}catch(error){element('status').textContent=error.message;return;}
    setBusy(true,'保存 qPCR…');
    try{
      const saved=await api('/api/instrument/export',payload());await window.ColorLensNotebook.analysisSaved(saved);state.savedId=saved.id;
      element('status').textContent='qPCR 输入、方法和结果已保存到原实验。日常可在分析快照中在线查看，不需要下载。';
      document.getElementById('saved-path').value=saved.path;document.getElementById('download-link').href=saved.download_url;
      document.getElementById('export-note').textContent='保存了原始输入表、方法及效率/对照设置、样本结果、分组描述统计和校验清单。只有主动点击下载才生成 ZIP。'+(saved.simulated?' 此快照是模拟数据。':'');
      document.querySelector('#export-dialog>p').textContent='qPCR 表达量结果已关联保存。';document.querySelector('#export-dialog .export-file-list').innerHTML='<span>原始输入 CSV</span><span>样本结果 CSV</span><span>分组统计 CSV</span><span>方法与参数 JSON</span><span>标准品（如有）</span><span>SHA-256 清单</span>';if(element('input-type').value==='multi_ct')for(const title of ['多内参配置与效率','逐基因原始 Ct','逐基因与内参汇总'])textNode(document.querySelector('#export-dialog .export-file-list'),'span',title);document.getElementById('export-dialog').showModal();
    }catch(error){element('status').textContent=error.message;}finally{setBusy(false);}
  }
  function loadCsv(raw,name,simulated){
    const columns=raw.split(/\r?\n/)[0].replace(/^\uFEFF/,'').split(/[,\t]/).map(value=>value.trim().replace(/^"|"$/g,''));element('entrymode').value='batch';element('csv').value=raw;element('input-type').value=columns.includes('ct_target')?'ct':columns.includes('gene')&&columns.includes('ct')?'multi_ct':'dct';
    activeInputType=element('input-type').value;element('quick-samples').value='';element('quick-controls').value='';
    filename=name;simulatedLocked=Boolean(simulated);element('simulated').checked=Boolean(simulated);element('filename').textContent=name;element('assumptions').checked=false;invalidate();sync();element('status').textContent='数据已载入；请检查方法、内参、对照组与重复类型，再确认并计算。';
  }
  panel.addEventListener('input',event=>{if(event.target.matches('input,textarea,select')&&!element('result').contains(event.target))invalidate();});
  for(const identifier of ['entrymode','method','input-type'])element(identifier).addEventListener('change',()=>{element('assumptions').checked=false;sync();});
  element('calculate').onclick=calculate;element('save').onclick=save;
  element('import').onclick=()=>element('file').click();
  element('file').onchange=async()=>{const file=element('file').files[0];if(!file)return;try{if(file.size>2000000)throw new Error('CSV / TSV 请选择 2 MB 以内文件，并控制在 512 行以内。');const bytes=await file.arrayBuffer();let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{raw=new TextDecoder('gb18030',{fatal:true}).decode(bytes);}loadCsv(raw,file.name,simulatedLocked||element('simulated').checked);}catch(error){element('status').textContent=error.message;}finally{element('file').value='';}};
  element('demo').onclick=async()=>{try{const demo=await api('/api/instrument/demo',{assay_id:'qpcr'});element('method').value=demo.method;element('input-type').value=demo.input_type;activeInputType=demo.input_type;element('target-gene').value='IL6';element('reference-gene').value='GAPDH';element('control-group').value='对照组';element('treated-group').value='处理组';element('calibration').value='group';element('replicate-kind').value='biological';element('quick-controls').value='6\n6';element('quick-samples').value='4\n4';element('csv').value=demo.csv;filename=demo.filename;element('filename').textContent=filename;simulatedLocked=true;element('simulated').checked=true;element('assumptions').checked=false;invalidate();sync();element('status').textContent='已载入模拟数据：对照 ΔCt=6、处理 ΔCt=4，预期 ΔΔCt=-2、表达倍数=4。确认方法前提后计算。';}catch(error){element('status').textContent=error.message;}};
  element('clear').onclick=()=>{if(!confirm('清空当前 qPCR 输入，开始一份新数据？已保存的云端记录不会删除。'))return;for(const identifier of ['quick-controls','quick-samples','csv','standards-csv','quantity-unit','target-gene','reference-gene','reference-genes-csv'])element(identifier).value='';simulatedLocked=false;element('simulated').checked=false;element('assumptions').checked=false;filename='pasted-qpcr.csv';element('filename').textContent='也可直接粘贴带表头的 Excel 表格';invalidate();sync();};
  multiDemo.onclick=async()=>{
    if(state.busy)return;setBusy(true,'载入多内参模拟数据…');
    try{const demo=await api('/api/instrument/demo',{assay_id:'qpcr',input_type:'multi_ct'});element('method').value=demo.method;element('input-type').value='multi_ct';activeInputType='multi_ct';element('entrymode').value='batch';element('csv').value=demo.csv;element('reference-genes-csv').value=demo.reference_genes_csv;element('control-group').value=demo.control_group;element('calibration').value=demo.calibration;element('replicate-kind').value=demo.replicate_kind;element('target-efficiency').value=demo.target_efficiency;simulatedLocked=true;element('simulated').checked=true;element('assumptions').checked=false;filename=demo.filename;element('filename').textContent=filename;invalidate();sync();element('status').textContent='已载入多内参模拟数据：GAPDH / ACTB 等权归一化，处理组预期表达倍数 4；技术孔数不等。请确认实际方法前提。';}catch(error){element('status').textContent=error.message;}finally{setBusy(false);}
  };
  async function restore(record){
    const inputs=record.instrument_input;for(const key of ['method','input_type','target_gene','reference_gene','control_group','calibration','replicate_kind','target_efficiency','reference_efficiency','standards_csv','quantity_unit','reference_genes_csv'])if(inputs[key]!==null&&inputs[key]!==undefined)element(key.replaceAll('_','-')).value=inputs[key];
    element('entrymode').value='batch';element('csv').value=inputs.csv;element('assumptions').checked=inputs.assumptions_confirmed;simulatedLocked=inputs.simulated;element('simulated').checked=inputs.simulated;filename=inputs.filename||'restored-qpcr.csv';element('filename').textContent=filename;
    activeInputType=inputs.input_type;element('quick-samples').value='';element('quick-controls').value='';
    for(const [key,value] of Object.entries(record.experiment)){const input=document.getElementById('experiment-'+key.replaceAll('_','-'));if(input)input.value=value;}document.getElementById('shared-experiment-name').value=record.experiment.name||'';
    state.instrumentResult=await api('/api/instrument/analyze',payload());sync();element('status').textContent='已按保存的 qPCR 输入与方法重新计算，原快照没有被覆盖。';
  }
  sync();return {sync,save,restore,loadCsv};
}
