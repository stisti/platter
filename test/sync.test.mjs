import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadLibrary, syncLibrary } from '../app/js/sync.js';
import { emptyLibrary } from '../app/js/library.js';
import { readTrack } from '../app/js/tags.js';
import { buildFlac, fakeDirectory } from './helpers/media.mjs';
import { memoryTrackStore } from './helpers/trackstore.mjs';

const flac = (tags) => buildFlac({ tags });

/** A drive with `count` tagged songs, five to an album folder. */
function songs(count) {
  const tree = {};
  for (let i = 0; i < count; i++) {
    const album = `Album ${Math.floor(i / 5) + 1}`;
    tree.Artist ??= {};
    tree.Artist[album] ??= {};
    tree.Artist[album][`${String(i).padStart(2, '0')}.flac`] = flac({ TITLE: `Song ${i}`, ARTIST: 'Artist', ALBUM: album, TRACKNUMBER: String((i % 5) + 1) });
  }
  return tree;
}

/** Removes the first `count` songs from a tree made by songs(). */
function withoutFirst(tree, count) {
  const copy = structuredClone(tree);
  let left = count;
  for (const album of Object.values(copy.Artist)) {
    for (const name of Object.keys(album).sort()) {
      if (left-- <= 0) return copy;
      delete album[name];
    }
  }
  return copy;
}

/**
 * Runs one sync and records what it handed back. `events` is the order things
 * happened in: library hand-backs by reason, and 'covers'.
 */
async function sync(root, { lib = emptyLibrary(), store = memoryTrackStore(), ...options } = {}) {
  const events = [];
  const libraries = [];
  const covers = [];
  const outcome = await syncLibrary({
    lib,
    root,
    store,
    readTrack,
    isAlive: async () => !root.unplugged,
    buildCovers: async (o) => {
      events.push('covers');
      covers.push(o);
    },
    onLibrary: (l, reason) => {
      events.push(reason);
      libraries.push(l);
    },
    ...options,
  });
  return { outcome, store, events, covers, lib: libraries.at(-1) ?? lib };
}

/** A library as the app would have it after a first sync of `tree`. */
async function synced(tree) {
  const first = await sync(fakeDirectory(tree));
  assert.equal(first.outcome.status, 'done');
  return { lib: first.lib, store: first.store };
}

test('a first sync saves every song, shows the library before covers, and prunes covers', async () => {
  const { outcome, store, events, covers, lib } = await sync(fakeDirectory(songs(7)));
  assert.deepEqual(outcome, { status: 'done', added: 7, updated: 0, removed: 0, suspicious: false, protectedFiles: 0, skipped: 0 });
  assert.equal(store.tracks.size, 7);
  assert.equal(lib.tracks.size, 7);
  assert.deepEqual(events, ['scanned', 'covers']);
  assert.equal(covers[0].lib, lib, 'covers are built for the new library');
  assert.equal(covers[0].prune, true);
  assert.equal(store.lastScan.tracks, 7);
});

test('an unchanged drive leaves the library alone but still builds covers', async () => {
  const tree = songs(7);
  const before = await synced(tree);
  const { outcome, events, covers } = await sync(fakeDirectory(tree), before);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.added + outcome.updated + outcome.removed, 0);
  assert.deepEqual(events, ['covers'], 'no library handed back');
  assert.equal(covers[0].lib, before.lib);
});

test('a scan the user asked for removes what is gone, however much', async () => {
  const tree = songs(20);
  const before = await synced(tree);
  const { outcome, store, lib } = await sync(fakeDirectory(withoutFirst(tree, 15)), before);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.removed, 15);
  assert.equal(outcome.suspicious, false);
  assert.equal(store.tracks.size, 5);
  assert.equal(lib.tracks.size, 5);
});

test('an automatic scan that finds most of the library gone removes nothing', async () => {
  const tree = songs(20);
  const before = await synced(tree);
  const { outcome, store, events, covers } = await sync(fakeDirectory(withoutFirst(tree, 15)), { ...before, quiet: true });
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.suspicious, true);
  assert.equal(outcome.removed, 0);
  assert.equal(store.tracks.size, 20);
  assert.deepEqual(events, ['covers'], 'nothing changed, so no new library');
  assert.equal(covers[0].prune, false, 'covers of the missing albums are kept');
  assert.equal(store.lastScan.tracks, 20);
});

test('the automatic-scan guard needs at least 10 removals and more than half the library', async () => {
  const cases = [
    { size: 10, gone: 9, suspicious: false }, // most of it, but fewer than 10
    { size: 19, gone: 10, suspicious: true }, // 10, and over half
    { size: 20, gone: 10, suspicious: false }, // 10, but exactly half
    { size: 25, gone: 13, suspicious: true },
  ];
  for (const { size, gone, suspicious } of cases) {
    const tree = songs(size);
    const before = await synced(tree);
    const { outcome, store } = await sync(fakeDirectory(withoutFirst(tree, gone)), { ...before, quiet: true });
    assert.equal(outcome.suspicious, suspicious, `${gone} of ${size}`);
    assert.equal(store.tracks.size, suspicious ? size : size - gone, `${gone} of ${size}`);
  }
});

