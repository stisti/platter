// Library sync: brings the stored library in line with the drive, without ever
// losing tracks to a drive that vanished half-way or to the wrong drive.
//
// scanner.js walks the folder and reads what changed; this module decides what
// to do with that: what gets saved and when, what may be removed, when covers
// may be pruned, and what to show after a failure. It never touches the page.
// The caller turns the outcome into messages.
//
// The drive can vanish at any moment, so the order matters:
//   1. records are saved batch by batch while the scan runs, so an interrupted
//      first scan of a big library does not start from zero next time;
//   2. removals are applied only after a complete scan, and an automatic scan
//      that finds most of the library gone removes nothing (wrong or half-ready
//      drive is the likelier story);
//   3. covers are pruned only when the scan was complete;
//   4. lastScan is written only once everything above has succeeded.

import { scanLibrary, ScanInterrupted } from './scanner.js';
import { buildLibrary, toRecord } from './library.js';

/** An automatic scan that would remove at least this many tracks, and over half the library, removes none. */
const SUSPICIOUS_REMOVALS = 10;
/** On a first scan, show what has been found so far at most this often (ms). */
const PREVIEW_EVERY = 2500;

/**
 * Where track records are kept (IndexedDB in the app: `trackStore` in db.js).
 * @typedef {object} TrackStore
 * @property {() => Promise<object[]>} getAll
 * @property {(records: object[]) => Promise<void>} putMany
 * @property {(paths: string[]) => Promise<void>} deleteMany
 * @property {(info: {at: number, tracks: number}) => Promise<void>} setLastScan
 */

/**
 * @typedef {object} SyncOutcome
 * @property {'done'|'interrupted'|'stopped'|'failed'} status
 *   interrupted: the drive went away (see `during`); stopped: the signal was aborted;
 *   failed: anything else (see `error`). In every case but `done`, nothing was removed
 *   and the library handed to `onLibrary` last is what the store holds.
 * @property {'scan'|'covers'} [during]  for `interrupted`: reading the music, or loading album art
 * @property {unknown} [error]  for `failed`
 * @property {number} added
 * @property {number} updated
 * @property {number} removed
 * @property {boolean} suspicious  an automatic scan found most of the library missing and removed nothing
 * @property {number} protectedFiles  copy-protected files found (never part of the library)
 * @property {number} skipped  files or folders that could not be read
 */

/** The library as saved, for showing at startup whether or not the drive is there. */
export async function loadLibrary(store) {
  return buildLibrary(await store.getAll());
}

/**
 * Brings the library up to date with the drive. Never rejects; what happened is in the outcome.
 *
 * @param {object} o
 * @param {object} o.lib  the library as it is now; the drive is compared against its tracks
 * @param {FileSystemDirectoryHandle} o.root  the music folder
 * @param {TrackStore} o.store
 * @param {(file: File, path: string) => Promise<object|null>} o.readTrack
 * @param {(options: {lib: object, images: Map<string, string[]>, prune: boolean,
 *   signal?: AbortSignal, onProgress: Function}) => Promise<void>} o.buildCovers
 *   makes missing cover thumbnails; with `prune`, also drops those of albums that are gone
 * @param {() => Promise<boolean>} [o.isAlive]  is the drive still there?
 * @param {boolean} [o.quiet]  an automatic scan, not one the user asked for: guarded against
 *   removing most of the library
 * @param {(lib: object, reason: 'preview'|'scanned'|'recovered') => void} [o.onLibrary]
 *   a library to show. preview: part of a first scan, so far; scanned: the scan's result,
 *   before covers are built; recovered: reloaded from the store after a failure.
 * @param {(progress: object) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<SyncOutcome>}
 */
export async function syncLibrary({
  lib,
  root,
  store,
  readTrack,
  buildCovers,
  isAlive,
  quiet = false,
  onLibrary = () => {},
  onProgress = () => {},
  signal,
}) {
  const counts = { added: 0, updated: 0, removed: 0, suspicious: false, protectedFiles: 0, skipped: 0 };
  const wasEmpty = lib.tracks.size === 0;
  const fresh = [];
  let lastPreview = Date.now();
  let during = 'scan';

  try {
    const result = await scanLibrary({
      root,
      existing: lib.tracks,
      readTrack,
      signal,
      isAlive,
      onProgress,
      onBatch: async (records) => {
        await store.putMany(records.map(toRecord));
        if (!wasEmpty) return;
        fresh.push(...records);
        if (Date.now() - lastPreview > PREVIEW_EVERY) {
          lastPreview = Date.now();
          onLibrary(buildLibrary(fresh), 'preview');
        }
      },
    });
    Object.assign(counts, { added: result.added, updated: result.updated, protectedFiles: result.protectedFiles, skipped: result.skipped });

    let { tracks, removed, complete } = result;
    if (quiet && removed.length >= SUSPICIOUS_REMOVALS && removed.length * 2 > lib.tracks.size) {
      tracks = tracks.concat(removed.map((path) => lib.tracks.get(path)));
      removed = [];
      complete = false; // also keeps the covers of the albums in question
      counts.suspicious = true;
    }
    if (removed.length) await store.deleteMany(removed);
    counts.removed = removed.length;

    let current = lib;
    // An unchanged library is left alone: no reason to redraw what the user is looking at.
    if (result.added || result.updated || removed.length || wasEmpty) {
      current = buildLibrary(tracks);
      onLibrary(current, 'scanned');
    }

    during = 'covers';
    await buildCovers({ lib: current, images: result.images, prune: complete, signal, onProgress });

    await store.setLastScan({ at: Date.now(), tracks: tracks.length });
    return { status: 'done', ...counts };
  } catch (error) {
    // Whatever was read before the failure is already saved; show it.
    try {
      onLibrary(await loadLibrary(store), 'recovered');
    } catch {
      // keep the library the caller has
    }
    if (error instanceof ScanInterrupted || error?.name === 'SourceError') return { status: 'interrupted', during, ...counts };
    if (error?.name === 'AbortError') return { status: 'stopped', ...counts };
    return { status: 'failed', error, ...counts };
  }
}
