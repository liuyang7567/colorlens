import {rgbLab,deltaE} from '../src/photo.mjs';
import {captureProtocol} from './capture-bridge.mjs';
import {fitColorMatrix,applyColorMatrix,projectedWells,plateProjection} from '../src/color-calibration.mjs';
import {validateColorSession} from '../src/color-session.mjs';
import {saveBlob,sha} from './transport.mjs';

const linear=value=>{const channel=value/255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;};
const encode=value=>255*(value<=0.0031308?12.92*value:1.055*value**(1/2.4)-0.055);
export function correctColor(sample,reference,baseline){
  if(![sample,reference,baseline].every(values=>Array.isArray(values)&&values.length===3&&values.every(value=>Number.isFinite(value)&&value>=0&&value<=255)))throw new Error('颜色数据无效。');
  const gain=reference.map((value,index)=>linear(baseline[index])/linear(value));
  if(reference.some(value=>value<=8||value>=250)||baseline.some(value=>value<=8||value>=250)||gain.some(value=>!Number.isFinite(value)||value<0.5||value>2))throw new Error('参考色块过暗、饱和或变化过大；请调整画面并重新设定基准。');
  const corrected=sample.map((value,index)=>linear(value)*gain[index]);
  return {rgb:corrected.map(value=>Math.max(0,Math.min(255,encode(value)))),clipped:corrected.some(value=>value>1)};
}

