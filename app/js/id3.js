// MP3 metadata reader: ID3v2.2/2.3/2.4 (with an ID3v1 fallback) and a duration
// estimate from the first MPEG frame. Tags are returned under the same key
// names the FLAC reader uses so the rest of the app treats both alike.

import { be24, be32, latin1, syncsafe } from './bytes.js';

const FRAME_MAP = {
  TIT2: 'TITLE', TT2: 'TITLE',
  TPE1: 'ARTIST', TP1: 'ARTIST',
  TPE2: 'ALBUMARTIST', TP2: 'ALBUMARTIST',
  TALB: 'ALBUM', TAL: 'ALBUM',
  TRCK: 'TRACKNUMBER', TRK: 'TRACKNUMBER',
  TPOS: 'DISCNUMBER', TPA: 'DISCNUMBER',
  TCON: 'GENRE', TCO: 'GENRE',
  TDRC: 'DATE', TYER: 'DATE', TYE: 'DATE',
  TDOR: 'ORIGINALDATE', TORY: 'ORIGINALYEAR', TOR: 'ORIGINALYEAR',
  TCMP: 'COMPILATION', TCP: 'COMPILATION',
};

const MAX_TEXT_FRAME = 8192;

// prettier-ignore
export const ID3_GENRES = ['Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge','Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B','Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska','Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient','Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical','Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise','Alternative Rock','Bass','Soul','Punk','Space','Meditative','Instrumental Pop','Instrumental Rock','Ethnic','Gothic','Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance','Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40','Christian Rap','Pop/Funk','Jungle','Native American','Cabaret','New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi','Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical','Rock & Roll','Hard Rock','Folk','Folk-Rock','National Folk','Swing','Fast Fusion','Bebop','Latin','Revival','Celtic','Bluegrass','Avantgarde','Gothic Rock','Progressive Rock','Psychedelic Rock','Symphonic Rock','Slow Rock','Big Band','Chorus','Easy Listening','Acoustic','Humour','Speech','Chanson','Opera','Chamber Music','Sonata','Symphony','Booty Bass','Primus','Porn Groove','Satire','Slow Jam','Club','Tango','Samba','Folklore','Ballad','Power Ballad','Rhythmic Soul','Freestyle','Duet','Punk Rock','Drum Solo','A Cappella','Euro-House','Dance Hall','Goa','Drum & Bass','Club-House','Hardcore','Terror','Indie','BritPop','Afro-Punk','Polsk Punk','Beat','Christian Gangsta Rap','Heavy Metal','Black Metal','Crossover','Contemporary Christian','Christian Rock','Merengue','Salsa','Thrash Metal','Anime','JPop','Synthpop'];

/**
 * @param {{size: number, read(offset: number, length: number): Promise<Uint8Array>}} reader
 */
export async function parseMp3(reader) {
  const out = { tags: {}, duration: null, picture: null };
  let audioStart = 0;

  const h = await reader.read(0, 10);
  const hasV2 = h.length >= 10 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33;
  if (hasV2) {
    const major = h[3];
    const flags = h[5];
    const tagEnd = Math.min(10 + syncsafe(h, 6), reader.size);
    audioStart = tagEnd + (flags & 0x10 ? 10 : 0);
    if (major >= 2 && major <= 4) await readFrames(reader, major, flags, tagEnd, out);
  }
  if (!hasV2 || Object.keys(out.tags).length === 0) await readId3v1(reader, out.tags);

  if (out.tags.GENRE) out.tags.GENRE = out.tags.GENRE.flatMap(resolveGenre);
  out.duration = await estimateDuration(reader, audioStart);
  return out;
}

async function readFrames(reader, major, tagFlags, tagEnd, out) {
  const tagUnsync = (tagFlags & 0x80) !== 0;
  let pos = await firstFramePos(reader, major, tagFlags);
  if (pos === null) return;
  let pictureType = -1;

  for (let frame; (frame = await readFrameHeader(reader, pos, major, tagEnd)); pos = frame.end) {
    const body = frameBody(frame, major, tagUnsync);
    if (!body) continue;
    if (FRAME_MAP[body.id]) {
      await readTextFrame(reader, body, out.tags);
    } else if ((body.id === 'APIC' || body.id === 'PIC') && !body.unsync) {
      const pic = await readPictureFrame(reader, body);
      // Prefer the front cover; otherwise keep the first picture found.
      if (pic && (out.picture === null || (pic.type === 3 && pictureType !== 3))) {
        out.picture = { offset: pic.offset, length: pic.length, mime: pic.mime };
        pictureType = pic.type;
      }
    }
  }
}

