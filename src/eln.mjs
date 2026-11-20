import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {check,sha,escapeHtml} from './common.mjs';

const jsonBytes=value=>strToU8(JSON.stringify(value,null,2));
const hasType=(node,type)=>[node?.['@type']].flat().includes(type);
const safeName=value=>String(value||'attachment.bin').replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,180);
const fileId=value=>'./'+value.split('/').map(encodeURIComponent).join('/');
const supported=/\.(jpe?g|png|webp|csv|pdf|txt|md|xlsx|docx|pptx|json|zip)$/i;
function validPath(value){check(typeof value==='string'&&value.length<=1000&&!value.startsWith('/')&&!value.includes('\\')&&!/[\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..')&&!/^[a-z]:/i.test(value),'ELN 路径无效。');return value;}
export function unpackEln(bytes){
  check(bytes instanceof Uint8Array&&bytes.length<=128*1048576,'ELN 压缩包最大 128 MB。');let count=0,total=0;const seen=new Set();
  const files=unzipSync(bytes,{filter:file=>{validPath(file.name);check(!seen.has(file.name),'ELN 包含重复路径。');seen.add(file.name);count++;total+=file.originalSize;check(count<=5000&&total<=256*1048576&&file.originalSize<=32*1048576,'ELN 文件数量或展开大小超限。');return !file.name.endsWith('/');}});
  const names=Object.keys(files),folders=new Set(names.map(name=>name.split('/')[0]));check(folders.size===1&&names.every(name=>name.includes('/')),'ELN 必须只有一个顶层目录。');const folder=[...folders][0];check(files[folder+'/ro-crate-metadata.json'],'ELN 缺少 ro-crate-metadata.json。');
  return {folder,files};
}
export async function encodeEln(archives,blobs,createdAt=new Date().toISOString()){
  check(Array.isArray(archives)&&archives.length>0&&archives.length<=200,'一次导出 1–200 条实验。');
  const folder='ColorLens-'+createdAt.replace(/[^0-9]/g,'').slice(0,14),files={},graph=[{'@id':'ro-crate-metadata.json','@type':'CreativeWork',about:{'@id':'./'},conformsTo:{'@id':'https://w3id.org/ro/crate/1.1'},sdPublisher:{'@id':'#colorlens'}},{'@id':'./','@type':'Dataset',name:'镜析实验记录',description:'用户主动导出的私人实验资料；不含账号凭据，不改变原始资料使用权限。',datePublished:createdAt,license:{'@id':'#rights'},hasPart:[]},{'@id':'#colorlens','@type':'Organization',name:'镜析 ColorLens',url:'https://ly070326.cn/'},{'@id':'#rights','@type':'CreativeWork',name:'原有资料权限保持不变',description:'导出不授予额外使用许可；请向资料权利人确认。'}];
  let total=0;const ids=new Set();
  async function addFile(relative,bytes,mime){check(bytes instanceof Uint8Array,'ELN 文件内容无效。');total+=bytes.length;check(total<=256*1048576,'ELN 展开超过 256 MB。');const id=fileId(relative);files[folder+'/'+relative]=bytes;graph.push({'@id':id,'@type':'File',name:relative.split('/').at(-1),encodingFormat:mime,contentSize:String(bytes.length),sha256:await sha(bytes)});return {'@id':id};}
  for(const archive of archives){
    const entry=archive?.entry;check(entry&&/^[a-f0-9]{32}$/.test(entry.id)&&!ids.has(entry.id)&&Array.isArray(entry.attachments),'ELN 实验编号或附件结构无效。');ids.add(entry.id);
    const relative='experiments/'+entry.id,dataset={'@id':fileId(relative)+'/','@type':'Dataset',name:entry.data.title,identifier:entry.id,dateCreated:entry.created_at,dateModified:entry.updated_at,keywords:(entry.data.tags||[]).join(','),text:'',hasPart:[]},mapping=[];
    graph[1].hasPart.push({'@id':dataset['@id']});graph.push(dataset);
    if(entry.data.operator){const person='#operator-'+entry.id;graph.push({'@id':person,'@type':'Person',name:entry.data.operator});dataset.author={'@id':person};}
    for(const attachment of entry.attachments){const bytes=blobs[attachment.sha256];check(bytes&&bytes.length===attachment.size&&await sha(bytes)===attachment.sha256,'ELN 导出附件校验失败。');const attachmentPath=relative+'/attachments/'+attachment.id+'-'+safeName(attachment.filename);dataset.hasPart.push(await addFile(attachmentPath,bytes,'application/octet-stream'));mapping.push({id:attachment.id,path:attachmentPath,sha256:attachment.sha256,size:attachment.size});}
    dataset.text=['title','purpose','materials','procedure','results','discussion','body'].map(key=>'<section><h2>'+escapeHtml({title:'标题',purpose:'目的',materials:'材料',procedure:'步骤',results:'结果',discussion:'讨论',body:'正文'}[key])+'</h2><pre>'+escapeHtml(entry.data[key]||'')+'</pre></section>').join('\n');
    dataset.hasPart.push(await addFile(relative+'/record.json',jsonBytes({schema:'colorlens-eln-record-1',archive,attachments:mapping}),'application/json'));
    dataset.hasPart.push(await addFile(relative+'/index.html',strToU8('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;"><title>'+escapeHtml(entry.data.title)+'</title><body>'+dataset.text+'</body></html>'),'text/html'));
  }
  files[folder+'/ro-crate-metadata.json']=jsonBytes({'@context':'https://w3id.org/ro/crate/1.1/context','@graph':graph});
  const bytes=zipSync(files,{level:1});check(bytes.length<=128*1048576,'ELN 压缩后超过 128 MB。');return {bytes,filename:folder+'.eln'};
}
export async function decodeEln(bytes){
  const {folder,files}=unpackEln(bytes),metadata=JSON.parse(strFromU8(files[folder+'/ro-crate-metadata.json']));
  check(typeof metadata['@context']==='string'&&/^https:\/\/w3id.org\/ro\/crate\/1\.[123]\/context$/.test(metadata['@context']),'目前仅导入 RO-Crate 1.1–1.3 基础上下文，不联网展开自定义 JSON-LD。');
  const graph=metadata['@graph'];check(Array.isArray(graph)&&graph.length<=5000,'ELN 图结构无效。');const nodes=new Map();
  for(const node of graph){check(node&&typeof node['@id']==='string'&&!nodes.has(node['@id']),'ELN 节点编号缺失或重复。');nodes.set(node['@id'],node);}
  const root=nodes.get('./'),descriptor=nodes.get('ro-crate-metadata.json');check(hasType(root,'Dataset')&&hasType(descriptor,'CreativeWork')&&descriptor.about?.['@id']==='./','ELN 根目录或元数据描述无效。');check(/^https:\/\/w3id.org\/ro\/crate\/1\.[123]$/.test(descriptor.conformsTo?.['@id']||''),'ELN 缺少 RO-Crate 版本声明。');
  const warnings=[],verified=new Map();
  function relative(id){check(typeof id==='string'&&!/^[a-z][a-z0-9+.-]*:|^\//i.test(id),'不自动下载 ELN 外部资源。');const stripped=id.startsWith('./')?id.slice(2):id;let decoded;try{decoded=stripped.split('/').map(part=>{const value=decodeURIComponent(part);check(!value.includes('/')&&!value.includes('\\'),'ELN 编码路径无效。');return value;}).join('/');}catch{check(false,'ELN 编码路径无效。');}return validPath(decoded);}
  for(const node of graph.filter(node=>hasType(node,'File'))){
    const pathname=relative(node['@id']),content=files[folder+'/'+pathname];check(content,'ELN 缺少引用的本地文件。');check(node.contentSize===undefined||String(content.length)===node.contentSize,'ELN 文件长度不符。');const digest=await sha(content);check(node.sha256===undefined||typeof node.sha256==='string'&&digest===node.sha256.toLowerCase(),'ELN 文件 SHA-256 不符。');if(node.sha256===undefined)warnings.push('部分外部文件没有 SHA-256，只能检查包结构和实际大小。');verified.set(node['@id'],{pathname,content,digest,node});
  }
  if(files[folder+'/ro-crate-metadata.json.minisig'])warnings.push('包内存在签名，本版不验证 minisign，也不声称来源真实。');
  check(Array.isArray(root.hasPart)&&root.hasPart.length>0&&root.hasPart.length<=200,'ELN 根目录须直接列出 1–200 份可导入 Dataset。');const sources=[],blobs={},seenDatasets=new Set();
  for(const reference of root.hasPart){
    const dataset=nodes.get(reference['@id']);check(hasType(dataset,'Dataset')&&!seenDatasets.has(dataset['@id']),'ELN 只能导入根目录直接列出的不重复 Dataset。');seenDatasets.add(dataset['@id']);
    const members=[],visited=new Set();
    function collect(node){check(node&&!visited.has(node['@id']),'ELN 引用循环或缺失节点。');visited.add(node['@id']);check(visited.size<=5000,'ELN 引用过多。');for(const part of node.hasPart||[]){const child=nodes.get(part['@id']);check(child,'ELN 引用不存在。');if(hasType(child,'File')){check(verified.has(child['@id']),'ELN 附件未校验。');if(!members.some(item=>item.node['@id']===child['@id']))members.push(verified.get(child['@id']));}else if(hasType(child,'Dataset'))collect(child);}}
    collect(dataset);
    let native;
    for(const member of members.filter(item=>item.pathname.endsWith('/record.json'))){try{const candidate=JSON.parse(strFromU8(member.content));if(candidate.schema==='colorlens-eln-record-1')native=candidate;}catch{check(false,'ELN record.json 无效。');}}
    if(native){
      check(native.archive?.entry?.data&&Array.isArray(native.archive.entry.attachments)&&Array.isArray(native.attachments),'镜析 ELN 原生记录结构无效。');
      check(native.attachments.length===native.archive.entry.attachments.length,'ELN 原生附件清单不一致。');const used=new Set();
      for(const attachment of native.archive.entry.attachments){const mapping=native.attachments.find(item=>item.id===attachment.id);check(mapping&&!used.has(attachment.id),'ELN 原生附件映射无效。');used.add(attachment.id);const file=members.find(item=>item.pathname===mapping.path);check(file&&file.digest===attachment.sha256&&file.content.length===attachment.size&&mapping.sha256===attachment.sha256&&mapping.size===attachment.size,'ELN 原生附件完整性失败。');blobs[attachment.sha256]=file.content;}
      sources.push(native.archive);
    }else{
      check(typeof dataset.name==='string'&&dataset.name.length<=200&&typeof(dataset.text??'')==='string'&&(dataset.text??'').length<=100000,'外部 ELN 名称或文字过长。');const attachments=[];
      for(const [index,member] of members.entries()){
        check(member.content.length>0&&member.content.length<=20*1048576,'外部 ELN 附件须为 1 字节至 20 MB。');let content=member.content,filename=safeName(member.node.name||member.pathname.split('/').at(-1));if(!supported.test(filename)){content=zipSync({[filename]:content},{level:1});filename+='.zip';warnings.push('不支持直接上传的原文件类型已无损封装为单文件 ZIP。');}
        const digest=await sha(content),id=String(index+1).padStart(32,'0');blobs[digest]=content;attachments.push({id,filename,size:content.length,sha256:digest});
      }
      check(attachments.length<100,'单份外部 ELN 附件过多。');
      sources.push({entry:{id:'external-'+sources.length,data:{title:dataset.name,body:dataset.text??'',discussion:'来自外部 .eln。原始 HTML 仅作为文字保留，不执行脚本、不加载外链；导入不是可信签署或原生历史恢复。',tags:typeof dataset.keywords==='string'?dataset.keywords.split(',').map(tag=>tag.trim()).filter(Boolean).slice(0,12):[]},attachments,events:[],analyses:[]},external_eln:{dataset,metadata}});
      warnings.push('外部 Dataset 按基础文字与本地文件导入新副本；自定义字段保存在来源 JSON，不伪装为镜析原生历史。');
    }
  }
  return {sources,blobs,warnings:[...new Set(warnings)]};
}
