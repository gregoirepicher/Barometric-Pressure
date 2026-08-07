const CACHE_NAME = 'bp-tracker-v21';

// Same-origin app files. Served network-first so a deploy lands on the next
// open, not the one after it. The previous cache-first rule meant every update
// was always one session late, which is the wrong trade for an app that
// changes; the cache here is the offline fallback, not the primary source.
const APP_SHELL = [
  '/',
  '/icon.svg',
  '/manifest.json',
  '/symptoms.css',
  '/symptoms.js',
];

// Versioned CDN libraries. These URLs are immutable, so cache-first is both
// safe and faster.
const VENDOR = [
  'https://cdn.jsdelivr.net/npm/chart.js@4',
  'https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3',
  'https://cdn.jsdelivr.net/npm/hammerjs@2',
  'https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2',
];

// How long to wait for the network before falling back to the cached copy.
// Keeps a slow or flaky connection from turning into a blank screen.
const NETWORK_TIMEOUT_MS = 4000;

// Install: seed the offline copy.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Fetched individually rather than via addAll(): addAll rejects as a unit,
    // so one unreachable CDN would abort the whole install and leave the app
    // with no offline copy at all.
    await Promise.all(APP_SHELL.concat(VENDOR).map(async (url) => {
      try {
        // cache: 'reload' bypasses the browser's HTTP cache, so a fresh
        // install can't seed itself with the stale copy it exists to replace.
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] precache failed:', url, err);
      }
    }));
  })());
  self.skipWaiting();
});

// Activate: drop caches from previous versions.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GETs are cacheable; cache.put() throws on anything else.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ignore chrome-extension:// and similar.
  if (!url.protocol.startsWith('http')) return;

  // Live weather data: always the network, never cached, never served stale.
  // Falling through without respondWith() leaves it to the browser.
  if (url.pathname.startsWith('/api/') || url.hostname.includes('open-meteo.com')) {
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

// Network-first with a timeout, falling back to cache.
function networkFirst(request) {
  // Ask the server every time. Without cache: 'no-cache' the browser's own
  // HTTP cache sits underneath this and can answer fetch() from disk, so the
  // service worker never learns a new version exists -- which would defeat the
  // whole point of going network-first. 'no-cache' revalidates rather than
  // re-downloads, so an unchanged file still costs only a 304.
  const networkRequest = new Request(request.url, {
    cache: 'no-cache',
    credentials: 'same-origin',
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (response) => {
      if (!settled && response) {
        settled = true;
        resolve(response);
      }
    };

    // If the network is slow, serve the cached copy rather than hanging. The
    // fetch below still runs to completion and refreshes the cache.
    const timer = setTimeout(() => {
      caches.match(request).then(settle);
    }, NETWORK_TIMEOUT_MS);

    fetch(networkRequest).then((response) => {
      clearTimeout(timer);

      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        settle(response);
        return;
      }

      // A 404 or 500 must never evict a good cached copy -- that's what would
      // strand the app permanently if a deploy went missing.
      caches.match(request).then((cached) => settle(cached || response));
    }).catch(() => {
      clearTimeout(timer);
      caches.match(request).then((cached) => {
        if (cached) return settle(cached);
        // Offline with nothing cached for this exact URL: for a page load,
        // the app shell is a better answer than a browser error.
        if (request.mode === 'navigate') {
          return caches.match('/').then((shell) => settle(shell || Response.error()));
        }
        settle(Response.error());
      });
    });
  });
}

// Cache-first for immutable vendor files.
function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;

    return fetch(request).then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    });
  });
}
