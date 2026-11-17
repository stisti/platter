// The main-area views: the different lenses onto the library (artists, albums,
// genres, songs), playlists, search results, and the first-run screen.
//
// Every view is a function `(app, param) => HTMLElement`. Views are rebuilt
// from scratch whenever the route or the library changes; nothing here keeps
// state between renders except through `app`.

import { searchLibrary, compareText, keyOf } from '../library.js';
import {
  h, icon, iconButton, formatTime, formatLength, plural, hueOf, openMenu, promptDialog, confirmDialog,
} from './dom.js';

// -------------------------------------------------------------- cover art

let coverObserver = null;

function observeCover(app, el) {
  coverObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        coverObserver.unobserve(entry.target);
        const target = entry.target;
        app.covers.url(target.dataset.cover).then((url) => url && showCover(target, url));
      }
    },
    { rootMargin: '400px' },
  );
  coverObserver.observe(el);
}

function showCover(el, url) {
  if (el.querySelector('img')) return;
  el.append(h('img', { src: url, alt: '', decoding: 'async', draggable: false }));
}

/**
 * A square (or round) piece of cover art. Shows a tinted placeholder until
 * the thumbnail has loaded, or forever when the album has no art.
 */
export function coverArt(app, albumKey, { seed = '', round = false, placeholder = 'album' } = {}) {
  const el = h('div', { class: `cover${round ? ' round' : ''}` }, icon(placeholder, 40));
  el.style.setProperty('--hue', hueOf(albumKey || seed));
  if (albumKey) {
    el.dataset.cover = albumKey;
    attachCover(app, el);
  }
  return el;
}

function attachCover(app, el) {
  const key = el.dataset.cover;
  if (!app.covers.has(key)) return;
  const cached = app.covers.cachedUrl(key);
  if (cached) showCover(el, cached);
  else observeCover(app, el);
}

/**
 * Fills in covers that became available after the page was drawn (album art
 * is loaded at the end of a scan), without rebuilding the page under the user.
 */
export function refreshCovers(app, root = document) {
  for (const el of root.querySelectorAll('.cover[data-cover]')) {
    if (!el.querySelector('img')) attachCover(app, el);
  }
}

// ------------------------------------------------------------ small parts

const albumHref = (album) => `#/album/${encodeURIComponent(album.key)}`;
const artistHref = (name) => `#/artist/${encodeURIComponent(keyOf(name))}`;
const genreHref = (genre) => `#/genre/${encodeURIComponent(genre.key)}`;

