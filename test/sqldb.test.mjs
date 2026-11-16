// SQL over the library, in Node, with the app's own vendored SQLite build.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { buildLibrary } from '../app/js/library.js';
import { libraryRows, COLUMNS } from '../app/js/sqlrows.js';
import { LibraryDatabase, QueryError } from '../app/js/sqldb.js';
import { nodeSqlite } from './helpers/sqlite.mjs';
import { sqlLibraryRecords, SQL_LIBRARY_SONGS } from './helpers/sqllibrary.mjs';

let sqlite3;
before(async () => {
  sqlite3 = await nodeSqlite();
});

function filled(options = {}) {
  const db = new LibraryDatabase(sqlite3);
  const error = db.fill(libraryRows(buildLibrary(sqlLibraryRecords())), options);
  return { db, error };
}

const column = (result, name) => result.rows.map((row) => row[result.columns.indexOf(name)]);

test('the vendored SQLite starts in Node', () => {
  const { db } = filled();
  assert.match(db.run('SELECT sqlite_version() AS v').rows[0][0], /^3\.\d+\.\d+$/);
});

test('the tables have exactly the columns the rows are made for', () => {
  const { db } = filled();
  for (const [table, columns] of Object.entries(COLUMNS)) {
    assert.deepEqual(db.run(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).rows.flat(), columns, table);
  }
});

test('acceptance: 80s rock, by the release year and any rock-family genre', () => {
  const { db } = filled();
  const result = db.run(`
    SELECT s.* FROM songs s JOIN track_families f USING (path)
    WHERE f.family = 'rock' AND s.released BETWEEN 1980 AND 1989
    ORDER BY s.album_artist, s.released, s.disc_no, s.track_no`);
  assert.ok(result.columns.includes('path'));
  // New Wave counts as rock; Synth Pop alone would not, Soundtrack and Pop do not.
  // (SQLite orders text by its bytes: "Bruce" before "a-ha". COLLATE NOCASE changes that.)
  assert.deepEqual(column(result, 'title'), [
    'Born in the U.S.A.', 'Cover Me', // Classic Rock 1984
    'Dancing in the Dark', // Rock, on a 1988 compilation
    'Take On Me', '02', 'Train of Thought', // a-ha 1985, New Wave; the stand-in (titled from its file name) adopted the genre
  ]);
});

test('acceptance: the first album of Bruce Springsteen in the library', () => {
  const { db } = filled();
  const result = db.run(`
    SELECT * FROM albums WHERE artist_key = 'bruce springsteen'
    ORDER BY COALESCE(original_year, year) LIMIT 1`);
  assert.deepEqual(column(result, 'title'), ['Born to Run']);
  assert.ok(result.columns.includes('album_key'), 'a list of albums to the Query page');
});

test('views: songs carries the album, album_families groups albums', () => {
  const { db } = filled();
  const songs = db.run('SELECT album, album_artist, released FROM songs WHERE title = ?1'.replace('?1', "'Forever Young'"));
  assert.deepEqual(songs.rows, [['Eighties', 'Various Artists', 1988]]);
  const albums = db.run("SELECT a.title FROM albums a JOIN album_families f USING (album_key) WHERE f.family = 'soundtrack'");
  assert.deepEqual(albums.rows.flat(), ['Chariots of Fire']);
  assert.equal(db.run('SELECT count(*) FROM songs').rows[0][0], SQL_LIBRARY_SONGS);
});

test('values come back as plain JavaScript numbers and strings', () => {
  const { db } = filled();
  const [[mtime, duration, title, missing]] = db.run("SELECT mtime, duration, title, original_year FROM tracks WHERE title = 'Thunder Road'").rows;
  assert.deepEqual([mtime, duration, title, missing], [100, 200, 'Thunder Road', null]);
  assert.equal(typeof db.run('SELECT 9007199254740991').rows[0][0], 'number');
});

