/* Offline support for the MAD apps: same-origin files are fetched fresh from the network when there is
   one (so updates show up at once) and served from the cache when there is not (weak signal at the track).
   External data (radar, weather, tiles, live timing, YouTube) is never cached here. */
const CACHE = 'mad-v1';
const CORE = [
  './', './index.html', './assets/mad-logo.png', './assets/sr-logo.png', './assets/icon-180.png',
  './dashboard/index.html', './dashboard/dashboard.css', './dashboard/dashboard.js', './dashboard/tracks.js', './dashboard/entries.js',
  './dashboard/tips.js', './dashboard/quicktip.js', './dashboard/vendor/leaflet/leaflet.js', './dashboard/vendor/leaflet/leaflet.css',
  './dashboard/vendor/pdfjs/pdf.min.js', './dashboard/vendor/pdfjs/pdf.worker.min.js',
  './dashboard/assets/mad-logo.png', './dashboard/assets/sr-logo.png', './dashboard/manifest.webmanifest',
  './webapp/index.html', './webapp/app.css', './webapp/app.js', './webapp/tips.js', './webapp/quicktip.js',
  './webapp/assets/mad-logo.png', './webapp/assets/sr-logo.png', './webapp/manifest.webmanifest', './webapp/samples/samples.json',
];
self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', ev => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  // web fonts: cache first (they never change)
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    ev.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  ev.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match(url.pathname.endsWith('/') ? url.pathname + 'index.html' : req))));
});
