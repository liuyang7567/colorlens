import {check,text,query} from './common.mjs';
import {membership,accessGuard} from './teams.mjs';

export const maximumQuantity=999999999999999;
export function identifier(value){check(typeof value==='string'&&/^[a-f0-9]{32}$/.test(value),'资料不存在或没有权限。',404);return value;}
export function quantity(value,unit){
  check(typeof value==='string'&&/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(value),'数量须为 0–999999999.999999 的十进制文本，最多 6 位小数，不接受负数或科学计数。');
  const [whole,fraction='']=value.split('.'),result=Number(whole)*1000000+Number(fraction.padEnd(6,'0'));
  check(result<=maximumQuantity&&!(['支','份','瓶','盒','包','个'].includes(unit)&&result%1000000),'计数单位必须为整数，数量不能超出上限。');return result;
}
export function amount(value){const absolute=Math.abs(value),fraction=String(absolute%1000000).padStart(6,'0').replace(/0+$/,'');return (value<0?'-':'')+Math.floor(absolute/1000000)+(fraction?'.'+fraction:'');}
export function code(value){const result=text(value,60,'编号',true).trim().normalize('NFC').toUpperCase();check(result.length<=60&&/^[\p{L}\p{N}_.-]+$/u.test(result),'编号仅支持文字、数字、下划线、点和短横线，规范化后最多 60 字。');return result;}
export async function scope(env,user,teamId,write=false){
  if(teamId===undefined||teamId===null)return {key:'user:'+user.id,role:'owner',team:null};
  const team=await membership(env,user,identifier(teamId),write?['owner','editor']:undefined);return {key:'team:'+team.id,role:team.role,team};
}
export async function storedScope(env,user,key,write=false){if(key==='user:'+user.id)return scope(env,user,null,write);check(/^team:[a-f0-9]{32}$/.test(key),'资料不存在或没有权限。',404);return scope(env,user,key.slice(5),write);}
export function scopeGuard(env,user,access){return access.team?accessGuard(env,user,access.team):[query(env,'INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0) THEN 1 ELSE 0 END',user.id),query(env,'DELETE FROM mutation_guard')];}
export function current(record,revision){check(Number.isSafeInteger(revision)&&record.revision===revision,'台账已被更新，请保留输入后刷新重试。',409);}
export function date(value,label){const result=text(value??'',10,label);check(!result||/^\d{4}-\d{2}-\d{2}$/.test(result)&&!Number.isNaN(Date.parse(result))&&new Date(result).toISOString().slice(0,10)===result,label+'无效。');return result;}
export const businessDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
