const C='mashhad-v3',A=['./','index.html','css/app.css','js/app.js','js/db.js','fonts/Cairo-Variable.woff2','icons/icon.svg','icons/icon-192.png','icons/icon-512.png','manifest.json','sample/sample.webm'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});
