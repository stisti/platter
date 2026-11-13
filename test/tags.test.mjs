import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BlobReader } from '../app/js/bytes.js';
import { parseFlac } from '../app/js/flac.js';
import { parseMp3 } from '../app/js/id3.js';
import { parseMp4 } from '../app/js/mp4.js';
import { guessFromPath, makeTrack, readTrack, splitGenres } from '../app/js/tags.js';
import { TONE_FLAC, TINY_PNG, buildFlac, buildId3v1, buildId3v2, buildM4a, concat, mpegFrame } from './helpers/media.mjs';

const reader = (bytes, options) => new BlobReader(new Blob([bytes]), options);

// ---------------------------------------------------------------------- FLAC

test('flac: reads stream info of a real file written by the reference encoder', async () => {
  const meta = await parseFlac(reader(TONE_FLAC));
  assert.equal(meta.sampleRate, 22050);
  assert.equal(meta.channels, 1);
  assert.equal(meta.bitsPerSample, 16);
  assert.equal(meta.duration, 33075 / 22050);
  assert.deepEqual(meta.tags, {});
  assert.equal(meta.picture, null);
});

test('flac: reads tags, upper-casing keys and keeping repeated fields', async () => {
  const bytes = buildFlac({
    tags: { title: 'Sää', Artist: ['Ultra Bra', 'Vieras'], ALBUM: 'Kroketti', tracknumber: '3/12', GENRE: ['Pop', 'Rock'], DATE: '1997-05-01' },
    sampleRate: 96000,
    channels: 2,
    bits: 24,
    totalSamples: 96000 * 200,
  });
  const meta = await parseFlac(reader(bytes));
  assert.deepEqual(meta.tags, {
    TITLE: ['Sää'],
    ARTIST: ['Ultra Bra', 'Vieras'],
    ALBUM: ['Kroketti'],
    TRACKNUMBER: ['3/12'],
    GENRE: ['Pop', 'Rock'],
    DATE: ['1997-05-01'],
  });
  assert.equal(meta.sampleRate, 96000);
  assert.equal(meta.bitsPerSample, 24);
  assert.equal(meta.channels, 2);
  assert.equal(meta.duration, 200);
});

test('flac: handles durations that need more than 32 bits of sample count', async () => {
  const totalSamples = 2 ** 32 + 192000 * 10; // > 6 hours at 192 kHz
  const meta = await parseFlac(reader(buildFlac({ sampleRate: 192000, totalSamples })));
  assert.equal(meta.duration, totalSamples / 192000);
});

test('flac: locates the embedded cover exactly, preferring the front cover', async () => {
  const back = new Uint8Array(5000).fill(7);
  const front = concat([TINY_PNG]);
  const bytes = buildFlac({
    tags: { TITLE: 'x' },
    pictures: [
      { type: 4, mime: 'image/jpeg', data: back },
      { type: 3, mime: 'image/png', description: 'the front', data: front },
    ],
  });
  const meta = await parseFlac(reader(bytes));
  assert.equal(meta.picture.mime, 'image/png');
  assert.equal(meta.picture.length, front.length);
  assert.deepEqual(bytes.slice(meta.picture.offset, meta.picture.offset + meta.picture.length), front);
});

test('flac: finds tags that come after a large picture without reading the picture', async () => {
  const big = new Uint8Array(3 * 1024 * 1024).fill(1);
  const bytes = buildFlac({ tags: { TITLE: 'After the art', ARTIST: 'A' }, pictures: [{ data: big }], picturesFirst: true, padding: 4096 });
  const r = reader(bytes);
  const meta = await parseFlac(r);
  assert.deepEqual(meta.tags.TITLE, ['After the art']);
  assert.equal(meta.picture.length, big.length);
  assert.ok(r.reads <= 4, `expected a handful of small reads, got ${r.reads}`);
});

test('flac: tags followed by a big front cover need just one read', async () => {
  const big = new Uint8Array(3 * 1024 * 1024).fill(1);
  const r = reader(buildFlac({ tags: { TITLE: 't', ARTIST: 'a' }, pictures: [{ type: 3, data: big }], padding: 8192 }));
  const meta = await parseFlac(r);
  assert.deepEqual(meta.tags.TITLE, ['t']);
  assert.equal(meta.picture.length, big.length);
  assert.equal(r.reads, 1);
});

test('flac: a typical file is parsed with a single read', async () => {
  const r = reader(buildFlac({ tags: { TITLE: 't', ARTIST: 'a', ALBUM: 'b' }, playable: true }));
  await parseFlac(r);
  assert.equal(r.reads, 1);
});

