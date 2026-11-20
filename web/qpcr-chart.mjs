import {saveBlob} from './transport.mjs';

const namespace='http://www.w3.org/2000/svg';
const format=value=>value===0?'0':Math.abs(value)<0.001||Math.abs(value)>=10000?value.toExponential(2):String(Number(value.toPrecision(4)));
export function qpcrChartData(result,target){
  const key=result.method==='standard'?'quantity':result.method==='dct'?'normalized_expression':'fold_change';
  const label=key==='quantity'?'模板量（'+result.quantity_unit+'）':key==='fold_change'?'相对表达倍数 RQ':'内参归一化相对量';
  const grouped=new Map();
  for(const row of result.rows.filter(item=>item.target===target)){
    const value=row[key];if(!Number.isFinite(value))throw new Error('结果包含无法绘图的数值，请检查原始计算。');
    if(!grouped.has(row.group))grouped.set(row.group,[]);grouped.get(row.group).push({id:row.sample_id,value});
  }
  const groups=[...grouped].map(([name,points])=>{
    const mean=points.reduce((total,point)=>total+point.value,0)/points.length;
    const sd=points.length>1?Math.sqrt(points.reduce((total,point)=>total+(point.value-mean)**2,0)/(points.length-1)):null;
    if(!Number.isFinite(mean)||sd!==null&&!Number.isFinite(sd))throw new Error('数值跨度超出图形支持范围，请查看原始结果表。');
    return {name,points,mean,sd};
  });
  if(!groups.length)throw new Error('此目标基因没有可绘图的样本。');
  return {target,key,label,groups};
}
function svgElement(parent,tag,attributes={},text){
  const node=document.createElementNS(namespace,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;parent.append(node);return node;
}
function plot(data,result){
  const width=Math.max(720,140+data.groups.length*110),height=460,left=105,right=25,top=68,bottom=108;
  const lower=Math.min(0,...data.groups.map(group=>group.mean-(group.sd??0))),upper=Math.max(...data.groups.flatMap(group=>[group.mean+(group.sd??0),...group.points.map(point=>point.value)]));
  const minimum=lower<0?lower*1.08:0,maximum=upper>minimum?upper+(upper-minimum)*0.12:minimum+1;
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||!Number.isFinite(maximum-minimum))throw new Error('数值跨度超出图形坐标支持范围，请查看结果表。');
  const ordinate=value=>height-bottom-(value-minimum)/(maximum-minimum)*(height-top-bottom);
  const svg=document.createElementNS(namespace,'svg');svg.setAttribute('width',width);svg.setAttribute('height',height);svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',data.target+' '+data.label+'，样本点和算术均值±样本SD');
  svgElement(svg,'title',{},(result.simulated?'模拟数据 · ':'')+data.target+' · '+data.label);
  svgElement(svg,'desc',{},'每点为合并技术行后的一个样本ID。短横线为算术均值，误差线为样本SD，不是SEM或置信区间。不进行显著性检验。');
  svgElement(svg,'metadata',{},JSON.stringify({algorithm:result.algorithm,method:result.method,formula:result.formula,input_type:result.input_type,target:data.target,reference_gene:result.reference_gene,reference_config:result.reference_config,normalization:result.normalization,reference_summary:result.reference_summary,control_group:result.control_group,calibration:result.calibration,replicate_kind:result.replicate_kind,target_efficiency:result.target_efficiency,reference_efficiency:result.reference_efficiency,quantity_unit:result.quantity_unit,simulated:result.simulated,groups:data.groups}));
  svgElement(svg,'rect',{width,height,fill:'#ffffff'});
  const font={'font-family':'Arial, Microsoft YaHei, sans-serif',fill:'#234335','font-size':12};
  svgElement(svg,'text',{...font,x:left,y:26,'font-size':17,'font-weight':600},(result.simulated?'模拟数据 · ':'')+data.target+' · '+result.method_name);
  svgElement(svg,'text',{...font,x:left,y:47},'点＝样本 ID；横线＝算术均值；误差线＝样本 SD（n<2 不显示）；无显著性标记');
  for(let tick=0;tick<=4;tick++){
    const value=minimum+(maximum-minimum)*tick/4,position=ordinate(value);
    svgElement(svg,'line',{x1:left,y1:position,x2:width-right,y2:position,stroke:'#e1e8df'});
    svgElement(svg,'text',{...font,x:left-12,y:position+4,'text-anchor':'end'},format(value));
  }
  svgElement(svg,'text',{...font,x:left,y:top-8},data.label);
  svgElement(svg,'line',{x1:left,y1:ordinate(0),x2:width-right,y2:ordinate(0),stroke:'#809384'});
  const spacing=(width-left-right)/data.groups.length;
  for(const [index,group] of data.groups.entries()){
    const center=left+spacing*(index+0.5);
    if(group.sd!==null){
      svgElement(svg,'line',{x1:center,y1:ordinate(group.mean-group.sd),x2:center,y2:ordinate(group.mean+group.sd),stroke:'#315d49','stroke-width':2});
      for(const endpoint of [group.mean-group.sd,group.mean+group.sd])svgElement(svg,'line',{x1:center-9,y1:ordinate(endpoint),x2:center+9,y2:ordinate(endpoint),stroke:'#315d49','stroke-width':2});
    }
    for(const [pointIndex,point] of group.points.entries()){
      const jitter=group.points.length===1?0:((pointIndex*7)%13-6)*3;
      const circle=svgElement(svg,'circle',{cx:center+jitter,cy:ordinate(point.value),r:4,fill:'#648e72','fill-opacity':0.7});svgElement(circle,'title',{},point.id+' · '+group.name+' · '+format(point.value));
    }
    svgElement(svg,'line',{x1:center-24,y1:ordinate(group.mean),x2:center+24,y2:ordinate(group.mean),stroke:'#173c2b','stroke-width':3});
    const label=svgElement(svg,'text',{...font,x:center,y:height-bottom+24,'text-anchor':'middle'},group.name.length>12?group.name.slice(0,11)+'…':group.name);svgElement(label,'title',{},group.name);
    svgElement(svg,'text',{...font,x:center,y:height-bottom+44,'text-anchor':'middle'},'样本 ID n='+group.points.length);
  }
  svgElement(svg,'text',{...font,x:left,y:height-30},'样本分组 · '+(result.replicate_kind==='biological'?'用户声明为独立生物样本':'未声明独立生物重复，n 不解释为生物学 n'));
  svgElement(svg,'text',{...font,x:left,y:height-10},'图形依据当前样本结果生成；SD 可跨过零，不表示真实表达量为负。');return svg;
}
export function renderQpcrChart(target,result){
  const section=document.createElement('section');section.className='qpcr-chart';const heading=document.createElement('h3');heading.textContent='样本分布与分组描述图';section.append(heading);
  const controls=document.createElement('div');controls.className='cloud-actions';const label=document.createElement('label');label.textContent='目标基因 ';const select=document.createElement('select');select.setAttribute('aria-label','图表目标基因');
  for(const gene of [...new Set(result.rows.map(row=>row.target))]){const option=document.createElement('option');option.value=gene;option.textContent=gene;select.append(option);}label.append(select);controls.append(label);
  const vector=document.createElement('button'),raster=document.createElement('button');for(const button of [vector,raster]){button.type='button';button.className='button secondary';}vector.textContent='导出图形 SVG';raster.textContent='导出图形 PNG';controls.append(vector,raster);section.append(controls);
  const viewport=document.createElement('div');viewport.className='qpcr-chart-viewport';viewport.tabIndex=0;section.append(viewport);const status=document.createElement('p');status.className='cloud-status';status.setAttribute('role','status');section.append(status);target.append(section);
  let current;
  const update=()=>{viewport.replaceChildren();current=null;try{current=plot(qpcrChartData(result,select.value),result);viewport.append(current);status.textContent='图形仅用于描述；未计算 p 值。导出仅在主动点击时执行。';}catch(error){status.textContent=error.message;}vector.disabled=raster.disabled=!current;};select.onchange=update;update();
  const blob=()=>new Blob([new XMLSerializer().serializeToString(current)],{type:'image/svg+xml;charset=utf-8'});
  const filename=()=>('ColorLens-qPCR-'+select.value).replace(/[^\p{L}\p{N}_.-]/gu,'_').slice(0,120);
  vector.onclick=()=>{if(current)saveBlob(blob(),filename()+'.svg');};
  raster.onclick=async()=>{
    if(!current)return;const svg=current,width=Number(svg.getAttribute('width'))*2,height=Number(svg.getAttribute('height'))*2;if(width>8192||width*height>32000000){status.textContent='图形过宽，请导出 SVG 或减少分组后导出 PNG。';return;}
    raster.disabled=true;select.disabled=true;const outputName=filename(),url=URL.createObjectURL(blob());
    try{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(image,0,0,width,height);const output=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!output)throw new Error('PNG 编码失败，请改用 SVG。');saveBlob(output,outputName+'.png');status.textContent='PNG 已交给浏览器下载。';}catch(error){status.textContent=error.message;}finally{URL.revokeObjectURL(url);raster.disabled=!current;select.disabled=false;}
  };
}
