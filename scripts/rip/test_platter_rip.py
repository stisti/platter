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


if __name__ == '__main__':
    unittest.main()