test('flac: skips an ID3v2 tag in front of the stream', async () => {
  const id3 = buildId3v2({ frames: [{ id: 'TIT2', text: 'wrong' }] });
  const meta = await parseFlac(reader(buildFlac({ tags: { TITLE: 'right' }, prefix: id3 })));
  assert.deepEqual(meta.tags.TITLE, ['right']);
});

test('flac: ignores oversized and malformed comments instead of failing', async () => {
  const meta = await parseFlac(reader(buildFlac({ tags: { LYRICS: 'x'.repeat(20000), TITLE: 'ok', NOVALUE: '' } })));
  assert.deepEqual(meta.tags, { TITLE: ['ok'] });
});

test('flac: rejects files that are not FLAC', async () => {
  await assert.rejects(parseFlac(reader(new Uint8Array(100))), /Not a FLAC file/);
  await assert.rejects(parseFlac(reader(new Uint8Array(0))), /Not a FLAC file/);
});

test('flac: survives truncation at every possible length', async () => {
  const bytes = buildFlac({ tags: { TITLE: 'Truncated', ARTIST: 'Somebody' }, pictures: [{ data: TINY_PNG }] });
  for (let length = 0; length < bytes.length; length++) {
    try {
      await parseFlac(reader(bytes.slice(0, length)));
    } catch (err) {
      assert.match(err.message, /Not a FLAC file/, `unexpected error at length ${length}: ${err.message}`);
    }
  }
});

// ----------------------------------------------------------------------- MP3

test('mp3: reads ID3v2.3 text frames in latin-1 and UTF-16', async () => {
  const tag = buildId3v2({
    version: 3,
    frames: [
      { id: 'TIT2', text: 'Hyvää yötä', encoding: 1 },
      { id: 'TPE1', text: 'Café Tacvba', encoding: 0 },
      { id: 'TALB', text: 'Re', encoding: 0 },
      { id: 'TRCK', text: '7/20' },
      { id: 'TYER', text: '1994' },
      { id: 'TCON', text: '(17)' },
      { id: 'TPE2', text: 'Café Tacvba' },
    ],
  });
  const meta = await parseMp3(reader(concat([tag, mpegFrame()])));
  assert.deepEqual(meta.tags, {
    TITLE: ['Hyvää yötä'],
    ARTIST: ['Café Tacvba'],
    ALBUM: ['Re'],
    TRACKNUMBER: ['7/20'],
    DATE: ['1994'],
    GENRE: ['Rock'],
    ALBUMARTIST: ['Café Tacvba'],
  });
});

test('mp3: reads ID3v2.4 (UTF-8, multiple values) and ID3v2.2', async () => {
  const v4 = buildId3v2({ version: 4, frames: [{ id: 'TIT2', text: 'Ääni', encoding: 3 }, { id: 'TCON', text: 'Jazz\u0000Fusion', encoding: 3 }, { id: 'TDRC', text: '2001-03-04', encoding: 3 }] });
  const m4 = await parseMp3(reader(concat([v4, mpegFrame()])));
  assert.deepEqual(m4.tags, { TITLE: ['Ääni'], GENRE: ['Jazz', 'Fusion'], DATE: ['2001-03-04'] });

  const v2 = buildId3v2({ version: 2, frames: [{ id: 'TT2', text: 'Old' }, { id: 'TP1', text: 'Timer' }, { id: 'TCO', text: '(8)Jazz' }] });
  const m2 = await parseMp3(reader(concat([v2, mpegFrame()])));
  assert.deepEqual(m2.tags, { TITLE: ['Old'], ARTIST: ['Timer'], GENRE: ['Jazz'] });
});

test('mp3: locates the attached picture', async () => {
  for (const version of [2, 3, 4]) {
    const tag = buildId3v2({ version, frames: [{ id: version === 2 ? 'TT2' : 'TIT2', text: 'x' }], picture: { mime: 'image/png', data: TINY_PNG } });
    const bytes = concat([tag, mpegFrame()]);
    const meta = await parseMp3(reader(bytes));
    assert.ok(meta.picture, `v2.${version} picture`);
    assert.equal(meta.picture.mime, 'image/png');
    assert.deepEqual(bytes.slice(meta.picture.offset, meta.picture.offset + meta.picture.length), TINY_PNG);
  }
});

