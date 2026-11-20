import {check,base64,unbase64,encoder} from './common.mjs';

const iterations=310000;
export async function deriveKey(password,salt){
  check(typeof password==='string'&&password.length>=12&&password.length<=128,'加密密码需为 12–128 个字符，不会发送给服务器。');
  check(salt instanceof Uint8Array&&salt.length===16,'加密盐无效。');
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations,salt},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function header(salt,purpose){return {schema:'colorlens-sealed-1',algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations,salt:base64(salt),purpose};}
export async function encryptBytes(bytes,key,salt,purpose){
  check(bytes instanceof Uint8Array&&typeof purpose==='string'&&purpose.length<=100,'加密资料无效。');
  const metadata=header(salt,purpose),iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(metadata))},key,bytes));
  return {...metadata,iv:base64(iv),cipher:base64(cipher)};
}
export async function decryptBytes(envelope,password,purpose,maximum=256*1048576){
  check(envelope?.schema==='colorlens-sealed-1'&&envelope.algorithm==='AES-256-GCM'&&envelope.kdf==='PBKDF2-SHA256'&&envelope.iterations===iterations&&envelope.purpose===purpose,'不是支持的加密资料格式或用途。');
  for(const value of [envelope.salt,envelope.iv,envelope.cipher])check(typeof value==='string'&&value.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(value),'加密资料编码无效。');
  check(envelope.cipher.length<=Math.ceil((maximum+16)/3)*4,'加密资料超过本次大小限制。');const salt=unbase64(envelope.salt),iv=unbase64(envelope.iv);check(salt.length===16&&iv.length===12,'加密参数无效。');
  const key=await deriveKey(password,salt);
  try{const bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(header(salt,purpose)))},key,unbase64(envelope.cipher)));check(bytes.length<=maximum,'解密资料过大。');return {bytes,key,salt};}
  catch{throw new Error('密码错误或加密资料已损坏；没有清除或覆盖原资料。');}
}
export async function sealBytes(bytes,password,purpose){const salt=crypto.getRandomValues(new Uint8Array(16)),key=await deriveKey(password,salt);return encryptBytes(bytes,key,salt,purpose);}
