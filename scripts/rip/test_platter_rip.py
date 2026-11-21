"""Tests for platter_rip's pure parts. Run: npm run test:rip"""

import os
import random
import struct
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import platter_rip as pr  # noqa: E402

# READ TOC response of a real disc (Kitaro, Tunhuang), as the drive returned it.
KITARO_TOC = bytes.fromhex(
    '00 52 01 09 00 10 01 00  00 00 00 21 00 10 02 00'
    '00 00 51 5c 00 10 03 00  00 00 94 55 00 10 04 00'
    '00 00 d5 3e 00 10 05 00  00 01 30 ea 00 10 06 00'
    '00 01 88 92 00 10 07 00  00 01 d5 18 00 10 08 00'
    '00 02 30 b9 00 10 09 00  00 02 7f 74 00 10 aa 00'
    '00 02 ef e3')


def reference_checksums(samples, first, last):
    """AccurateRip v1/v2 written out the slow, obvious way."""
    n = len(samples)
    lo = 5 * 588 if first else 1
    hi = n - 5 * 588 if last else n
    v1 = v2 = 0
    for m in range(1, n + 1):
        if lo <= m <= hi:
            p = samples[m - 1] * m
            v1 = (v1 + (p & 0xffffffff)) & 0xffffffff
            v2 = (v2 + (p & 0xffffffff) + (p >> 32)) & 0xffffffff
    return v1, v2


class TocTest(unittest.TestCase):
    def setUp(self):
        self.toc = pr.parse_toc(KITARO_TOC)

    def test_tracks(self):
        self.assertEqual(len(self.toc.tracks), 9)
        self.assertEqual(self.toc.tracks[0], (1, 33))
        self.assertEqual(self.toc.tracks[2], (3, 37973))
        self.assertEqual(self.toc.leadout, 192483)
        self.assertEqual(self.toc.span(8), (163700, 192483))

    def test_musicbrainz_id(self):
        # The ID MusicBrainz knows this disc by.
        self.assertEqual(self.toc.musicbrainz_id(), 'BUa_KzRqd.T8ns2TNwNV_owbDKI-')

    def test_musicbrainz_submit_url(self):
        url = self.toc.musicbrainz_submit_url()
        self.assertTrue(url.startswith('https://musicbrainz.org/cdtoc/attach?'))
        self.assertIn('id=BUa_KzRqd.T8ns2TNwNV_owbDKI-', url)
        self.assertIn('tracks=9', url)
        self.assertIn('toc=1+9+192633+183+', url)    # lead-out and offsets + 150 frames

    def test_accuraterip_url(self):
        # The database file AccurateRip serves for this disc.
        self.assertTrue(self.toc.accuraterip_url().startswith('http://www.accuraterip.com/accuraterip/'))
        self.assertIn('dBAR-009-', self.toc.accuraterip_url())
        id1, id2, cddb = self.toc.accuraterip_ids()
        self.assertEqual(id1, sum(lba for _, lba in self.toc.tracks) + 192483)
        self.assertEqual(cddb & 0xff, 9)

    def test_enhanced_cd(self):
        # Audio tracks 1-2, data track 3 in a second session.
        entries = [(1, 0x10, 0), (2, 0x10, 20000), (3, 0x14, 60000), (0xaa, 0x14, 90000)]
        data = b'\x00\x22\x01\x03' + b''.join(
            bytes([0, c, n, 0]) + struct.pack('>i', lba) for n, c, lba in entries)
        toc = pr.parse_toc(data)
        self.assertEqual(toc.tracks, [(1, 0), (2, 20000)])
        self.assertEqual(toc.leadout, 60000 - 11400)
        self.assertEqual(toc.data_tracks, [(3, 60000)])


