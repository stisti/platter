// The play queue: an ordered list of tracks with a current position, shuffle
// and repeat. Pure logic with no audio or DOM, so it can be tested on its own.

let uidCounter = 0;
const nextUid = () => ++uidCounter;

function shuffleInPlace(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export const REPEAT_MODES = ['off', 'all', 'one'];

export class PlayQueue {
  constructor({ random = Math.random } = {}) {
    this._random = random;
    /** Entries in play order. `uid` tells apart two entries for the same track. */
    this.items = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    /** The un-shuffled order, kept while shuffle is on so it can be restored. */
    this._original = null;
  }

  get length() {
    return this.items.length;
  }

  current() {
    return this.items[this.index] ?? null;
  }

  /**
   * Replaces the queue. With shuffle on, an explicitly chosen start track
   * (`startIndex` given) plays first and the rest is shuffled behind it;
   * otherwise the whole list is shuffled.
   */
  set(ids, startIndex = null) {
    const entries = ids.map((id) => ({ uid: nextUid(), id }));
    if (!entries.length) {
      this.clear();
      return null;
    }
    if (this.shuffle) {
      this._original = entries.slice();
      if (startIndex !== null && entries[startIndex]) {
        const [first] = entries.splice(startIndex, 1);
        shuffleInPlace(entries, this._random);
        entries.unshift(first);
      } else {
        shuffleInPlace(entries, this._random);
      }
      this.items = entries;
      this.index = 0;
    } else {
      this._original = null;
      this.items = entries;
      this.index = Math.min(Math.max(startIndex ?? 0, 0), entries.length - 1);
    }
    return this.current();
  }

  clear() {
    this.items = [];
    this._original = null;
    this.index = -1;
  }

  setShuffle(on) {
    on = Boolean(on);
    if (on === this.shuffle) return;
    this.shuffle = on;
    const current = this.current();
    if (on) {
      // Keep what has played and what is playing; shuffle only what is still to come.
      this._original = this.items.slice();
      const upcoming = shuffleInPlace(this.items.slice(this.index + 1), this._random);
      this.items = this.items.slice(0, this.index + 1).concat(upcoming);
    } else if (this._original) {
      this.items = this._original;
      this._original = null;
      if (current) this.index = this.items.indexOf(current);
    }
  }

  cycleRepeat() {
    this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    return this.repeat;
  }

  _nextIndex(auto) {
    if (!this.items.length) return -1;
    if (auto && this.repeat === 'one' && this.index >= 0) return this.index;
    if (this.index + 1 < this.items.length) return this.index + 1;
    return this.repeat === 'all' ? 0 : -1;
  }

  /** What would play next, without moving. */
  peekNext({ auto = true } = {}) {
    return this.items[this._nextIndex(auto)] ?? null;
  }

  /**
   * Advances. `auto` means the track ended by itself (so repeat-one replays
   * it); a manual skip always moves on. Returns null at the end of the queue.
   */
  next({ auto = false } = {}) {
    const i = this._nextIndex(auto);
    if (i < 0) return null;
    this.index = i;
    return this.current();
  }

  prev() {
    if (!this.items.length) return null;
    if (this.index > 0) this.index--;
    else if (this.repeat === 'all') this.index = this.items.length - 1;
    return this.current();
  }

  jump(index) {
    if (index < 0 || index >= this.items.length) return null;
    this.index = index;
    return this.current();
  }

  /** Appends to the end of the queue. */
  add(ids) {
    const entries = ids.map((id) => ({ uid: nextUid(), id }));
    this.items.push(...entries);
    this._original?.push(...entries);
    if (this.index < 0 && this.items.length) this.index = 0;
    return entries;
  }

  /** Inserts right after the current track. */
  addNext(ids) {
    const entries = ids.map((id) => ({ uid: nextUid(), id }));
    const current = this.current();
    this.items.splice(this.index + 1, 0, ...entries);
    if (this._original) {
      const at = current ? this._original.indexOf(current) + 1 : 0;
      this._original.splice(at, 0, ...entries);
    }
    if (this.index < 0 && this.items.length) this.index = 0;
    return entries;
  }

  /** Removes one entry. Returns true when it was the current one. */
  remove(index) {
    const entry = this.items[index];
    if (!entry) return false;
    this.items.splice(index, 1);
    if (this._original) {
      const at = this._original.indexOf(entry);
      if (at >= 0) this._original.splice(at, 1);
    }
    const wasCurrent = index === this.index;
    if (index < this.index) this.index--;
    if (this.index >= this.items.length) this.index = this.items.length - 1;
    return wasCurrent;
  }

  move(from, to) {
    if (from === to || !this.items[from] || to < 0 || to >= this.items.length) return;
    const current = this.current();
    const [entry] = this.items.splice(from, 1);
    this.items.splice(to, 0, entry);
    this.index = this.items.indexOf(current);
  }

  /** Drops entries whose track no longer exists (after a rescan removed files). */
  prune(exists) {
    const current = this.current();
    const keep = (entry) => exists(entry.id);
    const currentSurvives = current ? keep(current) : false;
    let fallbackIndex = this.index;
    if (current && !currentSurvives) {
      fallbackIndex = this.items.slice(0, this.index).filter(keep).length;
    }
    this.items = this.items.filter(keep);
    if (this._original) this._original = this._original.filter(keep);
    if (!this.items.length) this.index = -1;
    else if (currentSurvives) this.index = this.items.indexOf(current);
    else this.index = Math.min(fallbackIndex, this.items.length - 1);
    return !current || currentSurvives;
  }

  toJSON() {
    return {
      items: this.items.map((e) => e.id),
      index: this.index,
      shuffle: this.shuffle,
      repeat: this.repeat,
      original: this._original
        ? this._original.map((e) => this.items.indexOf(e))
        : null,
    };
  }

  /** Restores a queue saved with toJSON(). Tolerates missing or damaged data. */
  restore(data) {
    this.clear();
    if (!data || !Array.isArray(data.items)) return;
    this.items = data.items.map((id) => ({ uid: nextUid(), id }));
    this.index = this.items.length
      ? Math.min(Math.max(Number(data.index) || 0, 0), this.items.length - 1)
      : -1;
    this.shuffle = Boolean(data.shuffle);
    this.repeat = REPEAT_MODES.includes(data.repeat) ? data.repeat : 'off';
    if (this.shuffle) {
      const order = Array.isArray(data.original) ? data.original.map((i) => this.items[i]) : null;
      const valid = order && order.length === this.items.length && order.every(Boolean) && new Set(order).size === order.length;
      this._original = valid ? order : this.items.slice();
    }
  }
}