test('mp3: falls back to ID3v1', async () => {
  const bytes = concat([mpegFrame(), new Uint8Array(1000), buildId3v1({ title: 'Song', artist: 'Band', album: 'LP', year: '1988', track: 4, genre: 17 })]);
  const meta = await parseMp3(reader(bytes));
  assert.deepEqual(meta.tags, { TITLE: ['Song'], ARTIST: ['Band'], ALBUM: ['LP'], DATE: ['1988'], TRACKNUMBER: ['4'], GENRE: ['Rock'] });
});

test('mp3: duration from the Xing header, or from the bitrate without one', async () => {
  const vbr = await parseMp3(reader(concat([buildId3v2({ frames: [{ id: 'TIT2', text: 'x' }] }), mpegFrame({ xingFrames: 10000 })])));
  assert.equal(vbr.duration, (10000 * 1152) / 44100);

  const audio = new Uint8Array(160000); // 10 s at 128 kbit/s
  audio.set(mpegFrame());
  const cbr = await parseMp3(reader(audio));
  assert.equal(cbr.duration, 10);
});

test('mp3: garbage in, empty result out', async () => {
  const meta = await parseMp3(reader(new Uint8Array(5000).fill(0x41)));
  assert.deepEqual(meta, { tags: {}, duration: null, picture: null });
  await parseMp3(reader(new Uint8Array(0)));
  // a header that promises more than the file holds
  const lying = buildId3v2({ frames: [{ id: 'TIT2', text: 'x' }] }).slice(0, 14);
  await parseMp3(reader(lying));
});

// ----------------------------------------------------------------------- M4A

const ITUNES_TAGS = { TITLE: 'Rolling In the Deep', ARTIST: 'Adele', ALBUMARTIST: 'Adele', ALBUM: '21', GENRE: 'Pop', DATE: '2010-11-29T08:00:00Z' };

test('m4a: reads iTunes tags, duration, codec and the cover location', async () => {
  const bytes = buildM4a({ tags: ITUNES_TAGS, track: [1, 12], disc: [1, 1], compilation: true, cover: { png: true, data: TINY_PNG }, duration: 228.5 });
  const meta = await parseMp4(reader(bytes));
  assert.deepEqual(meta.tags, {
    TITLE: ['Rolling In the Deep'], ARTIST: ['Adele'], ALBUMARTIST: ['Adele'], ALBUM: ['21'], GENRE: ['Pop'],
    DATE: ['2010-11-29T08:00:00Z'], TRACKNUMBER: ['1/12'], DISCNUMBER: ['1/1'], COMPILATION: ['1'],
  });
  assert.equal(meta.duration, 228.5);
  assert.equal(meta.codec, 'mp4a');
  assert.equal(meta.picture.mime, 'image/png');
  assert.deepEqual(bytes.slice(meta.picture.offset, meta.picture.offset + meta.picture.length), TINY_PNG);
});

test('m4a: finds the metadata when it comes after the audio, without reading the audio', async () => {
  for (const wideAudio of [false, true]) {
    const r = reader(buildM4a({ tags: { TITLE: 'Ääni', ARTIST: 'Yö' }, track: [7, 0], moovLast: true, audioBytes: 5 * 1024 * 1024, wideAudio }));
    const meta = await parseMp4(r);
    assert.deepEqual(meta.tags, { TITLE: ['Ääni'], ARTIST: ['Yö'], TRACKNUMBER: ['7'] });
    assert.equal(meta.duration, 200);
    assert.ok(r.reads <= 3, `expected at most 3 reads, got ${r.reads}`);
  }
});

test('m4a: numeric genres, and text genre taking precedence', async () => {
  const numeric = await parseMp4(reader(buildM4a({ genreId: 18 })));
  assert.deepEqual(numeric.tags.GENRE, ['Rock']);
  const both = await parseMp4(reader(buildM4a({ tags: { GENRE: 'Suomirock' }, genreId: 18 })));
  assert.deepEqual(both.tags.GENRE, ['Suomirock']);
});

test('m4a: rejects other files, and survives truncation at every length', async () => {
  await assert.rejects(parseMp4(reader(new Uint8Array(500).fill(7))), /Not an MP4 file/);
  await assert.rejects(parseMp4(reader(new Uint8Array(0))), /Not an MP4 file/);
  const bytes = buildM4a({ tags: ITUNES_TAGS, track: [1, 12], cover: { data: TINY_PNG } });
  for (let length = 0; length < bytes.length; length += 7) {
    try {
      await parseMp4(reader(bytes.slice(0, length)));
    } catch (err) {
      assert.match(err.message, /MP4/, `unexpected error at length ${length}: ${err.message}`);
    }
  }
});