export function pageHeader(title, subtitle, ...actions) {
  return h(
    'header',
    { class: 'page-header' },
    h('div', { class: 'grow' }, h('h1', null, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null,
  );
}

export function playButtons(app, getTracks) {
  return [
    h('button', { class: 'btn btn-primary', type: 'button', onClick: () => app.play(getTracks(), null, { shuffle: false }) }, icon('play', 18), 'Play'),
    h('button', { class: 'btn', type: 'button', onClick: () => app.play(getTracks(), null, { shuffle: true }) }, icon('shuffle', 18), 'Shuffle'),
  ];
}

export function emptyState(iconName, title, text, ...actions) {
  return h(
    'div',
    { class: 'empty' },
    icon(iconName, 48),
    h('h2', null, title),
    text ? h('p', { class: 'muted' }, text) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null,
  );
}

/** A card in a grid: art with a hover play button, a title and a line of detail. */
function card(app, { href, art, title, detail, getTracks, menuLabel }) {
  const menu = (anchor) => app.collectionMenu(anchor, getTracks, menuLabel);
  return h(
    'a',
    {
      class: 'card',
      href,
      onContextmenu: (event) => {
        event.preventDefault();
        menu(event);
      },
    },
    h(
      'div',
      { class: 'card-art' },
      art,
      iconButton('play', `Play ${title}`, () => app.play(getTracks(), null, { shuffle: false }), { size: 22, cls: 'card-play' }),
    ),
    h('div', { class: 'card-title ellipsis', title }, title),
    h('div', { class: 'card-detail ellipsis muted' }, detail),
  );
}

function albumCard(app, album, { showArtist = true } = {}) {
  const detail = showArtist
    ? album.artist
    : [album.year, plural(album.tracks.length, 'track')].filter(Boolean).join(' · ');
  return card(app, {
    href: albumHref(album),
    art: coverArt(app, album.key),
    title: album.title,
    detail,
    getTracks: () => album.tracks,
    menuLabel: album.title,
  });
}

export function albumGrid(app, albums, options) {
  return h('div', { class: 'grid' }, albums.map((album) => albumCard(app, album, options)));
}

/**
 * One row in a list of tracks. Clicking plays the track within its list, so
 * playback carries on with whatever follows it.
 */
export function trackRow(app, track, { list, index, number = null, showArtist = true, showAlbum = false, menuItems = null, leading = null }) {
  const playing = app.player.track?.path === track.path;
  const play = () => app.play(list, index);
  const menu = (anchor) => app.trackMenu(anchor, track, menuItems);
  return h(
    'div',
    {
      class: `track${playing ? ' playing' : ''}${showAlbum ? ' with-album' : ''}`,
      role: 'button',
      tabIndex: 0,
      dataset: { path: track.path },
      onClick: play,
      onKeydown: (event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) play();
      },
      onContextmenu: (event) => {
        event.preventDefault();
        menu(event);
      },
    },
    leading,
    h('div', { class: 'track-num' }, h('span', { class: 'num' }, number == null ? '' : String(number)), icon('play', 16), h('span', { class: 'eq', 'aria-label': 'Playing' })),
    h(
      'div',
      { class: 'track-main' },
      h('div', { class: 'track-title ellipsis' }, track.title),
      showArtist ? h('div', { class: 'track-sub ellipsis muted' }, track.artist) : null,
    ),
    showAlbum ? h('div', { class: 'track-album ellipsis muted' }, track.album) : null,
    h('div', { class: 'track-time muted' }, formatTime(track.duration)),
    iconButton('more', 'More options', (event) => menu(event.currentTarget), { size: 18, cls: 'track-more' }),
  );
}

/**
 * Renders only the rows that are on screen, so a list of tens of thousands of
 * songs scrolls as smoothly as a list of ten.
 */
export function virtualList(app, { count, rowHeight, renderRow }) {
  const scroller = app.scroller;
  const el = h('div', { class: 'vlist' });
  el.style.height = `${count * rowHeight}px`;
  let first = -1;
  let last = -1;
  let frame = 0;

  const update = () => {
    frame = 0;
    if (!el.isConnected) return;
    const top = scroller.scrollTop - el.offsetTop;
    const start = Math.max(0, Math.floor(top / rowHeight) - 10);
    const end = Math.min(count, Math.ceil((top + scroller.clientHeight) / rowHeight) + 10);
    if (start === first && end === last) return;
    first = start;
    last = end;
    const rows = [];
    for (let i = start; i < end; i++) {
      const row = renderRow(i);
      row.style.transform = `translateY(${i * rowHeight}px)`;
      rows.push(row);
    }
    el.replaceChildren(...rows);
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(update);
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(scroller);
  app.onViewDispose(() => {
    scroller.removeEventListener('scroll', schedule);
    resize.disconnect();
    cancelAnimationFrame(frame);
  });
  schedule();
  return el;
}

// ------------------------------------------------------------------ views

const ALBUM_SORTS = {
  artist: { label: 'Artist', sort: null },
  title: { label: 'Title', sort: (a, b) => compareText(a.title, b.title) },
  newest: { label: 'Year, newest first', sort: (a, b) => (b.year ?? 0) - (a.year ?? 0) || compareText(a.title, b.title) },
  added: { label: 'Recently added', sort: (a, b) => b.added - a.added },
};

export function albumsView(app) {
  const { lib } = app;
  if (!lib.sortedAlbums.length) return libraryEmpty(app);
  const sortKey = ALBUM_SORTS[app.prefs.albumSort] ? app.prefs.albumSort : 'artist';
  const { sort } = ALBUM_SORTS[sortKey];
  const albums = sort ? lib.sortedAlbums.slice().sort(sort) : lib.sortedAlbums;
  const select = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Sort albums by',
      onChange: () => {
        app.setPref('albumSort', select.value);
        app.rerender({ keepScroll: false });
      },
    },
    Object.entries(ALBUM_SORTS).map(([key, { label }]) => h('option', { value: key, selected: key === sortKey }, label)),
  );
  return h(
    'div',
    { class: 'page' },
    pageHeader('Albums', plural(albums.length, 'album'), h('label', { class: 'sort-label muted' }, 'Sort by', select)),
    albumGrid(app, albums),
  );
}

