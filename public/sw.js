/* Service worker: keeps the app shell (styles, scripts, icons) on the device so it opens quickly,
   and shows a friendly offline page when there's no signal. Pages themselves are never cached:
   they carry carts, sign-ins and admin data that must always be fresh. */
'use strict';

const VERSION = 'v1';
const STATIC_CACHE = `oakforest-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/images/app-icon.svg',
  '/images/favicon.svg',
  '/images/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('oakforest-') && k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  if (url.origin === self.location.origin) {
    return /^\/(public\/(css|js)|css|js|images)\//.test(url.pathname);
  }
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Pages: always from the network; fall back to the offline page when there's no connection.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Styles, scripts, images and fonts: serve the saved copy at once and refresh it in the background.
  if (isStaticAsset(url)) {
    event.respondWith(caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((response) => {
        if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
        return response;
      }).catch(() => cached);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return network;
    }));
  }
});
