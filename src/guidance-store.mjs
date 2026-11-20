import {check,text,first,rows} from './common.mjs';

export function guidanceProtocol(value){
  check(value&&typeof value==='object'&&!Array.isArray(value),'SOP 格式无效。');
  const title=text(value.title,160,'方案标题',true).trim();
  check(Array.isArray(value.steps)&&value.steps.length>=1&&value.steps.length<=30,'SOP 需要 1–30 个步骤。');
  const steps=value.steps.map((step,index)=>{
    check(step&&typeof step==='object'&&!Array.isArray(step),'步骤格式无效。');
    const timer=step.timer_seconds??0;
    check(Number.isInteger(timer)&&timer>=0&&timer<=86400,'步骤计时需为 0–86400 秒。');
    return {number:index+1,title:text(step.title,160,'步骤标题',true).trim(),instruction:text(step.instruction||'',1600,'步骤说明'),evidence:text(step.evidence||'',700,'可见证据'),watch_for:text(step.watch_for||'',700,'注意事项'),timer_seconds:timer};
  });
  const protocol={title,source:text(value.source||'用户提供，尚未独立核实',400,'方案来源'),steps};
  check(new TextEncoder().encode(JSON.stringify(protocol)).length<=24000,'SOP 超过 24 KB，请缩短或拆分。');
  return protocol;
}
export async function guidanceRow(env,user,id){
  check(typeof id==='string'&&/^[a-f0-9]{32}$/.test(id),'指导会话不存在。',404);
  const row=await first(env,'SELECT * FROM guidance_runs WHERE id=? AND owner=?',id,user.id);
  check(row,'指导会话不存在或无权访问。',404);
  return row;
}
export function guidanceView(row){
  return {id:row.id,entry_id:row.entry_id,revision:row.revision,...JSON.parse(row.data),monitor:{epoch:row.epoch,expires_at:row.consent_until,interval_s:row.interval_s,maximum:row.max_calls,used:row.used,busy:Boolean(row.busy_id)&&row.last_call>Date.now()-90000},created_at:row.created_at,updated_at:row.updated_at};
}
export async function guidanceEvents(env,user,id){
  return (await rows(env,'SELECT id,kind,status,data,created_at,completed_at FROM guidance_events WHERE run_id=? AND owner=? ORDER BY created_at,id',id,user.id)).map(event=>({...event,data:JSON.parse(event.data)}));
}
export async function archiveGuidance(env,user,entryId){
  const runs=await rows(env,'SELECT * FROM guidance_runs WHERE owner=? AND entry_id=? ORDER BY created_at,id',user.id,entryId);
  return Promise.all(runs.map(async row=>{
    const state=guidanceView(row);delete state.monitor;delete state.source_nonce;
    return {...state,events:await guidanceEvents(env,user,row.id),notice:'来源指导记录；AI 观察未经独立核验，导入不恢复采集授权或原生签名。'};
  }));
}