test('readTrack: an M4A becomes a full track record; a copy-protected one is refused', async () => {
  const file = new File([buildM4a({ tags: ITUNES_TAGS, track: [1, 12], disc: [1, 1] })], 'x.m4a', { lastModified: 99 });
  const t = await readTrack(file, 'Apple Music/Media/Music/Adele/21/01 Rolling In the Deep.m4a');
  assert.deepEqual(
    { title: t.title, artist: t.artist, album: t.album, albumArtist: t.albumArtist, year: t.year, trackNo: t.trackNo, discNo: t.discNo, genres: t.genres, duration: t.duration, guessed: t.guessed },
    { title: 'Rolling In the Deep', artist: 'Adele', album: '21', albumArtist: 'Adele', year: 2010, trackNo: 1, discNo: 1, genres: ['Pop'], duration: 200, guessed: [] },
  );
  const locked = new File([buildM4a({ tags: ITUNES_TAGS, codec: 'drms' })], 'x.m4a');
  assert.equal(await readTrack(locked, 'a/b/x.m4a'), null);
});

// ------------------------------------------------------------- track records

test('guessFromPath: common naming schemes', () => {
  assert.deepEqual(guessFromPath('Pink Floyd/Animals/02 - Dogs.flac'), { title: 'Dogs', trackNo: 2, discNo: null, album: 'Animals', artist: 'Pink Floyd' });
  assert.deepEqual(guessFromPath('A/B/03. Song_Name.flac'), { title: 'Song Name', trackNo: 3, discNo: null, album: 'B', artist: 'A' });
  assert.deepEqual(guessFromPath('A/B/CD2/1-07 Late.flac'), { title: 'Late', trackNo: 7, discNo: 1, album: 'B', artist: 'A' });
  assert.deepEqual(guessFromPath('A/B/Disc 2/07 Late.flac'), { title: 'Late', trackNo: 7, discNo: 2, album: 'B', artist: 'A' });
  assert.deepEqual(guessFromPath('loose.flac'), { title: 'loose', trackNo: null, discNo: null, album: null, artist: null });
  assert.deepEqual(guessFromPath('Album/track.flac'), { title: 'track', trackNo: null, discNo: null, album: 'Album', artist: null });
});

test('makeTrack: tags win, the path fills the gaps', () => {
  const tagged = makeTrack('x/y/09 - z.flac', { size: 10, mtime: 5 }, {
    tags: { TITLE: ['Real Title'], ARTIST: ['A', 'B'], ALBUM: ['Real Album'], ALBUMARTIST: ['AA'], TRACKNUMBER: ['2/9'], DISCNUMBER: ['1/2'], DATE: ['c. 1973'], GENRE: ['Rock; Prog', 'rock'] },
    duration: 61.5,
    picture: { offset: 100, length: 50, mime: 'image/jpeg' },
  });
  assert.deepEqual(
    { ...tagged, v: undefined },
    {
      path: 'x/y/09 - z.flac', size: 10, mtime: 5, v: undefined, fmt: 'flac',
      title: 'Real Title', artist: 'A, B', album: 'Real Album', albumArtist: 'AA', compilation: false,
      trackNo: 2, discNo: 1, year: 1973, genres: ['Rock', 'Prog'], duration: 61.5, pic: { o: 100, l: 50, m: 'image/jpeg' }, guessed: [],
    },
  );

  const bare = makeTrack('Artist/Album/09 - Name.flac', {}, null);
  assert.equal(bare.title, 'Name');
  assert.equal(bare.artist, 'Artist');
  assert.equal(bare.album, 'Album');
  assert.equal(bare.albumArtist, null);
  assert.equal(bare.trackNo, 9);
  assert.equal(bare.duration, null);

  const loose = makeTrack('thing.ogg', {}, null);
  assert.equal(loose.artist, 'Unknown Artist');
  assert.equal(loose.album, 'Unknown Album');
});

test('makeTrack: odd numbering does not produce nonsense', () => {
  const t = makeTrack('a/b/c.flac', {}, { tags: { TRACKNUMBER: ['A1'], DISCNUMBER: ['0'], DATE: ['unknown'] } });
  assert.equal(t.trackNo, null);
  assert.equal(t.discNo, null);
  assert.equal(t.year, null);
});