export function artistsView(app) {
  const artists = app.lib.sortedArtists;
  if (!artists.length) return libraryEmpty(app);
  return h(
    'div',
    { class: 'page' },
    pageHeader('Artists', plural(artists.length, 'artist')),
    h(
      'div',
      { class: 'grid' },
      artists.map((artist) =>
        card(app, {
          href: artistHref(artist.name),
          art: coverArt(app, artist.albums[0]?.key, { seed: artist.key, round: true, placeholder: 'person' }),
          title: artist.name,
          detail: plural(artist.albums.length, 'album'),
          getTracks: () => artist.tracks,
          menuLabel: artist.name,
        }),
      ),
    ),
  );
}

export function artistView(app, key) {
  const artist = app.lib.artists.get(key);
  if (!artist) return notFound(app, 'artist');
  const firstAlbum = artist.albums[0] ?? artist.appearsOn[0];
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'hero' },
      coverArt(app, firstAlbum?.key, { seed: artist.key, round: true, placeholder: 'person' }),
      h(
        'div',
        { class: 'hero-text' },
        h('div', { class: 'eyebrow muted' }, 'Artist'),
        h('h1', null, artist.name),
        h(
          'p',
          { class: 'muted' },
          [artist.albums.length ? plural(artist.albums.length, 'album') : null, plural(artist.tracks.length, 'song')].filter(Boolean).join(' · '),
        ),
        h(
          'div',
          { class: 'hero-actions' },
          playButtons(app, () => artist.tracks),
          iconButton('more', 'More options', (event) => app.collectionMenu(event.currentTarget, () => artist.tracks, artist.name)),
        ),
      ),
    ),
    artist.albums.length ? [h('h2', { class: 'section-title' }, 'Albums'), albumGrid(app, artist.albums, { showArtist: false })] : null,
    artist.appearsOn.length ? [h('h2', { class: 'section-title' }, 'Appears on'), albumGrid(app, artist.appearsOn)] : null,
    artist.albums.length
      ? null
      : [
          h('h2', { class: 'section-title' }, 'Songs'),
          h('div', { class: 'tracks' }, artist.tracks.map((t, i) => trackRow(app, t, { list: artist.tracks, index: i, number: i + 1, showAlbum: true, showArtist: false }))),
        ],
  );
}

export function albumView(app, key) {
  const album = app.lib.albums.get(key);
  if (!album) return notFound(app, 'album');
  const rows = [];
  let disc = null;
  album.tracks.forEach((t, i) => {
    const d = t._disc;
    if (album.discCount > 1 && d !== disc) {
      disc = d;
      rows.push(h('div', { class: 'disc-title muted' }, icon('album', 16), `Disc ${d}`));
    }
    rows.push(
      trackRow(app, t, {
        list: album.tracks,
        index: i,
        number: t.trackNo ?? i + 1,
        // Only name the artist per track when it adds something (compilations, guests).
        showArtist: keyOf(t.artist) !== album.artistKey,
      }),
    );
  });
  // A reissue shows both years: "1985 · 1986 edition".
  const edition = album.originalYear && album.editionYear && album.editionYear !== album.originalYear ? `${album.editionYear} edition` : null;
  const facts = [album.year, edition, plural(album.tracks.length, 'track'), album.duration ? formatLength(album.duration) : null].filter(Boolean);
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'hero' },
      coverArt(app, album.key),
      h(
        'div',
        { class: 'hero-text' },
        h('div', { class: 'eyebrow muted' }, 'Album'),
        h('h1', null, album.title),
        h('p', null, h('a', { class: 'link', href: artistHref(album.artist) }, album.artist)),
        h('p', { class: 'muted' }, facts.join(' · ')),
        album.genres.length
          ? h('p', { class: 'chips' }, album.genres.map((g) => h('a', { class: 'chip', href: `#/genre/${encodeURIComponent(keyOf(g))}` }, g)))
          : null,
        h(
          'div',
          { class: 'hero-actions' },
          playButtons(app, () => album.tracks),
          iconButton('more', 'More options', (event) => app.collectionMenu(event.currentTarget, () => album.tracks, album.title)),
        ),
      ),
    ),
    h('div', { class: 'tracks' }, rows),
  );
}

