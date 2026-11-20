import {DatabaseSync,constants} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {sealBytes,decryptBytes} from './sealed.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ensure=(value,message)=>{if(!value)throw new Error(message);};
const quote=value=>'"'+value.replaceAll('"','""')+'"';
export function importDatabase(sql,filename=':memory:'){
  ensure(typeof sql==='string'&&Buffer.byteLength(sql)<=256*1048576,'SQL 资料过大或无效。');const database=new DatabaseSync(filename,{allowExtension:false});
  ensure(typeof database.setAuthorizer==='function','恢复工具需要 Node.js 24.10 或更新版本。');database.enableDefensive(true);
  database.setAuthorizer((action,first,second,dbname)=>{
    if([constants.SQLITE_ATTACH,constants.SQLITE_DETACH,constants.SQLITE_CREATE_VTABLE].includes(action)||dbname&&!['main','temp'].includes(dbname))return constants.SQLITE_DENY;
    if(action===constants.SQLITE_PRAGMA&&!['foreign_keys','defer_foreign_keys'].includes(String(first).toLowerCase()))return constants.SQLITE_DENY;
    if(action===constants.SQLITE_FUNCTION&&['load_extension','readfile','writefile'].includes(String(second).toLowerCase()))return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });
  try{database.exec(sql);database.setAuthorizer(null);ensure(database.prepare('PRAGMA integrity_check').get().integrity_check==='ok','恢复数据库完整性检查失败。');ensure(database.prepare('PRAGMA foreign_key_check').all().length===0,'恢复数据库存在外键断裂。');return database;}catch{database.close();throw new Error('SQL 恢复被拒绝或完整性检查失败，未访问外部数据库。');}
}
export function databaseFingerprint(database){
  const tables=database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name).filter(name=>!name.startsWith('sqlite_')&&!name.startsWith('_cf_')&&name!=='local_migrations'),result={};
  for(const table of tables){const columns=database.prepare('PRAGMA table_info('+quote(table)+')').all(),primary=columns.filter(column=>column.pk).sort((left,right)=>left.pk-right.pk).map(column=>quote(column.name)),rows=database.prepare('SELECT * FROM '+quote(table)+' ORDER BY '+(primary.length?primary.join(','):'rowid')).all();result[table]={rows:rows.length,sha256:digest(JSON.stringify(rows))};}
  return result;
}
export function prepareRemoteImport(sql){
  const original=importDatabase(sql),helper='colorlens_recovery_fragments';let expected;
  try{ensure(!original.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(helper),'恢复暂存表名称冲突。');expected=databaseFingerprint(original);}finally{original.close();}
  let token=0,fragments=0;
  const lines=sql.split('\n').flatMap(line=>{
    if(Buffer.byteLength(line)<90000)return [line];
    ensure(/^INSERT INTO /i.test(line),'超长 SQL 不是受支持的 D1 导出 INSERT，未导入远端。');
    const prefix=[],parts=[];let cursor=0;
    while(cursor<line.length){
      if(line[cursor]!=="'"){parts.push(line[cursor++]);continue;}
      const start=cursor++;let closed=false;
      while(cursor<line.length){if(line[cursor++]!=="'")continue;if(line[cursor]==="'"){cursor++;continue;}closed=true;break;}
      ensure(closed,'超长 INSERT 包含跨行或未闭合字符串，未导入远端。');
      const literal=line.slice(start,cursor);
      if(Buffer.byteLength(literal)<30000){parts.push(literal);continue;}
      token++;const characters=Array.from(literal.slice(1,-1).replaceAll("''","'"));
      for(let position=0;position<characters.length;position+=8000){const value=characters.slice(position,position+8000).join('').replaceAll("'","''");prefix.push('INSERT INTO "'+helper+'" VALUES('+token+','+(position/8000)+",'"+value+"');");fragments++;}
      parts.push('(SELECT group_concat(value,\'\') FROM (SELECT value FROM "'+helper+'" WHERE token='+token+' ORDER BY position))');
    }
    const statement=parts.join('');ensure(Buffer.byteLength(statement)<90000,'重组后 SQL 仍过长，未导入远端。');
    return [...prefix,statement,'DELETE FROM "'+helper+'";'];
  });
  if(!fragments)return {sql,fragment_count:0};
  const prepared='CREATE TABLE "'+helper+'"(token INTEGER,position INTEGER,value TEXT,PRIMARY KEY(token,position));\n'+lines.join('\n')+'\nDROP TABLE "'+helper+'";';
  const restored=importDatabase(prepared);try{ensure(JSON.stringify(databaseFingerprint(restored))===JSON.stringify(expected),'分块重组改变了恢复资料，未导入远端。');}finally{restored.close();}
  return {sql:prepared,fragment_count:fragments};
}
export function validateDatabase(database){
  const fingerprint=databaseFingerprint(database);for(const table of ['users','entries','revisions','files','file_chunks','analyses','teams','lab_samples','inventory_lots','equipment_devices','collaboration_documents','sync_operations'])ensure(fingerprint[table],'恢复包缺少必要业务表。');
  for(const entry of database.prepare('SELECT id,revision,doc FROM entries').all()){let parsed;try{parsed=JSON.parse(entry.doc);}catch{throw new Error('实验 JSON 损坏。');}ensure(parsed.id===entry.id&&parsed.revision===entry.revision,'实验版本与索引不一致。');}
  for(const [table,dataColumn] of [['analyses','data'],['team_versions','snapshot'],['collaboration_versions','data'],['collaboration_documents','data']])for(const row of database.prepare('SELECT '+quote(dataColumn)+' AS data,sha256 FROM '+quote(table)).all())ensure(digest(row.data)===row.sha256,'分析或团队版本哈希不一致。');
  let verifiedFiles=0;for(const file of database.prepare('SELECT id,size,sha256 FROM files WHERE ready=1').all()){const chunks=database.prepare('SELECT position,data FROM file_chunks WHERE file_id=? ORDER BY position').all(file.id),hash=createHash('sha256');let size=0;for(const [index,chunk] of chunks.entries()){ensure(chunk.position===index,'附件分块顺序缺失。');const bytes=Buffer.from(chunk.data,'base64');size+=bytes.length;hash.update(bytes);}ensure(size===file.size&&hash.digest('hex')===file.sha256,'原始附件哈希或长度不一致。');verifiedFiles++;}
  return {tables:fingerprint,verified_files:verifiedFiles};
}
export async function createRecovery(sql,files,password,metadata){
  const database=importDatabase(sql);let validation;try{validation=validateDatabase(database);if(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").get())metadata={...metadata,migrations:database.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map(row=>row.name)};}finally{database.close();}
  const packed={'database.sql':strToU8(sql),...files},hashes={};let size=0;
  for(const [name,bytes] of Object.entries(packed)){ensure(bytes instanceof Uint8Array&&!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').some(part=>part==='..'||part==='.')&&!name.includes('\0'),'恢复文件路径无效。');size+=bytes.length;ensure(size<=320*1048576,'全平台备份超过 320 MB，请规划专用存储。');hashes[name]=digest(bytes);}
  packed['manifest.json']=strToU8(JSON.stringify({schema:'colorlens-server-recovery-1',created_at:new Date().toISOString(),metadata,validation,files:hashes}));const zip=zipSync(packed,{level:1});return sealBytes(zip,password,'colorlens-server-recovery-v1');
}
export async function inspectRecovery(envelope,password){
  const {bytes}=await decryptBytes(envelope,password,'colorlens-server-recovery-v1',320*1048576);let count=0,total=0;const seen=new Set(),files=unzipSync(bytes,{filter:file=>{ensure(!file.name.startsWith('/')&&!file.name.includes('\\')&&!file.name.split('/').some(part=>part==='..'||part==='.')&&!file.name.includes('\0')&&!seen.has(file.name),'恢复包路径无效或重复。');seen.add(file.name);count++;total+=file.originalSize;ensure(count<=10000&&total<=320*1048576&&file.originalSize<=256*1048576,'恢复包大小超限。');return true;}});
  const manifest=JSON.parse(strFromU8(files['manifest.json']||new Uint8Array()));ensure(manifest.schema==='colorlens-server-recovery-1'&&manifest.files&&manifest.validation?.tables,'不是完整镜析恢复包。');ensure(Object.keys(files).length===Object.keys(manifest.files).length+1,'恢复包包含未列入清单的文件。');
  for(const [name,hash] of Object.entries(manifest.files))ensure(files[name]&&digest(files[name])===hash,'恢复文件哈希不符。');
  for(const name of ['database.sql','server-secrets.json','provider-secrets.json','runtime/pages/_worker.js','runtime/pages/index.html','runtime/pages/cloud.js'])ensure(files[name],'恢复包缺少运行程序或认证配置。');
  const database=importDatabase(strFromU8(files['database.sql']));try{const validation=validateDatabase(database);ensure(JSON.stringify(validation)===JSON.stringify(manifest.validation),'恢复后业务表与备份指纹不一致。');return {manifest,files,validation};}finally{database.close();}
}
export function invalidateRecoveredSessions(database){database.exec('DELETE FROM sessions; DELETE FROM rate_limits; UPDATE email_codes SET used=1;');if(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='guidance_runs'").get())database.exec("UPDATE guidance_runs SET consent_until=0,busy_id=NULL; UPDATE guidance_events SET status='stale' WHERE kind='vision' AND status='pending';");}
