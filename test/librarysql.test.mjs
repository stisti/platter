// Library SQL, in Node, with the app's own vendored SQLite build.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { LibrarySql } from '../app/js/librarysql.js';
import { QueryError } from '../app/js/sqldb.js';
import { buildLibrary } from '../app/js/library.js';
import { nodeSqlite } from './helpers/sqlite.mjs';
import { sqlLibraryRecords, SQL_LIBRARY_SONGS } from './helpers/sqllibrary.mjs';

let sqlite3;
before(async () => {
  sqlite3 = await nodeSqlite();
});

const THUNDER_ROAD = 'Bruce Springsteen/Born to Run/01.flac';
const DUPLICATE = 'iTunes/Bruce Springsteen/Born in the U.S.A/02 Cover Me.m4a';

/** IndexedDB `kv` stand-in: values are copied in and out, as IndexedDB does. */
function memoryKv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
  };
}

/** Library SQL over the test library, with its three sources as plain event targets. */
function librarySql({ kv = memoryKv(), loadSqlite = async () => sqlite3 } = {}) {
  const library = Object.assign(new EventTarget(), { current: buildLibrary(sqlLibraryRecords()) });
  const playlists = Object.assign(new EventTarget(), { list: [] });
  const coverKeys = new Set();
  const covers = Object.assign(new EventTarget(), { has: (key) => coverKeys.has(key) });
  const sql = new LibrarySql({ library, playlists, covers, kv, loadSqlite });
  const changed = (source) => source.dispatchEvent(new Event('change'));
  return { sql, kv, library, playlists, coverKeys, covers, changed };
}

const value = async (sql, query) => (await sql.run(query)).rows[0][0];

/** Leaves a mark that a refill would wipe (a refill starts a fresh database). */
async function mark(sql) {
  await sql.run('CREATE TEMP TABLE mark (x)');
}
async function marked(sql) {
  return (await value(sql, "SELECT count(*) FROM temp.sqlite_schema WHERE name = 'mark'")) === 1;
}

test('the tables are filled from the library on the first query, and not again while nothing changes', async () => {
  const { sql } = librarySql();
  assert.deepEqual(sql.schema(), [], 'no SQLite before the first query');
  assert.equal(await value(sql, 'SELECT count(*) FROM tracks'), SQL_LIBRARY_SONGS);
  await mark(sql);
  await sql.run('SELECT 1');
  assert.equal(await marked(sql), true, 'no refill');
  assert.ok(sql.schema().some((o) => o.name === 'tracks'));
});

test('a change to the library, the playlists or the covers refills the tables on the next query', async () => {
  const { sql, library, playlists, coverKeys, covers, changed } = librarySql();
  await mark(sql);

  library.current = buildLibrary(sqlLibraryRecords().slice(0, 2));
  assert.equal(await marked(sql), true, 'without a change event, the tables are left alone');
  changed(library);
  assert.equal(await value(sql, 'SELECT count(*) FROM tracks'), 2);
  assert.equal(await marked(sql), false);

  await mark(sql);
  playlists.list = [{ id: 'p1', name: 'Mix', tracks: [THUNDER_ROAD] }];
  changed(playlists);
  assert.equal(await value(sql, 'SELECT name FROM playlists'), 'Mix');
  assert.equal(await marked(sql), false);

  const albumKey = library.current.sortedAlbums[0].key;
  coverKeys.add(albumKey);
  changed(covers);
  assert.equal(await value(sql, 'SELECT album_key FROM albums WHERE has_cover = 1'), albumKey);
});

test('setup SQL runs after every fill; a new one refills the tables', async () => {
  const { sql, changed, library } = librarySql();
  await mark(sql);
  await sql.setSetup("CREATE VIEW rockers AS SELECT * FROM albums WHERE artist = 'Bruce Springsteen';");
  assert.equal(await value(sql, 'SELECT count(*) FROM rockers'), 3);
  assert.equal(await marked(sql), false);
  assert.ok(sql.schema().some((o) => o.name === 'rockers' && o.type === 'view'));
  changed(library);
  assert.equal(await value(sql, 'SELECT count(*) FROM rockers'), 3, 'and again after the next refill');
});

