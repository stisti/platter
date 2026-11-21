// MP4 / M4A metadata reader (iTunes-style tags). Reads the `moov` box only:
// duration from `mvhd`, the audio codec from the sample description, and the
// tags from `udta/meta/ilst`. Tags are returned under the same key names the
// FLAC reader uses.

import { be32, latin1 } from './bytes.js';
import { ID3_GENRES } from './id3.js';

const utf8 = new TextDecoder('utf-8');
const utf16be = new TextDecoder('utf-16be');

const ITEM_MAP = {
  '©nam': 'TITLE',
  '©ART': 'ARTIST',
  aART: 'ALBUMARTIST',
  '©alb': 'ALBUM',
  '©gen': 'GENRE',
  '©day': 'DATE',
};

// Free-form ("----") items worth keeping, by name: the original release date
// as MusicBrainz Picard and Platter's year tool write it.
const FREEFORM_MAP = { ORIGINALDATE: 'ORIGINALDATE', ORIGINALYEAR: 'ORIGINALYEAR' };

const MAX_TEXT = 8192;
const TYPE_UTF8 = 1;
const TYPE_UTF16 = 2;
const TYPE_JPEG = 13;
const TYPE_PNG = 14;

/** Reads one box header. Returns null when there is no valid box at `pos`. */
async function readBox(reader, pos, limit) {
  if (pos + 8 > limit) return null;
  const b = await reader.read(pos, 16);
  if (b.length < 8) return null;
  let size = be32(b, 0);
  const type = latin1(b.subarray(4, 8));
  let header = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = be32(b, 8) * 2 ** 32 + be32(b, 12);
    header = 16;
  } else if (size === 0) {
    size = limit - pos; // "extends to the end of the file"
  }
  if (size < header || pos + size > limit) return null;
  return { type, body: pos + header, end: pos + size };
}

/** Finds the first child box of the given type inside [start, end). */
async function findChild(reader, start, end, type) {
  let pos = start;
  for (let guard = 0; guard < 10000; guard++) {
    const box = await readBox(reader, pos, end);
    if (!box) return null;
    if (box.type === type) return box;
    pos = box.end;
  }
  return null;
}

async function findPath(reader, start, end, path) {
  let box = { body: start, end };
  for (const type of path) {
    box = await findChild(reader, box.body, box.end, type);
    if (!box) return null;
  }
  return box;
}

/**
 * @param {{size: number, read(offset: number, length: number): Promise<Uint8Array>}} reader
 * @returns {Promise<{tags: Record<string, string[]>, duration: number|null, codec: string|null,
 *   picture: {offset: number, length: number, mime: string}|null}>}
 */
export async function parseMp4(reader) {
  const first = await readBox(reader, 0, reader.size);
  if (!first || !/^(ftyp|moov|free|skip|wide|mdat)$/.test(first.type)) throw new Error('Not an MP4 file');
  // The movie box sits either right at the start or after all the audio data.
  const moov = first.type === 'moov' ? first : await findChild(reader, 0, reader.size, 'moov');
  if (!moov) throw new Error('MP4 file without a movie box');

  const out = { tags: {}, duration: null, codec: null, picture: null };

  let pos = moov.body;
  for (let guard = 0; guard < 1000; guard++) {
    const box = await readBox(reader, pos, moov.end);
    if (!box) break;
    pos = box.end;
    if (box.type === 'mvhd') {
      out.duration = await readDuration(reader, box);
    } else if (box.type === 'trak' && out.codec === null) {
      out.codec = await readCodec(reader, box);
    } else if (box.type === 'udta') {
      const meta = await findChild(reader, box.body, box.end, 'meta');
      if (meta) await readMeta(reader, meta, out);
    } else if (box.type === 'meta') {
      await readMeta(reader, box, out);
    }
  }
  return out;
}

async function readDuration(reader, box) {
  const b = (await reader.read(box.body, 32)).slice();
  if (b.length < 20) return null;
  let timescale;
  let duration;
  if (b[0] === 1) {
    if (b.length < 32) return null;
    timescale = be32(b, 20);
    duration = be32(b, 24) * 2 ** 32 + be32(b, 28);
  } else {
    timescale = be32(b, 12);
    duration = be32(b, 16);
    if (duration === 0xffffffff) return null; // "unknown"
  }
  return timescale && duration ? duration / timescale : null;
}

