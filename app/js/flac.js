// FLAC metadata reader: STREAMINFO (duration), VORBIS_COMMENT (tags) and the
// location of the embedded cover picture. Only the metadata blocks at the head
// of the file are read; the audio itself is never touched.

import { be24, be32, le32, syncsafe } from './bytes.js';

const utf8 = new TextDecoder('utf-8');

const BLOCK_STREAMINFO = 0;
const BLOCK_VORBIS_COMMENT = 4;
const BLOCK_PICTURE = 6;

const MAX_COMMENT_BLOCK = 8 * 1024 * 1024;
const MAX_COMMENT_VALUE = 16 * 1024;
const PICTURE_FRONT_COVER = 3;

/**
 * @param {{size: number, read(offset: number, length: number): Promise<Uint8Array>}} reader
 * @returns {Promise<{tags: Record<string, string[]>, duration: number|null, sampleRate: number|null,
 *   channels: number|null, bitsPerSample: number|null,
 *   picture: {offset: number, length: number, mime: string}|null}>}
 */
export async function parseFlac(reader) {
  let pos = await metadataStart(reader);
  const out = {
    tags: {},
    duration: null,
    sampleRate: null,
    channels: null,
    bitsPerSample: null,
    picture: null,
  };
  const seen = { info: false, comment: false, pictureType: -1 };

  for (let guard = 0; guard < 1024; guard++) {
    const block = await readBlockHeader(reader, pos);
    if (!block) break;
    await readBlock(reader, block, out, seen);

    // With stream info, tags and the front cover in hand there is nothing more
    // to learn - and not looking past a multi-megabyte picture saves a disk seek.
    if (seen.info && seen.comment && seen.pictureType === PICTURE_FRONT_COVER) break;

    pos = block.body + block.length;
    if (block.last || pos >= reader.size) break;
  }
  return out;
}

/** Where the first metadata block starts, after the "fLaC" marker. Throws for a file that is not FLAC. */
async function metadataStart(reader) {
  let pos = 0;
  let head = await reader.read(0, 10);

  // Some taggers prepend an ID3v2 tag to FLAC files. Skip over it.
  if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
    pos = 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
    head = await reader.read(pos, 4);
  }
  if (head.length < 4 || head[0] !== 0x66 || head[1] !== 0x4c || head[2] !== 0x61 || head[3] !== 0x43) {
    throw new Error('Not a FLAC file');
  }
  return pos + 4;
}

/** The metadata block header at `pos`, or null where there is no valid one. */
async function readBlockHeader(reader, pos) {
  const hdr = await reader.read(pos, 4);
  if (hdr.length < 4) return null;
  const type = hdr[0] & 0x7f;
  if (type === 127) return null; // invalid block type: the stream is corrupt
  return { last: (hdr[0] & 0x80) !== 0, type, length: be24(hdr, 1), body: pos + 4 };
}

/** Reads one metadata block into `out`, noting in `seen` what has been found so far. */
async function readBlock(reader, block, out, seen) {
  if (block.type === BLOCK_STREAMINFO) {
    seen.info = true;
    await readStreamInfo(reader, block, out);
  } else if (block.type === BLOCK_VORBIS_COMMENT) {
    seen.comment = true;
    await readCommentBlock(reader, block, out.tags);
  } else if (block.type === BLOCK_PICTURE) {
    const pic = await readPictureBlock(reader, block.body, block.length);
    // Prefer the front cover; otherwise keep the first picture found.
    if (pic && (out.picture === null || (pic.type === PICTURE_FRONT_COVER && seen.pictureType !== PICTURE_FRONT_COVER))) {
      out.picture = { offset: pic.offset, length: pic.length, mime: pic.mime };
      seen.pictureType = pic.type;
    }
  }
}

async function readStreamInfo(reader, block, out) {
  const b = await reader.read(block.body, Math.min(block.length, 34));
  if (b.length < 18) return;
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  const totalSamples = (b[13] & 0x0f) * 2 ** 32 + be32(b, 14);
  out.sampleRate = sampleRate || null;
  out.channels = ((b[12] >> 1) & 0x07) + 1;
  out.bitsPerSample = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
  out.duration = sampleRate && totalSamples ? totalSamples / sampleRate : null;
}

async function readCommentBlock(reader, block, tags) {
  if (block.length > MAX_COMMENT_BLOCK) return;
  const b = await reader.read(block.body, block.length);
  if (b.length === block.length) parseVorbisComment(b, tags);
}

async function readPictureBlock(reader, body, blockLength) {
  if (blockLength < 32) return null;
  let b = await reader.read(body, 8);
  if (b.length < 8) return null;
  const type = be32(b, 0);
  const mimeLength = be32(b, 4);
  if (mimeLength > 255 || 8 + mimeLength + 4 > blockLength) return null;

  b = await reader.read(body + 8, mimeLength + 4);
  if (b.length < mimeLength + 4) return null;
  let mime = '';
  for (let i = 0; i < mimeLength; i++) mime += String.fromCharCode(b[i]);
  const descLength = be32(b, mimeLength);

  // description, then width/height/depth/colours (4 bytes each), then data length
  const lengthAt = body + 8 + mimeLength + 4 + descLength + 16;
  if (lengthAt + 4 > body + blockLength) return null;
  b = await reader.read(lengthAt, 4);
  if (b.length < 4) return null;
  const dataLength = be32(b, 0);
  const offset = lengthAt + 4;
  if (dataLength === 0 || offset + dataLength > body + blockLength || offset + dataLength > reader.size) return null;
  if (mime === '-->') return null; // the "picture" is a URL, not image data
  return { type, mime: mime || 'image/jpeg', offset, length: dataLength };
}

/**
 * Parses a Vorbis comment packet (as stored in a FLAC VORBIS_COMMENT block).
 * Keys are upper-cased; every key maps to the list of its values in file order.
 */
export function parseVorbisComment(b, tags = {}) {
  if (b.length < 8) return tags;
  let p = 4 + le32(b, 0); // skip the vendor string
  if (p + 4 > b.length) return tags;
  const count = le32(b, p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= b.length; i++) {
    const len = le32(b, p);
    p += 4;
    if (p + len > b.length) break;
    if (len <= MAX_COMMENT_VALUE) {
      const eq = b.indexOf(0x3d, p);
      if (eq > p && eq < p + len) {
        let key = '';
        for (let k = p; k < eq; k++) key += String.fromCharCode(b[k]);
        key = key.toUpperCase();
        const value = utf8.decode(b.subarray(eq + 1, p + len)).trim();
        if (value) (tags[key] ??= []).push(value);
      }
    }
    p += len;
  }
  return tags;
}
