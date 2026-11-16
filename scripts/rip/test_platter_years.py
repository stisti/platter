"""Tests for platter_years. Run: npm run test:rip"""

import os
import shutil
import struct
import sys
import tempfile
import unittest

import mutagen.flac
import mutagen.mp4
import numpy as np
import soundfile

sys.path.insert(0, os.path.dirname(__file__))
import platter_rip as pr  # noqa: E402
import platter_years as py  # noqa: E402
from test_platter_rip import KITARO_TOC  # noqa: E402


def mcdi_of(toc):
    """The WM/MCDI string Windows Media Player would have written for `toc`."""
    values = [len(toc.tracks)] + [lba + 150 for _, lba in toc.tracks] + [toc.leadout + 150]
    return '+'.join('%X' % v for v in values)


class McdiTest(unittest.TestCase):
    def test_gives_the_same_disc_id_as_reading_the_cd(self):
        toc = pr.parse_toc(KITARO_TOC)
        from_file = py.toc_from_mcdi(mcdi_of(toc))
        self.assertEqual(from_file.musicbrainz_id(), toc.musicbrainz_id())
        self.assertEqual(from_file.musicbrainz_toc(), toc.musicbrainz_toc())

    def test_a_real_wmp_value(self):
        toc = py.toc_from_mcdi('11+96+48A3+71A0+A820+E58D+1266F+1670B+19A69+1D04C+21AC5+27713+2ED79'
                               '+34742+37D8E+3B038+3EEB6+4B0E6+50AFA')
        self.assertEqual(len(toc.tracks), 17)
        self.assertEqual(toc.tracks[0], (1, 0))
        self.assertEqual(toc.leadout, 0x50AFA - 150)

    def test_rejects_nonsense(self):
        for bad in ('', 'x', '3+96+100', '2+96+50+100', 'zz+96+100+200', '1+10+200'):
            self.assertIsNone(py.toc_from_mcdi(bad), bad)

    def test_enhanced_cd_variant_drops_the_data_track(self):
        toc = py.toc_from_mcdi('3+96+5000+20000+30000')
        alt = py.without_last_track(toc)
        self.assertEqual([n for n, _ in alt.tracks], [1, 2])
        self.assertEqual(alt.leadout, toc.tracks[2][1] - 11400)

    def test_no_enhanced_cd_variant_when_the_last_track_is_too_close(self):
        # A real disc: track 19 starts 7,000 sectors after track 18, less than the 11,400 data gap.
        toc = py.toc_from_mcdi('13+B7+2B64+6557+830E+ACE2+DD7A+12674+156A6+18702+1B9C2+1EC85+231E0+26CDA'
                               '+2B23C+2EB12+31BB2+35E06+3857C+39F60+3F28C')
        self.assertEqual(len(toc.tracks), 19)
        self.assertIsNone(py.without_last_track(toc))


class TextTest(unittest.TestCase):
    def test_titles_match_across_punctuation_disc_suffix_and_brackets(self):
        self.assertTrue(py.titles_match('Live 1975-85 [Disc 2]', 'Live/1975–85'))
        self.assertTrue(py.titles_match('Born in the U.S.A.', 'Born In The USA'))
        self.assertTrue(py.titles_match('Minimum-Maximum (Live)', 'Minimum‐Maximum'))
        self.assertTrue(py.titles_match('Tuuleen piirretyt vuodet', 'Tuuleen Piirretyt Vuodet'))
        self.assertFalse(py.titles_match('Born to Run', 'Born in the U.S.A.'))
        self.assertTrue(py.titles_match('X & Y', 'X&Y'))
        self.assertTrue(py.titles_match('Hunting High & Low', 'Hunting High and Low'))
        self.assertTrue(py.titles_match('Light and Shade', 'Light + Shade'))

    def test_look_alike_titles_count_only_for_name_searches(self):
        for ours, theirs in (('Tres Lunas', 'Tr3s Lunas'), ('Alchemy (Live)', 'Alchemy: Dire Straits Live'),
                             ('R.E.T.R.O.', 'R.E.T.R.O')):
            self.assertTrue(py.titles_similar(ours, theirs), (ours, theirs))
        self.assertFalse(py.titles_match('Tres Lunas', 'Tr3s Lunas'))
        self.assertFalse(py.titles_similar('Hits', 'Hits of the 80s'), 'too short to be a prefix match')
        self.assertFalse(py.titles_similar('Born to Run', 'Born in the U.S.A.'))

    def test_artists_match_wmp_classical_credits_and_various_artists(self):
        self.assertTrue(py.artists_match('Howard Shelley: City Of London Sinfonia',
                                         'Wolfgang Amadeus Mozart; City of London Sinfonia, Howard Shelley'))
        self.assertTrue(py.artists_match('a-ha', 'a‐ha'))
        self.assertTrue(py.artists_match('Bruce Springsteen', 'Bruce Springsteen & The E Street Band'))
        self.assertTrue(py.artists_match('Eri Esittäjiä', 'Various Artists'))
        self.assertFalse(py.artists_match('Various Artists', 'Queen'))
        self.assertFalse(py.artists_match('Peter Gabriel', 'Queen'))

    def test_search_title_takes_the_itunes_type_suffix_off(self):
        self.assertEqual(py.search_title('Something That You Said - EP'), ('Something That You Said', 'EP'))
        self.assertEqual(py.search_title('Hey - Single'), ('Hey', 'Single'))
        self.assertEqual(py.search_title('Greatest Hits (CD 2)'), ('Greatest Hits', None))


