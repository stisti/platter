#!/usr/bin/env python3
"""Rip an audio CD into the music folder Platter reads.

ChromeOS's Linux kernel has no CD-ROM driver (no /dev/sr0, no /dev/sg*), so
cdparanoia, whipper and friends cannot open the drive. The kernel does
create a SCSI pass-through node, /dev/bsg/H:C:T:L, and this script talks to
the drive through it directly (the SG_IO ioctl, version 4 interface).

What it does, per disc:
  1. reads the table of contents, works out the MusicBrainz and AccurateRip
     disc IDs, and looks the disc up in both (MusicBrainz is retried while
     busy, then GnuDB is asked; if neither can say what the disc is, it
     stops here rather than rip an "Unknown Album");
  2. reads every audio track, corrected for the drive's read offset;
  3. checks each track against AccurateRip; a track that cannot be verified
     there is read a second time and any differing chunks re-read until the
     reads agree, or until the track's time (--patience) is up;
  4. writes FLAC files tagged from MusicBrainz, plus cover.jpg, into a
     staging folder on the Chromebook's own disk;
  5. when every track is done, copies the album to
     <music folder>/<Album artist>/<Album>/NN Title.flac, checks the copy,
     and removes the staging folder;
  6. if a backup command is set ("backup_command" in the config file, or
     --backup), runs it on the new album folder.

The music folder is $PLATTER_MUSIC_DIR, or --dest.

Run it through uv, which installs the dependencies listed in pyproject.toml
next to this file:  uv run --project scripts/rip scripts/rip/platter_rip.py
(or: npm run rip). See README.md ("Ripping CDs").
"""

import argparse
import base64
import ctypes
import fcntl
import glob
import hashlib
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import mutagen.flac
import numpy as np
import soundfile

SECTOR = 2352                 # bytes of audio per CD sector
SAMPLES_PER_SECTOR = 588      # stereo 16-bit samples per sector
CHUNK = 26                    # sectors per READ CD (61 KB, under the 64 KB limit)
CHUNK_ATTEMPTS = 3            # tries per chunk before going sector by sector
REREAD_ROUNDS = 10            # most rounds of re-reading chunks that differ
MIN_TRACK_BUDGET = 120        # seconds; a track may take max(this, its length) × --patience
# MusicBrainz wants "Application/version ( contact-url )" so it can reach the maintainers
# (https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting). Same name as GNUDB_CLIENT.
USER_AGENT = 'PlatterCDRipper/1.0.0 ( https://github.com/stisti/platter )'
MUSIC_DIR_ENV = 'PLATTER_MUSIC_DIR'
STAGING_ROOT = os.path.join(os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache'),
                            'platter-rip')
CONFIG_PATH = os.path.expanduser('~/.config/platter-rip.json')


# --------------------------------------------------------------------------
# SCSI pass-through over /dev/bsg (SG_IO v4)

class SgIoV4(ctypes.Structure):
    """struct sg_io_v4 from <linux/bsg.h>."""
    _fields_ = [
        ('guard', ctypes.c_int32), ('protocol', ctypes.c_uint32),
        ('subprotocol', ctypes.c_uint32), ('request_len', ctypes.c_uint32),
        ('request', ctypes.c_uint64), ('request_tag', ctypes.c_uint64),
        ('request_attr', ctypes.c_uint32), ('request_priority', ctypes.c_uint32),
        ('request_extra', ctypes.c_uint32), ('max_response_len', ctypes.c_uint32),
        ('response', ctypes.c_uint64),
        ('dout_iovec_count', ctypes.c_uint32), ('dout_xfer_len', ctypes.c_uint32),
        ('din_iovec_count', ctypes.c_uint32), ('din_xfer_len', ctypes.c_uint32),
        ('dout_xferp', ctypes.c_uint64), ('din_xferp', ctypes.c_uint64),
        ('timeout', ctypes.c_uint32), ('flags', ctypes.c_uint32),
        ('usr_ptr', ctypes.c_uint64), ('spare_in', ctypes.c_uint32),
        ('driver_status', ctypes.c_uint32), ('transport_status', ctypes.c_uint32),
        ('device_status', ctypes.c_uint32), ('retry_delay', ctypes.c_uint32),
        ('info', ctypes.c_uint32), ('duration', ctypes.c_uint32),
        ('response_len', ctypes.c_uint32), ('din_resid', ctypes.c_int32),
        ('dout_resid', ctypes.c_int32), ('generated_tag', ctypes.c_uint64),
        ('spare_out', ctypes.c_uint32), ('padding', ctypes.c_uint32),
    ]


SG_IO = 0x2285


class ScsiError(Exception):
    def __init__(self, what, status=0, sense=b''):
        self.sense_key = self.asc = self.ascq = None
        if len(sense) >= 14 and (sense[0] & 0x7f) in (0x70, 0x71):
            self.sense_key, self.asc, self.ascq = sense[2] & 0x0f, sense[12], sense[13]
        elif len(sense) >= 4 and (sense[0] & 0x7f) in (0x72, 0x73):
            self.sense_key, self.asc, self.ascq = sense[1] & 0x0f, sense[2], sense[3]
        detail = ''
        if self.sense_key is not None:
            detail = f' (sense {self.sense_key:x}/{self.asc:02x}/{self.ascq:02x})'
        super().__init__(f'{what} failed: status {status}{detail}')

    @property
    def no_medium(self):
        return self.asc == 0x3a

    @property
    def becoming_ready(self):
        return self.asc == 0x04 or self.asc == 0x28 or self.asc == 0x29


class Drive:
    def __init__(self, path):
        self.path = path
        self.fd = os.open(path, os.O_RDWR)

    def close(self):
        os.close(self.fd)

    def command(self, cdb, length=0, timeout=60_000):
        cdb_buf = ctypes.create_string_buffer(bytes(cdb), len(cdb))
        sense = ctypes.create_string_buffer(32)
        data = ctypes.create_string_buffer(max(length, 1))
        hdr = SgIoV4(guard=ord('Q'), request_len=len(cdb),
                     request=ctypes.addressof(cdb_buf),
                     max_response_len=len(sense), response=ctypes.addressof(sense),
                     din_xfer_len=length,
                     din_xferp=ctypes.addressof(data) if length else 0,
                     timeout=timeout)
        fcntl.ioctl(self.fd, SG_IO, hdr)
        if hdr.device_status or hdr.transport_status or hdr.driver_status:
            raise ScsiError(f'command {cdb[0]:02x}', hdr.device_status or hdr.transport_status
                            or hdr.driver_status, sense.raw[:hdr.response_len])
        return data.raw[:length - max(hdr.din_resid, 0)]

    def test_unit_ready(self):
        self.command([0x00, 0, 0, 0, 0, 0])

    def wait_ready(self, seconds=30):
        deadline = time.time() + seconds
        while True:
            try:
                self.test_unit_ready()
                return
            except ScsiError as e:
                if e.no_medium:
                    raise SystemExit('There is no disc in the drive.')
                if time.time() > deadline:
                    raise
                time.sleep(1)

    def read_toc(self):
        data = self.command([0x43, 0, 0, 0, 0, 0, 0, 0x03, 0x24, 0], 804)
        return parse_toc(data)

    def set_max_speed(self):
        try:
            self.command([0xbb, 0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0])
        except ScsiError:
            pass  # optional; some drives refuse it

    def read_cd(self, lba, count):
        """`count` raw CD-DA sectors from `lba`, as bytes."""
        cdb = [0xbe, 0x04, *lba.to_bytes(4, 'big'), *count.to_bytes(3, 'big'), 0x10, 0, 0]
        return self.command(cdb, count * SECTOR)

    def eject(self):
        try:
            self.command([0x1b, 0, 0, 0, 0x02, 0])
        except ScsiError:
            pass


