// Album cover thumbnails. Covers are read from the drive once, shrunk, and
// kept in IndexedDB - so the library still looks right when the drive is
// unplugged, and browsing never has to wait for the disk.

import { db } from './db.js';
import { coverCandidates } from './coverpick.js';

const THUMB_SIZE = 400;

/** Bump when the way covers are chosen or made changes; stored thumbnails are then rebuilt. */
const COVERS_VERSION = 2;

async function makeThumbnail(blob) {
  const full = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_SIZE / Math.max(full.width, full.height));
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const small = scale < 1
    ? await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
    : full;
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(small, 0, 0, width, height);
  if (small !== full) small.close();
  full.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.86 });
}

export class CoverStore extends EventTarget {
  constructor() {
    super();
    /** album keys that have a stored cover */
    this.known = new Set();
    this._urls = new Map();
    this._loading = new Map();
  }

  async init() {
    try {
      if ((await db.get('kv', 'coversVersion')) !== COVERS_VERSION) {
        // Thumbnails made by an older version may have come from a worse source
        // image. Drop them; the next scan with the drive attached remakes them.
        await db.clear('covers');
        await db.put('kv', COVERS_VERSION, 'coversVersion');
      }
      this.known = new Set(await db.keys('covers'));
    } catch {
      this.known = new Set();
    }
  }

  has(albumKey) {
    return this.known.has(albumKey);
  }

  /** Object URL of an album's thumbnail, or null when it has none. */
  url(albumKey) {
    if (!this.known.has(albumKey)) return Promise.resolve(null);
    const ready = this._urls.get(albumKey);
    if (ready) return Promise.resolve(ready);
    let loading = this._loading.get(albumKey);
    if (!loading) {
      loading = db
        .get('covers', albumKey)
        .then((record) => {
          if (!record?.blob) return null;
          const url = URL.createObjectURL(record.blob);
          this._urls.set(albumKey, url);
          return url;
        })
        .catch(() => null)
        .finally(() => this._loading.delete(albumKey));
      this._loading.set(albumKey, loading);
    }
    return loading;
  }

  /** The URL if it is already loaded, without waiting. */
  cachedUrl(albumKey) {
    return this._urls.get(albumKey) ?? null;
  }

  /**
   * Creates thumbnails for albums that do not have one yet and drops those of
   * albums that no longer exist. Runs after a scan, while the drive is there.
   *
   * @param {object} options
   * @param {{albums: Map<string, object>}} options.lib
   * @param {Map<string, string[]>} options.images from the scanner
   * @param {(path: string) => Promise<File>} options.getFile
   * @param {boolean} options.prune  remove covers of vanished albums (only after a complete scan)
   */
  async build({ lib, images, getFile, prune = false, onProgress = () => {}, signal }) {
    const todo = [...lib.albums.values()].filter((album) => !this.known.has(album.key));
    let done = 0;
    let created = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < todo.length) {
        signal?.throwIfAborted();
        const album = todo[cursor++];
        // Open every candidate (cheap: nothing is read yet) and try the largest
        // first. File size is a good stand-in for resolution, and it keeps a
        // 75-pixel "AlbumArtSmall.jpg" from winning over the real cover.
        const sources = [];
        for (const candidate of coverCandidates(album, images)) {
          try {
            const file = await getFile(candidate.path);
            sources.push(
              candidate.type === 'embedded'
                ? file.slice(candidate.offset, candidate.offset + candidate.length, candidate.mime)
                : file,
            );
          } catch (err) {
            // Drive gone: no point trying the remaining albums.
            if (err?.name === 'SourceError' && err.code !== 'missing-file') throw err;
          }
        }
        sources.sort((a, b) => b.size - a.size);
        for (const source of sources) {
          try {
            const blob = await makeThumbnail(source);
            await db.put('covers', { key: album.key, blob });
            this.known.add(album.key);
            created++;
            break;
          } catch (err) {
            // A read error because the drive went, or an undecodable image.
            if (err?.name === 'NotFoundError' || err?.name === 'NotReadableError') {
              try {
                await getFile(album.tracks[0].path);
              } catch (probe) {
                if (probe?.name === 'SourceError' && probe.code !== 'missing-file') throw probe;
              }
            }
          }
        }
        done++;
        onProgress({ phase: 'covers', done, total: todo.length });
        if (created && done % 24 === 0) this.dispatchEvent(new Event('change'));
      }
    };
    await Promise.all([worker(), worker()]);

    if (prune) {
      const gone = [...this.known].filter((key) => !lib.albums.has(key));
      if (gone.length) {
        await db.deleteMany('covers', gone);
        for (const key of gone) {
          this.known.delete(key);
          const url = this._urls.get(key);
          if (url) URL.revokeObjectURL(url);
          this._urls.delete(key);
        }
      }
    }
    if (created) this.dispatchEvent(new Event('change'));
    return { created };
  }
}
