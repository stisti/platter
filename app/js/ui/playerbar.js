// The player bar along the bottom, the queue panel, and the hook-up to the
// system media controls (keyboard media keys, the ChromeOS media widget).

import { h, icon, iconButton, formatTime, plural } from './dom.js';
import { coverArt } from './views.js';
import { keyOf } from '../library.js';

const QUEUE_ROWS_SHOWN = 200;

function setRange(input, fraction) {
  const f = Math.min(1, Math.max(0, fraction || 0));
  input.style.setProperty('--fill', `${f * 100}%`);
}

export function mountPlayerBar(app, host) {
  const { player } = app;

  // --- now playing
  const art = h('div', { class: 'pb-art' });
  const title = h('a', { class: 'pb-title ellipsis' });
  const artist = h('a', { class: 'pb-artist ellipsis muted' });
  const nowPlaying = h('div', { class: 'pb-track' }, art, h('div', { class: 'pb-text' }, title, artist));

  // --- transport
  const shuffleBtn = iconButton('shuffle', 'Shuffle', () => player.setShuffle(!player.queue.shuffle), { size: 18, cls: 'toggle' });
  const prevBtn = iconButton('prev', 'Previous', () => player.prev(), { size: 24 });
  const playBtn = iconButton('play', 'Play', () => app.togglePlay(), { size: 26, cls: 'pb-play' });
  const nextBtn = iconButton('next', 'Next', () => player.next(), { size: 24 });
  const repeatBtn = iconButton('repeat', 'Repeat', () => player.cycleRepeat(), { size: 18, cls: 'toggle' });

  // --- seek bar
  const elapsed = h('span', { class: 'pb-time' }, '0:00');
  const total = h('span', { class: 'pb-time' }, '0:00');
  const seek = h('input', { class: 'range pb-seek-range', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek' });
  let seeking = false;
  seek.addEventListener('pointerdown', () => (seeking = true));
  seek.addEventListener('input', () => {
    seeking = true;
    const f = seek.value / 1000;
    setRange(seek, f);
    elapsed.textContent = formatTime(f * player.duration);
  });
  seek.addEventListener('change', () => {
    player.seek((seek.value / 1000) * player.duration);
    seeking = false;
  });

  // --- volume and queue
  const volumeBtn = iconButton('volume', 'Mute', () => (player.muted = !player.muted), { size: 20 });
  const volume = h('input', { class: 'range pb-volume', type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume' });
  volume.addEventListener('input', () => {
    // Read the slider before touching the player: un-muting fires an update
    // that writes the old volume back into the slider.
    const level = volume.value / 100;
    player.muted = false;
    player.volume = level;
    app.setPref('volume', level);
  });
  const eqBtn = iconButton('equalizer', 'Equalizer', () => app.toggleEq(), { size: 20, cls: 'toggle pb-eq' });
  eqBtn.setAttribute('aria-haspopup', 'dialog');
  eqBtn.setAttribute('aria-expanded', 'false');
  const queueBtn = iconButton('queue', 'Queue', () => app.toggleQueue(), { size: 20, cls: 'toggle' });

  host.append(
    nowPlaying,
    h(
      'div',
      { class: 'pb-center' },
      h('div', { class: 'pb-controls' }, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn),
      h('div', { class: 'pb-seek' }, elapsed, seek, total),
    ),
    h('div', { class: 'pb-right' }, volumeBtn, volume, eqBtn, queueBtn),
  );

  // --- updates
  const setIcon = (button, name, label) => {
    button.replaceChildren(icon(name, Number(button.firstChild?.getAttribute('width')) || 20));
    button.title = label;
    button.setAttribute('aria-label', label);
  };

  const updateTrack = () => {
    const track = player.track;
    host.classList.toggle('no-track', !track);
    // Only swap the artwork when the album changes, so it does not flicker between tracks.
    const artKey = track ? track._albumKey : '';
    if (art.dataset.album !== artKey || !art.firstChild) {
      art.dataset.album = artKey;
      art.replaceChildren(track ? coverArt(app, track._albumKey, { seed: track.album, placeholder: 'note' }) : coverArt(app, null, { seed: 'platter', placeholder: 'note' }));
    }
    title.textContent = track ? track.title : 'Nothing playing';
    title.title = track ? track.title : '';
    artist.textContent = track ? track.artist : 'Pick something and press play';
    if (track) {
      title.href = `#/album/${encodeURIComponent(track._albumKey)}`;
      artist.href = `#/artist/${encodeURIComponent(keyOf(track.artist))}`;
    } else {
      title.removeAttribute('href');
      artist.removeAttribute('href');
    }
    document.title = track ? `${track.title} · ${track.artist}` : 'Platter';
    updateTime();
    updateMediaSession();
  };

  const updateState = () => {
    const playing = player.state === 'playing' || player.state === 'loading';
    setIcon(playBtn, playing ? 'pause' : 'play', playing ? 'Pause' : 'Play');
    host.classList.toggle('loading', player.state === 'loading');
    document.body.classList.toggle('is-playing', player.state === 'playing');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = player.state === 'idle' ? 'none' : playing ? 'playing' : 'paused';
    }
  };

  const updateTime = () => {
    const d = player.duration;
    const t = player.currentTime;
    total.textContent = player.track ? formatTime(d || null) : '0:00';
    host.style.setProperty('--played', `${d ? Math.min(100, (t / d) * 100) : 0}%`);
    if (seeking) return;
    elapsed.textContent = formatTime(t);
    seek.value = d ? Math.round((t / d) * 1000) : 0;
    setRange(seek, d ? t / d : 0);
    seek.disabled = !player.track;
  };

  const updateModes = () => {
    const { shuffle, repeat } = player.queue;
    shuffleBtn.classList.toggle('on', shuffle);
    shuffleBtn.setAttribute('aria-pressed', String(shuffle));
    shuffleBtn.title = shuffle ? 'Shuffle is on' : 'Shuffle is off';
    repeatBtn.classList.toggle('on', repeat !== 'off');
    setIcon(repeatBtn, repeat === 'one' ? 'repeatOne' : 'repeat', { off: 'Repeat is off', all: 'Repeating the queue', one: 'Repeating this track' }[repeat]);
    const has = player.queue.length > 0;
    prevBtn.disabled = nextBtn.disabled = playBtn.disabled = !has;
  };

  const updateVolume = () => {
    const silent = player.muted || player.volume === 0;
    setIcon(volumeBtn, silent ? 'muted' : 'volume', player.muted ? 'Unmute' : 'Mute');
    volume.value = Math.round(player.volume * 100);
    setRange(volume, player.muted ? 0 : player.volume);
  };

  // The equalizer button lights up while the equalizer changes the sound.
  const updateEq = () => {
    const { enabled } = player.equalizer.settings;
    eqBtn.classList.toggle('on', enabled);
    eqBtn.title = enabled ? 'Equalizer (on)' : 'Equalizer (off)';
  };

  // --- system media controls
  let positionSentAt = 0;
  const updateMediaSession = () => {
    if (!('mediaSession' in navigator)) return;
    const track = player.track;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const set = (artworkUrl) => {
      if (player.track !== track) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: artworkUrl ? [{ src: artworkUrl, sizes: '400x400', type: 'image/webp' }] : [],
      });
    };
    set(app.covers.cachedUrl(track._albumKey));
    if (app.covers.has(track._albumKey) && !app.covers.cachedUrl(track._albumKey)) app.covers.url(track._albumKey).then(set);
  };
  const updatePositionState = () => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const now = Date.now();
    if (now - positionSentAt < 900) return;
    positionSentAt = now;
    const d = player.duration;
    try {
      if (d > 0) navigator.mediaSession.setPositionState({ duration: d, position: Math.min(player.currentTime, d), playbackRate: 1 });
    } catch {
      // some values are briefly inconsistent while a track loads
    }
  };
  if ('mediaSession' in navigator) {
    const actions = {
      play: () => app.togglePlay(true),
      pause: () => player.pause(),
      previoustrack: () => player.prev(),
      nexttrack: () => player.next(),
      seekto: (details) => details.seekTime != null && player.seek(details.seekTime),
      seekbackward: (details) => player.seek(player.currentTime - (details.seekOffset || 10)),
      seekforward: (details) => player.seek(player.currentTime + (details.seekOffset || 10)),
      stop: () => player.pause(),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // action not supported by this browser
      }
    }
  }

  player.addEventListener('trackchange', updateTrack);
  player.addEventListener('statechange', updateState);
  player.addEventListener('timeupdate', () => {
    updateTime();
    updatePositionState();
  });
  player.addEventListener('queuechange', updateModes);
  player.addEventListener('volumechange', updateVolume);
  player.equalizer.addEventListener('change', updateEq);
  app.covers.addEventListener('change', updateTrack);

  updateTrack();
  updateState();
  updateModes();
  updateVolume();
  updateEq();

  return {
    refresh: updateTrack,
    setQueueOpen: (open) => {
      queueBtn.classList.toggle('on', open);
      queueBtn.setAttribute('aria-pressed', String(open));
    },
    setEqOpen: (open) => eqBtn.setAttribute('aria-expanded', String(open)),
  };
}

