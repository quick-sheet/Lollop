const CACHE = 'lollop-v1';   // bump on every release, together with core.js?v= and gfx.js?v= in index.html
const SHELL = ['./', 'index.html', 'core.js', 'gfx.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys()
  .then((k) => Promise.all(k.filter((x) => x.startsWith('lollop-') && x !== CACHE).map((x) => caches.delete(x)))).then(() => self.clients.claim())));
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {            // network first (always checked with GitHub), 4 s, then cache
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const net = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
        const r = await Promise.race([net, new Promise((_, j) => setTimeout(() => j(new Error('slow')), 4000))]);
        if (r.ok) c.put(req, r.clone());
        return r;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
      }
    })());
    return;
  }
  if (FONTS.test(req.url)) e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { c.put(req, r.clone()); return r; })));
});