def info(path='a.flac', album='A', album_artist='X', artist=None, year=None, mcdi=None, original=None, kind='flac'):
    return py.FileInfo(path, kind, album, album_artist, artist, year, mcdi, original, False)


class GroupingTest(unittest.TestCase):
    def test_tracks_of_one_cd_stay_together_despite_stand_in_tags(self):
        albums = py.group_albums([
            info('1.flac', 'Tuntematon albumi (26.9.2024 0.59.52)', 'Tuntematon esittäjä', mcdi='M'),
            info('2.flac', 'Super Hits', 'Bonnie Tyler', mcdi='M', year=1999),
            info('3.flac', 'Super Hits', 'Bonnie Tyler', mcdi='M', year=1999),
        ])
        self.assertEqual(len(albums), 1)
        (album,) = albums.values()
        self.assertEqual((album.artist, album.title, len(album.files)), ('Bonnie Tyler', 'Super Hits', 3))
        self.assertEqual(album.current_year, 1999)

    def test_discs_and_copies_of_one_album_are_one_row(self):
        albums = py.group_albums([
            info('a/1.flac', 'Live 1975-85 [Disc 1]', 'Bruce Springsteen', mcdi='D1'),
            info('a/2.flac', 'Live 1975-85 [Disc 2]', 'Bruce Springsteen', mcdi='D2'),
            info('b/1.m4a', 'Live 1975-85', 'bruce springsteen', kind='m4a'),
        ])
        self.assertEqual(len(albums), 1)
        self.assertEqual(list(albums.values())[0].mcdis, ['D1', 'D2'])

    def test_files_without_names_are_left_out(self):
        self.assertEqual(py.group_albums([info(album=None, album_artist=None)]), {})


def release(group_id, title, date, kind='Album', secondary=(), artist='Bruce Springsteen'):
    return {'artist-credit': [{'name': artist, 'joinphrase': ''}],
            'release-group': {'id': group_id, 'title': title, 'first-release-date': date,
                              'primary-type': kind, 'secondary-types': list(secondary)}}


def album(title='Live 1975-85', artist='Bruce Springsteen'):
    a = py.Album(py.album_key(artist, title), artist, title)
    return a