test('an error in the SQL is a QueryError with SQLite\'s own message', () => {
  const { db } = filled();
  assert.throws(() => db.run('SELECT * FROM nope'), (err) => err instanceof QueryError && err.message === 'no such table: nope');
  assert.throws(() => db.run('SELEC 1'), (err) => err instanceof QueryError && /syntax error/.test(err.message));
  assert.equal(db.run('SELECT 1').rows[0][0], 1, 'the database still works afterwards');
});

test('several statements: all run, the first one with columns is the result', () => {
  const { db } = filled();
  const result = db.run(`
    CREATE TEMP VIEW long_songs AS SELECT * FROM tracks WHERE duration >= 200;
    SELECT count(*) AS n FROM long_songs;
    SELECT 'ignored'`);
  assert.deepEqual(result, { columns: ['n'], rows: [[SQL_LIBRARY_SONGS]], truncated: false });
  const none = db.run('CREATE TEMP TABLE t (x)');
  assert.deepEqual(none, { columns: [], rows: [], truncated: false });
});

test('a runaway query stops at the row limit and says so', () => {
  const { db } = filled();
  const result = db.run('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n', { maxRows: 500 });
  assert.equal(result.rows.length, 500);
  assert.equal(result.truncated, true);
});

test('the owner\'s setup SQL runs after every fill; its error does not lose the tables', () => {
  const { db, error } = filled({ setup: "INSERT INTO genre_family VALUES ('synth pop', 'rock'); CREATE VIEW mine AS SELECT title FROM tracks;" });
  assert.equal(error, null);
  const rock = db.run("SELECT DISTINCT s.title FROM songs s JOIN track_families f USING (path) WHERE f.family = 'rock' AND s.artist = 'a-ha'");
  assert.equal(rock.rows.length, 3);
  assert.equal(db.run('SELECT count(*) FROM mine').rows[0][0], SQL_LIBRARY_SONGS);
  assert.ok(db.schema().some((o) => o.name === 'mine' && o.type === 'view'));

  const broken = filled({ setup: 'INSERT INTO nowhere VALUES (1)' });
  assert.ok(broken.error instanceof QueryError);
  assert.equal(broken.error.message, 'no such table: nowhere');
  assert.equal(broken.db.run('SELECT count(*) FROM tracks').rows[0][0], SQL_LIBRARY_SONGS);
});

test('refilling replaces everything, including what earlier queries created', () => {
  const { db } = filled();
  db.run('CREATE TABLE scratch (x); DELETE FROM tracks');
  db.fill(libraryRows(buildLibrary(sqlLibraryRecords())));
  assert.equal(db.run('SELECT count(*) FROM tracks').rows[0][0], SQL_LIBRARY_SONGS);
  assert.throws(() => db.run('SELECT * FROM scratch'), QueryError);
});

test('schema() lists tables, then views, with their columns', () => {
  const { db } = filled();
  const schema = db.schema();
  assert.deepEqual(schema.filter((o) => o.type === 'table').map((o) => o.name), Object.keys(COLUMNS));
  assert.deepEqual(schema.filter((o) => o.type === 'view').map((o) => o.name), ['songs', 'track_families', 'album_families']);
  assert.ok(schema.find((o) => o.name === 'songs').columns.includes('released'));
});

test('a library the size of the owner\'s fills in well under a second', () => {
  const records = [];
  for (let a = 0; a < 200; a++) {
    for (let t = 1; t <= 12; t++) {
      const r = sqlLibraryRecords()[0];
      records.push({ ...r, path: `A${a}/${t}.flac`, album: `Album ${a}`, artist: `Artist ${a % 120}`, trackNo: t, title: `Song ${t}`, genres: ['Rock', 'Pop'] });
    }
  }
  const lib = buildLibrary(records);
  const db = new LibraryDatabase(sqlite3);
  const started = performance.now();
  db.fill(libraryRows(lib));
  const took = performance.now() - started;
  assert.equal(db.run('SELECT count(*) FROM tracks').rows[0][0], 2400);
  assert.ok(took < 1000, `fill took ${took.toFixed(0)} ms`);
});
