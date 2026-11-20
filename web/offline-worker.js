const cacheName='colorlens-offline-__COLORLENS_OFFLINE_VERSION__';
const assets=['/offline.html','/offline.css','/offline.js','/favicon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(assets.map(url=>new Request(url,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('colorlens-offline-')&&key!==cacheName).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  if(assets.includes(url.pathname))event.respondWith(caches.open(cacheName).then(async cache=>(await cache.match(url.pathname))||fetch(event.request)));
  else if(event.request.mode==='navigate'&&['/','/index.html'].includes(url.pathname))event.respondWith(fetch(event.request).catch(()=>caches.open(cacheName).then(cache=>cache.match('/offline.html'))));
});
