#!/usr/bin/env python3
"""Add the original release date (ORIGINALDATE) to albums already on the drive.

A file's DATE/YEAR tag says when *that edition* came out: a 2002 remaster of
a 1984 album says 2002, and Windows Media Player's years are often a year
off. Platter sorts and queries albums by the original year when the files
carry ORIGINALDATE, which the CD ripper writes but old rips lack.

Two steps, with a plan file in between that you read and edit:

  lookup   Reads the tags of every FLAC and M4A file in the music folder,
           groups them into albums and looks each album up in MusicBrainz:
             - by disc ID, computed from the CD table of contents Windows
               Media Player saved in each file (WM/MCDI) -- exact;
             - by that table of contents, approximately, when the exact ID
               is unknown;
             - by searching for album artist + title (iTunes files, rips
               without WM/MCDI) -- needs a human to check.
           Writes plan.tsv: one row per album, with what it would write.
           Nothing on the drive is changed.

  apply    Writes ORIGINALDATE and MUSICBRAINZ_RELEASEGROUPID into the files
           of the rows marked "yes". Existing tags are never changed, and a
           file that already has ORIGINALDATE is left alone, so it can be
           re-run after an interruption.

The files on the drive have no spare room for new tags (no FLAC padding), so
adding a tag means rewriting the whole file. Each file is therefore copied to
the Chromebook's disk, tagged there, checked to still hold byte-identical
audio, copied back next to the original under a hidden name, checked again,
and only then renamed over the original. An interruption at any point leaves
either the old file or the new one, never a broken one.

Run it through uv like the ripper:  npm run years -- lookup | apply
"""

import argparse
import collections
import csv
import difflib
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import time
import unicodedata
import urllib.error

import mutagen.flac
import mutagen.mp4

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import platter_rip as pr  # noqa: E402

CACHE_ROOT = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'),
                          'platter-years')
DEFAULT_PLAN = os.path.join(CACHE_ROOT, 'plan.tsv')
TEMP_SUFFIX = '.platter-years'          # hidden temp files next to the originals: .<name>.platter-years

SKIPPED_DIRS = re.compile(r'^(\$RECYCLE\.BIN|System Volume Information|lost\+found|@eaDir)$', re.I)
PROTECTED_CODECS = ('drms', 'drmi', 'p608')

# Stand-in tags written by rippers that could not identify a CD (as in app/js/tags.js).
PLACEHOLDER_ARTIST = re.compile(r'^(unknown artist|tuntematon esittäjä|okänd artist|unbekannter interpret)$', re.I)
PLACEHOLDER_ALBUM = re.compile(r'^(unknown album|tuntematon albumi|okänt album|unbekanntes album)(\s*\(.*\))?$', re.I)
DISC_SUFFIX = re.compile(r'^(.*\S)\s*[\[(](?:disc|disk|cd)\s*\d+[\])]$', re.I)

MP4_FREEFORM = '----:com.apple.iTunes:'
MP4_NAMES = {'ORIGINALDATE': 'ORIGINALDATE', 'MUSICBRAINZ_RELEASEGROUPID': 'MusicBrainz Release Group Id'}


# --------------------------------------------------------------------------
# Text

def fold(s):
    """Case-, accent- and punctuation-insensitive form for comparing names."""
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c)).casefold()
    s = re.sub(r"[.'’`´]", '', s)
    s = re.sub(r'\s*[&+]\s*', ' and ', s)       # "X&Y" = "X & Y", "Light + Shade" = "Light and Shade"
    return ' '.join(re.findall(r'\w+', s))


def strip_disc(album):
    """'Live 1975-85 [Disc 2]' -> 'Live 1975-85'."""
    m = DISC_SUFFIX.match(album or '')
    return m.group(1) if m else album


TYPE_SUFFIX = re.compile(r'\s+-\s+(EP|Single)$', re.I)


def search_title(album):
    """The title to search MusicBrainz for, and a release type it hints at.

    iTunes appends ' - EP' / ' - Single'; MusicBrainz keeps that in the type.
    """
    album = strip_disc(album)
    m = TYPE_SUFFIX.search(album)
    if m:
        return album[:m.start()], {'ep': 'EP', 'single': 'Single'}[m.group(1).lower()]
    return album, None


