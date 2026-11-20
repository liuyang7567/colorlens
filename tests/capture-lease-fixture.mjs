import WebSocket from 'ws';
export function openCaptureConnection(origin,csrf,token,clientId,options={}){
  const socket=new WebSocket(origin.replace('http:','ws:')+'/api/connection',{headers:{Origin:options.origin??origin},autoPong:options.autoPong??true});
  return new Promise((resolve,reject)=>{
    let connected=false;const timer=setTimeout(()=>{socket.terminate();reject(new Error('Connection handshake timeout'));},5000);
    socket.on('open',()=>socket.send(JSON.stringify({type:'authenticate',csrf,token,clientId,...options.authentication})));
    socket.on('unexpected-response',(request,response)=>{clearTimeout(timer);response.resume();const error=new Error('Upgrade rejected');error.status=response.statusCode;reject(error);});
    socket.on('error',error=>{clearTimeout(timer);reject(error);});
    socket.on('close',code=>{clearTimeout(timer);if(!connected){const error=new Error('Authentication rejected');error.code=code;reject(error);}});
    socket.on('message',bytes=>{clearTimeout(timer);if(JSON.parse(bytes.toString()).type!=='connected'){socket.terminate();reject(new Error('Unexpected handshake'));return;}connected=true;resolve({socket,close:()=>new Promise(done=>{if(socket.readyState===WebSocket.CLOSED){done();return;}socket.once('close',done);socket.terminate();})});});
  });
}
