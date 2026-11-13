import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlayQueue } from '../app/js/queue.js';

const ids = (q) => q.items.map((e) => e.id);
const letters = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));

/** Deterministic stand-in for Math.random. */
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

test('plays through in order and stops at the end', () => {
  const q = new PlayQueue();
  assert.equal(q.current(), null);
  q.set(['a', 'b', 'c']);
  assert.equal(q.current().id, 'a');
  assert.equal(q.peekNext().id, 'b');
  assert.equal(q.next({ auto: true }).id, 'b');
  assert.equal(q.next({ auto: true }).id, 'c');
  assert.equal(q.peekNext(), null);
  assert.equal(q.next({ auto: true }), null);
  assert.equal(q.current().id, 'c', 'stays on the last track when there is nothing after it');
});

test('starts at the chosen track; previous steps back and stops at the first', () => {
  const q = new PlayQueue();
  q.set(['a', 'b', 'c'], 2);
  assert.equal(q.current().id, 'c');
  assert.equal(q.prev().id, 'b');
  assert.equal(q.prev().id, 'a');
  assert.equal(q.prev().id, 'a');
  q.set(['a', 'b'], 99);
  assert.equal(q.current().id, 'b', 'an out-of-range start is clamped');
});

test('repeat all wraps around in both directions', () => {
  const q = new PlayQueue();
  q.set(['a', 'b']);
  q.repeat = 'all';
  q.next();
  assert.equal(q.next({ auto: true }).id, 'a');
  assert.equal(q.prev().id, 'b');
});

test('repeat one replays when a track ends, but a manual skip still moves on', () => {
  const q = new PlayQueue();
  q.set(['a', 'b']);
  q.repeat = 'one';
  assert.equal(q.peekNext({ auto: true }).id, 'a');
  assert.equal(q.next({ auto: true }).id, 'a');
  assert.equal(q.next({ auto: false }).id, 'b');
});

test('cycleRepeat goes off -> all -> one -> off', () => {
  const q = new PlayQueue();
  assert.deepEqual([q.cycleRepeat(), q.cycleRepeat(), q.cycleRepeat()], ['all', 'one', 'off']);
});

test('shuffle play: every track exactly once, in a different order', () => {
  const q = new PlayQueue({ random: seeded(7) });
  q.setShuffle(true);
  const all = letters(20);
  q.set(all);
  assert.deepEqual(ids(q).slice().sort(), all);
  assert.notDeepEqual(ids(q), all);
  assert.equal(q.index, 0);
});

test('shuffle with a chosen track: that track plays first', () => {
  const q = new PlayQueue({ random: seeded(3) });
  q.setShuffle(true);
  q.set(letters(10), 6);
  assert.equal(q.current().id, 'g');
  assert.equal(q.index, 0);
  assert.deepEqual(ids(q).slice().sort(), letters(10));
});

test('turning shuffle on mid-queue keeps history and the current track; turning it off restores the order', () => {
  const q = new PlayQueue({ random: seeded(11) });
  const all = letters(12);
  q.set(all, 3);
  q.setShuffle(true);
  assert.deepEqual(ids(q).slice(0, 4), ['a', 'b', 'c', 'd'], 'played part is untouched');
  assert.equal(q.current().id, 'd');
  assert.deepEqual(ids(q).slice(4).sort(), all.slice(4));
  assert.notDeepEqual(ids(q).slice(4), all.slice(4));

  q.next();
  q.next();
  const playing = q.current().id;
  q.setShuffle(false);
  assert.deepEqual(ids(q), all);
  assert.equal(q.current().id, playing, 'the playing track stays the playing track');
});

test('add appends; addNext inserts after the current track - also while shuffled', () => {
  const q = new PlayQueue({ random: seeded(5) });
  q.set(['a', 'b', 'c'], 1);
  q.add(['x']);
  q.addNext(['n1', 'n2']);
  assert.deepEqual(ids(q), ['a', 'b', 'n1', 'n2', 'c', 'x']);
  assert.equal(q.current().id, 'b');

  q.setShuffle(true);
  q.addNext(['soon']);
  assert.equal(q.peekNext().id, 'soon');
  q.add(['later']);
  assert.equal(ids(q).at(-1), 'later');
  q.setShuffle(false);
  assert.deepEqual(ids(q), ['a', 'b', 'soon', 'n1', 'n2', 'c', 'x', 'later']);
});

