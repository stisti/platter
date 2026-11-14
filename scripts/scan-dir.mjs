#!/usr/bin/env node
// Runs Platter's own tag reader and library builder over a folder on disk and
// prints what the app would make of it. Useful for checking how a real music
// collection is interpreted (odd tags, compilations, missing covers) without
// opening the app.
//
//   node scripts/scan-dir.mjs /path/to/music            summary
//   node scripts/scan-dir.mjs /path/to/music --albums   also list every album
//
// On a Chromebook the USB drive is only visible here after sharing it with
// Linux: Files app -> right-click the drive -> "Share with Linux". It then
// appears under /mnt/chromeos/removable/ (or /mnt/shared/ on newer systems).

import { openAsBlob } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, PROTECTED_EXTENSIONS, extensionOf, readTrack } from '../app/js/tags.js';
import { buildLibrary } from '../app/js/library.js';
import { coverCandidates } from '../app/js/coverpick.js';

const [root, ...flags] = process.argv.slice(2);
if (!root || root.startsWith('-')) {
  console.error('usage: node scripts/scan-dir.mjs <music folder> [--albums]');
  process.exit(2);
}

// File names and tag text come from the drive and may hold terminal escape
// sequences. Show C0/C1 control characters as U+FFFD instead of printing them.
const printable = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '\uFFFD');

const files = [];
let protectedFiles = 0;
const images = new Map();
const unreadable = [];
async function walk(dir, rel) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    unreadable.push(`${rel || '.'}: ${err.code ?? err.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || /^(\$RECYCLE\.BIN|System Volume Information|lost\+found|@eaDir)$/i.test(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(join(dir, entry.name), path);
    else if (AUDIO_EXTENSIONS.has(extensionOf(entry.name))) files.push(path);
    else if (PROTECTED_EXTENSIONS.has(extensionOf(entry.name))) protectedFiles++;
    else if (IMAGE_EXTENSIONS.has(extensionOf(entry.name))) {
      if (!images.has(rel)) images.set(rel, []);
      images.get(rel).push(entry.name);
    }
  }
}

const started = performance.now();
await walk(root, '');
const walked = performance.now();
console.log(`Found ${files.length.toLocaleString()} audio files in ${((walked - started) / 1000).toFixed(1)} s. Reading tags…`);

const tracks = [];
let failed = 0;
for (const [i, path] of files.entries()) {
  try {
    const blob = await openAsBlob(join(root, path));
    const record = await readTrack(blob, path);
    if (record) tracks.push(record);
    else protectedFiles++;
  } catch (err) {
    failed++;
    if (failed <= 10) console.warn(`  could not read ${printable(path)}: ${printable(err.message)}`);
  }
  if ((i + 1) % 500 === 0) process.stdout.write(`  ${i + 1}\r`);
}
const read = performance.now();
const lib = buildLibrary(tracks);

const count = (list, test) => list.filter(test).length;
const all = [...lib.tracks.values()].filter((t) => !t._dup);
const albums = lib.sortedAlbums;
const withCover = count(albums, (a) => coverCandidates(a, images).length > 0);
const formats = new Map();
for (const t of all) formats.set(t.fmt, (formats.get(t.fmt) ?? 0) + 1);
const hours = all.reduce((sum, t) => sum + (t.duration ?? 0), 0) / 3600;

console.log(`
Tags read in ${((read - walked) / 1000).toFixed(1)} s (${failed} unreadable).

  Songs    ${all.length.toLocaleString()}   (${[...formats].map(([f, n]) => `${n.toLocaleString()} ${f}`).join(', ')})
  Albums   ${albums.length.toLocaleString()}   (${withCover.toLocaleString()} with cover art)
  Artists  ${lib.sortedArtists.length.toLocaleString()}
  Genres   ${lib.sortedGenres.length.toLocaleString()}
  Playtime ${hours.toFixed(1)} hours

  Duplicate copies left out                  ${lib.duplicates.toLocaleString()}
  Copy-protected files left out              ${protectedFiles.toLocaleString()}
  Songs placed by folder, not by tags        ${count(all, (t) => t.guessed?.includes('album')).toLocaleString()}
  FLAC files whose tags could not be read    ${count(all, (t) => !t.duration && t.fmt === 'flac').toLocaleString()}
  Songs without a genre                      ${count(all, (t) => !t.genres.length).toLocaleString()}
  Songs without a known length               ${count(all, (t) => !t.duration).toLocaleString()}
  Albums without a year                      ${count(albums, (a) => !a.year).toLocaleString()}
  Albums filed under "Various Artists"       ${count(albums, (a) => a.artist === 'Various Artists').toLocaleString()}
`);
if (unreadable.length) console.log(`Unreadable folders:\n  ${unreadable.slice(0, 20).map(printable).join('\n  ')}\n`);

const top = (title, items, describe) => {
  console.log(title);
  for (const item of items) console.log(`  ${printable(describe(item))}`);
  console.log('');
};
top('Largest genres:', [...lib.sortedGenres].sort((a, b) => b.tracks.length - a.tracks.length).slice(0, 15), (g) => `${String(g.tracks.length).padStart(6)}  ${g.name}`);
top('Artists with the most albums:', [...lib.sortedArtists].sort((a, b) => b.albums.length - a.albums.length).slice(0, 15), (a) => `${String(a.albums.length).padStart(6)}  ${a.name}`);

if (flags.includes('--albums')) {
  top('Albums:', albums, (a) => `${a.artist} — ${a.title}${a.year ? ` (${a.year})` : ''}  [${a.tracks.length} ${a.tracks.length === 1 ? 'track' : 'tracks'}${a.discCount > 1 ? `, ${a.discCount} discs` : ''}${coverCandidates(a, images).length ? '' : ', no cover'}]`);
}
