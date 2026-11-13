// Application entry point: wires the library, the drive connection, the
// player and the views together.

import { db } from './db.js';
import { MusicSource } from './source.js';
import { Player } from './player.js';
import { Playlists } from './playlists.js';
import { CoverStore } from './covers.js';
import { scanLibrary, ScanInterrupted } from './scanner.js';
import { readTrack } from './tags.js';
import { buildLibrary, emptyLibrary, keyOf, toRecord } from './library.js';
import { h, icon, iconButton, toast, openMenu, plural, promptDialog, playlistDialog } from './ui/dom.js';
import {
  albumsView, albumView, artistsView, artistView, genresView, genreView, songsView,
  playlistsView, playlistView, searchView, welcomeView, refreshCovers,
} from './ui/views.js';
import { mountPlayerBar, mountQueuePanel } from './ui/playerbar.js';

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
  lib: emptyLibrary(),
  source: new MusicSource(),
  covers: new CoverStore(),
  playlists: new Playlists(),
  /** @type {Player} */
  player: null,
  prefs: loadPrefs(),
  scan: { active: false, progress: null, controller: null },
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
   * Brings the library up to date with the drive.
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
    const wasEmpty = this.lib.tracks.size === 0;
    if (wasEmpty) render();

    // On a first scan, show albums as they are discovered instead of a long blank wait.
    const fresh = [];
    let lastPreview = Date.now();
    const onProgress = (progress) => {
      this.scan.progress = progress;
      refreshScanStatus();
    };

    try {
      const result = await scanLibrary({
        root: this.source.root,
        existing: this.lib.tracks,
        readTrack,
        signal: controller.signal,
        isAlive: async () => (await this.source.check()) === 'connected',
        onProgress,
        onBatch: async (records) => {
          await db.putMany('tracks', records.map(toRecord));
          if (!wasEmpty) return;
          fresh.push(...records);
          if (Date.now() - lastPreview > 2500) {
            lastPreview = Date.now();
            setLibrary(buildLibrary(fresh));
          }
        },
      });
      // An automatic scan must not quietly gut the library. If most of it seems
      // to have vanished, the likelier story is the wrong drive or a half-ready
      // one, not a spring clean - so keep everything and let the user decide.
      const suspicious = quiet && result.removed.length >= 10 && result.removed.length * 2 > this.lib.tracks.size;
      if (suspicious) {
        for (const path of result.removed) result.tracks.push(this.lib.tracks.get(path));
        result.removed = [];
        result.complete = false; // also keeps the covers of the albums in question
        toast('Most of your library was not found on the drive, so nothing was removed. If the music really is gone, use “Scan for new music” to update the library.', { kind: 'error', duration: 12000 });
      }
      if (result.removed.length) await db.deleteMany('tracks', result.removed);
      // An unchanged library is left alone: no reason to redraw what the user is looking at.
      if (result.added || result.updated || result.removed.length || wasEmpty) {
        setLibrary(buildLibrary(result.tracks));
        this.player.pruneQueue();
      }

      await this.covers.build({
        lib: this.lib,
        images: result.images,
        getFile: (path) => this.source.getFile(path),
        prune: result.complete,
        signal: controller.signal,
        onProgress,
      });

      await db.put('kv', { at: Date.now(), tracks: result.tracks.length }, 'lastScan');
      const changes = [
        result.added ? `${plural(result.added, 'song')} added` : null,
        result.updated ? `${result.updated.toLocaleString()} updated` : null,
        result.removed.length ? `${result.removed.length.toLocaleString()} removed` : null,
      ].filter(Boolean);
      if (changes.length) toast(`Library updated: ${changes.join(', ')}.`);
      else if (!quiet) toast('Library is up to date.');
      // Say once why some of the collection is absent, not on every scan.
      if (result.protectedFiles && this.prefs.protectedNoted !== result.protectedFiles) {
        this.setPref('protectedNoted', result.protectedFiles);
        toast(`${plural(result.protectedFiles, 'copy-protected iTunes file')} (FairPlay DRM) can only be played by Apple’s apps and ${result.protectedFiles === 1 ? 'was' : 'were'} left out.`, { duration: 12000 });
      }
      if (result.skipped && !quiet) toast(`${plural(result.skipped, 'file or folder', 'files or folders')} could not be read and were skipped.`, { kind: 'error' });
    } catch (err) {
      // Whatever was read before the interruption is already saved; show it.
      try {
        setLibrary(buildLibrary(await db.getAll('tracks')));
      } catch {
        // keep the library we have
      }
      if (err instanceof ScanInterrupted) toast('The music drive was disconnected during the scan. Your library is unchanged; scan again when the drive is back.', { kind: 'error', duration: 8000 });
      else if (err?.name === 'AbortError') toast('Scan stopped.');
      else if (err?.name === 'SourceError') toast('The music drive went away while loading album art.', { kind: 'error' });
      else {
        console.error(err);
        toast('The scan ran into a problem and stopped. Your library is unchanged.', { kind: 'error' });
      }
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
  if (search && route.name !== 'search') search.value = '';
}

/** Marks the rows of the playing track in whatever view is showing. */
function markPlaying() {
  const path = app.player.track?.path;
  for (const row of app.scroller.querySelectorAll('.track')) row.classList.toggle('playing', row.dataset.path === path && path !== undefined);
}

function setLibrary(lib) {
  app.lib = lib;
  render({ keepScroll: true });
  refreshChrome();
  ui.playerBar?.refresh();
  ui.queuePanel?.render();
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
      searchTimer = setTimeout(() => {
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
    h('div', { class: 'brand' }, h('img', { src: 'icons/icon.svg', alt: '', width: 28, height: 28 }), h('span', null, 'Platter')),
    h('label', { class: 'search' }, icon('search', 18), search),
    h(
      'nav',
      { class: 'nav', 'aria-label': 'Library' },
      navLink('artists', 'Artists', 'person'),
      navLink('albums', 'Albums', 'album'),
      navLink('genres', 'Genres', 'genre'),
      navLink('songs', 'Songs', 'note'),
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
    track.duration = duration;
    db.put('tracks', toRecord(track)).catch(() => {});
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

  app.playlists.addEventListener('change', () => {
    refreshPlaylistLinks();
    const { name } = parseRoute();
    if (name === 'playlist' || name === 'playlists') render({ keepScroll: true });
  });
  app.covers.addEventListener('change', () => refreshCovers(app));
  window.addEventListener('hashchange', () => render());

  // The saved library shows immediately, whether or not the drive is there.
  let tracks = [];
  try {
    [tracks] = await Promise.all([db.getAll('tracks'), app.covers.init(), app.playlists.init()]);
  } catch (err) {
    console.error(err);
    toast('Your saved library could not be opened. Scanning the drive will rebuild it.', { kind: 'error', duration: 8000 });
  }
  app.lib = buildLibrary(tracks);
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
}

// Exposed for debugging from the DevTools console (and for the browser tests).
window.platter = app;

start().catch((err) => {
  console.error(err);
  document.body.classList.remove('booting');
  $('view').replaceChildren(h('div', { class: 'page' }, h('div', { class: 'empty' }, icon('warning', 48), h('h2', null, 'Platter could not start'), h('p', { class: 'muted' }, String(err?.message ?? err)))));
});
