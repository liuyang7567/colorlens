import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const recordBytes=record=>strToU8(JSON.stringify({...record,owner:undefined,notice:'本机实验过程资料。口令转写和照片需人工复核；不证明步骤完成。'},null,2));
function zip(record,files){const bytes=zipSync(files,{level:0,mtime:new Date(record.endedAt||record.startedAt)});return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
export function createRecordArchive(record,readImage){
  const files={'record.json':recordBytes(record)};for(const frame of record.frames)files['photos/'+frame.id+'.jpg']=readImage(frame.id);return zip(record,files);
}
export function createRecordParts(record,readImage,{maximumBytes=20*1048576}={}){
  if(!Number.isInteger(maximumBytes)||maximumBytes<262144||maximumBytes>20*1048576)throw new Error('分组大小无效。');
  if(!Array.isArray(record.frames)||record.frames.length>100)throw new Error('记录照片数量无效，请保留本机资料检查。');
  const metadata=recordBytes(record),images=record.frames.map(frame=>({id:frame.id,bytes:readImage(frame.id)})),photoBytes=images.reduce((sum,item)=>sum+item.bytes.length,0);
  if(photoBytes>32*1048576)throw new Error('记录照片超过本机上限，请保留原资料检查。');
  const make=(group,index)=>{const files={'record.json':metadata,...index?{'bundle.json':index}:{}};for(const image of group)files['photos/'+image.id+'.jpg']=image.bytes;return zip(record,files);};
  const full=make(images),baseName='镜析-免手动-'+record.id;
  const result={schema:'colorlens-record-bundle-1',recordId:record.id,recordSha256:hash(metadata),fullBytes:full.length,totalPhotos:images.length,photoBytes,parts:[]};
  if(full.length<=maximumBytes){result.parts=[{number:1,total:1,filename:baseName+'.zip',photoCount:images.length,photoIds:images.map(image=>image.id),size:full.length,sha256:hash(full),bytes:full}];return result;}
  const target=Math.floor(maximumBytes*0.9),overhead=metadata.length+65536+4096,groups=[];let current=[],used=overhead;
  for(const image of images){const required=image.bytes.length+1024;if(required+overhead>target)throw new Error('单张照片或时间线过大，无法在附件上限内分组；请保留完整本机导出。');if(current.length&&used+required>target){groups.push(current);current=[];used=overhead;}current.push(image);used+=required;}
  if(current.length)groups.push(current);if(groups.length<2||groups.length>99)throw new Error('记录分组失败，请保留完整本机导出。');
  const descriptions=groups.map((group,index)=>({number:index+1,total:groups.length,filename:baseName+'-part-'+String(index+1).padStart(2,'0')+'-of-'+String(groups.length).padStart(2,'0')+'.zip',photoIds:group.map(image=>image.id)}));
  const index=strToU8(JSON.stringify({schema:result.schema,recordId:record.id,recordSha256:result.recordSha256,totalPhotos:images.length,parts:descriptions,notice:'本记录需要保留全部分组。各组含相同 record.json 和 bundle.json，照片分组存放；合并解压到同一目录可得到完整记录。'},null,2));
  if(index.length>65536)throw new Error('分组索引过大，请保留完整本机导出。');
  result.parts=groups.map((group,number)=>{const bytes=make(group,index);if(bytes.length>maximumBytes)throw new Error('分组仍超过附件上限，未发送或删减照片。');return {...descriptions[number],photoCount:group.length,size:bytes.length,sha256:hash(bytes),bytes};});return result;
}