test('makeTrack: a ripper\'s "unknown" stand-in tags count as missing, in several languages', () => {
  // What Windows Media Player (Finnish) writes when it cannot identify a CD.
  const fi = makeTrack('Bonnie Tyler/Super Hits/01 Total Eclipse Of The Heart.flac', {}, {
    tags: { TITLE: ['Raita 1'], ARTIST: ['Tuntematon esittäjä'], ALBUMARTIST: ['Tuntematon esittäjä'], ALBUM: ['Tuntematon albumi (26.9.2024 0.59.52)'], GENRE: ['Tuntematon tyylilaji'], TRACKNUMBER: ['1'] },
  });
  assert.deepEqual(
    { title: fi.title, artist: fi.artist, album: fi.album, albumArtist: fi.albumArtist, genres: fi.genres, trackNo: fi.trackNo, guessed: fi.guessed },
    { title: 'Total Eclipse Of The Heart', artist: 'Bonnie Tyler', album: 'Super Hits', albumArtist: null, genres: [], trackNo: 1, guessed: ['title', 'artist', 'album'] },
  );
  const en = makeTrack('x/y/03 - Song.flac', {}, { tags: { TITLE: ['Track 3'], ARTIST: ['Unknown Artist'], ALBUM: ['Unknown Album'], GENRE: ['Unknown genre', 'Rock'] } });
  assert.deepEqual([en.title, en.artist, en.album, en.genres, en.guessed], ['Song', 'x', 'y', ['Rock'], ['title', 'artist', 'album']]);

  // Real names that merely resemble the stand-ins are left alone.
  const fine = makeTrack('a/b/1.flac', {}, { tags: { TITLE: ['Track 12 Blues'], ARTIST: ['The Unknown Artist Collective'], ALBUM: ['Unknown Album Of Songs'] } });
  assert.deepEqual([fine.title, fine.artist, fine.album, fine.guessed], ['Track 12 Blues', 'The Unknown Artist Collective', 'Unknown Album Of Songs', []]);
});

test('makeTrack: "[Disc 2]" in the album name is a disc number, not a different album', () => {
  const of = (album, extra = {}) => {
    const t = makeTrack('a/b/01.flac', {}, { tags: { ALBUM: [album], ...extra } });
    return [t.album, t.discNo];
  };
  assert.deepEqual(of('Live 1975-85 [Disc 3]'), ['Live 1975-85', 3]);
  assert.deepEqual(of('Greatest Hits (CD 2)'), ['Greatest Hits', 2]);
  assert.deepEqual(of('Greatest Hits (disc 1)', { DISCNUMBER: ['4'] }), ['Greatest Hits', 4], 'an explicit disc tag wins');
  assert.deepEqual(of('The Ballad Hits [EP]'), ['The Ballad Hits [EP]', null]);
  assert.deepEqual(of('Disc 2'), ['Disc 2', null], 'nothing is left of the name, so it is kept');
  // From the folder name, when there are no tags at all.
  const untagged = makeTrack('Kaija Koo/Tuuleen Piirretyt Vuodet [Disc 2]/05 Laulu.flac', {}, null);
  assert.deepEqual([untagged.album, untagged.discNo], ['Tuuleen Piirretyt Vuodet', 2]);
});

test('splitGenres: splits on semicolons, de-duplicates, leaves slashes alone', () => {
  assert.deepEqual(splitGenres(['Rock;Pop ; rock', 'Hip-Hop/Rap']), ['Rock', 'Pop', 'Hip-Hop/Rap']);
  assert.deepEqual(splitGenres(undefined), []);
});

test('readTrack: end to end on a FLAC file, and on a file that is not what it claims', async () => {
  const flac = new File([buildFlac({ tags: { TITLE: 'T', ARTIST: 'Ar', ALBUM: 'Al', GENRE: 'Jazz' }, playable: true })], 'x.flac', { lastModified: 1234 });
  const track = await readTrack(flac, 'Ar/Al/01 - x.flac');
  assert.equal(track.title, 'T');
  assert.equal(track.mtime, 1234);
  assert.equal(track.size, flac.size);
  assert.deepEqual(track.genres, ['Jazz']);
  assert.ok(Math.abs(track.duration - 1.5) < 0.001);

  const fake = new File([new Uint8Array(500)], 'x.flac');
  const fallback = await readTrack(fake, 'Some Artist/Some Album/04 - Broken.flac');
  assert.equal(fallback.title, 'Broken');
  assert.equal(fallback.artist, 'Some Artist');
  assert.equal(fallback.duration, null);
});
