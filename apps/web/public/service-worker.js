const CACHE = 'weft-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('weft-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/health/')) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/vault-pages/')) return;
  const isDocument = request.mode === 'navigate';
  const isShellAsset = url.pathname === '/manifest.webmanifest'
    || url.pathname === '/icon.svg'
    || /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(url.pathname);
  if (!isDocument && !isShellAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque' && (url.pathname === '/' || isShellAsset)) {
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') return (await cache.match('/')) ?? Response.error();
      return Response.error();
    }
  })());
});
