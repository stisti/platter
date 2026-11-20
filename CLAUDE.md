# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Platter is a music player PWA for a Chromebook: it reads music from a user-chosen folder (usually a removable USB drive) via the File System Access API and keeps its library index, covers and playlists in IndexedDB. README.md is the authoritative user and developer doc; this file covers what you need to change the code safely.

## Commands

No build step — `app/` is served as-is. The one runtime dependency, SQLite WASM for the Query page, is vendored in `app/vendor/sqlite/` (README "Development" says how to update it). Node >= 20; the dev dependencies are `playwright-core` and `typescript` (a checker only: see "Type checking" below).

```sh
npm start                     # dev server on http://localhost:7373 (PORT=… to change)
npm test                      # unit tests: node --test test/*.test.mjs
npm run test:e2e              # real app in headless Chromium, serial
npm run typecheck             # tsc over the JSDoc types of the modules in tsconfig.json; emits nothing
npm run test:all              # unit + typecheck + rip + e2e
node --test test/library.test.mjs                        # one file
node --test --test-name-pattern='various' test/*.test.mjs  # tests matching a name
node scripts/scan-dir.mjs /path/to/music --albums        # how the library logic reads a real folder
npm run rip -- --info         # CD ripper (Python via uv, Linux only); --info looks the disc up without ripping
npm run test:rip              # ripper + year tool unit tests (needs uv; in test:all and PR CI, not in npm test)
npm run years -- lookup       # find original release years for old rips; writes a plan, changes nothing
```

The CD ripper (`scripts/rip/platter_rip.py`) is separate from the web app: Chrome cannot read audio CDs, and the ChromeOS Linux kernel has no CD driver (no `/dev/sr0`/`/dev/sg*`), so it sends SCSI commands through `/dev/bsg/*` with the SG_IO v4 ioctl. Its deps are in `scripts/rip/pyproject.toml` + `uv.lock` (add with `uv add --project scripts/rip`). `scripts/rip/platter_years.py` shares that environment and the ripper's MusicBrainz code: it adds `ORIGINALDATE` to existing files (the only code that modifies files already on the drive; it rewrites each file via a verified local copy and never changes existing tags). It rips into `~/.cache/platter-rip/` and copies the finished album into the music folder (`$PLATTER_MUSIC_DIR` or `--dest`) — only FLAC + `cover.jpg`; the app finds them on rescan. README "Ripping CDs" documents it.

- Use `http://localhost:7373`, not `penguin.linux.test`: Chrome only grants folder access on localhost or HTTPS.
- E2E tests need a Chromium (`$CHROME_PATH`, a Playwright download via `npx playwright-core install chromium`, or a system one — see `scripts/find-chrome.mjs`). Without one they are **skipped** locally but **fail** when `CI` is set.
- There is no linter or formatter configured.

## Architecture

**Pure modules vs. browser modules.** The data logic is written to run unchanged in both the browser and Node, which is how unit tests and `scripts/scan-dir.mjs` exercise it:

- Pure (Node-importable): `bytes.js`, `flac.js` / `mp4.js` / `id3.js` (tag parsers), `tags.js` (file → track record, falling back to the path), `library.js` (track records → albums/artists/genres/search), `coverpick.js`, `scanner.js` (takes a directory handle and an injected `readTrack`), `sync.js` (Library sync: the rules around a scan; takes an injected track store and cover builder), `librarystate.js` (Library state: the current library and every change to it), `queue.js`, `genres.js` (genre → families), `sqlrows.js` (SQL schema + built library → table rows), `sqldb.js` (lazily `import()`s the vendored SQLite; Node tests pass the `.wasm` bytes via `test/helpers/sqlite.mjs`).
- Browser-only: `db.js` (IndexedDB), `source.js` (folder handle, permission, drive connected/disconnected), `covers.js`, `player.js`, `playlists.js`, `update.js`, `main.js` and `ui/`.

Keep new library/tag logic in the pure modules so it stays testable in Node. Tests feed them synthetic media built by `test/helpers/media.mjs` (`buildFlac`, `buildM4a`, `buildId3v2`, `fakeDirectory`, …) rather than fixture files.

