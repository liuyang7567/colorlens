import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {localDatabase} from '../scripts/local-db.mjs';
import {uid,sha,now} from '../src/common.mjs';
import {businessDay} from '../src/lab.mjs';

async function fixture(){
  const DB=localDatabase(),env={DB},users={};
  for(const [name,role] of [['owner','member'],['editor','member'],['reviewer','member'],['viewer','member'],['outsider','admin']]){
    const id=uid(),token=uid()+uid(),csrf=uid();DB.raw.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').run(id,uid(),'unused',role,now(),'同名实验同学',name+'@example.test',now());DB.raw.prepare('INSERT INTO sessions(hash,user_id,csrf,expires,auth_version) VALUES(?,?,?,?,0)').run(await sha(token),id,csrf,Math.floor(Date.now()/1000)+3600);users[name]={id,cookie:'__Host-ColorLens='+token,csrf};
  }
  async function call(name,route,payload){const user=users[name],response=await worker.fetch(new Request('https://colorlens.test/api/'+route,{method:payload===undefined?'GET':'POST',headers:{Cookie:user.cookie,...payload===undefined?{}:{Origin:'https://colorlens.test','Content-Type':'application/json','X-ColorLens-Token':user.csrf}},...payload===undefined?{}:{body:JSON.stringify(payload)}}),env);return {status:response.status,data:await response.json()};}
  async function ok(name,route,payload){const result=await call(name,route,payload);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
  async function team(){const result=await ok('owner','teams/create',{name:'模拟采购团队'});for(const role of ['editor','reviewer','viewer']){await ok('owner','teams/invite',{team_id:result.id,email:role+'@example.test',role});const invite=(await ok(role,'teams')).invites[0];await ok(role,'teams/accept',{invite_id:invite.id});}return result.id;}
  const create=(name,data={})=>ok(name,'inventory/create',{code:'R-001',name:'模拟试剂',manufacturer:'模拟厂商',catalogue:'CAT-1',lot:'LOT-1',unit:'mL',quantity:'1',minimum:'0.2',...data});
  const purchase=(teamId,data={})=>ok('editor','inventory/purchase-create',{team_id:teamId,name:'模拟试剂',manufacturer:'模拟厂商',catalogue:'CAT-1',supplier:'模拟供应商',unit:'mL',quantity:'2',estimated_total:'12.34',reason:'模拟补充库存',consent:true,...data});
  return {DB,env,users,call,ok,team,create,purchase};
}

test('inventory preserves private/team isolation, current roles and immutable lot identity',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),personal=await app.create('editor');assert.equal((await app.call('owner','inventory/detail',{id:personal.id})).status,404);assert.equal((await app.call('outsider','inventory/detail',{id:personal.id})).status,404);
    const lot=await app.create('editor',{team_id:teamId,consent:true});assert.equal((await app.ok('viewer','inventory/detail',{id:lot.id})).lot,'LOT-1');
    for(const role of ['viewer','reviewer'])assert.equal((await app.call(role,'inventory/action',{id:lot.id,revision:1,action:'consume',quantity:'0.1',reason:'不允许'})).status,403);
    const updated=await app.ok('editor','inventory/action',{id:lot.id,revision:1,action:'edit',name:'修订名称',minimum:'0.3',manufacturer:'FORGED',catalogue:'FORGED',lot:'FORGED',reason:'修订资料'});assert.equal(updated.lot,'LOT-1');assert.equal(updated.manufacturer,'模拟厂商');assert.equal(updated.unit,'mL');
    await app.ok('owner','teams/member',{team_id:teamId,user_id:app.users.viewer.id,role:'remove'});assert.equal((await app.call('viewer','inventory/archive',{id:lot.id})).status,404);
  }finally{app.DB.close();}
});

