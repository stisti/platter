// Equalizer settings and the maths behind them: the bands, the presets, and
// how loud the filters make each frequency. Pure, so Node tests can check it.
//
// The sound itself is filtered by the browser (equalizer.js builds a chain of
// Web Audio BiquadFilterNodes, one per band). The formulas here are the ones
// the Web Audio spec gives for those nodes (the "Audio EQ Cookbook"), so what
// responseDb() computes is what the browser does. They are used to draw the
// curve and to find how much the music must be turned down so that boosting
// a band cannot push it past full scale (clipping).

/** Centre frequencies (Hz) of the ten bands: one octave apart, as on a hi-fi graphic equalizer. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** One octave wide bells (Q = √2), so neighbouring bands meet about half-way. */
export const BAND_Q = Math.SQRT2;

/** A slider goes from -MAX_GAIN to +MAX_GAIN dB. */
export const MAX_GAIN = 12;

/** Slider steps, in dB. */
export const GAIN_STEP = 0.5;

const flat = () => BANDS.map(() => 0);

/**
 * Built-in settings, in dB per band (31 Hz … 16 kHz).
 * @type {ReadonlyArray<{id: string, name: string, gains: number[]}>}
 */
export const PRESETS = [
  { id: 'flat', name: 'Flat', gains: flat() },
  { id: 'bass', name: 'More bass', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'less-bass', name: 'Less bass', gains: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble', name: 'More treble', gains: [0, 0, 0, 0, 0, 0, 1, 3, 5, 6] },
  { id: 'less-treble', name: 'Less treble', gains: [0, 0, 0, 0, 0, 0, -1, -3, -5, -6] },
  { id: 'loudness', name: 'Loudness (quiet listening)', gains: [6, 5, 3, 0, -1, 0, 0, 1, 3, 4] },
  { id: 'vocal', name: 'Voices', gains: [-3, -2, -1, 0, 2, 3, 3, 2, 0, -1] },
  { id: 'small-speakers', name: 'Small speakers', gains: [-6, -3, 2, 3, 1, 0, 0, 1, 2, 2] },
];

/**
 * @typedef {object} EqSettings
 * @property {boolean} enabled  off = the music is played as it is
 * @property {number[]} gains   dB per band, BANDS.length of them
 */

/** The setting a new user starts with: off, and flat. */
export function defaultEq() {
  return { enabled: false, gains: flat() };
}

/** Rounds to a slider step and keeps within ±MAX_GAIN; anything not a number is 0. */
export function clampGain(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const stepped = Math.round(n / GAIN_STEP) * GAIN_STEP;
  return Math.min(MAX_GAIN, Math.max(-MAX_GAIN, stepped)) || 0; // `|| 0` turns -0 into 0
}

/**
 * Makes saved settings safe to use: they come from localStorage and may be
 * missing, from an older version, or edited by hand.
 * @param {any} saved
 * @returns {EqSettings}
 */
export function normalizeEq(saved) {
  const gains = Array.isArray(saved?.gains) ? saved.gains : [];
  return {
    enabled: saved?.enabled === true,
    gains: BANDS.map((_, i) => clampGain(gains[i])),
  };
}

/** The preset these gains are exactly, or null ("Custom"). */
export function matchPreset(gains) {
  return PRESETS.find((p) => p.gains.every((g, i) => g === gains[i]))?.id ?? null;
}

export function isFlat(gains) {
  return gains.every((g) => g === 0);
}

/** "31", "500", "1k", "16k" */
export function bandLabel(frequency) {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
}

/**
 * The coefficients of a peaking filter, as the Web Audio spec defines
 * BiquadFilterNode type "peaking" (normalised so that a0 = 1).
 */
function peaking(frequency, gainDb, q, sampleRate) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cos) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/** |H| of one biquad at `frequency`, in dB. */
function biquadDb({ b0, b1, b2, a1, a2 }, frequency, sampleRate) {
  const w = (2 * Math.PI * frequency) / sampleRate;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * How much louder (+) or quieter (-) the equalizer makes `frequency`, in dB:
 * the bands' filters one after another, before any headroom is taken off.
 * Bands above the Nyquist frequency are left out, as the browser can't play them.
 */
export function responseDb(gains, frequency, sampleRate = 48000) {
  let total = 0;
  BANDS.forEach((f, i) => {
    if (!gains[i] || f >= sampleRate / 2) return;
    total += biquadDb(peaking(f, gains[i], BAND_Q, sampleRate), frequency, sampleRate);
  });
  return total;
}

/** `count` frequencies spaced evenly on a log scale from 20 Hz to 20 kHz (or Nyquist). */
export function curveFrequencies(count = 160, sampleRate = 48000) {
  const lo = Math.log10(20);
  const hi = Math.log10(Math.min(20000, sampleRate / 2 - 1));
  return Array.from({ length: count }, (_, i) => 10 ** (lo + ((hi - lo) * i) / (count - 1)));
}

/**
 * How far (dB) to turn the music down before the filters, so that the
 * loudest frequency comes out no louder than it went in. 0 when nothing is boosted.
 */
export function headroomDb(gains, sampleRate = 48000) {
  if (!gains.some((g) => g > 0)) return 0;
  // Bells peak at (or between) their centres; check the centres and a fine sweep.
  const freqs = [...BANDS.filter((f) => f < sampleRate / 2), ...curveFrequencies(400, sampleRate)];
  let peak = 0;
  for (const f of freqs) peak = Math.max(peak, responseDb(gains, f, sampleRate));
  return Math.round(peak * 100) / 100;
}
