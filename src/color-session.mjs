const ensure=(value,message)=>{if(!value)throw new Error(message);};
const rgb=value=>{ensure(Array.isArray(value)&&value.length===3&&value.every(channel=>Number.isFinite(channel)&&channel>=0&&channel<=255),'结果颜色数据无效。');return [...value];};
const scalar=value=>{ensure(Number.isFinite(value)&&value>=0&&value<=1000,'结果数值无效。');return value;};
const timestamp=value=>{ensure(typeof value==='string'&&value.length<40&&Number.isFinite(Date.parse(value)),'结果时间无效。');return value;};
const patches=value=>{ensure(Array.isArray(value)&&value.length<=24,'色块列表无效。');return value.map(rgb);};
export function validateColorSession(input){
  ensure(input?.schema==='colorlens-color-session-1'&&['gray','matrix'].includes(input.method),'不是支持的镜析显色结果。');
  ensure(input.baseline&&Array.isArray(input.rows)&&input.rows.length>=1&&input.rows.length<=200,'结果时间点数量无效。');
  const baseline={reference:rgb(input.baseline.reference),sample:rgb(input.baseline.sample),patches:patches(input.baseline.patches??[])};
  ensure(baseline.patches.length<=24&&(input.method!=='matrix'||baseline.patches.length>=6),'基准色块数量无效。');
  const rows=input.rows.map(row=>{
    ensure(row&&Array.isArray(row.wells)&&[0,6,12,24,48,96].includes(row.wells.length),'孔位数据无效。');const labels=new Set();
    const wells=row.wells.map(well=>{ensure(well&&typeof well.label==='string'&&/^[A-H](?:[1-9]|1[0-2])$/.test(well.label)&&!labels.has(well.label),'孔位编号无效或重复。');labels.add(well.label);ensure(Number.isFinite(well.clipped)&&well.clipped>=0&&well.clipped<=1,'孔位饱和比例无效。');return {label:well.label,rgb:rgb(well.rgb),corrected:rgb(well.corrected),clipped:well.clipped};});
    const currentPatches=patches(row.patches??[]);ensure(input.method!=='matrix'||currentPatches.length===baseline.patches.length,'结果色块数量无效。');
    return {time:timestamp(row.time),raw:scalar(row.raw),adjusted:scalar(row.adjusted),reference:rgb(row.reference),sample:rgb(row.sample),corrected:rgb(row.corrected),patches:currentPatches,residual:scalar(row.residual??0),wells};
  });
  ensure(rows.every((row,index)=>!index||Date.parse(row.time)>=Date.parse(rows[index-1].time)),'结果时间顺序错误。');
  return {schema:input.schema,method:input.method,createdAt:timestamp(input.createdAt),baseline,rows,notice:'来源显色数据；不含原始图像、账号或采集授权。导入只读，不恢复测量。'};
}