/** The sample format of a track: 'mp4a' (AAC), 'alac', 'drms' (copy-protected), ... */
async function readCodec(reader, trak) {
  const stsd = await findPath(reader, trak.body, trak.end, ['mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) return null;
  // version/flags (4), entry count (4), then the first entry: size (4), format (4)
  const b = await reader.read(stsd.body, 16);
  if (b.length < 16 || be32(b, 4) === 0) return null;
  return latin1(b.subarray(12, 16)).trim().toLowerCase() || null;
}

async function readMeta(reader, meta, out) {
  // `meta` is a "full box": 4 bytes of version/flags precede its children.
  // (QuickTime-style files omit them; try both.)
  const ilst =
    (await findChild(reader, meta.body + 4, meta.end, 'ilst')) ?? (await findChild(reader, meta.body, meta.end, 'ilst'));
  if (!ilst) return;

  let pos = ilst.body;
  for (let guard = 0; guard < 2000; guard++) {
    const item = await readBox(reader, pos, ilst.end);
    if (!item) break;
    pos = item.end;
    if (item.type === '----') {
      await readFreeform(reader, item, out);
      continue;
    }

    let dataPos = item.body;
    for (let n = 0; n < 16; n++) {
      const data = await readBox(reader, dataPos, item.end);
      if (!data) break;
      dataPos = data.end;
      if (data.type !== 'data' || data.end - data.body < 8) continue;
      const head = await reader.read(data.body, 8);
      if (head.length < 8) break;
      const kind = be32(head, 0) & 0xffffff;
      const payload = data.body + 8;
      const length = data.end - payload;
      await readItem(reader, item.type, kind, payload, length, out);
    }
  }
}

/**
 * A free-form item: `mean` (the namespace), `name`, then `data`. Only the
 * names in FREEFORM_MAP are read; the rest (iTunes' own iTunNORM, iTunSMPB, …)
 * are skipped without reading their data.
 */
async function readFreeform(reader, item, out) {
  let key = null;
  let pos = item.body;
  for (let n = 0; n < 8; n++) {
    const child = await readBox(reader, pos, item.end);
    if (!child) return;
    pos = child.end;
    // `mean` and `name` are full boxes: 4 bytes of version/flags, then the text.
    if (child.type === 'name') {
      const length = child.end - child.body - 4;
      if (length <= 0 || length > 64) return;
      key = FREEFORM_MAP[utf8.decode(await reader.read(child.body + 4, length)).toUpperCase()];
      if (!key) return;
    } else if (child.type === 'data' && key) {
      const length = child.end - child.body - 8;
      if (length <= 0 || length > MAX_TEXT) return;
      const head = await reader.read(child.body, 8);
      if (head.length < 8 || (be32(head, 0) & 0xffffff) !== TYPE_UTF8) return;
      const value = stripTrailingNuls(utf8.decode(await reader.read(child.body + 8, length))).trim();
      if (value) (out.tags[key] ??= []).push(value);
      return;
    }
  }
}

/**
 * Drops trailing NUL characters. A linear scan, because the regex /\u0000+$/
 * takes quadratic time on a long run of NULs followed by another character.
 */
function stripTrailingNuls(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return s.slice(0, end);
}

async function readItem(reader, type, kind, payload, length, out) {
  if (type === 'covr') {
    if (length > 0 && out.picture === null) {
      out.picture = { offset: payload, length, mime: kind === TYPE_PNG ? 'image/png' : 'image/jpeg' };
    }
    return;
  }
  if (length <= 0 || length > MAX_TEXT) return;
  const readValue = ITEM_MAP[type] ? readTextItem : ITEM_READERS[type];
  if (!readValue) return;
  const tag = await readValue(reader, { type, kind, payload, length }, out.tags);
  if (tag?.value) (out.tags[tag.key] ??= []).push(tag.value);
}

/**
 * Readers for the items that are not plain text, by item type. Each returns
 * the tag the item gives, or nothing.
 * @type {Record<string, (reader: any, item: {type: string, kind: number, payload: number, length: number},
 *   tags: Record<string, string[]>) => Promise<{key: string, value: string}|undefined>>}
 */
const ITEM_READERS = {
  trkn: readNumberPair,
  disk: readNumberPair,
  gnre: readGenreNumber,
  cpil: readCompilation,
};

async function readTextItem(reader, { type, kind, payload, length }) {
  if (kind !== TYPE_UTF8 && kind !== TYPE_UTF16) return;
  const b = await reader.read(payload, length);
  return { key: ITEM_MAP[type], value: stripTrailingNuls((kind === TYPE_UTF16 ? utf16be : utf8).decode(b)).trim() };
}

/** Track or disc number, with the total when there is one: "3/12". */
async function readNumberPair(reader, { type, payload, length }) {
  const b = await reader.read(payload, Math.min(length, 6));
  if (b.length < 4) return;
  const number = (b[2] << 8) | b[3];
  const total = b.length >= 6 ? (b[4] << 8) | b[5] : 0;
  if (!number) return;
  return { key: type === 'trkn' ? 'TRACKNUMBER' : 'DISCNUMBER', value: total ? `${number}/${total}` : String(number) };
}

/** Numeric genre: an ID3v1 genre number, plus one. A text genre wins over it. */
async function readGenreNumber(reader, { payload, length }, tags) {
  const b = await reader.read(payload, Math.min(length, 2));
  const index = b.length >= 2 ? ((b[0] << 8) | b[1]) - 1 : -1;
  if (index < 0 || index >= ID3_GENRES.length || tags.GENRE) return;
  return { key: 'GENRE', value: ID3_GENRES[index] };
}

async function readCompilation(reader, { payload }) {
  const b = await reader.read(payload, 1);
  if (b.length && b[0]) return { key: 'COMPILATION', value: '1' };
}
