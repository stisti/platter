// The equalizer's sound path: both of the player's <audio> elements feed one
// chain of Web Audio filters, one per band, on the way to the speakers.
//
//   <audio> A ─┐
//   <audio> B ─┴─→ headroom (gain) → 31 Hz → 62 Hz → … → 16 kHz → speakers
//
// The browser computes the filtered samples; this module only builds the chain
// and sets each filter's gain from the settings (eq.js). Track changes are
// untouched: the player still swaps between its two elements, and the chain
// filters whatever comes in.
//
// Three things to know:
// - Nothing is built until the equalizer is first switched on. Until then the
//   elements play straight to the speakers, as they always did. Once built,
//   the chain stays for the life of the page (an element connected to Web
//   Audio cannot be disconnected); switching off sets every gain to 0 dB,
//   which passes the sound through unchanged.
// - Browsers only let a page start sound after the user has clicked or typed
//   on it. An AudioContext made before that starts "suspended", and so does
//   one the system stopped (sleep, audio device changes). The player calls
//   wake() before every play. If the context still isn't running while music
//   plays, the elements would play silently with the progress bar moving, so
//   the 'silent' event tells the player to pause and say so instead.
// - set() fires 'change'; the panel, the player bar and the saved
//   preferences follow it.
// - When nothing has played for a while the context is suspended, so that an
//   idle Platter doesn't keep the audio device busy.

import { BANDS, BAND_Q, defaultEq, headroomDb, normalizeEq } from './eq.js';

/** Seconds over which a gain change glides, so that moving a slider doesn't click. */
const GLIDE = 0.03;
/** Suspend the context after this long with nothing playing. */
const IDLE_SUSPEND_MS = 20000;
/** How long wake() waits for the context to start before letting play go ahead. */
const WAKE_WAIT_MS = 600;
/** Playing for this long without a running context means the music is silent. */
const SILENCE_CHECK_MS = 2000;

/** @import { EqSettings } from './eq.js' */

export class Equalizer extends EventTarget {
  /** @param {HTMLMediaElement[]} elements the player's audio elements */
  constructor(elements) {
    super();
    this._els = elements;
    /** @type {EqSettings} */
    this.settings = defaultEq();
    /** @type {AudioContext|null} built on first use; null while the elements play directly */
    this.context = null;
    /** @type {GainNode|null} the start of the chain: turns the music down by the headroom */
    this.input = null;
    /** @type {BiquadFilterNode[]} */
    this.filters = [];
    /** @type {AudioNode|null} the end of the chain (tests listen here) */
    this.output = null;
    /** Set when building the chain failed: the music then plays without it. */
    this.unavailable = false;
    this._idleTimer = 0;
    this._silenceTimer = 0;

    for (const el of elements) {
      el.addEventListener('playing', () => this._onPlaying());
      el.addEventListener('pause', () => this._onPaused());
      el.addEventListener('ended', () => this._onPaused());
    }
  }

  /** Whether the music currently goes through the filters. */
  get routed() {
    return this.context !== null;
  }

  /**
   * New settings (from the equalizer panel or saved preferences). Changes
   * while music plays glide in; switching on for the first time while music
   * plays builds the chain right away (the user just clicked, so the browser
   * lets it start).
   * @param {EqSettings} settings
   */
  set(settings) {
    this.settings = normalizeEq(settings);
    if (this.context) this._apply();
    else if (this.settings.enabled && this._anyPlaying()) this._build();
    this.dispatchEvent(new Event('change'));
  }

  /**
   * Called before every play: builds the chain if the equalizer is on, and
   * makes sure the context runs. Resolves when it does, or after a short wait
   * (a context the browser won't start yet never resolves its resume()).
   */
  async wake() {
    clearTimeout(this._idleTimer);
    if (!this.context) {
      if (!this.settings.enabled || this.unavailable) return;
      this._build();
      if (!this.context) return;
    }
    if (this.context.state === 'running') return;
    const resumed = this.context.resume().catch(() => {});
    await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, WAKE_WAIT_MS))]);
  }

  // ------------------------------------------------------------ internals

  _anyPlaying() {
    return this._els.some((el) => !el.paused && !el.ended);
  }

  _build() {
    let context;
    try {
      context = new AudioContext({ latencyHint: 'playback' });
      this.input = new GainNode(context);
      this.filters = BANDS.map((frequency) => new BiquadFilterNode(context, { type: 'peaking', frequency, Q: BAND_Q, gain: 0 }));
      /** @type {AudioNode} */
      let node = this.input;
      for (const filter of this.filters) node = node.connect(filter);
      node.connect(context.destination);
      this.output = node;
      for (const el of this._els) context.createMediaElementSource(el).connect(this.input);
    } catch (err) {
      // No Web Audio, or it refused: play on without the equalizer.
      console.warn('Equalizer unavailable:', err);
      this.unavailable = true;
      context?.close().catch(() => {});
      this.input = this.output = null;
      this.filters = [];
      this.dispatchEvent(new Event('unavailable'));
      return;
    }
    this.context = context;
    context.addEventListener('statechange', () => this._onContextState());
    this._apply({ glide: false });
    if (context.state !== 'running') context.resume().catch(() => {});
  }

  /** Sets the filters and the headroom from the settings. */
  _apply({ glide = true } = {}) {
    const { context } = this;
    const gains = this.settings.enabled ? this.settings.gains : BANDS.map(() => 0);
    const nyquist = context.sampleRate / 2;
    const set = (param, value) => {
      if (glide) param.setTargetAtTime(value, context.currentTime, GLIDE);
      else param.value = value;
    };
    this.filters.forEach((filter, i) => set(filter.gain, BANDS[i] < nyquist ? gains[i] : 0));
    set(this.input.gain, 10 ** (-headroomDb(gains, context.sampleRate) / 20));
  }

  _onPlaying() {
    clearTimeout(this._idleTimer);
    if (!this.context || this.context.state === 'running') return;
    this.context.resume().catch(() => {});
    this._checkForSilence();
  }

  _onPaused() {
    clearTimeout(this._idleTimer);
    if (!this.context) return;
    this._idleTimer = setTimeout(() => {
      if (this.context.state === 'running' && !this._anyPlaying()) this.context.suspend().catch(() => {});
    }, IDLE_SUSPEND_MS);
  }

  _onContextState() {
    // Stopped by the system (sleep, headphones plugged in or out…) mid-song: try to carry on.
    if (this.context.state !== 'running' && this.context.state !== 'closed' && this._anyPlaying()) {
      this.context.resume().catch(() => {});
      this._checkForSilence();
    }
  }

  _checkForSilence() {
    clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      if (this.context.state !== 'running' && this._anyPlaying()) this.dispatchEvent(new Event('silent'));
    }, SILENCE_CHECK_MS);
  }
}
