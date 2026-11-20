import {check,text,uid,now,first,rows,query,json} from './common.mjs';
import {maximumQuantity as maximum,identifier,quantity,amount,code,scope,storedScope,scopeGuard,current} from './lab.mjs';
import {detail} from './notebook.mjs';

const units=['µL','mL','mg','g','支','份'];
const kinds=['组织','细胞','血清/血浆','核酸','蛋白','菌株','其他'];
const guard=env=>[query(env,'INSERT INTO mutation_guard VALUES(changes())'),query(env,'DELETE FROM mutation_guard')];
function metadata(input){
  check(kinds.includes(input.kind),'样本类别无效。');const collected=text(input.collected_on??'',10,'采集日期');check(!collected||/^\d{4}-\d{2}-\d{2}$/.test(collected)&&!Number.isNaN(Date.parse(collected))&&new Date(collected).toISOString().slice(0,10)===collected,'采集日期无效。');
  return {name:text(input.name,120,'样本名称',true).trim(),kind:input.kind,origin:text(input.origin??'',200,'来源'),batch:text(input.batch??'',100,'批次'),collected_on:collected,notes:text(input.notes??'',4000,'样本备注')};
}
async function sampleRow(env,user,id,write=false){const sample=await first(env,'SELECT * FROM lab_samples WHERE id=?',identifier(id));check(sample,'样本不存在或没有权限。',404);return {sample,access:await storedScope(env,user,sample.scope,write)};}
async function placement(env,access,boxId,slot){
  if(boxId===undefined||boxId===null||boxId===''){check(slot===undefined||slot===null||slot==='','未选冻存盒时不能填写孔位。');return {box_id:null,slot:null};}
  const box=await first(env,'SELECT * FROM sample_boxes WHERE id=? AND scope=?',identifier(boxId),access.key);check(box,'冻存盒不存在或不属于当前空间。',404);
  check(typeof slot==='string'&&/^[A-P](?:[1-9]|1\d|2[0-4])$/.test(slot)&&slot.charCodeAt(0)-65<box.rows&&Number(slot.slice(1))<=box.columns,'孔位超出盒尺寸，使用 A1、B2 等坐标。');return {box_id:box.id,slot};
}
function summary(sample){return {id:sample.id,code:sample.code,name:sample.name??JSON.parse(sample.metadata).name,kind:sample.kind??JSON.parse(sample.metadata).kind,unit:sample.unit,quantity:amount(sample.quantity),parent_id:sample.parent_id,box_id:sample.box_id,slot:sample.slot,revision:sample.revision,status:sample.status};}
function eventStatement(env,user,sample,kind,delta,reason,relatedId=null,previous=null){
  const data={...summary(sample),metadata:JSON.parse(sample.metadata),related_id:relatedId,previous:previous?summary(previous):null};
  return query(env,'INSERT INTO sample_events VALUES(?,?,?,?,?,?,?,?,?,?,?)',uid(),sample.id,user.id,user.display_name||user.username,sample.revision,kind,delta,sample.quantity,JSON.stringify(data),reason,now());
}
function insertStatement(env,sample){return query(env,'INSERT INTO lab_samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',sample.id,sample.scope,sample.creator,sample.code,sample.unit,sample.quantity,sample.metadata,sample.parent_id,sample.box_id,sample.slot,sample.revision,sample.status,sample.created_at,sample.updated_at);}
function updateStatements(env,sample,previous){return [query(env,'UPDATE lab_samples SET quantity=?,metadata=?,box_id=?,slot=?,revision=?,status=?,updated_at=? WHERE id=? AND scope=? AND revision=?',sample.quantity,sample.metadata,sample.box_id,sample.slot,sample.revision,sample.status,sample.updated_at,sample.id,sample.scope,previous.revision),...guard(env)];}
async function view(env,user,id){
  const {sample,access}=await sampleRow(env,user,id),parent=sample.parent_id?await first(env,'SELECT id,code FROM lab_samples WHERE id=? AND scope=?',sample.parent_id,access.key):null;
  const events=await rows(env,'SELECT id,owner,actor_name,revision,kind,delta,balance,data,reason,created_at FROM sample_events WHERE sample_id=? ORDER BY revision',id);
  return {...summary(sample),...JSON.parse(sample.metadata),team_id:access.team?.id??null,workspace:access.team?.name??'我的私有样本',role:access.role,parent,created_at:sample.created_at,updated_at:sample.updated_at,
    box:sample.box_id?await first(env,'SELECT * FROM sample_boxes WHERE id=? AND scope=?',sample.box_id,access.key):null,
    children:(await rows(env,'SELECT * FROM lab_samples WHERE parent_id=? AND scope=? ORDER BY created_at',id,access.key)).map(summary),
    events:events.map(event=>({...event,delta:amount(event.delta),balance:amount(event.balance),data:JSON.parse(event.data)})),
    linked_notes:await rows(env,`SELECT entries.id,json_extract(entries.doc,'$.data.title') AS title,json_extract(entries.doc,'$.deleted') AS deleted
      FROM sample_links JOIN entries ON entries.id=entry_id WHERE sample_id=? AND sample_links.owner=? AND entries.owner=? AND active=1 ORDER BY sample_links.created_at`,id,user.id,user.id)};
}
export async function samplesRoute(env,user,path,payload){
  const input=payload??{};
  if(path==='/api/samples')return json({units,kinds,workspaces:[{team_id:null,name:'我的私有样本',role:'owner'},...(await rows(env,`SELECT teams.id AS team_id,teams.name,team_members.role FROM teams JOIN team_members ON team_id=teams.id
    JOIN users founder ON founder.id=teams.owner WHERE user_id=? AND founder.disabled=0 ORDER BY teams.created_at DESC`,user.id))]});
  if(path==='/api/samples/list'){
    const access=await scope(env,user,input.team_id),search=text(input.q??'',200,'搜索词').trim(),status=input.status??'active';check(['active','archived','all'].includes(status),'筛选状态无效。');
    const samples=await rows(env,`SELECT id,code,unit,quantity,parent_id,box_id,slot,revision,status,json_extract(metadata,'$.name') AS name,json_extract(metadata,'$.kind') AS kind FROM lab_samples
      WHERE scope=? AND (?='all' OR status=?) AND instr(lower(code||metadata),lower(?))>0 ORDER BY updated_at DESC`,access.key,status,status,search);
    return json({role:access.role,workspace:access.team?.name??'我的私有样本',samples:samples.map(summary),boxes:await rows(env,'SELECT * FROM sample_boxes WHERE scope=? ORDER BY created_at DESC',access.key)});
  }
  if(path==='/api/samples/box'){
    const box=await first(env,'SELECT * FROM sample_boxes WHERE id=?',identifier(input.id));check(box,'冻存盒不存在或没有权限。',404);await storedScope(env,user,box.scope);
    return json({box,occupants:(await rows(env,'SELECT * FROM lab_samples WHERE box_id=? ORDER BY slot',box.id)).map(summary)});
  }
  if(path==='/api/samples/box-create'){
    const access=await scope(env,user,input.team_id,true);check(!access.team||input.consent===true,'请确认向整个团队登记冻存位置。');
    check(Number.isSafeInteger(input.rows)&&input.rows>=1&&input.rows<=16&&Number.isSafeInteger(input.columns)&&input.columns>=1&&input.columns<=24,'盒尺寸须为 1–16 行、1–24 列。');
    const freezer=text(input.freezer,100,'冰箱/库位',true).trim().normalize('NFC'),rack=text(input.rack,60,'架/层',true).trim().normalize('NFC'),name=text(input.name,100,'盒名称',true).trim().normalize('NFC'),id=uid();
    await env.DB.batch([...scopeGuard(env,user,access),query(env,'INSERT INTO sample_boxes VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,access.key,user.id,freezer,rack,name,text(input.storage_condition??'',60,'声明保存条件'),input.rows,input.columns,JSON.stringify([freezer,rack,name].map(value=>value.toUpperCase())),now())]);return json({id});
  }
  if(path==='/api/samples/create'){
    const access=await scope(env,user,input.team_id,true);check(!access.team||input.consent===true,'请确认向整个团队登记样本；私人实验不会随之公开。');check(units.includes(input.unit),'样本单位无效。');
    const placed=await placement(env,access,input.box_id,input.slot),created=now(),sample={id:uid(),scope:access.key,creator:user.id,code:code(input.code),unit:input.unit,quantity:quantity(input.quantity,input.unit),metadata:JSON.stringify(metadata(input)),parent_id:null,...placed,revision:1,status:'active',created_at:created,updated_at:created};
    await env.DB.batch([...scopeGuard(env,user,access),insertStatement(env,sample),eventStatement(env,user,sample,'create',sample.quantity,'首次登记；数量为用户申报值。')]);return json(await view(env,user,sample.id));
  }
  if(path==='/api/samples/detail'||path==='/api/samples/archive'){const result=await view(env,user,input.id);return json(path.endsWith('/archive')?{schema:'colorlens-sample-1',exported_at:now(),notice:'单样本现状与流水，包含当前用户自己的实验关联；不是全空间备份，不包含原实验或附件。',sample:result}:result);}
  if(path==='/api/samples/for-note'){
    await detail(env,user,input.entry_id);
    const samples=await rows(env,`SELECT lab_samples.* FROM sample_links JOIN lab_samples ON lab_samples.id=sample_id WHERE sample_links.owner=? AND entry_id=? AND active=1 AND
      (scope=? OR EXISTS(SELECT 1 FROM team_members JOIN teams ON teams.id=team_id JOIN users founder ON founder.id=teams.owner
      WHERE 'team:'||teams.id=lab_samples.scope AND user_id=? AND founder.disabled=0)) ORDER BY lab_samples.updated_at DESC`,user.id,input.entry_id,'user:'+user.id,user.id);
    return json({samples:samples.map(summary)});
  }
  if(path==='/api/samples/link'){
    const {sample,access}=await sampleRow(env,user,input.id),entry=await detail(env,user,input.entry_id);check(typeof input.active==='boolean','请选择建立或解除自己的关联。');check(!input.active||!entry.deleted,'回收站记录不能建立新关联。',409);
    check(input.active||await first(env,'SELECT 1 FROM sample_links WHERE sample_id=? AND owner=? AND entry_id=?',sample.id,user.id,entry.id),'自己的关联不存在。',404);
    await env.DB.batch([...scopeGuard(env,user,access),...input.active?[query(env,'INSERT INTO mutation_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM entries WHERE id=? AND owner=? AND revision=?) THEN 1 ELSE 0 END',entry.id,user.id,entry.revision),query(env,'DELETE FROM mutation_guard')]:[],query(env,'INSERT INTO sample_links VALUES(?,?,?,?,?) ON CONFLICT(sample_id,owner,entry_id) DO UPDATE SET active=excluded.active',sample.id,user.id,entry.id,Number(input.active),now())]);return json(await view(env,user,sample.id));
  }
  if(path==='/api/samples/action'||path==='/api/samples/aliquot'){
    const {sample:previous,access}=await sampleRow(env,user,input.id,true);current(previous,input.revision);const reason=text(input.reason,2000,'操作原因',true).trim(),sample={...previous,revision:previous.revision+1,updated_at:now()};
    if(path==='/api/samples/aliquot'){
      check(previous.status==='active','归档样本不能分装。',409);const transferred=quantity(input.quantity,previous.unit);check(transferred>0&&transferred<=previous.quantity,'分装数量须大于零，且不能超过余量。');
      const placed=await placement(env,access,input.box_id,input.slot),child={...previous,id:uid(),creator:user.id,code:code(input.code),quantity:transferred,metadata:JSON.stringify({...JSON.parse(previous.metadata),name:text(input.name,120,'分装样本名称',true).trim()}),parent_id:previous.id,...placed,revision:1,created_at:now(),updated_at:now()};sample.quantity-=transferred;
      await env.DB.batch([...scopeGuard(env,user,access),...updateStatements(env,sample,previous),eventStatement(env,user,sample,'aliquot',-transferred,reason,child.id,previous),insertStatement(env,child),eventStatement(env,user,child,'create',transferred,reason,previous.id)]);return json(await view(env,user,child.id));
    }
    const action=input.action;check(['edit','consume','add','correct','move','retire','restore'].includes(action),'样本操作无效。');check(previous.status==='active'||action==='restore','样本已归档，请先恢复。',409);
    if(action==='restore'){check(previous.status==='archived','只有归档样本可以恢复。',409);sample.status='active';}
    else if(action==='edit')sample.metadata=JSON.stringify(metadata(input));
    else if(action==='move'){Object.assign(sample,await placement(env,access,input.box_id,input.slot));check(sample.box_id!==previous.box_id||sample.slot!==previous.slot,'位置没有改变。');}
    else if(action==='retire'){check(previous.quantity===0,'请先按真实情况记录领用或盘点，将余量归零后再归档。');sample.status='archived';sample.box_id=null;sample.slot=null;}
    else{const value=quantity(input.quantity,previous.unit);check(action==='correct'||value>0,'入/出库数量须大于零。');sample.quantity=action==='correct'?value:previous.quantity+(action==='consume'?-value:value);check(sample.quantity>=0&&sample.quantity<=maximum,'领用超出余量，或入库后超过数量上限。');check(sample.quantity!==previous.quantity,'数量没有改变。');}
    await env.DB.batch([...scopeGuard(env,user,access),...updateStatements(env,sample,previous),eventStatement(env,user,sample,action,sample.quantity-previous.quantity,reason,null,previous)]);return json(await view(env,user,sample.id));
  }
  check(false,'接口不存在。',404);
}
