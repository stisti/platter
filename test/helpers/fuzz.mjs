// Fuzzing the tag readers: a corpus of well-formed files of each kind, and a
// mutator that damages them the way the parsers are most likely to trip on
// (bytes in the metadata at the head of the file, ID3 flag bytes, truncation).
// Used by test/parsers-fuzz.test.mjs and scripts/fuzz-parsers.mjs.

import { TINY_PNG, buildFlac, buildId3v1, buildId3v2, buildM4a, concat, mpegFrame } from './media.mjs';

/** A small deterministic random number generator, so a failure can be reproduced from its seed. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (list) => list[Math.floor(next() * list.length)] };
}

const jpeg = new Uint8Array(300).fill(0xd8);
const FRAMES = [
  { id: 'TIT2', text: 'Title' },
  { id: 'TPE1', text: 'Artist', encoding: 1 },
  { id: 'TALB', text: 'Album', encoding: 3 },
  { id: 'TRCK', text: '3/12' },
  { id: 'TCON', text: '(17)' },
  { id: 'TDOR', text: '1977-01-02' },
  { id: 'TXXX', text: 'ignored' },
];
const V22_FRAMES = [{ id: 'TT2', text: 'Title' }, { id: 'TP1', text: 'Artist' }, { id: 'TCO', text: '(17)Rock' }];

/** Well-formed files of each kind, covering the features each parser reads. */
export function seedFiles() {
  const mp3 = [];
  for (const version of [2, 3, 4]) {
    for (const xingFrames of [null, 1234]) {
      for (const picture of [null, { data: jpeg, type: 3 }, { data: TINY_PNG, mime: 'image/png', type: 0 }]) {
        const tag = buildId3v2({ version, frames: version === 2 ? V22_FRAMES : FRAMES, picture });
        mp3.push(concat([tag, new Uint8Array(version * 7), mpegFrame({ xingFrames }), new Uint8Array(2000)]));
      }
    }
  }
  mp3.push(concat([mpegFrame(), new Uint8Array(500), buildId3v1({ title: 'T', artist: 'A', track: 4, genre: 17 })]));

  const flac = [
    buildFlac({ tags: { TITLE: 'a', ARTIST: ['b', 'c'] }, sampleRate: 44100, totalSamples: 441000 }),
    buildFlac({ tags: { TITLE: 'a' }, pictures: [{ type: 0, data: jpeg }, { type: 3, data: TINY_PNG, mime: 'image/png' }], padding: 100 }),
    buildFlac({ tags: { TITLE: 'a' }, pictures: [{ type: 3, data: jpeg }], picturesFirst: true }),
    buildFlac({ playable: true, tags: { ALBUM: 'x' }, prefix: buildId3v2({ frames: FRAMES }) }),
  ];

  const mp4 = [
    buildM4a({ tags: { TITLE: 't', ARTIST: 'a', GENRE: 'Rock' }, track: [3, 12], disc: [1, 2], compilation: true, cover: { data: jpeg } }),
    buildM4a({ genreId: 18, freeform: { ORIGINALDATE: '1970' }, track: [5, 0], cover: { png: true, data: TINY_PNG }, moovLast: true }),
    buildM4a({ tags: { TITLE: 'x' }, genreId: 18, codec: 'alac', wideAudio: true }),
  ];
  return { mp3, flac, mp4 };
}

const INTERESTING_BYTES = [0x00, 0xff, 0x01, 0x02, 0x03, 0x04, 0x06, 0x7f, 0x80, 0x40, 0xc0, 0x0c];
const ID3_TAG_FLAGS = [0x00, 0x10, 0x40, 0x80, 0xc0, 0xd0];
const ID3_FRAME_FLAGS = [0x00, 0x01, 0x02, 0x03, 0x04, 0x08, 0x40, 0x80];

/**
 * A damaged copy of `bytes`: a few bytes overwritten (mostly near the head,
 * where the metadata is), for MP3 sometimes the ID3 tag and first frame flags
 * set, and sometimes cut short.
 *
 * @param {Uint8Array} bytes
 * @param {'mp3'|'flac'|'mp4'} kind
 * @param {ReturnType<typeof seededRandom>} random
 */
export function mutate(bytes, kind, random) {
  const b = bytes.slice();
  const count = 1 + random.int(6);
  for (let i = 0; i < count; i++) {
    const at = random.next() < 0.8 ? random.int(Math.min(b.length, 200)) : random.int(b.length);
    b[at] = random.next() < 0.5 ? random.int(256) : random.pick(INTERESTING_BYTES);
  }
  if (kind === 'mp3' && b[0] === 0x49 && random.next() < 0.5) b[5] = random.pick(ID3_TAG_FLAGS);
  if (kind === 'mp3' && random.next() < 0.3) b[19] = random.pick(ID3_FRAME_FLAGS); // first frame's format flags
  return random.next() < 0.1 ? b.subarray(0, random.int(b.length)) : b;
}

/**
 * The seed files of each kind followed by `rounds` damaged copies of them.
 *
 * @param {number} rounds
 * @param {number} seed
 * @returns {Record<'mp3'|'flac'|'mp4', Uint8Array[]>}
 */
export function fuzzCorpus(rounds, seed) {
  const random = seededRandom(seed);
  const seeds = seedFiles();
  const corpus = {};
  for (const [kind, files] of Object.entries(seeds)) {
    corpus[kind] = [...files];
    for (let i = 0; i < rounds; i++) corpus[kind].push(mutate(random.pick(files), /** @type {any} */ (kind), random));
  }
  return /** @type {any} */ (corpus);
}
