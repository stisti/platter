// Turns an audio file into the track record stored in the library. Tags come
// from the file when a parser exists for the format; whatever is missing is
// filled in from the file's path ("Artist/Album/01 - Title.flac").

import { BlobReader } from './bytes.js';
import { parseFlac } from './flac.js';
import { parseMp3 } from './id3.js';
import { parseMp4 } from './mp4.js';

/** Bump when parsing changes in a way that should make a rescan re-read every file. */
export const TRACK_VERSION = 3;

export const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wav']);
/** Copy-protected iTunes purchases (FairPlay). Recognised only so they can be counted and explained. */
export const PROTECTED_EXTENSIONS = new Set(['m4p']);
export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

export const UNKNOWN_ARTIST = 'Unknown Artist';
export const UNKNOWN_ALBUM = 'Unknown Album';

export function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function baseOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

const DISC_FOLDER = /^(cd|disc|disk)[\s._-]*\d+$/i;

/** Best-effort metadata from "…/Artist/Album/[CD1/]01 - Title.ext". */
export function guessFromPath(path) {
  const parts = path.split('/');
  const file = parts.pop();
  const dot = file.lastIndexOf('.');
  let title = dot > 0 ? file.slice(0, dot) : file;
  let trackNo = null;
  let discNo = null;

  // "01 - Title", "01. Title", "01_Title", "1-01 Title" (disc-track)
  const m = /^(?:(\d)[-.])?(\d{1,3})(?:\s*[-._)]\s*|\s+)(\S.*)$/.exec(title);
  if (m) {
    if (m[1]) discNo = Number(m[1]);
    trackNo = Number(m[2]);
    title = m[3];
  }
  title = title.replace(/_/g, ' ').trim() || file;

  if (parts.length && DISC_FOLDER.test(parts[parts.length - 1])) {
    const d = /\d+/.exec(parts.pop());
    if (d && discNo === null) discNo = Number(d[0]);
  }
  const album = parts.length ? parts[parts.length - 1] : null;
  const artist = parts.length >= 2 ? parts[parts.length - 2] : null;
  return { title, trackNo, discNo, album, artist };
}

// Rippers (Windows Media Player above all) write stand-in tags when they cannot
// identify a CD: "Unknown artist", "Unknown album (date time)", "Track 3" - in
// the language of the computer. Such tags say less than the file's own path,
// so they are treated as missing. English, Finnish, Swedish, German.
const PLACEHOLDER_ARTIST = /^(unknown artist|tuntematon esittäjä|okänd artist|unbekannter interpret)$/i;
const PLACEHOLDER_ALBUM = /^(unknown album|tuntematon albumi|okänt album|unbekanntes album)(\s*\(.*\))?$/i;
const PLACEHOLDER_TITLE = /^(track|raita|spår|titel)\s*\d+$/i;
const PLACEHOLDER_GENRE = /^(unknown genre|tuntematon tyylilaji|okänd genre|unbekanntes genre)$/i;

const real = (value, placeholder) => (value && !placeholder.test(value.trim()) ? value : null);

// "Live 1975-85 [Disc 2]", "Greatest Hits (CD 1)": one album, several discs.
const DISC_SUFFIX = /^(.*\S)\s*[[(](?:disc|disk|cd)\s*(\d+)[\])]$/i;

function firstTag(tags, ...keys) {
  for (const key of keys) {
    const v = tags[key];
    if (v && v.length) return v[0];
  }
  return null;
}