test('setup SQL that fails is reported, and the tables still work', async () => {
  const { sql } = librarySql();
  await sql.setSetup('INSERT INTO nowhere VALUES (1);');
  assert.equal(await value(sql, 'SELECT count(*) FROM tracks'), SQL_LIBRARY_SONGS);
  assert.ok(sql.setupError instanceof QueryError);
  assert.equal(sql.setupError.message, 'no such table: nowhere');
  await sql.setSetup('');
  await sql.run('SELECT 1');
  assert.equal(sql.setupError, null);
});

test('saved queries and setup SQL are kept, by name, and read back by a new instance', async () => {
  const { sql, kv } = librarySql();
  await sql.saveQuery('rock', 'SELECT 1');
  await sql.saveQuery('Albums', 'SELECT 2');
  await sql.saveQuery('jazz', 'SELECT 3');
  await sql.saveQuery('rock', 'SELECT 4');
  await sql.deleteQuery('jazz');
  await sql.setSetup('-- mine');
  assert.deepEqual(sql.saved, [{ name: 'Albums', sql: 'SELECT 2' }, { name: 'rock', sql: 'SELECT 4' }]);

  const again = librarySql({ kv }).sql;
  await again.init();
  assert.deepEqual(again.saved, sql.saved);
  assert.equal(again.setup, '-- mine');
});

test('unreadable saved queries or setup SQL are left out', async () => {
  const { sql } = librarySql({ kv: memoryKv({ savedQueries: [{ name: 'ok', sql: 'SELECT 1' }, null, { name: 2, sql: 'x' }], sqlSetup: 42 }) });
  await sql.init();
  assert.deepEqual(sql.saved, [{ name: 'ok', sql: 'SELECT 1' }]);
  assert.equal(sql.setup, '');

  const broken = librarySql({ kv: { get: async () => { throw new Error('closed'); }, put: async () => {} } }).sql;
  await broken.init();
  assert.deepEqual(broken.saved, []);
});

test('a result with a path column is songs: each once, without duplicate copies or songs not in the library', async () => {
  const { sql, library } = librarySql();
  const result = await sql.run(`
    SELECT column1 AS path, 'x' AS album_key FROM (VALUES ('${THUNDER_ROAD}'), ('${THUNDER_ROAD}'), ('${DUPLICATE}'), ('Nowhere/gone.flac'))`);
  assert.equal(result.kind, 'songs', 'path wins over album_key');
  assert.equal(result.rows.length, 4, 'the rows are all there for the table view');
  assert.deepEqual(result.tracks, [library.current.tracks.get(THUNDER_ROAD)], "the library's own track");
  assert.equal(result.missing, 2);
  assert.ok(result.ms >= 0);
});

test('a result with album_key is albums; unknown keys are left out', async () => {
  const { sql, library } = librarySql();
  const result = await sql.run(`
    SELECT album_key FROM albums WHERE title = 'Born to Run'
    UNION ALL SELECT album_key FROM albums WHERE title = 'Born to Run'
    UNION ALL SELECT 'no such album'`);
  assert.equal(result.kind, 'albums');
  assert.deepEqual(result.albums.map((a) => a.title), ['Born to Run']);
  assert.equal(result.albums[0], library.current.albums.get(result.rows[0][0]));
});

test('any other result is a table, and a statement without result columns is none', async () => {
  const { sql } = librarySql();
  const table = await sql.run('SELECT count(*) AS songs FROM tracks');
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.columns, ['songs']);
  assert.deepEqual((await sql.run('CREATE TEMP TABLE t (x)')).kind, 'none');
  await assert.rejects(sql.run('SELECT nope'), QueryError);
});

test('SQLite that fails to start fails that query; the next one tries again', async () => {
  let attempts = 0;
  const { sql } = librarySql({
    loadSqlite: async () => {
      if (++attempts === 1) throw new Error('offline');
      return sqlite3;
    },
  });
  await assert.rejects(sql.run('SELECT 1'), (err) => !(err instanceof QueryError) && err.message === 'offline');
  assert.deepEqual(sql.schema(), []);
  assert.equal(await value(sql, 'SELECT count(*) FROM tracks'), SQL_LIBRARY_SONGS);
  assert.equal(attempts, 2);
});
