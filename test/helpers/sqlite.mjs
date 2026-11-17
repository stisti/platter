// Starts the app's own vendored SQLite build (app/vendor/sqlite/) in Node, so
// SQL tests run against the same engine the browser uses.

import { readFile } from 'node:fs/promises';
import { loadSqlite } from '../../app/js/sqldb.js';

export async function nodeSqlite() {
  const wasmBinary = await readFile(new URL('../../app/vendor/sqlite/sqlite3.wasm', import.meta.url));
  // Outside a browser worker the OPFS storage backends cannot be installed;
  // SQLite says so through config.warn. Nothing here needs them.
  globalThis.sqlite3ApiConfig = { warn: () => {} };
  return loadSqlite({ wasmBinary });
}
