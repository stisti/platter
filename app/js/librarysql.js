// Library SQL: SQL over the library, for the Query page.
//
// It keeps the SQL copy (an in-memory SQLite database filled from the built
// library, the playlists and the covers; see sqlrows.js and sqldb.js) fresh,
// holds the owner's setup SQL and saved queries, and reads a result as songs,
// albums or a plain table.
//
// Nothing tells it to refill: it listens for `change` on the library state,
// the playlists and the covers, and the next query refills the tables. Refills
// are lazy, so a scan that adds a hundred covers costs nothing until a query
// runs. SQLite itself (~1.5 MB) is only started by the first query.

import { loadSqlite as defaultLoadSqlite, LibraryDatabase } from './sqldb.js';
import { libraryRows } from './sqlrows.js';

/**
 * @import { Library, Track, Album } from './library.js'
 */

/** Where saved queries and the setup SQL are kept (IndexedDB `kv` in the app). */
const SAVED_KEY = 'savedQueries';
const SETUP_KEY = 'sqlSetup';

/** @typedef {{ name: string, sql: string }} SavedQuery */

/**
 * Small settings storage: IndexedDB `kv` in the app (`kvStore` in db.js), a Map in tests.
 * @typedef {object} KeyValueStore
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<unknown>} put
 */

/**
 * A query's result, read for the Query page.
 * @typedef {object} QueryResult
 * @property {string[]} columns
 * @property {any[][]} rows
 * @property {boolean} truncated  stopped at sqldb's MAX_ROWS
 * @property {number} ms  how long SQLite took
 * @property {'songs'|'albums'|'table'|'none'} kind
 *   songs: a `path` column; albums: `album_key` and no `path`; none: no result columns at all
 * @property {Track[]} [tracks]  songs: the library's tracks, each once, in result order
 * @property {number} [missing]  songs: distinct paths that are not songs in the library
 *   (gone from the library, or a duplicate copy it leaves out)
 * @property {Album[]} [albums]  albums: the library's albums, each once, in result order
 */

export class LibrarySql {
  /**
   * @param {object} o
   * @param {EventTarget & { current: Library }} o.library  Library state
   * @param {EventTarget & { list: Array<{id: string, name: string, tracks: string[]}> }} o.playlists
   * @param {EventTarget & { has(albumKey: string): boolean }} o.covers
   * @param {KeyValueStore} o.kv
   * @param {() => Promise<any>} [o.loadSqlite]  starts SQLite (Node tests pass the .wasm bytes)
   */
  constructor({ library, playlists, covers, kv, loadSqlite = defaultLoadSqlite }) {
    this.library = library;
    this.playlists = playlists;
    this.covers = covers;
    this.kv = kv;
    this.loadSqlite = loadSqlite;
    /** @type {SavedQuery[]} by name */
    this.saved = [];
    /** The owner's SQL, run after every fill: genre families of their own, views, anything. */
    this.setup = '';
    /** @type {Error|null} what the setup SQL failed with at the last fill */
    this.setupError = null;
    /** @type {Promise<LibraryDatabase>|null} */
    this._ready = null;
    /** @type {LibraryDatabase|null} */
    this._db = null;
    this._stale = true;
    const stale = () => {
      this._stale = true;
    };
    for (const source of [library, playlists, covers]) source.addEventListener('change', stale);
  }

  /** Reads the saved queries and setup SQL. Never rejects: unreadable ones are left out. */
  async init() {
    try {
      const [saved, setup] = await Promise.all([this.kv.get(SAVED_KEY), this.kv.get(SETUP_KEY)]);
      this.saved = Array.isArray(saved) ? sortByName(saved.filter((q) => q && typeof q.name === 'string' && typeof q.sql === 'string')) : [];
      this.setup = typeof setup === 'string' ? setup : '';
    } catch {
      // the Query page works without them
    }
  }

  /** Saves `sql` under `name`, replacing a query of the same name. */
  async saveQuery(name, sql) {
    this.saved = sortByName([...this.saved.filter((q) => q.name !== name), { name, sql }]);
    await this.kv.put(SAVED_KEY, this.saved);
  }

  async deleteQuery(name) {
    this.saved = this.saved.filter((q) => q.name !== name);
    await this.kv.put(SAVED_KEY, this.saved);
  }

  /** Replaces the setup SQL; the next query runs on tables refilled with it. */
  async setSetup(sql) {
    this.setup = sql;
    this._stale = true;
    await this.kv.put(SETUP_KEY, sql);
  }

  /**
   * Runs the owner's SQL on the SQL copy, refilling it first if anything it is
   * made from changed. Throws QueryError for an error in the SQL; any other
   * error means SQLite could not be started (the next run tries again).
   * @param {string} sql
   * @returns {Promise<QueryResult>}
   */
  async run(sql) {
    const db = await this._database();
    const started = performance.now();
    const result = db.run(sql);
    const ms = performance.now() - started;
    return { ...result, ms, ...readResult(this.library.current, result) };
  }

  /** The tables and views (with the owner's own); empty until SQLite has started. */
  schema() {
    return this._db?.schema() ?? [];
  }

  /** SQLite, started on first use, with tables as fresh as their sources. */
  async _database() {
    this._ready ??= this.loadSqlite().then((sqlite3) => new LibraryDatabase(sqlite3));
    try {
      this._db = await this._ready;
    } catch (err) {
      this._ready = null; // try again next time (it may have failed offline)
      throw err;
    }
    if (this._stale) {
      const rows = libraryRows(this.library.current, { playlists: this.playlists.list, hasCover: (key) => this.covers.has(key) });
      this.setupError = this._db.fill(rows, { setup: this.setup });
      this._stale = false;
    }
    return this._db;
  }
}

/** @param {SavedQuery[]} queries */
function sortByName(queries) {
  return queries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * What a result is a list of, and those songs or albums from the library.
 * @param {Library} lib
 * @param {{ columns: string[], rows: any[][] }} result
 * @returns {Pick<QueryResult, 'kind'|'tracks'|'missing'|'albums'>}
 */
function readResult(lib, { columns, rows }) {
  if (!columns.length) return { kind: 'none' };
  if (columns.includes('path')) {
    const at = columns.indexOf('path');
    const seen = new Set();
    const tracks = [];
    let missing = 0;
    for (const row of rows) {
      const path = row[at];
      if (seen.has(path)) continue;
      seen.add(path);
      const track = lib.tracks.get(path);
      if (track && !track._dup) tracks.push(track);
      else missing++;
    }
    return { kind: 'songs', tracks, missing };
  }
  if (columns.includes('album_key')) {
    const at = columns.indexOf('album_key');
    const albums = [...new Set(rows.map((row) => row[at]))].map((key) => lib.albums.get(key)).filter(Boolean);
    return { kind: 'albums', albums };
  }
  return { kind: 'table' };
}
