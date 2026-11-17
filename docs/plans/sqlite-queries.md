# Plan: SQL queries over the library

Status: **planned, not started** (written 2026-11-16). To be picked up after
the original-release-year work: the app reading `ORIGINALDATE`, and
`scripts/rip/platter_years.py` adding it to old rips. The `original_year`
columns below depend on it.

## Goal

Let the owner type SQL against the music library and play, queue or save the
result. Queries the current UI cannot answer, for example:

- "80s rock": songs whose album first came out 1980–1989, in any rock-family genre
- "first album of Bruce Springsteen": the earliest album *in this library*
- anything else a backend developer would write in SQL

The owner is the only user and knows SQL. There is **no** query language of
our own and no natural-language layer (an LLM writing SQL could be added later
on top of the same tables).

## Decisions already made

1. **Engine: SQLite compiled to WebAssembly**, the official build
   (`@sqlite.org/sqlite-wasm`). Vendored as files under `app/vendor/sqlite/`
   (no build step, works offline, cached by the service worker). This is the
   project's first runtime dependency; that is accepted.
2. **In-memory database, rebuilt from the built library.** After
   `buildLibrary()` (startup, every rescan, every library change) the SQL
   tables are filled from its result, not from raw IndexedDB records. That way
   SQL sees exactly what the UI shows: resolved album artists, merged discs,
   folder-adopted tags, duplicates left out.
3. **IndexedDB stays the storage.** No OPFS SQLite file, no persistence of the
   SQL database itself. ~2,250 tracks / ~190 albums load in milliseconds.
4. **Mapping tables** turn messy tag values into things worth querying. Genres
   first (`genre_family`); more attributes may get the same treatment later
   (e.g. decade/era names, language, country, artist aliases).
5. **Results point back into the app**: a query that returns a `path` column
   is a track list (play / shuffle / queue / save as playlist); one that
   returns `album_key` is an album list. Anything else is shown as a plain
   table.

## Schema (first version)

Tables are recreated on each rebuild. Column names are snake_case; keys are
the same strings the app already uses (`track.path`, `album.key`,
`artist.key`, `keyOf(genre)`).

```sql
CREATE TABLE tracks (
  path          TEXT PRIMARY KEY,   -- file path in the music folder; the track's identity
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,      -- track artist as tagged
  album_key     TEXT NOT NULL REFERENCES albums(key),
  disc_no       INTEGER,            -- the resolved disc (_disc)
  track_no      INTEGER,
  year          INTEGER,            -- year of the edition the file comes from (DATE/YEAR tag)
  original_year INTEGER,            -- first release of the album (ORIGINALDATE), null if unknown
  duration      REAL,               -- seconds
  format        TEXT,               -- 'flac', 'm4a', 'mp3', …
  size          INTEGER,
  mtime         INTEGER             -- ms since epoch; "recently added"
);

CREATE TABLE albums (
  key           TEXT PRIMARY KEY,   -- album.key
  title         TEXT NOT NULL,
  artist        TEXT NOT NULL,      -- resolved album artist (may be 'Various Artists')
  artist_key    TEXT NOT NULL REFERENCES artists(key),
  year          INTEGER,            -- what the app shows: original year when known, else edition year
  edition_year  INTEGER,
  original_year INTEGER,
  track_count   INTEGER,
  disc_count    INTEGER,
  duration      REAL,
  added         INTEGER             -- newest mtime among its tracks
);

CREATE TABLE artists (
  key           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  album_count   INTEGER             -- 0 for guest-only artists
);

CREATE TABLE track_genres (path TEXT, genre TEXT, genre_key TEXT);   -- one row per genre tag value
CREATE TABLE album_genres (album_key TEXT, genre TEXT, genre_key TEXT);

-- Mapping: a genre tag value (by key) belongs to one or more families.
CREATE TABLE genre_family (genre_key TEXT, family TEXT, PRIMARY KEY (genre_key, family));

-- Playlists, so queries can use them too.
CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE playlist_tracks (playlist_id TEXT, position INTEGER, path TEXT);
```

Indexes are not needed at this size.

Convenience views worth adding once the base works:

```sql
CREATE VIEW songs AS          -- one wide row per track; what most queries want
SELECT t.*, a.title AS album, a.artist AS album_artist,
       COALESCE(t.original_year, a.original_year, t.year) AS released
FROM tracks t JOIN albums a ON a.key = t.album_key;

CREATE VIEW track_families AS  -- tracks with their genre families
SELECT DISTINCT tg.path, gf.family
FROM track_genres tg JOIN genre_family gf USING (genre_key);
```

Example queries the feature must handle (make them the acceptance tests):

```sql
-- 80s rock
SELECT s.* FROM songs s JOIN track_families f USING (path)
WHERE f.family = 'rock' AND s.released BETWEEN 1980 AND 1989
ORDER BY s.album_artist, s.released, s.disc_no, s.track_no;

-- first album of Bruce Springsteen in the library
SELECT * FROM albums WHERE artist_key = 'bruce springsteen'
ORDER BY COALESCE(original_year, year) LIMIT 1;

-- longest albums without a cover … etc.
```

