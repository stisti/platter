// Walks the music folder and produces the list of track records.
//
// Scans are incremental: a file whose size and modification time match the
// record from the previous scan is not opened again, so a rescan only costs a
// directory walk plus the files that actually changed.
//
// The drive can be unplugged at any moment. When that happens the scan stops
// with a ScanInterrupted error and reports nothing as removed, so a
// half-finished scan can never wipe the library.

import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, PROTECTED_EXTENSIONS, TRACK_VERSION, extensionOf } from './tags.js';

export class ScanInterrupted extends Error {
  constructor(message = 'The music drive went away during the scan') {
    super(message);
    this.name = 'ScanInterrupted';
  }
}

const SKIPPED_DIRECTORIES = /^(\$RECYCLE\.BIN|System Volume Information|lost\+found|@eaDir)$/i;

/** @import { TrackRecord } from './tags.js' */

/**
 * @param {object} options
 * @param {FileSystemDirectoryHandle} options.root
 * @param {Map<string, TrackRecord>} options.existing  path -> record from the previous scan
 * @param {(file: File, path: string) => Promise<TrackRecord|null>} options.readTrack
 *   null for a copy-protected file
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(records: TrackRecord[]) => Promise<void>} [options.onBatch]  new/changed records, as they are read
 * @param {() => Promise<boolean>} [options.isAlive]  is the drive still there?
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.concurrency]  files read at the same time
 * @param {number} [options.batchSize]  records per onBatch call
 */
export async function scanLibrary({
  root,
  existing,
  readTrack,
  onProgress = () => {},
  onBatch = async () => {},
  isAlive = async () => true,
  signal,
  concurrency = 6,
  batchSize = 100,
}) {
  const walk = await walkFolder(root, { isAlive, onProgress, signal });
  const read = await readFiles(walk.files, { existing, readTrack, onProgress, onBatch, isAlive, signal, concurrency, batchSize });
  const { tracks } = read;
  const removed = settleUnseen(existing, tracks, walk.complete);
  return {
    tracks,
    removed,
    images: walk.images,
    added: read.added,
    updated: read.updated,
    skipped: walk.skipped + read.skipped,
    complete: walk.complete,
    protectedFiles: walk.protectedFiles + read.protectedFiles,
  };
}

/**
 * Rethrows an abort, and a ScanInterrupted when the drive has gone. Returns
 * when the error was about one unreadable file or folder.
 */
async function rethrowIfFatal(err, isAlive) {
  if (err?.name === 'AbortError') throw err;
  if (!(await isAlive())) throw new ScanInterrupted();
}

/** Phase 1: find every audio file. Only directory listings are read here. */
async function walkFolder(root, { isAlive, onProgress, signal }) {
  const found = {
    /** @type {{path: string, handle: FileSystemFileHandle}[]} */
    files: [],
    /** @type {Map<string, string[]>} directory path -> image file names in it (cover art candidates) */
    images: new Map(),
    /** copy-protected files, which are found but cannot be played by anything but iTunes */
    protectedFiles: 0,
  };
  let complete = true;
  let skipped = 0;

  const pending = [{ dir: root, path: '' }];
  while (pending.length) {
    signal?.throwIfAborted();
    const { dir, path } = pending.pop();
    try {
      for await (const [name, handle] of dir.entries()) {
        const subfolder = noteEntry(found, path, name, handle);
        if (subfolder) pending.push(subfolder);
      }
    } catch (err) {
      await rethrowIfFatal(err, isAlive);
      // One unreadable folder should not sink the scan, but we can no longer
      // tell which of its tracks still exist - so nothing gets removed.
      complete = false;
      skipped++;
    }
    onProgress({ phase: 'walk', found: found.files.length });
  }
  return { ...found, complete, skipped };
}

/**
 * Notes one entry of the folder at `path` in `found`. Returns the subfolder
 * to walk when the entry is one.
 */
function noteEntry(found, path, name, handle) {
  if (name.startsWith('.')) return null; // hidden files, macOS "._" resource forks
  if (handle.kind === 'directory') {
    return SKIPPED_DIRECTORIES.test(name) ? null : { dir: handle, path: path + name + '/' };
  }
  const ext = extensionOf(name);
  if (AUDIO_EXTENSIONS.has(ext)) {
    found.files.push({ path: path + name, handle });
  } else if (PROTECTED_EXTENSIONS.has(ext)) {
    found.protectedFiles++;
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    const dirPath = path.slice(0, -1);
    let list = found.images.get(dirPath);
    if (!list) found.images.set(dirPath, (list = []));
    list.push(name);
  }
  return null;
}

function isUnchanged(previous, file) {
  return (
    Boolean(previous) &&
    previous.size === file.size &&
    previous.mtime === file.lastModified &&
    previous.v === TRACK_VERSION
  );
}

/** Phase 2: read tags of new and changed files, a few at a time. */
async function readFiles(files, { existing, readTrack, onProgress, onBatch, isAlive, signal, concurrency, batchSize }) {
  const result = {
    /** @type {TrackRecord[]} */
    tracks: [],
    added: 0,
    updated: 0,
    skipped: 0,
    /** copy-protected despite a playable-looking extension */
    protectedFiles: 0,
  };
  /** @type {TrackRecord[]} */
  const batch = [];
  let cursor = 0;
  let done = 0;
  let failure = null;

  const flush = async () => {
    if (batch.length) await onBatch(batch.splice(0));
  };

  const readOne = async ({ path, handle }) => {
    const previous = existing.get(path);
    try {
      const file = await handle.getFile();
      if (isUnchanged(previous, file)) {
        result.tracks.push(previous);
        return;
      }
      const record = await readTrack(file, path);
      if (record === null) {
        result.protectedFiles++;
        return;
      }
      result.tracks.push(record);
      batch.push(record);
      if (previous) result.updated++;
      else result.added++;
      if (batch.length >= batchSize) await flush();
    } catch (err) {
      await rethrowIfFatal(err, isAlive);
      // Unreadable file: keep what we knew about it rather than dropping it.
      if (previous) result.tracks.push(previous);
      result.skipped++;
    }
  };

  const worker = async () => {
    while (cursor < files.length && !failure) {
      signal?.throwIfAborted();
      await readOne(files[cursor++]);
      done++;
      if (done % 10 === 0 || done === files.length) onProgress({ phase: 'read', done, total: files.length });
    }
  };

  onProgress({ phase: 'read', done: 0, total: files.length });
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () =>
    worker().catch((err) => {
      failure ??= err;
    }),
  );
  await Promise.all(workers);
  // Keep whatever was read before a failure: an interrupted first scan of a
  // big library should not have to start from zero.
  await flush().catch((err) => {
    failure ??= err;
  });
  if (failure) throw failure;
  return result;
}

/**
 * Phase 3: the records of the previous scan whose files were not seen this
 * time. After a complete walk their files are gone: returns their paths as
 * removed. After an incomplete one nobody knows, so they are carried over
 * into `tracks` and nothing is removed.
 *
 * @param {Map<string, TrackRecord>} existing
 * @param {TrackRecord[]} tracks
 * @param {boolean} complete
 */
function settleUnseen(existing, tracks, complete) {
  const seen = new Set(tracks.map((t) => t.path));
  /** @type {string[]} */
  const removed = [];
  for (const [path, record] of existing) {
    if (seen.has(path)) continue;
    if (complete) removed.push(path);
    else tracks.push(record);
  }
  return removed;
}
