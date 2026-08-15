/* Simple offline shell for the NYC Apartment Search app.
 *
 * Caches only the top-level HTML document. Everything else this app fetches is
 * either a live public dataset (NYC Open Data, Nominatim, Overpass) or auth/sync
 * infrastructure (Firebase) — none of those should be cached, since stale answers
 * would be actively misleading (a "no open violations" report from 6 months ago
 * is worse than an honest offline error).
 *
 * The tradeoff of caching-only-the-shell is:
 *   + The app opens instantly on repeat visits, even without a network
 *   + An offline user can still see the UI (empty results, but no white screen)
 *   + Every dataset stays fresh — no risk of showing stale public-records data
 *   - An offline user obviously can't run new searches
 *
 * Bump CACHE_NAME's version whenever the HTML changes structure enough that a
 * cached older copy would be broken by a subsequent JS update.
 */
const CACHE_NAME = 'nyc-bldg-v1';
const APP_SHELL_URLS = ['/', '/index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  // We ONLY intercept top-level document navigations for the app itself. Anything
  // else — API calls to opendata, gstatic (Firebase), unpkg (Leaflet), Nominatim,
  // Overpass, Google Maps tiles — falls through to the browser's normal fetch.
  if(url.origin !== self.location.origin) return;
  if(req.mode !== 'navigate' && req.destination !== 'document') return;
  event.respondWith(
    fetch(req).then(res => {
      // Only cache successful basic-type responses; opaque/error responses cache
      // as-is would poison the shell.
      if(res && res.ok && res.type === 'basic'){
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put('/', clone));
      }
      return res;
    }).catch(() => caches.match('/').then(cached => cached || new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<style>body{font:14px system-ui;padding:2em;max-width:36em;margin:auto;color:#333;}</style>' +
      '<h1>Offline</h1><p>NYC public records require an internet connection. ' +
      'Reconnect and reload to run a search.</p>',
      {status: 200, headers: {'Content-Type': 'text/html'}}
    )))
  );
});
