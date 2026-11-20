import {captureProtocol} from './capture-bridge.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export function createReceiptSender({nonce,post,timeoutMs=10000,maximum=4}){
  const pending=new Map();
  function finish(id,value,error){const item=pending.get(id);if(!item)return;pending.delete(id);clearTimeout(item.timer);error?item.reject(error):item.resolve(value);}
  return {
    send(message,transfers=[]){
      if(pending.size>=maximum)return Promise.reject(new Error('正在等待主页面确认，请稍候再传回。'));
      const id=crypto.randomUUID();return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>finish(id,null,new Error('主页面未确认收到，请检查主页面与目标实验后重试。尚未传回的内容仍保留在本窗口。')),timeoutMs);pending.set(id,{resolve,reject,timer});
        try{post({...message,id},transfers);}catch(error){finish(id,null,error);}
      });
    },
    receive(value){
      if(!value||value.protocol!==captureProtocol||value.nonce!==nonce||value.type!=='transfer-result'||!uuid(value.requestId)||typeof value.accepted!=='boolean'||typeof value.message!=='string'||value.message.length>300||Object.keys(value).some(key=>!['protocol','nonce','type','requestId','accepted','message'].includes(key)))return false;
      if(!pending.has(value.requestId))return false;finish(value.requestId,value,value.accepted?null:new Error(value.message||'主页面未接收，请核对后重试。'));return true;
    },
    cancel(reason='本次传回已取消，未确认内容仍保留。'){for(const id of [...pending.keys()])finish(id,null,new Error(reason));},
    get size(){return pending.size;}
  };
}
