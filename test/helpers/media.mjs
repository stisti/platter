// Test helpers: build FLAC and ID3 byte streams from a description, and fake
// the File System Access directory handles the app reads the drive through.

import { readFileSync } from 'node:fs';

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const syncsafe = (n) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);

// ------------------------------------------------------------------- FLAC

/** A real, playable 1.5 s FLAC (a 440 Hz tone) whose audio frames the builder can reuse. */
export const TONE_FLAC = new Uint8Array(readFileSync(new URL('../fixtures/tone.flac', import.meta.url)));

function flacBlock(type, body, last = false) {
  const header = new Uint8Array([(last ? 0x80 : 0) | type, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]);
  return concat([header, body]);
}

function streamInfo({ sampleRate = 44100, channels = 2, bits = 16, totalSamples = 44100 * 180 }) {
  const b = new Uint8Array(34);
  b[0] = 0x10; b[2] = 0x10; // min/max block size 4096
  b[10] = (sampleRate >> 12) & 255;
  b[11] = (sampleRate >> 4) & 255;
  b[12] = ((sampleRate & 15) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 1);
  b[13] = (((bits - 1) & 15) << 4) | Math.floor(totalSamples / 2 ** 32);
  b.set(u32be(totalSamples % 2 ** 32), 14);
  return b;
}

function vorbisComment(tags, vendor = 'platter-test') {
  const comments = [];
  for (const [key, value] of Object.entries(tags)) {
    for (const v of Array.isArray(value) ? value : [value]) comments.push(enc.encode(`${key}=${v}`));
  }
  const v = enc.encode(vendor);
  return concat([u32le(v.length), v, u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c])]);
}

function pictureBlock({ type = 3, mime = 'image/png', description = '', data }) {
  const m = enc.encode(mime);
  const d = enc.encode(description);
  return concat([u32be(type), u32be(m.length), m, u32be(d.length), d, u32be(0), u32be(0), u32be(0), u32be(0), u32be(data.length), data]);
}

/** Splits a FLAC file into its STREAMINFO body and its audio frames. */
function splitFlac(bytes) {
  let pos = 4;
  let info = null;
  for (;;) {
    const last = (bytes[pos] & 0x80) !== 0;
    const type = bytes[pos] & 0x7f;
    const length = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (type === 0) info = bytes.slice(pos + 4, pos + 4 + length);
    pos += 4 + length;
    if (last) break;
  }
  return { info, audio: bytes.slice(pos) };
}

/**
 * Builds a FLAC file.
 * @param {object} o
 * @param {Record<string, string|string[]>} [o.tags]
 * @param {Array<{type?: number, mime?: string, description?: string, data: Uint8Array}>} [o.pictures]
 * @param {boolean} [o.playable] reuse the tone fixture's audio, so a browser can actually play it
 * @param {boolean} [o.picturesFirst] put PICTURE blocks before the tags (some taggers do)
 * @param {number} [o.padding] bytes of PADDING block at the end of the metadata
 * @param {Uint8Array} [o.prefix] bytes to put before the stream (e.g. an ID3v2 tag)
 */
export function buildFlac({ tags = {}, pictures = [], playable = false, picturesFirst = false, padding = 0, prefix = null, vendor, ...info } = {}) {
  const base = playable ? splitFlac(TONE_FLAC) : null;
  const blocks = [{ type: 0, body: base ? base.info : streamInfo(info) }];
  const comment = { type: 4, body: vorbisComment(tags, vendor) };
  const pics = pictures.map((p) => ({ type: 6, body: pictureBlock(p) }));
  blocks.push(...(picturesFirst ? [...pics, comment] : [comment, ...pics]));
  if (padding) blocks.push({ type: 1, body: new Uint8Array(padding) });
  const parts = blocks.map((b, i) => flacBlock(b.type, b.body, i === blocks.length - 1));
  return concat([prefix ?? new Uint8Array(0), enc.encode('fLaC'), ...parts, base ? base.audio : new Uint8Array(64)]);
}

// -------------------------------------------------------------------- ID3

