import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLibrary } from '../app/js/library.js';
import { libraryRows, COLUMNS } from '../app/js/sqlrows.js';
import { sqlLibraryRecords, track, SQL_LIBRARY_SONGS } from './helpers/sqllibrary.mjs';

/** Rows of one table as objects, for readable assertions. */
function objects(rows, table) {
  return rows[table].map((row) => Object.fromEntries(COLUMNS[table].map((c, i) => [c, row[i]])));
}

test('tracks: one row per song, duplicates left out, with the disc and album the library resolved', () => {
  const lib = buildLibrary(sqlLibraryRecords());
  const rows = libraryRows(lib);
  const tracks = objects(rows, 'tracks');
  assert.equal(tracks.length, SQL_LIBRARY_SONGS);
  assert.ok(!tracks.some((t) => t.format === 'm4a'), 'the AAC copy of a FLAC song is a duplicate');
  assert.equal(new Set(tracks.map((t) => t.path)).size, tracks.length, 'paths are unique');

  const thunder = tracks.find((t) => t.title === 'Thunder Road');
  assert.deepEqual(thunder, {
    path: 'Bruce Springsteen/Born to Run/01.flac',
    title: 'Thunder Road',
    artist: 'Bruce Springsteen',
    artist_key: 'bruce springsteen',
    album_key: 'bruce springsteen\u001fborn to run',
    disc_no: 1,
    track_no: 1,
    year: 1975,
    original_year: null,
    genres: 'Rock',
    duration: 200,
    format: 'flac',
    size: 1000,
    mtime: 100,
  });
  const partThree = tracks.find((t) => t.title === 'Part Three');
  assert.equal(partThree.disc_no, 2);
});

test('a stand-in track appears with what it adopted from its folder neighbours', () => {
  const rows = libraryRows(buildLibrary(sqlLibraryRecords()));
  const raita = objects(rows, 'tracks').find((t) => t.path === 'a-ha/Hunting High and Low/02.flac');
  assert.deepEqual([raita.album_key, raita.year, raita.genres, raita.artist], ['a-ha\u001fhunting high and low', 1985, 'New Wave, Synth Pop', 'a-ha']);
  const genres = objects(rows, 'track_genres').filter((g) => g.path === raita.path);
  assert.deepEqual(genres.map((g) => g.genre_key), ['new wave', 'synth pop']);
});

test('albums, artists and genres match what the app shows', () => {
  const rows = libraryRows(buildLibrary(sqlLibraryRecords()), { hasCover: (key) => key.startsWith('a-ha') });
  const albums = objects(rows, 'albums');
  assert.equal(albums.length, 8);
  const usa = albums.find((a) => a.title === 'Born in the U.S.A.');
  assert.deepEqual(
    [usa.artist, usa.artist_key, usa.year, usa.edition_year, usa.track_count, usa.disc_count, usa.duration, usa.added, usa.has_cover],
    ['Bruce Springsteen', 'bruce springsteen', 1984, 1984, 2, 1, 400, 200, 0],
  );
  const eighties = albums.find((a) => a.title === 'Eighties');
  assert.equal(eighties.artist, 'Various Artists');
  assert.equal(albums.find((a) => a.title === 'Incantations').disc_count, 2);
  assert.equal(albums.find((a) => a.title === 'Hunting High and Low').has_cover, 1);
  assert.equal(objects(libraryRows(buildLibrary(sqlLibraryRecords())), 'albums')[0].has_cover, null, 'unknown without hasCover');

  const artists = objects(rows, 'artists');
  const bruce = artists.find((a) => a.artist_key === 'bruce springsteen');
  assert.deepEqual([bruce.album_count, bruce.track_count], [3, 6], 'own albums, and all songs including the compilation one');
  assert.equal(artists.find((a) => a.artist_key === 'alphaville').album_count, 0, 'a guest on a compilation only');

  const genres = objects(rows, 'genres').map((g) => g.name).sort();
  assert.deepEqual(genres, ['Classic Rock', 'Contemporary Folk', 'Metal & Hard Rock', 'New Wave', 'Pop', 'Progressive', 'Rock', 'Soundtrackit', 'Synth Pop']);
  const albumGenres = objects(rows, 'album_genres').filter((g) => g.album_key === 'a-ha\u001fhunting high and low');
  assert.deepEqual(albumGenres.map((g) => g.genre), ['New Wave', 'Synth Pop']);
});

test('genre_family: every genre in its own family and its broader ones', () => {
  const rows = libraryRows(buildLibrary(sqlLibraryRecords()));
  const families = objects(rows, 'genre_family');
  const of = (key) => families.filter((f) => f.genre_key === key).map((f) => f.family);
  assert.deepEqual(of('classic rock'), ['classic rock', 'rock']);
  assert.deepEqual(of('rock'), ['rock']);
  assert.deepEqual(of('soundtrackit'), ['soundtrackit', 'soundtrack']);
  for (const { genre_key: key } of objects(rows, 'genres')) assert.ok(of(key).includes(key), `${key} is in its own family`);
});

test('a genre tagged twice on one track (in different case) is one genre', () => {
  const rows = libraryRows(buildLibrary([track('x/1.flac', { ARTIST: 'X', ALBUM: 'Y', TITLE: 'Z', GENRE: ['Rock', 'rock'] })]));
  assert.deepEqual(objects(rows, 'track_genres').map((g) => g.genre), ['Rock']);
  assert.equal(objects(rows, 'tracks')[0].genres, 'Rock');
});

test('original and edition years are passed through when the library knows them', () => {
  // The album fields as the original-year work sets them (library.js on that branch).
  const records = [track('bs/usa/1.flac', { ARTIST: 'Bruce Springsteen', ALBUM: 'Born in the U.S.A.', DATE: 2015, TITLE: 'c' })];
  records[0].originalYear = 1984;
  const lib = buildLibrary(records);
  const [album] = lib.sortedAlbums;
  Object.assign(album, { editionYear: 2015, originalYear: 1984, year: 1984 });
  const rows = libraryRows(lib);
  const [a] = objects(rows, 'albums');
  assert.deepEqual([a.year, a.edition_year, a.original_year], [1984, 2015, 1984]);
  const [t] = objects(rows, 'tracks');
  assert.deepEqual([t.year, t.original_year], [2015, 1984]);
});

test('playlists keep their order, and entries for files no longer in the library', () => {
  const rows = libraryRows(buildLibrary(sqlLibraryRecords()), {
    playlists: [{ id: 'p1', name: 'Drive', tracks: ['a-ha/Hunting High and Low/01.flac', 'gone.flac', 'Bruce Springsteen/Born to Run/01.flac'] }],
  });
  assert.deepEqual(objects(rows, 'playlists'), [{ id: 'p1', name: 'Drive' }]);
  assert.deepEqual(objects(rows, 'playlist_tracks').map((p) => [p.position, p.path]), [
    [0, 'a-ha/Hunting High and Low/01.flac'],
    [1, 'gone.flac'],
    [2, 'Bruce Springsteen/Born to Run/01.flac'],
  ]);
});

test('an empty library has empty tables', () => {
  const rows = libraryRows(buildLibrary([]));
  for (const table of Object.keys(COLUMNS)) assert.deepEqual(rows[table], [], table);
});
