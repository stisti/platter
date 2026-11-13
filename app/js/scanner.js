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

/**
 * @param {object} options
 * @param {FileSystemDirectoryHandle} options.root
 * @param {Map<string, object>} options.existing  path -> record from the previous scan
 * @param {(file: File, path: string) => Promise<object>} options.readTrack
 * @param {(progress: object) => void} [options.onProgress]
 * @param {(records: object[]) => Promise<void>} [options.onBatch]  new/changed records, as they are read
 * @param {() => Promise<boolean>} [options.isAlive]  is the drive still there?
 * @param {AbortSignal} [options.signal]
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
  const files = [];
  /** directory path -> image file names in it (cover art candidates) */
  const images = new Map();
  let complete = true;
  let skipped = 0;
  /** copy-protected files, which are found but cannot be played by anything but iTunes */
  let protectedFiles = 0;

  // Phase 1: find every audio file. Only directory listings are read here.
  const pending = [{ dir: root, path: '' }];
  while (pending.length) {
    signal?.throwIfAborted();
    const { dir, path } = pending.pop();
    try {
      for await (const [name, handle] of dir.entries()) {
        if (name.startsWith('.')) continue; // hidden files, macOS "._" resource forks
        if (handle.kind === 'directory') {
          if (!SKIPPED_DIRECTORIES.test(name)) pending.push({ dir: handle, path: path + name + '/' });
          continue;
        }
        const ext = extensionOf(name);
        if (AUDIO_EXTENSIONS.has(ext)) {
          files.push({ path: path + name, handle });
        } else if (PROTECTED_EXTENSIONS.has(ext)) {
          protectedFiles++;
        } else if (IMAGE_EXTENSIONS.has(ext)) {
          const dirPath = path.slice(0, -1);
          let list = images.get(dirPath);
          if (!list) images.set(dirPath, (list = []));
          list.push(name);
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (!(await isAlive())) throw new ScanInterrupted();
      // One unreadable folder should not sink the scan, but we can no longer
      // tell which of its tracks still exist - so nothing gets removed.
      complete = false;
      skipped++;
    }
    onProgress({ phase: 'walk', found: files.length });
  }

  // Phase 2: read tags of new and changed files, a few at a time.
  const tracks = [];
  const batch = [];
  let cursor = 0;
  let done = 0;
  let added = 0;
  let updated = 0;
  let failure = null;

  const flush = async () => {
    if (batch.length) await onBatch(batch.splice(0));
  };

  const worker = async () => {
    while (cursor < files.length && !failure) {
      signal?.throwIfAborted();
      const { path, handle } = files[cursor++];
      const previous = existing.get(path);
      try {
        const file = await handle.getFile();
        if (
          previous &&
          previous.size === file.size &&
          previous.mtime === file.lastModified &&
          previous.v === TRACK_VERSION
        ) {
          tracks.push(previous);
        } else {
          const record = await readTrack(file, path);
          if (record === null) {
            protectedFiles++; // copy-protected despite a playable-looking extension
          } else {
            tracks.push(record);
            batch.push(record);
            if (previous) updated++;
            else added++;
            if (batch.length >= batchSize) await flush();
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (!(await isAlive())) throw new ScanInterrupted();
        // Unreadable file: keep what we knew about it rather than dropping it.
        if (previous) tracks.push(previous);
        skipped++;
      }
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

  const seen = new Set(tracks.map((t) => t.path));
  const removed = [];
  if (complete) {
    for (const path of existing.keys()) if (!seen.has(path)) removed.push(path);
  } else {
    // Incomplete walk: carry over everything we could not confirm either way.
    for (const [path, record] of existing) if (!seen.has(path)) tracks.push(record);
  }

  return { tracks, removed, images, added, updated, skipped, complete, protectedFiles };
}