export function mountQueuePanel(app, host) {
  const { player } = app;
  const list = h('div', { class: 'queue-list' });
  const count = h('span', { class: 'muted small' });
  const clearBtn = h('button', { class: 'btn btn-small', type: 'button', onClick: () => player.clearQueue() }, 'Clear');
  host.append(
    h('header', { class: 'queue-header' }, h('h2', { class: 'grow' }, 'Queue'), count, clearBtn, iconButton('close', 'Close queue', () => app.toggleQueue(false), { size: 18 })),
    list,
  );

  const render = () => {
    if (host.hidden) return;
    const { items, index } = player.queue;
    count.textContent = items.length ? plural(items.length, 'song') : '';
    clearBtn.hidden = !items.length;
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'queue-empty muted' }, 'The queue is empty. Press play on an album, artist, genre or playlist.'));
      return;
    }
    const children = [];
    const start = Math.max(0, index);
    const end = Math.min(items.length, start + QUEUE_ROWS_SHOWN);
    if (start > 0) children.push(h('div', { class: 'queue-note muted small' }, `${plural(start, 'song')} already played`));
    for (let i = start; i < end; i++) {
      const track = app.lib.tracks.get(items[i].id);
      if (i === start) children.push(h('div', { class: 'queue-label muted small' }, 'Now playing'));
      if (i === start + 1) children.push(h('div', { class: 'queue-label muted small' }, 'Next up'));
      children.push(
        h(
          'div',
          {
            class: `queue-row${i === index ? ' current' : ''}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => (i === player.queue.index ? app.togglePlay() : player.jump(i)),
            onKeydown: (event) => {
              if (event.key === 'Enter') player.jump(i);
            },
          },
          h(
            'div',
            { class: 'grow queue-text' },
            h('div', { class: 'ellipsis' }, track ? track.title : 'Missing track'),
            h('div', { class: 'ellipsis muted small' }, track ? track.artist : items[i].id),
          ),
          h('span', { class: 'muted small' }, track ? formatTime(track.duration) : ''),
          iconButton('close', 'Remove from queue', () => player.removeFromQueue(i), { size: 16, cls: 'queue-remove' }),
        ),
      );
    }
    if (end < items.length) children.push(h('div', { class: 'queue-note muted small' }, `…and ${plural(items.length - end, 'more song')}`));
    const scrollTop = list.scrollTop;
    list.replaceChildren(...children);
    list.scrollTop = scrollTop;
  };

  player.addEventListener('queuechange', render);
  player.addEventListener('trackchange', () => {
    render();
    list.scrollTop = 0;
  });
  return { render };
}