function leadingInt(value) {
  if (value == null) return null;
  const m = /^\s*(\d+)/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

function yearOf(value) {
  if (value == null) return null;
  const m = /(\d{4})/.exec(value);
  return m ? Number(m[1]) : null;
}

export function splitGenres(values) {
  const out = [];
  const seen = new Set();
  for (const value of values ?? []) {
    for (const part of value.split(/[;\u0000]/)) {
      const genre = part.trim().replace(/\s+/g, ' ');
      const key = genre.toLowerCase();
      if (genre && !seen.has(key)) {
        seen.add(key);
        out.push(genre);
      }
    }
  }
  return out;
}

/**
 * What is stored for one audio file (IndexedDB `tracks`, keyed by path).
 * @typedef {object} TrackRecord
 * @property {string} path  relative to the music folder: "Artist/Album/01 - Title.flac"
 * @property {number} size  bytes; with `mtime` and `v`, tells a rescan whether to re-read the file
 * @property {number} mtime  the file's lastModified (ms)
 * @property {number} v  the TRACK_VERSION the record was made with
 * @property {string} fmt  file extension, lower case
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {string|null} albumArtist
 * @property {boolean} compilation
 * @property {number|null} trackNo
 * @property {number|null} discNo
 * @property {number|null} year  of the edition this file comes from
 * @property {number|null} originalYear  when the album first came out, if the file says
 * @property {string[]} genres
 * @property {number|null} duration  seconds
 * @property {{o: number, l: number, m: string}|null} pic  embedded picture: byte offset, length, MIME type
 * @property {string[]} guessed  fields taken from the path for want of a usable tag
 */

/**
 * Builds a track record from already-parsed tags. Pure, so it is easy to test.
 *
 * `guessed` lists the fields ("title", "artist", "album") that had no usable
 * tag and were derived from the path instead; the library builder uses it to
 * let such a track take its album details from its neighbours in the folder.
 *
 * @param {string} path
 * @param {{size?: number, mtime?: number}} [file]
 * @param {{tags?: Record<string, string[]>, duration?: number|null,
 *   picture?: {offset: number, length: number, mime: string}|null}|null} [parsed]  from a tag parser
 * @returns {TrackRecord}
 */
export function makeTrack(path, { size = 0, mtime = 0 } = {}, parsed = null) {
  const tags = parsed?.tags ?? {};
  const guess = guessFromPath(path);
  const guessed = [];

  const artists = (tags.ARTIST ?? []).filter((a) => real(a, PLACEHOLDER_ARTIST));
  const albumArtist = real(firstTag(tags, 'ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'), PLACEHOLDER_ARTIST);
  let title = real(firstTag(tags, 'TITLE'), PLACEHOLDER_TITLE);
  let artist = artists.length ? artists.join(', ') : albumArtist;
  let album = real(firstTag(tags, 'ALBUM'), PLACEHOLDER_ALBUM);
  if (!title) {
    title = guess.title;
    guessed.push('title');
  }
  if (!artist) {
    artist = guess.artist ?? UNKNOWN_ARTIST;
    guessed.push('artist');
  }
  if (!album) {
    album = guess.album ?? UNKNOWN_ALBUM;
    guessed.push('album');
  }

  let discNo = leadingInt(firstTag(tags, 'DISCNUMBER', 'DISC')) ?? guess.discNo;
  const disc = DISC_SUFFIX.exec(album);
  if (disc) {
    album = disc[1];
    discNo ??= Number(disc[2]) || null;
  }

  const picture = parsed?.picture;
  return {
    path,
    size,
    mtime,
    v: TRACK_VERSION,
    fmt: extensionOf(path),
    title,
    artist,
    album,
    albumArtist: albumArtist ?? null,
    compilation: firstTag(tags, 'COMPILATION') === '1',
    trackNo: leadingInt(firstTag(tags, 'TRACKNUMBER', 'TRACK')) ?? guess.trackNo,
    discNo,
    /** Year of the edition this file comes from (a reissue says when it was reissued). */
    year: yearOf(firstTag(tags, 'DATE', 'YEAR', 'ORIGINALDATE', 'ORIGINALYEAR')),
    /** Year the album first came out, when the file says so (MusicBrainz's ORIGINALDATE). */
    originalYear: yearOf(firstTag(tags, 'ORIGINALDATE', 'ORIGINALYEAR')),
    genres: splitGenres(tags.GENRE).filter((g) => !PLACEHOLDER_GENRE.test(g)),
    duration: parsed?.duration ?? null,
    pic: picture ? { o: picture.offset, l: picture.length, m: picture.mime } : null,
    guessed,
  };
}

/** Sample formats no browser can decode: FairPlay-protected iTunes purchases. */
const PROTECTED_CODECS = new Set(['drms', 'drmi', 'p608']);

/**
 * Reads tags from an audio File/Blob. A file whose tags cannot be parsed
 * still gets a usable record derived from its path. Returns null for a
 * copy-protected file, which could be listed but never played.
 *
 * @param {File} file
 * @param {string} path
 * @returns {Promise<TrackRecord|null>}
 */
export async function readTrack(file, path) {
  const ext = extensionOf(path);
  let parsed = null;
  try {
    if (ext === 'flac') parsed = await parseFlac(new BlobReader(file));
    else if (ext === 'mp3') parsed = await parseMp3(new BlobReader(file));
    else if (ext === 'm4a') parsed = await parseMp4(new BlobReader(file));
  } catch (err) {
    // A vanished drive must surface to the scanner; a malformed file must not.
    if (err?.name === 'NotFoundError' || err?.name === 'NotReadableError' || err?.name === 'AbortError') throw err;
    parsed = null;
  }
  if (parsed?.codec && PROTECTED_CODECS.has(parsed.codec)) return null;
  return makeTrack(path, { size: file.size, mtime: file.lastModified ?? 0 }, parsed);
}
