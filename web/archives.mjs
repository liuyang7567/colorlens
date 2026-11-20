import {zip,unzipSync,strToU8,strFromU8} from 'fflate';
import {request,getBytes,saveBlob,uploadFile,sha} from './transport.mjs';
import {encodeEln,decodeEln} from '../src/eln.mjs';

async function zipFiles(files,filename) {
  const hashes={};
  let size=0;
  for (const [name,bytes] of Object.entries(files)) {size+=bytes.length;if(size>256*1048576)throw new Error('备份展开超过 256 MB，请按单条实验导出。');hashes[name]=await sha(bytes);}
  files['manifest.json']=strToU8(JSON.stringify({schema:'colorlens-cloud-1',files:hashes}));
  const bytes=await new Promise((resolve,reject)=>zip(files,{level:1},(error,result)=>error?reject(error):resolve(result)));
  if (bytes.length>128*1048576) throw new Error('备份超过 128 MB，请分次导出。');
  saveBlob(new Blob([bytes],{type:'application/zip'}),filename);
}
const csvCell=value=>{const raw=String(value??'');const safe=typeof value==='string'&&/^[\t\r\n ]*[=+@-]/.test(raw)?"'"+raw:raw;return `"${safe.replaceAll('"','""')}"`;};
function tableCsv(rows) {
  if (!rows.length) return '';
  const keys=Object.keys(rows[0]);
  return '\ufeff'+[keys.map(csvCell).join(','),...rows.map(row=>keys.map(key=>csvCell(typeof row[key]==='object'?JSON.stringify(row[key]):row[key])).join(','))].join('\r\n');
}
export async function analysisFiles(record) {
  const files={'analysis.json':strToU8(JSON.stringify(record,null,2))};
  if (record.analysis_type==='instrument') {
    files['input.csv']=strToU8(record.instrument_input.csv);
    files['processed.csv']=strToU8(tableCsv(record.result.rows));
    files['groups.csv']=strToU8(tableCsv(record.result.groups));
    if(record.result.measurement==='qpcr'&&record.instrument_input.standards_csv)files['standards.csv']=strToU8(record.instrument_input.standards_csv);
    if(record.result.input_type==='multi_ct'){files['reference-config.csv']=strToU8(record.instrument_input.reference_genes_csv);files['gene-ct.csv']=strToU8(tableCsv(record.result.gene_rows));files['gene-summary.csv']=strToU8(tableCsv(record.result.gene_summary));files['reference-summary.csv']=strToU8(tableCsv(record.result.reference_summary));}
    if(record.result.measurement==='elisa'){files['standards.csv']=strToU8(tableCsv(record.result.curve.points));files['curve.json']=strToU8(JSON.stringify({algorithm:record.result.algorithm,formula:record.result.formula,unit:record.result.unit,curve:record.result.curve},null,2));}
  } else {
    files['results.csv']=strToU8(tableCsv(record.result.results));
    files['matrix.csv']=strToU8(record.result.matrix.map(row=>row.map(csvCell).join(',')).join('\r\n'));
    const original=await getBytes(record.original_attachment_id);
    if (await sha(original)!==record.result.image.sha256) throw new Error('原图哈希校验失败，导出已停止。');
    files['original.'+record.result.image.filename.split('.').at(-1).toLowerCase()]=original;
    if (record.annotated_attachment_id) files['annotated.png']=await getBytes(record.annotated_attachment_id);
  }
  return files;
}
export async function downloadAnalysis(id,filename='ColorLens-analysis-'+id+'.zip') {
  const record=await request('/api/restore',{id});
  await zipFiles(await analysisFiles(record),filename);
}
export async function downloadNotebook(id,filename,status=()=>{}) {
  const entries=id?[(await request('/api/notebook/entry/'+id))]:(await request('/api/notebook/backup-index')).entries;
  const files={},archives=[];
  for (const [index,entry] of entries.entries()) {
    status(`正在校验并导出 ${index+1}/${entries.length} 条实验…`);
    const archive=await request('/api/notebook/archive/'+entry.id);
    archives.push(archive);
    for (const attachment of entry.attachments) {
      if (files['blobs/'+attachment.sha256]) continue;
      const bytes=await getBytes(attachment.id);
      if (bytes.length!==attachment.size||await sha(bytes)!==attachment.sha256) throw new Error('附件校验失败：'+attachment.filename);
      files['blobs/'+attachment.sha256]=bytes;
    }
  }
  files['archive.json']=strToU8(JSON.stringify({schema:'colorlens-cloud-1',created_at:new Date().toISOString(),archives}));
  files['README.txt']=strToU8('镜析 V0.4 私有实验备份：archive.json 包含笔记、分析、AI 草稿与修改历史；blobs 包含原件。导入时建立新副本，原历史和分析作为来源附件保留，不覆盖现有记录。勿公开此 ZIP。SHA-256 不是电子签名。');
  await zipFiles(files,filename||'ColorLens-cloud-backup.zip');
}
function unpack(bytes) {
  let count=0,total=0;
  const files=unzipSync(bytes,{filter:file=>{
    count++;total+=file.originalSize;
    if (count>5000 || total>256*1048576 || file.originalSize>32*1048576 || !file.name || file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').some(part=>part==='..'||part==='.') || file.name.includes('\0')) throw new Error('备份文件路径、数量或解压大小无效。');
    return true;
  }});
  return files;
}
export async function importBackup(bytes,status=()=>{}) {
  if (bytes.length>128*1048576) throw new Error('请选择 128 MB 以内的备份 ZIP。');
  const files=unpack(bytes);
  const manifest=JSON.parse(strFromU8(files['manifest.json']||new Uint8Array()));
  if (!manifest.files || Object.keys(manifest.files).length>5000) throw new Error('备份校验清单无效。');
  for (const [name,hash] of Object.entries(manifest.files)) if (!files[name] || await sha(files[name])!==hash) throw new Error('备份文件完整性校验失败：'+name);
  let sources;
  if (files['archive.json'] && manifest.files['archive.json']) {
    const archive=JSON.parse(strFromU8(files['archive.json']));
    if (archive.schema!=='colorlens-cloud-1'||!Array.isArray(archive.archives)) throw new Error('不是镜析联网版备份。');
    sources=archive.archives;
  } else if (files['notebook.json'] && manifest.files['notebook.json']) {
    const archive=JSON.parse(strFromU8(files['notebook.json']));
    if (archive.schema!=='colorlens-notebook-1'||!Array.isArray(archive.tables?.entries)) throw new Error('不是镜析 V0.3 备份。');
    const tables=archive.tables;
    sources=tables.entries.map(entry=>({entry:{...entry,data:typeof entry.data==='string'?JSON.parse(entry.data):entry.data,attachments:tables.attachments.filter(item=>item.entry_id===entry.id),events:tables.events.filter(item=>item.entry_id===entry.id),analyses:tables.analyses.filter(item=>item.entry_id===entry.id)},revisions:tables.revisions.filter(item=>item.entry_id===entry.id),source_files:Object.keys(files).filter(name=>name.startsWith('analyses/')&&tables.analyses.some(item=>item.entry_id===entry.id&&name.startsWith('analyses/'+item.record_id+'/'))).map(name=>({name,sha256:manifest.files[name]}))}));
  } else throw new Error('备份缺少受校验的资料索引。');
  return importSources(sources,files,manifest.files,status);
}
async function importSources(sources,files,hashes,status){
  if (sources.length>200) throw new Error('一次最多导入 200 条实验，请分次导出。');
  let imported=0;
  for (const source of sources) {
    const original=source.entry;
    if (!original?.data || !Array.isArray(original.attachments)) throw new Error('备份记录结构无效。');
    const filename='导入来源-'+original.id+'.json';
    const provenance=strToU8(JSON.stringify(source,null,2));
    if (provenance.length>20*1048576) throw new Error('来源历史超过单附件上限，请拆分备份。');
    for (const attachment of original.attachments) if (!files['blobs/'+attachment.sha256] || !hashes['blobs/'+attachment.sha256]) throw new Error('备份缺失受校验附件：'+attachment.filename);
    const sourceFiles=source.source_files||[];
    for(const file of sourceFiles)if(!file.sha256 || !hashes[file.name] || hashes[file.name]!==file.sha256 || !files[file.name])throw new Error('来源分析文件未通过清单校验。');
    if(original.attachments.length+sourceFiles.length+1>100)throw new Error('该条导入资料超过 100 个附件，请拆分资料包。');
    status(`正在导入 ${imported+1}/${sources.length}：${original.data.title}。失败时已导入副本会保留，请勿盲目重复导入。`);
    const data={...original.data,status:'draft',body:'导入进行中；来源记录 '+original.id+'。完整历史将在来源附件保留。',body_format:undefined,event_draft:''};
    let entry=await request('/api/notebook/create',{data});
    const mapping=new Map();
    for (const attachment of original.attachments) {
      const uploaded=await uploadFile(entry,attachment.filename,files['blobs/'+attachment.sha256]);
      entry=uploaded.entry;mapping.set(attachment.id,uploaded.file.id);
    }
    for(const file of sourceFiles){const uploaded=await uploadFile(entry,'来源分析-'+file.name.replaceAll('/','-'),files[file.name]);entry=uploaded.entry;}
    const uploaded=await uploadFile(entry,filename,provenance);
    entry=uploaded.entry;
    const body=original.data.body_format==='inline-images-v1'?original.data.body.replace(/\[\[colorlens-image:([a-f0-9]{32})\]\]/g,(_,id)=>{if(!mapping.has(id))throw new Error('来源正文图片缺失。');return `[[colorlens-image:${mapping.get(id)}]]`;}):original.data.body;
    const timeline=(original.events||[]).map(event=>`${event.created_at} ${event.text}`).join('\n');
    entry=await request('/api/notebook/save',{id:entry.id,revision:entry.revision,data:{...original.data,template_binding:entry.data.template_binding,body,status:'draft',event_draft:'',discussion:(original.data.discussion||'')+(timeline?'\n\n【导入的原始过程时间线】\n'+timeline:'')}});
    imported++;
  }
  return {imported,skipped:0};
}
export async function downloadEln(id,status=()=>{}){
  const entries=id?[await request('/api/notebook/entry/'+id)]:(await request('/api/notebook/backup-index')).entries,archives=[],blobs={};
  for(const [index,entry] of entries.entries()){status(`正在准备 ELN ${index+1}/${entries.length}…`);const archive=await request('/api/notebook/archive/'+entry.id);archives.push(archive);for(const attachment of archive.entry.attachments)if(!blobs[attachment.sha256])blobs[attachment.sha256]=await getBytes(attachment.id);}
  const output=await encodeEln(archives,blobs);saveBlob(new Blob([output.bytes],{type:'application/vnd.eln+zip'}),output.filename);
}
export async function inspectEln(bytes){return decodeEln(bytes);}
export async function importEln(inspected,status=()=>{}){
  const files={},hashes={};for(const [digest,bytes] of Object.entries(inspected.blobs)){files['blobs/'+digest]=bytes;hashes['blobs/'+digest]=digest;}
  return importSources(inspected.sources,files,hashes,status);
}
