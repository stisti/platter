// Audio playback. Owns the play queue and two <audio> elements: one playing,
// one standing by with the next track already loaded so that albums play
// through without an audible pause between tracks.
//
// Files are opened from the drive only at the moment they are needed, so every
// load can fail because the drive is gone. Such failures pause playback and
// keep the position; they never clear the queue.

import { PlayQueue } from './queue.js';

const PRELOAD_SECONDS = 12;
const MAX_CONSECUTIVE_FAILURES = 3;

export class Player extends EventTarget {
  /**
   * @param {object} options
   * @param {{getFile(path: string): Promise<File>}} options.source
   * @param {(id: string) => object|undefined} options.getTrack  looks a track up in the library
   */
  constructor({ source, getTrack }) {
    super();
    this.source = source;
    this.getTrack = getTrack;
    this.queue = new PlayQueue();
    /** @type {'idle'|'loading'|'playing'|'paused'} */
    this.state = 'idle';
    this._els = [new Audio(), new Audio()];
    this._active = 0;
    /** What the active element holds: { uid, url } */
    this._loaded = null;
    /** What the standby element holds: { uid, url, ready } */
    this._preload = null;
    /** Where to start when the current track gets (re)loaded. */
    this._resumeAt = 0;
    this._token = 0;
    this._failures = 0;
    this._volume = 1;
    this._muted = false;

    for (const el of this._els) {
      el.preload = 'auto';
      el.addEventListener('playing', () => this._isActive(el) && this._setState('playing'));
      el.addEventListener('pause', () => {
        // 'pause' also fires when a track ends; _onEnded decides what happens then.
        if (this._isActive(el) && !el.ended && this.state === 'playing') this._setState('paused');
      });
      el.addEventListener('waiting', () => this._isActive(el) && this.state === 'playing' && this._emit('timeupdate'));
      el.addEventListener('timeupdate', () => this._isActive(el) && this._onTimeUpdate());
      el.addEventListener('durationchange', () => this._isActive(el) && this._onDuration());
      el.addEventListener('ended', () => this._isActive(el) && this._onEnded());
      el.addEventListener('error', () => {
        if (this._isActive(el)) this._onMediaError();
        else if (this._preload) this._preload.ready = false;
      });
    }
  }

  // ---------------------------------------------------------------- state

  get el() {
    return this._els[this._active];
  }

  _isActive(el) {
    return el === this._els[this._active];
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this._emit('statechange');
  }

  /** The track at the queue position (playing, paused, or about to load). */
  get track() {
    const entry = this.queue.current();
    return entry ? this.getTrack(entry.id) ?? null : null;
  }

  get currentTime() {
    return this._isCurrentLoaded() ? this.el.currentTime : this._resumeAt;
  }

  get duration() {
    const d = this._isCurrentLoaded() ? this.el.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : this.track?.duration ?? 0;
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    for (const el of this._els) el.volume = this._volume;
    this._emit('volumechange');
  }

  get muted() {
    return this._muted;
  }

  set muted(m) {
    this._muted = Boolean(m);
    for (const el of this._els) el.muted = this._muted;
    this._emit('volumechange');
  }

  _isCurrentLoaded() {
    const entry = this.queue.current();
    return Boolean(entry && this._loaded && this._loaded.uid === entry.uid && !this.el.error);
  }

  // ------------------------------------------------------------- commands

  /** Replaces the queue with `ids` and starts playing. */
  playQueue(ids, startIndex = null) {
    this.queue.set(ids, startIndex);
    this._failures = 0;
    this._emit('queuechange');
    return this._loadCurrent({ autoplay: true });
  }

  enqueue(ids, { next = false } = {}) {
    const wasEmpty = this.queue.length === 0;
    if (next) this.queue.addNext(ids);
    else this.queue.add(ids);
    this._dropPreload();
    this._emit('queuechange');
    if (wasEmpty) {
      this._resumeAt = 0;
      this._emit('trackchange');
      this._setState('paused');
    }
  }

  async play() {
    if (!this.queue.current()) return;
    if (this._isCurrentLoaded()) {
      try {
        await this.el.play();
      } catch (err) {
        this._onPlayRejected(err);
      }
    } else {
      this._failures = 0;
      await this._loadCurrent({ autoplay: true, position: this._resumeAt });
    }
  }

