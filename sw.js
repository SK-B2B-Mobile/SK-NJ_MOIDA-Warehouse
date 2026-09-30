// v2 — CACHE-FIRST for index.html was the root cause of a whole class of
// "I deployed but the bug is still there" reports: once a worker's phone
// had cached the page once, this fetch handler kept answering every load
// with that same frozen HTML forever, no matter how many times the app
// was redeployed on GitHub Pages — the only way out was that page's own
// script clearing all caches, which just meant every deploy needed TWO
// loads to actually land (one stale load to trigger the clear, one more
// to finally fetch fresh). Fix: the app shell (the page itself) and any
// API call are now NETWORK-FIRST — every load fetches the latest deployed
// code straight away, and a cached copy is only used as a fallback if the
// device is genuinely offline. Only the pinned, versioned CDN assets
// (fonts/icons, which never change once published) stay cache-first,
// since those are safe to cache aggressively and it saves real bandwidth.
const CACHE_NAME = 'sk-warehouse-v3';
const ASSETS = [
  'https://cdn.jsdelivr.net/npm/remixicon@4.1.0/fonts/remixicon.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isAppShellOrApi =
    event.request.mode === 'navigate' ||
    url.endsWith('/') ||
    url.endsWith('index.html') ||
    url.includes('script.google.com');

  if (isAppShellOrApi) {
    // Network first — always try to get the freshest deploy. Only fall
    // back to whatever's cached if the network request itself fails
    // (device is offline), so the app still opens without a connection.
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (pinned CDN fonts/icons) — cache-first, then cache
  // whatever comes back from the network so it's available offline too.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return res;
    }))
  );
});
