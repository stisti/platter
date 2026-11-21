// Damaged files must not break the tag readers: each one either reads the file
// into a well-formed result or rejects it with its own "not this kind of file"
// error - never a stray TypeError or RangeError, and never a cover outside
// the file. (scripts/fuzz-parsers.mjs checks the same corpus for changes in
// behaviour against an earlier version.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BlobReader } from '../app/js/bytes.js';
import { parseFlac } from '../app/js/flac.js';
import { parseMp3 } from '../app/js/id3.js';
import { parseMp4 } from '../app/js/mp4.js';
import { fuzzCorpus } from './helpers/fuzz.mjs';

const ROUNDS = 1500;
const SEED = 20261121;

const PARSERS = {
  mp3: { parse: parseMp3, rejects: [] },
  flac: { parse: parseFlac, rejects: ['Not a FLAC file'] },
  mp4: { parse: parseMp4, rejects: ['Not an MP4 file', 'MP4 file without a movie box'] },
};

const corpus = fuzzCorpus(ROUNDS, SEED);

function checkResult(meta, size, where) {
  for (const [key, values] of Object.entries(meta.tags)) {
    assert.ok(Array.isArray(values) && values.length > 0, `${where}: tag ${key} is a non-empty list`);
    for (const v of values) assert.ok(typeof v === 'string' && v !== '', `${where}: tag ${key} has a string value`);
  }
  if (meta.duration !== null) {
    assert.ok(Number.isFinite(meta.duration) && meta.duration > 0, `${where}: duration ${meta.duration}`);
  }
  if (meta.picture !== null) {
    const { offset, length, mime } = meta.picture;
    assert.ok(Number.isInteger(offset) && offset >= 0, `${where}: picture offset ${offset}`);
    assert.ok(Number.isInteger(length) && length > 0, `${where}: picture length ${length}`);
    assert.ok(offset + length <= size, `${where}: picture ends at ${offset + length}, past the file (${size})`);
    assert.equal(typeof mime, 'string', `${where}: picture mime`);
  }
}

for (const [kind, { parse, rejects }] of Object.entries(PARSERS)) {
  test(`fuzz ${kind}: damaged files give a well-formed result or the parser's own error`, async () => {
    const files = corpus[kind];
    for (const [i, bytes] of files.entries()) {
      const where = `${kind} #${i} (seed ${SEED})`;
      let meta;
      try {
        meta = await parse(new BlobReader(new Blob([bytes])));
      } catch (err) {
        assert.ok(rejects.includes(err?.message), `${where}: unexpected ${err?.stack ?? err}`);
        continue;
      }
      checkResult(meta, bytes.length, where);
    }
  });
}
