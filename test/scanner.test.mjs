import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanLibrary, ScanInterrupted } from '../app/js/scanner.js';
import { readTrack } from '../app/js/tags.js';
import { buildFlac, buildM4a, fakeDirectory, TINY_PNG } from './helpers/media.mjs';

const flac = (tags) => buildFlac({ tags });

function sampleTree() {
  return {
    'Pink Floyd': {
      Animals: {
        '01 - Pigs on the Wing 1.flac': flac({ TITLE: 'Pigs on the Wing 1', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '1' }),
        '02 - Dogs.flac': flac({ TITLE: 'Dogs', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '2' }),
        'cover.jpg': TINY_PNG,
        'notes.txt': new Uint8Array(10),
        '._02 - Dogs.flac': new Uint8Array(10), // macOS resource fork: looks like audio, is not
      },
    },
    '.Trash-1000': { 'deleted.flac': flac({ TITLE: 'gone' }) },
    'System Volume Information': { 'x.flac': flac({ TITLE: 'no' }) },
    '$RECYCLE.BIN': { 'y.flac': flac({ TITLE: 'no' }) },
    'loose.FLAC': flac({ TITLE: 'Loose' }),
    'empty folder': {},
  };
}

const scan = (root, existing = new Map(), extra = {}) =>
  scanLibrary({ root, existing, readTrack, isAlive: async () => !root.unplugged, ...extra });

const byPath = (tracks) => new Map(tracks.map((t) => [t.path, t]));

test('finds audio files recursively, skipping hidden and system folders', async () => {
  const result = await scan(fakeDirectory(sampleTree()));
  assert.deepEqual(result.tracks.map((t) => t.path).sort(), [
    'Pink Floyd/Animals/01 - Pigs on the Wing 1.flac',
    'Pink Floyd/Animals/02 - Dogs.flac',
    'loose.FLAC',
  ]);
  assert.equal(result.added, 3);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.removed, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.images.get('Pink Floyd/Animals'), ['cover.jpg']);
  assert.equal(byPath(result.tracks).get('Pink Floyd/Animals/02 - Dogs.flac').title, 'Dogs');
});

test('a second scan reads no tags again, and still reports the same library', async () => {
  const root = fakeDirectory(sampleTree());
  const first = await scan(root);
  let parsed = 0;
  const second = await scan(root, byPath(first.tracks), {
    readTrack: (file, path) => {
      parsed++;
      return readTrack(file, path);
    },
  });
  assert.equal(parsed, 0);
  assert.equal(second.added + second.updated, 0);
  assert.equal(second.tracks.length, 3);
  assert.deepEqual(second.removed, []);
});

test('picks up new, changed and deleted files', async () => {
  const tree = sampleTree();
  const root = fakeDirectory(tree);
  const first = await scan(root);

  const animals = tree['Pink Floyd'].Animals;
  delete animals['01 - Pigs on the Wing 1.flac'];
  animals['02 - Dogs.flac'] = { data: flac({ TITLE: 'Dogs (Remaster)', ARTIST: 'Pink Floyd', ALBUM: 'Animals' }), lastModified: 1_800_000_000_000 };
  animals['03 - Pigs.flac'] = flac({ TITLE: 'Pigs', ARTIST: 'Pink Floyd', ALBUM: 'Animals' });

  const batches = [];
  const second = await scan(root, byPath(first.tracks), { onBatch: async (records) => batches.push(...records) });
  assert.equal(second.added, 1);
  assert.equal(second.updated, 1);
  assert.deepEqual(second.removed, ['Pink Floyd/Animals/01 - Pigs on the Wing 1.flac']);
  assert.deepEqual(batches.map((t) => t.title).sort(), ['Dogs (Remaster)', 'Pigs']);
  assert.deepEqual(second.tracks.map((t) => t.title).sort(), ['Dogs (Remaster)', 'Loose', 'Pigs']);
});

test('copy-protected iTunes files are counted, not listed - and not counted as changes', async () => {
  const root = fakeDirectory({
    iTunes: {
      'bought long ago.m4p': new Uint8Array(100),
      'also protected.m4a': buildM4a({ tags: { TITLE: 'Locked' }, codec: 'drms' }),
      'fine.m4a': buildM4a({ tags: { TITLE: 'Open', ARTIST: 'A', ALBUM: 'B' } }),
    },
  });
  const first = await scan(root);
  assert.deepEqual(first.tracks.map((t) => t.title), ['Open']);
  assert.equal(first.protectedFiles, 2);
  assert.equal(first.added, 1);
  const second = await scan(root, byPath(first.tracks));
  assert.equal(second.added + second.updated + second.removed.length, 0);
  assert.equal(second.protectedFiles, 2);
});

