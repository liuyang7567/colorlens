const phrases={
  zh:{ready:'电脑提示已就绪，请确认能听见。',start:'免手动记录已开始。',stop:'记录已停止，请复核保存。',pause:'留图已暂停，口令仍在监听。',resume:'留图已继续。',photo:'照片已保存，实验后请核对。',note:'标记已记录，实验后请核对。',both:'照片和标记已保存，实验后请核对。',quality:'画面质量不足，请调整镜头。',busy:'正在保存照片，请稍候。',connection:'采集连接已断开，请检查电脑上的记录状态。'},
  en:{ready:'Computer feedback is ready. Please check that you can hear it.',start:'Hands-free recording started.',stop:'Recording stopped. Please review and save.',pause:'Photos paused. Voice commands are still active.',resume:'Photos resumed.',photo:'Photo saved. Please review it later.',note:'Note recorded. Please review it later.',both:'Photo and note saved. Please review them later.',quality:'Image quality is low. Please adjust the camera.',busy:'Saving a photo. Please wait.',connection:'Capture connection lost. Please check the recording on your computer.'}
};
export function captureFeedbackCue(events,language='zh',now=Date.now()){
  if(!Array.isArray(events))return null;const labels=phrases[language==='en'?'en':'zh'];
  if(events.some(event=>event?.kind==='stop'))return {text:labels.stop,critical:true,at:now};
  const fresh=events.filter(event=>event&&(!event.at||Number.isFinite(Date.parse(event.at))&&now-Date.parse(event.at)>=-5000&&now-Date.parse(event.at)<=12000));
  const transition=fresh.findLast(event=>['start','pause','resume'].includes(event.kind));
  if(transition)return {text:labels[transition.kind],critical:transition.kind==='start',at:now};
  const photo=fresh.some(event=>event.kind==='photo'&&event.text?.startsWith('语音照片')),note=fresh.some(event=>event.kind==='note');
  if(photo||note)return {text:labels[photo&&note?'both':photo?'photo':'note'],critical:false,at:now};
  if(fresh.some(event=>event.kind==='feedback'&&event.text?.startsWith('自动照片未保留')))return {text:labels.quality,critical:false,at:now};
  if(fresh.some(event=>event.kind==='feedback'&&event.text?.includes('保存上一张照片')))return {text:labels.busy,critical:false,at:now};
  return null;
}