def find_drives():
    """[(dev path, 'Vendor Model')] for every CD/DVD drive with a bsg node."""
    drives = []
    for sysdir in sorted(glob.glob('/sys/class/bsg/*')):
        try:
            with open(os.path.join(sysdir, 'device', 'type')) as f:
                if f.read().strip() != '5':   # 5 = CD/DVD
                    continue
            vendor = open(os.path.join(sysdir, 'device', 'vendor')).read().strip()
            model = open(os.path.join(sysdir, 'device', 'model')).read().strip()
        except OSError:
            continue
        drives.append(('/dev/bsg/' + os.path.basename(sysdir), f'{vendor} {model}'))
    return drives


def open_drive(path):
    if not os.access(path, os.R_OK | os.W_OK):
        user = os.environ.get('USER') or str(os.getuid())
        print(f'Giving {user} access to {path} (sudo chown)...')
        subprocess.run(['sudo', 'chown', user, path], check=True)
    return Drive(path)


# --------------------------------------------------------------------------
# Table of contents and disc IDs

class Toc:
    """Audio tracks of a disc: numbers, start LBAs and the audio lead-out."""

    def __init__(self, tracks, leadout, data_tracks=(), preemphasis=()):
        self.tracks = tracks              # [(number, start lba)], audio only
        self.leadout = leadout            # lba where the audio ends
        self.data_tracks = list(data_tracks)
        self.preemphasis = list(preemphasis)

    @property
    def first(self):
        return self.tracks[0][0]

    @property
    def last(self):
        return self.tracks[-1][0]

    def span(self, i):
        """(start, end) LBA of the i-th audio track; gaps go to the track before."""
        start = self.tracks[i][1]
        end = self.tracks[i + 1][1] if i + 1 < len(self.tracks) else self.leadout
        return start, end

    def musicbrainz_id(self):
        h = hashlib.sha1()
        h.update(b'%02X%02X%08X' % (self.first, self.last, self.leadout + 150))
        offsets = dict(self.tracks)
        for n in range(1, 100):
            h.update(b'%08X' % (offsets[n] + 150 if n in offsets else 0))
        return base64.b64encode(h.digest(), b'._').decode().replace('=', '-')

    def musicbrainz_toc(self):
        return ' '.join(str(x) for x in
                        [self.first, self.last, self.leadout + 150]
                        + [lba + 150 for _, lba in self.tracks])

    def musicbrainz_submit_url(self):
        """Page where a MusicBrainz user attaches this disc ID to a release (or adds one)."""
        return ('https://musicbrainz.org/cdtoc/attach?'
                + urllib.parse.urlencode({'id': self.musicbrainz_id(), 'tracks': len(self.tracks),
                                          'toc': self.musicbrainz_toc()}))

    def cddb_id(self):
        def digit_sum(n):
            return sum(int(c) for c in str(n))
        n = sum(digit_sum((lba + 150) // 75) for _, lba in self.tracks)
        total = (self.leadout + 150) // 75 - (self.tracks[0][1] + 150) // 75
        return ((n % 0xff) << 24) | (total << 8) | len(self.tracks)

    def accuraterip_ids(self):
        id1 = id2 = 0
        for i, (_, lba) in enumerate(self.tracks, 1):
            id1 += lba
            id2 += max(lba, 1) * i
        id1 += self.leadout
        id2 += self.leadout * (len(self.tracks) + 1)
        return id1 & 0xffffffff, id2 & 0xffffffff, self.cddb_id()

    def accuraterip_url(self):
        id1, id2, cddb = self.accuraterip_ids()
        return ('http://www.accuraterip.com/accuraterip/'
                f'{id1 & 0xf:x}/{id1 >> 4 & 0xf:x}/{id1 >> 8 & 0xf:x}/'
                f'dBAR-{len(self.tracks):03d}-{id1:08x}-{id2:08x}-{cddb:08x}.bin')


def parse_toc(data):
    """READ TOC format 0 (LBA addresses) -> Toc."""
    entries = []
    for off in range(4, len(data) - 7, 8):
        control = data[off + 1] & 0x0f
        number = data[off + 2]
        lba = struct.unpack('>i', data[off + 4:off + 8])[0]
        entries.append((number, control, lba))
    leadout = next(lba for n, _, lba in entries if n == 0xaa)
    tracks = [(n, lba) for n, c, lba in entries if n != 0xaa and not c & 0x04]
    data_tracks = [(n, lba) for n, c, lba in entries if n != 0xaa and c & 0x04]
    preemphasis = [n for n, c, _ in entries if n != 0xaa and not c & 0x04 and c & 0x01]
    if not tracks:
        raise SystemExit('This disc has no audio tracks.')
    # Enhanced CD (CD Extra): the data session sits after the audio, with
    # 11400 sectors of lead-out/lead-in between them.
    after = [lba for n, lba in data_tracks if lba > tracks[-1][1]]
    if after:
        leadout = min(after) - 11400
    return Toc(tracks, leadout, data_tracks, preemphasis)


# --------------------------------------------------------------------------
# AccurateRip

def accuraterip_checksums(pcm, first, last):
    """(v1, v2) AccurateRip CRCs of one track's PCM (bytes or uint32 array)."""
    samples = np.frombuffer(pcm, dtype='<u4') if not isinstance(pcm, np.ndarray) else pcm
    n = len(samples)
    lo = 5 * SAMPLES_PER_SECTOR if first else 1         # multipliers, 1-based, inclusive
    hi = n - 5 * SAMPLES_PER_SECTOR if last else n
    if hi < lo:
        return 0, 0
    mult = np.arange(lo, hi + 1, dtype=np.uint64)
    products = samples[lo - 1:hi].astype(np.uint64) * mult
    v1 = int(np.sum(products & 0xffffffff, dtype=np.uint64)) & 0xffffffff
    v2 = (v1 + int(np.sum(products >> 32, dtype=np.uint64))) & 0xffffffff
    return v1, v2


def parse_accuraterip(data):
    """dBAR file -> list of pressings, each a list of (confidence, crc) per track."""
    pressings, off = [], 0
    while off + 13 <= len(data):
        count = data[off]
        off += 13
        tracks = []
        for _ in range(count):
            conf, crc, _crc450 = struct.unpack_from('<BII', data, off)
            tracks.append((conf, crc))
            off += 9
        pressings.append(tracks)
    return pressings


def fetch_accuraterip(toc):
    try:
        data = http_get(toc.accuraterip_url())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    pressings = parse_accuraterip(data)
    return [p for p in pressings if len(p) == len(toc.tracks)]


def accuraterip_match(pressings, index, crcs):
    """Highest confidence among pressings whose CRC for this track matches."""
    best = 0
    for p in pressings:
        conf, crc = p[index]
        if crc and crc in crcs:
            best = max(best, conf)
    return best


def find_offset_candidates(raw, base, length, wanted, search):
    """Read offsets in [-search, search] for which a middle track's v1 CRC is in `wanted`.

    `raw` holds samples starting `base` samples before the track's first
    sample. For offset k the track is raw[base + k : base + k + length], and
      sum (i+1)·raw[base+k+i] = Σ_j (j+1)·raw[j] − (base+k)·Σ_j raw[j]
    over the window, so every offset costs O(1) with prefix sums (all mod 2^64,
    which keeps the low 32 bits exact).
    """
    x = raw.astype(np.uint64)
    j1 = np.arange(1, len(x) + 1, dtype=np.uint64)
    p0 = np.concatenate((np.zeros(1, np.uint64), np.cumsum(x, dtype=np.uint64)))
    p1 = np.concatenate((np.zeros(1, np.uint64), np.cumsum(x * j1, dtype=np.uint64)))
    found = []
    for k in range(-search, search + 1):
        s = base + k
        if s < 0 or s + length > len(x):
            continue
        a = int(p1[s + length] - p1[s])
        b = int(p0[s + length] - p0[s])
        crc = (a - s * b) & 0xffffffff
        if crc in wanted:
            found.append(k)
    return found


# --------------------------------------------------------------------------
# Reading audio

class Reader:
    """Reads offset-corrected PCM, re-reading where reads disagree.

    Each track gets a time budget (`patience` times its playing time, at least
    MIN_TRACK_BUDGET seconds). A damaged disc can make every chunk come back
    different on every read; once the budget is spent the reader stops
    re-reading, keeps the best reads it has and says it gave up, instead of
    grinding for hours. patience=0 never gives up.
    """

    def __init__(self, drive, toc, offset, patience=1.0, clock=time.monotonic):
        self.drive = drive
        self.toc = toc
        self.offset = offset          # samples, AccurateRip convention
        self.disc_end = toc.leadout   # can't read past the audio lead-out
        self.unreadable = 0
        self.patience = patience
        self.clock = clock
        self.deadline = None          # clock() value after which a track gives up

    def track_budget(self, i):
        """Seconds a track may take, or None for no limit."""
        if not self.patience:
            return None
        start, end = self.toc.span(i)
        return self.patience * max(MIN_TRACK_BUDGET, (end - start) / 75)

    def out_of_time(self):
        return self.deadline is not None and self.clock() > self.deadline

    def _read_chunk(self, lba, count):
        attempts = 1 if self.out_of_time() else CHUNK_ATTEMPTS
        for attempt in range(attempts):
            try:
                return self.drive.read_cd(lba, count)
            except ScsiError:
                if attempt + 1 < attempts:
                    time.sleep(0.5)
        # Sector by sector, so one bad sector costs only itself -- unless the
        # track is out of time, when the whole chunk counts as unreadable.
        out = bytearray()
        for s in range(lba, lba + count):
            if not self.out_of_time():
                try:
                    out += self.drive.read_cd(s, 1)
                    continue
                except ScsiError:
                    pass
            out += bytes(SECTOR)
            self.unreadable += 1
        return bytes(out)

    def raw_sectors(self, first, count, progress=None):
        """Raw sectors [first, first+count) with zeros outside the disc."""
        out = bytearray()
        lead = max(0, -first)
        out += bytes(lead * SECTOR)
        lba, end = max(first, 0), min(first + count, self.disc_end)
        while lba < end:
            n = min(CHUNK, end - lba)
            out += self._read_chunk(lba, n)
            lba += n
            if progress:
                progress(len(out))
        out += bytes((count * SECTOR) - len(out))
        return bytes(out)

    def track_window(self, start, end):
        """Sector range to read and byte offset of the track inside it."""
        s0 = start * SAMPLES_PER_SECTOR + self.offset
        first = s0 // SAMPLES_PER_SECTOR
        skip = (s0 - first * SAMPLES_PER_SECTOR) * 4
        count = end - start + (1 if skip else 0)
        return first, count, skip

    def read_track(self, i, progress=None):
        """First read of track i; also starts the track's time budget."""
        self.unreadable = 0
        budget = self.track_budget(i)
        self.deadline = None if budget is None else self.clock() + budget
        start, end = self.toc.span(i)
        first, count, skip = self.track_window(start, end)
        raw = self.raw_sectors(first, count, progress)
        return raw, (first, count, skip)

    def track_pcm(self, i, raw, window):
        start, end = self.toc.span(i)
        skip = window[2]
        return raw[skip:skip + (end - start) * SECTOR]

    def flush_cache(self, near):
        """Read somewhere far away so the next read comes from the disc, not the cache."""
        far = 0 if near > self.disc_end // 2 else self.disc_end - 2000
        far = max(0, min(far, self.disc_end - 1000))
        for lba in range(far, min(far + 1000, self.disc_end), CHUNK):
            try:
                self.drive.read_cd(lba, min(CHUNK, self.disc_end - lba))
            except ScsiError:
                pass

    def verify_track(self, i, raw, window, log, progress=None):
        """Second read of a track; re-read chunks that differ until two reads agree.

        Re-reading goes in rounds: one cache flush, then every chunk not yet
        settled is read again in disc order. A chunk settles when a read
        repeats one seen before. After REREAD_ROUNDS rounds, or when the
        track's time is up, an unsettled chunk keeps its most frequent read
        (the first read on a tie).

        Returns a Verified.
        """
        first, count, skip = window
        chunk_bytes = CHUNK * SECTOR
        n_chunks = -(-count // CHUNK)
        if self.out_of_time():
            log('    out of time for this track (damaged disc?); not reading it again')
            return Verified(raw, 0, n_chunks, True)
        a = bytearray(raw)
        b = self.raw_sectors(first, count, progress)
        pending = {}                  # byte offset of a chunk -> reads of it seen so far
        for c in range(0, count * SECTOR, chunk_bytes):
            if a[c:c + chunk_bytes] != b[c:c + chunk_bytes]:
                pending[c] = [bytes(a[c:c + chunk_bytes]), bytes(b[c:c + chunk_bytes])]
        differing = len(pending)
        if differing:
            log(f'    {differing} of {n_chunks} chunk(s) differed between reads; re-reading them')
        for round_ in range(1, REREAD_ROUNDS + 1):
            if not pending or self.out_of_time():
                break
            self.flush_cache(first + (min(pending) + max(pending)) // 2 // SECTOR)
            for c in sorted(pending):
                if self.out_of_time():
                    break
                again = self.raw_sectors(first + c // SECTOR, min(CHUNK, count - c // SECTOR))
                seen = pending[c]
                if again in seen:
                    a[c:c + len(again)] = again
                    del pending[c]
                else:
                    seen.append(again)
            if pending:
                log(f'    round {round_}: {len(pending)} chunk(s) not settled yet')
        gave_up = bool(pending) and self.out_of_time()
        for c, seen in pending.items():
            best = max(seen, key=seen.count)        # max() keeps the first on a tie
            a[c:c + len(best)] = best
        if differing:
            log(f'    {differing} chunk(s) differed between reads'
                + (f', {len(pending)} could not be settled' if pending else ', all settled')
                + (' (out of time)' if gave_up else ''))
        return Verified(bytes(a), differing, len(pending), gave_up)


class Verified:
    """What verify_track found: the raw sectors to use and how sure they are."""

    def __init__(self, raw, differing, uncertain, gave_up):
        self.raw = raw
        self.differing = differing    # chunks whose first two reads differed
        self.uncertain = uncertain    # chunks no two reads agreed on
        self.gave_up = gave_up        # the track ran out of time


# --------------------------------------------------------------------------
# MusicBrainz and cover art

_last_mb_request = 0.0


def http_get(url, accept=None):
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT,
                                               **({'Accept': accept} if accept else {})})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def musicbrainz(path, **params):
    global _last_mb_request
    wait = 1.1 - (time.time() - _last_mb_request)   # MusicBrainz allows 1 request/s
    if wait > 0:
        time.sleep(wait)
    _last_mb_request = time.time()
    params['fmt'] = 'json'
    url = f'https://musicbrainz.org/ws/2/{path}?{urllib.parse.urlencode(params)}'
    return json.loads(http_get(url))


class Unavailable(Exception):
    """A disc database could not be reached, or kept saying it is busy."""


MB_RETRY_WAITS = (5, 15, 30, 60)   # seconds before each retry while MusicBrainz is busy
GNUDB_RETRY_WAITS = (5, 15)
RETRY_AFTER_MAX = 120              # longest Retry-After we honour


def _retrying(name, request, waits, log):
    """request(), retried after each of `waits` seconds while the service is busy or unreachable.

    HTTP 429 and 5xx and network errors are retried (a Retry-After header can
    make the wait longer); any other HTTP error is passed on. Raises
    Unavailable when the waits are used up.
    """
    for attempt in range(len(waits) + 1):
        try:
            return request()
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            problem = f'HTTP {e.code}' + (f' {e.reason}' if e.reason else '')
            try:
                asked = float((e.headers or {}).get('Retry-After') or 0)
            except ValueError:
                asked = 0
        except (urllib.error.URLError, OSError) as e:   # unreachable, timed out
            problem, asked = str(getattr(e, 'reason', None) or e), 0
        if attempt == len(waits):
            raise Unavailable(f'{problem}; tried {attempt + 1} times')
        wait = max(waits[attempt], min(asked, RETRY_AFTER_MAX))
        log(f'{name} is unavailable ({problem}); trying again in {wait:.0f} s...')
        time.sleep(wait)


def lookup_releases(toc, log=print, waits=MB_RETRY_WAITS):
    """MusicBrainz releases with this disc ID, or else releases with similar track timings.

    MusicBrainz answers by TOC when it does not know the disc ID; those
    releases may well be another disc (see has_disc). [] when it knows
    neither; Unavailable when it cannot say.
    """
    def request():
        try:
            return musicbrainz(f'discid/{toc.musicbrainz_id()}', toc=toc.musicbrainz_toc(),
                               inc='artist-credits recordings release-groups labels genres')
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):    # 400: MusicBrainz finds the TOC invalid
                return {}
            raise
    try:
        return _retrying('MusicBrainz', request, waits, log).get('releases', [])
    except urllib.error.HTTPError as e:
        raise Unavailable(f'HTTP {e.code}') from e


# --------------------------------------------------------------------------
# GnuDB (the freedb successor): a second opinion when MusicBrainz cannot answer.
# CDDB protocol over HTTP; its entries have titles, year and genre but no
# cover art or MusicBrainz IDs.
#
# GnuDB wants an email address and a descriptive application name and
# version in every request ("hello=emailname+emailhost+application+version",
# https://gnudb.org/howtognudb.php); short or generic names get blocked, and
# an application not registered with info@gnudb.org may be refused. A refusal
# comes as an error dressed up as a match (see _refused). GnuDB is only asked
# when the user has put their address in the config file as "gnudb_email".

GNUDB_URL = 'https://gnudb.gnudb.org/~cddb/cddb.cgi'
GNUDB_CLIENT = 'PlatterCDRipper v1.0.0'


def gnudb_hello(config):
    """The CDDB hello for the configured email address, or None when there is none."""
    name, at, host = str(config.get('gnudb_email') or '').strip().partition('@')
    if not (at and name and host) or ' ' in name + host:
        return None
    return f'{name} {host} {GNUDB_CLIENT}'


def cddb(cmd, hello):
    """Response lines of one CDDB command (proto 6: UTF-8)."""
    query = urllib.parse.urlencode({'cmd': cmd, 'hello': hello, 'proto': '6'})
    text = http_get(f'{GNUDB_URL}?{query}').decode('utf-8', errors='replace')
    return text.splitlines()


def cddb_query_command(toc):
    offsets = ' '.join(str(lba + 150) for _, lba in toc.tracks)
    return (f'cddb query {toc.cddb_id():08x} {len(toc.tracks)} {offsets} '
            f'{(toc.leadout + 150) // 75}')


def _refused(lines):
    """GnuDB's refusal, if these lines are one, else None.

    GnuDB refuses a request it does not accept, query or read alike, with a
    "match" whose title is an error: "210 Found exact matches ..." followed by
    "data 3509526 500 Unknown application / developer email ...".
    """
    for line in lines[1:]:
        if line.strip() == '.':
            break
        if line.startswith('#') or re.match(r'[A-Z]+\d*=', line):   # xmcd entry lines
            continue
        m = re.match(r'\S+ \S+ ([45]\d\d .*)', line)
        if m:
            return m.group(1).strip()
    return None


def _cddb_match(text):
    cat, discid, title = (text.split(' ', 2) + ['', ''])[:3]
    return cat, discid, title


def parse_cddb_query(lines):
    """`cddb query` response -> ([(category, disc id, title)] exact, [...] inexact)."""
    if not lines:
        raise Unavailable('GnuDB sent an empty answer')
    code = lines[0][:3]
    if code == '200':
        found = [_cddb_match(lines[0][4:])]
    elif code in ('210', '211'):
        found = []
        for line in lines[1:]:
            if line.strip() == '.':
                break
            found.append(_cddb_match(line))
    elif code == '202':
        return [], []
    else:
        raise Unavailable(f'GnuDB answered {lines[0].strip()!r}')
    if refusal := _refused(lines[:1] + [f'{c} {d} {t}' for c, d, t in found]):
        raise Unavailable(f'GnuDB refused: {refusal}')
    return (found, []) if code != '211' else ([], found)


_XMCD_ESCAPES = {'n': '\n', 't': '\t', '\\': '\\'}


def parse_xmcd(lines):
    """`cddb read` response (an xmcd entry) -> {KEY: value}; a repeated key continues its value."""
    if not lines or not lines[0].startswith('210'):
        raise Unavailable(f'GnuDB answered {lines[0] if lines else "nothing"!r}')
    if refusal := _refused(lines):
        raise Unavailable(f'GnuDB refused: {refusal}')
    entry = {}
    for line in lines[1:]:
        if line.strip() == '.':
            break
        if line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        entry[key] = entry.get(key, '') + value
    if 'DTITLE' not in entry:
        raise Unavailable(f'GnuDB sent no disc entry: {lines[0].strip()!r}')
    unescape = lambda v: re.sub(r'\\([nt\\])', lambda m: _XMCD_ESCAPES[m.group(1)], v)  # noqa: E731
    return {k: unescape(v) for k, v in entry.items()}


def _split_artist(text):
    artist, sep, title = text.partition(' / ')
    return (artist.strip(), title.strip()) if sep else ('', text.strip())


def xmcd_release(entry, cat, discid, toc):
    """A GnuDB entry in the shape of a MusicBrainz release, for release_metadata()."""
    artist, title = _split_artist(entry.get('DTITLE', ''))
    artist = artist or title
    various = artist.lower() in ('various', 'various artists', 'va')
    tracks = []
    for i in range(len(toc.tracks)):
        text = entry.get(f'TTITLE{i}', '').strip()
        # "Artist / Title" only on a various-artists disc; elsewhere ' / ' is part of the title
        t_artist, t_title = _split_artist(text) if various else ('', text)
        tracks.append({'title': t_title,
                       **({'artist-credit': [{'name': t_artist}]} if t_artist else {})})
    year = entry.get('DYEAR', '').strip()
    genre = entry.get('DGENRE', '').strip()
    return {
        'id': f'gnudb:{cat}/{discid}', 'source': 'GnuDB', 'title': title,
        'artist-credit': [{'name': artist}],
        **({'date': year} if year.isdigit() else {}),
        **({'genres': [{'name': genre, 'count': 1}]} if genre else {}),
        'media': [{'position': 1, 'track-count': len(toc.tracks), 'tracks': tracks}],
    }


def lookup_gnudb(toc, log=print, waits=GNUDB_RETRY_WAITS, hello=None):
    """GnuDB entries that exactly match this disc, as MusicBrainz-shaped releases.

    Inexact (fuzzy) matches are only mentioned: they may be another disc.
    Raises Unavailable when GnuDB cannot say, or `hello` is None (no email set).
    """
    if hello is None:
        raise Unavailable(f'not set up: it needs your email address, as "gnudb_email" in '
                          f'{CONFIG_PATH}')
    try:
        exact, inexact = parse_cddb_query(
            _retrying('GnuDB', lambda: cddb(cddb_query_command(toc), hello), waits, log))
        if inexact and not exact:
            log('GnuDB has only similar discs, not this one: '
                + '; '.join(title for _, _, title in inexact[:5]))
        releases = []
        for cat, discid, _ in exact:
            entry = parse_xmcd(
                _retrying('GnuDB', lambda: cddb(f'cddb read {cat} {discid}', hello), waits, log))
            releases.append(xmcd_release(entry, cat, discid, toc))
        return releases
    except urllib.error.HTTPError as e:
        raise Unavailable(f'HTTP {e.code}') from e


def has_disc(release, toc):
    """Whether this disc's MusicBrainz ID is attached to one of the release's discs."""
    return any(d.get('id') == toc.musicbrainz_id()
               for m in release.get('media', []) for d in m.get('discs', []))


def find_releases(toc, log, unknown_ok=False, mb=lookup_releases, gnudb=lookup_gnudb):
    """Releases this disc may be, from MusicBrainz or else GnuDB.

    MusicBrainz releases that only have similar track timings (not this
    disc's ID) come last, marked 'similar': they are never used unless
    chosen (pick_release). [] means the databases answered and none knows
    the disc (it is ripped as "Track N"). When MusicBrainz cannot answer and
    GnuDB does not know the disc either, this stops before anything is
    ripped -- unless `unknown_ok` (the user gave --artist and --album).
    """
    try:
        releases, mb_problem = mb(toc, log), None
    except Unavailable as e:
        releases, mb_problem = [], str(e)
        log(f'MusicBrainz is unavailable ({e}).')
    similar = [dict(r, similar=True) for r in releases if not has_disc(r, toc)]
    if len(similar) < len(releases):
        return releases
    if similar:
        log(f'MusicBrainz does not know this disc; {len(similar)} release(s) have similar '
            'track timings but may be another disc. Asking GnuDB...')
    else:
        log('Asking GnuDB instead...' if mb_problem else
            'MusicBrainz does not know this disc; asking GnuDB...')
    try:
        releases, gnudb_problem = gnudb(toc, log), None
    except Unavailable as e:
        releases, gnudb_problem = [], str(e)
        log(f'GnuDB is unavailable ({e}).')
    if releases:
        if mb_problem:
            log('Using GnuDB, so no cover art and no MusicBrainz IDs. '
                'Rip again when MusicBrainz is back to get those.')
        return releases + similar
    if mb_problem and not unknown_ok:
        raise SystemExit(
            'Not ripping: MusicBrainz is unavailable and GnuDB '
            + ('is unavailable too' if gnudb_problem else 'does not know this disc')
            + ', so the album would be "Unknown". Try again in a while, or give --artist '
              'and --album to rip it with numbered tracks anyway.')
    if not gnudb_problem:
        log('GnuDB does not know this disc either.')
    return similar


def pick_release(releases, pick=None, own_tags=False):
    """The release to tag the rip from: `pick` (--release: list number or ID), else the first
    that is known to be this disc. None when every one only has similar timings, or when the
    user gave their own tags (--artist/--album), which always win."""
    if own_tags:
        return None
    if pick:
        release = (releases[int(pick) - 1] if pick.isdigit() and 0 < int(pick) <= len(releases)
                   else next((r for r in releases if r['id'] == pick), None))
        if release is None:
            raise SystemExit(f'--release {pick} is not one of the releases listed.')
        return release
    return next((r for r in releases if not r.get('similar')), None)


def credit_name(credits):
    return ''.join(c.get('name', c.get('artist', {}).get('name', '')) + c.get('joinphrase', '')
                   for c in credits or [])


class MediumChoice:
    """Which medium (disc) of a release this CD is, and how sure we are."""

    def __init__(self, medium, guessed=False):
        self.medium = medium
        self.guessed = guessed      # several discs fit equally well; picked the first


def find_medium(release, toc, disc=None):
    """The medium of `release` that is this disc.

    `disc` (1-based position, from --disc) wins. Otherwise the medium carrying
    this disc's MusicBrainz ID, otherwise the first one with the same number of
    tracks -- a guess when several have that many.
    """
    media = release.get('media', [])
    if disc is not None:
        for m in media:
            if m.get('position') == disc:
                return MediumChoice(m)
        raise SystemExit(f'--disc {disc}: this release has {len(media)} disc(s).')
    discid = toc.musicbrainz_id()
    for m in media:
        if any(d.get('id') == discid for d in m.get('discs', [])):
            return MediumChoice(m)
    same = [m for m in media if m.get('track-count') == len(toc.tracks)]
    if same:
        return MediumChoice(same[0], guessed=len(same) > 1)
    return MediumChoice(media[0] if media else None, guessed=len(media) > 1)


def describe_release(r):
    bits = [credit_name(r.get('artist-credit')), '–', r.get('title', '?')]
    extra = [x for x in (r.get('date'), r.get('country'),
                         ', '.join(li.get('label', {}).get('name', '') for li in r.get('label-info', [])
                                   if li.get('label'))) if x]
    return ' '.join(bits) + (f' ({"; ".join(extra)})' if extra else '')


def release_metadata(release, toc, disc=None):
    """Album tags and per-track tags from a MusicBrainz release."""
    choice = find_medium(release, toc, disc)
    medium = choice.medium
    from_mb = release.get('source', 'MusicBrainz') == 'MusicBrainz'
    group = release.get('release-group', {})
    genres = sorted(release.get('genres') or group.get('genres') or [],
                    key=lambda g: -g.get('count', 0))
    labels = release.get('label-info', [])
    album = {
        'ALBUM': release.get('title', ''),
        'ALBUMARTIST': credit_name(release.get('artist-credit')),
        'DATE': release.get('date', ''),
        'ORIGINALDATE': group.get('first-release-date', ''),
        'GENRE': genres[0]['name'].title() if genres else '',
        'LABEL': labels[0].get('label', {}).get('name', '') if labels and labels[0].get('label') else '',
        'CATALOGNUMBER': labels[0].get('catalog-number', '') if labels else '',
        'BARCODE': release.get('barcode') or '',
        'MUSICBRAINZ_ALBUMID': release.get('id', '') if from_mb else '',
        'MUSICBRAINZ_RELEASEGROUPID': group.get('id', ''),
    }
    disc_total = len(release.get('media', []))
    if disc_total > 1 and medium:
        album['DISCNUMBER'] = str(medium.get('position', 1))
        album['DISCTOTAL'] = str(disc_total)
    mb_tracks = (medium or {}).get('tracks', [])
    tracks = []
    for i, (number, _) in enumerate(toc.tracks):
        t = mb_tracks[i] if i < len(mb_tracks) else {}
        rec = t.get('recording', {})
        tracks.append({
            'TITLE': t.get('title') or rec.get('title') or f'Track {number}',
            'ARTIST': credit_name(t.get('artist-credit') or rec.get('artist-credit'))
                      or album['ALBUMARTIST'],
            'TRACKNUMBER': str(i + 1),
            'TRACKTOTAL': str(len(toc.tracks)),
            'MUSICBRAINZ_TRACKID': rec.get('id', ''),
            'MUSICBRAINZ_RELEASETRACKID': t.get('id', ''),
        })
    return album, tracks


def fallback_metadata(toc, artist, album_title, disc=None):
    album = {'ALBUM': album_title or f'Unknown Album ({toc.musicbrainz_id()})',
             'ALBUMARTIST': artist or 'Unknown Artist'}
    if disc is not None:
        album['DISCNUMBER'] = str(disc)
    tracks = [{'TITLE': f'Track {i + 1}', 'ARTIST': album['ALBUMARTIST'],
               'TRACKNUMBER': str(i + 1), 'TRACKTOTAL': str(len(toc.tracks))}
              for i in range(len(toc.tracks))]
    return album, tracks


def fetch_cover(release_id):
    for size in ('front-1200', 'front-500', 'front'):
        try:
            return http_get(f'https://coverartarchive.org/release/{release_id}/{size}')
        except urllib.error.HTTPError as e:
            if e.code != 404:
                return None
        except urllib.error.URLError:
            return None
    return None


# --------------------------------------------------------------------------
# Files

_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_name(name, limit=120):
    """A file/folder name that FAT/exFAT/NTFS and ChromeOS all accept."""
    name = _UNSAFE.sub('_', name).strip()
    name = name.rstrip('. ') or '_'
    if len(name.encode()) > limit:
        name = name.encode()[:limit].decode(errors='ignore').rstrip('. ') or '_'
    return name


def track_filename(album, track):
    num = int(track['TRACKNUMBER'])
    prefix = f'{album["DISCNUMBER"]}-{num:02d}' if 'DISCNUMBER' in album else f'{num:02d}'
    return safe_name(f'{prefix} {track["TITLE"]}', limit=180) + '.flac'


def album_folder(dest, album):
    return os.path.join(dest, safe_name(album['ALBUMARTIST']), safe_name(album['ALBUM']))


def encode_flac(pcm, tags, path):
    """Write CD audio as tagged FLAC, and check that it decodes back to exactly `pcm`."""
    samples = np.frombuffer(pcm, dtype='<i2').reshape(-1, 2)
    soundfile.write(path, samples, 44100, format='FLAC', subtype='PCM_16',
                    compression_level=1.0)          # = flac -8
    flac = mutagen.flac.FLAC(path)
    flac.clear()                                     # drop libsndfile's own comments
    for k, v in tags.items():
        if v:
            flac[k] = v
    flac.save()
    back, _ = soundfile.read(path, dtype='int16', always_2d=True)
    if not np.array_equal(back, samples):
        raise RuntimeError(f'{path} does not decode back to the ripped audio')


def staging_folder(toc):
    """Where a disc is ripped before it goes to the music folder (on the Chromebook's disk)."""
    return os.path.join(STAGING_ROOT, toc.musicbrainz_id())


def _digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.digest()


def install_album(staging, folder):
    """Copy a finished album from `staging` into `folder`, verified, then delete `staging`.

    A new album appears all at once: it is copied into a hidden folder next to
    it (Platter skips names starting with '.') that is renamed into place at
    the end. If the album folder already exists, the files are added to it,
    each under a hidden name until its copy is verified. Never overwrites.
    """
    names = sorted(os.listdir(staging))
    exists = os.path.isdir(folder)
    if exists:
        clash = [n for n in names if os.path.exists(os.path.join(folder, n))]
        if clash:
            raise SystemExit(f'{folder} already has {clash[0]}; not overwriting. '
                             f'The rip is kept in {staging}.')
        target = folder
    else:
        parent, base = os.path.split(folder)
        os.makedirs(parent, exist_ok=True)
        target = os.path.join(parent, f'.{base}.platter-rip')
        shutil.rmtree(target, ignore_errors=True)    # left by an interrupted copy
        os.makedirs(target)
    for name in names:
        src = os.path.join(staging, name)
        tmp = os.path.join(target, f'.{name}.part')
        shutil.copyfile(src, tmp)
        if _digest(tmp) != _digest(src):
            os.remove(tmp)
            raise SystemExit(f'Copying {name} to {target} came out different; is the drive OK? '
                             f'The rip is kept in {staging}.')
        os.replace(tmp, os.path.join(target, name))
    if not exists:
        os.rename(target, folder)
    shutil.rmtree(staging)


# --------------------------------------------------------------------------
# Backup of the new album

BACKUP_PLACEHOLDER = re.compile(r'%[%sr]')


def chosen_backup(config, override=None, off=False):
    """The backup command to run after a rip: --backup, else the config's, else None."""
    if off:
        return None
    return override or str(config.get('backup_command') or '').strip() or None


def backup_argv(command, folder, dest):
    """The backup command as a list of arguments, for `folder` in the music folder `dest`.

    The command is split into words the way a shell would (quotes work), but
    not run by a shell. In each word %s becomes the album folder, %r the album
    folder relative to the music folder ("Artist/Album") and %% a single %.
    """
    try:
        words = shlex.split(command)
    except ValueError as e:
        raise SystemExit(f'Cannot read the backup command ({e}): {command}')
    if not words:
        raise SystemExit('The backup command is empty.')
    values = {'%s': folder, '%r': os.path.relpath(folder, dest), '%%': '%'}
    return [BACKUP_PLACEHOLDER.sub(lambda m: values[m.group()], w) for w in words]


def run_backup(argv, log):
    """Run the backup command, its output shown as it goes. True when it succeeded."""
    log(f'Backing up: {shlex.join(argv)}')
    try:
        code = subprocess.run(argv).returncode
        why = f'exit status {code}'
    except OSError as e:
        code, why = None, str(e)
    if code == 0:
        log('Backup done.')
        return True
    log(f'Backup FAILED ({why}). The album is in the music folder all the same; '
        f'back it up later with:  {shlex.join(argv)}')
    return False


# --------------------------------------------------------------------------
# Main

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(config):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)


def fmt_time(sectors):
    s = sectors // 75
    return f'{s // 60}:{s % 60:02d}'


def detect_offset(reader, toc, pressings, log, search=1500):
    """Find the drive's read offset by matching a middle track against AccurateRip."""
    if len(toc.tracks) < 3 or not pressings:
        return None
    # The shortest middle track keeps the read small.
    i = min(range(1, len(toc.tracks) - 1), key=lambda k: toc.span(k)[1] - toc.span(k)[0])
    wanted = {p[i][1] for p in pressings if p[i][1]}
    start, end = toc.span(i)
    margin = search // SAMPLES_PER_SECTOR + 2
    log(f'Finding the drive\'s read offset with track {toc.tracks[i][0]} '
        f'(within ±{search} samples)...')
    raw_bytes = reader.raw_sectors(start - margin, end - start + 2 * margin)
    raw = np.frombuffer(raw_bytes, dtype='<u4')
    length = (end - start) * SAMPLES_PER_SECTOR
    base = margin * SAMPLES_PER_SECTOR
    found = find_offset_candidates(raw, base, length, wanted, search)
    # Other pressings of the same album are cut a little shifted, so they
    # match at other offsets too. The drive's own offset is the one where the
    # most rippers agree (summed confidence over v1 and v2 checksums).
    best, best_conf = None, 0
    for k in found:
        crcs = accuraterip_checksums(raw[base + k:base + k + length], False, False)
        conf = sum(p[i][0] for p in pressings if p[i][1] in crcs)
        if conf > best_conf:
            best, best_conf = k, conf
    return best


def main(argv=None):
    ap = argparse.ArgumentParser(description='Rip an audio CD to FLAC for Platter.')
    ap.add_argument('--dest', default=os.environ.get(MUSIC_DIR_ENV),
                    help=f'music folder to rip into (default: ${MUSIC_DIR_ENV})')
    ap.add_argument('--device', help='drive node, e.g. /dev/bsg/1:0:0:0 (default: the first CD drive)')
    ap.add_argument('--offset', type=int, help='drive read offset in samples (default: detect)')
    ap.add_argument('--find-offset', action='store_true',
                    help='detect the drive read offset with this disc and remember it')
    ap.add_argument('--release', help='which MusicBrainz release to use: number from the list, or its ID')
    ap.add_argument('--disc', type=int, metavar='N',
                    help='which disc of a multi-disc release this is (default: work it out)')
    ap.add_argument('--artist', help='album artist: tag the rip with this and --album, numbered '
                                     'tracks, instead of what the databases say (with --album, '
                                     'also rips when MusicBrainz is down)')
    ap.add_argument('--album', help='album title (see --artist)')
    ap.add_argument('--info', action='store_true', help='look the disc up and stop (no ripping)')
    ap.add_argument('--no-eject', action='store_true', help='leave the disc in when done')
    ap.add_argument('--patience', type=float, default=1.0, metavar='X',
                    help='how long to keep re-reading a damaged track: X times its playing time '
                         f'(at least {MIN_TRACK_BUDGET // 60} min × X); 0 = never give up (default: 1)')
    backup_opts = ap.add_mutually_exclusive_group()
    backup_opts.add_argument('--backup', metavar='CMD',
                             help='back the new album up with CMD after copying it to the music '
                                  'folder (%%s = album folder, %%r = it relative to the music '
                                  'folder); default: "backup_command" in ' + CONFIG_PATH)
    backup_opts.add_argument('--no-backup', action='store_true',
                             help='do not run the backup command this time')
    args = ap.parse_args(argv)
    own_tags = bool(args.artist or args.album)
    if own_tags and args.release:
        raise SystemExit('Give either --release (tags from that release) or --artist/--album '
                         '(your own tags), not both.')
    config = load_config()
    backup = chosen_backup(config, args.backup, args.no_backup)

    def log(msg=''):
        print(msg, flush=True)

    drives = find_drives()
    if args.device:
        path, model = args.device, dict(drives).get(args.device, 'unknown drive')
    elif drives:
        path, model = drives[0]
    else:
        raise SystemExit('No CD drive found. Plug it in, then in ChromeOS: Settings → About ChromeOS → '
                         'Developers → Linux development environment → Manage USB devices → '
                         'switch the drive on.')
    drive = open_drive(path)
    drive.wait_ready()
    drive.set_max_speed()
    toc = drive.read_toc()
    log(f'Drive: {model} ({path})')
    log(f'Disc: {len(toc.tracks)} audio tracks, {fmt_time(toc.leadout - toc.tracks[0][1])}'
        + (f', plus {len(toc.data_tracks)} data track(s)' if toc.data_tracks else ''))
    log(f'MusicBrainz disc ID: {toc.musicbrainz_id()}')
    if toc.preemphasis:
        log(f'Note: track(s) {toc.preemphasis} use pre-emphasis; they are ripped as is.')

    # ---- lookups
    try:
        pressings = fetch_accuraterip(toc)
    except (urllib.error.URLError, OSError) as e:
        log(f'AccurateRip lookup failed ({e}); tracks will be verified by reading twice.')
        pressings = []
    log(f'AccurateRip: {len(pressings)} pressing(s) of this disc in the database'
        if pressings else 'AccurateRip: this disc is not in the database')

    hello = gnudb_hello(config)
    releases = find_releases(toc, log, unknown_ok=bool(args.artist and args.album),
                             gnudb=lambda toc, log: lookup_gnudb(toc, log, hello=hello))
    release = None
    if not any(r.get('source', 'MusicBrainz') == 'MusicBrainz' and not r.get('similar')
               for r in releases):
        log(f'Add this disc to MusicBrainz, or attach it to its release there: '
            f'{toc.musicbrainz_submit_url()}')
    if releases:
        log(f'{releases[0].get("source", "MusicBrainz")}:')
        for n, r in enumerate(releases, 1):
            log(f'  {n}. {describe_release(r)}  [{r["id"]}]'
                + ('  (MusicBrainz: similar timings only)' if r.get('similar') else ''))
        release = pick_release(releases, args.release, own_tags)
        if own_tags:
            log('Not using these: tagging with --artist/--album instead.')
        elif release is None:
            msg = ('Not ripping: MusicBrainz does not know this disc, and the releases above '
                   'only have similar track timings, so they may be another album. Check them '
                   '(for example by their track lengths on musicbrainz.org) and rip with '
                   '--release N if one is right, or give --artist and --album to rip with '
                   'numbered tracks.')
            if not args.info:
                raise SystemExit(msg)
            log(msg)
            return 0
        if release and len(releases) > 1:
            log(f'Using {releases.index(release) + 1}' +
                ('' if args.release else ' (choose another with --release N)'))

    if release:
        choice = find_medium(release, toc, args.disc)
        if choice.guessed:
            log(f'Note: this release has several discs with {len(toc.tracks)} tracks and MusicBrainz '
                f'cannot tell which one this is; assuming disc {choice.medium.get("position", 1)}. '
                'Use --disc N if that is wrong.')
        album, tracks = release_metadata(release, toc, args.disc)
    else:
        album, tracks = fallback_metadata(toc, args.artist, args.album, args.disc)
    folder = album_folder(args.dest, album) if args.dest else None
    log(f'Album: {album["ALBUMARTIST"]} – {album["ALBUM"]}')
    for t in tracks:
        log(f'  {int(t["TRACKNUMBER"]):2d}. {t["TITLE"]}'
            + (f'  ({t["ARTIST"]})' if t['ARTIST'] != album['ALBUMARTIST'] else ''))
    log(f'Into: {folder}' if folder else
        f'Into: (no music folder: set {MUSIC_DIR_ENV} or use --dest)')
    backup_cmd = backup_argv(backup, folder, args.dest) if backup and folder else None
    if backup_cmd:
        log(f'Then backed up with: {shlex.join(backup_cmd)}')

    # ---- read offset
    offsets = config.setdefault('offsets', {})
    reader = Reader(drive, toc, 0, patience=args.patience)
    offset = args.offset
    if offset is None and (args.find_offset or model not in offsets):
        found = detect_offset(reader, toc, pressings, log)
        if found is not None:
            log(f'Read offset of this drive: {found:+d} samples (remembered in {CONFIG_PATH})')
            offsets[model] = found
            save_config(config)
            offset = found
        elif args.find_offset:
            raise SystemExit('Could not find the offset with this disc (it needs a disc with at '
                             'least 3 tracks that AccurateRip knows). Try another disc.')
        else:
            log('Read offset unknown (this disc cannot tell it); ripping with 0. '
                'Run with --find-offset on another disc to set it.')
    if offset is None:
        offset = offsets.get(model, 0)
    reader.offset = offset
    if args.find_offset or args.info:
        log(f'Read offset: {offset:+d}')
        return 0

    # ---- rip
    if not args.dest:
        raise SystemExit(f'Which music folder should the album go to? Pass --dest, or set it once in '
                         f'~/.bashrc:  export {MUSIC_DIR_ENV}=/mnt/shared/removable/<drive>/Music')
    if not os.path.isdir(args.dest):
        raise SystemExit(f'{args.dest} does not exist. Is the music drive shared with Linux? '
                         '(Files app → right-click the drive → Share with Linux)')
    if backup_cmd and not shutil.which(backup_cmd[0]):
        raise SystemExit(f'The backup command {backup_cmd[0]} is not installed (or not on PATH). '
                         f'Install it, change "backup_command" in {CONFIG_PATH}, or rip with '
                         '--no-backup.')
    names = [track_filename(album, t) for t in tracks]
    clash = [n for n in names if os.path.exists(os.path.join(folder, n))]
    if clash:
        raise SystemExit(f'{folder} already has {clash[0]}; not overwriting. '
                         'Move it away first, or pick another release.')
    staging = staging_folder(toc)
    shutil.rmtree(staging, ignore_errors=True)       # an earlier, interrupted rip
    os.makedirs(staging)
    log(f'Ripping into {staging}; the album goes to the music folder when every track is done.')
    has_cover = any(os.path.exists(os.path.join(folder, n))
                    for n in ('cover.jpg', 'folder.jpg', 'Folder.jpg'))
    if release and release.get('source', 'MusicBrainz') == 'MusicBrainz' and not has_cover:
        cover = fetch_cover(release['id'])
        if cover:
            with open(os.path.join(staging, 'cover.jpg'), 'wb') as f:
                f.write(cover)
            log('Cover: cover.jpg')
        else:
            log('Cover: none in the Cover Art Archive')

    log(f'Ripping with read offset {offset:+d}...')
    summary = []
    t0 = time.time()
    n_tracks = len(toc.tracks)
    for i, tags in enumerate(tracks):
        start, end = toc.span(i)
        total = (end - start) * SECTOR
        label = f'  Track {i + 1:2d}/{n_tracks}'
        t_start = time.time()

        def progress_from(t0, label=label, total=total):
            def progress(done):
                speed = done / max(time.time() - t0, 1e-6) / 176400
                print(f'\r{label}: {min(done, total) * 100 // total:3d}%  {speed:4.1f}×',
                      end='', flush=True)
            return progress

        raw, window = reader.read_track(i, progress_from(t_start))
        pcm = reader.track_pcm(i, raw, window)
        print('\r' + ' ' * 40 + '\r', end='')
        crcs = accuraterip_checksums(pcm, i == 0, i == n_tracks - 1)
        conf = accuraterip_match(pressings, i, crcs)
        if conf:
            status = f'accurate (AccurateRip confidence {conf})'
        else:
            log(f'{label}: ' + ('not matched in AccurateRip' if pressings else 'no AccurateRip data')
                + ', reading it again to compare...')
            v = reader.verify_track(i, raw, window, log, progress_from(time.time()))
            print('\r' + ' ' * 40 + '\r', end='')
            raw = v.raw
            pcm = reader.track_pcm(i, raw, window)
            crcs = accuraterip_checksums(pcm, i == 0, i == n_tracks - 1)
            conf = accuraterip_match(pressings, i, crcs)
            if conf:
                status = f'accurate after re-reading (AccurateRip confidence {conf})'
            elif v.gave_up:
                status = f'MAY HAVE ERRORS (damaged: gave up re-reading after ' \
                         f'{(time.time() - t_start) / 60:.0f} min; {v.uncertain} unsettled ' \
                         f'chunk(s), {reader.unreadable} unreadable sector(s))'
            elif v.uncertain or reader.unreadable:
                status = f'MAY HAVE ERRORS ({v.uncertain} unsettled chunk(s), ' \
                         f'{reader.unreadable} unreadable sector(s))'
            elif v.differing:
                status = 'reads differed but were settled; not verified by AccurateRip'
            else:
                status = 'two reads identical' + (' (AccurateRip has a different pressing)'
                                                  if pressings else '')
        summary.append(status)
        encode_flac(pcm, {**album, **tags}, os.path.join(staging, names[i]))
        log(f'{label}: {names[i]} — {status}')

    if not args.no_eject:
        drive.eject()                                # the next disc can go in while we copy
    drive.close()
    log('Copying the album to the music folder...')
    install_album(staging, folder)
    log(f'Done in {(time.time() - t0) / 60:.1f} min: {folder}')
    bad = [n for n, s in zip(names, summary) if s.startswith('MAY')]
    if bad:
        log('Tracks that may have errors (try cleaning the disc and ripping again): ' + ', '.join(bad))
    log('In Platter, rescan the music folder to see the new album.')
    backed_up = run_backup(backup_cmd, log) if backup_cmd else True
    return 1 if bad or not backed_up else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
