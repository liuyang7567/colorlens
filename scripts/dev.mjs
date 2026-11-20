import {createServer} from 'node:http';
import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {Readable} from 'node:stream';
import {parseEnv} from 'node:util';
import path from 'node:path';
import worker from '../src/worker.mjs';
import {localDatabase} from './local-db.mjs';
const root=path.resolve(import.meta.dirname,'..');
mkdirSync(path.join(root,'.local'),{recursive:true});
const configuration=process.env.COLORLENS_ENV_FILE;
if(configuration)process.loadEnvFile(configuration);
const env={DB:localDatabase(path.join(root,'.local','preview.sqlite3')),AUTH_PEPPER:process.env.AUTH_PEPPER,BOOTSTRAP_KEY:process.env.BOOTSTRAP_KEY,DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY,DEEPSEEK_MODEL:process.env.DEEPSEEK_MODEL||'deepseek-flash'};
if(process.env.COLORLENS_AI_SOURCE){const source=parseEnv(readFileSync(process.env.COLORLENS_AI_SOURCE,'utf8'));env.DEEPSEEK_API_KEY=source.DEEPSEEK_API_KEY;}
if(!env.AUTH_PEPPER||!env.BOOTSTRAP_KEY)throw new Error('Configure AUTH_PEPPER and BOOTSTRAP_KEY in a private environment file.');
const types={'.html':'text/html;charset=utf-8','.js':'application/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
env.ASSETS={async fetch(request){let relative=decodeURIComponent(new URL(request.url).pathname);if(relative==='/')relative='/index.html';if(['/share','/report','/download'].includes(relative))relative+='.html';const filename=path.resolve(root,'dist','pages','.'+relative);if(!filename.startsWith(path.join(root,'dist','pages')+path.sep)||relative.includes('_worker')||!existsSync(filename))return new Response('Not found',{status:404});return new Response(readFileSync(filename),{headers:{'Content-Type':types[path.extname(filename)]||'application/octet-stream'}});}};
const port=Number(process.env.PORT||64829);
const server=createServer(async(incoming,outgoing)=>{
  try{const chunks=[];for await(const chunk of incoming)chunks.push(chunk);const request=new Request(`http://127.0.0.1:${port}${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Buffer.concat(chunks)})});const response=await worker.fetch(request,env,{waitUntil:promise=>promise.catch(()=>{})});outgoing.writeHead(response.status,Object.fromEntries(response.headers));if(!response.body)return outgoing.end();Readable.fromWeb(response.body).pipe(outgoing);}
  catch{outgoing.writeHead(500);outgoing.end('Local preview error');}
});
server.listen(port,'127.0.0.1',()=>console.log('ColorLens isolated preview http://127.0.0.1:'+port));
process.on('SIGTERM',()=>server.close(()=>{env.DB.close();process.exit(0);}));
