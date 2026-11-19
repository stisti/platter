// SQL over the library: an in-memory SQLite database (the official
// WebAssembly build, vendored in vendor/sqlite/) holding the tables described
// in sqlrows.js. It is a throwaway copy of what buildLibrary() made: nothing is
// stored, and it is refilled whenever the library changes.
//
// SQLite (~1.5 MB) is only downloaded and started when something first needs
// it, so opening the app costs nothing extra. This module itself runs in Node
// too (the unit tests pass the .wasm bytes in), only the default way of
// finding the .wasm file is the browser's.

import { SCHEMA, COLUMNS } from './sqlrows.js';

/** Most rows one query returns: more than any library has tracks, far fewer than a careless join makes. */
export const MAX_ROWS = 100_000;

/**
 * Not written into the import() below, so the type checker does not follow it
 * into SQLite's generated, untyped code. import() resolves it against this module either way.
 */
const SQLITE_MODULE = '../vendor/sqlite/sqlite3.mjs';

let loading = null;

/**
 * Loads and starts SQLite once. `options` go to the sqlite3 module's
 * initialiser (Node passes `wasmBinary`).
 */
export function loadSqlite(options = {}) {
  loading ??= (async () => {
    const { default: init } = await import(SQLITE_MODULE);
    return init({ print: () => {}, printErr: () => {}, ...options });
  })();
  loading.catch(() => {
    loading = null; // let a later attempt try again (the app may have been offline)
  });
  return loading;
}

/** An error in the owner's SQL, with SQLite's own message. */
export class QueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueryError';
  }
}

/** SQLite's messages carry a prefix about result codes that says nothing to a reader. */
function cleanMessage(err) {
  return String(err?.message ?? err).replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
}

export class LibraryDatabase {
  /** @param {any} sqlite3 what loadSqlite() resolves to (the vendored build comes without types) */
  constructor(sqlite3) {
    this.sqlite3 = sqlite3;
    this.db = null;
  }

  /**
   * Replaces the database with a fresh one holding `rows` (from libraryRows()).
   * `setup` is optional SQL of the owner's, run after the tables are filled
   * (extra genre families, views of their own); its error, if any, is returned
   * so the caller can show it, and the tables are usable either way.
   */
  fill(rows, { setup = '' } = {}) {
    this.close();
    const db = new this.sqlite3.oo1.DB(':memory:');
    this.db = db;
    db.exec(SCHEMA);
    db.transaction(() => {
      for (const [table, columns] of Object.entries(COLUMNS)) {
        const list = rows[table] ?? [];
        if (!list.length) continue;
        const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
        try {
          for (const row of list) insert.bind(row).stepReset();
        } finally {
          insert.finalize();
        }
      }
    });
    if (!setup.trim()) return null;
    try {
      db.exec(setup);
      return null;
    } catch (err) {
      return new QueryError(cleanMessage(err));
    }
  }

  /**
   * Runs the owner's SQL. Several statements are allowed (all of them run);
   * the result is that of the first statement that has result columns.
   * Collects at most `maxRows` rows, so a runaway join cannot freeze the page.
   * Throws QueryError with SQLite's message.
   * @returns {{ columns: string[], rows: any[][], truncated: boolean }}
   */
  run(sql, { maxRows = MAX_ROWS } = {}) {
    if (!this.db) throw new Error('LibraryDatabase.run() before fill()');
    const columns = [];
    const rows = [];
    let truncated = false;
    try {
      this.db.exec({
        sql,
        rowMode: 'array',
        columnNames: columns,
        callback: (row) => {
          if (rows.length >= maxRows) {
            truncated = true;
            return false;
          }
          rows.push(row);
        },
      });
    } catch (err) {
      throw new QueryError(cleanMessage(err));
    }
    return { columns, rows, truncated };
  }

  /**
   * The tables and views with their columns, read from the database itself
   * (so views the owner created in their setup SQL are listed too).
   * @returns {Array<{ name: string, type: 'table'|'view', columns: string[] }>}
   */
  schema() {
    if (!this.db) return [];
    const objects = this.db.selectObjects("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, rowid");
    return objects.map(({ name, type }) => ({
      name,
      type,
      columns: this.db.selectValues('SELECT name FROM pragma_table_info(?) ORDER BY cid', [name]),
    }));
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