class ChecksumTest(unittest.TestCase):
    def test_matches_reference(self):
        rng = random.Random(1)
        samples = [rng.getrandbits(32) for _ in range(588 * 12 + 7)]
        arr = np.array(samples, dtype=np.uint32)
        for first, last in [(False, False), (True, False), (False, True), (True, True)]:
            self.assertEqual(pr.accuraterip_checksums(arr, first, last),
                             reference_checksums(samples, first, last), (first, last))

    def test_offset_search_matches_direct(self):
        rng = np.random.default_rng(2)
        raw = rng.integers(0, 2**32, 588 * 40, dtype=np.uint64).astype(np.uint32)
        base, length = 588 * 5, 588 * 30
        for k in (-700, -6, 0, 6, 1000):
            v1, _ = pr.accuraterip_checksums(raw[base + k:base + k + length], False, False)
            self.assertIn(k, pr.find_offset_candidates(raw, base, length, {v1}, 1500))

    def test_parse_accuraterip(self):
        def pressing(crcs):
            return bytes([len(crcs)]) + b'\0' * 12 + b''.join(
                struct.pack('<BII', 5, c, 0) for c in crcs)
        pressings = pr.parse_accuraterip(pressing([1, 2]) + pressing([3, 4]))
        self.assertEqual(pressings, [[(5, 1), (5, 2)], [(5, 3), (5, 4)]])
        self.assertEqual(pr.accuraterip_match(pressings, 1, (4, 99)), 5)
        self.assertEqual(pr.accuraterip_match(pressings, 0, (2,)), 0)


class FakeDrive:
    """A disc whose sample number n holds the value n + 1."""

    def __init__(self, sectors):
        self.sectors = sectors

    def read_cd(self, lba, count):
        assert 0 <= lba and lba + count <= self.sectors
        first = lba * 588 + 1
        return np.arange(first, first + count * 588, dtype='<u4').tobytes()


class ReaderTest(unittest.TestCase):
    def read(self, offset, track):
        toc = pr.Toc([(1, 0), (2, 100), (3, 250)], 400)
        reader = pr.Reader(FakeDrive(400), toc, offset)
        raw, window = reader.read_track(track)
        return np.frombuffer(reader.track_pcm(track, raw, window), '<u4'), toc

    def test_offset_correction(self):
        for offset in (0, 6, -6, 667, -1164):
            pcm, toc = self.read(offset, 1)
            start, end = toc.span(1)
            expected = np.arange(start * 588 + offset, end * 588 + offset) + 1
            np.testing.assert_array_equal(pcm, expected, err_msg=f'offset {offset}')

    def test_zeros_beyond_the_disc(self):
        pcm, _ = self.read(6, 2)                    # last track, positive offset
        self.assertEqual(len(pcm), 150 * 588)
        self.assertTrue((pcm[-6:] == 0).all())
        self.assertEqual(pcm[-7], 400 * 588)
        pcm, _ = self.read(-6, 0)                   # first track, negative offset
        self.assertTrue((pcm[:6] == 0).all())
        self.assertEqual(pcm[6], 1)


class NamingTest(unittest.TestCase):
    def test_safe_name(self):
        self.assertEqual(pr.safe_name('AC/DC: Live?'), 'AC_DC_ Live_')
        self.assertEqual(pr.safe_name('Trailing dots...'), 'Trailing dots')
        self.assertEqual(pr.safe_name('喜多郎'), '喜多郎')
        self.assertLessEqual(len(pr.safe_name('あ' * 100).encode()), 120)

    def test_track_filename(self):
        t = {'TRACKNUMBER': '3', 'TITLE': 'Sacred Journey'}
        self.assertEqual(pr.track_filename({}, t), '03 Sacred Journey.flac')
        self.assertEqual(pr.track_filename({'DISCNUMBER': '2'}, t), '2-03 Sacred Journey.flac')

    def test_release_metadata(self):
        toc = pr.parse_toc(KITARO_TOC)
        release = {
            'id': 'r1', 'title': 'Album', 'date': '1996',
            'artist-credit': [{'name': 'A', 'joinphrase': ' & '}, {'name': 'B'}],
            'media': [{'position': 1, 'track-count': 9, 'discs': [{'id': toc.musicbrainz_id()}],
                       'tracks': [{'id': f't{i}', 'title': f'Song {i}',
                                   'recording': {'id': f'rec{i}'}} for i in range(1, 10)]}],
        }
        album, tracks = pr.release_metadata(release, toc)
        self.assertEqual(album['ALBUMARTIST'], 'A & B')
        self.assertNotIn('DISCNUMBER', album)
        self.assertEqual(tracks[4]['TITLE'], 'Song 5')
        self.assertEqual(tracks[4]['ARTIST'], 'A & B')
        self.assertEqual(tracks[4]['MUSICBRAINZ_TRACKID'], 'rec5')