export function genresView(app) {
  const genres = app.lib.sortedGenres;
  if (!app.lib.tracks.size) return libraryEmpty(app);
  if (!genres.length) {
    return h('div', { class: 'page' }, pageHeader('Genres'), emptyState('genre', 'No genres found', 'None of your music files have a genre tag.'));
  }
  return h(
    'div',
    { class: 'page' },
    pageHeader('Genres', plural(genres.length, 'genre')),
    h(
      'div',
      { class: 'genre-grid' },
      genres.map((genre) => {
        const tile = h(
          'a',
          {
            class: 'genre-tile',
            href: genreHref(genre),
            onContextmenu: (event) => {
              event.preventDefault();
              app.collectionMenu(event, () => genre.tracks, genre.name);
            },
          },
          h('div', { class: 'grow' }, h('div', { class: 'genre-name ellipsis' }, genre.name), h('div', { class: 'genre-count' }, `${plural(genre.albums.length, 'album')} · ${plural(genre.tracks.length, 'song')}`)),
          iconButton('shuffle', `Shuffle ${genre.name}`, () => app.play(genre.tracks, null, { shuffle: true }), { cls: 'genre-play' }),
        );
        tile.style.setProperty('--hue', hueOf(genre.key));
        return tile;
      }),
    ),
  );
}

export function genreView(app, key) {
  const genre = app.lib.genres.get(key);
  if (!genre) return notFound(app, 'genre');
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'hero hero-plain' },
      h(
        'div',
        { class: 'hero-text' },
        h('div', { class: 'eyebrow muted' }, 'Genre'),
        h('h1', null, genre.name),
        h('p', { class: 'muted' }, `${plural(genre.albums.length, 'album')} · ${plural(genre.tracks.length, 'song')}`),
        h(
          'div',
          { class: 'hero-actions' },
          playButtons(app, () => genre.tracks),
          iconButton('more', 'More options', (event) => app.collectionMenu(event.currentTarget, () => genre.tracks, genre.name)),
        ),
      ),
    ),
    albumGrid(app, genre.albums),
  );
}

export function songsView(app) {
  const tracks = app.lib.sortedTracks;
  if (!tracks.length) return libraryEmpty(app);
  return h(
    'div',
    { class: 'page' },
    pageHeader('Songs', plural(tracks.length, 'song'), playButtons(app, () => tracks)),
    virtualList(app, {
      count: tracks.length,
      rowHeight: 52,
      renderRow: (i) => trackRow(app, tracks[i], { list: tracks, index: i, showAlbum: true }),
    }),
  );
}

export function playlistsView(app) {
  const { playlists } = app;
  const create = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => app.createPlaylist() }, icon('add', 18), 'New playlist');
  if (!playlists.list.length) {
    return h(
      'div',
      { class: 'page' },
      pageHeader('Playlists'),
      emptyState('playlist', 'No playlists yet', 'Make one here, or use “Add to playlist” on any song, album, artist or genre.', create),
    );
  }
  return h(
    'div',
    { class: 'page' },
    pageHeader('Playlists', plural(playlists.list.length, 'playlist'), create),
    h(
      'div',
      { class: 'grid' },
      playlists.list.map((p) => {
        const tracks = () => p.tracks.map((path) => app.lib.tracks.get(path)).filter(Boolean);
        const firstKey = tracks()[0]?._albumKey;
        return card(app, {
          href: `#/playlist/${encodeURIComponent(p.id)}`,
          art: coverArt(app, firstKey, { seed: p.id, placeholder: 'playlist' }),
          title: p.name,
          detail: plural(p.tracks.length, 'song'),
          getTracks: tracks,
          menuLabel: p.name,
        });
      }),
    ),
  );
}

