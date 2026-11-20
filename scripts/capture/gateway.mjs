import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {voiceCommand} from './handsfree.mjs';
import {WebSocketServer} from 'ws';

export const gatewayHeaders = {
  'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'",
};
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
async function body(request, maximum = 131072) {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maximum) throw new Error('请求过大。'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export function createCaptureGateway({ root, engine, allowedOrigins, verify = fetch,clock=Date.now,heartbeatMs=15000,authenticationMs=5000 }) {
  const csrf = randomBytes(32).toString('hex');
  const sessions = new Map(), resources = new Map(), speech = new Map(),leases=new Map();
  const sockets=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
  let pairing=Promise.resolve();
  const serializePair=operation=>{const result=pairing.then(operation);pairing=result.catch(()=>{});return result;};
  async function retire(token,reason,{stopMedia=true}={}){
    const session=sessions.get(token);if(!session)return;sessions.delete(token);
    const lease=leases.get(token);if(lease){leases.delete(token);clearInterval(lease.timer);lease.socket.terminate();}
    const job=speech.get(token);job?.controller.abort();
    if(engine.handsfree?.nonce===session.claims.nonce)await engine.handsfree.stop(reason);
    if(job)await job.done;
    for(const [identifier,resource] of resources)if(resource.token===token){resources.delete(identifier);await engine.closeOffer(resource.location);}
    if(stopMedia&&!sessions.size)await serializePair(async()=>{if(!sessions.size)await engine.unbind();});
  }
  const files = new Map([
    ['/', ['scripts/capture/web/capture.html', 'text/html; charset=utf-8']],
    ['/capture.html', ['scripts/capture/web/capture.html', 'text/html; charset=utf-8']],
    ['/capture.js', ['scripts/capture/web/capture.js', 'text/javascript; charset=utf-8']],
    ['/capture.css', ['scripts/capture/web/capture.css', 'text/css; charset=utf-8']],
    ['/handsfree.js', ['scripts/capture/web/handsfree.js', 'text/javascript; charset=utf-8']],
    ['/capture-bridge.mjs', ['web/capture-bridge.mjs', 'text/javascript; charset=utf-8']],
    ['/capture-receipts.mjs', ['web/capture-receipts.mjs', 'text/javascript; charset=utf-8']],
    ['/capture-drafts.mjs', ['web/capture-drafts.mjs', 'text/javascript; charset=utf-8']],
    ['/capture-feedback.mjs', ['web/capture-feedback.mjs', 'text/javascript; charset=utf-8']],
  ]);
  const server = createServer(async (request, response) => {
    const listening=server.address();if(!listening){response.writeHead(503);response.end();return;}
    const origin = `http://127.0.0.1:${listening.port}`;
    let status = 200, type = 'application/json; charset=utf-8', content;
    try {
      if (request.headers.host !== new URL(origin).host || request.socket.remoteAddress !== '127.0.0.1') { status = 421; throw new Error('仅允许本机回环访问。'); }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && files.has(url.pathname)) {
        const [filename, contentType] = files.get(url.pathname);
        type = contentType; content = readFileSync(path.join(root, filename));
      } else if (request.method === 'GET' && url.pathname === '/api/config') {
        content = { version: '0.10.0-preview.19', csrf, allowedOrigins, maximumDevices: 3,connectionLease:'websocket' };
      } else {
        if (!['POST', 'DELETE'].includes(request.method)) { status = 405; throw new Error('请求方式不支持。'); }
        if (request.headers.origin !== origin || !same(request.headers['x-capture-csrf'], csrf)) { status = 403; throw new Error('本机来源或安全校验失败。'); }
        if (url.pathname === '/api/pair' && request.method === 'POST') {
          const payload = JSON.parse(await body(request));
          if (!allowedOrigins.includes(payload.issuer) || !/^[a-f0-9]{64}$/.test(payload.nonce || '') || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(payload.clientId||'') || typeof payload.ticket !== 'string' || payload.ticket.length > 4096) { status = 403; throw new Error('不允许的镜析来源或采集凭据。'); }
          const result = await verify(payload.issuer + '/api/capture/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: payload.issuer }, body: JSON.stringify({ ticket: payload.ticket, nonce: payload.nonce }), redirect: 'error', signal: AbortSignal.timeout(10000) });
          if (!result.ok) { status = 403; throw new Error('镜析账号配对失败或已过期，请返回镜析重新打开。'); }
          const claims = await result.json();
          if (!/^[a-f0-9]{32}$/.test(claims.user_id) || !/^[a-f0-9]{32}$/.test(claims.entry_id) || claims.nonce !== payload.nonce || claims.issuer !== payload.issuer || !Number.isSafeInteger(claims.expires_at) || claims.expires_at <= clock() || claims.expires_at > clock() + 11 * 60 * 1000) { status = 403; throw new Error('采集授权格式不正确。'); }
          content=await serializePair(async()=>{
          if(claims.expires_at<=clock())throw new Error('采集授权已到期，请重新打开。');
          const previous = [...sessions].find(([, item]) => item.claims.nonce === claims.nonce && item.claims.user_id === claims.user_id && item.claims.entry_id === claims.entry_id && item.claims.issuer === claims.issuer);
          if(!previous&&sessions.size>=8)throw new Error('配对窗口过多，请先关闭已有采集窗口。');
          const replaced=previous&&previous[1].clientId!==payload.clientId;
          if(replaced)await retire(previous[0],'采集页面已刷新，记录已停止；请重新确认开始。',{stopMedia:false});
          engine.bind(claims);
          const token = previous&&!replaced?previous[0]:randomBytes(32).toString('hex');
          if(previous&&!replaced){previous[1].claims=claims;previous[1].lastSeen=clock();}
          else sessions.set(token, {claims,clientId:payload.clientId,lastSeen:clock()});
          return { token, userId: claims.user_id, entryId: claims.entry_id, entryTitle: claims.entry_title, expiresAt: claims.expires_at };
          });
        } else {
          const token = request.headers['x-capture-session'];
          const session = sessions.get(token);
          if (!session || session.claims.expires_at <= clock() || session.claims.user_id !== engine.owner) { status = 403; throw new Error('本次本机采集授权已失效，请重新配对。'); }
          session.lastSeen = clock();
          if(['/api/start','/api/handsfree/start','/api/transcribe'].includes(url.pathname)&&!leases.has(token))throw new Error('采集页面的持续连接尚未建立，请重新打开本机采集窗口。');
          if(url.pathname.startsWith('/api/handsfree/')&&request.method==='POST'){
            if(!engine.handsfree)throw new Error('当前助手不支持免手动记录。');const payload=JSON.parse(await body(request));
            if(url.pathname==='/api/handsfree/start')content=await engine.handsfree.start(session.claims,payload);
            else if(url.pathname==='/api/handsfree/state')content=engine.handsfree.status(session.claims,payload.id);
            else if(url.pathname==='/api/handsfree/stop'){engine.handsfree.read(session.claims,payload.id);if(payload.id!==engine.handsfree.active?.id)throw new Error('请选择当前正在记录的会话。');await engine.handsfree.stop();content=engine.handsfree.status(session.claims,payload.id);}
            else if(url.pathname==='/api/handsfree/export'){content=engine.handsfree.export(session.claims,payload.id);type='application/zip';}
            else if(url.pathname==='/api/handsfree/export-plan')content=engine.handsfree.exportPlan(session.claims,payload.id);
            else if(url.pathname==='/api/handsfree/export-part'){content=engine.handsfree.exportPart(session.claims,payload.id,payload.number);type='application/zip';}
            else if(url.pathname==='/api/handsfree/photo'){content=engine.handsfree.image(session.claims,payload.id,payload.frameId);type='image/jpeg';}
            else if(url.pathname==='/api/handsfree/delete'){if(payload.confirm!==true)throw new Error('请先确认删除本机记录。');engine.handsfree.remove(session.claims,payload.id);content=engine.handsfree.status(session.claims);}
            else{status=404;throw new Error('免手动接口不存在。');}
          }
          else if (url.pathname === '/api/state' && request.method === 'POST') content = engine.status();
          else if (url.pathname === '/api/start' && request.method === 'POST') { const payload = JSON.parse(await body(request)); await engine.start(payload.address); content = engine.status(); }
          else if (url.pathname === '/api/stop' && request.method === 'POST') { await engine.stop(); content = engine.status(); }
          else if (url.pathname === '/api/device' && request.method === 'POST') { const payload = JSON.parse(await body(request)); content = { id: engine.addDevice(payload.label) }; }
          else if (url.pathname === '/api/unbind' && request.method === 'POST') {await serializePair(async()=>{for(const current of [...sessions.keys()])await retire(current,'本机账号绑定已解除。',{stopMedia:false});await engine.unbind();});content = { unbound: true }; }
          else if (url.pathname === '/api/unpair' && request.method === 'POST') {
            await retire(token,'采集窗口已关闭。');
            content = { closed: true };
          } else if (url.pathname.startsWith('/api/whep/') && request.method === 'POST') {
            if([...resources.values()].filter(item=>item.token===token).length>=3)throw new Error('预览会话已达上限，请先关闭已有预览。');
            if (!String(request.headers['content-type']).startsWith('application/sdp')) throw new Error('媒体请求类型错误。');
            const sdp = await body(request, 65536);
            if (!sdp.startsWith('v=0')) throw new Error('媒体协商内容错误。');
            const offer = await engine.readOffer(url.pathname.split('/').at(-1), sdp);
            if(sessions.get(token)!==session){await engine.closeOffer(offer.location);throw new Error('采集配对已结束，预览未继续建立。');}
            const identifier = randomUUID(); resources.set(identifier, { token, location: offer.location });
            status = 201; type = 'application/sdp'; content = offer.sdp; response.setHeader('Location', '/api/whep-session/' + identifier);
          } else if (url.pathname.startsWith('/api/whep-session/') && request.method === 'DELETE') {
            const identifier = url.pathname.split('/').at(-1), resource = resources.get(identifier);
            if (!resource || resource.token !== token) { status = 404; throw new Error('媒体会话不存在。'); }
            resources.delete(identifier); await engine.closeOffer(resource.location); content = { closed: true };
          } else if(url.pathname==='/api/speech-state'&&request.method==='POST'){content=speech.has(token)?engine.speechProgress||{phase:'connecting'}:{phase:'idle'};
          } else if (url.pathname === '/api/transcribe' && request.method === 'POST') {
            if(speech.has(token))throw new Error('本窗口正在转写，请等待或先取消。');
            const payload = JSON.parse(await body(request));
            if (payload.consent !== true) throw new Error('请确认开始读取这段眼镜音频并进行本机离线转写。');
            if(payload.mode!==undefined&&!['command-test','dictation'].includes(payload.mode))throw new Error('语音处理模式无效。');
            const controller = new AbortController(); let finished;
            const done = new Promise((resolve) => { finished = resolve; });
            const job = { controller, done }; speech.set(token, job);
            response.on('close', () => { if (!response.writableEnded) controller.abort(); });
            try { content = await engine.transcribe(payload.deviceId, payload.language || 'zh', controller.signal,payload.mode==='command-test'?6:30);if(payload.mode==='command-test')content={...content,command:voiceCommand(content.text),testOnly:true}; }
            finally { if (speech.get(token) === job) speech.delete(token); finished(); }
          } else if (url.pathname === '/api/speech-cancel' && request.method === 'POST') { const job = speech.get(token); if (job) { job.controller.abort(); await job.done; } content = { cancelled: true }; }
          else { status = 404; throw new Error('本机接口不存在。'); }
        }
      }
    } catch (error) {
      if (status < 400) status = 400;
      type='application/json; charset=utf-8';content = { error: error instanceof SyntaxError ? '请求内容格式错误。' : String(error.message).slice(0, 300) };
    }
    if (!response.destroyed) { response.writeHead(status, { ...gatewayHeaders,'Content-Security-Policy':gatewayHeaders['Content-Security-Policy'].replace("connect-src 'self'",`connect-src 'self' ${origin.replace('http:','ws:')}`), 'Content-Type': type }); response.end(Buffer.isBuffer(content) || typeof content === 'string' ? content : JSON.stringify(content)); }
  });
  server.on('upgrade',(request,socket,head)=>{
    const address=server.address(),origin=address&&`http://127.0.0.1:${address.port}`;socket.on('error',()=>{});
    if(!origin||request.headers.host!==new URL(origin).host||request.socket.remoteAddress!=='127.0.0.1'||request.headers.origin!==origin||request.url!=='/api/connection'||sockets.clients.size>=16){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
    sockets.handleUpgrade(request,socket,head,connection=>{
      let token=null,lease=null;const deadline=setTimeout(()=>connection.terminate(),authenticationMs);connection.on('error',()=>{});
      connection.on('message',(bytes,binary)=>{
        if(token||binary){connection.close(1008,'Unsupported message');return;}
        try{
          const value=JSON.parse(bytes.toString('utf8')),session=sessions.get(value.token);
          if(Object.keys(value).some(key=>!['type','csrf','token','clientId'].includes(key))||value.type!=='authenticate'||!same(value.csrf,csrf)||!session||session.claims.expires_at<=clock()||session.claims.user_id!==engine.owner||session.clientId!==value.clientId||leases.has(value.token))throw new Error('Invalid connection');
          token=value.token;clearTimeout(deadline);lease={socket:connection,timer:null,alive:true};leases.set(token,lease);
          connection.on('pong',()=>{lease.alive=true;});lease.timer=setInterval(()=>{if(!lease.alive){connection.terminate();return;}lease.alive=false;connection.ping();},heartbeatMs);
          connection.send(JSON.stringify({type:'connected'}));
        }catch{connection.close(1008,'Connection rejected');}
      });
      connection.once('close',()=>{clearTimeout(deadline);if(lease)clearInterval(lease.timer);if(lease&&leases.get(token)===lease)void retire(token,'采集页面连接已断开，记录已停止；已保存资料保留。');});
    });
  });
  // HTTP shutdown does not close upgraded sockets; keep all owned connections bounded.
  const closeHTTP=server.close.bind(server),closeConnections=server.closeAllConnections.bind(server);let closing=false;
  server.closeAllConnections=()=>{for(const socket of sockets.clients)socket.terminate();closeConnections();};
  server.close=(...args)=>{if(!closing){closing=true;for(const socket of sockets.clients)socket.terminate();sockets.close();}return closeHTTP(...args);};
  const expiry = setInterval(() => {
    for (const [token, session] of sessions) if (session.claims.expires_at <= clock() || !leases.has(token)&&clock() - session.lastSeen > 120000)void retire(token,'本窗口授权或心跳已失效。');
    if (!sessions.size && engine.running && !engine.busy) void engine.stop();
  }, 1000);
  server.once('close', () => {clearInterval(expiry);for(const lease of leases.values())clearInterval(lease.timer);for (const job of speech.values()) job.controller.abort();void engine.stop();});
  return server;
}
