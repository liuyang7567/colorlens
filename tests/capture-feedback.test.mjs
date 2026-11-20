import test from 'node:test';
import assert from 'node:assert/strict';
import {captureFeedbackCue,createCaptureFeedback} from '../web/capture-feedback.mjs';

function fixture(t,options={}){
  let now=Date.now(),allowed=true;const reports=[],spoken=[],nodes=[],contexts=[];
  class Utterance{constructor(text){this.text=text;}}
  const synthesis={cancelled:0,getVoices:()=>[{localService:true,lang:'zh-CN'},{localService:true,lang:'en-US'}],speak(value){spoken.push(value);},cancel(){this.cancelled++;}};
  const createAudio=()=>{const context={state:'suspended',currentTime:0,destination:{},resume:async()=>{context.state='running';},close:async()=>{context.state='closed';},createOscillator(){const node={frequency:{},connect(){},start(){this.started=true;},stop(){this.stops=(this.stops||0)+1;},disconnect(){this.disconnections=(this.disconnections||0)+1;}};nodes.push(node);return node;},createGain(){const node={gain:{},connect(){},disconnect(){this.disconnections=(this.disconnections||0)+1;}};nodes.push(node);return node;}};contexts.push(context);return context;};
  const player=createCaptureFeedback({createAudio,synthesis,Utterance,clock:()=>now,canNotify:()=>allowed,report:value=>reports.push(value),...options});t.after(()=>player.dispose());
  return {player,synthesis,spoken,nodes,contexts,reports,advance:ms=>{now+=ms;},allow:value=>{allowed=value;}};
}
test('feedback describes results without reading private notes or automatic photos',()=>{
  const at=new Date().toISOString(),secret='PRIVATE specimen name';
  assert.equal(captureFeedbackCue([{kind:'photo',at,text:'已保留一张自动照片。'}]),null);
  const cue=captureFeedbackCue([{kind:'note',at,text:secret},{kind:'photo',at,text:'语音照片已保存'}]);assert.match(cue.text,/照片和标记/);assert.ok(!cue.text.includes(secret));
  assert.match(captureFeedbackCue([{kind:'feedback',at,text:'自动照片未保留：遮挡'}]).text,/质量不足/);
  assert.match(captureFeedbackCue([{kind:'feedback',at,text:'正在保存上一张照片'}]).text,/稍候/);
});
test('old acknowledgements are silent and a stop supersedes other events',()=>{
  const now=Date.now(),old=new Date(now-13000).toISOString();
  assert.equal(captureFeedbackCue([{kind:'note',at:old}], 'zh',now),null);
  assert.equal(captureFeedbackCue([{kind:'note',at:'invalid'}], 'zh',now),null);
  assert.equal(captureFeedbackCue([{kind:'note',at:new Date(now+6000).toISOString()}], 'zh',now),null);
  assert.match(captureFeedbackCue([{kind:'stop',at:old},{kind:'note'}],'en',now).text,/Recording stopped/);
  assert.match(captureFeedbackCue([{kind:'pause'},{kind:'resume'}]).text,/已继续/);
});
test('preview uses only a matching local voice and does not need capture authorization',async t=>{
  const f=fixture(t,{language:()=> 'en'});f.allow(false);f.synthesis.getVoices=()=>[{localService:false,lang:'en-US'},{localService:true,lang:'zh-CN'},{localService:true,lang:'en-GB'}];
  assert.equal(await f.player.preview(),true);assert.equal(f.spoken.length,1);assert.match(f.spoken[0].text,/Computer feedback/);assert.equal(f.spoken[0].voice.lang,'en-GB');assert.equal(f.player.notify([{kind:'note'}]),false);
});
test('remote-only voices fall back to a short local tone',async t=>{
  const f=fixture(t);f.synthesis.getVoices=()=>[{localService:false,lang:'zh-CN'}];assert.equal(await f.player.preview(),true);assert.equal(f.spoken.length,0);assert.equal(f.nodes.length,2);assert.match(f.reports.at(-1),/没有可用.*本机语音/);
});
test('audio creation and resume failures do not reject record preparation',async t=>{
  const f=fixture(t,{createAudio:()=>{throw new Error('blocked');}});assert.equal(await f.player.prepare(),false);assert.equal(f.player.notify([{kind:'start'}]),true);assert.match(f.spoken[0].text,/已开始/);assert.match(f.reports[0],/记录仍可继续/);
  let closed=false;const g=fixture(t,{createAudio:()=>({state:'suspended',resume:()=>Promise.reject(new Error('denied')),close:()=>{closed=true;}})});assert.equal(await g.player.prepare(),false);assert.equal(closed,true);
});
test('unresolved audio preparation is bounded and cancellation cannot revive it',async t=>{
  let finish,closed=0;const context={state:'suspended',resume:()=>new Promise(resolve=>{finish=()=>{context.state='running';resolve();};}),close:()=>{closed++;context.state='closed';}};
  const f=fixture(t,{createAudio:()=>context,prepareTimeoutMs:20});const pending=f.player.preview();f.player.cancel();finish();assert.equal(await pending,false);assert.equal(f.spoken.length,0);assert.equal(closed,1);
  const g=fixture(t,{createAudio:()=>({state:'suspended',resume:()=>new Promise(()=>{}),close(){}}),prepareTimeoutMs:20});assert.equal(await g.player.prepare(),false);
});
test('concurrent preparation shares one context and tones release both audio nodes',async t=>{
  const f=fixture(t);const a=f.player.prepare(),b=f.player.prepare();assert.equal(a,b);assert.equal(await a,true);assert.equal(f.contexts.length,1);assert.equal(f.player.prompt(),true);assert.equal(f.nodes.length,2);f.nodes[0].onended();assert.deepEqual(f.nodes.map(node=>node.disconnections),[1,1]);f.player.cancel();assert.deepEqual(f.nodes.map(node=>node.disconnections),[1,1]);
});
test('queue is bounded and a stop immediately cancels obsolete acknowledgements',t=>{
  const f=fixture(t);f.player.notify([{kind:'note'}]);const oldEnd=f.spoken[0].onend;
  for(let count=0;count<8;count++)f.player.notify([{kind:'photo',text:'语音照片已保存'}]);assert.equal(f.spoken.length,1);
  f.spoken[0].onend();assert.equal(f.spoken.length,2);f.spoken[1].onend();assert.equal(f.spoken.length,3);f.spoken[2].onend();assert.equal(f.spoken.length,3);
  f.player.notify([{kind:'note'}]);f.player.notify([{kind:'photo',text:'语音照片已保存'}]);f.player.notify([{kind:'stop'}]);assert.match(f.spoken.at(-1).text,/已停止/);const count=f.spoken.length;oldEnd();assert.equal(f.spoken.length,count);f.spoken.at(-1).onend();assert.equal(f.spoken.length,count);
});
test('queued stale acknowledgements and authorization withdrawal are silent',t=>{
  const f=fixture(t);f.player.notify([{kind:'note'}]);f.player.notify([{kind:'photo',text:'语音照片已保存'}]);f.advance(13000);f.spoken[0].onend();assert.equal(f.spoken.length,1);
  f.player.notify([{kind:'note'}]);f.player.notify([{kind:'note'}]);f.allow(false);f.spoken.at(-1).onend();assert.equal(f.spoken.length,2);assert.equal(f.player.notify([{kind:'start'}]),false);
});
test('speech errors and a stalled local voice fall back without blocking',async t=>{
  const f=fixture(t,{speechTimeoutMs:20});await f.player.prepare();f.player.notify([{kind:'start'}]);f.spoken[0].onerror();assert.equal(f.nodes.length,2);assert.match(f.reports.at(-1),/改用电脑短提示/);
  f.advance(200);f.player.notify([{kind:'note'}]);await new Promise(resolve=>setTimeout(resolve,45));assert.equal(f.spoken.at(-1).onend,null);assert.equal(f.nodes.length,4);assert.match(f.reports.at(-1),/改用电脑短提示/);
});
test('synchronous speech failure leaves no stale current utterance',async t=>{
  const f=fixture(t);await f.player.prepare();f.synthesis.speak=()=>{throw new Error('unavailable');};assert.equal(f.player.notify([{kind:'start'}]),true);assert.match(f.reports.at(-1),/改用电脑短提示/);f.synthesis.speak=value=>f.spoken.push(value);f.player.notify([{kind:'note'}]);assert.equal(f.spoken.length,1);
});
test('disabling feedback stops tones and speech; disposal cannot be re-enabled',async t=>{
  const f=fixture(t);await f.player.prepare();f.player.prompt();f.player.notify([{kind:'note'}]);f.player.setEnabled(false);assert.ok(f.synthesis.cancelled>0);assert.deepEqual(f.nodes.map(node=>node.disconnections),[1,1]);assert.equal(f.contexts[0].state,'closed');assert.equal(await f.player.preview(),false);f.player.setEnabled(true);assert.equal(await f.player.prepare(),true);f.player.dispose();f.player.setEnabled(true);assert.equal(await f.player.prepare(),false);assert.equal(f.player.notify([{kind:'start'}]),false);assert.equal(await f.player.preview(),false);
});
test('connection warning does not claim that remote recording has stopped',t=>{
  const f=fixture(t);f.allow(false);assert.equal(f.player.connectionLost(),true);assert.match(f.spoken[0].text,/连接已断开/);assert.ok(!f.spoken[0].text.includes('记录已停止'));
});
