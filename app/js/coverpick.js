// Decides where an album's cover art should come from. Pure logic; the actual
// image loading and thumbnailing happens in covers.js.

import { dirOf } from './tags.js';

/** @import { TrackRecord } from './tags.js' */

const PREFERRED_NAME = /^(cover|folder|front|album|albumart|artwork)/i;
const DISC_FOLDER = /(^|\/)(cd|disc|disk)[\s._-]*\d+$/i;

/**
 * Candidates in order of preference:
 *   1. a conventionally named image in the album's folder (cover.jpg, folder.jpg, ...)
 *   2. the picture embedded in one of the album's tracks
 *   3. the only image in the album's folder, whatever it is called
 *
 * @param {{tracks: TrackRecord[]}} album
 * @param {Map<string, string[]>} images directory path -> image file names
 * @returns {Array<{type: 'file', path: string} | {type: 'embedded', path: string, offset: number, length: number, mime: string}>}
 */
export function coverCandidates(album, images) {
  const dirs = [];
  for (const t of album.tracks) {
    const dir = dirOf(t.path);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  // For "Album/CD1/..." the cover usually sits in "Album/".
  for (const dir of dirs.slice()) {
    if (DISC_FOLDER.test(dir)) {
      const parent = dirOf(dir);
      if (!dirs.includes(parent)) dirs.push(parent);
    }
  }
  const join = (dir, name) => (dir ? dir + '/' + name : name);

  const out = [];
  for (const dir of dirs) {
    const names = (images.get(dir) ?? []).filter((n) => PREFERRED_NAME.test(n)).sort();
    for (const name of names) out.push({ type: 'file', path: join(dir, name) });
  }
  const withPicture = album.tracks.find((t) => t.pic);
  if (withPicture) {
    const { o, l, m } = withPicture.pic;
    out.push({ type: 'embedded', path: withPicture.path, offset: o, length: l, mime: m });
  }
  for (const dir of dirs) {
    const names = images.get(dir) ?? [];
    if (names.length === 1 && !PREFERRED_NAME.test(names[0])) out.push({ type: 'file', path: join(dir, names[0]) });
  }
  return out;
}
