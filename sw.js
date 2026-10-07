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
//
// v14.86 — IM-reported "접속이 잘 안 된다 / 자주 끊긴다" (the app often
// fails to load at all, or gets stuck on "Loading warehouse system...").
// Root cause, confirmed directly from a worker's own DevTools console:
//   "The FetchEvent ... resulted in a network error response: the
//    promise was rejected."
//   "Uncaught (in promise) TypeError: Failed to convert value to
//    'Response'." — thrown from this file.
// The old network-first handler's offline fallback was:
//   fetch(event.request).catch(() => caches.match(event.request))
// caches.match() resolves to undefined when nothing matching is in the
// cache — and this handler NEVER put a successful app-shell/API response
// into the cache in the first place (only the plain cache-first branch
// below does that, for the two pinned CDN assets). So the "fall back to
// cache if offline" comment above was never actually true for the app
// shell or API calls: there was nothing to ever fall back to. The result:
// the very first network hiccup on this warehouse's WiFi — a dropped
// packet, not necessarily the phone being genuinely offline — made
// caches.match() resolve to undefined, and handing respondWith()
// undefined instead of a real Response is a hard, uncatchable crash at
// the browser level, which is exactly the frozen loading screen reported.
// Fixed three ways:
//   1. One quick automatic retry before giving up at all — most warehouse
//      WiFi drops are a one-off blip that succeeds immediately on a
//      second try, so most cases now silently self-heal with no worker
//      action needed at all.
//   2. A successful app-shell/API response IS now cached, so a genuinely
//      offline moment has a real last-known-good copy to fall back to —
//      fulfilling what the original comment already claimed to do.
//   3. respondWith() is now GUARANTEED a real Response no matter what,
//      even in the worst case (network down on both tries AND nothing
//      cached yet, e.g. this exact device's very first-ever load) — so
//      this handler can never crash the page load again. The app's own
//      "⚠ Failed to connect — check API URL" / "다시 연결 시도" UI (already
//      built for exactly this situation) takes it from there instead of
//      the browser just hanging forever with no explanation.
const CACHE_NAME = 'sk-warehouse-v4';
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

// v14.86 — see the long note above. Tries the network (twice, back to
// back, before giving up on it), caches whatever succeeds, falls back to
// the last cached copy if both tries fail, and — only in the worst case,
// network down and nothing cached — returns a small, real Response
// explaining that plainly instead of ever handing respondWith() something
// that isn't a Response at all.
async function networkFirstWithFallback(request){
  async function tryNetwork(){
    const res = await fetch(request);
    if (res && res.ok) {
      // Cache a CLONE — the original response body can only be read once,
      // and this function still needs to hand the real one back to the
      // page that asked for it.
      const copy = res.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
    }
    return res;
  }

  try {
    return await tryNetwork();
  } catch (err) {
    try {
      return await tryNetwork();
    } catch (err2) {
      const cached = await caches.match(request);
      if (cached) return cached;
      // Nothing cached yet (most likely this exact device's very first
      // load) and the network genuinely isn't reachable right now. A
      // same-origin navigation gets a short, readable HTML explanation;
      // anything else routed through here (the Apps Script JSONP calls,
      // loaded as a <script> tag) gets an inert JS comment instead, so a
      // browser that tries to execute it as a script does nothing rather
      // than throwing a syntax error on an HTML body.
      const isNavigate = request.mode === 'navigate';
      return new Response(
        isNavigate
          ? '<!doctype html><meta charset="utf-8"><body style="background:#0a0e1a;color:#e8ecf5;font-family:-apple-system,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px"><div><h2 style="margin:0 0 8px">연결할 수 없습니다</h2><p style="color:#aab4cc;margin:0">네트워크 연결을 확인하고 새로고침해주세요.</p></div></body>'
          : '/* offline — no cached copy available */',
        {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': isNavigate ? 'text/html; charset=utf-8' : 'application/javascript' }
        }
      );
    }
  }
}

self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isAppShellOrApi =
    event.request.mode === 'navigate' ||
    url.endsWith('/') ||
    url.endsWith('index.html') ||
    url.includes('script.google.com');

  if (isAppShellOrApi) {
    event.respondWith(networkFirstWithFallback(event.request));
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
