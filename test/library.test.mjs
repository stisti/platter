import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLibrary, searchLibrary, toRecord, keyOf, VARIOUS_ARTISTS } from '../app/js/library.js';
import { coverCandidates } from '../app/js/coverpick.js';
import { makeTrack } from '../app/js/tags.js';

/** Shorthand: a track record from a path plus tag overrides. */
function track(path, tags = {}, extra = {}) {
  const asLists = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, Array.isArray(v) ? v : [String(v)]]));
  return { ...makeTrack(path, { size: 1, mtime: extra.mtime ?? 1 }, { tags: asLists, duration: extra.duration ?? 100, picture: extra.picture ?? null }) };
}

const titles = (list) => list.map((x) => x.title ?? x.name);

test('groups tracks into albums and orders them by disc, then track number', () => {
  const lib = buildLibrary([
    track('PF/Wall/CD2/01.flac', { TITLE: 'Hey You', ARTIST: 'Pink Floyd', ALBUM: 'The Wall', DISCNUMBER: 2, TRACKNUMBER: 1 }),
    track('PF/Wall/CD1/02.flac', { TITLE: 'The Thin Ice', ARTIST: 'Pink Floyd', ALBUM: 'The Wall', DISCNUMBER: 1, TRACKNUMBER: 2 }),
    track('PF/Wall/CD1/01.flac', { TITLE: 'In the Flesh?', ARTIST: 'Pink Floyd', ALBUM: 'The Wall', DISCNUMBER: 1, TRACKNUMBER: 1 }),
    track('PF/Wall/CD1/10.flac', { TITLE: 'One of My Turns', ARTIST: 'Pink Floyd', ALBUM: 'The Wall', DISCNUMBER: 1, TRACKNUMBER: 10 }),
  ]);
  assert.equal(lib.albums.size, 1, 'both discs are one album even though they live in different folders');
  const [album] = lib.albums.values();
  assert.deepEqual(titles(album.tracks), ['In the Flesh?', 'The Thin Ice', 'One of My Turns', 'Hey You']);
  assert.equal(album.discCount, 2);
  assert.equal(album.duration, 400);
  assert.equal(album.artist, 'Pink Floyd');
});

test('album identity ignores case and stray whitespace, but separates same-named albums by artist', () => {
  const lib = buildLibrary([
    track('a/1.flac', { ARTIST: 'Weezer', ALBUM: 'Weezer', TITLE: 'a' }),
    track('a/2.flac', { ARTIST: 'weezer ', ALBUM: ' WEEZER', TITLE: 'b' }),
    track('b/1.flac', { ARTIST: 'Peter Gabriel', ALBUM: 'Greatest Hits', TITLE: 'c' }),
    track('c/1.flac', { ARTIST: 'Queen', ALBUM: 'Greatest Hits', TITLE: 'd' }),
  ]);
  assert.equal(lib.albums.size, 3);
  assert.equal(lib.artists.get('weezer').albums[0].tracks.length, 2);
});

test('compilations without an album-artist tag become one Various Artists album', () => {
  const lib = buildLibrary([
    track('Comp/01.flac', { ARTIST: 'Alpha', ALBUM: 'Now 1', TITLE: 'a', TRACKNUMBER: 1 }),
    track('Comp/02.flac', { ARTIST: 'Beta', ALBUM: 'Now 1', TITLE: 'b', TRACKNUMBER: 2 }),
    track('Comp/03.flac', { ARTIST: 'Gamma', ALBUM: 'Now 1', TITLE: 'c', TRACKNUMBER: 3 }),
    track('Alpha/Solo/01.flac', { ARTIST: 'Alpha', ALBUM: 'Solo', TITLE: 'own' }),
  ]);
  assert.equal(lib.albums.size, 2);
  const comp = [...lib.albums.values()].find((a) => a.title === 'Now 1');
  assert.equal(comp.artist, VARIOUS_ARTISTS);
  assert.equal(comp.tracks.length, 3);

  // Alpha has their own album, and also appears on the compilation.
  const alpha = lib.artists.get('alpha');
  assert.deepEqual(titles(alpha.albums), ['Solo']);
  assert.deepEqual(titles(alpha.appearsOn), ['Now 1']);
  assert.deepEqual(titles(alpha.tracks).sort(), ['a', 'own']);

  // Beta only appears as a guest: reachable, but not listed among the album artists.
  assert.ok(lib.artists.has('beta'));
  assert.deepEqual(titles(lib.sortedArtists), ['Alpha', VARIOUS_ARTISTS]);
});

