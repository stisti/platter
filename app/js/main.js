// Application entry point: wires the library, the drive connection, the
// player and the views together.

import { db, trackStore } from './db.js';
import { MusicSource } from './source.js';
import { Player } from './player.js';
import { Playlists } from './playlists.js';
import { CoverStore } from './covers.js';
import { LibraryState } from './librarystate.js';
import { readTrack } from './tags.js';
import { keyOf } from './library.js';
import { libraryRows } from './sqlrows.js';
import { loadSqlite, LibraryDatabase } from './sqldb.js';
import { h, icon, iconButton, toast, openMenu, plural, promptDialog, playlistDialog } from './ui/dom.js';
import {
  albumsView, albumView, artistsView, artistView, genresView, genreView, songsView,
  playlistsView, playlistView, searchView, welcomeView, refreshCovers,
} from './ui/views.js';
import { queryView } from './ui/query.js';
import { mountPlayerBar, mountQueuePanel } from './ui/playerbar.js';
import { VERSION } from './version.js';
import { watchForUpdates } from './update.js';

const PREFS_KEY = 'platter.prefs';
const POSITION_KEY = 'platter.position';
const LENSES = ['artists', 'albums', 'genres', 'songs'];

const ROUTES = {
  artists: artistsView,
  artist: artistView,
  albums: albumsView,
  album: albumView,
  genres: genresView,
  genre: genreView,
  songs: songsView,
  playlists: playlistsView,
  playlist: playlistView,
  search: searchView,
  query: queryView,
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

const $ = (id) => document.getElementById(id);

const app = {
  supported: MusicSource.supported,
  /** The library and every change to it (librarystate.js); `change` events say when it is replaced. */
  library: new LibraryState({ store: trackStore }),
  /** The library being shown. Never edited in place: a change replaces it. */
  get lib() {
    return this.library.current;
  },
  source: new MusicSource(),
  covers: new CoverStore(),
  playlists: new Playlists(),
  /** @type {Player} */
  player: null,
  prefs: loadPrefs(),
  scan: { active: false, progress: null, controller: null },
  /** The SQL copy of the library (see sqlDatabase()); `changes` counts edits that make it stale. */
  sql: { ready: null, filled: null, changes: 0, setup: '', setupDraft: null, setupError: null, saved: [] },
  scroller: $('view'),
  _disposers: [],

  setPref(key, value) {
    this.prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // storage full or unavailable: preferences just won't stick
    }
  },

  /** Views register cleanup (scroll listeners etc.) to run when they are replaced. */
  onViewDispose(fn) {
    this._disposers.push(fn);
  },

  navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  },

  rerender(options = { keepScroll: true }) {
    render(options);
  },

  // ---------------------------------------------------------------- SQL

  /**
   * The library as an SQLite database, for the Query page. SQLite is started
   * on first use, and the tables are refilled only when something changed
   * since the last fill: the library, a playlist, the covers, the setup SQL.
   */
  async sqlDatabase() {
    const { sql } = this;
    sql.ready ??= loadSqlite().then((sqlite3) => new LibraryDatabase(sqlite3));
    let db;
    try {
      db = await sql.ready;
    } catch (err) {
      sql.ready = null; // try again next time (it may have failed offline)
      throw err;
    }
    const stamp = `${sql.changes}`;
    if (sql.filled?.lib !== this.lib || sql.filled.stamp !== stamp) {
      const rows = libraryRows(this.lib, { playlists: this.playlists.list, hasCover: (key) => this.covers.has(key) });
      sql.setupError = db.fill(rows, { setup: sql.setup });
      sql.filled = { lib: this.lib, stamp };
    }
    return db;
  },

  /** The error from the owner's setup SQL at the last fill, if it failed. */
  sqlSetupError() {
    return this.sql.setupError;
  },

  /** Saves a query under a name (replacing one of the same name). Kept in IndexedDB `kv`. */
  async saveQuery(name, sql) {
    const saved = this.sql.saved.filter((q) => q.name !== name);
    saved.push({ name, sql });
    saved.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
    this.sql.saved = saved;
    await db.put('kv', saved, 'savedQueries');
  },

  async deleteQuery(name) {
    this.sql.saved = this.sql.saved.filter((q) => q.name !== name);
    await db.put('kv', this.sql.saved, 'savedQueries');
  },

  /**
   * The owner's setup SQL: run after every refill of the tables, for genre
   * families of their own, views, and the like.
   */
  async setSqlSetup(sql) {
    this.sql.setup = sql;
    this.sql.changes++;
    await db.put('kv', sql, 'sqlSetup');
  },

  // ----------------------------------------------------------- playback

  /**
   * Replaces the queue with `tracks` and plays. `startIndex` is the track the
   * user clicked (null = from the top). `shuffle` true/false switches shuffle
   * on or off first; left out, the current setting stays.
   */
  async play(tracks, startIndex = null, { shuffle } = {}) {
    const list = [];
    let start = startIndex;
    tracks.forEach((t, i) => {
      if (t) list.push(t.path);
      else if (startIndex !== null && i < startIndex) start--;
    });
    if (!list.length) {
      toast('There is nothing to play here.');
      return;
    }
    if (this.source.state === 'needs-permission') await this.source.requestAccess();
    if (shuffle !== undefined) this.player.queue.setShuffle(shuffle);
    await this.player.playQueue(list, start);
  },

  async togglePlay(forcePlay = false) {
    const { player } = this;
    const playing = player.state === 'playing' || player.state === 'loading';
    if (playing && !forcePlay) {
      player.pause();
      return;
    }
    if (this.source.state === 'needs-permission') await this.source.requestAccess();
    await player.play();
  },

  playNext(tracks) {
    const ids = tracks.filter(Boolean).map((t) => t.path);
    if (!ids.length) return;
    this.player.enqueue(ids, { next: true });
    toast(ids.length === 1 ? 'Playing next' : `${plural(ids.length, 'song')} will play next`);
  },

  addToQueue(tracks) {
    const ids = tracks.filter(Boolean).map((t) => t.path);
    if (!ids.length) return;
    this.player.enqueue(ids);
    toast(ids.length === 1 ? 'Added to the queue' : `${plural(ids.length, 'song')} added to the queue`);
  },

  toggleQueue(open = $('queue').hidden) {
    $('queue').hidden = !open;
    document.body.classList.toggle('queue-open', open);
    this.setPref('queueOpen', open);
    ui.playerBar.setQueueOpen(open);
    ui.queuePanel.render();
  },

  // ---------------------------------------------------------- playlists

  async createPlaylist(tracks = []) {
    const name = await promptDialog({ title: 'New playlist', label: 'Playlist name', okLabel: 'Create' });
    if (!name) return null;
    const playlist = await this.playlists.create(name, tracks.filter(Boolean).map((t) => t.path));
    this.navigate(`#/playlist/${encodeURIComponent(playlist.id)}`);
    return playlist;
  },

  async addToPlaylist(tracks) {
    const paths = tracks.filter(Boolean).map((t) => t.path);
    if (!paths.length) return;
    const choice = await playlistDialog({
      title: paths.length === 1 ? 'Add to playlist' : `Add ${plural(paths.length, 'song')} to playlist`,
      playlists: this.playlists.list,
    });
    if (!choice) return;
    let playlist;
    if (choice.create) playlist = await this.playlists.create(choice.create, paths);
    else {
      playlist = this.playlists.get(choice.id);
      await this.playlists.addTracks(choice.id, paths);
    }
    if (!playlist) return;
    toast(`Added to “${playlist.name}”`, {
      action: { label: 'Open', onClick: () => this.navigate(`#/playlist/${encodeURIComponent(playlist.id)}`) },
    });
  },

  // -------------------------------------------------------------- menus

  trackMenu(anchor, track, extraItems = null) {
    openMenu(anchor, [
      { label: 'Play next', icon: 'playNext', onClick: () => this.playNext([track]) },
      { label: 'Add to queue', icon: 'queue', onClick: () => this.addToQueue([track]) },
      { label: 'Add to playlist…', icon: 'playlistAdd', onClick: () => this.addToPlaylist([track]) },
      'separator',
      { label: 'Go to album', icon: 'album', onClick: () => this.navigate(`#/album/${encodeURIComponent(track._albumKey)}`) },
      { label: 'Go to artist', icon: 'person', onClick: () => this.navigate(`#/artist/${encodeURIComponent(keyOf(track.artist))}`) },
      ...(extraItems ? ['separator', ...extraItems] : []),
    ]);
  },

  /** Menu for anything that stands for a list of tracks: an album, artist, genre, playlist. */
  collectionMenu(anchor, getTracks) {
    openMenu(anchor, [
      { label: 'Play', icon: 'play', onClick: () => this.play(getTracks(), null, { shuffle: false }) },
      { label: 'Shuffle', icon: 'shuffle', onClick: () => this.play(getTracks(), null, { shuffle: true }) },
      'separator',
      { label: 'Play next', icon: 'playNext', onClick: () => this.playNext(getTracks()) },
      { label: 'Add to queue', icon: 'queue', onClick: () => this.addToQueue(getTracks()) },
      { label: 'Add to playlist…', icon: 'playlistAdd', onClick: () => this.addToPlaylist(getTracks()) },
    ]);
  },

  // ------------------------------------------------------- music folder

  async chooseFolder() {
    try {
      await this.source.pick();
    } catch (err) {
      if (err?.name === 'AbortError') return; // picker dismissed
      console.error(err);
      toast('That folder could not be opened. Try a folder inside the drive, such as its Music folder.', { kind: 'error', duration: 8000 });
      return;
    }
    navigator.storage?.persist?.().catch(() => {});
    refreshChrome();
    render();
    if (this.source.state === 'connected') this.rescan();
  },

  async reconnect() {
    const state = this.source.state === 'needs-permission' ? await this.source.requestAccess() : await this.source.check();
    if (state === 'disconnected') toast('Still can’t find the music drive. Check that it is plugged in and shows up in the Files app.');
  },

  /**
   * Brings the library up to date with the drive (sync.js has the rules).
   * @param {{quiet?: boolean}} [options] quiet: no messages unless something changed
   */
  async rescan({ quiet = false } = {}) {
    if (this.scan.active) return;
    if (this.source.state === 'needs-permission') await this.source.requestAccess();
    if (this.source.state !== 'connected') {
      if (!quiet) toast('Connect the music drive first, then scan.');
      return;
    }
    const controller = new AbortController();
    this.scan = { active: true, progress: { phase: 'walk', found: 0 }, controller };
    refreshChrome();
    if (this.lib.tracks.size === 0) render();

    try {
      // The libraries it hands back arrive as `change` events (see showLibrary).
      const outcome = await this.library.sync({
        root: this.source.root,
        readTrack,
        buildCovers: (options) => this.covers.build({ ...options, getFile: (path) => this.source.getFile(path) }),
        isAlive: async () => (await this.source.check()) === 'connected',
        quiet,
        signal: controller.signal,
        onProgress: (progress) => {
          this.scan.progress = progress;
          refreshScanStatus();
        },
      });
      reportSync(outcome, { quiet });
    } finally {
      this.scan = { active: false, progress: null, controller: null };
      refreshChrome();
      if (!this.lib.tracks.size) render();
    }
  },

  cancelScan() {
    this.scan.controller?.abort();
  },
};