def without_brackets(s):
    """'Minimum-Maximum (Live)' -> 'Minimum-Maximum'."""
    return re.sub(r'\s*[\[(][^\])]*[\])]', '', s).strip() or s


def titles_match(ours, theirs):
    a, b = fold(strip_disc(ours)), fold(theirs)
    if a == b:
        return True
    return fold(without_brackets(strip_disc(ours))) == fold(without_brackets(theirs))


def titles_similar(ours, theirs):
    """Looser than titles_match, for name searches (whose rows a human checks anyway):
    'Tres Lunas' ~ 'Tr3s Lunas', 'Alchemy (Live)' ~ 'Alchemy: Dire Straits Live'."""
    if titles_match(ours, theirs):
        return True
    a, b = fold(without_brackets(strip_disc(ours))), fold(without_brackets(theirs))
    if not a or not b:
        return False
    if difflib.SequenceMatcher(None, a, b).ratio() >= 0.85:
        return True
    short, long_ = sorted((a, b), key=len)
    return len(short) >= 5 and long_.startswith(short + ' ')


VARIOUS = {'various artists', 'various', 'va', 'eri esittajia', 'diverse', 'verschiedene interpreten',
           'various classical artists', 'blandade artister'}


def artists_match(ours, theirs):
    """'Howard Shelley: City Of London Sinfonia' ~ 'Mozart; City of London Sinfonia, Howard Shelley'."""
    a, b = fold(ours), fold(theirs)
    if not a or not b:
        return False
    if a in VARIOUS or b in VARIOUS:
        return a in VARIOUS and b in VARIOUS
    if a == b or a in b or b in a:
        return True
    wa, wb = set(a.split()) - {'the', 'and', 'of'}, set(b.split()) - {'the', 'and', 'of'}
    return bool(wa and wb) and len(wa & wb) * 2 >= min(len(wa), len(wb))


def year_of(value):
    m = re.search(r'\d{4}', value or '')
    return int(m.group(0)) if m else None


def most_common(values):
    values = [v for v in values if v]
    return collections.Counter(values).most_common(1)[0][0] if values else None


# --------------------------------------------------------------------------
# Windows Media Player's CD table of contents

def toc_from_mcdi(mcdi):
    """WM/MCDI ("11+96+48A3+…+50AFA": track count, then each track's start and
    the lead-out, in hex sectors including the 150-sector lead-in) -> Toc."""
    try:
        values = [int(x, 16) for x in mcdi.strip().split('+')]
    except ValueError:
        return None
    if len(values) < 3:
        return None
    count = values[0]
    if count < 1 or count > 99 or len(values) != count + 2:
        return None
    starts, leadout = values[1:count + 1], values[count + 1]
    if any(b <= a for a, b in zip(starts, starts[1:] + [leadout])) or starts[0] < 150:
        return None
    return pr.Toc([(i + 1, s - 150) for i, s in enumerate(starts)], leadout - 150)


def without_last_track(toc):
    """The same disc read as an Enhanced CD: its last track is data, which
    MusicBrainz leaves out (and puts the audio lead-out 11,400 sectors before it)."""
    if len(toc.tracks) < 2:
        return None
    leadout = toc.tracks[-1][1] - 11400
    if leadout <= toc.tracks[-2][1]:
        return None                     # the last track is too close to be after a data gap: plain audio CD
    return pr.Toc(toc.tracks[:-1], leadout)


# --------------------------------------------------------------------------
# Reading the music folder

class FileInfo:
    def __init__(self, path, kind, album, album_artist, artist, year, mcdi, original_date, protected):
        self.path = path
        self.kind = kind                    # 'flac' or 'm4a'
        self.album = album
        self.album_artist = album_artist
        self.artist = artist
        self.year = year
        self.mcdi = mcdi
        self.original_date = original_date
        self.protected = protected


def _first(tags, *keys):
    for k in keys:
        v = tags.get(k)
        if v:
            v = v[0]
            if isinstance(v, bytes):
                v = v.decode('utf-8', 'replace')
            if str(v).strip():
                return str(v).strip()
    return None


