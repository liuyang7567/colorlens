import {captureArchivePart} from '/capture-bridge.mjs';
import {createCaptureFeedback} from '/capture-feedback.mjs';
export function mountHandsFree({root,api,getState,transfer}){
  const section=document.createElement('section');section.className='panel';section.id='handsfree-panel';
  section.innerHTML='<h2>实验前开启一次，过程免手动记录</h2><p>后台自动挑选有细节、曝光可用且变化明显的照片。实验中可使用眼镜音轨口令；实验结束后在电脑复核与导出，不必逐次点取帧。</p><label class="check"><input id="hf-image-consent" type="checkbox">我确认本次自动留图，已取得在场人员同意；照片保存到本机当前实验资料。</label><label class="check"><input id="hf-voice" type="checkbox">同时开启眼镜音轨的本机离线口令识别</label><label class="check"><input id="hf-audio-consent" type="checkbox">我同意持续处理本次眼镜音轨，只保留识别到的标记文字，不保存原始音频。</label><div class="controls"><label>自动观察间隔<select id="hf-interval"><option value="20">20 秒</option><option value="40" selected>40 秒</option><option value="60">60 秒</option></select></label><label>口令语言<select id="hf-language"><option value="zh">中文</option><option value="en">English</option></select></label><button id="hf-start">开始免手动记录</button><button id="hf-stop" class="secondary">结束本次记录</button></div><label class="check"><input id="hf-feedback" type="checkbox" checked>使用电脑默认音频设备播放本机提示；尚未接通眼镜扬声器</label><p>中文：实验助手，拍照／标记 后接一句话／暂停记录／继续记录／结束记录。暂停留图时仍监听继续和结束口令。English: Lab assistant, photo / note ... / pause recording / resume recording / stop recording.</p><p id="hf-state" role="status" aria-live="polite">尚未开始。语音识别可能延迟或漏听，实验前请先试说口令。</p><p class="muted">此模式主要保存过程证据。照片质量检查不等于判断实验操作正确；镜头移开、反光或遮挡仍可能漏掉关键动作。口令标记保留为待复核资料。</p><label>本实验的本机记录<select id="hf-history"></select></label><div class="controls"><button id="hf-export" class="secondary">导出照片与时间线 ZIP</button><button id="hf-delete" class="secondary">删除选中的本机资料</button></div><div id="hf-events" style="max-height:280px;overflow:auto"></div><div id="hf-photos" style="display:flex;gap:12px;flex-wrap:wrap"></div>';
  root.querySelector('#stream').closest('section').before(section);const element=id=>section.querySelector('#'+id);let selected=null,snapshot=null,lastRendered='',busy=false,polling=false,ownedRecord=null,lastToken='';
  const soundTest=document.createElement('button');soundTest.id='hf-test-sound';soundTest.className='secondary';soundTest.textContent='实验前：试听电脑提示';element('hf-feedback').closest('label').after(soundTest);
  const soundStatus=document.createElement('p');soundStatus.id='hf-feedback-status';soundStatus.setAttribute('role','status');soundStatus.textContent='可先试听并确认能听见。声音不可用时仍可记录；提示尚未接通眼镜扬声器。';soundTest.after(soundStatus);
  const player=createCaptureFeedback({language:()=>element('hf-language').value,canNotify:()=>Boolean(getState().token),report:value=>{soundStatus.textContent=value;}});
  soundTest.onclick=()=>void player.preview();window.addEventListener('pagehide',()=>player.dispose());
  const summary=document.createElement('button');summary.id='hf-transfer';summary.className='secondary';summary.textContent='实验后：时间线传入待保存区';element('hf-export').after(summary);
  const bundle=document.createElement('button');bundle.id='hf-save-bundle';bundle.className='secondary';bundle.textContent='照片与时间线整包传入实验';summary.after(bundle);
  const voiceTest=document.createElement('button');voiceTest.id='hf-test-voice';voiceTest.className='secondary';voiceTest.textContent='实验前：6 秒口令自检';element('hf-start').before(voiceTest);
  const cancelTest=document.createElement('button');cancelTest.id='hf-cancel-test';cancelTest.className='secondary';cancelTest.textContent='取消自检';voiceTest.after(cancelTest);
  const startHint=document.createElement('p');startHint.id='hf-start-hint';startHint.className='muted';startHint.setAttribute('role','status');element('hf-start').closest('div').after(startHint);element('hf-start').setAttribute('aria-describedby',startHint.id);
  const testHint=document.createElement('p');testHint.id='hf-test-hint';testHint.className='muted';testHint.setAttribute('role','status');startHint.after(testHint);voiceTest.setAttribute('aria-describedby',testHint.id);
  const testResult=document.createElement('p');testResult.id='hf-test-result';testResult.setAttribute('role','status');testResult.textContent='自检只检查音轨和口令，不执行拍照。先点自检，等出现“现在说”或电脑短提示后再说“实验助手，拍照”。';element('hf-state').before(testResult);
  const voiceStatus=document.createElement('p');voiceStatus.id='hf-voice-status';voiceStatus.setAttribute('role','status');element('hf-state').after(voiceStatus);
  const storageStatus=document.createElement('p');storageStatus.id='hf-storage-status';storageStatus.setAttribute('role','alert');storageStatus.hidden=true;voiceStatus.after(storageStatus);
  let testRunning=false,testController=null,testTimer=null,selectionRevision=0,feedbackRecord=null,feedbackCount=0;
  const actionStatus=document.createElement('p');actionStatus.id='hf-action-status';actionStatus.setAttribute('role','status');bundle.after(actionStatus);
  const groupPanel=document.createElement('section');groupPanel.id='hf-groups';groupPanel.className='notice';groupPanel.hidden=true;element('hf-export').closest('div').after(groupPanel);let groupPlan=null,receivedGroups=new Set();
  const status=value=>{actionStatus.textContent=value;};
  const liveStatus=value=>{element('hf-state').textContent=value;};
  function storageIssue(error){const message=typeof error==='string'&&error.trim()?error.trim()+' 请先导出需要的照片与时间线，并核对完整资料。最新变更可能只在本次应用内存中，关闭应用或开始新记录前请先保存副本。':'';if(storageStatus.textContent!==message)storageStatus.textContent=message;storageStatus.hidden=!message;}
  function eventDescription(item){return item?.kind==='stop'&&/^本机口令识别失败：(ENOSPC|EACCES|EPERM|EDQUOT|EROFS|EISDIR|ENOENT):/.test(item.text||'')?'本机资料读写失败，记录已停止；请先导出需要的资料。':item?.text||'';}
  const safe=operation=>Promise.resolve().then(operation).catch(error=>status(error.message)).finally(()=>{busy=false;availability();});
  async function cancelVoiceTest(){testController?.abort();try{await api('/api/speech-cancel');testResult.textContent='口令自检已取消。';}catch(error){testResult.textContent='正在结束本机识别：'+error.message;}}
  voiceTest.onclick=()=>void safe(async()=>{
    if(!element('hf-audio-consent').checked)throw new Error('请先同意眼镜音轨处理，再进行口令自检。');
    testRunning=true;const controller=new AbortController();testController=controller;availability();testResult.textContent='正在连接眼镜音轨，请先等待“现在说”的提示。';
    if(element('hf-feedback').checked)await player.prepare();
    let updating=false,prompted=false;
    testTimer=setInterval(async()=>{if(updating||controller.signal.aborted)return;updating=true;try{
      const progress=await api('/api/speech-state',{}, {signal:controller.signal});if(testController!==controller)return;
      if(progress.phase==='listening'){
        const example=element('hf-language').value==='en'?'Lab assistant, photo':'实验助手，拍照';testResult.textContent='已收到音轨，现在说“'+example+'”。剩余约 '+Math.max(0,Math.ceil((6000-progress.capturedMs)/1000))+' 秒。';
        if(!prompted){prompted=true;if(element('hf-feedback').checked)player.prompt(850);}
      }else if(progress.phase==='recognizing')testResult.textContent='采样已结束，正在本机识别口令，请稍候；也可以取消。';
    }catch{}finally{updating=false;}},250);
    try{const current=getState(),result=await api('/api/transcribe',{deviceId:current.selectedDevice,language:element('hf-language').value,consent:true,mode:'command-test'},{signal:controller.signal});testResult.textContent=result.command?'自检识别成功：'+result.text+'。测试未执行该口令。':'未匹配口令。识别文字：'+result.text+'；请等“现在说”后在安静环境重试短口令。';}
    catch(error){testResult.textContent=error.name==='AbortError'?'口令自检已取消。':'自检未通过：'+error.message;}
    finally{clearInterval(testTimer);testRunning=false;testController=null;}
  });
  cancelTest.onclick=()=>void safe(cancelVoiceTest);
  function clearGroups(){groupPlan=null;receivedGroups=new Set();groupPanel.replaceChildren();groupPanel.hidden=true;}
  function renderGroups(){
    groupPanel.replaceChildren();groupPanel.hidden=!groupPlan||groupPlan.parts.length<2;if(groupPanel.hidden)return;
    const heading=document.createElement('strong');heading.textContent='大记录已分为 '+groupPlan.parts.length+' 组，全部照片均已保留。';const explanation=document.createElement('p');explanation.textContent='请逐组传回并在主页面确认保存。每组包含完整时间线，照片分组存放；只保存部分组会缺少照片。';const progress=document.createElement('p');progress.id='hf-groups-progress';progress.textContent='主页面已确认接收 '+receivedGroups.size+'/'+groupPlan.parts.length+' 组；这不代表已写入实验。';groupPanel.append(heading,explanation,progress);
    for(const part of groupPlan.parts){const row=document.createElement('div');row.className='controls';const text=document.createElement('span');text.textContent='第 '+part.number+'/'+part.total+' 组 · '+part.photoCount+' 张照片 · '+(part.size/1048576).toFixed(1)+' MB';const button=document.createElement('button');button.className='secondary';button.dataset.part=part.number;button.textContent=(receivedGroups.has(part.number)?'再次传回第 ':'传回第 ')+part.number+' 组';button.onclick=()=>void safe(async()=>{busy=true;availability();await sendGroup(part);});row.append(text,button);groupPanel.append(row);}availability();
  }
  async function sendGroup(part){
    const plan=groupPlan;if(!plan||plan.recordId!==selected||snapshot?.record?.id!==selected)throw new Error('所选记录已变化，请重新准备完整资料。');
    status('正在准备第 '+part.number+'/'+part.total+' 组…');const blob=await api('/api/handsfree/export-part',{id:plan.recordId,number:part.number},{responseType:'blob'});if(blob.size!==part.size||blob.size>20*1048576)throw new Error('分组大小已变化，请重新准备；没有删减照片。');const archive=await blob.arrayBuffer(),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',archive))].map(value=>value.toString(16).padStart(2,'0')).join('');if(sha256!==part.sha256||groupPlan!==plan||selected!==plan.recordId)throw new Error('分组内容已变化，请重新准备资料。');
    status('等待主页面确认第 '+part.number+'/'+part.total+' 组…');await transfer({type:'archive',capturedAt:new Date().toISOString(),source:part.total===1?'免手动实验完整资料（照片与时间线，待复核）':'免手动记录第 '+part.number+'/'+part.total+' 组（需保存全部组）',filename:part.filename,sha256,archive},[archive]);receivedGroups.add(part.number);renderGroups();status(part.total===1?'主页面已接收完整资料，仍需在主页面核对并确认保存为实验附件。':'主页面已确认接收第 '+part.number+'/'+part.total+' 组，请先确认保存，再继续下一组；全部组才含完整照片。');
  }
  bundle.onclick=()=>void safe(async()=>{
    busy=true;availability();const record=snapshot?.record;if(!record||['recording','paused'].includes(record.status)||record.id!==selected)throw new Error('请先结束并选中要保存的记录。');status('正在准备完整照片与时间线，超过附件上限时将自动分组…');const plan=await api('/api/handsfree/export-plan',{id:record.id});
    if(record.id!==selected||plan.recordId!==record.id||plan.schema!=='colorlens-record-bundle-1'||!/^[a-f0-9]{64}$/.test(plan.recordSha256||'')||!Array.isArray(plan.parts)||!plan.parts.length||plan.parts.length>99||!plan.parts.every((part,index)=>{const name=captureArchivePart(part.filename);return part.number===index+1&&part.total===plan.parts.length&&name?.recordId===plan.recordId&&name.number===part.number&&name.total===part.total&&Number.isSafeInteger(part.size)&&part.size>=22&&part.size<=20*1048576&&Number.isSafeInteger(part.photoCount)&&part.photoCount>=0&&part.photoCount<=100&&/^[a-f0-9]{64}$/.test(part.sha256||'');}))throw new Error('分组计划校验失败，请保留本机资料后重试。');
    if(groupPlan?.recordId!==plan.recordId||groupPlan?.recordSha256!==plan.recordSha256)receivedGroups=new Set();groupPlan=plan;renderGroups();if(plan.parts.length===1)await sendGroup(plan.parts[0]);else status('已准备 '+plan.parts.length+' 组完整资料。请按编号逐组传回，并在主页面确认保存；未丢弃任何照片。');
  });
  function availability(){
    const current=getState(),device=current.state?.devices.find(item=>item.id===current.selectedDevice),running=['recording','paused'].includes(snapshot?.record?.status),locked=busy||testRunning;
    const hasAudio=Boolean(device?.tracks?.some(track=>/Audio|Opus|AAC/i.test(track.codec))),otherRecord=snapshot?.records?.some(record=>record.id!==snapshot?.record?.id&&['recording','paused'].includes(record.status));
    const connectionIssue=!current.token?'请从镜析主页面选择实验，再打开本机采集窗口。':!current.state?.running?'请先在上方点击“开始本机接收”，再到官方 App 开播。':!device?.online?'正在等待眼镜直播。请确认同一 Wi-Fi，并在官方 App 使用本次地址开播。':!device.ready?'已收到直播，正在准备画面，请稍候。':'';
    const activeIssue=locked?testRunning?'口令自检正在进行，可等待结果或点击“取消自检”。':'正在处理本次操作，请稍候。':running?'本次记录进行中；结束后再开始新记录或导出资料。':otherRecord?'本实验已有另一条记录进行中，请从本机记录列表选择它查看。':'';
    const startIssue=connectionIssue||activeIssue||(!element('hf-image-consent').checked?'请先勾选本次自动留图授权。':element('hf-voice').checked&&!element('hf-audio-consent').checked?'开启口令识别前，请先勾选本次眼镜音轨处理授权。':element('hf-voice').checked&&!current.state.offlineSpeech?'本机离线语音组件不可用；可取消口令识别，继续使用自动留图。':element('hf-voice').checked&&!hasAudio?'直播没有可用音轨。请在官方 App 开启音频，或取消口令识别，使用自动留图。':current.speechBusy?'另一段语音正在处理，请等待或取消后再开始。':'');
    const testIssue=connectionIssue||activeIssue||(!element('hf-audio-consent').checked?'进行口令自检前，请勾选本次眼镜音轨处理授权。':!current.state.offlineSpeech?'本机离线语音组件不可用，请检查接收助手的语音组件。':!hasAudio?'直播没有可用音轨，暂不能进行口令自检；自动留图仍可使用。':current.speechBusy?'另一段语音正在处理，请等待或取消后再自检。':'');
    const startText=startIssue||'已准备好。点击“开始免手动记录”后，按所选间隔自动留图。',testText=testIssue||'口令自检已可用。点击后等“现在说”的提示，再说一条短口令。';if(startHint.textContent!==startText)startHint.textContent=startText;if(testHint.textContent!==testText)testHint.textContent=testText;
    if(lastToken&&!current.token)player.cancel();lastToken=current.token;soundTest.disabled=locked||running||!element('hf-feedback').checked;
    element('hf-start').disabled=Boolean(startIssue);
    element('hf-stop').disabled=busy||!current.token||!running;
    voiceTest.disabled=Boolean(testIssue);
    cancelTest.disabled=!testRunning;
    for(const id of ['hf-export','hf-delete','hf-transfer','hf-save-bundle'])element(id).disabled=locked||!current.token||!selected||running||snapshot?.record?.id!==selected;
    element('hf-history').disabled=locked||!current.token||running;
    for(const id of ['hf-voice','hf-interval','hf-language'])element(id).disabled=locked||running;
    for(const button of groupPanel.querySelectorAll('button'))button.disabled=locked||!current.token||running||groupPlan?.recordId!==selected||snapshot?.record?.id!==selected;
  }
  function feedback(events){if(element('hf-feedback').checked)player.notify(Array.isArray(events)?events:[events]);}
  async function load(){
    if(polling||!getState().token)return;polling=true;const revision=selectionRevision,requested=selected,token=getState().token;
    try{
      const names={recording:'记录中',paused:'留图暂停，仍监听口令',ended:'已结束',interrupted:'上次意外中断'},response=await api('/api/handsfree/state',requested?{id:requested}:{});
      if(revision!==selectionRevision||token!==getState().token)return;snapshot=response;storageIssue(response.error);const record=response.record;
      selected=record?.id||(response.records.some(item=>item.id===selected)?selected:response.records[0]?.id)||null;
      if(groupPlan&&groupPlan.recordId!==selected)clearGroups();
      const signature=response.records.map(item=>item.id+item.status+item.frames).join();
      if(element('hf-history').dataset.signature!==signature){element('hf-history').replaceChildren(...response.records.map(item=>new Option(new Date(item.startedAt).toLocaleString()+' · '+(names[item.status]||item.status)+' · '+item.frames+' 张',item.id)));element('hf-history').dataset.signature=signature;}
      if(selected)element('hf-history').value=selected;
      if(record&&record.id===selected){
        const event=record.events.at(-1);liveStatus('本次 '+(names[record.status]||record.status)+' · '+record.frames.length+'/100 张照片 · '+record.events.length+' 条记录。 '+eventDescription(event));
        const voice=response.voiceState;
        voiceStatus.textContent=response.listening?'眼镜口令：'+({buffering:'等待音轨',quiet:'已收到音轨，未检测到明显说话声',recognizing:'正在本机识别，请稍候',waiting:'等待下一条短口令',stopped:'已停止'})[voice?.phase]+'。'+(voice?.lastRecognitionMs?'上次识别用时 '+(voice.lastRecognitionMs/1000).toFixed(1)+' 秒。':'')+(voice?.droppedAudioSeconds>0?'电脑处理较慢，累计跳过约 '+Math.ceil(voice.droppedAudioSeconds)+' 秒音频，可能漏听口令。':''):'本次未在监听口令。';
        if(feedbackRecord!==record.id){feedbackRecord=record.id;feedbackCount=record.events.length;}
        else{if(ownedRecord===record.id)feedback(record.events.slice(feedbackCount));feedbackCount=record.events.length;}
        const rendered=record.id+record.events.length+record.status;
        if(lastRendered!==rendered){
          lastRendered=rendered;
          element('hf-events').replaceChildren(...record.events.slice(-60).reverse().map(item=>{const paragraph=document.createElement('p');paragraph.textContent=new Date(item.at).toLocaleTimeString()+' · '+(({note:'口令标记（待复核）',start:'开始',stop:'结束',photo:'照片',pause:'暂停',resume:'继续',feedback:'提示'})[item.kind]||item.kind)+' · '+eventDescription(item);return paragraph;}));
          element('hf-photos').replaceChildren(...record.frames.slice(-12).reverse().map(item=>{const button=document.createElement('button');button.className='secondary';button.textContent=new Date(item.at).toLocaleTimeString()+' · 查看照片';button.onclick=()=>void safe(async()=>{const imageBlob=await api('/api/handsfree/photo',{id:record.id,frameId:item.id},{responseType:'blob'}),url=URL.createObjectURL(imageBlob),image=document.createElement('img');image.src=url;image.alt='眼镜过程照片，待人工复核';image.style.maxWidth='100%';image.onload=()=>URL.revokeObjectURL(url);button.replaceWith(image);});return button;}));
        }
      }else{element('hf-events').replaceChildren();element('hf-photos').replaceChildren();voiceStatus.textContent='';liveStatus(selected?'正在读取选中的本机记录…':'当前实验还没有本机免手动记录。');}
    }catch(error){if(revision===selectionRevision&&token===getState().token)liveStatus(error.message);}finally{polling=false;availability();}
  }
  element('hf-start').onclick=()=>void safe(async()=>{
    if(snapshot?.error&&!confirm('上次本机写入失败，最新变更可能尚未写入磁盘。请先导出完整照片与时间线并核对副本。开始新记录会替换内存中的上一份记录。确认已保存需要的资料并继续吗？'))return;
    busy=true;availability();const current=getState(),revision=++selectionRevision;
    if(element('hf-feedback').checked)await player.prepare();
    if(revision!==selectionRevision||current.token!==getState().token)return;
    const response=await api('/api/handsfree/start',{deviceId:current.selectedDevice,imageConsent:element('hf-image-consent').checked,voice:element('hf-voice').checked,audioConsent:element('hf-audio-consent').checked,interval:Number(element('hf-interval').value),language:element('hf-language').value});
    if(revision!==selectionRevision||current.token!==getState().token)return;snapshot=response;storageIssue(response.error);selected=snapshot.record.id;ownedRecord=selected;feedbackRecord=null;
    if(!element('hf-image-consent').checked||snapshot.record.voice&&!element('hf-audio-consent').checked){await stopRecord(selected);status('授权已撤回，记录已停止。');return;}
    if(!['recording','paused'].includes(snapshot.record.status)){await load();status('记录未持续开启，请查看连接状态和时间线。');return;}liveStatus('本次免手动记录已开启，正在保留过程资料。');await load();if(revision===selectionRevision&&current.token===getState().token&&snapshot?.record?.status==='recording')feedback({kind:'start'});
  });
  async function stopRecord(id=selected){busy=true;availability();const token=getState().token,revision=++selectionRevision,response=await api('/api/handsfree/stop',{id});if(revision!==selectionRevision||token!==getState().token)return;snapshot=response;storageIssue(response.error);feedbackRecord=response.record?.id||null;feedbackCount=response.record?.events.length||0;liveStatus('本次记录已停止，照片与时间线可复核保存。');await load();if(revision===selectionRevision&&token===getState().token)feedback({kind:'stop'});}
  element('hf-stop').onclick=()=>void safe(()=>stopRecord());
  element('hf-history').onchange=()=>{selected=element('hf-history').value;selectionRevision++;feedbackRecord=null;lastRendered='';player.cancel();clearGroups();void load();};
  element('hf-export').onclick=()=>void safe(async()=>{busy=true;const blob=await api('/api/handsfree/export',{id:selected},{responseType:'blob'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='镜析-免手动实验记录-'+selected+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});
  element('hf-delete').onclick=()=>void safe(async()=>{if(!confirm('请确认已导出需要的资料。删除会移除所选本机照片和时间线，继续吗？'))return;busy=true;await api('/api/handsfree/delete',{id:selected,confirm:true});selected=null;lastRendered='';await load();});
  summary.onclick=()=>void safe(async()=>{const record=snapshot?.record;if(!record||['recording','paused'].includes(record.status))throw new Error('请先结束记录。');busy=true;availability();const text=['【免手动实验记录：需人工复核】',record.entryTitle,'会话：'+record.id,'照片 '+record.frames.length+' 张；以下为最近 40 条时间线，完整资料请导出 ZIP。',...record.events.slice(-40).map(event=>event.at+' · '+event.kind+' · '+event.text.slice(0,180)),'照片与口令不证明操作已完成，实验数值和术语需核对。'].join('\n').slice(0,11500);await transfer({type:'transcript',captureId:record.id,capturedAt:new Date().toISOString(),source:'免手动实验时间线（待人工复核）',text});status('主页面已确认接收时间线，实验后仍需核对并确认保存。');});
  for(const id of ['hf-image-consent','hf-voice','hf-audio-consent'])element(id).onchange=()=>{if(id==='hf-audio-consent'&&!element(id).checked&&testRunning)void cancelVoiceTest();const record=snapshot?.record;if(['recording','paused'].includes(record?.status)&&(!element('hf-image-consent').checked||record.voice&&!element('hf-audio-consent').checked))void safe(async()=>{await stopRecord(record.id);status('授权已撤回，免手动记录已停止。');});availability();};
  element('hf-feedback').onchange=()=>{player.setEnabled(element('hf-feedback').checked);availability();};setInterval(()=>void load(),2000);availability();
  return {availability,isBusy:()=>busy,isRecording:()=>['recording','paused'].includes(snapshot?.record?.status),isBusyAudio:()=>testRunning||Boolean(snapshot?.listening),connectionLost(reason){
    const wasOwner=ownedRecord===snapshot?.record?.id&&['recording','paused'].includes(snapshot?.record?.status);testController?.abort();selectionRevision++;ownedRecord=null;feedbackRecord=null;feedbackCount=0;lastToken=getState().token;player.cancel();
    clearGroups();snapshot=null;selected=null;lastRendered='';element('hf-history').replaceChildren();element('hf-history').dataset.signature='';element('hf-events').replaceChildren();element('hf-photos').replaceChildren();voiceStatus.textContent='本窗口已停用口令监听。';liveStatus(reason);if(wasOwner&&/连接.*断开/.test(reason))player.connectionLost();availability();
  }};
}
