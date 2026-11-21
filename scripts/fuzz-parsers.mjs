#!/usr/bin/env node
// Differential fuzzing of the tag readers: do the FLAC, MP3 and M4A parsers of
// the working tree read every file exactly as those of an earlier commit do?
// Run it after refactoring a parser; any difference is a change in behaviour.
//
//   node scripts/fuzz-parsers.mjs [--ref main] [--rounds 5000] [--seed 1]
//
// The corpus is test/helpers/fuzz.mjs: well-formed files plus damaged copies.
// Exits 1 when the two versions disagree on any file, printing the first few.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { BlobReader } from '../app/js/bytes.js';
import * as flac from '../app/js/flac.js';
import * as id3 from '../app/js/id3.js';
import * as mp4 from '../app/js/mp4.js';
import { fuzzCorpus } from '../test/helpers/fuzz.mjs';

const { values: args } = parseArgs({
  options: {
    ref: { type: 'string', default: 'main' },
    rounds: { type: 'string', default: '5000' },
    seed: { type: 'string', default: '1' },
  },
});

/** The parser modules as they are at `ref`, copied to a temporary folder (they import only each other). */
async function parsersAt(ref, dir) {
  for (const name of ['bytes', 'id3', 'flac', 'mp4']) {
    const source = execFileSync('git', ['show', `${ref}:app/js/${name}.js`], { encoding: 'utf8' });
    writeFileSync(join(dir, `${name}.js`), source);
  }
  const load = (name) => import(pathToFileURL(join(dir, `${name}.js`)).href);
  return { id3: await load('id3'), flac: await load('flac'), mp4: await load('mp4') };
}

/** What a parser makes of a file, as comparable text: its result or its error. */
async function outcome(parse, bytes) {
  try {
    return JSON.stringify(await parse(new BlobReader(new Blob([bytes]))));
  } catch (err) {
    return `throws ${err?.name}: ${err?.message}`;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'platter-fuzz-'));
try {
  const before = await parsersAt(args.ref, dir);
  const now = { id3, flac, mp4 };
  const parsers = { mp3: ['id3', 'parseMp3'], flac: ['flac', 'parseFlac'], mp4: ['mp4', 'parseMp4'] };
  const corpus = fuzzCorpus(Number(args.rounds), Number(args.seed));

  let checked = 0;
  let differ = 0;
  for (const [kind, [module, name]] of Object.entries(parsers)) {
    for (const [i, bytes] of corpus[kind].entries()) {
      const was = await outcome(before[module][name], bytes);
      const is = await outcome(now[module][name], bytes);
      checked++;
      if (was === is) continue;
      differ++;
      if (differ <= 5) console.log(`${kind} #${i} differs\n  ${args.ref}: ${was}\n  now: ${is}`);
    }
  }
  console.log(`${checked} files, ${differ} read differently than at ${args.ref} (seed ${args.seed})`);
  process.exitCode = differ ? 1 : 0;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
