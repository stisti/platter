import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GENRE_FAMILIES, familiesOf } from '../app/js/genres.js';
import { keyOf } from '../app/js/library.js';

test('a genre is in its own family first, then in the broader ones', () => {
  assert.deepEqual(familiesOf('Classic Rock'), ['classic rock', 'rock']);
  assert.deepEqual(familiesOf('Metal & Hard Rock'), ['metal & hard rock', 'rock', 'metal']);
  assert.deepEqual(familiesOf('  INDIE /  Alternative '), ['indie / alternative', 'alternative', 'rock'], 'looked up by keyOf()');
});

test('a genre the mapping does not know is still in a family: its own', () => {
  assert.deepEqual(familiesOf('Miscellaneous'), ['miscellaneous']);
  assert.deepEqual(familiesOf('Rock'), ['rock'], 'a family name used as a genre is not listed twice');
  assert.deepEqual(familiesOf(''), []);
});

test('Finnish genre names from Windows Media Player land in the right families', () => {
  assert.ok(familiesOf('Soundtrackit').includes('soundtrack'));
  assert.ok(familiesOf('Maailmanmusiikki').includes('world'));
  assert.ok(familiesOf('Laulaja-lauluntekijä').includes('singer-songwriter'));
  assert.ok(familiesOf('Espanjankielinen pop').includes('pop'));
});

test('the mapping is keyed and valued in keyOf() form, without repeats', () => {
  for (const [genre, families] of Object.entries(GENRE_FAMILIES)) {
    assert.equal(genre, keyOf(genre), `key "${genre}"`);
    assert.ok(families.length > 0, `"${genre}" has families`);
    for (const family of families) assert.equal(family, keyOf(family), `family "${family}" of "${genre}"`);
    assert.equal(new Set(families).size, families.length, `"${genre}" lists a family twice`);
  }
});