class DiscChoiceTest(unittest.TestCase):
    def setUp(self):
        self.toc = pr.parse_toc(KITARO_TOC)

    def release(self, disc_ids):
        """Two 9-track discs; disc_ids[n] lists the disc IDs attached to disc n+1."""
        return {'id': 'r', 'title': 'Set', 'artist-credit': [{'name': 'A'}], 'media': [
            {'position': n + 1, 'track-count': 9, 'discs': [{'id': d} for d in ids],
             'tracks': [{'title': f'D{n + 1} T{i}'} for i in range(1, 10)]}
            for n, ids in enumerate(disc_ids)]}

    def test_disc_id_wins(self):
        choice = pr.find_medium(self.release([[], [self.toc.musicbrainz_id()]]), self.toc)
        self.assertEqual((choice.medium['position'], choice.guessed), (2, False))

    def test_guess_is_flagged(self):
        choice = pr.find_medium(self.release([[], []]), self.toc)
        self.assertEqual((choice.medium['position'], choice.guessed), (1, True))

    def test_disc_option(self):
        release = self.release([[self.toc.musicbrainz_id()], []])
        album, tracks = pr.release_metadata(release, self.toc, disc=2)
        self.assertEqual((album['DISCNUMBER'], album['DISCTOTAL']), ('2', '2'))
        self.assertEqual(tracks[0]['TITLE'], 'D2 T1')
        self.assertEqual(pr.track_filename(album, tracks[0]), '2-01 D2 T1.flac')
        with self.assertRaises(SystemExit):
            pr.find_medium(release, self.toc, disc=3)

    def test_disc_option_without_musicbrainz(self):
        album, _ = pr.fallback_metadata(self.toc, 'A', 'B', disc=2)
        self.assertEqual(album['DISCNUMBER'], '2')


class OutputTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name

    def staged(self, files):
        staging = os.path.join(self.root, 'staging')
        os.makedirs(staging)
        for name, data in files.items():
            with open(os.path.join(staging, name), 'wb') as f:
                f.write(data)
        return staging

    def test_flac_round_trip_and_tags(self):
        pcm = np.random.default_rng(3).integers(-32768, 32768, 588 * 75 * 2,
                                                dtype=np.int64).astype('<i2').tobytes()
        path = os.path.join(self.root, 't.flac')
        pr.encode_flac(pcm, {'TITLE': 'Fata Morgana', 'ARTIST': '喜多郎',
                             'TRACKNUMBER': '2', 'GENRE': ''}, path)
        back, rate = pr.soundfile.read(path, dtype='int16', always_2d=True)
        self.assertEqual(rate, 44100)
        self.assertEqual(back.tobytes(), pcm)
        tags = pr.mutagen.flac.FLAC(path)
        self.assertEqual(tags['ARTIST'], ['喜多郎'])
        self.assertEqual(tags['TRACKNUMBER'], ['2'])
        self.assertNotIn('GENRE', tags)          # empty values are left out

    def test_new_album_appears_whole(self):
        staging = self.staged({'01 A.flac': b'one', 'cover.jpg': b'img'})
        folder = os.path.join(self.root, 'Music', 'Artist', 'Album')
        # Leftover of an interrupted copy is replaced.
        os.makedirs(os.path.join(self.root, 'Music', 'Artist', '.Album.platter-rip'))
        pr.install_album(staging, folder)
        self.assertEqual(sorted(os.listdir(folder)), ['01 A.flac', 'cover.jpg'])
        self.assertEqual(os.listdir(os.path.dirname(folder)), ['Album'])
        self.assertFalse(os.path.exists(staging))

    def test_adds_to_existing_folder_without_overwriting(self):
        folder = os.path.join(self.root, 'Album')
        os.makedirs(folder)
        with open(os.path.join(folder, '01 A.flac'), 'wb') as f:
            f.write(b'old')
        staging = self.staged({'02 B.flac': b'two'})
        pr.install_album(staging, folder)
        self.assertEqual(sorted(os.listdir(folder)), ['01 A.flac', '02 B.flac'])

        staging = self.staged({'01 A.flac': b'new'})
        with self.assertRaises(SystemExit):
            pr.install_album(staging, folder)
        with open(os.path.join(folder, '01 A.flac'), 'rb') as f:
            self.assertEqual(f.read(), b'old')
        self.assertTrue(os.path.exists(staging))  # the rip is kept


