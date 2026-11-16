// The SQL view of the library: the schema of the tables the Query page runs
// SQL against, and the rows that fill them. Pure data code with no browser
// dependencies; sqldb.js puts the rows into SQLite.
//
// The rows come from the built library (library.js), not from the stored
// track records, so SQL sees exactly what the rest of the app shows: resolved
// album artists, merged discs, tags adopted from folder neighbours, and no
// duplicate copies.

import { keyOf } from './library.js';
import { familiesOf } from './genres.js';

/**
 * The tables and views. Recreated on every fill; documented for the owner in
 * README.md ("Queries"). Keys are the same strings the app uses everywhere
 * (a track's path, album.key, artist.key, keyOf(genre)) and are named the
 * same in every table, so joins can say USING (album_key). A result with a
 * `path` column is a list of songs to the Query page, one with `album_key` a
 * list of albums.
 */
export const SCHEMA = `
CREATE TABLE tracks (
  path          TEXT PRIMARY KEY,  -- file path in the music folder
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,     -- track artist as tagged
  artist_key    TEXT NOT NULL,     -- artists.artist_key
  album_key     TEXT NOT NULL,     -- albums.album_key
  disc_no       INTEGER,
  track_no      INTEGER,
  year          INTEGER,           -- year of the edition the file comes from
  original_year INTEGER,           -- first release (ORIGINALDATE), null if unknown
  genres        TEXT,              -- all its genres, joined with ', '
  duration      REAL,              -- seconds
  format        TEXT,              -- file extension: 'flac', 'm4a', 'mp3', ...
  size          INTEGER,           -- bytes
  mtime         INTEGER            -- last modified, ms since 1970: "recently added"
);
CREATE TABLE albums (
  album_key     TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,     -- album artist; 'Various Artists' for compilations
  artist_key    TEXT NOT NULL,     -- artists.artist_key
  year          INTEGER,           -- the year the app shows: original year when known
  edition_year  INTEGER,           -- year of the edition the files come from
  original_year INTEGER,           -- first release, null if unknown
  genres        TEXT,              -- joined with ', '
  track_count   INTEGER NOT NULL,
  disc_count    INTEGER NOT NULL,
  duration      REAL,              -- seconds
  added         INTEGER,           -- newest mtime of its tracks
  has_cover     INTEGER            -- 1 or 0; null when not known
);
CREATE TABLE artists (
  artist_key    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  album_count   INTEGER NOT NULL,  -- 0 for artists who only appear as guests
  track_count   INTEGER NOT NULL
);
CREATE TABLE genres (
  genre_key     TEXT PRIMARY KEY,
  name          TEXT NOT NULL
);
CREATE TABLE track_genres (path TEXT NOT NULL, genre TEXT NOT NULL, genre_key TEXT NOT NULL);
CREATE TABLE album_genres (album_key TEXT NOT NULL, genre TEXT NOT NULL, genre_key TEXT NOT NULL);
CREATE TABLE genre_family (genre_key TEXT NOT NULL, family TEXT NOT NULL, PRIMARY KEY (genre_key, family));
CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL);

-- One wide row per track: what most queries want.
CREATE VIEW songs AS
SELECT t.*, a.title AS album, a.artist AS album_artist, a.artist_key AS album_artist_key,
       COALESCE(t.original_year, a.original_year, t.year, a.year) AS released
FROM tracks t JOIN albums a USING (album_key);

-- Tracks with the genre families they belong to.
CREATE VIEW track_families AS
SELECT DISTINCT tg.path, gf.family
FROM track_genres tg JOIN genre_family gf USING (genre_key);

-- Albums with the genre families they belong to.
CREATE VIEW album_families AS
SELECT DISTINCT ag.album_key, gf.family
FROM album_genres ag JOIN genre_family gf USING (genre_key);
`;

/** Column order of each table's rows, as `libraryRows()` produces them. */
export const COLUMNS = {
  tracks: ['path', 'title', 'artist', 'artist_key', 'album_key', 'disc_no', 'track_no', 'year', 'original_year', 'genres', 'duration', 'format', 'size', 'mtime'],
  albums: ['album_key', 'title', 'artist', 'artist_key', 'year', 'edition_year', 'original_year', 'genres', 'track_count', 'disc_count', 'duration', 'added', 'has_cover'],
  artists: ['artist_key', 'name', 'album_count', 'track_count'],
  genres: ['genre_key', 'name'],
  track_genres: ['path', 'genre', 'genre_key'],
  album_genres: ['album_key', 'genre', 'genre_key'],
  genre_family: ['genre_key', 'family'],
  playlists: ['id', 'name'],
  playlist_tracks: ['playlist_id', 'position', 'path'],
};

const joined = (names) => (names.length ? names.join(', ') : null);

/** A track's genres without repeats (the same genre twice in different case counts once). */
function uniqueGenres(names) {
  const seen = new Map();
  for (const name of names) if (!seen.has(keyOf(name))) seen.set(keyOf(name), name);
  return [...seen];
}

/**
 * Turns the built library into rows for every table: `{ tracks: [[...]], ... }`,
 * each row's values in `COLUMNS` order.
 *
 * @param {object} lib from buildLibrary()
 * @param {{ playlists?: Array<{id: string, name: string, tracks: string[]}>, hasCover?: (albumKey: string) => boolean }} [options]
 */
export function libraryRows(lib, { playlists = [], hasCover = null } = {}) {
  const rows = Object.fromEntries(Object.keys(COLUMNS).map((table) => [table, []]));

  for (const album of lib.sortedAlbums) {
    // Before the original-year work, an album only has `year` (the edition's).
    const originalYear = album.originalYear ?? null;
    const editionYear = album.editionYear !== undefined ? album.editionYear : album.year;
    rows.albums.push([
      album.key, album.title, album.artist, album.artistKey,
      album.year, editionYear, originalYear, joined(album.genres),
      album.tracks.length, album.discCount, album.duration, album.added || null,
      hasCover ? Number(hasCover(album.key)) : null,
    ]);
    for (const g of album.genres) rows.album_genres.push([album.key, g, keyOf(g)]);

    // album.tracks leaves duplicate copies out.
    for (const t of album.tracks) {
      const genres = uniqueGenres(t.genres);
      rows.tracks.push([
        t.path, t.title, t.artist, keyOf(t.artist), album.key,
        t._disc ?? t.discNo ?? null, t.trackNo ?? null, t.year ?? null, t.originalYear ?? null,
        joined(genres.map(([, name]) => name)), t.duration ?? null, t.fmt ?? null, t.size ?? null, t.mtime ?? null,
      ]);
      for (const [key, name] of genres) rows.track_genres.push([t.path, name, key]);
    }
  }

  for (const artist of lib.artists.values()) {
    rows.artists.push([artist.key, artist.name, artist.albums.length, artist.tracks.length]);
  }
  for (const genre of lib.genres.values()) {
    rows.genres.push([genre.key, genre.name]);
    for (const family of familiesOf(genre.name)) rows.genre_family.push([genre.key, family]);
  }
  for (const playlist of playlists) {
    rows.playlists.push([playlist.id, playlist.name]);
    playlist.tracks.forEach((path, position) => rows.playlist_tracks.push([playlist.id, position, path]));
  }
  return rows;
}
