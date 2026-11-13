// Service worker: keeps a copy of the app itself so Platter opens even when
// the server it was installed from is not running (which, on a Chromebook, is
// whenever the Linux environment is shut down).
//
// Strategy: try the network first so updates show up as soon as the server is
// reachable; fall back to the saved copy otherwise. A refused connection to
// localhost fails instantly, so there is no waiting when the server is down.
//
// Only the app's own files are handled here. Music never goes through the
// service worker - it is read straight from the drive.

const CACHE = 'platter-app-v1';

// Every file the app needs. test/assets.test.mjs fails if this list and the
// contents of app/ drift apart.
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/main.js',
  'js/bytes.js',
  'js/coverpick.js',
  'js/covers.js',
  'js/db.js',
  'js/flac.js',
  'js/id3.js',
  'js/library.js',
  'js/mp4.js',
  'js/player.js',
  'js/playlists.js',
  'js/queue.js',
  'js/scanner.js',
  'js/source.js',
  'js/tags.js',
  'js/ui/dom.js',
  'js/ui/playerbar.js',
  'js/ui/views.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('platter-app-') && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-cache' });
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch (err) {
        const cached = (await cache.match(request, { ignoreSearch: true })) ?? (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
