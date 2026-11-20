import {createServer} from 'node:http';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import path from 'node:path';
import worker from '../src/worker.mjs';
import {hashPassword} from '../src/auth.mjs';
import {uid,now} from '../src/common.mjs';
import {create} from '../src/notebook.mjs';
import {localDatabase} from './local-db.mjs';
import {CaptureEngine} from './capture/engine.mjs';
import {createCaptureGateway} from './capture/gateway.mjs';
import {allowFirewall} from './capture/firewall.mjs';

const root=path.resolve(import.meta.dirname,'..');
const state=process.env.COLORLENS_PREVIEW_STATE||path.join(root,'.local','capture-preview');
const runtime=process.env.COLORLENS_RUNTIME||path.join(root,'runtime');
const port=Number(process.env.COLORLENS_PREVIEW_PORT||49185),capturePort=Number(process.env.COLORLENS_CAPTURE_PORT||49186);
if(!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(capturePort)||capturePort<1024||capturePort>65535||port===capturePort)throw new Error('Invalid preview ports.');
const origin='http://127.0.0.1:'+port;
mkdirSync(state,{recursive:true});
const settingsFile=path.join(state,'settings.json');
if(!existsSync(settingsFile))writeFileSync(settingsFile,JSON.stringify({pepper:randomBytes(32).toString('hex'),bootstrap:randomBytes(32).toString('hex'),demoPassword:randomBytes(12).toString('hex')}),{mode:0o600,flag:'wx'});
const settings=JSON.parse(readFileSync(settingsFile,'utf8'));
const keyFile=path.join(state,'deepseek.dpapi');
const keyScript=path.join(root,'scripts','capture','key-store.ps1');
if(process.env.COLORLENS_AI_SOURCE&&!existsSync(keyFile)){
  const selected=parseEnv(readFileSync(process.env.COLORLENS_AI_SOURCE,'utf8')).DEEPSEEK_API_KEY;
  if(selected){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',keyScript,'-Operation','protect','-Path',keyFile],{input:selected,encoding:'utf8',windowsHide:true,timeout:10000});if(result.status!==0)throw new Error('Cannot protect the selected AI key for this Windows account.');}
}
let aiKey=process.env.DEEPSEEK_API_KEY||'';
if(!aiKey&&existsSync(keyFile)){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',keyScript,'-Operation','read','-Path',keyFile],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(result.status===0)aiKey=result.stdout.trim();
}
const env={DB:localDatabase(path.join(state,'preview.sqlite3')),AUTH_PEPPER:settings.pepper,BOOTSTRAP_KEY:settings.bootstrap,DEEPSEEK_API_KEY:aiKey,DEEPSEEK_MODEL:'deepseek-flash'};
env.DB.raw.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const seeded=env.DB.raw.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if(!seeded){
  for(const [index,email] of ['capture-a@example.test','capture-b@example.test'].entries()){
    const user={id:uid()};
    await env.DB.prepare('INSERT INTO users(id,username,password,role,created_at,display_name,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?)').bind(user.id,uid(),await hashPassword(settings.demoPassword,env.AUTH_PEPPER),index===0?'admin':'member',now(),'模拟实验员',email,now()).run();
    await create(env,user,{title:index===0?'SIMULATED · 实验操作指导验收':'SIMULATED · 另一账号的独立记录',body:'本记录仅用于独立测试，不含私人实验资料。\n\n在这里记录观察，再插入眼镜截图或离线转写。',tags:['模拟数据','V0.10验收']});
  }
}
const types={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'application/javascript;charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.txt':'text/plain;charset=utf-8'};
env.ASSETS={async fetch(request){
  let relative=decodeURIComponent(new URL(request.url).pathname);if(relative==='/')relative='/index.html';if(['/share','/report','/download'].includes(relative))relative+='.html';
  const filename=path.resolve(root,'dist','pages','.'+relative);
  if(!filename.startsWith(path.join(root,'dist','pages')+path.sep)||relative.includes('_worker')||!existsSync(filename))return new Response('Not found',{status:404});
  let bytes=readFileSync(filename);
  if(relative==='/index.html')bytes=Buffer.from(bytes.toString('utf8').replace('</head>','<link rel="stylesheet" href="/preview-v05.css"><script src="/preview-v05.js" defer></script></head>').replace('<body>','<body><aside class="preview-v05-banner">V0.10 独立本机验收版 · 不连接正式实验库 · 测试邮箱 capture-a@example.test / capture-b@example.test · 首次生成的登录密码见本地 settings.json。请勿保存私人资料。</aside>'));
  return new Response(bytes,{headers:{'Content-Type':types[path.extname(filename)]||'application/octet-stream'}});
}};
const engine=new CaptureEngine({runtime,state:path.join(state,'capture'),allowFirewall});
const gateway=createCaptureGateway({root,engine,allowedOrigins:[origin]});
const shutdown=process.env.COLORLENS_SHUTDOWN_TOKEN||randomBytes(32).toString('hex');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await engine.unbind();gateway.closeAllConnections();gateway.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));env.DB.close();process.exit(0);}
const server=createServer(async(incoming,outgoing)=>{
  try{
    if(incoming.headers.host!==new URL(origin).host||incoming.socket.remoteAddress!=='127.0.0.1'){outgoing.writeHead(421);outgoing.end();return;}
    if(incoming.url==='/__preview/status'&&incoming.method==='GET'){outgoing.setHeader('Content-Type','application/json');outgoing.setHeader('Cache-Control','no-store');outgoing.end(JSON.stringify({version:'0.10.0-preview.19',isolated:true,aiConfigured:Boolean(aiKey),capturePort,instance:createHash('sha256').update(shutdown).digest('hex')}));return;}
    if(incoming.url==='/__preview/stop'&&incoming.method==='POST'){
      const value=incoming.headers['x-preview-stop'];if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(shutdown))){outgoing.writeHead(403);outgoing.end();return;}outgoing.end('{}');void stop();return;
    }
    const chunks=[];let size=0;for await(const chunk of incoming){size+=chunk.length;if(size>2*1048576){outgoing.writeHead(413);outgoing.end();return;}chunks.push(chunk);}
    const request=new Request(origin+incoming.url,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Buffer.concat(chunks)})});
    const response=await worker.fetch(request,env,{waitUntil:promise=>promise.catch(()=>{})});
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)Readable.fromWeb(response.body).pipe(outgoing);else outgoing.end();
  }catch{if(!outgoing.headersSent)outgoing.writeHead(500);outgoing.end('本机验收服务暂时无法处理请求。');}
});
const listen=(service,number)=>new Promise((resolve,reject)=>{service.once('error',reject);service.listen(number,'127.0.0.1',resolve);});
try{await listen(server,port);await listen(gateway,capturePort);}catch(error){server.close();gateway.close();env.DB.close();throw new Error('Preview ports are occupied; no existing process was stopped. '+error.code);}
if(process.env.COLORLENS_PARENT_PID){const parent=Number(process.env.COLORLENS_PARENT_PID);setInterval(()=>{try{process.kill(parent,0);}catch{void stop();}},1500).unref();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
console.log('ColorLens V0.10 isolated preview ready: '+origin+'/#glasses; AI configured: '+Boolean(aiKey));
