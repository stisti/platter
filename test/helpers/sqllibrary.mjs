// A small library for the SQL tests: albums across decades and genre
// families, a compilation with a guest, a two-disc set, a duplicate copy and
// a track that takes its album from its folder neighbours.

import { makeTrack } from '../../app/js/tags.js';

/** A track record from a path plus tag overrides (as test/library.test.mjs does). */
export function track(path, tags = {}, { mtime = 1, duration = 200, size = 1000 } = {}) {
  const asLists = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]]));
  return makeTrack(path, { size, mtime }, { tags: asLists, duration, picture: null });
}

const song = (artist, album, year, genre, n, title, extra = {}) =>
  ({ ARTIST: artist, ALBUM: album, DATE: year, GENRE: genre, TRACKNUMBER: n, TITLE: title, ...extra });

export function sqlLibraryRecords() {
  return [
    track('Bruce Springsteen/Born to Run/01.flac', song('Bruce Springsteen', 'Born to Run', 1975, 'Rock', 1, 'Thunder Road'), { mtime: 100 }),
    track('Bruce Springsteen/Born to Run/02.flac', song('Bruce Springsteen', 'Born to Run', 1975, 'Rock', 2, 'Tenth Avenue Freeze-Out'), { mtime: 100 }),
    track('Bruce Springsteen/Born in the U.S.A/01.flac', song('Bruce Springsteen', 'Born in the U.S.A.', 1984, 'Classic Rock', 1, 'Born in the U.S.A.'), { mtime: 200 }),
    track('Bruce Springsteen/Born in the U.S.A/02.flac', song('Bruce Springsteen', 'Born in the U.S.A.', 1984, 'Classic Rock', 2, 'Cover Me'), { mtime: 200 }),
    // The same song again, bought as AAC: a duplicate the library leaves out.
    track('iTunes/Bruce Springsteen/Born in the U.S.A/02 Cover Me.m4a', song('Bruce Springsteen', 'Born in the U.S.A.', 1984, 'Classic Rock', 2, 'Cover Me'), { mtime: 50, size: 10 }),
    track('Bruce Springsteen/Devils & Dust/01.flac', song('Bruce Springsteen', 'Devils & Dust', 2005, 'Contemporary Folk', 1, 'Devils & Dust'), { mtime: 300 }),

    track('a-ha/Hunting High and Low/01.flac', song('a-ha', 'Hunting High and Low', 1985, ['New Wave', 'Synth Pop'], 1, 'Take On Me'), { mtime: 400 }),
    // A Windows Media Player stand-in: it takes album, year and genre from its neighbours.
    track('a-ha/Hunting High and Low/02.flac', { TITLE: 'Raita 2', ARTIST: 'Tuntematon esittäjä', ALBUM: 'Tuntematon albumi (26.9.2024 0.59.52)', GENRE: 'Tuntematon tyylilaji', TRACKNUMBER: 2 }, { mtime: 400 }),
    track('a-ha/Hunting High and Low/03.flac', song('a-ha', 'Hunting High and Low', 1985, ['New Wave', 'Synth Pop'], 3, 'Train of Thought'), { mtime: 400 }),

    track('Nightwish/Oceanborn/01.flac', song('Nightwish', 'Oceanborn', 1998, 'Metal & Hard Rock', 1, 'Stargazers'), { mtime: 500 }),
    track('Vangelis/Chariots of Fire/01.flac', song('Vangelis', 'Chariots of Fire', 1981, 'Soundtrackit', 1, 'Titles'), { mtime: 600 }),

    // A compilation: no album artist, different artists in one folder.
    track('Compilations/Eighties/01.flac', song('Alphaville', 'Eighties', 1988, 'Pop', 1, 'Forever Young'), { mtime: 700 }),
    track('Compilations/Eighties/02.flac', song('Bruce Springsteen', 'Eighties', 1988, 'Rock', 2, 'Dancing in the Dark'), { mtime: 700 }),

    // Two discs.
    track('Mike Oldfield/Incantations/CD1/01.flac', song('Mike Oldfield', 'Incantations', 1978, 'Progressive', 1, 'Part One', { DISCNUMBER: 1 }), { mtime: 800 }),
    track('Mike Oldfield/Incantations/CD2/01.flac', song('Mike Oldfield', 'Incantations', 1978, 'Progressive', 1, 'Part Three', { DISCNUMBER: 2 }), { mtime: 800 }),
  ];
}

/** Songs in the library (the duplicate left out). */
export const SQL_LIBRARY_SONGS = 14;