  pause() {
    if (this.state === 'loading') {
      // Cancel the pending start; stay on the same track.
      this._token++;
      this.el.pause();
      this._setState('paused');
    } else {
      this.el.pause();
    }
  }

  toggle() {
    if (this.state === 'playing' || this.state === 'loading') this.pause();
    else this.play();
  }

  next() {
    if (!this.queue.next({ auto: false })) return;
    this._failures = 0;
    this._loadCurrent({ autoplay: true });
  }

  /** Like every player: back to the start of the track first, previous track on a second press. */
  prev() {
    if (!this.queue.current()) return;
    if (this.currentTime > 3) {
      this.seek(0);
      return;
    }
    this.queue.prev();
    this._failures = 0;
    this._loadCurrent({ autoplay: true });
  }

  jump(index) {
    if (!this.queue.jump(index)) return;
    this._failures = 0;
    this._loadCurrent({ autoplay: true });
  }

  seek(seconds) {
    const t = Math.max(0, Math.min(seconds, this.duration || seconds));
    if (this._isCurrentLoaded()) this.el.currentTime = t;
    else this._resumeAt = t;
    this._emit('timeupdate');
  }

  removeFromQueue(index) {
    const wasCurrent = this.queue.remove(index);
    this._dropPreload();
    this._emit('queuechange');
    if (!wasCurrent) return;
    if (this.queue.current()) {
      this._loadCurrent({ autoplay: this.state === 'playing' || this.state === 'loading' });
    } else {
      this._stop();
    }
  }

  moveInQueue(from, to) {
    this.queue.move(from, to);
    this._dropPreload();
    this._emit('queuechange');
  }

  clearQueue() {
    this.queue.clear();
    this._emit('queuechange');
    this._stop();
  }

  setShuffle(on) {
    this.queue.setShuffle(on);
    this._dropPreload();
    this._emit('queuechange');
  }

  cycleRepeat() {
    this.queue.cycleRepeat();
    this._dropPreload();
    this._emit('queuechange');
  }

  /** After a rescan: forget queue entries whose files are gone. */
  pruneQueue() {
    const before = this.queue.length;
    const currentSurvived = this.queue.prune((id) => Boolean(this.getTrack(id)));
    if (this.queue.length === before) return;
    this._dropPreload();
    this._emit('queuechange');
    if (currentSurvived) return;
    if (this.queue.current()) this._loadCurrent({ autoplay: this.state === 'playing' });
    else this._stop();
  }

  // ---------------------------------------------------------- persistence

  snapshot() {
    return { queue: this.queue.toJSON(), position: this.currentTime };
  }

  /** Restores a saved session, paused. Nothing is read from the drive until play. */
  restore(saved) {
    if (!saved?.queue) return;
    this.queue.restore(saved.queue);
    this._resumeAt = Number(saved.position) || 0;
    this._emit('queuechange');
    if (this.queue.current()) {
      this._emit('trackchange');
      this._setState('paused');
    }
  }

  // ------------------------------------------------------------ internals

  _release(holder) {
    if (holder?.url) URL.revokeObjectURL(holder.url);
  }

  _dropPreload() {
    if (!this._preload) return;
    const standby = this._els[this._active ^ 1];
    standby.removeAttribute('src');
    standby.load();
    this._release(this._preload);
    this._preload = null;
  }