export function playlistView(app, id) {
  const playlist = app.playlists.get(id);
  if (!playlist) return notFound(app, 'playlist');
  // Entries whose file is no longer in the library stay in the playlist (the
  // file may just be on a drive that hasn't been rescanned) but can't be played.
  const entries = playlist.tracks.map((path, position) => ({ path, position, track: app.lib.tracks.get(path) ?? null }));
  const playable = entries.filter((e) => e.track);
  const tracks = playable.map((e) => e.track);
  const duration = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const missing = entries.length - playable.length;

  let dragFrom = null;
  const rows = entries.map((entry) => {
    const { position } = entry;
    const moveItems = [
      { label: 'Move up', icon: 'up', disabled: position === 0, onClick: () => app.playlists.move(id, position, position - 1) },
      { label: 'Move down', icon: 'down', disabled: position === entries.length - 1, onClick: () => app.playlists.move(id, position, position + 1) },
      { label: 'Remove from this playlist', icon: 'trash', danger: true, onClick: () => app.playlists.removeAt(id, position) },
    ];
    const handle = h('span', { class: 'drag-handle', title: 'Drag to reorder' }, icon('drag', 18));
    let row;
    if (entry.track) {
      row = trackRow(app, entry.track, {
        list: tracks,
        index: playable.indexOf(entry),
        showAlbum: true,
        menuItems: moveItems,
        leading: handle,
      });
    } else {
      row = h(
        'div',
        { class: 'track with-album missing', onContextmenu: (event) => { event.preventDefault(); openMenu(event, moveItems); } },
        handle,
        h('div', { class: 'track-num' }, icon('warning', 16)),
        h('div', { class: 'track-main' }, h('div', { class: 'track-title ellipsis' }, entry.path.split('/').pop()), h('div', { class: 'track-sub ellipsis muted' }, 'Not found in the library')),
        h('div', { class: 'track-album' }),
        h('div', { class: 'track-time' }),
        iconButton('more', 'More options', (event) => openMenu(event.currentTarget, moveItems), { size: 18, cls: 'track-more' }),
      );
    }
    row.classList.add('reorderable');
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      dragFrom = position;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(position));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragFrom = null;
      row.classList.remove('dragging');
      for (const el of row.parentElement?.querySelectorAll('.drop-before, .drop-after') ?? []) el.classList.remove('drop-before', 'drop-after');
    });
    row.addEventListener('dragover', (event) => {
      if (dragFrom === null) return;
      event.preventDefault();
      const r = row.getBoundingClientRect();
      const after = event.clientY > r.top + r.height / 2;
      row.classList.toggle('drop-before', !after);
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      if (dragFrom === null) return;
      event.preventDefault();
      const after = row.classList.contains('drop-after');
      let to = position + (after ? 1 : 0);
      if (dragFrom < to) to--;
      app.playlists.move(id, dragFrom, to);
    });
    return row;
  });

  const facts = [plural(entries.length, 'song'), duration ? formatLength(duration) : null, missing ? `${missing} not found` : null].filter(Boolean);
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'hero' },
      coverArt(app, tracks[0]?._albumKey, { seed: playlist.id, placeholder: 'playlist' }),
      h(
        'div',
        { class: 'hero-text' },
        h('div', { class: 'eyebrow muted' }, 'Playlist'),
        h('h1', null, playlist.name),
        h('p', { class: 'muted' }, facts.join(' · ')),
        h(
          'div',
          { class: 'hero-actions' },
          playButtons(app, () => tracks),
          iconButton('more', 'More options', (event) =>
            openMenu(event.currentTarget, [
              { label: 'Play next', icon: 'playNext', onClick: () => app.playNext(tracks) },
              { label: 'Add to queue', icon: 'queue', onClick: () => app.addToQueue(tracks) },
              'separator',
              {
                label: 'Rename',
                icon: 'edit',
                onClick: async () => {
                  const name = await promptDialog({ title: 'Rename playlist', label: 'Playlist name', value: playlist.name, okLabel: 'Rename' });
                  if (name) app.playlists.rename(id, name);
                },
              },
              {
                label: 'Delete playlist',
                icon: 'trash',
                danger: true,
                onClick: async () => {
                  const ok = await confirmDialog({ title: `Delete “${playlist.name}”?`, message: 'The playlist is removed. Your music files are not touched.', okLabel: 'Delete', danger: true });
                  if (ok) {
                    await app.playlists.remove(id);
                    app.navigate('#/playlists');
                  }
                },
              },
            ]),
          ),
        ),
      ),
    ),
    entries.length
      ? h('div', { class: 'tracks' }, rows)
      : emptyState('playlist', 'This playlist is empty', 'Use “Add to playlist” on any song, album, artist or genre to fill it.'),
  );
}