test('inventory decimal balances, expiry and low-stock indicators use explicit dates and exact integers',async()=>{
  const app=await fixture();try{
    let lot=await app.create('owner',{quantity:'0.3',expires_on:'2000-01-01'});assert.equal(lot.alerts.expiry,'expired');assert.equal((await app.call('owner','inventory/action',{id:lot.id,revision:1,action:'consume',quantity:'0.1',reason:'过期不领用'})).status,400);
    lot=await app.ok('owner','inventory/action',{id:lot.id,revision:1,action:'edit',name:'模拟试剂',minimum:'0.2',expires_on:'2099-01-01',reason:'核对标签'});lot=await app.ok('owner','inventory/action',{id:lot.id,revision:lot.revision,action:'consume',quantity:'0.1',reason:'模拟领用'});assert.equal(lot.quantity,'0.2');assert.equal(lot.alerts.low_stock,true);assert.equal(lot.events.at(-1).delta,'-0.1');
    assert.equal((await app.call('owner','inventory/action',{id:lot.id,revision:1,action:'add',quantity:'1',reason:'旧版本'})).status,409);assert.equal((await app.call('owner','inventory/action',{id:lot.id,revision:lot.revision,action:'consume',quantity:'99',reason:'超领'})).status,400);
    for(const quantity of ['-1','1e3','NaN','0.0000001',1])assert.equal((await app.call('owner','inventory/create',{code:uid(),name:'非法数量',lot:'X',unit:'mL',quantity,minimum:'0'})).status,400);
  }finally{app.DB.close();}
});

test('team purchasing is independently approved, partially received, idempotent and cannot exceed the approved amount',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let purchase=await app.purchase(teamId);assert.equal(purchase.estimated_total,'12.34');assert.equal(purchase.status,'pending');
    assert.equal((await app.call('editor','inventory/purchase-action',{id:purchase.id,revision:1,action:'approve',reason:'不能自批'})).status,403);
    const input={id:purchase.id,revision:1,reference:'DELIVERY-1',quantity:'0.5',code:'ARRIVAL-1',lot:'LOT-A',minimum:'0',reason:'模拟到货'};
    assert.equal((await app.call('editor','inventory/receive',input)).status,409);
    purchase=await app.ok('owner','inventory/purchase-action',{id:purchase.id,revision:1,action:'approve',reason:'核对后批准'});const receiptInput={...input,revision:purchase.revision};
    const first=await app.ok('editor','inventory/receive',receiptInput);assert.equal(first.purchase.status,'partial');assert.equal(first.purchase.received,'0.5');assert.equal(first.lot.quantity,'0.5');
    const replay=await app.ok('editor','inventory/receive',receiptInput);assert.equal(replay.replayed,true);assert.equal(replay.lot.quantity,'0.5');assert.equal(replay.purchase.revision,first.purchase.revision);
    assert.equal((await app.call('editor','inventory/receive',{...receiptInput,quantity:'0.6'})).status,409);
    const second=await app.ok('owner','inventory/receive',{id:purchase.id,revision:first.purchase.revision,reference:'DELIVERY-2',quantity:'1.5',lot_id:first.lot.id,lot_revision:first.lot.revision,reason:'模拟余量到货'});assert.equal(second.purchase.status,'received');assert.equal(second.purchase.received,'2');assert.equal(second.lot.quantity,'2');
    assert.equal((await app.call('editor','inventory/receive',{id:purchase.id,revision:second.purchase.revision,reference:'DELIVERY-3',quantity:'0.1',lot_id:second.lot.id,lot_revision:second.lot.revision,reason:'超额到货'})).status,409);
    assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_receipts').get().count,2);
  }finally{app.DB.close();}
});

test('expiry indicators cover today, thirty-day boundary, unknown dates and precise low-stock filters',async()=>{
  const app=await fixture();try{
    const today=businessDay(),afterDays=days=>new Date(Date.parse(today+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
    for(const [index,expiry,expected] of [[1,today,'today'],[2,afterDays(30),'soon'],[3,afterDays(31),'valid'],[4,'','unknown']]){const lot=await app.create('owner',{code:'DATE-'+index,expires_on:expiry,quantity:'0.2'});assert.equal(lot.alerts.expiry,expected);assert.equal(lot.alerts.business_date,today);}
    assert.equal((await app.ok('owner','inventory/list',{alert:'soon'})).lots.length,2);assert.equal((await app.ok('owner','inventory/list',{alert:'unknown'})).lots.length,1);assert.equal((await app.ok('owner','inventory/list',{alert:'low'})).lots.length,4);
    assert.equal((await app.call('owner','inventory/create',{code:'BAD-DATE',name:'日期错误',lot:'X',unit:'mL',quantity:'1',expires_on:'2026-02-30'})).status,400);
    assert.equal((await app.call('owner','inventory/create',{code:'BAD-COUNT',name:'数量错误',lot:'X',unit:'瓶',quantity:'0.1'})).status,400);
  }finally{app.DB.close();}
});

test('purchase permissions and monetary inputs are validated independently of platform administrator status',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),input={team_id:teamId,name:'模拟报价',unit:'瓶',quantity:'1',estimated_total:'0.10',reason:'模拟申请',consent:true};
    for(const name of ['owner','viewer','reviewer'])assert.equal((await app.call(name,'inventory/purchase-create',input)).status,403);assert.equal((await app.call('outsider','inventory/purchase-create',input)).status,404);
    for(const value of ['-1','1e2','0.001','1000000000',12.34])assert.equal((await app.call('editor','inventory/purchase-create',{...input,estimated_total:value})).status,400);
    const valid=await app.ok('editor','inventory/purchase-create',input);assert.equal(valid.estimated_total,'0.10');assert.equal(valid.currency,'CNY');
    assert.equal((await app.call('viewer','inventory/purchase-action',{id:valid.id,revision:1,action:'approve',reason:'拒绝越权'})).status,403);
    assert.equal((await app.call('outsider','inventory/purchase',{id:valid.id})).status,404);
    await app.ok('owner','teams/member',{team_id:teamId,user_id:app.users.viewer.id,role:'remove'});assert.equal((await app.call('viewer','inventory/purchase-archive',{id:valid.id})).status,404);
  }finally{app.DB.close();}
});