  _unloadActive() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this._release(this._loaded);
    this._loaded = null;
  }

  _stop() {
    this._token++;
    this._dropPreload();
    this._unloadActive();
    this._resumeAt = 0;
    this._emit('trackchange');
    this._setState(this.queue.current() ? 'paused' : 'idle');
  }

  async _loadCurrent({ autoplay = true, position = 0 } = {}) {
    const entry = this.queue.current();
    if (!entry) {
      this._stop();
      return;
    }
    const token = ++this._token;
    this._dropPreload();
    this._unloadActive();
    this._resumeAt = position;
    this._emit('trackchange');

    const track = this.getTrack(entry.id);
    if (!track) {
      this._onTrackFailed('missing-file', null);
      return;
    }
    if (autoplay) this._setState('loading');

    let file;
    try {
      file = await this.source.getFile(track.path);
    } catch (err) {
      if (token === this._token) this._onLoadFailed(err, track);
      return;
    }
    if (token !== this._token) return; // the user moved on while the file was opening

    const url = URL.createObjectURL(file);
    this._loaded = { uid: entry.uid, url };
    const el = this.el;
    el.src = url;
    if (position > 0) el.currentTime = position;
    if (!autoplay) {
      this._setState('paused');
      return;
    }
    try {
      await el.play();
    } catch (err) {
      if (token === this._token) this._onPlayRejected(err);
    }
  }

  _onPlayRejected(err) {
    // AbortError: superseded by another load or a pause. NotSupportedError:
    // the element's own 'error' event reports it.
    if (err?.name === 'NotAllowedError') {
      this._setState('paused');
      this._emit('error', { kind: 'blocked' });
    }
  }

  _onLoadFailed(err, track) {
    const code = err?.code;
    if (code === 'missing-file') this._onTrackFailed('missing-file', track);
    else this._onDriveFailed(code ?? 'disconnected');
  }

  /** The drive (or permission to read it) is gone: stay put and wait for the user. */
  _onDriveFailed(state) {
    this._token++;
    this._dropPreload();
    this._setState('paused');
    this._emit('error', { kind: 'drive', state });
  }

  /** This one track cannot be played: say so and move on, within reason. */
  _onTrackFailed(reason, track) {
    this._failures++;
    this._emit('error', { kind: 'track', reason, track });
    const hasNext = this.queue.peekNext({ auto: false }) !== null;
    if (this._failures >= MAX_CONSECUTIVE_FAILURES || !hasNext) {
      this._token++;
      this._setState('paused');
      return;
    }
    this.queue.next({ auto: false });
    this._loadCurrent({ autoplay: true });
  }

  async _onMediaError() {
    const el = this.el;
    const position = el.currentTime || this._resumeAt;
    const track = this.track;
    const token = this._token;
    // A decode error and an unplugged drive look alike to <audio>; ask the source which it is.
    let state = 'connected';
    try {
      state = await this.source.check();
    } catch {
      state = 'disconnected';
    }
    if (token !== this._token) return;
    if (state === 'connected') {
      this._onTrackFailed('unplayable', track);
    } else {
      // Drop the dead stream but remember where it was, so that play picks the
      // song up from the same spot once the drive is back.
      this._unloadActive();
      this._resumeAt = position;
      this._emit('timeupdate');
      this._onDriveFailed(state);
    }
  }

  _onTimeUpdate() {
    this._emit('timeupdate');
    const el = this.el;
    if (this._preload || this.state !== 'playing' || !Number.isFinite(el.duration)) return;
    if (el.duration - el.currentTime > PRELOAD_SECONDS) return;
    const upcoming = this.queue.peekNext({ auto: true });
    if (upcoming) this._prepare(upcoming);
  }

  /** Loads the upcoming track into the standby element. Failure is fine: it just means a normal load later. */
  async _prepare(entry) {
    const holder = { uid: entry.uid, url: null, ready: false };
    this._preload = holder;
    const track = this.getTrack(entry.id);
    if (!track) return;
    try {
      const file = await this.source.getFile(track.path);
      if (this._preload !== holder) return;
      holder.url = URL.createObjectURL(file);
      const standby = this._els[this._active ^ 1];
      standby.src = holder.url;
      standby.load();
      holder.ready = true;
    } catch {
      // leave holder.ready false
    }
  }

  _onDuration() {
    const track = this.track;
    const d = this.el.duration;
    if (track && Number.isFinite(d) && d > 0 && this._isCurrentLoaded() && !track.duration) {
      this._emit('durationknown', { track, duration: d });
    }
    this._emit('timeupdate');
  }

  _onEnded() {
    const entry = this.queue.next({ auto: true });
    if (!entry) {
      // End of the queue: rewind to its start and wait.
      this.queue.jump(0);
      this._stop();
      return;
    }
    this._failures = 0;
    const pre = this._preload;
    if (pre && pre.ready && pre.uid === entry.uid) {
      // Swap elements: the standby one already has the track buffered.
      const finished = this._loaded;
      const old = this.el;
      this._token++;
      this._active ^= 1;
      this._loaded = { uid: pre.uid, url: pre.url };
      this._preload = null;
      this._resumeAt = 0;
      old.removeAttribute('src');
      old.load();
      this._release(finished);
      this._emit('trackchange');
      this.el.play().catch((err) => this._onPlayRejected(err));
    } else {
      this._loadCurrent({ autoplay: true });
    }
  }
}