class DiscDecisionTest(unittest.TestCase):
    def test_exact_disc_id_with_one_album_is_a_yes(self):
        m = py.from_disc_lookup(album(), {'id': 'x', 'releases': [release('g1', 'Live/1975–85', '1986-11-10')] * 2}, exact=True)
        self.assertEqual((m.method, m.decision, m.date, m.group_id), ('discid', 'yes', '1986-11-10', 'g1'))

    def test_near_match_needs_the_title_to_agree(self):
        yes = py.from_disc_lookup(album(), {'releases': [release('g1', 'Live/1975–85', '1986')]}, exact=False)
        self.assertEqual((yes.method, yes.decision), ('toc', 'yes'))
        other = py.from_disc_lookup(album(), {'releases': [release('g2', 'Tunnel of Love', '1987')]}, exact=False)
        self.assertEqual(other.decision, 'check')

    def test_several_albums_on_one_disc_title_decides_or_human_checks(self):
        res = {'id': 'x', 'releases': [release('g1', 'Greatest Hits', '1995', secondary=['Compilation']),
                                       release('g2', 'Live 1975-85', '1986')]}
        m = py.from_disc_lookup(album(), res, exact=True)
        self.assertEqual((m.decision, m.group_id), ('yes', 'g2'))
        m = py.from_disc_lookup(album('Something else'), res, exact=True)
        self.assertEqual((m.decision, m.group_id), ('check', 'g2'))   # the earlier one, flagged

    def test_near_match_with_unrelated_albums_falls_back_to_search(self):
        # What a fuzzy TOC lookup really returned for a Finnish Christmas CD.
        res = {'releases': [release('a', 'Greatest Hits', '1989', artist='Shakin’ Stevens'),
                            release('b', 'LOVE HATE', '2026-09-09', artist='Someone'),
                            release('c', 'From Outer Space To Inner Space', '1995', artist='Other')]}
        self.assertIsNone(py.from_disc_lookup(album('Joulun Tunnelmia', 'Instrumental'), res, exact=False))

    def test_near_match_title_and_artist_must_both_agree_among_several(self):
        res = {'releases': [release('a', '20 Suosikkia', '1996', artist='Mamba'),
                            release('b', '20 Suosikkia', '2004-02', artist='Egotrippi'),
                            release('c', 'Das Nummer 1 Album!', '2010', artist='Various Artists')]}
        m = py.from_disc_lookup(album('20 Suosikkia', 'Egotrippi'), res, exact=False)
        self.assertEqual((m.decision, m.group_id), ('yes', 'b'))

    def test_nothing_found(self):
        self.assertIsNone(py.from_disc_lookup(album(), {}, exact=False))


class LookupTest(unittest.TestCase):
    def run_lookup(self, found, current_year):
        a = album()
        a.files = [info(year=current_year)]
        saved = py.lookup_disc, py.lookup_search
        py.lookup_disc, py.lookup_search = (lambda *args: None), (lambda *args: found)
        try:
            return py.lookup(a, False, print)
        finally:
            py.lookup_disc, py.lookup_search = saved

    def test_a_match_that_would_not_change_the_year_is_left_alone(self):
        self.assertEqual(self.run_lookup(py.Match('search', 'check', '1984-06-04', 'g'), 1984).decision, 'same')
        self.assertEqual(self.run_lookup(py.Match('discid', 'yes', '1985', 'g'), 1986).decision, 'yes')
        self.assertEqual(self.run_lookup(py.Match('discid', 'yes', '1985', 'g'), None).decision, 'yes')

    def test_no_date_or_no_match_is_a_no(self):
        self.assertEqual(self.run_lookup(py.Match('discid', 'yes', '', 'g'), 1986).decision, 'no')
        self.assertEqual(self.run_lookup(None, 1986).method, 'none')


def group(gid, title, date, kind='Album', artist='Bruce Springsteen', score=100, secondary=()):
    return {'id': gid, 'title': title, 'first-release-date': date, 'primary-type': kind, 'score': score,
            'secondary-types': list(secondary), 'artist-credit': [{'name': artist, 'joinphrase': ''}]}


