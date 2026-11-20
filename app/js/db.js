// Thin promise wrapper around IndexedDB. Everything the app remembers lives
// here: the track index, cover thumbnails, playlists, and small settings
// (including the handle of the music folder).

const DB_NAME = 'platter';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      const ensure = (name, options) => {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, options);
      };
      ensure('tracks', { keyPath: 'path' });
      ensure('covers', { keyPath: 'key' });
      ensure('playlists', { keyPath: 'id' });
      ensure('kv');
    };
    req.onsuccess = () => {
      // Let a newer version of the app upgrade the database instead of blocking it.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Runs `work(store)` in one transaction and resolves once it has committed. */
async function withStore(storeName, mode, work) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    const out = work(tx.objectStore(storeName));
    if (out instanceof IDBRequest) out.onsuccess = () => (result = out.result);
    else result = out;
  });
}

export const db = {
  get: (store, key) => withStore(store, 'readonly', (s) => s.get(key)),
  getAll: (store) => withStore(store, 'readonly', (s) => s.getAll()),
  keys: (store) => withStore(store, 'readonly', (s) => s.getAllKeys()),
  /** `key` is only needed for stores without a key path (the `kv` store). */
  put: (store, value, key) => withStore(store, 'readwrite', (s) => s.put(value, key)),
  delete: (store, key) => withStore(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => withStore(store, 'readwrite', (s) => s.clear()),
  putMany: (store, values) =>
    withStore(store, 'readwrite', (s) => {
      for (const value of values) s.put(value);
    }),
  deleteMany: (store, keys) =>
    withStore(store, 'readwrite', (s) => {
      for (const key of keys) s.delete(key);
    }),
};

/** The track records, as Library sync (sync.js) uses them. */
export const trackStore = {
  getAll: () => db.getAll('tracks'),
  putMany: (records) => db.putMany('tracks', records),
  deleteMany: (paths) => db.deleteMany('tracks', paths),
  setLastScan: (info) => db.put('kv', info, 'lastScan'),
};

/** Small settings in the `kv` store, as Library SQL (librarysql.js) uses them. */
export const kvStore = {
  get: (key) => db.get('kv', key),
  put: (key, value) => db.put('kv', value, key),
};