test('"X" and "X feat. Y" on one album do not make it a compilation', () => {
  const lib = buildLibrary([
    track('d/1.flac', { ARTIST: 'Daft Punk', ALBUM: 'RAM', TITLE: 'a' }),
    track('d/2.flac', { ARTIST: 'Daft Punk feat. Pharrell Williams', ALBUM: 'RAM', TITLE: 'b' }),
    track('d/3.flac', { ARTIST: 'Daft Punk & Julian Casablancas', ALBUM: 'RAM', TITLE: 'c' }),
  ]);
  assert.equal(lib.albums.size, 1);
  assert.equal([...lib.albums.values()][0].artist, 'Daft Punk');
  // ...but an unrelated artist whose name merely starts the same is not folded in.
  const other = buildLibrary([
    track('e/1.flac', { ARTIST: 'Yes', ALBUM: 'Mix', TITLE: 'a' }),
    track('e/2.flac', { ARTIST: 'Yesterday', ALBUM: 'Mix', TITLE: 'b' }),
  ]);
  assert.equal([...other.albums.values()][0].artist, VARIOUS_ARTISTS);
});

test('an explicit album artist always wins', () => {
  const lib = buildLibrary([
    track('s/1.flac', { ARTIST: 'Guest One', ALBUMARTIST: 'Santana', ALBUM: 'Supernatural', TITLE: 'a' }),
    track('s/2.flac', { ARTIST: 'Guest Two', ALBUMARTIST: 'Santana', ALBUM: 'Supernatural', TITLE: 'b' }),
  ]);
  assert.equal(lib.albums.size, 1);
  assert.deepEqual(titles(lib.sortedArtists), ['Santana']);
  assert.equal(lib.artists.get('santana').tracks.length, 2);
  assert.deepEqual(titles(lib.artists.get('guest one').appearsOn), ['Supernatural']);
});

test('untagged files are grouped by their folders', () => {
  const lib = buildLibrary([
    track('Nick Drake/Pink Moon/01 - Pink Moon.flac'),
    track('Nick Drake/Pink Moon/02 - Place to Be.flac'),
    track('Nick Drake/Bryter Layter/01 - Introduction.flac'),
  ]);
  assert.deepEqual(titles(lib.sortedArtists), ['Nick Drake']);
  assert.deepEqual(titles(lib.sortedAlbums), ['Bryter Layter', 'Pink Moon']);
  assert.deepEqual(titles(lib.albums.get(keyOf('Nick Drake') + '\u001f' + keyOf('Pink Moon')).tracks), ['Pink Moon', 'Place to Be']);
});