const ui = { playerBar: null, queuePanel: null };

// ------------------------------------------------------------------ routing

let navigationWasTraversal = false;
const scrollPositions = new Map();
let renderedHash = null;

// The Navigation API tells us whether the user went back/forward, in which
// case the page should reappear scrolled to where they left it.
window.navigation?.addEventListener('navigate', (event) => {
  navigationWasTraversal = event.navigationType === 'traverse';
});

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const slash = hash.indexOf('/');
  const name = slash < 0 ? hash : hash.slice(0, slash);
  let param = slash < 0 ? '' : hash.slice(slash + 1);
  try {
    param = decodeURIComponent(param);
  } catch {
    // leave a malformed parameter as it is; the view will report "not found"
  }
  return { name, param };
}

function render({ keepScroll = false } = {}) {
  const { scroller } = app;
  const previousScroll = scroller.scrollTop;
  if (renderedHash !== null && renderedHash !== location.hash) scrollPositions.set(renderedHash, previousScroll);

  for (const dispose of app._disposers.splice(0)) dispose();

  let route = parseRoute();
  let view;
  if (!app.source.root && !app.lib.tracks.size) {
    view = welcomeView(app);
    route = { name: 'welcome', param: '' };
  } else {
    if (!ROUTES[route.name]) {
      route = { name: LENSES.includes(app.prefs.lens) ? app.prefs.lens : 'albums', param: '' };
      history.replaceState(null, '', `#/${route.name}`);
    }
    view = ROUTES[route.name](app, route.param);
    if (LENSES.includes(route.name)) app.setPref('lens', route.name);
  }

  scroller.replaceChildren(view);
  if (keepScroll && renderedHash === location.hash) scroller.scrollTop = previousScroll;
  else if (navigationWasTraversal) scroller.scrollTop = scrollPositions.get(location.hash) ?? 0;
  else scroller.scrollTop = 0;
  navigationWasTraversal = false;
  renderedHash = location.hash;

  document.body.classList.remove('nav-open');
  for (const link of document.querySelectorAll('.nav-link')) {
    const target = link.dataset.route;
    const active = target === route.name || target === `${route.name}s` || (target === 'playlist:' + route.param && route.name === 'playlist');
    link.classList.toggle('active', active);
  }
  const search = $('search-input');
  if (search && route.name === 'search' && document.activeElement !== search) search.value = route.param;
  // Leaving search clears the box - but not text that is still waiting to be
  // searched for: a render that lands mid-typing (a scan adding albums, a
  // navigation that has not rendered yet) must not throw the typing away.
  if (search && route.name !== 'search' && !search.dataset.pending) search.value = '';
}

