// The equalizer panel: opens above the player bar from its equalizer button.
// An on/off switch, the presets, a curve of what the settings do to the
// sound, and one slider per band. Changes go to the player's equalizer
// (equalizer.js), which tells everyone with a 'change' event.

import { h, iconButton } from './dom.js';
import { BANDS, MAX_GAIN, GAIN_STEP, PRESETS, matchPreset, bandLabel, responseDb, headroomDb } from '../eq.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CURVE_W = 400;
const CURVE_H = 72;
/** The curve shows ±CURVE_DB; overlapping boosts can reach past MAX_GAIN. */
const CURVE_DB = 15;

/** "+3", "0", "−4.5" */
function formatDb(db) {
  if (db === 0) return '0';
  return `${db > 0 ? '+' : '−'}${Math.abs(db)}`;
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function mountEqPanel(app, host) {
  const eq = app.player.equalizer;
  const update = (changes) => eq.set({ ...eq.settings, ...changes });

  // --- header: title, on/off, close
  const toggle = h('input', {
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    'aria-label': 'Equalizer on',
    onChange: () => update({ enabled: toggle.checked }),
  });
  const header = h(
    'header',
    { class: 'eq-header' },
    h('h2', { class: 'grow', id: 'eq-title' }, 'Equalizer'),
    h('label', { class: 'eq-switch-label' }, h('span', { class: 'muted small' }, 'On'), toggle),
    iconButton('close', 'Close equalizer', () => app.toggleEq(false), { size: 18 }),
  );

  // --- presets
  const custom = h('option', { value: '', disabled: true }, 'Custom');
  const preset = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Preset',
      onChange: () => {
        const chosen = PRESETS.find((p) => p.id === preset.value);
        if (chosen) update({ enabled: true, gains: [...chosen.gains] });
      },
    },
    PRESETS.map((p) => h('option', { value: p.id }, p.name)),
    custom,
  );
  const headroom = h('p', { class: 'muted small eq-headroom' });

  // --- the curve
  const zero = svg('line', { x1: 0, x2: CURVE_W, y1: CURVE_H / 2, y2: CURVE_H / 2, class: 'eq-zero' });
  const curvePath = svg('path', { class: 'eq-curve-line', d: '' });
  const curve = svg('svg', { viewBox: `0 0 ${CURVE_W} ${CURVE_H}`, preserveAspectRatio: 'none', class: 'eq-curve', 'aria-hidden': 'true' });
  curve.append(zero, curvePath);

  // --- the sliders
  const sliders = BANDS.map((frequency, i) => {
    const value = h('span', { class: 'eq-value' });
    const input = h('input', {
      type: 'range',
      class: 'eq-slider',
      min: -MAX_GAIN,
      max: MAX_GAIN,
      step: GAIN_STEP,
      'aria-label': `${bandLabel(frequency)} Hz`,
      title: 'Double-click for 0 dB',
      onInput: () => setBand(i, Number(input.value)),
      onDblclick: () => setBand(i, 0),
    });
    const column = h('div', { class: 'eq-band' }, value, input, h('span', { class: 'eq-freq muted' }, bandLabel(frequency)));
    return { input, value, column };
  });
  const setBand = (i, gain) => {
    const gains = [...eq.settings.gains];
    gains[i] = gain;
    update({ enabled: true, gains });
  };

  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-labelledby', 'eq-title');
  host.tabIndex = -1;
  host.append(
    header,
    h('label', { class: 'sort-label eq-presets' }, h('span', { class: 'muted small' }, 'Preset'), preset),
    curve,
    h('div', { class: 'eq-bands' }, sliders.map((s) => s.column)),
    headroom,
    h('p', { class: 'eq-unavailable muted small', hidden: true }, 'The equalizer isn’t available in this browser.'),
  );
  const unavailableNote = host.querySelector('.eq-unavailable');

  const render = () => {
    const { enabled, gains } = eq.settings;
    host.classList.toggle('off', !enabled);
    toggle.checked = enabled;
    const id = matchPreset(gains);
    custom.hidden = id !== null;
    preset.value = id ?? '';

    const sampleRate = eq.context?.sampleRate ?? 48000;
    const room = enabled ? headroomDb(gains, sampleRate) : 0;
    headroom.textContent = room > 0.05 ? `Music turned down ${room.toFixed(1)} dB to make room for the boost` : '';

    // The bands are an octave apart and the sliders evenly spaced, so on a
    // log scale each band's centre lines up with the middle of its slider.
    const top = Math.min(BANDS.at(-1) * Math.SQRT2, sampleRate / 2 - 1);
    const points = [];
    for (let x = 0; x <= CURVE_W; x += 4) {
      const frequency = BANDS[0] * 2 ** ((x / CURVE_W) * BANDS.length - 0.5);
      if (frequency > top) break;
      const db = Math.max(-CURVE_DB, Math.min(CURVE_DB, responseDb(gains, frequency, sampleRate)));
      points.push(`${x},${((1 - db / CURVE_DB) * CURVE_H) / 2}`);
    }
    curvePath.setAttribute('d', `M${points.join('L')}`);

    sliders.forEach(({ input, value }, i) => {
      // Don't fight the slider being dragged (its value is already right).
      if (document.activeElement !== input || Number(input.value) !== gains[i]) input.value = String(gains[i]);
      value.textContent = formatDb(gains[i]);
      // Fill the track from 0 dB to the thumb.
      const at = ((gains[i] + MAX_GAIN) / (2 * MAX_GAIN)) * 100;
      input.style.setProperty('--lo', `${Math.min(50, at)}%`);
      input.style.setProperty('--hi', `${Math.max(50, at)}%`);
    });
    unavailableNote.hidden = !eq.unavailable;
  };

  eq.addEventListener('change', render);
  eq.addEventListener('unavailable', render);
  render();

  // Close on Escape, or on a click anywhere outside (except the button that toggles it).
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      app.toggleEq(false);
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (host.hidden || !(event.target instanceof Element)) return;
    if (host.contains(event.target) || event.target.closest('.pb-eq')) return;
    app.toggleEq(false);
  });

  // Focus moves into the panel (so Tab goes on to its controls) without marking one of them.
  return { focus: () => host.focus() };
}