test('sorting: artists ignore a leading "The", albums go by artist then year', () => {
  const lib = buildLibrary([
    track('1.flac', { ARTIST: 'The Beatles', ALBUM: 'Revolver', DATE: 1966, TITLE: 'a' }),
    track('2.flac', { ARTIST: 'The Beatles', ALBUM: 'Abbey Road', DATE: 1969, TITLE: 'b' }),
    track('3.flac', { ARTIST: 'Björk', ALBUM: 'Post', DATE: 1995, TITLE: 'c' }),
    track('4.flac', { ARTIST: 'ABBA', ALBUM: 'Arrival', DATE: 1976, TITLE: 'd' }),
    track('5.flac', { ARTIST: 'Zappa', ALBUM: 'Hot Rats', DATE: 1969, TITLE: 'e' }),
  ]);
  assert.deepEqual(titles(lib.sortedArtists), ['ABBA', 'The Beatles', 'Björk', 'Zappa']);
  assert.deepEqual(titles(lib.sortedAlbums), ['Arrival', 'Revolver', 'Abbey Road', 'Post', 'Hot Rats']);
  assert.deepEqual(titles(lib.sortedTracks), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(lib.albums.get('björk\u001fpost').year, 1995);
});

test('an album\'s year is when it first came out, when the files say so', () => {
  const lib = buildLibrary([
    track('bs/live/1.flac', { ARTIST: 'Bruce Springsteen', ALBUM: 'Live 1975-85', YEAR: 1986, ORIGINALDATE: '1985', TITLE: 'a' }),
    track('bs/live/2.flac', { ARTIST: 'Bruce Springsteen', ALBUM: 'Live 1975-85', YEAR: 1986, ORIGINALDATE: '1985', TITLE: 'b' }),
    track('bs/usa/1.flac', { ARTIST: 'Bruce Springsteen', ALBUM: 'Born in the U.S.A.', DATE: 2015, ORIGINALDATE: '1984-06-04', TITLE: 'c' }),
    track('bs/dd/1.flac', { ARTIST: 'Bruce Springsteen', ALBUM: 'Devils & Dust', YEAR: 2005, TITLE: 'd' }),
  ]);
  const usa = lib.albums.get('bruce springsteen\u001fborn in the u.s.a.');
  assert.deepEqual([usa.year, usa.editionYear, usa.originalYear], [1984, 2015, 1984]);
  const dd = lib.albums.get('bruce springsteen\u001fdevils & dust');
  assert.deepEqual([dd.year, dd.editionYear, dd.originalYear], [2005, 2005, null]);
  assert.deepEqual(titles(lib.artists.get('bruce springsteen').albums), ['Born in the U.S.A.', 'Live 1975-85', 'Devils & Dust'], 'a 2015 remaster still sorts as 1984');
});

test('genres: a track can be in several; a genre lists its albums once', () => {
  const lib = buildLibrary([
    track('m/1.flac', { ARTIST: 'Miles Davis', ALBUM: 'Bitches Brew', TITLE: 'a', GENRE: ['Jazz', 'Fusion'] }),
    track('m/2.flac', { ARTIST: 'Miles Davis', ALBUM: 'Bitches Brew', TITLE: 'b', GENRE: 'jazz' }),
    track('k/1.flac', { ARTIST: 'Kraftwerk', ALBUM: 'Autobahn', TITLE: 'c', GENRE: 'Electronic' }),
    track('k/2.flac', { ARTIST: 'Kraftwerk', ALBUM: 'Autobahn', TITLE: 'd' }),
  ]);
  assert.deepEqual(titles(lib.sortedGenres), ['Electronic', 'Fusion', 'Jazz']);
  const jazz = lib.genres.get('jazz');
  assert.equal(jazz.tracks.length, 2);
  assert.deepEqual(titles(jazz.albums), ['Bitches Brew']);
  assert.equal(lib.genres.get('fusion').tracks.length, 1);
  assert.deepEqual(lib.albums.get('miles davis\u001fbitches brew').genres, ['Jazz', 'Fusion']);
});

test('search: every word must match, accents and case are ignored, prefix matches rank first', () => {
  const lib = buildLibrary([
    track('1.flac', { ARTIST: 'Björk', ALBUM: 'Homogenic', TITLE: 'Jóga' }),
    track('2.flac', { ARTIST: 'Björk', ALBUM: 'Homogenic', TITLE: 'Bachelorette' }),
    track('3.flac', { ARTIST: 'Sigur Rós', ALBUM: 'Ágætis byrjun', TITLE: 'Svefn-g-englar' }),
    track('4.flac', { ARTIST: 'Yoga Lin', ALBUM: 'Fiction', TITLE: 'A Song About Joga' }),
  ]);
  const r1 = searchLibrary(lib, 'bjork');
  assert.deepEqual(titles(r1.artists), ['Björk']);
  assert.deepEqual(titles(r1.albums), ['Homogenic']);
  assert.equal(r1.tracks.length, 2);

  assert.deepEqual(titles(searchLibrary(lib, 'JOGA').tracks), ['Jóga', 'A Song About Joga']);
  assert.deepEqual(titles(searchLibrary(lib, 'homogenic bachelor').tracks), ['Bachelorette']);
  assert.deepEqual(titles(searchLibrary(lib, 'agaetis').albums), []);
  assert.deepEqual(titles(searchLibrary(lib, 'agætis').albums), ['Ágætis byrjun']);
  assert.deepEqual(searchLibrary(lib, '   ').tracks, []);
  assert.equal(searchLibrary(lib, 'zzz').totals.tracks, 0);
});

test('toRecord drops derived fields so they are not stored', () => {
  const lib = buildLibrary([track('a/b/1.flac', { TITLE: 't' })]);
  const [t] = lib.tracks.values();
  assert.ok(t._albumKey);
  const record = toRecord(t);
  assert.ok(Object.keys(record).every((k) => !k.startsWith('_')));
  assert.equal(record.title, 't');
});

test('a 30,000-track library builds and searches quickly', () => {
  const records = [];
  for (let artist = 0; artist < 300; artist++) {
    for (let album = 0; album < 10; album++) {
      for (let n = 1; n <= 10; n++) {
        records.push(track(`Artist ${artist}/Album ${album}/${String(n).padStart(2, '0')} - Song ${n}.flac`, {
          ARTIST: `Artist ${artist}`, ALBUM: `Album ${album}`, TITLE: `Song ${n} of ${album} by ${artist}`, TRACKNUMBER: n, GENRE: `Genre ${artist % 12}`, DATE: 1960 + album,
        }));
      }
    }
  }
  let start = performance.now();
  const lib = buildLibrary(records);
  const buildMs = performance.now() - start;
  assert.equal(lib.tracks.size, 30000);
  assert.equal(lib.albums.size, 3000);
  assert.equal(lib.sortedArtists.length, 300);
  assert.equal(lib.sortedGenres.length, 12);

  start = performance.now();
  const found = searchLibrary(lib, 'song 7 artist 42');
  const searchMs = performance.now() - start;
  assert.ok(found.totals.tracks > 0);
  // Generous limits: these guard against accidental quadratic behaviour, not micro-regressions.
  assert.ok(buildMs < 3000, `build took ${buildMs.toFixed(0)} ms`);
  assert.ok(searchMs < 1500, `search took ${searchMs.toFixed(0)} ms`);
});

// ------------------------------------------------------------- cover picking

test('cover art: folder image first, then embedded art, then a lone image', () => {
  const pic = { offset: 10, length: 20, mime: 'image/jpeg' };
  const lib = buildLibrary([
    track('A/One/01.flac', { ARTIST: 'A', ALBUM: 'One', TITLE: 'x' }, { picture: pic }),
    track('A/Two/CD1/01.flac', { ARTIST: 'A', ALBUM: 'Two', TITLE: 'y' }),
    track('A/Three/01.flac', { ARTIST: 'A', ALBUM: 'Three', TITLE: 'z' }),
    track('A/Four/01.flac', { ARTIST: 'A', ALBUM: 'Four', TITLE: 'w' }),
  ]);
  const images = new Map([
    ['A/One', ['back.jpg', 'Cover.JPG', 'folder.png']],
    ['A/Two', ['front.jpg']],
    ['A/Three', ['scan0001.jpg']],
    ['A/Four', ['scan1.jpg', 'scan2.jpg']],
  ]);
  const of = (title) => coverCandidates([...lib.albums.values()].find((a) => a.title === title), images);

  assert.deepEqual(of('One'), [
    { type: 'file', path: 'A/One/Cover.JPG' },
    { type: 'file', path: 'A/One/folder.png' },
    { type: 'embedded', path: 'A/One/01.flac', offset: 10, length: 20, mime: 'image/jpeg' },
  ]);
  assert.deepEqual(of('Two'), [{ type: 'file', path: 'A/Two/front.jpg' }], 'looks in the album folder above a disc folder');
  assert.deepEqual(of('Three'), [{ type: 'file', path: 'A/Three/scan0001.jpg' }]);
  assert.deepEqual(of('Four'), [], 'does not guess between several unnamed images');
});

// ----------------------------------------------- lessons from a real collection

const PLACEHOLDER = { TITLE: 'Raita 1', ARTIST: 'Tuntematon esittäjä', ALBUMARTIST: 'Tuntematon esittäjä', ALBUM: 'Tuntematon albumi (26.9.2024 0.59.52)', GENRE: 'Tuntematon tyylilaji', TRACKNUMBER: 1 };

test('a track with stand-in tags joins the album its folder neighbours belong to', () => {
  const tyler = (n, title) => track(`Bonnie Tyler/Super Hits/${String(n).padStart(2, '0')} ${title}.flac`, { TITLE: title, ARTIST: 'Bonnie Tyler', ALBUMARTIST: 'Bonnie Tyler', ALBUM: 'Super Hits: The Best', YEAR: 1999, ORIGINALDATE: '1995', GENRE: 'Rock', TRACKNUMBER: n });
  const records = [
    track('Bonnie Tyler/Super Hits/01 Total Eclipse Of The Heart.flac', PLACEHOLDER),
    tyler(2, 'Have You Ever Seen The Rain?'),
    tyler(3, 'Ravishing'),
  ];
  const lib = buildLibrary(records);
  assert.equal(lib.albums.size, 1, 'no one-track "unknown album" on the side');
  const [album] = lib.albums.values();
  assert.equal(album.title, 'Super Hits: The Best', 'the tagged name, not the folder name');
  assert.deepEqual(titles(album.tracks), ['Total Eclipse Of The Heart', 'Have You Ever Seen The Rain?', 'Ravishing']);
  assert.deepEqual([album.tracks[0].artist, album.tracks[0].year, album.tracks[0].originalYear, album.tracks[0].genres], ['Bonnie Tyler', 1999, 1995, ['Rock']]);
  assert.deepEqual(titles(lib.sortedArtists), ['Bonnie Tyler']);
  assert.deepEqual(titles(lib.sortedGenres), ['Rock']);

  // What gets stored is what the file says; adopting is redone on every build, with the same result.
  const stored = toRecord(album.tracks[0]);
  assert.deepEqual([stored.album, stored.albumArtist, stored.year, stored.originalYear, stored.genres], ['Super Hits', null, null, null, []]);
  const again = buildLibrary([...lib.tracks.values()]);
  assert.deepEqual(titles([...again.albums.values()][0].tracks), titles(album.tracks));
  // ...and it follows the neighbours if they are retagged.
  for (const t of again.tracks.values()) if (!t.guessed.length) t.album = 'Renamed';
  assert.deepEqual(titles(buildLibrary([...again.tracks.values()]).sortedAlbums), ['Renamed']);
});

test('on a compilation, a stand-in track takes the album but not somebody else\'s name', () => {
  const lib = buildLibrary([
    track('Various Artists/Mad About The Boy/01 Mad About The Boy.flac', PLACEHOLDER),
    track('Various Artists/Mad About The Boy/02 x.flac', { TITLE: 'Wonderful World', ARTIST: 'Sam Cooke', ALBUMARTIST: 'Various Artists', ALBUM: 'Mad About The Boy', TRACKNUMBER: 2 }),
    track('Various Artists/Mad About The Boy/03 y.flac', { TITLE: 'Stand By Me', ARTIST: 'Ben E. King', ALBUMARTIST: 'Various Artists', ALBUM: 'Mad About The Boy', TRACKNUMBER: 3 }),
  ]);
  assert.equal(lib.albums.size, 1);
  const [album] = lib.albums.values();
  assert.equal(album.artist, VARIOUS_ARTISTS);
  assert.deepEqual([album.tracks[0].title, album.tracks[0].artist], ['Mad About The Boy', 'Various Artists']);
});

test('nothing is adopted in a folder that is a mixed bag, or has no tagged tracks', () => {
  const mixed = buildLibrary([
    track('Downloads/01 Mystery.flac', PLACEHOLDER),
    track('Downloads/a.flac', { TITLE: 'a', ARTIST: 'A', ALBUM: 'One' }),
    track('Downloads/b.flac', { TITLE: 'b', ARTIST: 'B', ALBUM: 'Two' }),
    track('Downloads/c.flac', { TITLE: 'c', ARTIST: 'C', ALBUM: 'Three' }),
  ]);
  assert.deepEqual(titles(mixed.sortedAlbums).sort(), ['Downloads', 'One', 'Three', 'Two']);

  // A CD nobody could identify stays what it is: one album, in order.
  const unknown = buildLibrary([1, 2, 3].map((n) => track(`Tuntematon esittäjä/Tuntematon albumi (5.10.2024 19.51.45)/0${n} Raita ${n}.flac`, { ...PLACEHOLDER, TITLE: `Raita ${n}`, TRACKNUMBER: n })));
  assert.equal(unknown.albums.size, 1);
  assert.deepEqual(titles([...unknown.albums.values()][0].tracks), ['Raita 1', 'Raita 2', 'Raita 3']);
});

test('duplicate copies of a song are shown once, keeping the lossless one', () => {
  const flac = (n, title) => track(`Bruce Springsteen/Born In The U.S.A/0${n} ${title}.flac`, { TITLE: title, ARTIST: 'Bruce Springsteen', ALBUMARTIST: 'Bruce Springsteen', ALBUM: 'Born In The U.S.A.', TRACKNUMBER: n });
  const aac = (dir, n, title) => track(`${dir}/Bruce Springsteen/Born in the U.S.A_/0${n} ${title}.m4a`, { TITLE: title, ARTIST: 'Bruce Springsteen', ALBUMARTIST: 'Bruce Springsteen', ALBUM: 'Born in the U.S.A.', TRACKNUMBER: n, DISCNUMBER: 1 });
  const lib = buildLibrary([
    aac('Apple Music/Media/Music', 1, 'Born in the U.S.A.'),
    aac('Apple Music/Media/Music', 2, 'Cover Me'),
    aac('iTunes/iTunes Media/Music', 1, 'Born in the U.S.A.'),
    aac('iTunes/iTunes Media/Music', 3, 'Darlington County'),
    flac(1, 'Born In The U.S.A.'),
    flac(2, 'Cover Me'),
  ]);
  assert.equal(lib.albums.size, 1);
  const [album] = lib.albums.values();
  assert.deepEqual(album.tracks.map((t) => `${t.trackNo} ${t.fmt}`), ['1 flac', '2 flac', '3 m4a'], 'FLAC where there is one, the only copy otherwise');
  assert.equal(lib.songCount, 3);
  assert.equal(lib.duplicates, 3);
  assert.equal(lib.tracks.size, 6, 'every file is still known, so a rescan does not re-read the hidden copies');
  assert.equal(lib.sortedTracks.length, 3);
  assert.equal(lib.artists.get('bruce springsteen').tracks.length, 3);
  assert.deepEqual(searchLibrary(lib, 'born usa').tracks.map((t) => `${t.trackNo} ${t.fmt}`).sort(), ['1 flac', '2 flac', '3 m4a'], 'search does not list the hidden copies');
  // Stable from one build to the next.
  assert.deepEqual(buildLibrary([...lib.tracks.values()].reverse()).sortedTracks.map((t) => t.path), lib.sortedTracks.map((t) => t.path));
});

test('same track number is not enough to call two songs duplicates', () => {
  const lib = buildLibrary([
    track('x/Live/01 a.flac', { TITLE: 'Intro', ARTIST: 'X', ALBUM: 'Live', TRACKNUMBER: 1 }),
    track('x/Live/01 b.flac', { TITLE: 'Encore', ARTIST: 'X', ALBUM: 'Live', TRACKNUMBER: 1 }),
    track('x/Live/02 c.flac', { TITLE: 'Intro', ARTIST: 'X', ALBUM: 'Live', TRACKNUMBER: 2 }),
  ]);
  assert.equal(lib.duplicates, 0);
  assert.equal(lib.songCount, 3);
});

test('a two-disc set ripped into one folder without disc tags is split by the order it was ripped in', () => {
  const rip = (n, title, minute) => track(`Spede/Pure Nenaas/${String(n).padStart(2, '0')} ${title}.flac`, { TITLE: title, ARTIST: 'Spede', ALBUM: 'Pure Nenaas', TRACKNUMBER: n }, { mtime: Date.UTC(2024, 8, 26, 10, minute) });
  // File names interleave the discs alphabetically; the second disc was ripped first here.
  const records = [rip(1, 'Alpha', 45), rip(1, 'Pakastettuja', 40), rip(2, 'Riidanhaastaja', 41), rip(2, 'Beta', 46), rip(3, 'Gamma', 47), rip(3, 'Verokarhu', 42), rip(4, 'Loppu', 43)];
  const [album] = buildLibrary(records).albums.values();
  assert.equal(album.discCount, 2);
  assert.deepEqual(album.tracks.map((t) => `${t._disc}-${t.trackNo} ${t.title}`), ['1-1 Pakastettuja', '1-2 Riidanhaastaja', '1-3 Verokarhu', '1-4 Loppu', '2-1 Alpha', '2-2 Beta', '2-3 Gamma']);

  // If the write order does not separate the discs cleanly, no discs are invented.
  const jumbled = records.map((t, i) => ({ ...t, mtime: 1000 - i }));
  const [flat] = buildLibrary(jumbled).albums.values();
  assert.equal(flat.discCount, 1);
  assert.equal(flat.tracks.length, 7);
});

test('albums named "[Disc 1]" and "[Disc 2]" are one album with two discs', () => {
  const lib = buildLibrary([
    track('K/Vuodet [Disc 2]/01 c.flac', { TITLE: 'c', ARTIST: 'Kaija Koo', ALBUM: 'Vuodet [Disc 2]', TRACKNUMBER: 1 }),
    track('K/Vuodet [Disc 1]/01 a.flac', { TITLE: 'a', ARTIST: 'Kaija Koo', ALBUM: 'Vuodet [Disc 1]', TRACKNUMBER: 1 }),
    track('K/Vuodet [Disc 1]/02 b.flac', { TITLE: 'b', ARTIST: 'Kaija Koo', ALBUM: 'Vuodet [Disc 1]', TRACKNUMBER: 2 }),
  ]);
  assert.deepEqual(titles(lib.sortedAlbums), ['Vuodet']);
  const [album] = lib.albums.values();
  assert.equal(album.discCount, 2);
  assert.deepEqual(album.tracks.map((t) => `${t._disc}-${t.trackNo} ${t.title}`), ['1-1 a', '1-2 b', '2-1 c']);
  assert.equal(lib.duplicates, 0);
});

test('search ignores punctuation', () => {
  const lib = buildLibrary([
    track('1.flac', { TITLE: "Don't Stop Me Now", ARTIST: 'Queen', ALBUM: 'Jazz' }),
    track('2.flac', { TITLE: 'Thunderstruck', ARTIST: 'AC/DC', ALBUM: 'The Razors Edge' }),
    track('3.flac', { TITLE: 'Born In The U.S.A.', ARTIST: 'Bruce Springsteen', ALBUM: 'Born In The U.S.A.' }),
    track('4.flac', { TITLE: '風の谷', ARTIST: '喜多郎', ALBUM: 'Silk Road' }),
  ]);
  assert.deepEqual(titles(searchLibrary(lib, 'dont stop').tracks), ["Don't Stop Me Now"]);
  assert.deepEqual(titles(searchLibrary(lib, "don't").tracks), ["Don't Stop Me Now"]);
  assert.deepEqual(titles(searchLibrary(lib, 'ac/dc').artists), ['AC/DC']);
  assert.deepEqual(titles(searchLibrary(lib, 'ac dc thunder').tracks), ['Thunderstruck']);
  assert.deepEqual(titles(searchLibrary(lib, 'born usa').albums), ['Born In The U.S.A.']);
  assert.deepEqual(titles(searchLibrary(lib, 'u.s.a.').tracks), ['Born In The U.S.A.']);
  assert.deepEqual(titles(searchLibrary(lib, '喜多郎').artists), ['喜多郎']);
  assert.deepEqual(searchLibrary(lib, '...').tracks, []);
});
