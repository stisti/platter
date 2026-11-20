// Service worker: keeps a copy of the app itself so Platter opens even when
// the site it was installed from can't be reached (offline, or a development
// server on localhost that isn't running).
//
// Strategy: try the network first, so a new version is used as soon as it is
// published; fall back to the saved copy otherwise. Publishing a new version
// needs no change here. A window that stays open while a new version is
// published is told about it by js/update.js.
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
  'js/librarystate.js',
  'js/mp4.js',
  'js/player.js',
  'js/playlists.js',
  'js/queue.js',
  'js/scanner.js',
  'js/source.js',
  'js/genres.js',
  'js/sqldb.js',
  'js/sqlrows.js',
  'js/sync.js',
  'js/tags.js',
  'js/ui/dom.js',
  'js/ui/playerbar.js',
  'js/ui/query.js',
  'js/ui/views.js',
  'js/update.js',
  'js/version.js',
  // SQLite for the Query page (vendored @sqlite.org/sqlite-wasm; loaded only when used)
  'vendor/sqlite/sqlite3.mjs',
  'vendor/sqlite/sqlite3.wasm',
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
  // The update check (js/update.js) asks for the published version.js and
  // must neither get nor overwrite the saved copy.
  if (request.cache === 'no-store') return;
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