/** Where the first frame starts: after the tag header and any extended header. Null when the tag is cut short. */
async function firstFramePos(reader, major, tagFlags) {
  if (major < 3 || !(tagFlags & 0x40)) return 10;
  const e = await reader.read(10, 4);
  if (e.length < 4) return null;
  return 10 + (major === 4 ? syncsafe(e, 0) : be32(e, 0) + 4);
}

/** Frame header layout by ID3v2 major version. */
const FRAME_HEADERS = {
  2: { idLength: 3, headerLength: 6, size: (fh) => be24(fh, 3), flags: () => 0 },
  3: { idLength: 4, headerLength: 10, size: (fh) => be32(fh, 4), flags: (fh) => fh[9] },
  4: { idLength: 4, headerLength: 10, size: (fh) => syncsafe(fh, 4), flags: (fh) => fh[9] },
};

/**
 * Reads the frame header at `pos`. Null where the frames end: at the padding,
 * at something that is not a frame, or at a frame that runs past the tag.
 */
async function readFrameHeader(reader, pos, major, tagEnd) {
  const layout = FRAME_HEADERS[major];
  if (pos + layout.headerLength > tagEnd) return null;
  const fh = await reader.read(pos, layout.headerLength);
  if (fh.length < layout.headerLength || fh[0] === 0) return null; // reached the padding
  const id = latin1(fh.subarray(0, layout.idLength));
  if (!/^[A-Z0-9]+$/.test(id)) return null;
  const size = layout.size(fh);
  const dataPos = pos + layout.headerLength;
  const end = dataPos + size;
  if (size === 0 || end > tagEnd) return null;
  return { id, formatFlags: layout.flags(fh), dataPos, size, end };
}

/**
 * Where a frame's data is and whether it is unsynchronised, after its format
 * flags. Null for a frame that cannot be read: compressed, encrypted or empty.
 */
function frameBody(frame, major, tagUnsync) {
  const { id, formatFlags } = frame;
  let { dataPos, size: dataLength } = frame;
  let unsync = tagUnsync;
  if (major === 4) {
    if (formatFlags & 0x0c) return null; // compressed or encrypted
    if (formatFlags & 0x02) unsync = true;
    if (formatFlags & 0x01) { dataPos += 4; dataLength -= 4; } // data length indicator
  } else if (major === 3 && formatFlags & 0xc0) {
    return null; // compressed or encrypted
  }
  return dataLength > 0 ? { id, dataPos, dataLength, unsync } : null;
}

async function readTextFrame(reader, body, tags) {
  if (body.dataLength > MAX_TEXT_FRAME) return;
  let d = await reader.read(body.dataPos, body.dataLength);
  if (body.unsync) d = removeUnsync(d);
  const key = FRAME_MAP[body.id];
  for (const value of decodeText(d)) (tags[key] ??= []).push(value);
}

/** An APIC (or v2.2 PIC) frame: where its image data is, or null. */
async function readPictureFrame(reader, body) {
  const d = await reader.read(body.dataPos, Math.min(body.dataLength, 512));
  const pic = parsePictureHeader(d, body.id === 'PIC');
  if (!pic || pic.headerLength >= body.dataLength) return null;
  return {
    type: pic.type,
    offset: body.dataPos + pic.headerLength,
    length: body.dataLength - pic.headerLength,
    mime: pic.mime,
  };
}