test('rejection, cancellation and partial closure keep approval history and never erase received stock',async()=>{
  const app=await fixture();try{
    const teamId=await app.team(),rejected=await app.purchase(teamId);const decision=await app.ok('owner','inventory/purchase-action',{id:rejected.id,revision:1,action:'reject',reason:'模拟驳回'});assert.equal(decision.status,'rejected');
    assert.equal((await app.call('owner','inventory/purchase-action',{id:rejected.id,revision:2,action:'approve',reason:'不能改写原决定'})).status,409);
    const cancelled=await app.purchase(teamId),cancel=await app.ok('editor','inventory/purchase-action',{id:cancelled.id,revision:1,action:'cancel',reason:'模拟撤回'});assert.equal(cancel.status,'cancelled');
    let request=await app.purchase(teamId);request=await app.ok('owner','inventory/purchase-action',{id:request.id,revision:1,action:'approve',reason:'独立批准'});
    const received=await app.ok('editor','inventory/receive',{id:request.id,revision:request.revision,reference:'PART-1',quantity:'0.5',code:'CLOSE-LOT',lot:'CLOSE-A',reason:'部分到货'});
    assert.equal((await app.call('editor','inventory/purchase-action',{id:request.id,revision:received.purchase.revision,action:'cancel',reason:'不能取消已到货'})).status,409);
    const closed=await app.ok('owner','inventory/purchase-action',{id:request.id,revision:received.purchase.revision,action:'close',reason:'剩余不再到货'});assert.equal(closed.status,'closed');assert.equal(closed.received,'0.5');assert.equal(closed.remaining,'1.5');assert.equal((await app.ok('owner','inventory/detail',{id:received.lot.id})).quantity,'0.5');
    const archive=await app.ok('viewer','inventory/purchase-archive',{id:request.id});assert.equal(archive.purchase.receipts.length,1);assert.equal(archive.purchase.events.length,4);
  }finally{app.DB.close();}
});

test('receipt scope, unit and catalogue conflicts cannot redirect stock to another workspace or product',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let request=await app.purchase(teamId);request=await app.ok('owner','inventory/purchase-action',{id:request.id,revision:1,action:'approve',reason:'模拟批准'});
    const personal=await app.create('editor'),wrong=await app.create('editor',{team_id:teamId,consent:true,code:'WRONG',catalogue:'OTHER'}),differentUnit=await app.create('editor',{team_id:teamId,consent:true,code:'UNIT',unit:'mg'});
    for(const [lot,status] of [[personal,403],[wrong,400],[differentUnit,400]])assert.equal((await app.call('editor','inventory/receive',{id:request.id,revision:request.revision,reference:'SCOPE-'+lot.code,quantity:'0.5',lot_id:lot.id,lot_revision:lot.revision,reason:'不能错入库'})).status,status);
    let unnamed=await app.purchase(teamId,{catalogue:''});unnamed=await app.ok('owner','inventory/purchase-action',{id:unnamed.id,revision:1,action:'approve',reason:'无货号核对'});const wrongName=await app.create('editor',{team_id:teamId,consent:true,code:'OTHER-NAME',catalogue:'',name:'同厂家的另一种试剂'});assert.equal((await app.call('editor','inventory/receive',{id:unnamed.id,revision:unnamed.revision,reference:'WRONG-NAME',quantity:'0.5',lot_id:wrongName.id,lot_revision:1,reason:'无货号也不能错品名'})).status,400);
    assert.equal((await app.ok('owner','inventory/purchase',{id:request.id})).received,'0');assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_receipts').get().count,0);
  }finally{app.DB.close();}
});