function encodeText(text, encoding) {
  if (encoding === 3) return enc.encode(text);
  if (encoding === 1) {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xff; out[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      out[2 + i * 2] = text.charCodeAt(i) & 255;
      out[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return out;
  }
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 255); // latin-1
}

/**
 * Builds an ID3v2 tag.
 * @param {object} o
 * @param {2|3|4} [o.version]
 * @param {Array<{id: string, text?: string, encoding?: 0|1|3, raw?: Uint8Array}>} o.frames
 * @param {{mime?: string, type?: number, data: Uint8Array}} [o.picture]
 */
export function buildId3v2({ version = 3, frames = [], picture = null, padding = 32 } = {}) {
  const parts = [];
  const frame = (id, body) => {
    if (version === 2) parts.push(enc.encode(id), new Uint8Array([(body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255]), body);
    else parts.push(enc.encode(id), version === 4 ? syncsafe(body.length) : u32be(body.length), new Uint8Array(2), body);
  };
  for (const f of frames) {
    const encoding = f.encoding ?? 0;
    frame(f.id, f.raw ?? concat([new Uint8Array([encoding]), encodeText(f.text, encoding)]));
  }
  if (picture) {
    const { mime = 'image/jpeg', type = 3, data } = picture;
    if (version === 2) frame('PIC', concat([new Uint8Array([0]), enc.encode(mime.includes('png') ? 'PNG' : 'JPG'), new Uint8Array([type, 0]), data]));
    else frame('APIC', concat([new Uint8Array([0]), enc.encode(mime), new Uint8Array([0, type, 0]), data]));
  }
  const body = concat([...parts, new Uint8Array(padding)]);
  return concat([enc.encode('ID3'), new Uint8Array([version, 0, 0]), syncsafe(body.length), body]);
}

/** One MPEG-1 Layer III frame header (128 kbit/s, 44.1 kHz, stereo), optionally with a Xing header. */
export function mpegFrame({ xingFrames = null } = {}) {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  if (xingFrames !== null) {
    frame.set(enc.encode('Xing'), 4 + 32);
    frame.set(u32be(1), 4 + 32 + 4); // flags: frame count present
    frame.set(u32be(xingFrames), 4 + 32 + 8);
  }
  return frame;
}

export function buildId3v1({ title = '', artist = '', album = '', year = '', track = 0, genre = 255 }) {
  const tag = new Uint8Array(128);
  const put = (text, at, length) => tag.set(Uint8Array.from(text.slice(0, length), (c) => c.charCodeAt(0) & 255), at);
  put('TAG', 0, 3);
  put(title, 3, 30);
  put(artist, 33, 30);
  put(album, 63, 30);
  put(year, 93, 4);
  tag[126] = track;
  tag[127] = genre;
  return tag;
}

// -------------------------------------------------------------------- MP4

function box(type, ...parts) {
  const body = concat(parts);
  const name = Uint8Array.from(type, (c) => c.charCodeAt(0) & 255);
  return concat([u32be(body.length + 8), name, body]);
}

const ILST_TEXT = { TITLE: '\u00a9nam', ARTIST: '\u00a9ART', ALBUMARTIST: 'aART', ALBUM: '\u00a9alb', GENRE: '\u00a9gen', DATE: '\u00a9day' };

/**
 * Builds an M4A file the way iTunes lays it out.
 * @param {object} o
 * @param {Record<string, string>} [o.tags] TITLE, ARTIST, ALBUMARTIST, ALBUM, GENRE, DATE
 * @param {Record<string, string>} [o.freeform] free-form iTunes items ("----"), by name, e.g. ORIGINALDATE
 * @param {[number, number]} [o.track] track number and total
 * @param {[number, number]} [o.disc]
 * @param {number} [o.genreId] numeric ("gnre") genre: ID3v1 index + 1
 * @param {{png?: boolean, data: Uint8Array}} [o.cover]
 * @param {string} [o.codec] sample format: 'mp4a' (AAC), 'alac', 'drms' (protected)
 * @param {boolean} [o.moovLast] put the metadata after the audio, as non-"fast start" encoders do
 * @param {number} [o.audioBytes] size of the audio data
 * @param {boolean} [o.wideAudio] give the audio box a 64-bit size field
 */
export function buildM4a({ tags = {}, freeform = {}, track = null, disc = null, genreId = null, compilation = false, cover = null, codec = 'mp4a', duration = 200, moovLast = false, audioBytes = 256, wideAudio = false } = {}) {
  const data = (kind, payload) => box('data', u32be(kind), u32be(0), payload);
  const items = [];
  for (const [key, value] of Object.entries(tags)) items.push(box(ILST_TEXT[key], data(1, enc.encode(value))));
  if (track) items.push(box('trkn', data(0, new Uint8Array([0, 0, track[0] >> 8, track[0] & 255, track[1] >> 8, track[1] & 255, 0, 0]))));
  if (disc) items.push(box('disk', data(0, new Uint8Array([0, 0, disc[0] >> 8, disc[0] & 255, disc[1] >> 8, disc[1] & 255]))));
  if (genreId !== null) items.push(box('gnre', data(0, new Uint8Array([genreId >> 8, genreId & 255]))));
  if (compilation) items.push(box('cpil', data(21, new Uint8Array([1]))));
  items.push(box('----', box('mean', u32be(0), enc.encode('com.apple.iTunes')), box('name', u32be(0), enc.encode('iTunNORM')), data(1, enc.encode(' 00000A2B'))));
  for (const [name, value] of Object.entries(freeform)) {
    items.push(box('----', box('mean', u32be(0), enc.encode('com.apple.iTunes')), box('name', u32be(0), enc.encode(name)), data(1, enc.encode(value))));
  }
  if (cover) items.push(box('covr', data(cover.png ? 14 : 13, cover.data)));

  const timescale = 44100;
  const mvhd = box('mvhd', u32be(0), u32be(0), u32be(0), u32be(timescale), u32be(Math.round(duration * timescale)), new Uint8Array(80));
  const sampleEntry = concat([u32be(36), Uint8Array.from(codec, (c) => c.charCodeAt(0)), new Uint8Array(28)]);
  const trak = box('trak', box('tkhd', new Uint8Array(84)), box('mdia', box('mdhd', new Uint8Array(24)), box('minf', box('smhd', new Uint8Array(8)), box('stbl', box('stsd', u32be(0), u32be(1), sampleEntry), box('stts', new Uint8Array(4096))))));
  const meta = box('meta', u32be(0), box('hdlr', new Uint8Array(25)), box('ilst', ...items));
  const moov = box('moov', mvhd, trak, box('udta', meta));
  const ftyp = box('ftyp', enc.encode('M4A '), u32be(0), enc.encode('M4A mp42isom'));
  const audio = new Uint8Array(audioBytes).fill(0x21);
  const mdat = wideAudio
    ? concat([u32be(1), enc.encode('mdat'), u32be(0), u32be(audio.length + 16), audio])
    : box('mdat', audio);
  return concat(moovLast ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

export { concat };

/** A 1x1 PNG, the smallest thing that decodes as an image. */
export const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

// ---------------------------------------------------- fake directory handles

function notFound(name) {
  return new DOMException(`A requested file or directory could not be found: ${name}`, 'NotFoundError');
}

/**
 * A stand-in for FileSystemDirectoryHandle over a plain object tree:
 *   fakeDirectory({ 'Artist': { 'Album': { '01 - Song.flac': bytes } } })
 * File values are Uint8Array contents, or `{ data, lastModified }`.
 * Set `handle.unplugged = true` on the root to make every access fail the way
 * a disconnected drive does.
 */
export function fakeDirectory(tree, name = 'Music', root = null) {
  const handle = {
    kind: 'directory',
    name,
    tree,
    unplugged: false,
    reads: 0,
    _check() {
      if ((root ?? handle).unplugged) throw notFound(name);
    },
    async *entries() {
      handle._check();
      for (const [childName, value] of Object.entries(tree)) {
        handle._check();
        yield [childName, child(childName, value)];
      }
    },
    async *keys() {
      handle._check();
      for (const childName of Object.keys(tree)) yield childName;
    },
    async getDirectoryHandle(childName) {
      handle._check();
      const value = tree[childName];
      if (!value || value instanceof Uint8Array || value.data) throw notFound(childName);
      return child(childName, value);
    },
    async getFileHandle(childName) {
      handle._check();
      const value = tree[childName];
      if (!value || !(value instanceof Uint8Array || value.data)) throw notFound(childName);
      return child(childName, value);
    },
    async queryPermission() {
      return 'granted';
    },
  };
  const top = root ?? handle;
  function child(childName, value) {
    if (value instanceof Uint8Array || value.data) {
      const data = value instanceof Uint8Array ? value : value.data;
      return {
        kind: 'file',
        name: childName,
        async getFile() {
          handle._check();
          top.reads++;
          return new File([data], childName, { lastModified: value.lastModified ?? 1_700_000_000_000 });
        },
      };
    }
    return fakeDirectory(value, childName, top);
  }
  return handle;
}