export function createCaptureFeedback({createAudio=()=>new globalThis.AudioContext(),synthesis=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance,language=()=> 'zh',canNotify=()=>true,report=()=>{},clock=Date.now,prepareTimeoutMs=1000,speechTimeoutMs=7000}={}){
  let enabled=true,disposed=false,audio=null,preparing=null,epoch=0,current=null,queue=[],lastBeep=-Infinity;
  const tones=new Set(),say=value=>{try{report(value);}catch{}};
  function closeAudio(){const previous=audio;audio=null;if(previous)try{Promise.resolve(previous.close()).catch(()=>{});}catch{}}
  function cancel(){epoch++;queue=[];if(current){clearTimeout(current.timer);current.utterance.onend=null;current.utterance.onerror=null;current=null;}try{synthesis?.cancel();}catch{}for(const tone of [...tones])tone.stop();if(preparing){preparing=null;closeAudio();}}
  function prepare(){
    if(!enabled||disposed)return Promise.resolve(false);if(preparing)return preparing;
    const generation=epoch;let context,timer;
    const task=(async()=>{try{context=audio;if(!context||context.state==='closed'){context=createAudio();audio=context;}await Promise.race([context.state==='running'?Promise.resolve():context.resume(),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Audio preparation timeout')),prepareTimeoutMs);})]);
      if(generation!==epoch||!enabled||disposed)return false;if(context.state!=='running')throw new Error('Audio context is not running');return true;
    }catch{if(audio===context)closeAudio();if(generation===epoch&&enabled&&!disposed)say('电脑短提示不可用，记录仍可继续；可试听或检查电脑声音设置。');return false;}finally{clearTimeout(timer);}})();
    preparing=task;void task.finally(()=>{if(preparing===task)preparing=null;});return task;
  }
  function prompt(frequency=700){
    if(!enabled||disposed||!audio||audio.state!=='running')return false;if(clock()-lastBeep<150)return true;lastBeep=clock();let oscillator,gain,done=false;
    const tone={stop(){if(done)return;done=true;tones.delete(tone);try{oscillator?.stop();}catch{}try{oscillator?.disconnect();}catch{}try{gain?.disconnect();}catch{}}};
    try{oscillator=audio.createOscillator();gain=audio.createGain();oscillator.frequency.value=frequency;gain.gain.value=0.05;oscillator.connect(gain);gain.connect(audio.destination);oscillator.onended=()=>tone.stop();tones.add(tone);oscillator.start();oscillator.stop(audio.currentTime+0.15);return true;}catch{tone.stop();return false;}
  }
  function finish(ticket,failed){if(current!==ticket)return;clearTimeout(ticket.timer);ticket.utterance.onend=null;ticket.utterance.onerror=null;current=null;if(failed){try{synthesis?.cancel();}catch{}const sounded=prompt();say(sounded?'本机语音未完成，已改用电脑短提示；以时间线为准。':'电脑声音提示不可用，记录不受影响；请查看状态和时间线。');}drain();}
  function drain(){
    if(current||!enabled||disposed)return;
    while(queue.length){const cue=queue.shift();if(clock()-cue.at>12000&&!cue.critical)continue;if(!cue.manual&&!canNotify()){cancel();return;}
      let voice;try{voice=synthesis?.getVoices().find(item=>item.localService===true&&new RegExp('^'+(language()==='en'?'en':'zh'),'i').test(item.lang));}catch{}
      if(!voice||!Utterance){const sounded=prompt();say(sounded?'已请求电脑短提示；没有可用的对应语言本机语音，请确认能听见。':'电脑声音提示不可用，记录不受影响；可先试听并检查声音设置。');continue;}
      try{const utterance=new Utterance(cue.text),ticket={utterance,timer:null};utterance.voice=voice;utterance.lang=voice.lang;utterance.rate=1;current=ticket;utterance.onend=()=>finish(ticket,false);utterance.onerror=()=>finish(ticket,true);ticket.timer=setTimeout(()=>finish(ticket,true),speechTimeoutMs);synthesis.speak(utterance);if(current===ticket)say('已请求电脑本机语音提示，请确认能听见；尚未接通眼镜扬声器。');return;}catch{const ticket=current;if(ticket)finish(ticket,true);else{prompt();say('电脑语音不可用，记录仍可继续。');}return;}
    }
  }
  function enqueue(cue){if(!enabled||disposed||!cue)return false;if(!cue.manual&&!canNotify())return false;if(cue.critical)cancel();if(queue.length>=2)queue.shift();queue.push(cue);drain();return true;}
  return {
    prepare,prompt,notify(events){return enqueue(captureFeedbackCue(events,language(),clock()));},
    connectionLost(){return enqueue({text:phrases[language()==='en'?'en':'zh'].connection,critical:true,manual:true,at:clock()});},
    async preview(){if(!enabled||disposed){say('请先勾选电脑声音提示，再试听。');return false;}cancel();const generation=epoch;await prepare();if(!enabled||disposed||generation!==epoch)return false;prompt(850);return enqueue({text:phrases[language()==='en'?'en':'zh'].ready,critical:false,manual:true,at:clock()});},
    setEnabled(value){enabled=Boolean(value);if(!enabled){cancel();closeAudio();say('电脑声音提示已关闭，记录不受影响。');}},
    cancel,dispose(){if(disposed)return;cancel();disposed=true;closeAudio();}
  };
}