def read_file(path):
    """Tags that matter here, or None for a file that cannot be read."""
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == '.flac':
            f = mutagen.flac.FLAC(path)
            t = {k.upper(): v for k, v in (f.tags or {}).items()}
            return FileInfo(path, 'flac', _first(t, 'ALBUM'),
                            _first(t, 'ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST'), _first(t, 'ARTIST'),
                            year_of(_first(t, 'DATE', 'YEAR')), _first(t, 'WM/MCDI'),
                            _first(t, 'ORIGINALDATE', 'ORIGINALYEAR'), False)
        if ext == '.m4a':
            f = mutagen.mp4.MP4(path)
            t = f.tags or {}
            codec = (getattr(f.info, 'codec', '') or '').lower()
            return FileInfo(path, 'm4a', _first(t, '©alb'), _first(t, 'aART'), _first(t, '©ART'),
                            year_of(_first(t, '©day')), None,
                            _first(t, MP4_FREEFORM + 'ORIGINALDATE', MP4_FREEFORM + 'ORIGINALYEAR'),
                            codec.startswith(PROTECTED_CODECS))
    except (mutagen.MutagenError, OSError, ValueError):
        return None
    return None


def walk(root):
    """Audio files under `root`, skipping hidden names and system folders like Platter does."""
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not x.startswith('.') and not SKIPPED_DIRS.match(x))
        for name in sorted(files):
            if not name.startswith('.') and os.path.splitext(name)[1].lower() in ('.flac', '.m4a'):
                yield os.path.join(d, name)


def real(value, placeholder):
    return value if value and not placeholder.match(value) else None


def album_key(album_artist, album):
    return fold(album_artist) + '\x1f' + fold(strip_disc(album))


class Album:
    def __init__(self, key, artist, title):
        self.key = key
        self.artist = artist
        self.title = title
        self.files = []

    @property
    def mcdis(self):
        return sorted({f.mcdi for f in self.files if f.mcdi})

    @property
    def current_year(self):
        return most_common(f.year for f in self.files)


def group_albums(infos):
    """Albums, keyed by album artist + title.

    Files from one CD (the same WM/MCDI) belong together even when some of
    them carry a ripper's "Unknown album" stand-in tags: they take the
    album and artist most of the disc agrees on.
    """
    disc_names = {}
    by_mcdi = collections.defaultdict(list)
    for f in infos:
        if f.mcdi:
            by_mcdi[f.mcdi].append(f)
    for mcdi, files in by_mcdi.items():
        disc_names[mcdi] = (
            most_common(real(f.album_artist, PLACEHOLDER_ARTIST) or real(f.artist, PLACEHOLDER_ARTIST) for f in files),
            most_common(real(f.album, PLACEHOLDER_ALBUM) for f in files),
        )
    albums = {}
    for f in infos:
        if f.protected:
            continue
        artist = real(f.album_artist, PLACEHOLDER_ARTIST) or real(f.artist, PLACEHOLDER_ARTIST)
        title = real(f.album, PLACEHOLDER_ALBUM)
        if f.mcdi:
            artist, title = disc_names[f.mcdi][0] or artist, disc_names[f.mcdi][1] or title
        if not artist or not title:
            continue                        # nothing to look up
        title = strip_disc(title)
        key = album_key(artist, title)
        if key not in albums:
            albums[key] = Album(key, artist, title)
        albums[key].files.append(f)
    return albums


def scan(root, log):
    infos = []
    unreadable = 0
    for n, path in enumerate(walk(root), 1):
        info = read_file(path)
        if info is None:
            unreadable += 1
        else:
            infos.append(info)
        if n % 250 == 0:
            log(f'  read {n} files…')
    if unreadable:
        log(f'  {unreadable} file(s) could not be read and are left out.')
    return infos


# --------------------------------------------------------------------------
# MusicBrainz, with a cache so a second lookup run is quick

class Busy(Exception):
    """MusicBrainz kept saying it is too busy."""


_pace = 0.5


