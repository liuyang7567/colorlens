import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,existsSync,statSync,lstatSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createRecordArchive,createRecordParts} from './record-bundle.mjs';
import {pcmWave,trimQuietEdges} from './audio.mjs';

const identifier=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const ensure=(value,message)=>{if(!value)throw new Error(message);};
export function voiceCommand(text){
  if(typeof text!=='string'||text.length>2000)return null;
  const forms={'實':'实','驗':'验','鏡':'镜','暫':'暂','繼':'继','續':'续','記':'记','錄':'录','標':'标','結':'结'};
  const normalized=text.trim().replace(/[實驗鏡暫繼續記錄標結]/g,character=>forms[character]).replace(/[，。！？、,:;.!?]/g,' ').replace(/\s+/g,' ').trim();
  const matched=normalized.match(/^(?:实验助手|镜析|lab assistant|color lens)\s*(.*)$/i);if(!matched)return null;
  const command=matched[1].trim();
  if(/^(?:拍照|截图|photo|take a photo)$/i.test(command))return {action:'photo'};
  if(/^(?:暂停记录|暂停留图|pause recording)$/i.test(command))return {action:'pause'};
  if(/^(?:继续记录|继续留图|resume recording)$/i.test(command))return {action:'resume'};
  if(/^(?:结束记录|停止记录|stop recording)$/i.test(command))return {action:'stop'};
  const note=command.match(/^(?:标记|记录|mark|note)\s*(.+)$/i);
  return note&&note[1].trim().length<=600?{action:'note',text:note[1].trim()}:null;
}
export function frameQuality(gray,previous){
  ensure(gray.length===160*90,'预览质量数据无效。');let dark=0,bright=0,variation=0,edge=0;
  for(let index=0;index<gray.length;index++){if(gray[index]<12)dark++;if(gray[index]>245)bright++;if(previous)variation+=Math.abs(gray[index]-previous[index]);if(index%160>0)edge+=(gray[index]-gray[index-1])**2;}
  const sharpness=edge/gray.length,duplicate=Boolean(previous)&&variation/gray.length<1.5;
  const warnings=[];if(dark/gray.length>0.7)warnings.push('画面过暗');if(bright/gray.length>0.7)warnings.push('画面过亮');if(sharpness<12)warnings.push('画面细节不足，可能模糊或对准空白');
  return {usable:!warnings.length&&!duplicate,duplicate,sharpness,warnings};
}
export class HandsFreeRecorder{
  constructor(engine,{transcribe}={}){this.engine=engine;this.root=path.join(engine.state,'handsfree');mkdirSync(this.root,{recursive:true});this.transcribe=transcribe;this.active=null;this.revision=0;this.jobs=new Set();}
  folder(id){ensure(identifier(id),'记录编号无效。');const folder=path.resolve(this.root,id);ensure(folder.startsWith(path.resolve(this.root)+path.sep),'记录路径无效。');if(existsSync(folder))ensure(!lstatSync(folder).isSymbolicLink(),'记录目录不能是链接。');return folder;}
  persist(){if(!this.active)return;const folder=this.folder(this.active.id),temporary=path.join(folder,'record.tmp');writeFileSync(temporary,JSON.stringify(this.active));renameSync(temporary,path.join(folder,'record.json'));}
  storedBytes(){let total=0;for(const item of readdirSync(this.root,{withFileTypes:true})){if(!item.isDirectory()||!identifier(item.name))continue;try{const folder=this.folder(item.name);for(const file of readdirSync(folder)){if(/^[a-f0-9-]{36}\.jpg$/.test(file))total+=statSync(path.join(folder,file)).size;}}catch{}}return total;}
  event(kind,text,extra={}){if(!this.active)return;ensure(this.active.events.length<500,'本次记录已达 500 项，请结束后导出。');this.active.events.push({id:randomUUID(),at:new Date().toISOString(),kind,text,...extra});this.persist();}
  renew(claims){if(!this.active||!['recording','paused'].includes(this.active.status)||this.nonce!==claims.nonce)return;const same=this.active.owner===claims.user_id&&this.active.entryId===claims.entry_id;if(!same){void this.stop('采集账号或实验归属变化，记录已停止。');return;}this.expires=claims.expires_at;}
  list(claims){const records=[];for(const item of readdirSync(this.root,{withFileTypes:true})){if(!item.isDirectory()||!identifier(item.name))continue;try{const record=JSON.parse(readFileSync(path.join(this.folder(item.name),'record.json'),'utf8'));if(record.owner!==claims.user_id||record.entryId!==claims.entry_id)continue;records.push({id:record.id,status:record.id===this.active?.id?this.active.status:['recording','paused'].includes(record.status)?'interrupted':record.status,startedAt:record.startedAt,events:record.events.length,frames:record.frames.length});}catch{}}
    return records.sort((left,right)=>right.startedAt.localeCompare(left.startedAt));}
  read(claims,id){const record=this.active?.id===id?this.active:JSON.parse(readFileSync(path.join(this.folder(id),'record.json'),'utf8'));ensure(record.owner===claims.user_id&&record.entryId===claims.entry_id,'记录不属于当前账号和实验。');return record.id!==this.active?.id&&['recording','paused'].includes(record.status)?{...record,status:'interrupted'}:record;}
  status(claims,id){const records=this.list(claims),active=this.active&&this.active.owner===claims.user_id&&this.active.entryId===claims.entry_id?this.active:null,selected=id?(records.some(record=>record.id===id)?this.read(claims,id):null):active;return {record:selected?{...selected,owner:undefined}:null,records,listening:Boolean(this.audio)&&['recording','paused'].includes(this.active?.status)&&selected?.id===this.active?.id,lastQuality:selected?.id===this.active?.id?this.lastQuality:null,voiceState:selected?.id===this.active?.id?this.voiceState:null,error:this.error||'',notice:'语音只处理眼镜音轨；暂停留图仍监听继续/结束口令。提示音从电脑默认音频设备播放。'};}
  async start(claims,payload){
    ensure(!this.error||!this.active||this.active.owner===claims.user_id&&this.active.entryId===claims.entry_id,'上次记录尚未写入磁盘；请原账号在原实验中先导出并处理这份本机资料，再开始其他实验。');
    ensure(!['recording','paused'].includes(this.active?.status),'已有免手动记录，请先结束。');ensure(!this.capturing&&!this.recognizing,'上一段处理尚在退出，请稍候重试。');ensure(payload.imageConsent===true&&(!payload.voice||payload.audioConsent===true),'请先确认本次留图和语音授权。');
    ensure([20,40,60].includes(payload.interval)&&['zh','en'].includes(payload.language||'zh'),'记录参数无效。');const device=this.engine.devices.get(payload.deviceId);ensure(this.engine.running&&device?.ready,'请先确认眼镜直播已到达电脑。');
    ensure(!payload.voice||device.tracks.some(track=>/Audio|Opus|AAC/i.test(track.codec)),'当前直播没有眼镜音轨，请先使用自动留图。');ensure(this.list(claims).length<20,'本实验已保留 20 次记录，请先导出并删除不需要的本机记录。');
    ensure(!this.engine.speechBusy,'另一段音频正在转写，请先等待结束。');ensure(this.storedBytes()<256*1048576,'本机免手动照片达到 256 MB，请先导出并删除不需要的记录。');this.active={schema:'colorlens-handsfree-1',id:randomUUID(),owner:claims.user_id,entryId:claims.entry_id,entryTitle:claims.entry_title,deviceId:device.id,status:'recording',startedAt:new Date().toISOString(),interval:payload.interval,voice:Boolean(payload.voice),language:payload.language||'zh',events:[],frames:[],bytes:0};
    try{
    mkdirSync(this.folder(this.active.id));this.nonce=claims.nonce;this.expires=claims.expires_at;this.started=Date.now();this.revision++;this.controller=new AbortController();this.previous=null;this.lastCommand=null;this.audioBuffer=Buffer.alloc(0);this.voiceState={phase:payload.voice?'buffering':'disabled',lastAudioAt:null,lastCommandAt:null,lastRecognizedAt:null,lastRecognitionMs:null,level:0,droppedAudioSeconds:0};this.persist();this.event('start','记录已开启；转写标记和照片需实验后复核。');
    this.error='';this.lastQuality=null;this.lastWarning='';const current=this.revision;this.timer=setInterval(()=>void this.capture(false,current).catch(error=>void this.stop(error.message)),payload.interval*1000);this.watchdog=setInterval(()=>{
      if(this.expires<=Date.now())void this.stop('本窗口授权到期，记录已停止；请重新打开采集窗口。');
      else if(Date.now()-this.started>60*60*1000)void this.stop('本次记录已满一小时，记录已停止；请先复核保存。');
      else if(!this.engine.running)void this.stop('本机接收已停止，本次记录已结束。');
      else if(!this.engine.devices.get(device.id)?.online)void this.stop('眼镜直播连接断开，本次记录已停止；已保存资料保留。');
      else if(this.active.voice&&Date.now()-(this.voiceState.lastAudioAt||this.started)>12000)void this.stop('眼镜音轨超过 12 秒未收到数据，记录已停止；请检查直播音轨。');
    },1000);
    if(payload.voice)this.listen(device,current);void this.capture(false,current).catch(error=>void this.stop(error.message));
    }catch(error){const reason=error.code?'无法写入本机记录，请检查磁盘空间和保存目录。':error.message;await this.stop(reason);throw new Error(reason);}
    return this.status(claims);
  }
  async capture(explicit,current=this.revision){
    if(current!==this.revision||this.active?.status!=='recording')return;if(this.capturing){if(explicit)this.event('feedback','正在保存上一张照片，请稍后再说拍照。');return;}this.capturing=true;
    try{
      const device=this.engine.devices.get(this.active.deviceId);ensure(device?.ready,'眼镜预览未就绪。');ensure(this.active.frames.length<100&&this.active.bytes<32*1048576,'本次照片达到 100 张或 32 MB，请结束后导出。');
      const jpeg=await this.collect(path.join(this.engine.runtime,'ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-rtsp_transport','tcp','-timeout','8000000','-i',this.engine.outputUrl(device),'-frames:v','1','-vf','scale=960:720:force_original_aspect_ratio=decrease','-q:v','3','-f','image2pipe','-vcodec','mjpeg','pipe:1'],1024*1024,12000);
      if(current!==this.revision||this.active.status!=='recording')return;
      const gray=await this.collect(path.join(this.engine.runtime,'ffmpeg.exe'),['-hide_banner','-loglevel','error','-i','pipe:0','-vf','scale=160:90,format=gray','-frames:v','1','-f','rawvideo','pipe:1'],160*90,8000,jpeg);
      if(current!==this.revision||this.active.status!=='recording')return;const quality=frameQuality(gray,this.previous);if(!explicit&&!quality.usable){this.lastQuality=quality;const warnings=quality.warnings.join('；');if(warnings&&warnings!==this.lastWarning){this.lastWarning=warnings;this.event('feedback','自动照片未保留：'+warnings+'，请检查镜头和位置。');}return;}this.lastWarning='';
      ensure(this.active.bytes+jpeg.length<=32*1048576&&this.storedBytes()+jpeg.length<=256*1048576,'照片空间达到上限，请先导出。');const id=randomUUID(),filename=id+'.jpg';writeFileSync(path.join(this.folder(this.active.id),filename),jpeg);this.active.bytes+=jpeg.length;this.active.frames.push({id,filename,at:new Date().toISOString(),source:explicit?'voice-photo':'automatic',sha256:createHash('sha256').update(jpeg).digest('hex'),quality});this.previous=Buffer.from(gray);this.event('photo',explicit?'语音照片已保存，请实验后核对。':'已保留一张自动照片。',{frameId:id});
    }finally{this.capturing=false;}
  }
  async collect(filename,args,maximum,timeout,input){const jobs=[];this.jobs.add(jobs);try{return await this.engine.collect(filename,args,maximum,timeout,jobs,this.controller.signal,input);}finally{this.jobs.delete(jobs);}}
  listen(device,current){
    const child=this.engine.spawnAudio(device);this.audio=child;this.engine.children.add(child);child.stderr.resume();child.stdout.on('data',chunk=>{if(current!==this.revision||this.audio!==child)return;this.voiceState.lastAudioAt=Date.now();this.audioBuffer=Buffer.concat([this.audioBuffer,chunk]);if(this.audioBuffer.length>32000*12){const skipped=Math.floor((this.audioBuffer.length-32000*12)/2)*2;this.voiceState.droppedAudioSeconds+=skipped/32000;this.audioBuffer=this.audioBuffer.subarray(skipped);}});child.on('error',()=>void this.stop('眼镜音轨无法读取，记录已停止。'));child.on('close',()=>{this.engine.children.delete(child);if(this.audio===child&&current===this.revision)void this.stop('眼镜音轨中断，记录已停止。');});
    this.speechTimer=setInterval(()=>void this.recognize(current),2000);
  }
  async recognize(current){
    if(current!==this.revision||this.recognizing||this.audioBuffer.length<32000*4)return;const length=this.audioBuffer.length-this.audioBuffer.length%2,pcm=Buffer.from(this.audioBuffer.subarray(Math.max(0,length-32000*6),length));this.audioBuffer=this.audioBuffer.subarray(Math.max(0,length-32000*3));let energy=0;for(let index=0;index+1<pcm.length;index+=2)energy+=(pcm.readInt16LE(index)/32768)**2;const speech=trimQuietEdges(pcm);if(!speech){this.voiceState??={};this.voiceState.phase='quiet';this.voiceState.level=Math.sqrt(energy/(pcm.length/2));return;}
    this.voiceState??={};this.voiceState.level=Math.sqrt(energy/(pcm.length/2));this.voiceState.phase='recognizing';this.recognizing=true;const started=Date.now();
    try{const text=this.transcribe?await this.transcribe(pcmWave(speech)):await this.collect(path.join(this.engine.runtime,'whisper/Release/whisper-cli.exe'),['-m',path.join(this.engine.runtime,'whisper/ggml-base-q5_1.bin'),'-f','-','-of','memory','-l',this.active.language,'-nt','-np','-ng','-t','4'],16000,30000,pcmWave(speech));if(current!==this.revision)return;this.voiceState.lastRecognizedAt=Date.now();this.voiceState.lastRecognitionMs=Date.now()-started;this.voiceState.phase='waiting';const command=voiceCommand(String(text).trim());if(command)await this.command(command,current);}catch(error){if(current===this.revision)await this.stop('本机口令识别失败：'+error.message);}finally{this.recognizing=false;}
  }
  async command(command,current=this.revision){
    if(current!==this.revision||!['recording','paused'].includes(this.active?.status))return;const fingerprint=JSON.stringify(command);if(this.lastCommand?.fingerprint===fingerprint&&Date.now()-this.lastCommand.at<8000)return;this.lastCommand={fingerprint,at:Date.now()};if(this.voiceState)this.voiceState.lastCommandAt=Date.now();
    if(command.action==='photo'){if(this.active.status==='paused')this.event('feedback','当前已暂停留图，请先说“实验助手，继续记录”。');else await this.capture(true,current);}
    else if(command.action==='pause'){this.active.status='paused';this.event('pause','已暂停自动留图，仍监听继续和结束口令。');}
    else if(command.action==='resume'){this.active.status='recording';this.event('resume','自动留图已继续。');}
    else if(command.action==='note')this.event('note',command.text,{needsReview:true});
    else if(command.action==='stop')await this.stop('语音结束记录。');
  }
  async stop(reason='本次免手动记录已结束。'){
    if(!['recording','paused'].includes(this.active?.status))return;this.revision++;clearInterval(this.timer);clearInterval(this.watchdog);clearInterval(this.speechTimer);this.controller?.abort();const audio=this.audio;this.audio=null;audio?.kill();for(const jobs of this.jobs)for(const child of jobs)if(child.exitCode===null)child.kill();this.jobs.clear();this.audioBuffer=Buffer.alloc(0);if(this.voiceState)this.voiceState.phase='stopped';this.active.status='ended';this.active.endedAt=new Date().toISOString();try{if(this.active.events.length<500)this.event('stop',reason);else this.persist();}catch{this.error='本机存储写入失败，记录已停止；请检查磁盘并保留已写入照片。';}
  }
  image(claims,recordId,frameId){const record=this.read(claims,recordId),frame=record.frames.find(frame=>frame.id===frameId);ensure(frame&&identifier(frameId),'照片不存在。');const filename=path.join(this.folder(record.id),frameId+'.jpg'),file=lstatSync(filename);ensure(file.isFile()&&!file.isSymbolicLink()&&file.size>0&&file.size<=1048576,'照片文件无效或超过采集上限，请保留本机资料检查。');const bytes=readFileSync(filename);ensure(frame.sha256&&createHash('sha256').update(bytes).digest('hex')===frame.sha256,'照片完整性校验失败，请保留本机资料检查。');return bytes;}
  export(claims,id){const record=this.read(claims,id);ensure(!['recording','paused'].includes(record.status),'请先结束本次记录后导出。');return createRecordArchive(record,frameId=>this.image(claims,id,frameId));}
  exportParts(claims,id){const record=this.read(claims,id);ensure(!['recording','paused'].includes(record.status),'请先结束本次记录后分组。');return createRecordParts(record,frameId=>this.image(claims,id,frameId));}
  exportPlan(claims,id){const bundle=this.exportParts(claims,id);return {...bundle,parts:bundle.parts.map(({bytes,...part})=>part)};}
  exportPart(claims,id,number){ensure(Number.isSafeInteger(number)&&number>=1&&number<=99,'分组编号无效。');const bundle=this.exportParts(claims,id),part=bundle.parts.find(item=>item.number===number);ensure(part,'分组不存在，请重新准备资料。');return part.bytes;}
  remove(claims,id){const record=this.read(claims,id);ensure(!['recording','paused'].includes(record.status),'请先结束记录。');const folder=this.folder(id);ensure(folder.startsWith(path.resolve(this.root)+path.sep),'删除路径不在记录目录内。');rmSync(folder,{recursive:true,force:false});if(this.active?.id===id)this.active=null;}
}