function removeUnsync(d) {
  const out = new Uint8Array(d.length);
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    out[n++] = d[i];
    if (d[i] === 0xff && d[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decoderFor(encoding, bytes) {
  if (encoding === 1) {
    // UTF-16 with a byte order mark (little-endian assumed when it is missing)
    const be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
    return new TextDecoder(be ? 'utf-16be' : 'utf-16le');
  }
  if (encoding === 2) return new TextDecoder('utf-16be');
  if (encoding === 3) return new TextDecoder('utf-8');
  return new TextDecoder('windows-1252'); // what "ISO-8859-1" means in practice
}

/** Decodes an ID3 text frame body into its (usually single) list of values. */
function decodeText(d) {
  if (d.length < 2) return [];
  const body = d.subarray(1);
  const text = decoderFor(d[0], body).decode(body);
  return text.split('\u0000').map((s) => s.replace(/^﻿/, '').trim()).filter(Boolean);
}

function parsePictureHeader(d, isV22) {
  if (d.length < 6) return null;
  const encoding = d[0];
  let p = 1;
  let mime;
  if (isV22) {
    const format = latin1(d.subarray(1, 4)).toUpperCase();
    mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const end = d.indexOf(0, p);
    if (end < 0) return null;
    mime = latin1(d.subarray(p, end)).toLowerCase();
    if (mime === '-->') return null;
    if (!mime.includes('/')) mime = mime === 'png' ? 'image/png' : 'image/jpeg';
    p = end + 1;
  }
  if (p >= d.length) return null;
  const type = d[p++];
  // skip the description, which is terminated by a NUL in the frame's encoding
  if (encoding === 1 || encoding === 2) {
    while (p + 1 < d.length && (d[p] !== 0 || d[p + 1] !== 0)) p += 2;
    p += 2;
  } else {
    while (p < d.length && d[p] !== 0) p++;
    p += 1;
  }
  if (p > d.length) return null;
  return { type, mime, headerLength: p };
}

/** "(17)", "17" and "(17)Rock" are all ways ID3 spells a genre. */
function resolveGenre(value) {
  const numeric = /^\(?(\d{1,3})\)?$/.exec(value);
  if (numeric) return [ID3_GENRES[Number(numeric[1])] ?? value];
  const prefixed = /^\((\d{1,3})\)(.+)$/.exec(value);
  if (prefixed) return [prefixed[2].trim()];
  return [value];
}

async function readId3v1(reader, tags) {
  if (reader.size < 128) return;
  const b = (await reader.read(reader.size - 128, 128)).slice();
  if (b.length < 128 || b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return;
  const dec = new TextDecoder('windows-1252');
  const field = (start, length) => {
    let end = start;
    while (end < start + length && b[end] !== 0) end++;
    return dec.decode(b.subarray(start, end)).trim();
  };
  const set = (key, value) => { if (value) tags[key] = [value]; };
  set('TITLE', field(3, 30));
  set('ARTIST', field(33, 30));
  set('ALBUM', field(63, 30));
  set('DATE', field(93, 4));
  if (b[125] === 0 && b[126] !== 0) set('TRACKNUMBER', String(b[126]));
  if (b[127] < ID3_GENRES.length) set('GENRE', ID3_GENRES[b[127]]);
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Duration from the Xing/Info header when present (accurate for VBR), else
 * from the first frame's bitrate (accurate for CBR). Null when no MPEG
 * layer III frame is found near the start of the audio.
 */
async function estimateDuration(reader, audioStart) {
  const b = (await reader.read(audioStart, 4096)).slice();
  for (let i = 0; i + 4 <= b.length; i++) {
    const frame = mpegFrameHeader(b, i);
    if (!frame) continue;
    const frames = xingFrameCount(b, i + 4 + frame.sideInfo);
    if (frames) return (frames * frame.samplesPerFrame) / frame.sampleRate;
    const audioBytes = reader.size - (audioStart + i);
    return audioBytes > 0 ? (audioBytes * 8) / frame.bitrate : null;
  }
  return null;
}

/** The MPEG layer III frame header at `i`, or null when there is none. */
function mpegFrameHeader(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = layer III
  const bitrateIndex = b[i + 2] >> 4;
  const rateIndex = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const mono = (b[i + 3] >> 6) === 3;
  return {
    sampleRate: SAMPLE_RATES[version][rateIndex],
    bitrate: (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    sideInfo: SIDE_INFO_LENGTH[mpeg1 ? 'mpeg1' : 'mpeg2'][mono ? 'mono' : 'stereo'],
  };
}

const SIDE_INFO_LENGTH = { mpeg1: { mono: 17, stereo: 32 }, mpeg2: { mono: 9, stereo: 17 } };

/** The frame count of a Xing/Info header at `x`, or null when there is none. */
function xingFrameCount(b, x) {
  if (x + 12 > b.length) return null;
  const marker = latin1(b.subarray(x, x + 4));
  if ((marker !== 'Xing' && marker !== 'Info') || !(b[x + 7] & 0x01)) return null;
  const frames = be32(b, x + 8);
  return frames > 0 ? frames : null;
}
