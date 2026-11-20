// Library state: the library the app is showing now, and the only way to change
// it. Loading the saved library, Library sync (sync.js) and changes to single
// tracks all go through here, so whatever derives from the library - the views,
// the album totals, the SQL copy - only has to watch for one thing: a new
// library object, announced by a `change` event.
//
// A built library is never edited in place. A change saves the record through
// the track store and rebuilds the in-memory index (buildLibrary over the
// records already held: no music files are read, it takes milliseconds).

import { loadLibrary, syncLibrary } from './sync.js';
import { buildLibrary, emptyLibrary, toRecord } from './library.js';

/**
 * @import { Library, Track } from './library.js'
 * @import { TrackStore, SyncOutcome } from './sync.js'
 */

/**
 * Why the library changed:
 *   loaded     the saved library, at startup
 *   preview    part of a first scan, so far
 *   scanned    a scan's result
 *   recovered  reloaded from the store after a failed scan
 *   track      one track changed (a song length learned by playing it)
 * @typedef {'loaded'|'preview'|'scanned'|'recovered'|'track'} ChangeReason
 */

/**
 * What `sync()` takes: syncLibrary's options, less what Library state supplies itself.
 * @typedef {Omit<Parameters<typeof syncLibrary>[0], 'lib'|'store'|'onLibrary'>} SyncOptions
 */

/**
 * A song length learned while a sync runs, with the file version it was learned from.
 * @typedef {{duration: number, size: number, mtime: number}} Learned
 */

export class LibraryState extends EventTarget {
  /**
   * @param {object} o
   * @param {TrackStore} o.store  where track records are saved (`trackStore` in db.js)
   */
  constructor({ store }) {
    super();
    this.store = store;
    /** @type {Library} The library the app is showing now. */
    this.current = emptyLibrary();
    /** @type {Promise<SyncOutcome>|null} */
    this._sync = null;
    /** @type {Map<string, Learned>|null} path -> length learned during the running sync */
    this._learned = null;
  }

  /** Shows the saved library. Rejects if the store cannot be read; the library stays as it was. */
  async load() {
    this._replace(await loadLibrary(this.store), 'loaded');
  }

  /**
   * Brings the library up to date with the drive (see syncLibrary for the rules).
   * Only one sync runs at a time: calling this while one runs returns that one.
   * @param {SyncOptions} options
   * @returns {Promise<SyncOutcome>}
   */
  sync(options) {
    this._sync ??= this._runSync(options).finally(() => {
      this._sync = null;
    });
    return this._sync;
  }

  /** @param {SyncOptions} options */
  async _runSync(options) {
    const learned = (this._learned = new Map());
    try {
      return await syncLibrary({
        ...options,
        lib: this.current,
        store: this.store,
        // The sync works from the library as it was when it started, so it
        // hands back tracks without the lengths learned since: put them back.
        onLibrary: (lib, reason) => this._replace(withLearned(lib, learned), reason),
      });
    } finally {
      this._learned = null;
    }
  }

  /**
   * A song length learned by playing the file, for one whose tags do not give
   * it. The library shows it at once; it is saved too, but a failed save is not
   * an error (the length is learned again next time the song plays).
   * @param {string} path
   * @param {number} seconds
   */
  async learnDuration(path, seconds) {
    const track = this.current.tracks.get(path);
    if (!track || !(seconds > 0) || track.duration === seconds) return;
    this._learned?.set(path, { duration: seconds, size: track.size, mtime: track.mtime });
    const lib = rebuildWith(this.current, new Map([[path, seconds]]));
    this._replace(lib, 'track');
    try {
      await this.store.putMany([toRecord(lib.tracks.get(path))]);
    } catch {
      // not saved: still right for this session
    }
  }

  /**
   * @param {Library} lib
   * @param {ChangeReason} reason
   */
  _replace(lib, reason) {
    this.current = lib;
    this.dispatchEvent(new CustomEvent('change', { detail: { reason, library: lib } }));
  }
}

/**
 * A new library from `lib`'s records, with some durations set.
 * @param {Library} lib
 * @param {Map<string, number>} durations  path -> seconds
 * @returns {Library}
 */
function rebuildWith(lib, durations) {
  return buildLibrary(
    [...lib.tracks.values()].map((track) => {
      const record = toRecord(track);
      if (durations.has(record.path)) record.duration = durations.get(record.path);
      return record;
    }),
  );
}

/**
 * `lib` with the lengths learned during a sync, for tracks that still lack one
 * and are still the same file (a file the scan read again keeps what it found).
 * @param {Library} lib
 * @param {Map<string, Learned>} learned
 * @returns {Library}
 */
function withLearned(lib, learned) {
  /** @type {Map<string, number>} */
  const durations = new Map();
  for (const [path, l] of learned) {
    /** @type {Track|undefined} */
    const track = lib.tracks.get(path);
    if (track && !track.duration && track.size === l.size && track.mtime === l.mtime) durations.set(path, l.duration);
  }
  return durations.size ? rebuildWith(lib, durations) : lib;
}