test('a drive pulled during a first sync keeps what was read, and shows it', async () => {
  const root = fakeDirectory(songs(12));
  let reads = 0;
  const { outcome, store, events, lib } = await sync(root, {
    readTrack: async (file, path) => {
      if (++reads === 5) root.unplugged = true;
      return readTrack(file, path);
    },
  });
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.during, 'scan');
  assert.ok(store.tracks.size >= 4 && store.tracks.size < 12, `saved ${store.tracks.size} of 12`);
  assert.deepEqual(events, ['recovered'], 'no covers, and the saved part is shown');
  assert.equal(lib.tracks.size, store.tracks.size);
  assert.equal(store.lastScan, null);
});

test('a drive pulled during a rescan removes nothing', async () => {
  const tree = songs(12);
  const before = await synced(tree);
  const root = fakeDirectory(withoutFirst(tree, 5));
  for (const t of before.lib.tracks.values()) t.size = -1; // make every file be read again
  let reads = 0;
  const { outcome, store } = await sync(root, {
    ...before,
    readTrack: async (file, path) => {
      if (++reads === 2) root.unplugged = true;
      return readTrack(file, path);
    },
  });
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.removed, 0);
  assert.equal(store.tracks.size, 12);
});

test('a drive gone while covers are built is reported as such, after the library is saved', async () => {
  const gone = Object.assign(new Error('drive gone'), { name: 'SourceError', code: 'disconnected' });
  const { outcome, store, events } = await sync(fakeDirectory(songs(6)), {
    buildCovers: async () => {
      throw gone;
    },
  });
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.during, 'covers');
  assert.equal(outcome.added, 6);
  assert.equal(store.tracks.size, 6);
  assert.deepEqual(events, ['scanned', 'recovered']);
  assert.equal(store.lastScan, null, 'only a sync that finished counts as the last scan');
});

test('a stopped sync is reported as stopped and removes nothing', async () => {
  const tree = songs(10);
  const before = await synced(tree);
  const controller = new AbortController();
  for (const t of before.lib.tracks.values()) t.size = -1;
  const { outcome, store } = await sync(fakeDirectory(withoutFirst(tree, 3)), {
    ...before,
    signal: controller.signal,
    readTrack: async (file, path) => {
      controller.abort();
      return readTrack(file, path);
    },
  });
  assert.equal(outcome.status, 'stopped');
  assert.equal(store.tracks.size, 10);
});

test('an unexpected error is reported with the error, and never thrown', async () => {
  const boom = new TypeError('boom');
  const store = memoryTrackStore();
  store.getAll = async () => {
    throw new Error('the store is broken too');
  };
  const { outcome, events } = await sync(fakeDirectory(songs(3)), {
    store,
    buildCovers: async () => {
      throw boom;
    },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, boom);
  assert.deepEqual(events, ['scanned'], 'no recovered library when the store cannot be read');
});

test('values a song adopts from its folder are shown but never saved', async () => {
  const album = {
    '01.flac': flac({ TITLE: 'Tagged', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '1' }),
    '02.flac': flac({ TITLE: 'Untagged' }),
  };
  const tree = { 'Pink Floyd': { 'Animals (2018 Remix)': album } };
  const before = await synced(tree);
  const path = 'Pink Floyd/Animals (2018 Remix)/02.flac';
  assert.equal(before.lib.tracks.get(path).album, 'Animals', 'adopted from its neighbour');

  // A rescan that changes the neighbour re-saves only that file; the adopted one stays as it was saved.
  const changed = structuredClone(tree);
  changed['Pink Floyd']['Animals (2018 Remix)']['01.flac'] = { data: album['01.flac'], lastModified: 1_800_000_000_000 };
  const { outcome, store, lib } = await sync(fakeDirectory(changed), before);
  assert.equal(outcome.updated, 1);
  assert.equal(lib.tracks.get(path).album, 'Animals');
  for (const record of store.tracks.values()) {
    assert.deepEqual(Object.keys(record).filter((k) => k.startsWith('_')), [], `${record.path} has no derived fields`);
  }
  assert.notEqual(store.tracks.get(path).album, 'Animals', 'the saved record says what the file says');
});

test('loadLibrary builds the library from what was saved', async () => {
  const { store } = await synced(songs(6));
  const lib = await loadLibrary(store);
  assert.equal(lib.tracks.size, 6);
  assert.equal(lib.albums.size, 2);
});
