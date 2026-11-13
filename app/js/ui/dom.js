// DOM helpers shared by the views: element creation, icons, formatting,
// toasts, menus and dialogs.
//
// Tag text from music files is untrusted input. Everything here inserts text
// as text nodes; `innerHTML` is used only for the icon paths defined below.

const SVG_NS = 'http://www.w3.org/2000/svg';

// Material Design icon paths (Apache 2.0), 24x24 viewBox.
const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  prev: 'M6 6h2v12H6zm3.5 6l8.5 6V6z',
  shuffle: 'M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  repeatOne: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  queue: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z',
  genre: 'M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z',
  refresh: 'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  playlist: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z',
  playlistAdd: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z',
  playNext: 'M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z',
  drag: 'M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  up: 'M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z',
  down: 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
};

/**
 * Creates an element. `props` keys: `class`, `dataset`, `style` (object),
 * `on<Event>` listeners, anything else as a property or attribute.
 * Children may be nodes, strings, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key in el && !key.startsWith('aria')) el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child);
  }
}

export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** An icon-only button. `label` becomes both tooltip and accessible name. */
export function iconButton(name, label, onClick, { size = 20, cls = '' } = {}) {
  return h(
    'button',
    {
      class: `icon-btn ${cls}`.trim(),
      type: 'button',
      title: label,
      'aria-label': label,
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
      },
    },
    icon(name, size),
  );
}

/** 245 -> "4:05", 3725 -> "1:02:05", unknown -> "–:––" */
export function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '–:––';
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 4980 -> "1 hr 23 min" */
export function formatLength(seconds) {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function plural(count, one, many = one + 's') {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** A stable hue for a string, for placeholder art. */
export function hueOf(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

// ------------------------------------------------------------------ toasts

export function toast(message, { kind = 'info', duration = 4500, action = null } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  // Don't stack identical messages (e.g. several failed tracks in a row).
  for (const existing of host.children) if (existing.dataset.message === message) existing.remove();
  const el = h('div', { class: `toast toast-${kind}`, role: 'status', dataset: { message } }, h('span', null, message));
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    el.append(
      h('button', { class: 'toast-action', type: 'button', onClick: () => { dismiss(); action.onClick(); } }, action.label),
    );
  }
  host.append(el);
  setTimeout(dismiss, duration);
}

// ------------------------------------------------------------------- menus

let closeOpenMenu = null;

/**
 * Opens a popup menu next to an element or at a pointer event.
 * @param {HTMLElement|MouseEvent} anchor
 * @param {Array<{label: string, icon?: string, onClick: () => void, danger?: boolean, disabled?: boolean}|'separator'|null|false>} items
 */
export function openMenu(anchor, items) {
  closeOpenMenu?.();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator') {
      menu.append(h('div', { class: 'menu-separator', role: 'separator' }));
      continue;
    }
    menu.append(
      h(
        'button',
        {
          class: `menu-item${item.danger ? ' danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          disabled: Boolean(item.disabled),
          onClick: () => {
            close();
            item.onClick();
          },
        },
        item.icon ? icon(item.icon, 18) : h('span', { class: 'menu-icon-gap' }),
        h('span', null, item.label),
      ),
    );
  }
  document.body.append(menu);

  // Place it, keeping it inside the window.
  const box = menu.getBoundingClientRect();
  let x;
  let y;
  if (anchor instanceof Event) {
    x = anchor.clientX;
    y = anchor.clientY;
  } else {
    const r = anchor.getBoundingClientRect();
    x = r.right - box.width;
    y = r.bottom + 4;
    if (y + box.height > innerHeight - 8) y = r.top - box.height - 4;
  }
  x = Math.max(8, Math.min(x, innerWidth - box.width - 8));
  y = Math.max(8, Math.min(y, innerHeight - box.height - 8));
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const onPointerDown = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
      const at = buttons.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  };
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', close, true);
    if (closeOpenMenu === close) closeOpenMenu = null;
  }
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
  closeOpenMenu = close;
  menu.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true });
}

// ----------------------------------------------------------------- dialogs

function showDialog(build) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog' });
    let result = null;
    const finish = (value) => {
      result = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    // Click on the backdrop closes.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.append(build(finish));
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Asks for a line of text. Resolves to the trimmed text, or null if cancelled. */
export function promptDialog({ title, label, value = '', okLabel = 'OK' }) {
  return showDialog((finish) => {
    const input = h('input', { class: 'text-input', type: 'text', value, placeholder: label, 'aria-label': label, maxLength: 120 });
    setTimeout(() => input.select(), 0);
    return h(
      'form',
      {
        class: 'dialog-body',
        onSubmit: (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (text) finish(text);
        },
      },
      h('h2', null, title),
      input,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, okLabel),
      ),
    );
  });
}

export function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  return showDialog((finish) =>
    h(
      'div',
      { class: 'dialog-body' },
      h('h2', null, title),
      message ? h('p', { class: 'dialog-text' }, message) : null,
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { class: 'btn', type: 'button', onClick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', autofocus: true, onClick: () => finish(true) }, okLabel),
      ),
    ),
  ).then(Boolean);
}

/**
 * Lets the user pick one of their playlists or create a new one.
 * Resolves to `{ id }`, `{ create: name }`, or null if cancelled.
 */
export function playlistDialog({ title, playlists }) {
  return showDialog((finish) => {
    const input = h('input', { class: 'text-input', type: 'text', placeholder: 'New playlist name', 'aria-label': 'New playlist name', maxLength: 120 });
    return h(
      'div',
      { class: 'dialog-body' },
      h('h2', null, title),
      playlists.length
        ? h(
            'div',
            { class: 'dialog-list' },
            playlists.map((p) =>
              h(
                'button',
                { class: 'dialog-list-item', type: 'button', onClick: () => finish({ id: p.id }) },
                icon('playlist', 18),
                h('span', { class: 'grow ellipsis' }, p.name),
                h('span', { class: 'muted' }, String(p.tracks.length)),
              ),
            ),
          )
        : null,
      h(
        'form',
        {
          class: 'dialog-new',
          onSubmit: (event) => {
            event.preventDefault();
            const name = input.value.trim();
            if (name) finish({ create: name });
          },
        },
        input,
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create'),
      ),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onClick: () => finish(null) }, 'Cancel')),
    );
  });
}