def cached_musicbrainz(path, refresh=False, **params):
    key = hashlib.sha1(json.dumps([path, sorted(params.items())]).encode()).hexdigest()
    cache = os.path.join(CACHE_ROOT, 'mb', key + '.json')
    if not refresh:
        try:
            with open(cache) as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    global _pace
    result = None
    for attempt in range(6):
        time.sleep(_pace)               # on top of the ripper's own 1.1 s spacing
        try:
            result = pr.musicbrainz(path, **params)
            _pace = max(0.5, _pace * 0.9)
            break
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):    # 400: MusicBrainz finds the request (e.g. a TOC) invalid
                result = {}
                break
            if e.code not in (429, 503):
                raise
            # MusicBrainz is busy or wants us slower: go slower from now on, wait as it asks, retry.
            _pace = min(10.0, _pace * 2)
            if attempt == 5:
                raise Busy() from e
            try:
                wait = float(e.headers.get('Retry-After') or 0)
            except ValueError:
                wait = 0
            time.sleep(max(wait, min(60, 2 ** (attempt + 2))))
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, 'w') as f:
        json.dump(result, f)
    return result


class Match:
    """What a lookup found for an album."""

    def __init__(self, method, decision, date='', group_id='', note=''):
        self.method = method                # 'discid' | 'toc' | 'search' | 'none'
        self.decision = decision            # 'yes' | 'check' | 'no'
        self.date = date                    # first-release-date of the release group
        self.group_id = group_id
        self.note = note


def describe_group(g):
    kind = '/'.join(x for x in [g.get('primary-type')] + (g.get('secondary-types') or []) if x) or '?'
    return f'"{g.get("title", "?")}" ({kind}, {g.get("first-release-date") or "no date"})'


def from_disc_lookup(album, response, exact):
    """Decide on the release groups the releases of a disc lookup belong to.

    An exact disc ID is trusted. A near match by table of contents is not: CDs
    with similar track lengths are common, so it needs the title or the artist
    to agree before it counts (otherwise None, and the album is searched by name).
    """
    groups, credits = {}, collections.defaultdict(set)
    for r in response.get('releases', []):
        g = r.get('release-group') or {}
        if g.get('id'):
            groups.setdefault(g['id'], g)
            credits[g['id']].add(pr.credit_name(r.get('artist-credit')))
    if not groups:
        return None
    method = 'discid' if exact else 'toc'

    def named(g):
        return titles_match(album.title, g.get('title', ''))

    def by_artist(g):
        # "Various Artists" agreeing with "Various Artists" says nothing about a near match.
        if not exact and fold(album.artist) in VARIOUS:
            return False
        return any(artists_match(album.artist, c) for c in credits[g['id']] if c)

    def others(pick):
        rest = [describe_group(x) for x in groups.values() if x is not pick]
        return '; '.join(rest[:4]) + ('; …' if len(rest) > 4 else '')

    if len(groups) == 1:
        (g,) = groups.values()
        if not exact and not (named(g) or by_artist(g)):
            return None
        ok = exact or named(g)
        note = '' if named(g) else f'MusicBrainz calls it {describe_group(g)}'
        return Match(method, 'yes' if ok else 'check', g.get('first-release-date', ''), g['id'], note)
    best = [g for g in groups.values() if named(g) and (exact or by_artist(g))]
    if len(best) == 1:
        g = best[0]
        return Match(method, 'yes', g.get('first-release-date', ''), g['id'], f'disc also on: {others(g)}')
    plausible = ([g for g in groups.values() if named(g)] or [g for g in groups.values() if by_artist(g)]
                 or (list(groups.values()) if exact else []))
    if not plausible:
        return None
    # Several candidates: take the earliest plausible one, ask a human.
    pick = sorted(plausible, key=lambda x: x.get('first-release-date') or '9999')[0]
    return Match(method, 'check', pick.get('first-release-date', ''), pick['id'],
                 f'picked {describe_group(pick)}; also: {others(pick)}')


def lookup_disc(album, refresh, log):
    """Look up each CD of the album; they should agree on one release group."""
    matches = []
    for mcdi in album.mcdis:
        toc = toc_from_mcdi(mcdi)
        if toc is None:
            continue
        variants = [toc]
        alt = without_last_track(toc)
        if alt:
            variants.append(alt)
        found = None
        for t in variants:
            res = cached_musicbrainz(f'discid/{t.musicbrainz_id()}', refresh, toc=t.musicbrainz_toc(),
                                     cdstubs='no', inc='release-groups artist-credits')
            found = from_disc_lookup(album, res, exact=bool(res.get('id')))
            if found:
                break
        if found:
            matches.append(found)
    if not matches:
        return None
    groups = {m.group_id for m in matches}
    best = sorted(matches, key=lambda m: ({'yes': 0, 'check': 1}[m.decision], m.method != 'discid'))[0]
    if len(groups) > 1:
        best.decision = 'check'
        best.note = (best.note + '; ' if best.note else '') + f'the {len(matches)} discs point to different albums'
    return best