/** Marks the rows of the playing track in whatever view is showing. */
function markPlaying() {
  const path = app.player.track?.path;
  for (const row of app.scroller.querySelectorAll('.track')) row.classList.toggle('playing', row.dataset.path === path && path !== undefined);
}

/** Shows a library that replaced the previous one, whatever the reason: a scan, a song length learned. */
function showLibrary({ reason }) {
  // At startup, start() renders once everything has loaded.
  if (reason === 'loaded') return;
  render({ keepScroll: true });
  refreshChrome();
  ui.playerBar?.refresh();
  ui.queuePanel?.render();
  if (reason === 'scanned') app.player.pruneQueue();
}

/** Tells the user what a library sync did (see syncLibrary's outcome). */
function reportSync(outcome, { quiet }) {
  const { status, added, updated, removed, protectedFiles, skipped } = outcome;
  if (outcome.suspicious) {
    toast('Most of your library was not found on the drive, so nothing was removed. If the music really is gone, use “Scan for new music” to update the library.', { kind: 'error', duration: 12000 });
  }
  if (status === 'interrupted' && outcome.during === 'scan') {
    toast('The music drive was disconnected during the scan. Your library is unchanged; scan again when the drive is back.', { kind: 'error', duration: 8000 });
  } else if (status === 'interrupted') {
    toast('The music drive went away while loading album art.', { kind: 'error' });
  } else if (status === 'stopped') {
    toast('Scan stopped.');
  } else if (status === 'failed') {
    console.error(outcome.error);
    toast('The scan ran into a problem and stopped. Your library is unchanged.', { kind: 'error' });
  }
  if (status !== 'done') return;

  const changes = [
    added ? `${plural(added, 'song')} added` : null,
    updated ? `${updated.toLocaleString()} updated` : null,
    removed ? `${removed.toLocaleString()} removed` : null,
  ].filter(Boolean);
  if (changes.length) toast(`Library updated: ${changes.join(', ')}.`);
  else if (!quiet) toast('Library is up to date.');
  // Say once why some of the collection is absent, not on every scan.
  if (protectedFiles && app.prefs.protectedNoted !== protectedFiles) {
    app.setPref('protectedNoted', protectedFiles);
    toast(`${plural(protectedFiles, 'copy-protected iTunes file')} (FairPlay DRM) can only be played by Apple’s apps and ${protectedFiles === 1 ? 'was' : 'were'} left out.`, { duration: 12000 });
  }
  if (skipped && !quiet) toast(`${plural(skipped, 'file or folder', 'files or folders')} could not be read and were skipped.`, { kind: 'error' });
}