class SearchDecisionTest(unittest.TestCase):
    def test_prefers_the_album_over_an_ep_of_the_same_name_and_always_asks(self):
        # MusicBrainz's own top hit for this search really is the EP.
        res = {'release-groups': [group('ep', 'Born in the U.S.A.', '1984', 'EP'),
                                  group('lp', 'Born in the U.S.A.', '1984-06-04'),
                                  group('x', 'Born to Run', '1975-08-25')]}
        m = py.from_search(album('Born in the U.S.A.'), res)
        self.assertEqual((m.method, m.decision, m.group_id, m.date), ('search', 'check', 'lp', '1984-06-04'))
        self.assertIn('also', m.note)

    def test_itunes_ep_suffix_picks_the_ep(self):
        res = {'release-groups': [group('lp', 'Something That You Said', '2003', artist='The Bangles'),
                                  group('ep', 'Something That You Said', '2003-05', 'EP', artist='The Bangles')]}
        m = py.from_search(album('Something That You Said - EP', 'The Bangles'), res)
        self.assertEqual(m.group_id, 'ep')

    def test_plain_album_before_live_or_compilation(self):
        res = {'release-groups': [group('live', 'Hits', '2001', secondary=['Live']), group('studio', 'Hits', '1990')]}
        self.assertEqual(py.from_search(album('Hits'), res).group_id, 'studio')

    def test_musicbrainz_spelling_is_found_but_exact_titles_rank_first(self):
        res = {'release-groups': [group('x', 'Tr3s Lunas', '2002-06-17', artist='Mike Oldfield'),
                                  group('y', 'Tres Lunas', '2002', artist='Mike Oldfield', secondary=['Compilation'])]}
        m = py.from_search(album('Tres Lunas', 'Mike Oldfield'), res)
        self.assertEqual(m.group_id, 'y')
        res = {'release-groups': [group('x', 'Tr3s Lunas', '2002-06-17', artist='Mike Oldfield')]}
        self.assertEqual(py.from_search(album('Tres Lunas', 'Mike Oldfield'), res).group_id, 'x')

    def test_other_artists_do_not_count(self):
        res = {'release-groups': [group('x', 'Greatest Hits', '1981', artist='Queen')]}
        self.assertIsNone(py.from_search(album('Greatest Hits', 'Peter Gabriel'), res))


class PlanTest(unittest.TestCase):
    def test_round_trip_and_validation(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'sub', 'plan.tsv')
            py.write_plan(path, [{'apply': 'yes', 'original_date': '1985', 'current_year': 1986, 'method': 'discid',
                                  'album_artist': 'Bruce Springsteen & The E Street Band', 'album': 'Live 1975-85',
                                  'files': 40, 'release_group': '6b56d7c1-b1c0-43fb-ba21-1a0b5004ce3e',
                                  'note': 'tab\tfree "quotes"'}])
            with open(path) as f:
                self.assertTrue(f.read().startswith('# Platter'))
            (row,) = py.read_plan(path)
            self.assertEqual(row['album_artist'], 'Bruce Springsteen & The E Street Band')
            self.assertEqual(row['note'], 'tab\tfree "quotes"')
            self.assertIsNone(py.validate_row(row))
            self.assertIn('original_date', py.validate_row({**row, 'original_date': '85'}))
            self.assertIn('release_group', py.validate_row({**row, 'release_group': 'nope'}))
            self.assertIsNone(py.validate_row({**row, 'release_group': ''}))


# ---------------------------------------------------------------- writing

def make_flac(path, seconds=0.5):
    """A FLAC laid out like the Windows Media Player rips: tags, no padding."""
    rng = np.random.default_rng(1)
    samples = rng.integers(-20000, 20000, size=(int(44100 * seconds), 2), dtype=np.int16)
    soundfile.write(path, samples, 44100, format='FLAC', subtype='PCM_16')
    f = mutagen.flac.FLAC(path)
    f.clear()
    f['ALBUM'] = 'Live 1975-85 [Disc 2]'
    f['ALBUMARTIST'] = 'Bruce Springsteen'
    f['YEAR'] = '1986'
    f['WM/MCDI'] = '3+96+1000+2000+9000'
    f.save(padding=lambda info: 0)
    assert sum(b.length for b in mutagen.flac.FLAC(path).metadata_blocks if isinstance(b, mutagen.flac.Padding)) == 0
    return samples


def box(kind, *parts):
    body = b''.join(parts)
    return struct.pack('>I', len(body) + 8) + kind + body


