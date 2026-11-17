// The in-memory music library: takes the flat list of track records and builds
// the "lenses" the UI browses by - albums, artists and genres - plus search.
// Pure data code with no browser dependencies.

import { dirOf } from './tags.js';

export const VARIOUS_ARTISTS = 'Various Artists';

const SEP = '\u001f';
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Identity key: case- and whitespace-insensitive, so "The Beatles " == "the beatles". */
export function keyOf(s) {
  return String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Search form: additionally ignores accents, so "bjork" finds "Björk". */
export function fold(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * What search compares: accents, case and punctuation do not count, so
 * "born usa" finds "Born in the U.S.A." and "dont stop" finds "Don't Stop".
 */
export function searchForm(s) {
  return fold(s)
    .replace(/[.'’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Sort form: "The Beatles" files under B. */
function sortName(s) {
  return keyOf(s).replace(/^the\s+/, '');
}

export function compareText(a, b) {
  return collator.compare(a, b);
}

function mostCommon(values) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (const v of values) {
    if (v == null) continue;
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Decides the album artist for tracks that have no ALBUMARTIST tag, looking at
 * all tracks of the same album in the same folder together:
 *  - everyone agrees on the artist            -> that artist
 *  - "X" and "X feat. Y" mixed                -> X
 *  - genuinely different artists (compilation) -> Various Artists
 */
function resolveAlbumArtist(group) {
  if (group.some((t) => t.compilation)) return VARIOUS_ARTISTS;
  let shortest = group[0];
  for (const t of group) if (keyOf(t.artist).length < keyOf(shortest.artist).length) shortest = t;
  const base = keyOf(shortest.artist);
  const allShareBase = group.every((t) => {
    const k = keyOf(t.artist);
    return k === base || (k.startsWith(base) && /^[\s,;&(/]/.test(k.slice(base.length)));
  });
  return allShareBase ? shortest.artist : VARIOUS_ARTISTS;
}

const ADOPTED_FIELDS = ['album', 'albumArtist', 'artist', 'year', 'originalYear', 'genres'];

/**
 * A track whose album had to be guessed from its path (no tag, or a ripper's
 * "Unknown album" stand-in) usually sits in a folder with properly tagged
 * tracks of the same album. It then takes the album, album artist, year and
 * genre from those neighbours, so it lands in the right album instead of in a
 * one-track album of its own.
 *
 * The values a track had before adopting are kept in `_orig`, so rebuilding
 * the library always starts from what the file itself says.
 */
function adoptFolderTags(records) {
  const folders = new Map();
  for (const t of records) {
    if (!t.guessed?.includes('album')) continue;
    t._orig ??= Object.fromEntries(ADOPTED_FIELDS.map((f) => [f, t[f]]));
    Object.assign(t, t._orig);
    const dir = dirOf(t.path);
    if (!folders.has(dir)) folders.set(dir, { weak: [], strong: [] });
    folders.get(dir).weak.push(t);
  }
  if (!folders.size) return;
  for (const t of records) {
    if (!t.guessed?.includes('album')) folders.get(dirOf(t.path))?.strong.push(t);
  }

  for (const { weak, strong } of folders.values()) {
    if (!strong.length) continue;
    const albumKey = mostCommon(strong.map((t) => keyOf(t.album)));
    const peers = strong.filter((t) => keyOf(t.album) === albumKey);
    if (peers.length * 2 < strong.length) continue; // a mixed bag: no album to adopt
    const [first] = peers;
    const oneArtist = peers.every((p) => keyOf(p.artist) === keyOf(first.artist));
    const albumArtist = mostCommon(peers.map((p) => p.albumArtist));
    const year = mostCommon(peers.map((p) => p.year));
    const originalYear = mostCommon(peers.map((p) => p.originalYear));
    for (const t of weak) {
      t.album = first.album;
      t.albumArtist = albumArtist;
      if (t.guessed.includes('artist')) t.artist = oneArtist ? first.artist : albumArtist ?? t.artist;
      t.year ??= year;
      t.originalYear ??= originalYear;
      if (!t.genres.length) t.genres = first.genres;
    }
  }
}

const LOSSLESS = new Set(['flac', 'wav']);

/** Of two copies of one song, which is the one to keep: lossless first, then the bigger file. */
function compareCopies(a, b) {
  return (
    LOSSLESS.has(b.fmt) - LOSSLESS.has(a.fmt) || (b.size ?? 0) - (a.size ?? 0) || collator.compare(a.path, b.path)
  );
}

/**
 * Collections grow copies: the same album ripped to FLAC and bought as AAC,
 * or a music folder duplicated by a media-library migration. Within an album,
 * tracks in the same disc/track slot with the same title are one song; the
 * best copy stays and the others are marked `_dup` and left out of the lenses
 * (they remain known, so a rescan does not keep re-reading them).
 */
function dropDuplicates(album) {
  const slots = new Map();
  for (const t of album.tracks) {
    const slot = `${t.discNo ?? 1}/${t.trackNo ?? '-'}/${keyOf(t.title)}`;
    const copies = slots.get(slot);
    if (copies) copies.push(t);
    else slots.set(slot, [t]);
  }
  if (slots.size === album.tracks.length) return 0;
  const keep = [];
  for (const copies of slots.values()) {
    copies.sort(compareCopies);
    keep.push(copies[0]);
    for (let i = 1; i < copies.length; i++) copies[i]._dup = true;
  }
  const dropped = album.tracks.length - keep.length;
  album.tracks = keep;
  return dropped;
}

/**
 * Sets `_disc` on every track of an album. Normally that is just the disc
 * number tag. But a multi-disc set ripped into one folder without disc tags
 * has every track number twice; there the discs are told apart by the order
 * the files were written in (each disc was ripped in one go), provided that
 * splits the tracks cleanly.
 */
function assignDiscs(album) {
  const { tracks } = album;
  for (const t of tracks) t._disc = t.discNo ?? 1;
  if (tracks.some((t) => t.discNo != null || t.trackNo == null)) return;

  const perNumber = new Map();
  let most = 1;
  for (const t of tracks) {
    const n = (perNumber.get(t.trackNo) ?? 0) + 1;
    perNumber.set(t.trackNo, n);
    if (n > most) most = n;
  }
  if (most === 1) return;

  const byTime = tracks.slice().sort((a, b) => a.mtime - b.mtime || collator.compare(a.path, b.path));
  let disc = 1;
  let previous = 0;
  const guess = new Map();
  for (const t of byTime) {
    if (t.trackNo <= previous) disc++;
    previous = t.trackNo;
    guess.set(t, disc);
  }
  if (disc !== most) return; // the files were not written disc by disc: leave it alone
  for (const t of tracks) t._disc = guess.get(t);
}

function compareTracksInAlbum(a, b) {
  return (
    a._disc - b._disc ||
    (a.trackNo ?? 9999) - (b.trackNo ?? 9999) ||
    collator.compare(a.path, b.path)
  );
}

function compareAlbumsChronologically(a, b) {
  return (a.year ?? 9999) - (b.year ?? 9999) || collator.compare(a.title, b.title);
}

/**
 * @param {Iterable<object>} trackRecords records as produced by tags.js. Each gets two
 *   derived fields: `_albumKey` and `_aa` (the resolved album artist name).
 */
export function buildLibrary(trackRecords) {
  const tracks = new Map();
  const untagged = new Map();
  if (!Array.isArray(trackRecords)) trackRecords = [...trackRecords];
  adoptFolderTags(trackRecords);

  for (const t of trackRecords) {
    tracks.set(t.path, t);
    t._hay = undefined;
    t._dup = false;
    if (t.albumArtist) {
      t._aa = t.albumArtist;
    } else {
      const groupKey = dirOf(t.path) + SEP + keyOf(t.album);
      let group = untagged.get(groupKey);
      if (!group) untagged.set(groupKey, (group = []));
      group.push(t);
    }
  }
  for (const group of untagged.values()) {
    const albumArtist = resolveAlbumArtist(group);
    for (const t of group) t._aa = albumArtist;
  }

  // Albums
  const albums = new Map();
  for (const t of tracks.values()) {
    const key = keyOf(t._aa) + SEP + keyOf(t.album);
    t._albumKey = key;
    let album = albums.get(key);
    if (!album) {
      album = {
        key,
        title: t.album,
        artist: t._aa,
        artistKey: keyOf(t._aa),
        tracks: [],
        /** The year shown and sorted by: when the album first came out if known, else `editionYear`. */
        year: null,
        /** Year of the edition the files come from (a remaster's DATE tag). */
        editionYear: null,
        /** First release, from ORIGINALDATE tags; null when the files do not say. */
        originalYear: null,
        genres: [],
        duration: 0,
        added: 0,
        discCount: 1,
      };
      albums.set(key, album);
    }
    album.tracks.push(t);
  }
  let duplicates = 0;
  for (const album of albums.values()) {
    duplicates += dropDuplicates(album);
    assignDiscs(album);
    album.tracks.sort(compareTracksInAlbum);
    album.editionYear = mostCommon(album.tracks.map((t) => t.year));
    album.originalYear = mostCommon(album.tracks.map((t) => t.originalYear));
    album.year = album.originalYear ?? album.editionYear;
    album.discCount = new Set(album.tracks.map((t) => t._disc)).size;
    const genreNames = new Map();
    for (const t of album.tracks) {
      album.duration += t.duration ?? 0;
      if (t.mtime > album.added) album.added = t.mtime;
      for (const g of t.genres) if (!genreNames.has(keyOf(g))) genreNames.set(keyOf(g), g);
    }
    album.genres = [...genreNames.values()];
  }

  const sortedAlbums = [...albums.values()].sort(
    (a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || compareAlbumsChronologically(a, b),
  );

  // Artists and genres, visiting tracks in album order so their track lists come out ordered.
  const artists = new Map();
  const genres = new Map();
  const artistFor = (name) => {
    const key = keyOf(name);
    let artist = artists.get(key);
    if (!artist) {
      artist = { key, name, albums: [], appearsOn: [], tracks: [] };
      artists.set(key, artist);
    }
    return artist;
  };

  for (const album of sortedAlbums) {
    const albumArtist = artistFor(album.artist);
    albumArtist.albums.push(album);
    const guests = new Set();
    const albumGenres = new Set();
    for (const t of album.tracks) {
      albumArtist.tracks.push(t);
      if (keyOf(t.artist) !== album.artistKey) {
        const guest = artistFor(t.artist);
        guest.tracks.push(t);
        if (!guests.has(guest)) {
          guests.add(guest);
          guest.appearsOn.push(album);
        }
      }
      for (const name of t.genres) {
        const key = keyOf(name);
        let genre = genres.get(key);
        if (!genre) genres.set(key, (genre = { key, name, albums: [], tracks: [] }));
        genre.tracks.push(t);
        if (!albumGenres.has(genre)) {
          albumGenres.add(genre);
          genre.albums.push(album);
        }
      }
    }
  }
  for (const artist of artists.values()) {
    artist.albums.sort(compareAlbumsChronologically);
    artist.appearsOn.sort(compareAlbumsChronologically);
  }

  const lib = {
    /** Every known file, including duplicate copies that the lenses leave out. */
    tracks,
    /** Number of distinct songs: what the lenses show. */
    songCount: tracks.size - duplicates,
    duplicates,
    albums,
    artists,
    genres,
    sortedAlbums,
    /** The Artists lens lists album artists; guest-only artists are reachable through search. */
    sortedArtists: [...artists.values()]
      .filter((a) => a.albums.length > 0)
      .sort((a, b) => collator.compare(sortName(a.name), sortName(b.name))),
    sortedGenres: [...genres.values()].sort((a, b) => collator.compare(a.name, b.name)),
    _sortedTracks: null,
    /** All tracks by title. Sorted on first use, since many sessions never open the Songs view. */
    get sortedTracks() {
      this._sortedTracks ??= [...tracks.values()].filter((t) => !t._dup).sort(
        (a, b) => collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist),
      );
      return this._sortedTracks;
    },
  };
  return lib;
}

export function emptyLibrary() {
  return buildLibrary([]);
}

/**
 * The record as it should be stored: without derived fields, and with what
 * the file itself says rather than what was adopted from its neighbours.
 */
export function toRecord(track) {
  const record = {};
  for (const key of Object.keys(track)) if (key[0] !== '_') record[key] = track[key];
  if (track._orig) Object.assign(record, track._orig);
  return record;
}

function rank(items, nameOf, firstTerm, limit) {
  const starts = [];
  const rest = [];
  for (const item of items) (searchForm(nameOf(item)).startsWith(firstTerm) ? starts : rest).push(item);
  return starts.concat(rest).slice(0, limit);
}

/**
 * Every word of the query must appear somewhere in the item (in any field;
 * accents, case and punctuation ignored). Results whose name starts with the
 * query come first.
 */
export function searchLibrary(lib, query, { limit = 60 } = {}) {
  const terms = searchForm(query).split(' ').filter(Boolean);
  const empty = { artists: [], albums: [], tracks: [], totals: { artists: 0, albums: 0, tracks: 0 } };
  if (!terms.length) return empty;
  const matches = (hay) => terms.every((term) => hay.includes(term));

  const artists = [];
  for (const artist of lib.artists.values()) if (matches(searchForm(artist.name))) artists.push(artist);
  artists.sort((a, b) => b.albums.length - a.albums.length || collator.compare(a.name, b.name));

  const albums = lib.sortedAlbums.filter((album) => matches(searchForm(album.title + ' ' + album.artist)));

  const tracks = [];
  for (const t of lib.tracks.values()) {
    if (t._dup) continue;
    t._hay ??= searchForm(t.title + ' ' + t.artist + ' ' + t.album);
    if (matches(t._hay)) tracks.push(t);
  }
  tracks.sort((a, b) => collator.compare(a.title, b.title));

  return {
    artists: rank(artists, (a) => a.name, terms[0], limit),
    albums: rank(albums, (a) => a.title, terms[0], limit),
    tracks: rank(tracks, (t) => t.title, terms[0], limit),
    totals: { artists: artists.length, albums: albums.length, tracks: tracks.length },
  };
}
