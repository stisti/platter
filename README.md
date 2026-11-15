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

After a restart Chrome may ask you to confirm access to the folder again
(**Allow access** in the banner). Choosing *Allow on every visit* in Chrome's
prompt stops it asking.

### New music

Platter looks for changes on the drive each time it starts with the drive
connected and each time the drive is plugged in. To do it by hand: **⋮** next
to the drive status at the bottom of the sidebar → *Scan for new music*.

## Ripping CDs

Chrome cannot read audio CDs, so ripping happens in the Chromebook's Linux
environment with `scripts/rip/platter_rip.py`, which writes FLAC files
straight into the music folder. Platter picks the album up on its next scan.

One-time setup:

1. Turn on Linux (Settings → About ChromeOS → Developers) and install
   [nix](https://nixos.org/download/); the script fetches Python, numpy and
   `flac` through it on first run.
2. Share the music drive with Linux: Files app → right-click the drive →
   *Share with Linux*. It appears at `/mnt/shared/removable/<drive name>`.

Each time you plug in the CD drive: Settings → About ChromeOS → Developers →
Linux development environment → *Manage USB devices* → switch the drive on.
Then put in a disc and run:

```sh
npm run rip                          # rips into /mnt/shared/removable/tera/Music
npm run rip -- --dest /path/Music    # somewhere else
npm run rip -- --info                # look the disc up, don't rip
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
- **Tags and cover from MusicBrainz.** Artist, album, titles, track and disc
  numbers, date, genre, label and MusicBrainz IDs, plus `cover.jpg` from the
  Cover Art Archive. If several releases match, they are listed and the first
  is used; pick another with `--release N`. A disc MusicBrainz does not know
  becomes "Track 01…"; give `--artist` and `--album` for the folder and tags.
- **Files:** `<Album artist>/<Album>/NN Title.flac` (`D-NN Title.flac` on
  multi-disc releases), FLAC level 8. Existing files are never overwritten.
  The disc's table of contents is sent to MusicBrainz and AccurateRip to look
  it up; nothing else leaves the Chromebook.

Tests for the ripper: `npm run test:rip`.

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

No build step and no runtime dependencies: `app/` is plain HTML, CSS and
JavaScript modules, served as-is.

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
    source.js                   the folder handle: permission and connected/disconnected state
    queue.js, player.js         play queue; audio playback with next-track preloading
    playlists.js, db.js         playlists; IndexedDB storage
    main.js, ui/                wiring, views, player bar
    version.js, update.js       the running version; noticing a newer published one
server.mjs                      static file server for app/
scripts/                        icons, service installer, command-line scanner
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
npm run test:all
```

The browser tests need a Chromium: one downloaded by Playwright
(`npx playwright-core install chromium`), a system one, or `CHROME_PATH=…`;
without one they are skipped (in CI, where `CI` is set, they fail instead). They
simulate the drive with a folder in the browser's private file system, which
provides the same kind of folder handle Chrome gives for a real drive —
including the way it fails when the folder disappears.

When adding or removing a file under `app/`, update the `ASSETS` list in
`app/sw.js` (a test checks this).

### CI and publishing

- `.github/workflows/pr.yml` runs both test suites on every pull request.
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
used under the Apache License 2.0.