def make_m4a(path, audio=b'\x21' * 4096):
    """A minimal iTunes-style M4A: tags in moov, audio in mdat, one chunk offset to keep right."""
    def data(text):
        return box(b'data', struct.pack('>II', 1, 0), text.encode())
    ilst = box(b'ilst', box('©alb'.encode('latin-1'), data('Born in the U.S.A.')),
               box(b'aART', data('Bruce Springsteen')), box('©day'.encode('latin-1'), data('1984-06-04T07:00:00Z')))
    meta = box(b'meta', b'\0\0\0\0', box(b'hdlr', b'\0' * 8 + b'mdirappl' + b'\0' * 9), ilst)
    mvhd = box(b'mvhd', struct.pack('>IIIII', 0, 0, 0, 44100, 44100 * 2) + b'\0' * 80)
    mdhd = box(b'mdhd', struct.pack('>IIIIIHH', 0, 0, 0, 44100, 44100 * 2, 0, 0))
    hdlr = box(b'hdlr', b'\0' * 8 + b'soun' + b'\0' * 13)
    esds = box(b'esds', b'\0' * 4 + bytes([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15]) + b'\0' * 11 + bytes([5, 2, 0x12, 0x10, 6, 1, 2]))
    mp4a = box(b'mp4a', b'\0' * 6 + struct.pack('>H', 1) + b'\0' * 8 + struct.pack('>HHHHI', 2, 16, 0, 0, 44100 << 16), esds)
    stsd = box(b'stsd', struct.pack('>II', 0, 1), mp4a)

    def build(chunk_offset):
        stco = box(b'stco', struct.pack('>III', 0, 1, chunk_offset))
        stbl = box(b'stbl', stsd, box(b'stts', struct.pack('>II', 0, 0)), box(b'stsc', struct.pack('>II', 0, 0)),
                   box(b'stsz', struct.pack('>III', 0, 0, 0)), stco)
        trak = box(b'trak', box(b'tkhd', b'\0' * 84), box(b'mdia', mdhd, hdlr, box(b'minf', box(b'smhd', b'\0' * 8), stbl)))
        return box(b'ftyp', b'M4A ' + b'\0\0\0\0' + b'M4A mp42isom') + box(b'moov', mvhd, trak, box(b'udta', meta))

    head = build(0)
    head = build(len(head) + 8)          # the chunk starts right after the mdat header
    with open(path, 'wb') as f:
        f.write(head + box(b'mdat', audio))


def chunk_offset(path):
    with open(path, 'rb') as f:
        b = f.read()
    i = b.index(b'stco')
    return struct.unpack('>I', b[i + 12:i + 16])[0], b


class RewriteTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.work = os.path.join(self.dir, 'work')
        os.makedirs(self.work)
        self.tags = {'ORIGINALDATE': '1986-11-10', 'MUSICBRAINZ_RELEASEGROUPID': '6b56d7c1-b1c0-43fb-ba21-1a0b5004ce3e'}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_flac_without_padding_gets_the_tags_and_keeps_its_audio_and_other_tags(self):
        path = os.path.join(self.dir, '01 Thunder Road.flac')
        samples = make_flac(path)
        audio = py.audio_digest(path)
        self.assertEqual(py.rewrite(path, 'flac', self.tags, self.work), ['ORIGINALDATE', 'MUSICBRAINZ_RELEASEGROUPID'])
        f = mutagen.flac.FLAC(path)
        self.assertEqual(f['ORIGINALDATE'], ['1986-11-10'])
        self.assertEqual(f['YEAR'], ['1986'])
        self.assertEqual(f['WM/MCDI'], ['3+96+1000+2000+9000'])
        self.assertEqual(py.audio_digest(path), audio)
        back, _ = soundfile.read(path, dtype='int16', always_2d=True)
        self.assertTrue(np.array_equal(back, samples))
        self.assertEqual(sorted(os.listdir(self.dir)), ['01 Thunder Road.flac', 'work'], 'no temp files left')
        self.assertEqual(os.listdir(self.work), [])
        # A second run changes nothing.
        before = os.stat(path).st_mtime_ns
        self.assertEqual(py.rewrite(path, 'flac', self.tags, self.work), [])
        self.assertEqual(os.stat(path).st_mtime_ns, before)

    def test_existing_tags_are_never_overwritten(self):
        path = os.path.join(self.dir, 'a.flac')
        make_flac(path)
        f = mutagen.flac.FLAC(path)
        f['ORIGINALDATE'] = '1975'
        f.save()
        self.assertEqual(py.rewrite(path, 'flac', self.tags, self.work), ['MUSICBRAINZ_RELEASEGROUPID'])
        self.assertEqual(mutagen.flac.FLAC(path)['ORIGINALDATE'], ['1975'])

    def test_m4a_gets_itunes_freeform_items_and_its_chunk_offsets_follow_the_audio(self):
        path = os.path.join(self.dir, 'a.m4a')
        make_m4a(path)
        offset, b = chunk_offset(path)
        self.assertEqual(b[offset:offset + 4], b'\x21' * 4)
        audio = py.audio_digest(path)
        self.assertEqual(py.rewrite(path, 'm4a', self.tags, self.work), ['ORIGINALDATE', 'MUSICBRAINZ_RELEASEGROUPID'])
        m = mutagen.mp4.MP4(path)
        self.assertEqual(bytes(m['----:com.apple.iTunes:ORIGINALDATE'][0]), b'1986-11-10')
        self.assertEqual(bytes(m['----:com.apple.iTunes:MusicBrainz Release Group Id'][0]),
                         b'6b56d7c1-b1c0-43fb-ba21-1a0b5004ce3e')
        self.assertEqual(m['©alb'], ['Born in the U.S.A.'])
        self.assertEqual(py.audio_digest(path), audio)
        offset, b = chunk_offset(path)
        self.assertEqual(b[offset:offset + 4096], b'\x21' * 4096, 'the chunk offset still points at the audio')
        self.assertEqual(py.read_file(path).original_date, '1986-11-10')

    def test_a_file_changed_meanwhile_is_left_alone(self):
        path = os.path.join(self.dir, 'a.flac')
        make_flac(path)
        real_add = py.add_tags

        def add_and_touch(*args):
            os.utime(path, ns=(1, 1))      # someone else writes the original during our work
            return real_add(*args)
        py.add_tags = add_and_touch
        try:
            with self.assertRaises(py.WriteError):
                py.rewrite(path, 'flac', self.tags, self.work)
        finally:
            py.add_tags = real_add
        self.assertNotIn('ORIGINALDATE', mutagen.flac.FLAC(path))
        self.assertEqual(sorted(os.listdir(self.dir)), ['a.flac', 'work'])

    def test_leftover_temp_files_are_cleaned_up_and_hidden_from_the_walk(self):
        os.makedirs(os.path.join(self.dir, 'm', 'A'))
        make_flac(os.path.join(self.dir, 'm', 'A', '01.flac'))
        leftover = os.path.join(self.dir, 'm', 'A', '.01.flac' + py.TEMP_SUFFIX)
        open(leftover, 'wb').close()
        self.assertEqual([os.path.basename(p) for p in py.walk(os.path.join(self.dir, 'm'))], ['01.flac'])
        py.remove_leftovers(os.path.join(self.dir, 'm'), lambda msg: None)
        self.assertFalse(os.path.exists(leftover))


