// Cache-first offline support (safe for GitHub Pages)
const CACHE_NAME = 'signage-app-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/viewer.js',
  './js/ocr.js',
  './js/rules.js',
  './js/exporter.js',
  './js/storage.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/xlsx/xlsx.full.min.js'
];

self.addEventListener('install', (e)=>{
  e.waitUntil((async()=>{
    const cache = await caches.open(CACHE_NAME);
    try { await cache.addAll(CORE_ASSETS.map((p)=>new Request(p, {cache:'reload'}))); } catch(_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e)=>{
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith((async()=>{
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status===200) cache.put(req, fresh.clone());
      return fresh;
    } catch(err) {
      return cached || Response.error();
    }
  })());
});
