# Platter

A music player for the music on your own drive, built for a Chromebook.

Platter is a web app that installs into ChromeOS like any other app (own
window, own icon in the launcher and on the shelf). It reads music straight
from a folder you choose — typically on a USB hard drive — and lets you browse
it by **artist**, **album**, **genre** or **song**, pick something, and press
play. It also does playlists.

Nothing is uploaded anywhere. The music stays on the drive; Platter only reads
it. The library index, cover thumbnails and playlists are stored locally in
Chrome.

How it all works, explained for readers new to Chromebooks or web apps (how
a browser plays FLAC, how a web page can read a USB drive, what happens when
the drive is unplugged): the
[Platter Wiki](https://claude.ai/artifact/BkCUbFQpcP8vFDXoNmUjy2), written for
version 1.2.1.

## Install it on the Chromebook

1. In Chrome, open **https://stisti.github.io/platter/**.

2. Click the install icon at the right end of the address bar (or
   ⋮ → *Cast, save and share* → *Install page as app…*). Platter now has its
   own window and launcher icon.

3. Plug in the drive, press **Choose music folder**, and pick the folder that
   holds your music. If Chrome refuses the top level of the drive, pick the
   music folder inside it instead.

The first scan reads the tags of every file, which takes a while on a large
collection (albums appear as they are found). After that, starting the app is
instant and rescans only look at files that changed.

Once installed, the app keeps a copy of itself and opens without a network
connection. When online, it picks up the latest version each time it opens.
If a new version is published while Platter is open, a banner offers to
reload; the queue and the place in the song are kept. The version you are
running is shown next to the name in the sidebar.

The site is published from `main` by GitHub Actions when the version changes. Your music
is never uploaded: the page only reads the folder you choose, inside Chrome.

## Using it

- **Artists / Albums / Genres / Songs** in the sidebar are four views of the
  same library. Every artist, album, genre and playlist has **Play** and
  **Shuffle**; hovering an album shows a play button right on the cover.
- Clicking a song plays it and carries on with the rest of that album, artist
  page, playlist or search result.
- **⋮** or right-click on anything: *Play next*, *Add to queue*,
  *Add to playlist…*.
- The **queue** button (bottom right) shows what is coming up.
- **Playlists**: the **+** in the sidebar, or *Add to playlist…* on any song,
  album, artist or genre. Reorder by dragging, or with *Move up / Move down*.
- The Chromebook's media keys and the system media controls work.
- Platter remembers the queue and position, so next time **Play** resumes
  where you stopped.

| Key | Does |
| --- | --- |
| `Space` or `K` | Play / pause |
| `←` / `→` | Back / forward 10 seconds |
| `Ctrl` + `←` / `→` | Previous / next track |
| `M` | Mute |
| `/` | Search |

### When the drive is not connected

Platter is built around the drive being removable:

- The library, covers and playlists are stored in Chrome, so you can browse
  everything with the drive unplugged. A banner says the drive is missing.
- Pressing play without the drive explains what is wrong; the queue is kept.
- Unplugging the drive while music plays pauses playback and keeps your place.
- Plugging the drive back in is noticed within a few seconds. Press play.
- A scan that is interrupted by the drive disappearing never removes anything
  from the library.
- A drive that does not answer within a few seconds counts as not connected,
  so the app still opens. If Chrome does not answer at all (its saved data
  cannot be opened), Platter shows what it is waiting for after ten seconds
  instead of a blank window; reloading or restarting Chrome usually helps.

After a restart Chrome may ask you to confirm access to the folder again
(**Allow access** in the banner). Choosing *Allow on every visit* in Chrome's
prompt stops it asking.

### New music

Platter looks for changes on the drive each time it starts with the drive
connected and each time the drive is plugged in. To do it by hand: **⋮** next
to the drive status at the bottom of the sidebar → *Scan for new music*.

## Queries

**Query** in the sidebar runs SQL against the library: questions the other
views cannot answer, such as "80s rock" or "the first album of each artist".
Type SQL and press **Ctrl+Enter** (or **Run**). *Examples…* has a few to start
from; **Save…** keeps a query under a name, and a click on its name runs it
again.

How a result is shown depends on its columns:

- a **`path`** column: a list of **songs**, with *Play*, *Shuffle*, *Save as
  playlist* and the usual song menus;
- an **`album_key`** column (and no `path`): **albums**, as on the Albums page;
- anything else: a **table** (the first 1,000 rows of it).

*Songs* / *Albums* / *Table* above the result switches between the list and
the table. The page runs its query again whenever it is opened, so the result
follows the library through rescans. Queries work with the drive unplugged
(playing the result still needs the drive).

The database is SQLite, rebuilt in memory from what the app shows: album
artists as resolved, discs merged, duplicate copies left out. Nothing written
to it is kept, and nothing in it changes the music or the library.

| Table | One row per | Columns |
| --- | --- | --- |
| `tracks` | song | `path`, `title`, `artist`, `artist_key`, `album_key`, `disc_no`, `track_no`, `year`, `original_year`, `genres`, `duration` (seconds), `format`, `size`, `mtime` (ms since 1970) |
| `albums` | album | `album_key`, `title`, `artist`, `artist_key`, `year`, `edition_year`, `original_year`, `genres`, `track_count`, `disc_count`, `duration`, `added`, `has_cover` |
| `artists` | artist | `artist_key`, `name`, `album_count` (0 for guests on compilations), `track_count` |
| `genres` | genre | `genre_key`, `name` |
| `track_genres`, `album_genres` | genre of a song / album | `path` or `album_key`, `genre`, `genre_key` |
| `genre_family` | genre in a family | `genre_key`, `family` |
| `playlists`, `playlist_tracks` | playlist / entry | `id`, `name`; `playlist_id`, `position`, `path` |

Views: **`songs`** is `tracks` joined with its album (adds `album`,
`album_artist`, `album_artist_key`, and `released`: the original year when
known, else the year); **`track_families`** (`path`, `family`) and
**`album_families`** (`album_key`, `family`) give the genre families. The
panel next to the editor lists every table and column; clicking a name types
it into the query.

- **Keys** (`album_key`, `artist_key`, `genre_key`) are names in lower case
  with spaces tidied: `artist_key = 'bruce springsteen'`. They have the same
  name in every table, so joins can say `USING (album_key)`.
- **Genre families** group messy genre tags: *Classic Rock*, *Metal & Hard
  Rock* and *New Wave* are all in the `rock` family, *Soundtrackit* in
  `soundtrack`. Every genre is also in a family of its own name. The mapping
  is in `app/js/genres.js`; `node scripts/scan-dir.mjs /path/to/music --genres`
  shows how a collection's genres are mapped.
- **Years:** `year` is what the file says (a 2015 remaster says 2015);
  `original_year` is the first release, when the files carry an
  `ORIGINALDATE` tag.
- SQLite sorts text by its bytes (`Z` before `a`); add `COLLATE NOCASE` to
  sort as people do.
- Several statements may be run at once; the result is that of the first
  one that returns columns. A result stops at 100,000 rows.

```sql
-- 80s rock
SELECT s.* FROM songs s JOIN track_families f USING (path)
WHERE f.family = 'rock' AND s.released BETWEEN 1980 AND 1989
ORDER BY s.album_artist COLLATE NOCASE, s.released, s.disc_no, s.track_no;

-- The first album of Bruce Springsteen in the library
SELECT * FROM albums WHERE artist_key = 'bruce springsteen'
ORDER BY COALESCE(original_year, year) LIMIT 1;

-- Hours of music per decade
SELECT released / 10 * 10 AS decade, round(sum(duration) / 3600, 1) AS hours
FROM songs WHERE released IS NOT NULL GROUP BY decade;
```

**Setup SQL** (under the editor) is SQL of your own that runs every time the
tables are filled, before any query: your own genre families, views you use
often, corrections. For example:

```sql
INSERT INTO genre_family VALUES ('synth pop', 'rock');
CREATE VIEW long_songs AS SELECT * FROM songs WHERE duration > 600;
```

If a statement fails, the error is shown there; the statements before it have
run, the rest are skipped, and queries still work.

## Ripping CDs

Chrome cannot read audio CDs, so ripping happens in the Chromebook's Linux
environment with `scripts/rip/platter_rip.py`. It rips to the Chromebook's
own disk and copies the finished album into the music folder; Platter picks it
up on its next scan.

One-time setup:

1. Turn on Linux (Settings → About ChromeOS → Developers) and install
   [uv](https://docs.astral.sh/uv/). On first run uv sets up the ripper's
   Python environment (`scripts/rip/pyproject.toml`, pinned by `uv.lock`).
2. Share the music drive with Linux: Files app → right-click the drive →
   *Share with Linux*. It appears at `/mnt/shared/removable/<drive name>`.
3. Tell the ripper where the music folder is, e.g. in `~/.bashrc`:
   `export PLATTER_MUSIC_DIR=/mnt/shared/removable/<drive name>/Music`

Each time you plug in the CD drive: Settings → About ChromeOS → Developers →
Linux development environment → *Manage USB devices* → switch the drive on.
Then put in a disc and run:

```sh
npm run rip                          # rips into $PLATTER_MUSIC_DIR
npm run rip -- --dest /path/Music    # somewhere else this time
npm run rip -- --info                # look the disc up, don't rip
npm run rip -- --no-backup           # skip the backup command this time
```

What it does:

- **Reads the drive directly.** The ChromeOS Linux kernel has no CD-ROM
  driver (no `/dev/sr0`), so cdparanoia, whipper and the like cannot see the
  drive. The kernel does make a SCSI pass-through node, `/dev/bsg/H:C:T:L`,
  and the script sends the drive raw `READ CD` commands through it. The first
  run per plug-in asks `sudo` to give you access to that node.
- **Correct to the sample.** Audio is corrected for the drive's read offset,
  which is detected from the first suitable disc (via AccurateRip) and stored
  in `~/.config/platter-rip.json`. Each track is checked against
  [AccurateRip](http://www.accuraterip.com/); a track AccurateRip cannot
  vouch for is read a second time and every chunk that differs is re-read
  until two reads agree. The summary says which tracks are accurate, which
  were only compared, and which may have errors.
- **Gives up on a damaged disc.** Each track may take about as long as it
  plays (at least 2 minutes) before the ripper stops re-reading it, keeps the
  best reads it has and marks it "MAY HAVE ERRORS (damaged: gave up…)". A
  scratched disc then takes minutes per track, not hours. `--patience 3`
  allows three times as long; `--patience 0` never gives up.
- **Tags and cover from MusicBrainz.** Artist, album, titles, track and disc
  numbers, date, genre, label and MusicBrainz IDs, plus `cover.jpg` from the
  Cover Art Archive. If several releases match, they are listed and the first
  is used; pick another with `--release N`. For a multi-disc set the disc is
  recognised by its ID; when MusicBrainz cannot tell (it says so), give
  `--disc N`.
- **Only exact matches are used unasked.** When MusicBrainz does not know the
  disc's ID it offers releases with similar track timings. Those may be
  another pressing of the album, or a different album altogether, so they are
  listed, marked "similar timings only", and GnuDB is asked for an exact
  match. If there is none, **nothing is ripped**: check the listed releases
  and rip with `--release N` if one is right, or give `--artist` and
  `--album`. Whenever MusicBrainz lacks the disc's ID, the ripper prints a
  link for adding it there, so the next rip of that CD is recognised.
- **When MusicBrainz is busy or down** (HTTP 503, 429, other 5xx, no
  network), the lookup is retried for about two minutes. If MusicBrainz still
  cannot answer, the disc is looked up in [GnuDB](https://gnudb.org/) (the
  freedb successor: titles, year and genre, but no cover art or MusicBrainz
  IDs). If GnuDB does not know it either, **nothing is ripped**: try again
  later, or give `--artist` and `--album` to rip it with numbered tracks
  anyway. GnuDB only answers requests that carry an email address, so it is
  asked only once you put yours in `~/.config/platter-rip.json` as
  `"gnudb_email": "you@example.com"`; without it, a MusicBrainz outage
  simply stops the rip. The ripper calls itself `PlatterCDRipper` to GnuDB;
  "GnuDB refused: … Unknown application" means GnuDB does not (yet) accept
  that name (see [GnuDB's developer policy](https://gnudb.org/howtognudb.php)),
  and is treated like GnuDB being unavailable.
- A disc no database knows becomes "Track 01…"; give `--artist` and
  `--album` for the folder and tags.
- **`--artist` / `--album` always win.** Given either, the rip is tagged with
  them (tracks numbered) even when a database knows the disc; what the
  databases found is still listed. They cannot be combined with `--release`.
- **Files:** `<Album artist>/<Album>/NN Title.flac` (`D-NN Title.flac` on
  multi-disc releases), FLAC level 8, each checked to decode back to exactly
  the ripped audio.
- **Nothing half-done on the music drive.** Tracks are written to
  `~/.cache/platter-rip/<disc ID>/` first. Only when every track is done is
  the album copied to the music folder: into a hidden folder (Platter skips
  those), each file checked against the original, then renamed into place.
  The disc is ejected before the copy, so the next one can go in. An
  interrupted rip leaves its files only in the cache, and the next rip of
  that disc starts over. Existing files are never overwritten.
- **Backs the new album up, if you want.** Set `"backup_command"` in
  `~/.config/platter-rip.json` and the ripper runs it once the album is in
  the music folder (see below).
- **What goes online:** the disc's table of contents to MusicBrainz and
  AccurateRip, and the chosen release's MusicBrainz ID to the Cover Art
  Archive. GnuDB gets the table of contents and, if you set it up, your
  `gnudb_email`, and only when MusicBrainz cannot answer. No audio, and
  nothing else about you.

### Backing up new rips

The ripper can run a command of your choice on each new album, after it has
been copied to the music folder: put it in `~/.config/platter-rip.json` as
`backup_command`. For example, to copy the album to OneDrive with
[rclone](https://rclone.org/) (remote `onedrive:`, music in `Musiikki`):

```json
{
  "backup_command": "rclone copy %s onedrive:Musiikki/%r --progress"
}
```

- In the command, `%s` becomes the album's folder
  (`/mnt/shared/removable/tera/Music/Kitaro/Tunhuang`), `%r` the same folder
  relative to the music folder (`Kitaro/Tunhuang`) and `%%` a plain `%`.
  `rclone copy` copies a folder's *contents*, hence the `/%r` above: without
  it the tracks of every album would land loose in `Musiikki`.
- The command is split into words like a shell would (quotes work), but is
  not run by a shell: a path with spaces or quotes is always passed as one
  word, so no quoting is needed around `%s` or `%r`. For pipes, `&&` and the
  like, write a script and use that as the command.
- Its output is shown as it runs. If it fails, the ripper says so, prints the
  command for running it again by hand, and exits with status 1; the album
  stays in the music folder either way. If the command is not installed, the
  ripper says so before ripping.
- `--backup "CMD"` uses another command this time; `--no-backup` skips the
  backup. Without a `backup_command` (and no `--backup`) nothing is backed up.
- `--info` and `--find-offset` rip nothing, so they back nothing up.

Tests for the ripper: `npm run test:rip`.

### Original release years for older rips

An album's year in Platter is when it *first* came out, taken from the
`ORIGINALDATE` tag. The ripper writes it; older rips and iTunes purchases
usually only say when their own edition came out (a 2002 remaster of a 1984
album says 2002, and Windows Media Player's years are often off by one).
`scripts/rip/platter_years.py` adds the tag to those files, in two steps:

```sh
npm run years -- lookup              # look everything up; writes a plan, changes nothing
# read and edit ~/.cache/platter-years/plan.tsv
npm run years -- apply --dry-run     # what would be written
npm run years -- apply --limit 3     # try it on three albums first
npm run years -- apply               # write the rows marked "yes"
```

- **Lookup** groups the files into albums and finds each in MusicBrainz.
  Windows Media Player saved the CD's table of contents in every file it
  ripped (`WM/MCDI`), which gives the exact MusicBrainz disc ID: those rows
  say `yes`. Albums without it (iTunes files) are searched by album artist
  and title; those rows say `check`, with the candidates in the `note`
  column, and are only written once you change them to `yes`. You can also
  type a date yourself.
- **Apply** adds `ORIGINALDATE` and `MUSICBRAINZ_RELEASEGROUPID` (iTunes
  files: the same as `----:com.apple.iTunes:` items, as MusicBrainz Picard
  writes them). Existing tags are never changed, and files that already have
  `ORIGINALDATE` are skipped, so it can be stopped and run again.
- **Safe rewriting.** Files ripped by Windows Media Player have no spare room
  for tags, so each is rewritten whole: copied to the Chromebook's disk,
  tagged there, checked to contain byte-identical audio, copied back next to
  the original under a hidden name, checked again, and renamed over the
  original. Unplugging the drive midway leaves the old file or the new one,
  never a broken one. It reads every file twice and writes it once, so a
  large collection takes a while.
- **Backups.** The files' modification times change, so a backup that skips
  existing files (`rclone copy --ignore-existing`) will not pick up the new
  tags; run a plain `rclone copy` (or equivalent) once afterwards.
- **What goes online:** each CD's table of contents and the names of the
  albums that need a search, to MusicBrainz. Answers are cached in
  `~/.cache/platter-years/`; `lookup --refresh` asks again.

## How the library is built

- **Formats:** FLAC, M4A (AAC, as sold by iTunes) and MP3 tags are read in
  full. Ogg, Opus, AAC and WAV files are played and listed, named from their
  folders and file names.
- **Copy-protected iTunes purchases** (`.m4p`, and `.m4a` files with FairPlay
  DRM) can only be played by Apple's own apps. They are left out, and the
  first scan says how many there were.
- **Untagged files** are named from their path:
  `Artist/Album/01 - Title.flac`.
- **"Unknown" stand-in tags.** When a ripper such as Windows Media Player
  cannot identify a CD it writes tags like *Unknown artist*, *Unknown album
  (date)*, *Track 1* (in the computer's language — English, Finnish, Swedish
  and German are recognised). Those are treated as missing. If such a track
  sits in a folder of properly tagged tracks, it joins their album; otherwise
  it is named from its path.
- **Albums** are grouped by album artist + album title.
  - `Album [Disc 1]` / `Album [Disc 2]` (or `(CD 2)`) are one album with disc
    headings, as are albums spread over `CD1`/`CD2` folders.
  - A multi-disc set ripped into one folder with no disc numbers is split
    into discs by the order the files were written in.
  - Tracks by different artists in one album folder (and no album-artist
    tag) become a *Various Artists* album.
- **Duplicates.** If the same song is on the drive more than once — the same
  album as FLAC and as AAC, or a copied iTunes library — it is shown once.
  The FLAC copy wins, then the larger file. Nothing on the drive is touched.
- **Artists** lists album artists. An artist's page also shows the
  compilations they appear on; guest-only artists are found through search.
- **Years.** An album's year is when it first came out (`ORIGINALDATE`, or
  `TDOR`/`TORY` in MP3s) when the files say so; otherwise the year of the
  edition (`DATE`/`YEAR`). A reissue's album page shows both: *1984 · 2015
  edition*. See *Original release years for older rips* for adding the tag
  to files that lack it.
- **Genres** come from the genre tag; a song can be in several
  (`Rock; Blues`).
- **Covers** come from an image in the album folder (`cover.jpg`,
  `folder.jpg`, `front.jpg`, Windows Media Player's `AlbumArt…jpg`) or the
  picture embedded in the files — whichever is largest. They are shrunk and
  stored once. Albums with neither show a coloured placeholder.
- **Search** ignores case, accents and punctuation: `born usa` finds
  *Born in the U.S.A.*

To see how Platter interprets a collection without opening the app:

```sh
node scripts/scan-dir.mjs /path/to/music --albums
```

(The USB drive is only visible to Linux after *Share with Linux* in the Files
app.)

## Development

No build step: `app/` is plain HTML, CSS and JavaScript modules, served
as-is. The one runtime dependency, SQLite for the Query page, is vendored
(see below).

```
app/
  index.html, manifest.webmanifest, sw.js   page shell, install manifest, offline copy
  css/app.css
  js/
    flac.js, mp4.js, id3.js, bytes.js   tag readers (FLAC, M4A, MP3)
    tags.js                     file -> track record (tags, falling back to the path)
    library.js                  track records -> albums / artists / genres, search
    coverpick.js, covers.js     choosing and thumbnailing cover art
    scanner.js                  incremental walk of the music folder
    sync.js                     library sync: scan results -> saved records, never losing tracks to a vanished drive
    librarystate.js             the library being shown, and the only way to change it
    source.js                   the folder handle: permission and connected/disconnected state
    queue.js, player.js         play queue; audio playback with next-track preloading
    playlists.js, db.js         playlists; IndexedDB storage
    genres.js, sqlrows.js       genre families; the library as SQL tables (schema and rows)
    sqldb.js                    SQLite in memory: loading it, filling it, running queries
    librarysql.js               SQL over the library: kept fresh, setup SQL, saved queries, results as songs/albums
    main.js, ui/                wiring, views, player bar, the Query page (ui/query.js)
    version.js, update.js       the running version; noticing a newer published one
  vendor/sqlite/                SQLite compiled to WebAssembly (@sqlite.org/sqlite-wasm)
server.mjs                      static file server for app/
scripts/                        icons, service installer, command-line scanner, parser fuzzing
test/                           unit tests; test/e2e/ browser tests
```

To run the app from a working copy, start the development server and open
**http://localhost:7373** — it has to be `localhost`, not
`penguin.linux.test`: Chrome only allows folder access on `localhost` or
HTTPS. (`scripts/install-service.sh` keeps it running whenever Linux is up;
`--remove` undoes it.)

```sh
npm install
npm start           # http://localhost:7373
npm test            # unit tests (Node only)
npm run test:e2e    # the real app in headless Chromium, against a simulated drive
npm run test:rip    # the CD ripper (Python, through uv)
npm run typecheck   # JSDoc types of the pure modules (see below)
npm run test:all    # all of the above
```

The unit tests include fuzzing of the tag readers: damaged copies of
generated FLAC, MP3 and M4A files must each give a well-formed result or the
parser's own "not a … file" error. After refactoring a parser,
`npm run fuzz:parsers -- --ref main` also checks that it reads every one of
those files exactly as the version at that git ref does
(`--rounds` and `--seed` vary the corpus).

The browser tests need a Chromium: one downloaded by Playwright
(`npx playwright-core install chromium`), a system one, or `CHROME_PATH=…`;
without one they are skipped (in CI, where `CI` is set, they fail instead). They
simulate the drive with a folder in the browser's private file system, which
provides the same kind of folder handle Chrome gives for a real drive —
including the way it fails when the folder disappears.

When adding or removing a file under `app/`, update the `ASSETS` list in
`app/sw.js` (a test checks this).

### Type checking

The code is JavaScript, but `npm run typecheck` runs the TypeScript compiler
over it as a checker: it reads the types from JSDoc comments (`@param`,
`@typedef`, `@import`) and compiles nothing, so there is still no build step.
It covers the modules listed in `tsconfig.json`, so far the pure ones
(the tag readers, `library.js`, `scanner.js`, `sync.js`, `sqlrows.js`, …).
To check another module, add it there and fix what `tsc` reports.

The shared shapes are declared once: `TrackRecord` (what is stored per file)
in `tags.js`; `Track`, `Album`, `Artist`, `Genre` and `Library` in
`library.js`. Other modules import them with
`/** @import { Library } from './library.js' */`.

Strict mode is off (TypeScript 7 turns it on by default; `tsconfig.json` turns
it off). Turning it on would mean typing every function parameter and handling
every possible `null`, a couple of hundred changes in the pure modules alone.

**SQLite** is the official WebAssembly build, copied from the npm package
`@sqlite.org/sqlite-wasm` (currently 3.54.1-build1): its `dist/index.mjs` as
`app/vendor/sqlite/sqlite3.mjs`, and `dist/sqlite3.wasm`. Nothing else from
the package is needed (the OPFS and worker files are for databases stored on
disk). It is only downloaded when the Query page is first used. To update it:

```sh
npm pack @sqlite.org/sqlite-wasm@<version>   # in a scratch folder; check the
tar xzf sqlite.org-sqlite-wasm-*.tgz         # tarball against `npm view … dist.integrity`
cp package/dist/index.mjs  <repo>/app/vendor/sqlite/sqlite3.mjs
cp package/dist/sqlite3.wasm <repo>/app/vendor/sqlite/sqlite3.wasm
```

The unit tests run the same files in Node (`test/helpers/sqlite.mjs`).
Compiling WebAssembly needs `'wasm-unsafe-eval'` in the page's Content
Security Policy (`index.html`); it allows nothing else.

### CI and publishing

- `.github/workflows/pr.yml` runs the unit tests, the type check, and the
  ripper and browser tests on every pull request.
- `.github/workflows/pages.yml` publishes `app/` to GitHub Pages when a push
  to `main` changes the version (see below), after running the unit tests.
  The `github-pages` environment only accepts deployments from `main`, so
  pull requests (including ones from forks) cannot publish anything.

### Releasing a version

Merging to `main` doesn't publish anything by itself: changes collect on
`main` until the version number changes. To release them, bump the version
and push that to `main`:

```sh
npm version minor   # or patch / major
git commit -am "Version $(node -p 'require("./package.json").version')"
```

`npm version` updates `package.json` and `app/js/version.js` together (a
test checks they match). `.npmrc` stops it from making a commit and tag of
its own, so the bump can also go into a pull request with the change it
releases.

The Pages workflow deploys whenever the version in the repo differs from the
one on the live site, so a failed deploy is retried by the next push.
Running the workflow by hand (Actions → *Deploy to GitHub Pages* → *Run
workflow*) always deploys. Open Platter windows notice the new version and
offer to reload.

## Limits worth knowing

- Chrome (or another Chromium browser) only: Platter depends on the File
  System Access API.
- Track changes are near-gapless (the next track is loaded in advance), not
  sample-accurate gapless.
- The library belongs to the Chrome profile and the address it was scanned
  in: the app from `stisti.github.io` and one served from `localhost` have
  separate libraries. Clearing Chrome's site data for the address removes the
  library, covers and playlists (the music itself is untouched; a scan
  rebuilds the library).

## License

[MIT](LICENSE). The interface icons are Material Design icon paths by Google,
used under the Apache License 2.0. SQLite is in the public domain; its
WebAssembly packaging (`app/vendor/sqlite/`) is from
[sqlite-wasm](https://github.com/sqlite/sqlite-wasm), Apache License 2.0.