// ------------------------------------------------------- sidebar and banner

function buildSidebar() {
  const sidebar = $('sidebar');
  let searchTimer = 0;
  const search = h('input', {
    id: 'search-input',
    class: 'search-input',
    type: 'search',
    placeholder: 'Search',
    'aria-label': 'Search your music',
    autocomplete: 'off',
    spellcheck: false,
    onInput: () => {
      clearTimeout(searchTimer);
      search.dataset.pending = 'true';
      searchTimer = setTimeout(() => {
        delete search.dataset.pending;
        const query = search.value.trim();
        const target = query ? `#/search/${encodeURIComponent(query)}` : `#/${LENSES.includes(app.prefs.lens) ? app.prefs.lens : 'albums'}`;
        // Typing refines one history entry rather than adding one per keystroke.
        if (location.hash.startsWith('#/search/') && query) {
          history.replaceState(null, '', target);
          render();
        } else {
          app.navigate(target);
        }
      }, 180);
    },
  });
  const navLink = (route, label, iconName) => h('a', { class: 'nav-link', href: `#/${route}`, dataset: { route } }, icon(iconName, 20), h('span', null, label));

  sidebar.append(
    h(
      'div',
      { class: 'brand' },
      h('img', { src: 'icons/icon.svg', alt: '', width: 28, height: 28 }),
      h('span', null, 'Platter'),
      h('span', { class: 'version', id: 'app-version', title: `Platter version ${VERSION}` }, VERSION),
    ),
    h('label', { class: 'search' }, icon('search', 18), search),
    h(
      'nav',
      { class: 'nav', 'aria-label': 'Library' },
      navLink('artists', 'Artists', 'person'),
      navLink('albums', 'Albums', 'album'),
      navLink('genres', 'Genres', 'genre'),
      navLink('songs', 'Songs', 'note'),
      navLink('query', 'Query', 'code'),
    ),
    h(
      'div',
      { class: 'side-heading' },
      h('a', { class: 'nav-link grow', href: '#/playlists', dataset: { route: 'playlists' } }, icon('playlist', 20), h('span', null, 'Playlists')),
      iconButton('add', 'New playlist', () => app.createPlaylist(), { size: 18 }),
    ),
    h('nav', { class: 'side-playlists', id: 'side-playlists', 'aria-label': 'Playlists' }),
    h('div', { class: 'side-footer', id: 'side-footer' }),
  );
  refreshPlaylistLinks();
}

