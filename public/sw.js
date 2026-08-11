// BitMask Service Worker
const CACHE_NAME = 'bitmask-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/crypto.js',
  '/js/identity.js',
  '/js/qrcode.js',
  '/js/notifications.js',
  '/js/socket.js',
  '/js/webrtc.js',
  '/js/audio.js',
  '/js/panic.js',
  '/js/app.js'
];

self.addEventListener('install', (e) => {
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
    )
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/socket.io/')) return; // Skip socket signaling
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
