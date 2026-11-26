import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BANDS, MAX_GAIN, PRESETS, defaultEq, clampGain, normalizeEq, matchPreset, isFlat, bandLabel,
  responseDb, headroomDb, curveFrequencies,
} from '../app/js/eq.js';

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? ''} expected ${expected} ± ${tolerance}, got ${actual}`);

const only = (band, gain) => BANDS.map((_, i) => (i === band ? gain : 0));

test('the default is off and flat', () => {
  assert.deepEqual(defaultEq(), { enabled: false, gains: BANDS.map(() => 0) });
});

test('saved settings are made safe: wrong types, wrong lengths, out of range', () => {
  assert.deepEqual(normalizeEq(undefined), defaultEq());
  assert.deepEqual(normalizeEq('junk'), defaultEq());
  assert.deepEqual(normalizeEq({ enabled: 'yes', gains: 'loud' }), defaultEq(), 'only a real true turns it on');
  const eq = normalizeEq({ enabled: true, gains: [3, '2.5', null, 40, -40, 1.3, NaN] });
  assert.equal(eq.enabled, true);
  assert.equal(eq.gains.length, BANDS.length, 'missing bands are filled in');
  assert.deepEqual(eq.gains, [3, 2.5, 0, MAX_GAIN, -MAX_GAIN, 1.5, 0, 0, 0, 0]);
  assert.equal(normalizeEq({ gains: new Array(20).fill(1) }).gains.length, BANDS.length, 'extra bands are dropped');
});

test('gains snap to half-dB steps, and never come out as -0', () => {
  assert.equal(clampGain(0.74), 0.5);
  assert.equal(clampGain(0.76), 1);
  assert.ok(Object.is(clampGain(-0.1), 0));
});

test('presets are well-formed, distinct, and recognised from their gains', () => {
  const ids = new Set();
  for (const preset of PRESETS) {
    assert.equal(preset.gains.length, BANDS.length, preset.id);
    assert.deepEqual(preset.gains.map(clampGain), preset.gains, `${preset.id}: gains on the slider steps and in range`);
    assert.ok(!ids.has(preset.id));
    ids.add(preset.id);
    assert.equal(matchPreset([...preset.gains]), preset.id);
  }
  assert.equal(matchPreset(only(4, 1)), null, 'anything else is custom');
  assert.equal(matchPreset(BANDS.map(() => 0)), 'flat');
  assert.ok(isFlat(BANDS.map(() => 0)));
  assert.ok(!isFlat(only(9, -1)));
});

test('band labels', () => {
  assert.deepEqual(BANDS.map(bandLabel), ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
});

test('flat changes nothing at any frequency', () => {
  for (const f of curveFrequencies(50)) assert.equal(responseDb(BANDS.map(() => 0), f), 0);
});

test('a band boosts or cuts its own frequency by exactly its gain, and far-off frequencies hardly at all', () => {
  for (const [band, gain] of [[0, 6], [5, -9], [9, 12]]) {
    near(responseDb(only(band, gain), BANDS[band]), gain, 1e-9, `band ${BANDS[band]} Hz at its centre:`);
  }
  near(responseDb(only(5, 12), 1000), 12, 1e-9);
  near(responseDb(only(5, 12), 30), 0, 0.1, '1 kHz bell at 30 Hz:');
  near(responseDb(only(0, 12), 10000), 0, 0.01, '31 Hz bell at 10 kHz:');
  // One octave away, a √2-Q bell has dropped to well under half its gain (in dB).
  const octave = responseDb(only(5, 12), 2000);
  assert.ok(octave > 1 && octave < 6, `1 kHz bell at 2 kHz: ${octave}`);
});

test('a cut is the mirror image of the same boost', () => {
  for (const f of [100, 440, 1000, 3000, 12000]) near(responseDb(only(5, -8), f), -responseDb(only(5, 8), f), 1e-9);
});

test('bands at or above the Nyquist frequency are skipped', () => {
  // At a 22.05 kHz sample rate Nyquist is 11 kHz: the 16 kHz band cannot exist.
  assert.equal(responseDb(only(9, 12), 1000, 22050), 0);
  assert.equal(headroomDb(only(9, 12), 22050), 0);
});

test('headroom: nothing when nothing is boosted, the peak of the curve when something is', () => {
  assert.equal(headroomDb(BANDS.map(() => 0)), 0);
  assert.equal(headroomDb(BANDS.map(() => -6)), 0, 'cuts need no headroom');
  near(headroomDb(only(3, 6)), 6, 0.01, 'one band:');
  // Neighbouring boosts overlap, so together they peak higher than either.
  const both = BANDS.map((_, i) => (i === 3 || i === 4 ? 6 : 0));
  assert.ok(headroomDb(both) > 6.5, `two neighbours at +6: ${headroomDb(both)}`);
  // Whatever the setting, after the headroom no frequency comes out louder than it went in.
  for (const preset of PRESETS) {
    const room = headroomDb(preset.gains);
    for (const f of curveFrequencies(300)) assert.ok(responseDb(preset.gains, f) - room <= 0.01, `${preset.id} at ${f} Hz`);
  }
});