**Data flow.** `scanner.js` walks the folder and reads only new or changed files (same size + mtime + `TRACK_VERSION` → reuse the stored record). `sync.js` (`syncLibrary`) wraps each scan: it saves records in the `tracks` store (keyed by path) batch by batch, applies the removal guard, rebuilds the whole in-memory library with `buildLibrary`, builds covers, and resolves with an outcome (never throws for a vanished drive). `librarystate.js` (`LibraryState`, `app.library`) holds the library being shown (`app.lib` reads it) and is the only way to change it: `load()`, `sync()` (runs `syncLibrary`, one at a time) and `learnDuration()` (a length the player learned). A built library is never edited in place: a change saves the record and rebuilds the in-memory index, and a `change` event with a reason tells `main.js` to render; whatever derives from the library (the SQL copy, album totals) sees a new object. Node tests for both use `memoryTrackStore()` (`test/helpers/trackstore.mjs`). Album/artist identity uses `keyOf()` (case/whitespace-insensitive); search uses `searchForm()` (also ignores accents and punctuation).

- **Changing a track outside a scan?** Add a method to `LibraryState` (like `learnDuration`); never set fields on a `Track` from `app.lib`.

- **Changing how a track record is derived from a file?** Bump `TRACK_VERSION` in `app/js/tags.js`, or existing libraries keep the old records forever (unchanged files are never re-read).
- **IndexedDB schema** lives in `db.js` (`tracks`, `covers`, `playlists`, `kv`). Changing stores requires bumping `DB_VERSION` and handling upgrade.

**The drive can vanish at any moment** — this is a core design constraint, not an edge case. A scan interrupted by the drive disappearing throws `ScanInterrupted` and must never remove tracks from the library; playback pauses and keeps its place; the library must stay browsable offline. Preserve these behaviours; the e2e suite tests them.

**E2E harness** (`test/e2e/harness.mjs`) simulates the drive with a folder in the browser's origin-private file system (OPFS), which yields real `FileSystemDirectoryHandle`s; "unplugging" deletes that folder. It fails tests on any page error or `console.error`.

**Type checking.** JavaScript with JSDoc types, checked by `tsc` (TypeScript 7, `strict` off) for the modules listed in `tsconfig.json` `include`: so far the pure ones. Shared types: `TrackRecord` in `tags.js`; `Track`, `Album`, `Artist`, `Genre`, `Library` in `library.js`; import them with `/** @import { Library } from './library.js' */`. When you change a record or library shape, update the typedef too. Never import the vendored SQLite by a literal path (see `SQLITE_MODULE` in `sqldb.js`): tsc would follow it and check that generated code. To bring a browser module under the check, add it to `include` and fix what tsc reports.

**SQL queries** (`#/query`, `ui/query.js`). `app.sqlDatabase()` in `main.js` fills an in-memory SQLite from the *built* library (`libraryRows(lib)`), not from stored records, and refills only when `app.lib` is replaced or `app.sql.changes` is bumped (playlists, covers, setup SQL). Schema changes go in `SCHEMA` and `COLUMNS` in `sqlrows.js` together (`test/sqldb.test.mjs` checks they agree) and in README "Queries". The Query page treats a `path` column as songs and `album_key` as albums. SQL errors are shown inline as `QueryError`, never logged. Saved queries and setup SQL live in IndexedDB `kv` (`savedQueries`, `sqlSetup`).

**Offline + updates.** `app/sw.js` is network-first with a cached fallback. `update.js` polls the published `js/version.js` (with `cache: 'no-store'`) to offer a reload banner in long-open windows.

## Invariants enforced by tests

- Adding or removing any file under `app/` → update the `ASSETS` list in `app/sw.js` (`test/assets.test.mjs`).
- The CSP in `index.html` needs `'wasm-unsafe-eval'` for SQLite; without it the Query e2e tests fail.
- `VERSION` in `app/js/version.js` must equal `package.json` `version` (`test/version.test.mjs`). Never edit it by hand; use `npm version patch|minor|major`, which syncs both via `scripts/sync-version.mjs`. `.npmrc` disables npm's auto commit/tag.

## Release / CI

- `pr.yml`: unit + e2e tests on every PR.
- `pages.yml`: on push to `main`, deploys `app/` to GitHub Pages **only if the version differs from the live site**. Merging alone publishes nothing; a version bump releases what has accumulated on `main`. Don't bump the version unless asked to release.