class Clock:
    """A fake clock that a fake drive moves forward with every read."""

    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class DamagedDrive(FakeDrive):
    """FakeDrive whose sectors in [bad_from, bad_to) read differently the first
    `noisy_reads` times each is read (forever if None). Every READ CD costs
    `cost` seconds on `clock`; sectors in `unreadable` fail."""

    def __init__(self, sectors, bad_from, bad_to, clock, noisy_reads=None, cost=0.1,
                 unreadable=()):
        super().__init__(sectors)
        self.bad = range(bad_from, bad_to)
        self.clock, self.noisy_reads, self.cost = clock, noisy_reads, cost
        self.unreadable = set(unreadable)
        self.reads_of = {}
        self.calls = []
        self.rng = random.Random(7)

    def read_cd(self, lba, count):
        self.clock.now += self.cost
        self.calls.append((lba, count))
        if any(s in self.unreadable for s in range(lba, lba + count)):
            raise pr.ScsiError('read')
        out = bytearray(super().read_cd(lba, count))
        for s in range(lba, lba + count):
            if s in self.bad:
                n = self.reads_of[s] = self.reads_of.get(s, 0) + 1
                if self.noisy_reads is None or n <= self.noisy_reads:
                    k = (s - lba) * pr.SECTOR
                    out[k:k + 4] = self.rng.getrandbits(32).to_bytes(4, 'little')
        return bytes(out)