export function mountColorTrend({root,getCapture,getEntryId,queue}){
  const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='/color-trend.css';document.head.append(stylesheet);
  const section=document.createElement('section');section.className='panel color-trend';section.id='color-trend';
  section.innerHTML=`<h2>显色曲线与孔板 · 实验预览</h2><p>在同一画面中放置稳定的中性灰参考卡和样品，固定眼镜及样品。先取一帧，分别拖框选参考卡、样品或孔板，再设为基准。</p><p class="cloud-warning">支持灰卡及多色块矩阵的首帧相对校正；光谱变化、自动曝光、压缩、移动与反光仍会造成误差。结果是图像颜色变化，不是吸光度、浓度或实验结论。</p><div class="cloud-actions"><button class="button secondary" id="color-frame">从眼镜取一帧</button><label>或选择图片<input type="file" id="color-file" accept="image/png,image/jpeg,image/webp"></label><button class="button secondary" id="color-reference">框选灰卡</button><button class="button secondary" id="color-sample">框选样品</button><button class="button secondary" id="color-plate">框选 96 孔板</button></div><p id="color-mode" role="status">请先取得画面。</p><canvas id="color-canvas" aria-label="画面标注区域" style="width:100%;max-width:960px;touch-action:none;display:block;background:#eef2f6"></canvas><div class="cloud-actions"><button class="button primary" id="color-baseline">设为基准并记录</button><button class="button secondary" id="color-record">记录当前画面</button><label>周期间隔<select id="color-interval"><option value="15">15 秒</option><option value="30" selected>30 秒</option><option value="60">60 秒</option></select></label><button class="button secondary" id="color-start">开始周期取帧</button><button class="button secondary" id="color-stop">停止</button><button class="button secondary" id="color-export">导出 CSV</button><button class="button secondary" id="color-reset">清空结果</button></div><p id="color-status" role="status" aria-live="polite">尚未开始。全部计算在本机页面进行；刷新会丢失未导出的结果。</p><svg id="color-chart" viewBox="0 0 600 180" role="img" aria-label="原始和参考校正后的色差曲线" style="width:100%;max-width:800px;height:auto;background:#f6f8fb"></svg><p>蓝线：原始 ΔE00；绿线：校正后的 ΔE00，均相对于首帧。采集位置变化无法自动识别，请人工核对。</p><div id="color-plate-result" style="overflow:auto"></div><div id="color-log" style="overflow:auto;max-height:280px"></div>`;
  root.append(section);const element=id=>section.querySelector('#'+id),canvas=element('color-canvas'),context=canvas.getContext('2d',{willReadFrequently:true}),imageCanvas=document.createElement('canvas'),imageContext=imageCanvas.getContext('2d',{willReadFrequently:true});
  const summaryButton=document.createElement('button');summaryButton.className='button secondary';summaryButton.textContent='摘要传入待保存区';element('color-export').after(summaryButton);
  const options=document.createElement('div');options.className='cloud-actions';options.innerHTML='<label>校正方法<select id="color-method"><option value="gray">灰卡相对校正</option><option value="matrix">多色块矩阵校正</option></select></label><button id="color-patch" class="button secondary">框选色卡参考块</button><button id="color-undo-patch" class="button secondary">撤销末个参考块</button><label>孔板类型<select id="color-layout"><option value="8,12">96 孔</option><option value="6,8">48 孔</option><option value="4,6">24 孔</option><option value="3,4">12 孔</option><option value="2,3">6 孔</option></select></label><button id="color-corners" class="button secondary">按四角定位孔板</button><button id="color-clear-plate" class="button secondary">取消孔板</button><button id="color-json" class="button secondary">导出完整结果 JSON</button><label>重新打开结果<input id="color-open-result" type="file" accept=".json,application/json"></label><button id="color-save-data" class="button secondary">完整结果传入待保存区</button>';
  element('color-mode').before(options);
  const help=document.createElement('p');help.textContent='矩阵法：选 6–24 个不同颜色且位置固定的参考块，以首帧为目标。孔板四角顺序：左上 → 右上 → 右下 → 左下；请人工核对网格。导入结果只读，可查看、导出或另存附件。';options.after(help);
  const exports=document.createElement('div');exports.className='cloud-actions color-exports';
  for(const control of [element('color-export'),summaryButton,element('color-json'),element('color-open-result').closest('label'),element('color-save-data'),element('color-reset')])exports.append(control);
  const exportTitle=document.createElement('h3');exportTitle.textContent='保存与重新打开';element('color-log').before(exportTitle,exports);
  let mode='reference',drag=null,reference=null,sample=null,plate=null,frame=null,base=null,rows=[],timer=null,pending=null,epoch=crypto.randomUUID().replaceAll('-',''),watching=false,generation=0,sourceNonce=null,dirty=false,patches=[],corners=[],readOnly=false,imageGeneration=0;
  const status=value=>{element('color-status').textContent=value;};
  const notify=operation=>Promise.resolve().then(operation).catch(error=>status(error.message)).finally(availability);
  const validRect=box=>box&&box.w>=10&&box.h>=10;
  function configure(){if(readOnly)throw new Error('这是只读来源结果。请先导出，再清空结果以开始新测量。');stop();if(rows.length&&!confirm('更改设置需要重新建立基准。请先导出已有结果；继续吗？'))return false;base=null;rows=[];dirty=false;return true;}
  element('color-method').onchange=()=>notify(()=>{const previous=base?.method||'gray';if(!configure()){element('color-method').value=previous;return;}render();});
  element('color-layout').onchange=()=>notify(()=>{const previous=base?.layout||'8,12';if(configure()){render();draw();}else element('color-layout').value=previous;});
  element('color-patch').onclick=()=>notify(()=>{if(readOnly)throw new Error('请先清空只读结果。');stop();mode='patch';element('color-mode').textContent=`拖框选第 ${patches.length+1} 个固定参考色块，最多 24 个。`;});
  element('color-undo-patch').onclick=()=>notify(()=>{if(configure()){patches.pop();draw();render();}});
  element('color-corners').onclick=()=>notify(()=>{if(configure()){plate=null;corners=[];mode='corner';render();draw();element('color-mode').textContent='依次点击孔板左上、右上、右下、左下四角。';}});
  element('color-clear-plate').onclick=()=>notify(()=>{if(configure()){plate=null;corners=[];render();draw();}});
  async function sessionData(){if(!rows.length||!base)throw new Error('请先记录数据。');const content=validateColorSession({schema:'colorlens-color-session-1',method:base.method||'gray',createdAt:base.createdAt||rows[0].time,baseline:{reference:base.reference,sample:base.sample,patches:base.patches||[]},rows});return {...content,sha256:await sha(JSON.stringify(content))};}
  element('color-json').onclick=()=>notify(async()=>{const data=await sessionData();saveBlob(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),'镜析-完整显色结果.json');dirty=false;status('完整结果已发起下载；请确认文件保存成功。');});
  element('color-open-result').onchange=()=>notify(async()=>{const file=element('color-open-result').files[0];try{if(!file)return;if(file.size>8*1048576)throw new Error('结果 JSON 最大 8 MB。');const parsed=JSON.parse(await file.text()),content=validateColorSession(parsed);if(parsed.sha256!==await sha(JSON.stringify(content)))throw new Error('结果校验失败，文件可能损坏或被修改。');if(dirty&&!confirm('打开结果会替换本页未导出的数据，继续吗？'))return;stop();imageGeneration++;readOnly=true;base={...content.baseline,method:content.method,createdAt:content.createdAt,entryId:getEntryId()};rows=content.rows;frame=null;patches=[];corners=[];reference=null;sample=null;plate=null;dirty=false;element('color-method').value=content.method;context.clearRect(0,0,canvas.width,canvas.height);imageContext.clearRect(0,0,imageCanvas.width,imageCanvas.height);render();status('已重新打开完整结果（只读）。不恢复眼镜取帧或原始图像；开始新测量前请清空。');}finally{element('color-open-result').value='';}});
  element('color-save-data').onclick=()=>notify(async()=>{const target=getEntryId();if(!target||target!==base?.entryId)throw new Error('请切回该观察所属实验；来源结果可在打开时选择的实验另存。');const data=await sessionData(),key=data.sha256.slice(0,32),resultId=[key.slice(0,8),key.slice(8,12),key.slice(12,16),key.slice(16,20),key.slice(20)].join('-');await queue({kind:'file',entryId:target,id:resultId,source:'完整显色结果 JSON（待人工核对）',capturedAt:new Date().toISOString(),bytes:new TextEncoder().encode(JSON.stringify(data)),filename:'显色完整结果-'+data.sha256.slice(0,12)+'.json',reviewed:false});status('完整数据已进入上方待保存区；确认后作为实验附件保存。');});
  function draw(){
    if(!frame)return;canvas.width=imageCanvas.width;canvas.height=imageCanvas.height;context.drawImage(imageCanvas,0,0);
    for(const [box,color] of [[reference,'#10b981'],[sample,'#2563eb'],[plate,'#f97316'],[drag?.box,'#e11d48']])if(box){context.strokeStyle=color;context.lineWidth=3;context.strokeRect(box.x,box.y,box.w,box.h);}
    patches.forEach((box,index)=>{context.strokeStyle='#a855f7';context.strokeRect(box.x,box.y,box.w,box.h);context.fillStyle='#7e22ce';context.font='14px sans-serif';context.fillText('P'+(index+1),box.x,Math.max(14,box.y-3));});
    if(corners.length){context.strokeStyle='#f97316';context.beginPath();corners.forEach((point,index)=>{if(index)context.lineTo(point.x,point.y);else context.moveTo(point.x,point.y);});if(corners.length===4)context.closePath();context.stroke();corners.forEach(point=>{context.fillStyle='#f97316';context.fillRect(point.x-4,point.y-4,8,8);});}
    if(corners.length===4){try{const project=plateProjection(corners,canvas.width,canvas.height),[rowCount,columnCount]=element('color-layout').value.split(',').map(Number);context.lineWidth=1;for(const [count,horizontal] of [[rowCount,true],[columnCount,false]])for(let index=1;index<count;index++){const start=horizontal?project(0,index/count):project(index/count,0),end=horizontal?project(1,index/count):project(index/count,1);context.beginPath();context.moveTo(start.x,start.y);context.lineTo(end.x,end.y);context.stroke();}}catch(error){status(error.message);}}
  }
  const point=event=>{const bounds=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(canvas.width,Math.round((event.clientX-bounds.left)*canvas.width/bounds.width))),y:Math.max(0,Math.min(canvas.height,Math.round((event.clientY-bounds.top)*canvas.height/bounds.height)))};};
  canvas.onpointerdown=event=>{if(!frame||readOnly)return;if(watching)stop();const start=point(event);drag={start,box:null};canvas.setPointerCapture(event.pointerId);};
  canvas.onpointermove=event=>{if(!drag)return;const end=point(event);drag.box={x:Math.min(drag.start.x,end.x),y:Math.min(drag.start.y,end.y),w:Math.abs(drag.start.x-end.x),h:Math.abs(drag.start.y-end.y)};draw();};
  canvas.onpointerup=()=>{if(!drag)return;const {box,start}=drag;drag=null;if(readOnly)return;
    if(mode==='corner'){if(corners.length<4)corners.push(start);draw();element('color-mode').textContent=corners.length===4?'四角已选，请核对孔板类型并设定基准。':'继续点击：'+['左上','右上','右下','左下'][corners.length];return;}
    if(!validRect(box))return;if(mode==='patch'&&patches.length>=24){status('最多 24 个色卡参考块。');return;}
    if(rows.length&&!confirm('重新框选需要清除已有结果，请先导出；继续吗？'))return;
    stop();base=null;rows=[];dirty=false;
    if(mode==='reference')reference=box;else if(mode==='sample')sample=box;else if(mode==='patch')patches.push(box);else{plate=box;corners=[];}
    render();draw();status('区域已更新；请重新设为基准。');
  };
  for(const value of ['reference','sample','plate'])element('color-'+value).onclick=()=>{mode=value;element('color-mode').textContent='请在画面拖动框选：'+{reference:'中性灰参考卡',sample:'样品区域',plate:'整块 96 孔板（横向 12 列、纵向 8 行）'}[value];};
  function region(box){if(!validRect(box)||box.x+box.w>imageCanvas.width||box.y+box.h>imageCanvas.height)throw new Error('所选区域无效或画面尺寸已变化，请重新框选。');const pixels=imageContext.getImageData(box.x,box.y,box.w,box.h).data,totals=[0,0,0];let clipped=0;for(let index=0;index<pixels.length;index+=4){for(let channel=0;channel<3;channel++)totals[channel]+=pixels[index+channel];if(pixels[index]>=250||pixels[index+1]>=250||pixels[index+2]>=250)clipped++;}return {rgb:totals.map(value=>value/(pixels.length/4)),clipped:clipped/(pixels.length/4)};}
  function cells(){
    if(!plate&&corners.length===0)return [];if(corners.length&&corners.length!==4)throw new Error('请完成四角定位。');
    const selected=corners.length?corners:[{x:plate.x,y:plate.y},{x:plate.x+plate.w-1,y:plate.y},{x:plate.x+plate.w-1,y:plate.y+plate.h-1},{x:plate.x,y:plate.y+plate.h-1}];
    const [rowCount,columnCount]=element('color-layout').value.split(',').map(Number);
    return projectedWells(imageCanvas.width,imageCanvas.height,imageContext.getImageData(0,0,imageCanvas.width,imageCanvas.height).data,selected,rowCount,columnCount);
  }
  function measure(isBaseline){
    if(readOnly)throw new Error('来源结果只读；请先清空再开始新测量。');
    const method=element('color-method').value;
    if(!frame||!sample||method==='gray'&&!reference)throw new Error('请先取画面并框选样品及灰卡。');
    if(!isBaseline&&rows.length>=200)throw new Error('已达到 200 个时间点，请先导出并开始新观察。');
    if(!isBaseline&&rows.at(-1)?.time===frame.time)throw new Error('当前画面已记录，请先获取新画面。');
    const currentSample=region(sample),currentPatches=patches.map(region);
    if(method==='matrix'&&currentPatches.length<6)throw new Error('矩阵法需要至少 6 个不同颜色的固定参考块。');
    const currentReference=reference?region(reference):{rgb:[0,1,2].map(channel=>currentPatches.reduce((sum,item)=>sum+item.rgb[channel],0)/currentPatches.length),clipped:0};
    if([currentSample,currentReference,...currentPatches].some(item=>item.clipped>0.02))throw new Error('参考或样品区域高亮饱和超过 2%，请调整光照和位置。');
    const wells=cells();if(wells.some(well=>well.clipped>0.02))throw new Error('部分孔位高亮饱和超过 2%，请调整光照。');
    const proposed=isBaseline?{reference:currentReference.rgb,sample:currentSample.rgb,patches:currentPatches.map(item=>item.rgb),method,layout:element('color-layout').value,width:imageCanvas.width,height:imageCanvas.height,entryId:getEntryId()}:base;
    if(!proposed)throw new Error('请先设置基准。');
    if(proposed.entryId!==getEntryId())throw new Error('目标实验已变化，请先导出并清空结果。');
    if(proposed.width!==imageCanvas.width||proposed.height!==imageCanvas.height||proposed.method!==method||proposed.layout!==element('color-layout').value)throw new Error('设置或尺寸变化，请重新设定基准。');
    const fit=method==='matrix'?fitColorMatrix(currentPatches.map(item=>item.rgb),proposed.patches):null;
    const correct=rgb=>fit?applyColorMatrix(rgb,fit.matrix):correctColor(rgb,currentReference.rgb,proposed.reference);
    const corrected=correct(currentSample.rgb);if(corrected.clipped)throw new Error('校正后的样品颜色超出范围，请调整光照。');
    const correctedWells=wells.map(well=>{const result=correct(well.rgb);if(result.clipped)throw new Error('孔位校正颜色超出范围，请调整光照。');return {...well,corrected:result.rgb};});
    const record={time:frame.time,raw:deltaE(rgbLab(proposed.sample),rgbLab(currentSample.rgb)),adjusted:deltaE(rgbLab(proposed.sample),rgbLab(corrected.rgb)),reference:currentReference.rgb,sample:currentSample.rgb,corrected:corrected.rgb,patches:currentPatches.map(item=>item.rgb),residual:fit?.residual||0,wells:correctedWells};
    if(isBaseline){base=proposed;rows=[];}rows.push(record);dirty=true;render();
    status('已记录 '+rows.length+'/200 个时间点。'+(fit?'色卡平均拟合色差 '+fit.residual.toFixed(2)+'（不是独立精度验证）。':'')+' 请核对样品与参考块位置，完成后导出或保存附件。');
  }
  function availability(){
    const capture=getCapture(),connected=capture&&!capture.source.closed&&capture.expiresAt>Date.now(),busy=watching||Boolean(pending);
    for(const key of ['color-baseline','color-record','color-start','color-frame','color-file','color-reference','color-sample','color-plate','color-patch','color-corners','color-method','color-layout','color-clear-plate','color-undo-patch'])element(key).disabled=readOnly||busy;
    element('color-frame').disabled=readOnly||busy||!connected;
    element('color-baseline').disabled=readOnly||busy||!frame||!sample||(element('color-method').value==='gray'?!reference:patches.length<6);
    element('color-record').disabled=readOnly||busy||!base||!frame||rows.at(-1)?.time===frame.time;
    element('color-start').disabled=readOnly||busy||!base||!connected;
    element('color-stop').disabled=!busy;
    for(const key of ['color-export','color-json','color-save-data'])element(key).disabled=!rows.length;
    summaryButton.disabled=!rows.length;
  }
  function render(){
    const chart=element('color-chart'),maximum=Math.max(1,...rows.flatMap(row=>[row.raw,row.adjusted]));chart.replaceChildren();
    const svgText=(value,left,top)=>{const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',left);label.setAttribute('y',top);label.setAttribute('font-size','12');label.textContent=value;chart.append(label);};
    svgText('ΔE00 '+maximum.toFixed(1),3,15);svgText('0',3,160);svgText('采集时间 →',480,178);
    for(const [key,color] of [['raw','#2563eb'],['adjusted','#059669']]){const line=document.createElementNS('http://www.w3.org/2000/svg','polyline');line.setAttribute('fill','none');line.setAttribute('stroke',color);line.setAttribute('stroke-width','3');line.setAttribute('points',rows.map(row=>`${45+(Date.parse(row.time)-Date.parse(rows[0].time))*530/Math.max(1,Date.parse(rows.at(-1).time)-Date.parse(rows[0].time))},${155-row[key]/maximum*125}`).join(' '));chart.append(line);}
    element('color-log').replaceChildren(...rows.slice().reverse().map(row=>{const item=document.createElement('p');item.textContent=`${row.time} · 原始 ΔE00 ${row.raw.toFixed(2)} · 校正 ΔE00 ${row.adjusted.toFixed(2)}`;return item;}));
    const target=element('color-plate-result');target.replaceChildren();const wells=rows.at(-1)?.wells||[];
    if(wells.length){const table=document.createElement('table');table.setAttribute('aria-label','孔板校正颜色');for(const rowLabel of [...new Set(wells.map(well=>well.label[0]))]){const line=document.createElement('tr');for(const well of wells.filter(well=>well.label[0]===rowLabel)){const cell=document.createElement('td');cell.textContent=well.label;cell.title='校正 RGB '+well.corrected.map(Math.round).join(', ');cell.style.backgroundColor='rgb('+well.corrected.map(Math.round).join(',')+')';cell.style.color=well.corrected.reduce((sum,value)=>sum+value,0)<380?'white':'black';cell.style.padding='8px';line.append(cell);}table.append(line);}target.append(table);}
    for(const key of ['color-baseline','color-record','color-start','color-frame','color-file','color-reference','color-sample','color-plate','color-patch','color-corners','color-method','color-layout','color-clear-plate','color-undo-patch'])element(key).disabled=readOnly;
    element('color-plate').textContent='框选 '+element('color-layout').value.split(',').map(Number).reduce((product,value)=>product*value,1)+' 孔板';
    availability();
  }
  async function setImage(blob,time,expectedGeneration=generation){
    if(readOnly)throw new Error('来源结果只读，请先清空。');const serial=++imageGeneration,bitmap=await createImageBitmap(blob);
    try{
      if(serial!==imageGeneration||expectedGeneration!==generation)throw new Error('取帧已停止，未应用迟到画面。');
      if(bitmap.width*bitmap.height>32000000)throw new Error('图片超过 3200 万像素。');
      const ratio=Math.min(1,960/bitmap.width,720/bitmap.height),width=Math.round(bitmap.width*ratio),height=Math.round(bitmap.height*ratio);
      if(frame&&(width!==imageCanvas.width||height!==imageCanvas.height)){if(rows.length)throw new Error('画面尺寸变化，请先导出并清空结果。');base=null;reference=null;sample=null;plate=null;patches=[];corners=[];render();}
      imageCanvas.width=width;imageCanvas.height=height;imageContext.drawImage(bitmap,0,0,width,height);frame={time};draw();
    }finally{bitmap.close();}
  }
  function requestFrame(){const capture=getCapture();if(!capture||capture.source.closed||capture.expiresAt<=Date.now())throw new Error('请先打开并连接本机眼镜采集窗口。');if(sourceNonce&&sourceNonce!==capture.nonce&&base)throw new Error('采集窗口已切换，请清空结果后重新设定基准。');sourceNonce=capture.nonce;const requestId=crypto.randomUUID().replaceAll('-','');return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending=null;reject(new Error('取帧超时，请检查直播。'));},8000);pending={id:requestId,resolve:message=>{clearTimeout(timeout);pending=null;resolve(message);},reject:error=>{clearTimeout(timeout);pending=null;reject(error);}};capture.source.postMessage({protocol:captureProtocol,nonce:capture.nonce,type:'request-observation',requestId,epoch},capture.origin);});}
  async function acquire(){if(pending)throw new Error('正在等待上一帧。');const current=generation,message=await requestFrame();if(current!==generation)throw new Error('采集已停止。');await setImage(new Blob([message.image],{type:'image/jpeg'}),message.capturedAt);}
  function stop(message='周期取帧已停止。'){watching=false;generation++;clearTimeout(timer);if(pending){pending.reject(new Error('取帧已停止。'));pending=null;}status(message);availability();}
  async function tick(current){try{await acquire();if(!watching||current!==generation)return;measure(false);timer=setTimeout(()=>void tick(current),Number(element('color-interval').value)*1000);}catch(error){if(current===generation)stop('周期取帧已停止：'+error.message);}finally{availability();}}
  element('color-frame').onclick=()=>notify(async()=>{await acquire();status('已获取画面。确认参考卡、样品位置后设置基准或记录。');});
  element('color-file').onchange=()=>notify(async()=>{const file=element('color-file').files[0];if(!file)return;if(watching||pending)stop();if(file.size>20*1048576)throw new Error('请选择 20 MB 以内的图片。');await setImage(file,new Date().toISOString());element('color-file').value='';status('已载入本机图片，拍摄时间未验证。');});
  element('color-baseline').onclick=()=>notify(()=>{if(rows.length&&!confirm('重新设定基准会清除本页已有结果，请先导出；继续吗？'))return;measure(true);});element('color-record').onclick=()=>notify(()=>{if(rows.at(-1)?.time===frame?.time)throw new Error('当前画面已记录，请先获取新画面。');measure(false);});
  element('color-start').onclick=()=>notify(()=>{if(!base)throw new Error('请先设置基准。');if(watching)return;watching=true;generation++;void tick(generation);});element('color-stop').onclick=()=>stop();
  element('color-reset').onclick=()=>{if(dirty&&!confirm('清空会丢失未保存数据，继续吗？'))return;stop();imageGeneration++;base=null;rows=[];reference=null;sample=null;plate=null;patches=[];corners=[];sourceNonce=null;dirty=false;readOnly=false;epoch=crypto.randomUUID().replaceAll('-','');render();draw();status('已清空，可以选择新画面并开始测量。');};
  element('color-export').onclick=()=>notify(()=>{if(!rows.length)throw new Error('没有可导出的记录。');const escape=value=>'"'+String(value).replaceAll('"','""')+'"',lines=[['time','raw_delta_e00','corrected_delta_e00','reference_rgb','sample_rgb','corrected_rgb','well','well_corrected_rgb'].join(',')];for(const row of rows){const wells=row.wells.length?row.wells:[{label:'',corrected:[]}];for(const well of wells)lines.push([row.time,row.raw,row.adjusted,row.reference.join('/'),row.sample.join('/'),row.corrected.join('/'),well.label,well.corrected.join('/')].map(escape).join(','));}const url=URL.createObjectURL(new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='镜析-显色观察.csv';link.click();dirty=false;setTimeout(()=>URL.revokeObjectURL(url),60000);});
  summaryButton.onclick=()=>notify(async()=>{if(!rows.length||!base?.entryId)throw new Error('请先选择实验并记录数据。');if(getEntryId()!==base.entryId)throw new Error('观察属于原目标实验，请切回后保存或导出 CSV。');const latest=rows.at(-1),summary=['【显色观察摘要：需人工核对】',(base.method==='matrix'?'首帧多色块矩阵相对校正。':'首帧灰卡相对校正。')+'图像颜色变化不是吸光度或浓度。'+(readOnly?'这是导入的来源结果。':''),`共 ${rows.length} 个时间点；以下列出最近 ${Math.min(rows.length,80)} 个，完整数据请另行导出 CSV。`,...rows.slice(-80).map(row=>`${row.time} 原始 ΔE00 ${row.raw.toFixed(2)}；校正 ${row.adjusted.toFixed(2)}`),`末帧孔板：${latest.wells.length?latest.wells.length+' 个手动框选孔位':'未选择'}`, '区域位置需人工核对；灰卡校正不保证消除光照和压缩误差。'].join('\n');await queue({kind:'text',entryId:base.entryId,id:crypto.randomUUID(),source:'显色观察摘要（待人工复核）',capturedAt:new Date().toISOString(),text:summary,reviewed:false});status('摘要已进入上方待保存区；需人工核对后确认写入。');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&watching)stop('页面转入后台，周期取帧已停止。');});window.addEventListener('hashchange',()=>{if(watching&&!location.hash.startsWith('#glasses'))stop('离开采集页，周期取帧已停止。');});
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  availability();
  return {connected:availability,confirmExit(){return !dirty||confirm('显色观察有未导出数据，退出将丢失，继续吗？');},receive(message){if(!pending||message.requestId!==pending.id)return;if(message.type==='observation-unavailable')pending.reject(new Error(message.reason));else pending.resolve(message);},disconnect(){if(watching||pending)stop('采集窗口已关闭，周期取帧已停止。');},reset(){stop();imageGeneration++;base=null;rows=[];reference=null;sample=null;plate=null;patches=[];corners=[];readOnly=false;frame=null;sourceNonce=null;dirty=false;context.clearRect(0,0,canvas.width,canvas.height);imageContext.clearRect(0,0,imageCanvas.width,imageCanvas.height);render();}};
}