test('reports progress through both phases', async () => {
  const seen = [];
  await scan(fakeDirectory(sampleTree()), new Map(), { onProgress: (p) => seen.push(p) });
  assert.ok(seen.some((p) => p.phase === 'walk' && p.found === 3));
  assert.deepEqual(seen.at(-1), { phase: 'read', done: 3, total: 3 });
});

test('an empty folder is a valid, empty library', async () => {
  const result = await scan(fakeDirectory({}));
  assert.deepEqual(result.tracks, []);
  assert.equal(result.complete, true);
});

test('drive unplugged before the scan: interrupted, nothing lost', async () => {
  const root = fakeDirectory(sampleTree());
  const first = await scan(root);
  root.unplugged = true;
  await assert.rejects(scan(root, byPath(first.tracks)), ScanInterrupted);
});

test('drive unplugged while reading tags: interrupted, and what was read so far is handed over', async () => {
  const tree = {};
  for (let i = 0; i < 40; i++) tree[`track ${String(i).padStart(2, '0')}.flac`] = flac({ TITLE: `T${i}` });
  const root = fakeDirectory(tree);
  const saved = [];
  let parsed = 0;
  await assert.rejects(
    scan(root, new Map(), {
      concurrency: 2,
      batchSize: 5,
      onBatch: async (records) => saved.push(...records),
      readTrack: async (file, path) => {
        if (++parsed === 18) root.unplugged = true;
        return readTrack(file, path);
      },
    }),
    ScanInterrupted,
  );
  assert.ok(saved.length >= 15 && saved.length < 40, `saved ${saved.length} of 40 before the drive went`);
});

test('one unreadable folder does not sink the scan - and nothing is removed on its account', async () => {
  const root = fakeDirectory(sampleTree());
  const first = await scan(root);

  // Make "Pink Floyd/Animals" fail to list, while the drive itself is fine.
  const flaky = fakeDirectory(sampleTree());
  const original = flaky.getDirectoryHandle;
  const wrapped = {
    ...flaky,
    async *entries() {
      for await (const [name, handle] of flaky.entries()) {
        if (name === 'Pink Floyd') {
          yield [name, { ...handle, async *entries() { throw new DOMException('I/O error', 'NotReadableError'); } }];
        } else yield [name, handle];
      }
    },
    getDirectoryHandle: original,
  };
  const result = await scanLibrary({ root: wrapped, existing: byPath(first.tracks), readTrack, isAlive: async () => true });
  assert.equal(result.complete, false);
  assert.deepEqual(result.removed, []);
  assert.equal(result.tracks.length, 3, 'tracks in the unreadable folder are carried over');
  assert.equal(result.skipped, 1);
});

test('a single unreadable file is skipped; its previous record is kept', async () => {
  const tree = sampleTree();
  const root = fakeDirectory(tree);
  const first = await scan(root);
  const existing = byPath(first.tracks);
  // Force a re-read of every file, with one of them failing.
  for (const t of existing.values()) t.size = -1;
  const result = await scan(root, existing, {
    readTrack: async (file, path) => {
      if (path === 'loose.FLAC') throw new DOMException('bad sector', 'NotReadableError');
      return readTrack(file, path);
    },
  });
  assert.equal(result.skipped, 1);
  assert.equal(result.tracks.length, 3);
  assert.equal(result.updated, 2);
  assert.deepEqual(result.removed, []);
});

test('can be cancelled', async () => {
  const controller = new AbortController();
  const tree = {};
  for (let i = 0; i < 30; i++) tree[`t${i}.flac`] = flac({ TITLE: `T${i}` });
  let parsed = 0;
  await assert.rejects(
    scan(fakeDirectory(tree), new Map(), {
      signal: controller.signal,
      readTrack: async (file, path) => {
        if (++parsed === 10) controller.abort();
        return readTrack(file, path);
      },
    }),
    { name: 'AbortError' },
  );
  assert.ok(parsed < 30);
});
