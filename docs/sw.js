// Offline support. Network first, so a new version of the app is picked up as soon as there is a
// connection; the saved copy is used when there is none or the network is too slow.
const CACHE = 'ilm-shell-v1';
const SHELL = [
  './', 'index.html', 'app.css', 'icon.svg', 'manifest.webmanifest',
  'js/main.js', 'js/engine.js', 'js/parser.js', 'js/render.js', 'js/store.js', 'js/sync.js',
  'vendor/preact-htm.js', 'vendor/ts-fsrs.js',
  'fonts/noto-naskh-arabic-arabic-400-normal.woff2', 'fonts/noto-naskh-arabic-arabic-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const live = request.mode === 'navigate' ? fetch(request) : fetch(request.url, { cache: 'no-cache' });
    const response = await withTimeout(live, 4000);
    if (response && response.ok) cache.put(request.mode === 'navigate' ? './' : request.url, response.clone());
    return response;
  } catch (error) {
    const saved = await cache.match(request.mode === 'navigate' ? './' : request.url, { ignoreSearch: true });
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; // GitHub API calls go straight out
  event.respondWith(networkFirst(event.request));
});