export function searchView(app, query) {
  const { lib } = app;
  const results = searchLibrary(lib, query);
  const { totals } = results;
  if (!query.trim()) {
    return h('div', { class: 'page' }, pageHeader('Search'), emptyState('search', 'Search your music', 'Type an artist, album or song name.'));
  }
  if (!totals.artists && !totals.albums && !totals.tracks) {
    return h('div', { class: 'page' }, pageHeader(`Results for “${query}”`), emptyState('search', 'Nothing found', 'Try fewer or different words.'));
  }
  const more = (shown, total) => (total > shown ? h('p', { class: 'muted more-note' }, `Showing the first ${shown} of ${total.toLocaleString()}. Add words to narrow it down.`) : null);
  return h(
    'div',
    { class: 'page' },
    pageHeader(`Results for “${query}”`),
    results.artists.length
      ? [
          h('h2', { class: 'section-title' }, 'Artists'),
          h(
            'div',
            { class: 'grid' },
            results.artists.slice(0, 12).map((artist) =>
              card(app, {
                href: artistHref(artist.name),
                art: coverArt(app, (artist.albums[0] ?? artist.appearsOn[0])?.key, { seed: artist.key, round: true, placeholder: 'person' }),
                title: artist.name,
                detail: artist.albums.length ? plural(artist.albums.length, 'album') : plural(artist.tracks.length, 'song'),
                getTracks: () => artist.tracks,
                menuLabel: artist.name,
              }),
            ),
          ),
        ]
      : null,
    results.albums.length ? [h('h2', { class: 'section-title' }, 'Albums'), albumGrid(app, results.albums.slice(0, 24)), more(Math.min(24, results.albums.length), totals.albums)] : null,
    results.tracks.length
      ? [
          h('h2', { class: 'section-title' }, 'Songs'),
          h('div', { class: 'tracks' }, results.tracks.map((t, i) => trackRow(app, t, { list: results.tracks, index: i, showAlbum: true }))),
          more(results.tracks.length, totals.tracks),
        ]
      : null,
  );
}

// ----------------------------------------------------- empty / first run

function notFound(app, what) {
  return h(
    'div',
    { class: 'page' },
    emptyState('search', `That ${what} is no longer in your library`, 'It may have been renamed or removed since the last scan.', h('a', { class: 'btn', href: '#/albums' }, 'Back to albums')),
  );
}

function libraryEmpty(app) {
  if (app.scan.active) {
    return h('div', { class: 'page' }, emptyState('refresh', 'Reading your music…', 'Albums appear here as they are found.'));
  }
  return h(
    'div',
    { class: 'page' },
    emptyState(
      'note',
      'No music found',
      `There are no music files in “${app.source.folderName}” yet, or the folder has not been scanned.`,
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => app.rescan() }, icon('refresh', 18), 'Scan now'),
      h('button', { class: 'btn', type: 'button', onClick: () => app.chooseFolder() }, 'Choose another folder'),
    ),
  );
}

export function welcomeView(app) {
  if (!app.supported) {
    return h(
      'div',
      { class: 'page' },
      emptyState('warning', 'This browser can’t open folders', 'Platter needs the File System Access API. Please open it in Chrome (on a Chromebook, that is the built-in browser).'),
    );
  }
  return h(
    'div',
    { class: 'page welcome' },
    h('img', { class: 'welcome-logo', src: 'icons/icon.svg', alt: '', width: 96, height: 96 }),
    h('h1', null, 'Welcome to Platter'),
    h('p', { class: 'muted' }, 'A music player for the music on your own drive.'),
    h(
      'ol',
      { class: 'welcome-steps' },
      h('li', null, 'Plug in the drive that holds your music.'),
      h('li', null, 'Press the button below and pick the folder your music is in.'),
      h('li', null, 'Platter reads the tags once and remembers them. After that, just pick an artist, album or genre and press play.'),
    ),
    h('button', { class: 'btn btn-primary btn-large', type: 'button', onClick: () => app.chooseFolder() }, icon('folder', 20), 'Choose music folder'),
    h('p', { class: 'muted small' }, 'Your music stays on the drive. Platter only reads it, and nothing leaves this computer.'),
  );
}
