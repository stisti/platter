import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LibraryState } from '../app/js/librarystate.js';
import { readTrack } from '../app/js/tags.js';
import { buildFlac, fakeDirectory } from './helpers/media.mjs';
import { memoryTrackStore } from './helpers/trackstore.mjs';

const ALBUM = { ARTIST: 'Band', ALBUM: 'Tapes' };
const KNOWN = 'Band/Tapes/01 Known.flac'; // 180 s, from its STREAMINFO
const UNKNOWN = 'Band/Tapes/02 Unknown.flac'; // no length in the file
const ALBUM_KEY = 'band\u001ftapes';

const known = () => buildFlac({ tags: { ...ALBUM, TITLE: 'Known', TRACKNUMBER: '1' } });
const unknown = () => buildFlac({ tags: { ...ALBUM, TITLE: 'Unknown', TRACKNUMBER: '2' }, playable: true, unknownLength: true });

/** A drive with the two-song album; `extra` adds or replaces files by path. */
function drive(extra = {}) {
  const tree = { Band: { Tapes: { '01 Known.flac': known(), '02 Unknown.flac': unknown() } } };
  for (const [path, value] of Object.entries(extra)) {
    const parts = path.split('/');
    let dir = tree;
    for (const part of parts.slice(0, -1)) dir = dir[part] ??= {};
    dir[parts.at(-1)] = value;
  }
  return fakeDirectory(tree);
}

/** Library state with change reasons recorded. */
function libraryState(store = memoryTrackStore()) {
  const state = new LibraryState({ store });
  const reasons = [];
  state.addEventListener('change', (event) => {
    assert.equal(event.detail.library, state.current, 'the event carries the library now shown');
    reasons.push(event.detail.reason);
  });
  return { state, store, reasons };
}

function syncOptions(root, extra = {}) {
  return { root, readTrack, buildCovers: async () => {}, isAlive: async () => !root.unplugged, ...extra };
}

/** Library state after a first sync of the two-song album. */
async function synced() {
  const s = libraryState();
  const outcome = await s.state.sync(syncOptions(drive()));
  assert.equal(outcome.status, 'done');
  s.reasons.length = 0;
  return s;
}

test('load() shows the saved library', async () => {
  const { store } = await synced();
  const { state, reasons } = libraryState(store);
  assert.equal(state.current.tracks.size, 0, 'empty until loaded');
  await state.load();
  assert.equal(state.current.tracks.size, 2);
  assert.deepEqual(reasons, ['loaded']);
});

test('sync() shows what the sync hands back, and one sync runs at a time', async () => {
  const { state, reasons } = libraryState();
  const root = drive();
  const first = state.sync(syncOptions(root));
  const second = state.sync(syncOptions(root));
  assert.equal(second, first, 'a second call joins the running sync');
  const outcome = await first;
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.added, 2);
  assert.deepEqual(reasons, ['scanned']);
  assert.equal(state.current.tracks.size, 2);
  assert.notEqual(state.sync(syncOptions(root)), first, 'a finished sync is not reused');
});

test('sync() shows the saved library again when the drive goes away mid-scan', async () => {
  const { state, reasons } = await synced();
  const root = drive({ 'Band/Tapes/03 New.flac': buildFlac({ tags: { ...ALBUM, TITLE: 'New' } }) });
  const outcome = await state.sync(syncOptions(root, { isAlive: async () => false, readTrack: async () => { root.unplugged = true; throw new DOMException('gone', 'NotFoundError'); } }));
  assert.equal(outcome.status, 'interrupted');
  assert.deepEqual(reasons, ['recovered']);
  assert.equal(state.current.tracks.size, 2);
});

test('a learned song length reaches the album total and the store, without editing the old library', async () => {
  const { state, store, reasons } = await synced();
  const before = state.current;
  assert.equal(before.albums.get(ALBUM_KEY).duration, 180);

  await state.learnDuration(UNKNOWN, 100);

  assert.notEqual(state.current, before, 'a new library, so whatever derives from it knows to refresh');
  assert.deepEqual(reasons, ['track']);
  assert.equal(state.current.tracks.get(UNKNOWN).duration, 100);
  assert.equal(state.current.albums.get(ALBUM_KEY).duration, 280);
  assert.equal(store.tracks.get(UNKNOWN).duration, 100, 'saved');
  assert.equal(Object.keys(store.tracks.get(UNKNOWN)).some((k) => k.startsWith('_')), false, 'saved as a record, without derived fields');
  assert.equal(before.tracks.get(UNKNOWN).duration, null, 'the old library is left as it was');
  assert.equal(before.albums.get(ALBUM_KEY).duration, 180);

  await state.learnDuration(UNKNOWN, 100);
  await state.learnDuration('Band/Tapes/99 Not here.flac', 50);
  assert.deepEqual(reasons, ['track'], 'the same length again, or an unknown path, changes nothing');
});

test('a learned song length is shown even when saving it fails', async () => {
  const { state, store } = await synced();
  store.putMany = async () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await state.learnDuration(UNKNOWN, 100);
  assert.equal(state.current.albums.get(ALBUM_KEY).duration, 280);
});

test('a song length learned during a sync survives the library the sync hands back', async () => {
  const { state, reasons } = await synced();
  const root = drive({ 'Band/Tapes/03 New.flac': buildFlac({ tags: { ...ALBUM, TITLE: 'New', TRACKNUMBER: '3' } }) });
  // The song plays to where its length is known while the scan is reading the new file.
  const outcome = await state.sync(syncOptions(root, {
    readTrack: async (file, path) => {
      await state.learnDuration(UNKNOWN, 100);
      return readTrack(file, path);
    },
  }));
  assert.equal(outcome.status, 'done');
  assert.deepEqual(reasons, ['track', 'scanned']);
  assert.equal(state.current.tracks.size, 3);
  assert.equal(state.current.tracks.get(UNKNOWN).duration, 100);
  assert.equal(state.current.albums.get(ALBUM_KEY).duration, 180 + 100 + 180);
});

test('a file the sync read again keeps what the scan found, not a length learned from the old file', async () => {
  const { state } = await synced();
  const root = drive({ 'Band/Tapes/02 Unknown.flac': { data: unknown(), lastModified: 1_800_000_000_000 } });
  const outcome = await state.sync(syncOptions(root, {
    readTrack: async (file, path) => {
      await state.learnDuration(UNKNOWN, 100);
      return readTrack(file, path);
    },
  }));
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.updated, 1);
  assert.equal(state.current.tracks.get(UNKNOWN).duration, null);
  assert.equal(state.current.albums.get(ALBUM_KEY).duration, 180);
});