function refreshPlaylistLinks() {
  const host = $('side-playlists');
  if (!host) return;
  host.replaceChildren(
    ...app.playlists.list.map((p) =>
      h('a', { class: 'nav-link sub', href: `#/playlist/${encodeURIComponent(p.id)}`, dataset: { route: `playlist:${p.id}` }, title: p.name }, h('span', { class: 'ellipsis' }, p.name)),
    ),
  );
}

function scanText(progress) {
  if (!progress) return 'Scanning…';
  if (progress.phase === 'walk') return `Looking for music… ${progress.found.toLocaleString()} found`;
  if (progress.phase === 'read') return `Reading tags… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
  return `Loading album art… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`;
}

/** Cheap in-place update while a scan runs (called many times a second). */
function refreshScanStatus() {
  const text = $('scan-text');
  const bar = $('scan-bar');
  const { progress } = app.scan;
  if (!text || !bar || !progress) return;
  text.textContent = scanText(progress);
  const fraction = progress.total ? progress.done / progress.total : null;
  bar.classList.toggle('indeterminate', fraction === null);
  bar.style.setProperty('--progress', `${(fraction ?? 0) * 100}%`);
}

/** Everything outside the view that reflects drive and scan state. */
function refreshChrome() {
  const footer = $('side-footer');
  const { state } = app.source;
  if (footer) {
    if (app.scan.active) {
      footer.replaceChildren(
        h(
          'div',
          { class: 'scan-status' },
          h('div', { class: 'scan-line' }, h('span', { id: 'scan-text', class: 'grow small' }, scanText(app.scan.progress)), iconButton('close', 'Stop scanning', () => app.cancelScan(), { size: 16 })),
          h('div', { id: 'scan-bar', class: 'progress indeterminate' }),
        ),
      );
      refreshScanStatus();
    } else if (state === 'none') {
      footer.replaceChildren();
    } else {
      const label = { connected: 'Drive connected', disconnected: 'Drive not connected', 'needs-permission': 'Access needed' }[state];
      const count = app.lib.songCount;
      footer.replaceChildren(
        h(
          'div',
          { class: 'drive-status', dataset: { state } },
          h('span', { class: 'dot' }),
          h('div', { class: 'grow drive-text' }, h('div', { class: 'small' }, label), h('div', { class: 'muted small ellipsis', title: app.source.folderName }, `${app.source.folderName} · ${plural(count, 'song')}`)),
          iconButton(
            'more',
            'Library options',
            (event) =>
              openMenu(event.currentTarget, [
                { label: 'Scan for new music', icon: 'refresh', disabled: state === 'disconnected', onClick: () => app.rescan() },
                { label: 'Choose another folder…', icon: 'folder', onClick: () => app.chooseFolder() },
              ]),
            { size: 18 },
          ),
        ),
      );
    }
  }

  const banner = $('banner');
  if (state === 'needs-permission') {
    banner.replaceChildren(
      h(
        'div',
        { class: 'banner', role: 'status' },
        icon('folder', 20),
        h('span', { class: 'grow' }, `Chrome needs your OK to read “${app.source.folderName}” again. Your library is still here to browse.`),
        h('button', { class: 'btn btn-primary btn-small', type: 'button', onClick: () => app.reconnect() }, 'Allow access'),
      ),
    );
  } else if (state === 'disconnected') {
    banner.replaceChildren(
      h(
        'div',
        { class: 'banner banner-warn', role: 'status' },
        icon('warning', 20),
        h('span', { class: 'grow' }, 'The music drive isn’t connected. You can browse your library; plug the drive in to play.'),
        h('button', { class: 'btn btn-small', type: 'button', onClick: () => app.reconnect() }, 'Check again'),
      ),
    );
  } else {
    banner.replaceChildren();
  }
}

/** A newer Platter has been published while this window was open. */
function showUpdateBanner(version) {
  const host = $('update-banner');
  host.replaceChildren(
    h(
      'div',
      { class: 'banner', role: 'status' },
      icon('refresh', 20),
      h('span', { class: 'grow' }, `Platter ${version} is available. Reload to start using it; your queue and place in the song are kept.`),
      h('button', { class: 'btn btn-primary btn-small', type: 'button', onClick: () => location.reload() }, 'Reload'),
      iconButton('close', 'Not now', () => host.replaceChildren(), { size: 18 }),
    ),
  );
}

// ------------------------------------------------------------------- events

function wireSource() {
  app.source.addEventListener('change', (event) => {
    const { state, previous } = event.detail;
    refreshChrome();
    if (state === 'connected') {
      if (previous === 'disconnected') toast('Music drive connected.');
      // Pick up anything added to the drive while it was away.
      if (started) app.rescan({ quiet: true });
    } else if (state === 'disconnected' && previous === 'connected') {
      toast('Music drive disconnected.', { kind: 'error' });
    }
    if (!app.lib.tracks.size) render();
  });
}

function wirePlayer() {
  const { player } = app;
  player.addEventListener('trackchange', () => {
    markPlaying();
    savePosition();
  });
  player.addEventListener('statechange', savePosition);
  player.addEventListener('queuechange', () => {
    saveQueueSoon();
    savePosition();
  });
  let lastSave = 0;
  player.addEventListener('timeupdate', () => {
    if (Date.now() - lastSave > 4000) {
      lastSave = Date.now();
      savePosition();
    }
  });
  player.addEventListener('durationknown', (event) => {
    // Formats whose length can't be read from tags: remember it once played.
    const { track, duration } = event.detail;
    app.library.learnDuration(track.path, duration);
  });
  player.addEventListener('error', (event) => {
    const { kind, state, reason, track } = event.detail;
    if (kind === 'drive') {
      refreshChrome();
      if (state === 'needs-permission') {
        toast('Chrome needs your OK to read the music folder.', { kind: 'error', action: { label: 'Allow', onClick: () => app.reconnect() } });
      } else if (state === 'none') {
        toast('Choose your music folder first.', { kind: 'error' });
      } else {
        toast('The music drive isn’t connected. Plug it in, then press play.', { kind: 'error' });
      }
    } else if (kind === 'track') {
      const name = track ? `“${track.title}”` : 'A song';
      toast(reason === 'missing-file' ? `${name} is no longer on the drive. Scan to update your library.` : `${name} could not be played.`, { kind: 'error' });
    } else if (kind === 'blocked') {
      toast('Press play to start the music.');
    }
  });
  window.addEventListener('pagehide', savePosition);
}

let queueTimer = 0;
function saveQueueSoon() {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    db.put('kv', app.player.queue.toJSON(), 'queue').catch(() => {});
  }, 400);
}

function savePosition() {
  try {
    const { queue } = app.player;
    localStorage.setItem(POSITION_KEY, JSON.stringify({ index: queue.index, id: queue.current()?.id ?? null, position: app.player.currentTime }));
  } catch {
    // not critical
  }
}

/** Saved queries and setup SQL for the Query page. Missing or unreadable: start without them. */
async function loadSqlSettings() {
  try {
    const [saved, setup] = await Promise.all([db.get('kv', 'savedQueries'), db.get('kv', 'sqlSetup')]);
    app.sql.saved = Array.isArray(saved) ? saved.filter((q) => q && typeof q.name === 'string' && typeof q.sql === 'string') : [];
    app.sql.setup = typeof setup === 'string' ? setup : '';
  } catch {
    // the Query page works without them
  }
}

async function restoreSession() {
  let queue = null;
  try {
    queue = await db.get('kv', 'queue');
  } catch {
    return;
  }
  if (!queue?.items?.length) return;
  let position = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY));
    // Only trust the saved position if it still points at the same track.
    if (saved && queue.items[saved.index] === saved.id) {
      queue.index = saved.index;
      position = saved.position;
    }
  } catch {
    // start the saved queue from its last known track
  }
  app.player.restore({ queue, position });
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (document.querySelector('dialog[open]')) return;
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('search-input')?.focus();
      return;
    }
    if (event.key === 'Escape' && target === $('search-input')) {
      target.blur();
      return;
    }
    if (typing || event.altKey || event.metaKey) return;
    const inMenu = target instanceof HTMLElement && target.closest('.menu') !== null;
    const { player } = app;
    // Space is play/pause everywhere, as in any music player - even when a
    // button happens to have focus after a click (Enter still presses it).
    if ((event.key === ' ' && !inMenu) || event.key === 'k') {
      event.preventDefault();
      if (!event.repeat) app.togglePlay();
    } else if (event.key === 'ArrowRight' && event.ctrlKey) {
      event.preventDefault();
      player.next();
    } else if (event.key === 'ArrowLeft' && event.ctrlKey) {
      event.preventDefault();
      player.prev();
    } else if (event.key === 'ArrowRight' && !event.shiftKey) {
      event.preventDefault();
      player.seek(player.currentTime + 10);
    } else if (event.key === 'ArrowLeft' && !event.shiftKey) {
      event.preventDefault();
      player.seek(player.currentTime - 10);
    } else if (event.key === 'm') {
      player.muted = !player.muted;
    }
  });
  // A focused button is pressed on Space *keyup*; stop that, since keydown already toggled playback.
  document.addEventListener('keyup', (event) => {
    const target = event.target;
    if (event.key !== ' ' || !(target instanceof HTMLElement)) return;
    if (target.matches('input, textarea, select') || target.closest('.menu, dialog')) return;
    event.preventDefault();
  });
}

// -------------------------------------------------------------------- start

let started = false;

async function start() {
  app.player = new Player({ source: app.source, getTrack: (id) => app.lib.tracks.get(id) });
  if (typeof app.prefs.volume === 'number') app.player.volume = app.prefs.volume;

  buildSidebar();
  $('menu-button').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  ui.playerBar = mountPlayerBar(app, $('playerbar'));
  ui.queuePanel = mountQueuePanel(app, $('queue'));
  wireSource();
  wirePlayer();
  wireKeyboard();

  app.library.addEventListener('change', (event) => showLibrary(event.detail));
  app.playlists.addEventListener('change', () => {
    app.sql.changes++;
    refreshPlaylistLinks();
    const { name } = parseRoute();
    if (name === 'playlist' || name === 'playlists') render({ keepScroll: true });
  });
  app.covers.addEventListener('change', () => {
    app.sql.changes++;
    refreshCovers(app);
  });
  window.addEventListener('hashchange', () => render());

  // The saved library shows immediately, whether or not the drive is there.
  try {
    await Promise.all([app.library.load(), app.covers.init(), app.playlists.init(), loadSqlSettings()]);
  } catch (err) {
    console.error(err);
    toast('Your saved library could not be opened. Scanning the drive will rebuild it.', { kind: 'error', duration: 8000 });
  }
  refreshPlaylistLinks();
  await restoreSession();

  await app.source.init();
  refreshChrome();
  render();
  if (app.prefs.queueOpen) app.toggleQueue(true);
  document.body.classList.remove('booting');

  started = true;
  app.source.watch();
  navigator.storage?.persist?.().catch(() => {});
  if (app.source.state === 'connected') app.rescan({ quiet: true });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support unavailable:', err));
  app.checkForUpdate = watchForUpdates(showUpdateBanner);
}

// Exposed for debugging from the DevTools console (and for the browser tests).
window.platter = app;

start().catch((err) => {
  console.error(err);
  document.body.classList.remove('booting');
  $('view').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, icon('warning', 48), h('h2', null, 'Platter could not start'), h('p', { class: 'muted' }, String(err?.message ?? err)))));
});