class ApplyTest(unittest.TestCase):
    def test_only_yes_rows_are_written(self):
        with tempfile.TemporaryDirectory() as d:
            music = os.path.join(d, 'Music')
            os.makedirs(os.path.join(music, 'BS', 'Live'))
            os.makedirs(os.path.join(music, 'BS', 'Other'))
            make_flac(os.path.join(music, 'BS', 'Live', '01.flac'))
            other = os.path.join(music, 'BS', 'Other', '01.flac')
            make_flac(other)
            f = mutagen.flac.FLAC(other)
            f['ALBUM'] = 'Other'
            f['WM/MCDI'] = '2+96+1000+5000'
            f.save()
            plan = os.path.join(d, 'plan.tsv')
            row = {'original_date': '1986-11-10', 'current_year': 1986, 'method': 'discid',
                   'album_artist': 'Bruce Springsteen', 'files': 1, 'release_group': '', 'note': ''}
            py.write_plan(plan, [{**row, 'apply': 'yes', 'album': 'Live 1975-85'},
                                 {**row, 'apply': 'check', 'album': 'Other'}])
            old_root = py.CACHE_ROOT
            py.CACHE_ROOT = os.path.join(d, 'cache')
            try:
                out = []
                py.cmd_apply(type('A', (), {'plan': plan, 'dest': music, 'dry_run': False, 'limit': None})(), out.append)
            finally:
                py.CACHE_ROOT = old_root
            self.assertEqual(mutagen.flac.FLAC(os.path.join(music, 'BS', 'Live', '01.flac'))['ORIGINALDATE'], ['1986-11-10'])
            self.assertNotIn('MUSICBRAINZ_RELEASEGROUPID', mutagen.flac.FLAC(os.path.join(music, 'BS', 'Live', '01.flac')))
            self.assertNotIn('ORIGINALDATE', mutagen.flac.FLAC(other))
            self.assertTrue(any('still say "check"' in line for line in out))


if __name__ == '__main__':
    unittest.main()