def lucene(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


TYPE_ORDER = {'Album': 0, 'EP': 1, 'Single': 2}


def from_search(album, response):
    title, hinted = search_title(album.title)
    candidates = [g for g in response.get('release-groups', [])
                  if titles_similar(title, g.get('title', ''))
                  and artists_match(album.artist, pr.credit_name(g.get('artist-credit')))]
    if not candidates:
        return None

    def rank(g):
        kind = g.get('primary-type')
        return (0 if titles_match(title, g.get('title', '')) else 1,   # exact titles before look-alikes
                0 if hinted and kind == hinted else 1,
                len(g.get('secondary-types') or []),       # a plain album before a live album or compilation
                TYPE_ORDER.get(kind, 3),
                -int(g.get('score', 0)),
                g.get('first-release-date') or '9999')

    candidates.sort(key=rank)
    pick = candidates[0]
    note = f'MusicBrainz: {describe_group(pick)}'
    if len(candidates) > 1:
        note += '; also: ' + '; '.join(describe_group(g) for g in candidates[1:4])
    return Match('search', 'check', pick.get('first-release-date', ''), pick['id'], note)


def words(value):
    """Search terms without Lucene syntax: 'X & Y' -> '(x and y)'."""
    return '(' + fold(value) + ')'


def lookup_search(album, refresh):
    """By exact phrase first; MusicBrainz's spelling often differs ('X&Y', 'Tr3s Lunas'),
    so then by words, which finds more and relies on the comparison afterwards."""
    title, _ = search_title(album.title)
    artist = album.artist if fold(album.artist) not in VARIOUS else 'Various Artists'
    queries = [f'releasegroup:{lucene(title)} AND artist:{lucene(artist)}']
    if without_brackets(title) != title:
        queries.append(f'releasegroup:{lucene(without_brackets(title))} AND artist:{lucene(artist)}')
    queries.append(f'releasegroup:{words(without_brackets(title))} AND artist:{words(artist)}')
    for query in queries:
        match = from_search(album, cached_musicbrainz('release-group', refresh, query=query, limit=15))
        if match:
            return match
    return None


def lookup(album, refresh, log):
    match = lookup_disc(album, refresh, log) if album.mcdis else None
    if match is None:
        match = lookup_search(album, refresh)
    if match is None:
        return Match('none', 'no', note='not found in MusicBrainz; type a date and set apply to yes to write it anyway')
    if not match.date:
        match.decision = 'no'
        match.note = (match.note + '; ' if match.note else '') + 'MusicBrainz has no release date for it'
    elif album.current_year and year_of(match.date) == album.current_year:
        match.decision = 'same'         # nothing visible would change; not worth rewriting the files
    return match


# --------------------------------------------------------------------------
# The plan file

PLAN_COLUMNS = ['apply', 'original_date', 'current_year', 'method', 'album_artist', 'album', 'files',
                'release_group', 'note']

PLAN_HEADER = """\
# Platter: original release dates to add. Edit, then run:  npm run years -- apply
#
# apply          yes = write; no = leave alone; check = look first, then change to yes or no.
#                same = found, and the year is the one the files already show: left alone
#                (change to yes to write it anyway).
#                Exact disc ID matches are "yes". Name searches and near matches are "check".
# original_date  what goes into ORIGINALDATE. You may type your own (YYYY or YYYY-MM-DD).
# current_year   the year the files show now (DATE / YEAR tag), for comparison.
# method         discid = exact CD match; toc = near-identical CD; search = by name; none = not found;
#                error = MusicBrainz could not be asked (run lookup again).
# release_group  MusicBrainz release group: https://musicbrainz.org/release-group/<id>
#                Clear it to write only the date.
# Do not edit album_artist or album: they say which files a row is about.
"""


def write_plan(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', newline='') as f:
        f.write(PLAN_HEADER)
        w = csv.DictWriter(f, PLAN_COLUMNS, delimiter='\t', lineterminator='\n')
        w.writeheader()
        for row in rows:
            w.writerow({k: ('' if row.get(k) is None else row[k]) for k in PLAN_COLUMNS})


def read_plan(path):
    with open(path, newline='') as f:
        lines = [line for line in f if not line.startswith('#') and line.strip()]
    rows = list(csv.DictReader(lines, delimiter='\t'))
    for row in rows:
        missing = [k for k in ('apply', 'original_date', 'album_artist', 'album', 'release_group') if k not in row]
        if missing:
            raise SystemExit(f'{path}: column(s) {", ".join(missing)} missing; was the header line changed?')
        for k in row:
            row[k] = (row[k] or '').strip()
    return rows


DATE_FORMAT = re.compile(r'^\d{4}(-\d{2}(-\d{2})?)?$')
MBID_FORMAT = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def validate_row(row):
    """Problem with a row marked yes, or None."""
    if not DATE_FORMAT.match(row['original_date']):
        return f'original_date "{row["original_date"]}" is not YYYY, YYYY-MM or YYYY-MM-DD'
    if row['release_group'] and not MBID_FORMAT.match(row['release_group']):
        return f'release_group "{row["release_group"]}" is not a MusicBrainz ID'
    return None


# --------------------------------------------------------------------------
# Writing tags safely

def audio_region(path):
    """(start, end) byte ranges of the audio data: what must never change."""
    with open(path, 'rb') as f:
        head = f.read(10)
        size = os.fstat(f.fileno()).st_size
        if head[:4] == b'fLaC' or head[:3] == b'ID3':
            pos = 0
            if head[:3] == b'ID3':          # an ID3v2 tag in front of the FLAC stream
                pos = 10 + ((head[6] & 127) << 21 | (head[7] & 127) << 14 | (head[8] & 127) << 7 | head[9] & 127)
                f.seek(pos)
                if f.read(4) != b'fLaC':
                    raise ValueError(f'{path}: not a FLAC file')
            pos += 4
            while True:
                f.seek(pos)
                h = f.read(4)
                if len(h) < 4:
                    raise ValueError(f'{path}: FLAC metadata runs past the end')
                pos += 4 + int.from_bytes(h[1:4], 'big')
                if h[0] & 0x80:
                    return [(pos, size)]
        # MP4: the payload of every top-level mdat box.
        regions, pos = [], 0
        while pos + 8 <= size:
            f.seek(pos)
            h = f.read(16)
            n, kind = struct.unpack('>I4s', h[:8])
            header = 8
            if n == 1:
                n, header = struct.unpack('>Q', h[8:16])[0], 16
            elif n == 0:
                n = size - pos
            if n < header:
                raise ValueError(f'{path}: broken MP4 box at {pos}')
            if kind == b'mdat':
                regions.append((pos + header, pos + n))
            pos += n
        if not regions:
            raise ValueError(f'{path}: no audio data found')
        return regions


def audio_digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for start, end in audio_region(path):
            f.seek(start)
            left = end - start
            while left:
                block = f.read(min(left, 1 << 20))
                if not block:
                    raise ValueError(f'{path}: audio data cut short')
                h.update(block)
                left -= len(block)
    return h.digest()


def copy_hashing(src, dst):
    """Copy src to dst; returns the SHA-256 of what was read."""
    h = hashlib.sha256()
    with open(src, 'rb') as i, open(dst, 'wb') as o:
        for block in iter(lambda: i.read(1 << 20), b''):
            h.update(block)
            o.write(block)
        o.flush()
        os.fsync(o.fileno())
    return h.digest()


def add_tags(path, kind, tags):
    """Add `tags` ({'ORIGINALDATE': …, 'MUSICBRAINZ_RELEASEGROUPID': …}) to a
    local file, leaving every existing tag as it is. Returns the names added."""
    added = []
    if kind == 'flac':
        f = mutagen.flac.FLAC(path)
        if f.tags is None:
            f.add_tags()
        present = {k.upper() for k in f.tags.keys()}
        for k, v in tags.items():
            if v and k not in present:
                f.tags[k] = [v]
                added.append(k)
        if added:
            f.save()                    # mutagen leaves padding behind, so later tag edits are cheap
    else:
        f = mutagen.mp4.MP4(path)
        if f.tags is None:
            f.add_tags()
        present = {k.upper() for k in f.tags.keys()}
        for k, v in tags.items():
            atom = MP4_FREEFORM + MP4_NAMES[k]
            if v and atom.upper() not in present:
                f.tags[atom] = [mutagen.mp4.MP4FreeForm(v.encode('utf-8'))]
                added.append(k)
        if added:
            f.save()
    return added


class WriteError(Exception):
    pass


def rewrite(path, kind, tags, workdir):
    """Add tags to the file at `path` on the drive, safely (see the module docstring).

    Returns the names of the tags added (empty if the file had them all).
    """
    before = os.stat(path)
    local = os.path.join(workdir, 'work.' + kind)
    original_sha = copy_hashing(path, local)
    if pr._digest(local) != original_sha:
        raise WriteError(f'{path}: the copy on this computer came out different')
    audio_before = audio_digest(local)
    added = add_tags(local, kind, tags)
    if not added:
        os.remove(local)
        return []
    if audio_digest(local) != audio_before:
        raise WriteError(f'{path}: audio changed while tagging; nothing written')
    check = read_file(local)
    if check is None or ('ORIGINALDATE' in added and check.original_date != tags['ORIGINALDATE']):
        raise WriteError(f'{path}: tags did not read back after tagging; nothing written')

    folder, name = os.path.split(path)
    temp = os.path.join(folder, f'.{name}{TEMP_SUFFIX}')
    new_sha = copy_hashing(local, temp)
    if pr._digest(temp) != new_sha:
        os.remove(temp)
        raise WriteError(f'{path}: the copy back to the drive came out different; is the drive OK?')
    now = os.stat(path)
    if (now.st_size, now.st_mtime_ns) != (before.st_size, before.st_mtime_ns):
        os.remove(temp)
        raise WriteError(f'{path}: changed by something else meanwhile; skipped')
    os.replace(temp, path)
    os.remove(local)
    return added


def remove_leftovers(root, log):
    """Hidden temp files left by an interrupted apply. The originals are intact."""
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not SKIPPED_DIRS.match(x)]
        for name in files:
            if name.startswith('.') and name.endswith(TEMP_SUFFIX):
                os.remove(os.path.join(d, name))
                log(f'  removed leftover {os.path.join(d, name)}')


# --------------------------------------------------------------------------
# Commands

def cmd_lookup(args, log):
    log(f'Reading tags in {args.dest} …')
    infos = scan(args.dest, log)
    albums = group_albums(infos)
    todo = [a for a in albums.values() if any(not f.original_date for f in a.files)]
    done = len(albums) - len(todo)
    log(f'{len(infos)} files, {len(albums)} albums'
        + (f' ({done} already have ORIGINALDATE everywhere)' if done else '') + '.')
    log(f'Looking up {len(todo)} albums in MusicBrainz (about one per second; answers are cached) …')
    rows = []
    for n, album in enumerate(sorted(todo, key=lambda a: (fold(a.artist), fold(a.title))), 1):
        try:
            m = lookup(album, args.refresh, log)
        except (Busy, urllib.error.URLError, OSError) as e:
            reason = 'MusicBrainz was too busy' if isinstance(e, Busy) else f'lookup failed ({e})'
            m = Match('error', 'no', note=f'{reason}; run lookup again (finished albums are cached)')
        rows.append({
            'apply': m.decision, 'original_date': m.date, 'current_year': album.current_year or '',
            'method': m.method, 'album_artist': album.artist, 'album': album.title,
            'files': len(album.files), 'release_group': m.group_id, 'note': m.note,
        })
        if n % 10 == 0 or n == len(todo):
            log(f'  {n}/{len(todo)}')
    order = {'check': 0, 'yes': 1, 'no': 2, 'same': 3}
    errors = sum(1 for r in rows if r['method'] == 'error')
    rows.sort(key=lambda r: (order[r['apply']], fold(r['album_artist']), fold(r['album'])))
    write_plan(args.plan, rows)

    count = collections.Counter(r['apply'] for r in rows)
    methods = collections.Counter(r['method'] for r in rows)
    log('')
    log(f'Plan written to {args.plan}')
    log(f'  yes: {count["yes"]}   check: {count["check"]}   no: {count["no"]}   '
        f'same (year already right): {count["same"]}')
    log(f'  by disc ID: {methods["discid"]}, by table of contents: {methods["toc"]}, '
        f'by name: {methods["search"]}, not found: {methods["none"]}')
    if errors:
        log(f'  {errors} album(s) could not be looked up (MusicBrainz busy or offline): '
            f'run "npm run years -- lookup" again; it only asks about those.')
    log('Edit the plan (change "check" rows to yes or no), then: npm run years -- apply')


def cmd_apply(args, log):
    rows = read_plan(args.plan)
    chosen = [r for r in rows if r['apply'].lower() == 'yes']
    bad = [(r, validate_row(r)) for r in chosen]
    bad = [(r, p) for r, p in bad if p]
    if bad:
        for r, problem in bad:
            log(f'{r["album_artist"]} – {r["album"]}: {problem}')
        raise SystemExit('Fix those rows in the plan first.')
    unsure = sum(1 for r in rows if r['apply'].lower() == 'check')
    if unsure:
        log(f'Note: {unsure} row(s) still say "check"; they are skipped.')
    if args.limit:
        chosen = chosen[:args.limit]
    if not chosen:
        log('No rows say "yes"; nothing to do.')
        return

    log(f'Reading tags in {args.dest} …')
    if not args.dry_run:
        remove_leftovers(args.dest, log)
    albums = group_albums(scan(args.dest, log))
    os.makedirs(CACHE_ROOT, exist_ok=True)
    totals = collections.Counter()
    with tempfile.TemporaryDirectory(dir=CACHE_ROOT) as workdir:
        for r in chosen:
            album = albums.get(album_key(r['album_artist'], r['album']))
            if album is None:
                log(f'{r["album_artist"]} – {r["album"]}: no files found any more; skipped')
                totals['missing albums'] += 1
                continue
            tags = {'ORIGINALDATE': r['original_date'], 'MUSICBRAINZ_RELEASEGROUPID': r['release_group']}
            files = [f for f in album.files if not f.original_date]
            log(f'{album.artist} – {album.title}: ORIGINALDATE={r["original_date"]}, {len(files)} file(s)'
                + (' (dry run)' if args.dry_run else ''))
            if args.dry_run:
                totals['files'] += len(files)
                continue
            for f in files:
                try:
                    added = rewrite(f.path, f.kind, tags, workdir)
                except WriteError as e:
                    log(f'  ! {e}')
                    totals['failed'] += 1
                    continue
                totals['files' if added else 'unchanged'] += 1
                log(f'  {os.path.basename(f.path)}' + ('' if added else ': already tagged'))
    log('')
    log(f'Done: {totals["files"]} file(s) {"would be " if args.dry_run else ""}tagged'
        + (f', {totals["failed"]} failed' if totals['failed'] else '')
        + (f', {totals["missing albums"]} album(s) not found' if totals['missing albums'] else '') + '.')
    if not args.dry_run and totals['files']:
        log('Platter re-reads the changed files on its next scan.')
    if totals['failed']:
        raise SystemExit(1)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Add original release dates (ORIGINALDATE) to albums on the drive.')
    sub = ap.add_subparsers(dest='command', required=True)
    for name, help_text in (('lookup', 'look the albums up and write a plan; changes nothing'),
                            ('apply', 'write the dates of the plan rows marked "yes"')):
        p = sub.add_parser(name, help=help_text)
        p.add_argument('--dest', default=os.environ.get(pr.MUSIC_DIR_ENV),
                       help=f'music folder (default: ${pr.MUSIC_DIR_ENV})')
        p.add_argument('--plan', default=DEFAULT_PLAN, help=f'plan file (default: {DEFAULT_PLAN})')
        if name == 'lookup':
            p.add_argument('--refresh', action='store_true', help='ask MusicBrainz again instead of using cached answers')
        else:
            p.add_argument('--dry-run', action='store_true', help='list what would be written; write nothing')
            p.add_argument('--limit', type=int, metavar='N', help='only the first N "yes" rows (to try it out)')
    args = ap.parse_args(argv)
    if not args.dest:
        raise SystemExit(f'Which music folder? Pass --dest, or set {pr.MUSIC_DIR_ENV}.')
    if not os.path.isdir(args.dest):
        raise SystemExit(f'{args.dest} does not exist. Is the music drive shared with Linux?')

    def log(msg=''):
        print(msg, flush=True)

    (cmd_lookup if args.command == 'lookup' else cmd_apply)(args, log)


if __name__ == '__main__':
    main()