## Genre families

Current genre values on the owner's drive (36, from WMP and iTunes) include
`Rock`, `Classic Rock`, `Mainstream Rock`, `Metal & Hard Rock`,
`Indie / Alternative`, `Alternative`, `New Wave`, `Punk`, `Progressive`, and
Finnish names (`Soundtrackit`, `Maailmanmusiikki`, `Laulaja-lauluntekijä`,
`Espanjankielinen pop`). Run `node scripts/scan-dir.mjs <drive>` for the list.

- **Default mapping ships with the app** as a pure module
  (`app/js/genres.js`: `{ 'classic rock': ['rock'], 'metal & hard rock':
  ['rock', 'metal'], 'soundtrackit': ['soundtrack'], … }`), keyed by `keyOf()`.
  A genre can be in several families. Unmapped genres fall into a family named
  after themselves, so every genre has at least one family.
- **Owner's own overrides**: a later step. Options: an editable table in the
  query page persisted in IndexedDB `kv`, or plain SQL that the app runs after
  every rebuild (stored in `kv`, e.g. `INSERT INTO genre_family VALUES (…)`).
  The second is simpler and fits a SQL-literate owner; prefer it.
- Unit-test the mapping in Node (`test/genres.test.mjs`).

## UI

- A **Query** page (`#/query`), reachable from the nav. A monospace textarea,
  Ctrl+Enter runs, results below. Errors from SQLite are shown inline (and
  must not go to `console.error`, which fails the e2e harness).
- Result handling per the decision above: `path` column → track list with
  the usual track rows and Play / Shuffle / Add to queue / Save as playlist;
  `album_key` → album grid; otherwise a plain HTML table (cap rendered rows,
  e.g. 1,000, and say so).
- **Saved queries**: name + SQL, stored in IndexedDB `kv` (no schema change).
  Later, a saved query can act as a **smart playlist**: it re-runs after each
  rebuild. Store as a playlist with a `sql` field (playlist records are
  schemaless; no `DB_VERSION` bump needed), and make `playlists.js` resolve
  its tracks by running the query.
- A schema reference panel (table/column list) next to the editor, generated
  from `sqlite_master` so it never goes stale.

## Code structure

- `app/js/sqldb.js` (browser): loads SQLite WASM lazily (only when the Query
  page or a smart playlist needs it, so startup cost is unchanged), creates
  the schema, `fill(lib, playlists)`, `run(sql)` → `{ columns, rows }`.
- `app/js/sqlrows.js` (**pure**): `libraryRows(lib)` turns the built library
  into plain row arrays per table. All the mapping logic lives here so Node
  tests cover it without WASM.
- `app/js/genres.js` (**pure**): the default genre → family mapping.
- `app/js/ui/views.js` (or a new `ui/query.js`): the Query page.
- Rebuild trigger: wherever `main.js` replaces `app.lib` after
  `buildLibrary()`, mark the SQL database stale; refill lazily on next query.

## Things to check before starting

- **WASM loading under the service worker**: `sqlite3.wasm` must be served
  with `application/wasm` (check `server.mjs` and GitHub Pages) and added to
  `ASSETS` in `app/sw.js` (enforced by `test/assets.test.mjs`).
- **Which build file to vendor**: the plain in-memory build is enough; the
  OPFS/worker variants are not needed (no persistence). Check its size
  (~1 MB wasm expected) and that it works when loaded from the main thread.
- **Node tests**: verify whether `@sqlite.org/sqlite-wasm` runs in Node for
  in-memory databases (its docs say it does; confirm with the vendored copy).
  If not, Node 22.5+ ships `node:sqlite`, which can run the same schema and
  queries for tests, though the engine version may differ. `package.json`
  says Node >= 20; tests needing `node:sqlite` would have to skip on 20.
- **Drive disconnected**: everything is in memory, so queries keep working
  offline; playing a result follows the existing offline rules. Add an e2e
  test that runs a query with the drive unplugged.
- **Version/ASSETS invariants** in CLAUDE.md apply as usual.

## Steps

1. Vendor SQLite WASM; `sqldb.js` loads it and runs `SELECT sqlite_version()`
   in an e2e test.
2. `sqlrows.js` + `genres.js` with Node unit tests (rows match the library;
   duplicates excluded; adopted tags used; genre families).
3. Fill the tables; e2e test runs the two acceptance queries against a
   synthetic OPFS library.
4. Query page: editor, run, error display, three result renderings.
5. Track-list results: play/shuffle/queue/save as playlist.
6. Saved queries, then smart playlists.
7. Genre overrides as owner SQL run after each rebuild.
8. README: a "Queries" section with the schema and examples.

## Open questions

- Should `tracks` also carry composer, MusicBrainz IDs, and per-track
  original dates for compilations? (Only if the tag readers start keeping
  them; `makeTrack()` currently drops them.)
- Is the Query page useful on its own for the first release, before smart
  playlists? (Probably yes: play the result directly.)
