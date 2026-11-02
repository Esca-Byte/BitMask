// BitMask Service Worker
const CACHE_NAME = 'bitmask-v16';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/app-redesign.css',
  '/css/legal.css',
  '/js/crypto.js',
  '/js/identity.js',
  '/js/qrcode.js',
  '/js/notifications.js',
  '/js/config.js',
  '/js/socket.js',
  '/js/webrtc.js',
  '/js/panic.js',
  '/js/app.js',
  '/manifest.json',
  '/brand/bitmasklogo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/socket.io/')) return; // Skip socket signaling
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request)).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('/index.html');
      return Response.error();
    })
  );
});