class DamagedDiscTest(unittest.TestCase):
    """A damaged disc must not keep the ripper busy for hours."""

    def setUp(self):
        from unittest import mock
        self.toc = pr.Toc([(1, 0), (2, 3000)], 6000)    # 40 s tracks
        self.clock = Clock()
        self.logs = []
        patcher = mock.patch.object(pr.time, 'sleep', lambda s: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def verify(self, drive, patience):
        reader = pr.Reader(drive, self.toc, 0, patience=patience, clock=self.clock)
        raw, window = reader.read_track(0)
        return reader, reader.verify_track(0, raw, window, self.logs.append)

    def flushes(self, drive):
        """How many times the cache was flushed (reads of the far end of the disc)."""
        return sum(1 for lba, _ in drive.calls if lba == 4000)

    def test_one_cache_flush_per_round_not_per_chunk(self):
        # 20 chunks read differently twice, then the same: settled in the second round.
        drive = DamagedDrive(6000, 260, 780, self.clock, noisy_reads=2)
        _, v = self.verify(drive, patience=0)
        self.assertEqual((v.differing, v.uncertain, v.gave_up), (20, 0, False))
        self.assertEqual(self.flushes(drive), 2)
        start, end = self.toc.span(0)
        expected = FakeDrive(6000).read_cd(start, end - start)
        self.assertEqual(v.raw, expected)

    def test_gives_up_when_the_track_is_out_of_time(self):
        # The whole track differs on every read, as on the Jarre disc.
        drive = DamagedDrive(6000, 0, 3000, self.clock, cost=0.2)
        reader, v = self.verify(drive, patience=1)
        self.assertTrue(v.gave_up)
        self.assertGreater(v.uncertain, 0)
        budget = pr.MIN_TRACK_BUDGET                        # the 40 s track gets the minimum
        self.assertLess(self.clock.now, budget + 2)        # stops within a read or two of it
        self.assertEqual(len(v.raw), 3000 * pr.SECTOR)
        self.assertTrue(any('out of time' in line for line in self.logs))

    def test_patience_zero_never_gives_up(self):
        drive = DamagedDrive(6000, 0, 3000, self.clock, cost=0.2)
        _, v = self.verify(drive, patience=0)
        self.assertFalse(v.gave_up)
        self.assertEqual(self.flushes(drive), pr.REREAD_ROUNDS)

    def test_unsettled_chunk_keeps_the_first_read_on_a_tie(self):
        drive = DamagedDrive(6000, 26, 52, self.clock)     # one chunk, always noisy
        reader = pr.Reader(drive, self.toc, 0, patience=0, clock=self.clock)
        raw, window = reader.read_track(0)
        v = reader.verify_track(0, raw, window, self.logs.append)
        self.assertEqual(v.uncertain, 1)
        self.assertEqual(v.raw[26 * pr.SECTOR:52 * pr.SECTOR], raw[26 * pr.SECTOR:52 * pr.SECTOR])

    def test_no_second_read_when_the_first_used_up_the_time(self):
        drive = DamagedDrive(6000, 0, 0, self.clock, cost=10)  # very slow, not damaged
        reader = pr.Reader(drive, self.toc, 0, patience=1, clock=self.clock)
        raw, window = reader.read_track(0)
        calls = len(drive.calls)
        v = reader.verify_track(0, raw, window, self.logs.append)
        self.assertTrue(v.gave_up)
        self.assertEqual(len(drive.calls), calls)
        self.assertEqual(v.raw, raw)

    def test_unreadable_chunk_out_of_time_is_not_read_sector_by_sector(self):
        drive = DamagedDrive(6000, 0, 0, self.clock, unreadable={30})
        reader = pr.Reader(drive, self.toc, 0, patience=1, clock=self.clock)
        reader.deadline = -1                                # already out of time
        data = reader._read_chunk(26, 26)
        self.assertEqual(data, bytes(26 * pr.SECTOR))
        self.assertEqual(reader.unreadable, 26)
        self.assertEqual(len(drive.calls), 1)
        # In time: retried, then sector by sector, so only the bad sector is lost.
        drive.calls.clear()
        reader.deadline, reader.unreadable = None, 0
        data = reader._read_chunk(26, 26)
        self.assertEqual(reader.unreadable, 1)
        self.assertEqual(len(drive.calls), pr.CHUNK_ATTEMPTS + 26)
        self.assertEqual(data[:4 * pr.SECTOR], FakeDrive(6000).read_cd(26, 4))


def http_error(code, retry_after=None):
    import urllib.error
    return urllib.error.HTTPError('https://example', code, 'Busy',
                                  {'Retry-After': retry_after} if retry_after else {}, None)


class LookupTest(unittest.TestCase):
    """MusicBrainz busy: retry, then GnuDB, and never rip as "Unknown" by accident."""

    def setUp(self):
        from unittest import mock
        self.toc = pr.parse_toc(KITARO_TOC)
        self.logs = []
        self.sleeps = []
        patcher = mock.patch.object(pr.time, 'sleep', self.sleeps.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def answers(self, *results):
        """A request() that raises or returns each of `results` in turn."""
        it = iter(results)

        def request():
            r = next(it)
            if isinstance(r, Exception):
                raise r
            return r
        return request

    def test_retries_while_busy_then_succeeds(self):
        request = self.answers(http_error(503), http_error(429, '40'), {'releases': [1]})
        self.assertEqual(pr._retrying('MusicBrainz', request, (5, 15, 30), self.logs.append),
                         {'releases': [1]})
        self.assertEqual(self.sleeps, [5, 40])              # Retry-After asked for longer
        self.assertIn('HTTP 503', self.logs[0])

    def test_unavailable_when_retries_run_out(self):
        request = self.answers(*[http_error(503)] * 3)
        with self.assertRaises(pr.Unavailable):
            pr._retrying('MusicBrainz', request, (5, 15), self.logs.append)
        self.assertEqual(self.sleeps, [5, 15])

    def test_network_errors_are_retried_and_other_http_errors_are_not(self):
        import urllib.error
        request = self.answers(urllib.error.URLError('no route'), 'ok')
        self.assertEqual(pr._retrying('X', request, (1,), self.logs.append), 'ok')
        with self.assertRaises(urllib.error.HTTPError):
            pr._retrying('X', self.answers(http_error(403)), (1,), self.logs.append)

    def test_musicbrainz_lookup(self):
        from unittest import mock
        with mock.patch.object(pr, 'musicbrainz', side_effect=http_error(404)):
            self.assertEqual(pr.lookup_releases(self.toc, self.logs.append), [])
        with mock.patch.object(pr, 'musicbrainz', side_effect=http_error(503)):
            with self.assertRaises(pr.Unavailable):
                pr.lookup_releases(self.toc, self.logs.append, waits=(1, 1))
        with mock.patch.object(pr, 'musicbrainz', side_effect=[http_error(503), {'releases': ['r']}]):
            self.assertEqual(pr.lookup_releases(self.toc, self.logs.append), ['r'])

    def find(self, mb, gnudb, unknown_ok=False):
        def call(result):
            def lookup(toc, log):
                calls.append(result)
                if isinstance(result, Exception):
                    raise result
                return result
            return lookup
        calls = []
        found = pr.find_releases(self.toc, self.logs.append, unknown_ok, call(mb), call(gnudb))
        return found, len(calls)

    def mb_release(self, rid, this_disc=True):
        """A MusicBrainz release; this_disc=False: found by similar timings, not by disc ID."""
        ids = [self.toc.musicbrainz_id()] if this_disc else ['someOtherDisc-']
        return {'id': rid, 'media': [{'position': 1, 'discs': [{'id': d} for d in ids]}]}

    def test_musicbrainz_answer_is_used(self):
        mb = [self.mb_release('mb')]
        self.assertEqual(self.find(mb, ['gnu']), (mb, 1))

    def test_similar_timings_are_marked_and_gnudb_is_asked(self):
        similar = self.mb_release('fuzzy', this_disc=False)
        found, calls = self.find([similar], ['gnu'])
        self.assertEqual(calls, 2)
        self.assertEqual(found, ['gnu', dict(similar, similar=True)])  # an exact entry first
        self.assertTrue(any('similar' in line for line in self.logs))
        found, _ = self.find([similar], [])
        self.assertEqual(found, [dict(similar, similar=True)])
        self.assertNotIn('similar', similar)                            # the answer is not changed

    def test_pick_release(self):
        exact, fuzzy = self.mb_release('exact'), dict(self.mb_release('fuzzy', False), similar=True)
        self.assertIs(pr.pick_release([fuzzy, exact]), exact)
        self.assertIsNone(pr.pick_release([fuzzy]))       # similar timings are never used unasked
        self.assertIs(pr.pick_release([fuzzy], '1'), fuzzy)
        self.assertIs(pr.pick_release([exact, fuzzy], 'fuzzy'), fuzzy)
        for bad in ('3', 'nope'):
            with self.assertRaises(SystemExit):
                pr.pick_release([exact, fuzzy], bad)

    def test_own_tags_win_over_any_release(self):
        exact = self.mb_release('exact')
        self.assertIsNone(pr.pick_release([exact], own_tags=True))
        with self.assertRaises(SystemExit) as e:     # refused before the drive is touched
            pr.main(['--release', '1', '--artist', 'A', '--album', 'B'])
        self.assertIn('not both', str(e.exception))

    def test_gnudb_when_musicbrainz_is_down(self):
        found, _ = self.find(pr.Unavailable('HTTP 503'), ['gnu'])
        self.assertEqual(found, ['gnu'])
        self.assertTrue(any('no cover art' in line for line in self.logs))

    def test_gnudb_when_musicbrainz_does_not_know_the_disc(self):
        self.assertEqual(self.find([], ['gnu']), (['gnu'], 2))

    def test_does_not_rip_unknown_when_musicbrainz_is_down(self):
        for gnudb in ([], pr.Unavailable('HTTP 503')):
            with self.assertRaises(SystemExit) as e:
                self.find(pr.Unavailable('HTTP 503'), gnudb)
            self.assertIn('Not ripping', str(e.exception))

    def test_artist_and_album_given_rips_anyway(self):
        self.assertEqual(self.find(pr.Unavailable('HTTP 503'), [], unknown_ok=True), ([], 2))

    def test_unknown_disc_is_still_ripped_when_both_answered(self):
        self.assertEqual(self.find([], []), ([], 2))
        self.assertEqual(self.find([], pr.Unavailable('down')), ([], 2))


class GnuDBTest(unittest.TestCase):
    def setUp(self):
        self.toc = pr.parse_toc(KITARO_TOC)

    def test_query_command(self):
        cmd = pr.cddb_query_command(self.toc)
        parts = cmd.split()
        self.assertEqual(parts[:4], ['cddb', 'query', f'{self.toc.cddb_id():08x}', '9'])
        self.assertEqual(parts[4], '183')                      # 33 + 150
        self.assertEqual(int(parts[-1]), (self.toc.leadout + 150) // 75)

    def test_parse_query(self):
        self.assertEqual(pr.parse_cddb_query(['200 newage 7a0a6f09 Kitaro / Tunhuang']),
                         ([('newage', '7a0a6f09', 'Kitaro / Tunhuang')], []))
        lines = ['210 Found exact matches, list follows (until terminating `.\')',
                 'newage 7a0a6f09 Kitaro / Tunhuang', 'misc 7a0a6f09 Kitaro / Tun Huang', '.']
        exact, inexact = pr.parse_cddb_query(lines)
        self.assertEqual([m[0] for m in exact], ['newage', 'misc'])
        self.assertEqual(inexact, [])
        exact, inexact = pr.parse_cddb_query(['211 close matches', 'rock 12345678 X / Y', '.'])
        self.assertEqual((exact, len(inexact)), ([], 1))
        self.assertEqual(pr.parse_cddb_query(['202 No match found']), ([], []))
        with self.assertRaises(pr.Unavailable):
            pr.parse_cddb_query(['403 Database entry is corrupt'])

    def entry(self, dtitle, titles, **extra):
        lines = ['210 newage 7a0a6f09 CD database entry follows (until terminating `.\')',
                 '# xmcd', '#', 'DISCID=7a0a6f09', f'DTITLE={dtitle}']
        lines += [f'{k}={v}' for k, v in extra.items()]
        lines += [f'TTITLE{i}={t}' for i, t in enumerate(titles)]
        return lines + ['EXTD=', '.']

    def test_xmcd_to_tags(self):
        titles = ['Silk Road', 'Fata Morgana', 'Dunhuang / Mogao'] + [f'Song {i}' for i in range(4, 10)]
        lines = self.entry('Kitaro / Tunhuang', titles, DYEAR='1996', DGENRE='New Age')
        lines.insert(-2, 'TTITLE8=, continued')                # a long title goes on the next line
        entry = pr.parse_xmcd(lines)
        self.assertEqual(entry['TTITLE8'], 'Song 9, continued')
        release = pr.xmcd_release(entry, 'newage', '7a0a6f09', self.toc)
        album, tracks = pr.release_metadata(release, self.toc)
        self.assertEqual((album['ALBUMARTIST'], album['ALBUM']), ('Kitaro', 'Tunhuang'))
        self.assertEqual((album['DATE'], album['GENRE']), ('1996', 'New Age'))
        self.assertEqual(album['MUSICBRAINZ_ALBUMID'], '')       # not a MusicBrainz release
        self.assertEqual(tracks[2]['TITLE'], 'Dunhuang / Mogao')  # not split: one artist
        self.assertEqual(tracks[2]['ARTIST'], 'Kitaro')
        self.assertEqual(release['id'], 'gnudb:newage/7a0a6f09')

    def test_various_artists_titles_are_split(self):
        titles = [f'Artist {i} / Song {i}' for i in range(9)]
        entry = pr.parse_xmcd(self.entry('Various / Sampler', titles))
        _, tracks = pr.release_metadata(pr.xmcd_release(entry, 'misc', 'x', self.toc), self.toc)
        self.assertEqual((tracks[3]['ARTIST'], tracks[3]['TITLE']), ('Artist 3', 'Song 3'))

    def test_hello_needs_an_email_address(self):
        self.assertEqual(pr.gnudb_hello({'gnudb_email': 'me@example.org'}),
                         f'me example.org {pr.GNUDB_CLIENT}')
        for config in ({}, {'gnudb_email': ''}, {'gnudb_email': 'me'}, {'gnudb_email': 'a b@c'}):
            self.assertIsNone(pr.gnudb_hello(config), config)
        with self.assertRaises(pr.Unavailable) as e:
            pr.lookup_gnudb(self.toc, hello=None)
        self.assertIn('gnudb_email', str(e.exception))

    def test_refusal_dressed_as_a_match(self):
        # What GnuDB really answers to a hello it does not accept.
        lines = ["210 Found exact matches, list follows (until terminating `.')",
                 'data 3509526 500 Unknown application / developer email for platter-rip 1.0 '
                 'see https://gnudb.org/howtognudb.php', '.']
        with self.assertRaises(pr.Unavailable) as e:
            pr.parse_cddb_query(lines)
        self.assertIn('Unknown application', str(e.exception))

    def test_escapes(self):
        entry = pr.parse_xmcd(self.entry('A / B', [], EXTD='line1\\nline2 back\\\\slash'))
        self.assertEqual(entry['EXTD'], 'line1\nline2 back\\slash')


if __name__ == '__main__':
    unittest.main()