test('receipt quota and concurrent role changes roll back purchase state, stock, events and receipt identities',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let request=await app.purchase(teamId);request=await app.ok('owner','inventory/purchase-action',{id:request.id,revision:1,action:'approve',reason:'模拟批准'});const input={id:request.id,revision:request.revision,reference:'ATOMIC-1',quantity:'1',code:'ATOMIC-LOT',lot:'LOT-A',notes:'仅本批次备注',reason:'模拟原子到货'};
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=41943040 WHERE id=1').run();assert.equal((await app.call('editor','inventory/receive',input)).status,413);assert.equal((await app.ok('owner','inventory/purchase',{id:request.id})).received,'0');assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_lots').get().count,0);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_receipts').get().count,0);
    app.DB.raw.prepare('UPDATE usage_totals SET doc_bytes=0 WHERE id=1').run();const batch=app.DB.batch;let raced=false;app.DB.batch=async statements=>{if(!raced){raced=true;app.DB.raw.prepare("UPDATE team_members SET role='viewer' WHERE team_id=? AND user_id=?").run(teamId,app.users.editor.id);}return batch(statements);};assert.equal((await app.call('editor','inventory/receive',input)).status,409);app.DB.batch=batch;
    assert.equal((await app.ok('owner','inventory/purchase',{id:request.id})).received,'0');assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_lots').get().count,0);
    const success=await app.ok('owner','inventory/receive',input);assert.equal(success.lot.notes,'仅本批次备注');assert.equal(success.purchase.received,'1');
  }finally{app.DB.close();}
});

test('racing distinct receipt references with the same revision cannot overbook approved quantities',async()=>{
  const app=await fixture();try{
    const teamId=await app.team();let request=await app.purchase(teamId);request=await app.ok('owner','inventory/purchase-action',{id:request.id,revision:1,action:'approve',reason:'模拟批准'});
    const responses=await Promise.all(['ONE','TWO'].map(reference=>app.call('editor','inventory/receive',{id:request.id,revision:request.revision,reference,quantity:'1.5',code:'LOT-'+reference,lot:reference,reason:'模拟竞争到货'})));assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    assert.equal((await app.ok('viewer','inventory/purchase',{id:request.id})).received,'1.5');assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_lots').get().count,1);assert.equal(app.DB.raw.prepare('SELECT COUNT(*) AS count FROM inventory_receipts').get().count,1);
  }finally{app.DB.close();}
});

test('inventory APIs require login, POST and CSRF for details, actions and exports',async()=>{
  const app=await fixture();try{
    assert.equal((await worker.fetch(new Request('https://colorlens.test/api/inventory'),app.env)).status,401);
    for(const route of ['list','detail','create','action','archive','purchase','purchase-create','purchase-action','purchase-archive','receive'])assert.equal((await app.call('owner','inventory/'+route)).status,405);
    const response=await worker.fetch(new Request('https://colorlens.test/api/inventory/create',{method:'POST',headers:{Cookie:app.users.owner.cookie,Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'}),app.env);assert.equal(response.status,403);
  }finally{app.DB.close();}
});

test('expired disposal, zero-balance retirement and event limits preserve the existing ledger',async()=>{
  const app=await fixture();try{
    let lot=await app.create('owner',{expires_on:'2000-01-01'});lot=await app.ok('owner','inventory/action',{id:lot.id,revision:1,action:'dispose',quantity:'1',reason:'模拟报废'});lot=await app.ok('owner','inventory/action',{id:lot.id,revision:lot.revision,action:'retire',reason:'空瓶归档'});assert.equal(lot.status,'archived');assert.equal(lot.events.length,3);
    assert.equal((await app.call('owner','inventory/action',{id:lot.id,revision:lot.revision,action:'add',quantity:'1',reason:'归档后不入库'})).status,409);lot=await app.ok('owner','inventory/action',{id:lot.id,revision:lot.revision,action:'restore',reason:'恢复台账'});assert.equal(lot.quantity,'0');
    app.DB.raw.prepare('UPDATE inventory_lots SET revision=160 WHERE id=?').run(lot.id);assert.equal((await app.call('owner','inventory/action',{id:lot.id,revision:160,action:'add',quantity:'1',reason:'满额'})).status,409);assert.equal((await app.ok('owner','inventory/detail',{id:lot.id})).quantity,'0');
  }finally{app.DB.close();}
});