test('adding to an empty queue makes the first track current', () => {
  const q = new PlayQueue();
  q.add(['a', 'b']);
  assert.equal(q.current().id, 'a');
  const q2 = new PlayQueue();
  q2.addNext(['z']);
  assert.equal(q2.current().id, 'z');
});

test('remove keeps the current track current, and reports removing the current one', () => {
  const q = new PlayQueue();
  q.set(['a', 'b', 'c', 'd'], 2);
  assert.equal(q.remove(0), false);
  assert.equal(q.current().id, 'c');
  assert.equal(q.remove(2), false);
  assert.equal(q.current().id, 'c');
  assert.equal(q.remove(1), true);
  assert.equal(q.current().id, 'b', 'falls back to the new last entry');
  assert.equal(q.remove(0), true);
  assert.equal(q.current(), null);
  assert.equal(q.index, -1);
  assert.equal(q.remove(5), false);
});

test('the same track can be queued twice and the copies stay distinct', () => {
  const q = new PlayQueue({ random: seeded(2) });
  q.set(['a', 'a', 'b'], 1);
  q.setShuffle(true);
  q.setShuffle(false);
  assert.deepEqual(ids(q), ['a', 'a', 'b']);
  assert.equal(q.index, 1, 'still on the second copy');
});

test('move reorders and follows the current track', () => {
  const q = new PlayQueue();
  q.set(['a', 'b', 'c', 'd'], 1);
  q.move(3, 0);
  assert.deepEqual(ids(q), ['d', 'a', 'b', 'c']);
  assert.equal(q.current().id, 'b');
  q.move(2, 0);
  assert.equal(q.index, 0);
  q.move(0, 9);
  assert.deepEqual(ids(q), ['b', 'd', 'a', 'c'], 'out-of-range moves are ignored');
});

test('prune drops vanished tracks and keeps the position sensible', () => {
  const q = new PlayQueue();
  q.set(['a', 'b', 'c', 'd', 'e'], 2);
  assert.equal(q.prune((id) => id !== 'a' && id !== 'e'), true);
  assert.deepEqual(ids(q), ['b', 'c', 'd']);
  assert.equal(q.current().id, 'c');

  assert.equal(q.prune((id) => id !== 'c'), false, 'reports that the current track is gone');
  assert.deepEqual(ids(q), ['b', 'd']);
  assert.equal(q.current().id, 'd', 'moves on to what would have played next');

  q.prune(() => false);
  assert.equal(q.current(), null);
});

test('survives a save/restore round trip, including the un-shuffled order', () => {
  const q = new PlayQueue({ random: seeded(9) });
  q.set(letters(8), 2);
  q.setShuffle(true);
  q.repeat = 'all';
  q.next();
  const saved = JSON.parse(JSON.stringify(q.toJSON()));

  const r = new PlayQueue();
  r.restore(saved);
  assert.deepEqual(ids(r), ids(q));
  assert.equal(r.current().id, q.current().id);
  assert.equal(r.repeat, 'all');
  assert.equal(r.shuffle, true);
  r.setShuffle(false);
  assert.deepEqual(ids(r), letters(8));
});

test('restore tolerates missing and damaged data', () => {
  const q = new PlayQueue();
  for (const bad of [null, undefined, {}, { items: 'nope' }, { items: [] }]) {
    q.restore(bad);
    assert.equal(q.current(), null);
  }
  q.restore({ items: ['a', 'b'], index: 7, repeat: 'sideways', shuffle: true, original: [5, 5] });
  assert.equal(q.current().id, 'b');
  assert.equal(q.repeat, 'off');
  q.setShuffle(false);
  assert.deepEqual(ids(q).slice().sort(), ['a', 'b']);
});
