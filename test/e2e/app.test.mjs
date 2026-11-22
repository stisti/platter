// End-to-end tests: the real app, in a real (headless) Chromium, against a
// simulated drive. See harness.mjs for how the drive is simulated.
//
//   npm run test:e2e

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  chromePath, startApp, sampleLibrary, writeDrive, removeFromDrive, stubFolderPicker,
  unplugDrive, replugDrive, waitForLibrary, playerState,
} from './harness.mjs';
import { buildFlac } from '../helpers/media.mjs';

const NO_CHROME = 'no Chromium found (set CHROME_PATH or run: npx playwright-core install chromium)';
// Locally, a missing browser skips these tests. In CI it must not: a run that
// skipped every browser test would otherwise still go green.
if (!chromePath && process.env.CI) throw new Error(NO_CHROME);
const skip = chromePath ? false : NO_CHROME;
const SAMPLE_TRACKS = 15;

/** Starts the app, optionally with the sample library already chosen and scanned. */
async function withApp(fn, { library = true, ...options } = {}) {
  const app = await startApp(options);
  const { page } = app;
  try {
    await page.goto(app.url);
    await page.waitForSelector('body:not(.booting)');
    app.files = await sampleLibrary(page);
    await writeDrive(page, app.files);
    await stubFolderPicker(page);
    if (library) {
      await page.getByRole('button', { name: 'Choose music folder' }).click();
      await waitForLibrary(page, SAMPLE_TRACKS);
    }
    await fn(app);
    assert.deepEqual(app.problems, [], 'the page logged errors');
  } catch (err) {
    await page.screenshot({ path: `/tmp/platter-e2e-failure-${Date.now()}.png` }).catch(() => {});
    throw err;
  } finally {
    await app.close();
  }
}

const albumUrl = (app, artist, album) => `${app.url}#/album/${encodeURIComponent(`${artist}\u001f${album}`)}`;
const bar = (page) => page.locator('#playerbar');
const waitForState = (page, state) => page.waitForFunction((s) => window.platter.player.state === s, state, { timeout: 10000 });
const waitForTitle = (page, title) => page.waitForFunction((t) => window.platter.player.track?.title === t, title, { timeout: 10000 });
const queueTitles = (page) => page.evaluate(() => window.platter.player.queue.items.map((e) => window.platter.lib.tracks.get(e.id)?.title));

/**
 * Views re-render a moment after the click that causes them (navigation is an
 * event), so "what is on screen" is polled until it matches or time runs out.
 */
async function eventually(read, check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const actual = await read();
    try {
      check(actual);
      return actual;
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
const expectTexts = (page, selector, expected, message) =>
  eventually(() => page.locator(selector).allTextContents(), (actual) => assert.deepEqual(actual, expected, message));
const expectCount = (page, selector, expected, message) =>
  eventually(() => page.locator(selector).count(), (actual) => assert.equal(actual, expected, message));
const expectToast = (page, pattern) =>
  eventually(() => page.locator('.toast').allInnerTexts(), (texts) => assert.ok(texts.some((t) => pattern.test(t)), `no toast matching ${pattern}; showing: ${texts.join(' | ') || '(none)'}`));

async function reloadApp(app) {
  await app.page.reload();
  await app.page.waitForSelector('body:not(.booting)');
  await stubFolderPicker(app.page);
}

test('first run: choose a folder, and the library appears under every lens', { skip }, async () => {
  await withApp(async ({ page }) => {
    await page.waitForSelector('.welcome');
    await expectCount(page, '.nav-link.active', 0);

    await page.getByRole('button', { name: 'Choose music folder' }).click();
    await waitForLibrary(page, SAMPLE_TRACKS);

    const lib = await page.evaluate(() => {
      const { lib } = window.platter;
      return { tracks: lib.tracks.size, albums: lib.sortedAlbums.map((a) => a.title), artists: lib.sortedArtists.map((a) => a.name), genres: lib.sortedGenres.map((g) => g.name) };
    });
    assert.equal(lib.tracks, SAMPLE_TRACKS, 'hidden files and non-audio files are left out');
    await expectToast(page, /1 copy-protected iTunes file \(FairPlay DRM\) can only be played by Apple’s apps and was left out/);
    assert.deepEqual(lib.albums, ['Homogenic', 'Damaged Goods', 'Kind of Blue', 'Animals', 'Garage Tapes', 'Summer Mix', 'Double']);
    assert.deepEqual(lib.artists, ['Björk', 'Broken', 'Miles Davis', 'Pink Floyd', 'Unsorted', 'Various Artists', 'The Wall Band']);
    assert.deepEqual(lib.genres, ['Art Pop', 'Electronic', 'Jazz', 'Pop', 'Progressive Rock', 'Rock']);

    // The default lens shows the albums, with art from a folder image and from an embedded picture.
    await page.waitForSelector('.grid .card');
    await expectCount(page, '.grid .card', 7);
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2);
    const drawn = await page.locator('.card', { hasText: 'Animals' }).locator('img').evaluate((img) => img.decode().then(() => img.naturalWidth));
    assert.equal(drawn, 400, 'cover was scaled down to a thumbnail');

    await page.locator('.nav-link', { hasText: 'Artists' }).click();
    await expectTexts(page, '.card-title', lib.artists);
    await page.locator('.nav-link', { hasText: 'Genres' }).click();
    await expectTexts(page, '.genre-name', lib.genres);
    await page.locator('.nav-link', { hasText: 'Songs' }).click();
    await page.waitForSelector('.vlist .track');
    await expectCount(page, '.vlist .track', SAMPLE_TRACKS);

    assert.match(await page.locator('.drive-status').innerText(), /Drive connected[\s\S]*USB Music · 15 songs/);
  }, { library: false });
});

test('album: press play, it plays through in order, then stops at the end', { skip }, async () => {
  await withApp(async ({ page }) => {
    await page.locator('.card', { hasText: 'Animals' }).click();
    await page.waitForSelector('.hero');
    await expectTexts(page, '.track-title', ['Pigs on the Wing 1', 'Dogs', 'Pigs (Three Different Ones)']);

    await page.locator('.hero').getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    assert.equal(await bar(page).locator('.pb-title').innerText(), 'Pigs on the Wing 1');
    assert.equal(await bar(page).locator('.pb-artist').innerText(), 'Pink Floyd');
    assert.equal(await page.locator('.track.playing .track-title').innerText(), 'Pigs on the Wing 1');
    assert.equal(await page.title(), 'Pigs on the Wing 1 · Pink Floyd');

    // Sound is really being produced: the playback position moves.
    const t1 = (await playerState(page)).time;
    await page.waitForFunction((t) => window.platter.player.currentTime > t + 0.2, t1);

    // Each track is 1.5 s long; the album advances by itself.
    await waitForTitle(page, 'Dogs');
    assert.equal(await page.locator('.track.playing .track-title').innerText(), 'Dogs');
    await waitForTitle(page, 'Pigs (Three Different Ones)');
    assert.equal((await playerState(page)).state, 'playing');

    // After the last track: stopped, rewound to the top, ready to go again.
    await waitForState(page, 'paused');
    const end = await playerState(page);
    assert.deepEqual({ title: end.title, index: end.index, length: end.length }, { title: 'Pigs on the Wing 1', index: 0, length: 3 });
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
  });
});

test('transport: pause, resume, next, previous, seek, repeat, keyboard', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(albumUrl(app, 'pink floyd', 'animals'));
    // Clicking a track starts the album from that track.
    await page.locator('.track', { hasText: 'Dogs' }).click();
    await waitForState(page, 'playing');
    assert.deepEqual(await queueTitles(page), ['Pigs on the Wing 1', 'Dogs', 'Pigs (Three Different Ones)']);
    assert.equal((await playerState(page)).index, 1);

    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await waitForState(page, 'paused');
    const frozen = (await playerState(page)).time;
    await page.waitForTimeout(400);
    assert.equal((await playerState(page)).time, frozen, 'position does not move while paused');

    await bar(page).getByRole('button', { name: 'Next' }).click();
    await waitForTitle(page, 'Pigs (Three Different Ones)');
    await waitForState(page, 'playing');
    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await waitForState(page, 'paused');

    // Near the start of a track, Previous goes to the previous track...
    await page.evaluate(() => window.platter.player.seek(0));
    await bar(page).getByRole('button', { name: 'Previous' }).click();
    await waitForTitle(page, 'Dogs');
    // ...but further in, it restarts the current one.
    await waitForState(page, 'playing');
    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await waitForState(page, 'paused');
    // (The test tracks are only 1.5 s long, so stand in for "more than 3 s into a song".)
    await page.evaluate(() => Object.defineProperty(window.platter.player, 'currentTime', { get: () => 42, configurable: true }));
    await bar(page).getByRole('button', { name: 'Previous' }).click();
    await page.evaluate(() => delete window.platter.player.currentTime);
    assert.equal((await playerState(page)).title, 'Dogs');
    assert.ok((await playerState(page)).time < 0.3, 'rewound to the start');

    // Seeking with the slider.
    await page.locator('.pb-seek-range').evaluate((input) => {
      input.value = 500;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const sought = (await playerState(page)).time;
    assert.ok(sought > 0.6 && sought < 0.9, `expected about half of 1.5 s, got ${sought}`);

    // Repeat-one keeps playing the same track.
    await bar(page).getByRole('button', { name: /^Repeat/ }).click();
    await bar(page).getByRole('button', { name: /^Repeating the queue/ }).click();
    assert.equal(await page.evaluate(() => window.platter.player.queue.repeat), 'one');
    // Space plays/pauses even though the repeat button still has focus from the click.
    await page.keyboard.press('Space');
    await waitForState(page, 'playing');
    assert.equal(await page.evaluate(() => window.platter.player.queue.repeat), 'one', 'Space did not press the focused button');
    await page.waitForFunction(() => window.platter.player.currentTime < 0.5, null, { timeout: 5000 }); // wrapped around
    assert.equal((await playerState(page)).title, 'Dogs');
    await page.keyboard.press('k');
    await waitForState(page, 'paused');

    // Volume and mute are remembered.
    await page.locator('.pb-volume').evaluate((input) => {
      input.value = 30;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.platter.player.el.volume), 0.3);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('platter.prefs')).volume), 0.3);
    await page.keyboard.press('m');
    assert.equal(await page.evaluate(() => window.platter.player.el.muted), true);
  });
});

test('artist and genre lenses: pick one, press play, get all of it', { skip }, async () => {
  await withApp(async ({ page }) => {
    // Artist: own album plus the compilation appearance.
    await page.locator('.nav-link', { hasText: 'Artists' }).click();
    await page.locator('.card', { hasText: 'Björk' }).click();
    await page.waitForSelector('.hero');
    await expectTexts(page, '.section-title', ['Albums', 'Appears on']);
    await expectTexts(page, '.card-title', ['Homogenic', 'Summer Mix']);
    await page.locator('.hero').getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    assert.deepEqual(await queueTitles(page), ['Hunter', 'Jóga', 'Middle']);
    assert.equal(await page.evaluate(() => window.platter.player.queue.shuffle), false);

    // Genre: shuffle everything in it.
    await page.locator('.nav-link', { hasText: 'Genres' }).click();
    await page.locator('.genre-tile', { hasText: 'Progressive Rock' }).click();
    await page.waitForSelector('.hero');
    await expectTexts(page, '.card-title', ['Animals']);
    await page.locator('.hero').getByRole('button', { name: 'Shuffle' }).click();
    await waitForState(page, 'playing');
    assert.deepEqual((await queueTitles(page)).sort(), ['Dogs', 'Pigs (Three Different Ones)', 'Pigs on the Wing 1']);
    assert.equal(await page.evaluate(() => window.platter.player.queue.shuffle), true);
    assert.ok(await bar(page).getByRole('button', { name: 'Shuffle', pressed: true }).isVisible());

    // The play button on a card works without opening the page.
    await page.locator('.nav-link', { hasText: 'Albums' }).click();
    const card = page.locator('.card', { hasText: 'Kind of Blue' });
    await card.hover();
    await card.locator('.card-play').click();
    await waitForTitle(page, 'So What');
    assert.match(page.url(), /#\/albums$/, 'stayed on the albums page');
    assert.equal(await page.evaluate(() => window.platter.player.queue.shuffle), false, '"Play" turns shuffle off again');

    // A multi-disc album is one album with disc headings.
    await card.page().locator('.card', { hasText: 'Double' }).click();
    await expectTexts(page, '.disc-title', ['Disc 1', 'Disc 2']);
    await expectTexts(page, '.track-title', ['Disc One Opener', 'Disc Two Opener']);

    // Untagged files are named after their folders and file names.
    await page.goBack();
    await page.locator('.card', { hasText: 'Garage Tapes' }).click();
    assert.equal(await page.locator('.hero h1').innerText(), 'Garage Tapes');
    assert.equal(await page.locator('.hero .link').innerText(), 'Unsorted');
    await expectTexts(page, '.track-title', ['Demo One', 'Demo Two']);
  });
});

test('search finds artists, albums and songs, ignoring accents', { skip }, async () => {
  await withApp(async ({ page }) => {
    await page.keyboard.press('/');
    await page.keyboard.type('bjork');
    await page.waitForSelector('.section-title');
    assert.match(decodeURIComponent(page.url()), /#\/search\/bjork$/);
    await expectTexts(page, '.section-title', ['Artists', 'Albums', 'Songs']);
    await expectTexts(page, '.track-title', ['Hunter', 'Jóga', 'Middle']);

    await page.locator('#search-input').fill('joga');
    await page.waitForFunction(() => document.querySelectorAll('.track').length === 1);
    await page.locator('.track', { hasText: 'Jóga' }).click();
    await waitForTitle(page, 'Jóga');

    await page.locator('#search-input').fill('no such thing anywhere');
    await page.waitForSelector('.empty');
    assert.match(await page.locator('.empty').innerText(), /Nothing found/);

    // Clearing the search goes back to the lens that was open.
    await page.locator('#search-input').fill('');
    await page.waitForFunction(() => location.hash === '#/albums');

    // The page re-rendering while a search is still being typed (a scan
    // adding albums does this) keeps the typing.
    await page.locator('#search-input').fill('miles');
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await page.waitForFunction(() => location.hash === '#/search/miles');
    assert.equal(await page.locator('#search-input').inputValue(), 'miles');
  });
});

test('queue: play next, add to queue, jump, remove, clear', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(albumUrl(app, 'miles davis', 'kind of blue'));
    await page.locator('.track', { hasText: 'So What' }).click();
    await waitForState(page, 'playing');
    await bar(page).getByRole('button', { name: 'Pause' }).click();

    await page.goto(albumUrl(app, 'björk', 'homogenic'));
    await page.locator('.track', { hasText: 'Hunter' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Play next' }).click();
    await page.locator('.track', { hasText: 'Jóga' }).hover();
    await page.locator('.track', { hasText: 'Jóga' }).getByRole('button', { name: 'More options' }).click();
    await page.locator('.menu-item', { hasText: 'Add to queue' }).click();
    assert.deepEqual(await queueTitles(page), ['So What', 'Hunter', 'Freddie Freeloader', 'Jóga']);

    await bar(page).getByRole('button', { name: 'Queue' }).click();
    await page.waitForSelector('.queue-row');
    await expectTexts(page, '.queue-row .queue-text > :first-child', ['So What', 'Hunter', 'Freddie Freeloader', 'Jóga']);
    await expectCount(page, '.queue-row.current', 1);

    // Remove an upcoming track, then jump straight to another.
    const hunter = page.locator('.queue-row', { hasText: 'Hunter' });
    await hunter.hover();
    await hunter.getByRole('button', { name: 'Remove from queue' }).click();
    assert.deepEqual(await queueTitles(page), ['So What', 'Freddie Freeloader', 'Jóga']);
    await page.locator('.queue-row', { hasText: 'Jóga' }).click();
    await waitForTitle(page, 'Jóga');
    await waitForState(page, 'playing');

    await page.locator('#queue').getByRole('button', { name: 'Clear' }).click();
    assert.equal((await playerState(page)).state, 'idle');
    assert.match(await page.locator('.queue-empty').innerText(), /queue is empty/);
    assert.equal(await bar(page).locator('.pb-title').innerText(), 'Nothing playing');
  });
});

test('playlists: create, fill, reorder, play, rename, delete - and they survive a restart', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // Create from the sidebar.
    await page.locator('#sidebar').getByRole('button', { name: 'New playlist' }).click();
    await page.locator('dialog .text-input').fill('Road trip');
    await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
    await page.waitForSelector('.hero');
    assert.equal(await page.locator('.hero h1').innerText(), 'Road trip');
    assert.match(await page.locator('.empty').innerText(), /This playlist is empty/);
    await expectTexts(page, '#side-playlists .nav-link', ['Road trip']);

    // Add one song, then a whole album, then (via "new playlist" in the dialog) start a second list.
    await page.goto(albumUrl(app, 'björk', 'homogenic'));
    await page.locator('.track', { hasText: 'Hunter' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Add to playlist' }).click();
    await page.locator('.dialog-list-item', { hasText: 'Road trip' }).click();
    await expectToast(page, /Added to “Road trip”/);

    await page.goto(`${app.url}#/albums`);
    await page.locator('.card', { hasText: 'Animals' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Add to playlist' }).click();
    await page.locator('.dialog-list-item', { hasText: 'Road trip' }).click();

    await page.locator('.card', { hasText: 'Kind of Blue' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Add to playlist' }).click();
    await page.locator('dialog .text-input').fill('Late night');
    await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
    await page.waitForFunction(() => window.platter.playlists.list.length === 2);
    await expectTexts(page, '#side-playlists .nav-link', ['Late night', 'Road trip']);

    // Open it and rearrange.
    await page.locator('#side-playlists .nav-link', { hasText: 'Road trip' }).click();
    await page.waitForSelector('.track');
    await expectTexts(page, '.track-title', ['Hunter', 'Pigs on the Wing 1', 'Dogs', 'Pigs (Three Different Ones)']);

    await page.locator('.track', { hasText: 'Hunter' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Move down' }).click();
    await page.waitForFunction(() => document.querySelector('.track-title').textContent === 'Pigs on the Wing 1');
    await expectTexts(page, '.track-title', ['Pigs on the Wing 1', 'Hunter', 'Dogs', 'Pigs (Three Different Ones)']);

    // Drag the last row to the top.
    await page.locator('.track', { hasText: 'Three Different Ones' }).dragTo(page.locator('.track', { hasText: 'Pigs on the Wing 1' }), { targetPosition: { x: 200, y: 6 } });
    await page.waitForFunction(() => document.querySelector('.track-title').textContent.includes('Three Different'));
    await expectTexts(page, '.track-title', ['Pigs (Three Different Ones)', 'Pigs on the Wing 1', 'Hunter', 'Dogs']);

    await page.locator('.track', { hasText: 'Dogs' }).click({ button: 'right' });
    await page.locator('.menu-item', { hasText: 'Remove from this playlist' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.track').length === 3);

    // Play it: the queue is the playlist, in playlist order.
    await page.locator('.hero').getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    assert.deepEqual(await queueTitles(page), ['Pigs (Three Different Ones)', 'Pigs on the Wing 1', 'Hunter']);
    await bar(page).getByRole('button', { name: 'Pause' }).click();

    // Restart the app: playlists are still there.
    await reloadApp(app);
    await page.waitForSelector('.track');
    await expectTexts(page, '.track-title', ['Pigs (Three Different Ones)', 'Pigs on the Wing 1', 'Hunter']);
    await expectTexts(page, '#side-playlists .nav-link', ['Late night', 'Road trip']);

    // Rename and delete.
    await page.locator('.hero').getByRole('button', { name: 'More options' }).click();
    await page.locator('.menu-item', { hasText: 'Rename' }).click();
    await page.locator('dialog .text-input').fill('Long drive');
    await page.locator('dialog').getByRole('button', { name: 'Rename' }).click();
    await page.waitForFunction(() => document.querySelector('.hero h1').textContent === 'Long drive');
    await expectTexts(page, '#side-playlists .nav-link', ['Late night', 'Long drive']);

    await page.locator('.hero').getByRole('button', { name: 'More options' }).click();
    await page.locator('.menu-item', { hasText: 'Delete playlist' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => location.hash === '#/playlists');
    await expectTexts(page, '.card-title', ['Late night']);
  });
});

test('restart: library, queue and position come back without touching the folder picker', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(albumUrl(app, 'pink floyd', 'animals'));
    await page.locator('.track', { hasText: 'Dogs' }).click();
    await waitForState(page, 'playing');
    await page.waitForFunction(() => window.platter.player.currentTime > 0.4);
    await bar(page).getByRole('button', { name: 'Pause' }).click();
    await waitForState(page, 'paused');
    const before = await playerState(page);
    await page.waitForTimeout(600); // let the queue reach the database

    await reloadApp(app);
    // Break the picker: a restart must not need it.
    await page.evaluate(() => (window.showDirectoryPicker = () => Promise.reject(new Error('the picker must not be needed'))));
    await waitForLibrary(page, SAMPLE_TRACKS);
    assert.equal(await page.evaluate(() => window.platter.source.state), 'connected');
    await expectCount(page, '.welcome', 0);

    const after = await playerState(page);
    assert.deepEqual({ title: after.title, index: after.index, length: after.length, state: after.state }, { title: 'Dogs', index: 1, length: 3, state: 'paused' });
    assert.ok(Math.abs(after.time - before.time) < 0.05, `position ${after.time} should match ${before.time}`);
    assert.equal(await bar(page).locator('.pb-title').innerText(), 'Dogs');

    // Pressing play carries on from where it stopped, not from the top.
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    assert.ok((await playerState(page)).time >= before.time - 0.05);
    assert.equal((await playerState(page)).title, 'Dogs');
  });
});

test('updating the app: covers made by an older version are rebuilt on the next start', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2);
    // Pretend the stored thumbnails came from an earlier version of the app.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('platter');
      open.onsuccess = () => {
        const tx = open.result.transaction(['kv', 'covers'], 'readwrite');
        tx.objectStore('kv').put(1, 'coversVersion');
        tx.objectStore('covers').put({ key: 'an album that no longer exists', blob: new Blob(['old']) });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      };
    }));
    await reloadApp(app);
    await waitForLibrary(page, SAMPLE_TRACKS);
    // The quiet scan at start-up remakes them from the drive, without being asked.
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2, null, { timeout: 15000 });
    assert.deepEqual(await page.evaluate(() => [...window.platter.covers.known].sort()), ['miles davis\u001fkind of blue', 'pink floyd\u001fanimals']);
  });
});

test('a file that cannot be played is reported and skipped, not fatal', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // Queue: the corrupt file, then a good one.
    await page.evaluate(() => {
      const { lib } = window.platter;
      const bad = [...lib.tracks.values()].find((t) => t.title === 'Corrupt');
      const good = [...lib.tracks.values()].find((t) => t.title === 'So What');
      window.platter.play([bad, good]);
    });
    await waitForTitle(page, 'So What');
    await waitForState(page, 'playing');
    await expectToast(page, /“Corrupt” could not be played/);

    // A queue of nothing but broken files gives up instead of looping forever.
    await page.evaluate(() => {
      const bad = [...window.platter.lib.tracks.values()].find((t) => t.title === 'Corrupt');
      window.platter.player.queue.repeat = 'all';
      window.platter.play([bad, bad, bad, bad, bad]);
    });
    await waitForState(page, 'paused');
    await page.waitForTimeout(500);
    assert.equal((await playerState(page)).state, 'paused');
  });
});

test('rescan: new music appears, deleted music goes, playlists keep a note of what is missing', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.evaluate(async () => {
      const { lib, playlists } = window.platter;
      const paths = [...lib.tracks.values()].filter((t) => t.album === 'Homogenic').map((t) => t.path);
      await playlists.create('Keepers', paths);
    });
    const parsedBefore = await page.evaluate(() => window.platter.lib.tracks.size);

    await writeDrive(page, {
      'New Artist/Fresh/01 - Brand New.flac': buildFlac({ tags: { TITLE: 'Brand New', ARTIST: 'New Artist', ALBUM: 'Fresh', GENRE: 'Jazz' }, playable: true }),
    });
    await removeFromDrive(page, 'Björk/Homogenic/01 Hunter.flac');
    await removeFromDrive(page, 'Compilations');

    await page.locator('#side-footer').getByRole('button', { name: 'Library options' }).click();
    await page.locator('.menu-item', { hasText: 'Scan for new music' }).click();
    await page.waitForFunction(() => !window.platter.scan.active && window.platter.lib.albums.has('new artist\u001ffresh'));
    await expectToast(page, /Library updated: 1 song added, 4 removed\./);

    const after = await page.evaluate(() => ({ size: window.platter.lib.tracks.size, albums: window.platter.lib.sortedAlbums.map((a) => a.title), jazz: window.platter.lib.genres.get('jazz').tracks.length }));
    assert.equal(after.size, parsedBefore + 1 - 4);
    assert.ok(after.albums.includes('Fresh') && !after.albums.includes('Summer Mix'));
    assert.equal(after.jazz, 3);
    await expectCount(page, '.grid .card', after.albums.length, 'the open view refreshed itself');

    // The playlist still lists the deleted song, marked as missing, and plays the rest.
    await page.locator('#side-playlists .nav-link', { hasText: 'Keepers' }).click();
    await page.waitForSelector('.track');
    await expectCount(page, '.track.missing', 1);
    assert.match(await page.locator('.track.missing').innerText(), /01 Hunter\.flac[\s\S]*Not found in the library/);
    assert.match(await page.locator('.hero').innerText(), /2 songs · .* · 1 not found/);
    await page.locator('.hero').getByRole('button', { name: 'Play', exact: true }).click();
    await waitForTitle(page, 'Jóga');

    // Scanning again with nothing changed says so, and does not repeat old news.
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.locator('#side-footer').getByRole('button', { name: 'Library options' }).click();
    await page.locator('.menu-item', { hasText: 'Scan for new music' }).click();
    await expectToast(page, /up to date/);
    assert.ok(!(await page.locator('.toast').allInnerTexts()).some((t) => /copy-protected/.test(t)), 'the note about protected files is shown once, not on every scan');
  });
});

test('drive unplugged while playing: playback stops politely, the library stays, replugging just works', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(albumUrl(app, 'pink floyd', 'animals'));
    await page.locator('.hero').getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');

    await unplugDrive(page);
    // The app notices by itself (it polls), without any click.
    await page.waitForFunction(() => window.platter.source.state === 'disconnected', null, { timeout: 20000 });
    await page.waitForSelector('.banner-warn');
    assert.match(await page.locator('.banner').innerText(), /music drive isn’t connected/);
    assert.match(await page.locator('.drive-status').innerText(), /Drive not connected/);
    await waitForState(page, 'paused');
    assert.equal((await playerState(page)).length, 3, 'the queue is kept');

    // Browsing still works, covers included (they are stored with the library).
    await page.locator('.nav-link', { hasText: 'Albums' }).click();
    await expectCount(page, '.grid .card', 7);
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2);
    await page.locator('.nav-link', { hasText: 'Artists' }).click();
    await expectCount(page, '.grid .card', 7);
    await page.locator('#search-input').fill('miles');
    await page.waitForSelector('.section-title');

    // Trying to play explains what is wrong instead of failing silently or crashing.
    // (Unplugging already showed the same toast, and it may still be up - so
    // wait for this attempt to finish before looking.)
    await page.locator('.track', { hasText: 'So What' }).click();
    await page.waitForFunction(() => window.platter.player.track?.title === 'So What' && window.platter.player.state !== 'loading');
    await expectToast(page, /isn’t connected/);
    const blocked = await playerState(page);
    assert.deepEqual({ state: blocked.state, title: blocked.title }, { state: 'paused', title: 'So What' });

    // A scan is refused rather than wiping the library.
    await page.evaluate(() => window.platter.rescan());
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS);

    // "Check again" while still unplugged gives a useful hint.
    await page.locator('.banner').getByRole('button', { name: 'Check again' }).click();
    await expectToast(page, /Still can’t find/);

    // Plug it back in: noticed automatically, banner goes, and play now works.
    await replugDrive(page, app.files);
    await page.waitForFunction(() => window.platter.source.state === 'connected', null, { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('.banner'));
    await waitForLibrary(page, SAMPLE_TRACKS);
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    assert.equal((await playerState(page)).title, 'So What');
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS, 'reconnecting did not disturb the library');
  });
});

test('drive unplugged mid-song: the place in the song is kept and playback resumes from it', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(albumUrl(app, 'pink floyd', 'animals'));
    await page.locator('.track', { hasText: 'Dogs' }).click();
    await waitForState(page, 'playing');
    await page.waitForFunction(() => window.platter.player.currentTime > 0.5);

    // A real drive fails the audio stream when it is pulled. The simulated one
    // has the whole (tiny) file buffered already, so raise the stream error by hand.
    await unplugDrive(page);
    const at = await page.evaluate(() => {
      const { player } = window.platter;
      const position = player.currentTime;
      player.el.pause();
      player.el.dispatchEvent(new Event('error'));
      return position;
    });
    await waitForState(page, 'paused');
    await expectToast(page, /isn’t connected/);
    await page.waitForSelector('.banner-warn');
    const stopped = await playerState(page);
    assert.equal(stopped.title, 'Dogs');
    assert.equal(stopped.index, 1);
    assert.ok(Math.abs(stopped.time - at) < 0.25, `kept position ${stopped.time}, was at ${at}`);

    // Play with the drive still out: told why, nothing lost.
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.platter.player.state === 'paused');
    assert.ok(Math.abs((await playerState(page)).time - at) < 0.25);

    await replugDrive(page, app.files);
    await page.waitForFunction(() => window.platter.source.state === 'connected', null, { timeout: 20000 });
    await bar(page).getByRole('button', { name: 'Play', exact: true }).click();
    await waitForState(page, 'playing');
    const resumed = await playerState(page);
    assert.equal(resumed.title, 'Dogs');
    assert.ok(resumed.time >= at - 0.25, `resumed at ${resumed.time}, expected about ${at}`);
  });
});

test('starting the app with the drive unplugged shows the library, not an error', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await unplugDrive(page);
    await reloadApp(app);

    await page.waitForSelector('.banner-warn');
    assert.equal(await page.evaluate(() => window.platter.source.state), 'disconnected');
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS);
    await expectCount(page, '.grid .card', 7);
    await expectCount(page, '.welcome', 0);
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2);

    await replugDrive(page, app.files);
    await page.waitForFunction(() => window.platter.source.state === 'connected', null, { timeout: 20000 });
    await waitForLibrary(page, SAMPLE_TRACKS);
    await page.locator('.card', { hasText: 'Animals' }).hover();
    await page.locator('.card', { hasText: 'Animals' }).locator('.card-play').click();
    await waitForState(page, 'playing');
  });
});

test('a drive that never answers does not keep the app from starting', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // As seen on ChromeOS after an OS update: calls on the folder handle stay pending forever.
    await page.addInitScript(() => {
      const never = () => new Promise(() => {});
      FileSystemDirectoryHandle.prototype.keys = () => ({ [Symbol.asyncIterator]: () => ({ next: never }) });
    });
    await reloadApp(app);

    assert.equal(await page.evaluate(() => window.platter.source.state), 'disconnected');
    await page.waitForSelector('.banner-warn');
    await expectCount(page, '.grid .card', 7, 'the library is browsable');
  });
});

test('if the saved library never opens, the app says so instead of staying blank', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.addInitScript(() => {
      indexedDB.open = () => ({});
    });
    await page.reload();
    await page.waitForSelector('body:not(.booting)', { timeout: 20000 });
    assert.match(await page.locator('.boot-stuck').innerText(), /Still waiting for: the saved library \(IndexedDB\)/);
    assert.equal(await page.locator('.boot-stuck').getByRole('button', { name: 'Reload' }).count(), 1);
  });
});

test('drive unplugged in the middle of a scan: nothing is lost, and the scan can be redone', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // Force every file to be re-read, and pull the drive part-way through.
    await page.evaluate(async () => {
      for (const t of window.platter.lib.tracks.values()) t.size = -1;
      const scan = window.platter.rescan();
      const opfs = await navigator.storage.getDirectory();
      await opfs.removeEntry('USB Music', { recursive: true });
      await scan;
    });
    await page.waitForFunction(() => !window.platter.scan.active);
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS, 'library is intact');
    assert.equal(await page.evaluate(() => window.platter.source.state), 'disconnected');
    await expectToast(page, /disconnected during the scan/);

    await reloadApp(app);
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS, 'and it is intact in the database too');
  });
});

test('an automatic scan never quietly drops most of the library', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // The folder is there but nearly empty - as if another drive were mounted in its place.
    for (const folder of ['Pink Floyd', 'Miles Davis', 'Björk', 'Compilations', 'The Wall Band', 'Broken']) await removeFromDrive(page, folder);

    await reloadApp(app); // starting up scans by itself
    await expectToast(page, /Most of your library was not found on the drive, so nothing was removed/);
    assert.equal(await page.evaluate(() => window.platter.lib.tracks.size), SAMPLE_TRACKS);
    await expectCount(page, '.grid .card', 7);
    await page.waitForFunction(() => document.querySelectorAll('.grid .cover img').length === 2);

    // Asking for the scan by hand is taken as meaning it.
    await page.locator('#side-footer').getByRole('button', { name: 'Library options' }).click();
    await page.locator('.menu-item', { hasText: 'Scan for new music' }).click();
    await expectToast(page, /Library updated: 13 removed\./);
    await expectTexts(page, '.card-title', ['Garage Tapes']);
  });
});

test('when Chrome wants permission re-confirmed, one click restores access', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // From the next page load on, behave like a fresh Chrome session: the saved
    // folder handle needs the user's OK before it can be read.
    await page.addInitScript(() => {
      let granted = false;
      FileSystemDirectoryHandle.prototype.queryPermission = async () => (granted ? 'granted' : 'prompt');
      FileSystemDirectoryHandle.prototype.requestPermission = async () => {
        granted = true;
        return 'granted';
      };
    });
    await reloadApp(app);

    await page.waitForSelector('.banner');
    assert.equal(await page.evaluate(() => window.platter.source.state), 'needs-permission');
    assert.match(await page.locator('.banner').innerText(), /Chrome needs your OK to read “USB Music” again/);
    await expectCount(page, '.grid .card', 7, 'the library is browsable while waiting');

    await page.locator('.banner').getByRole('button', { name: 'Allow access' }).click();
    await page.waitForFunction(() => window.platter.source.state === 'connected');
    await page.waitForFunction(() => !document.querySelector('.banner'));

    // Pressing play is itself enough of a click to ask for access.
    await reloadApp(app);
    await page.waitForSelector('.banner');
    await page.locator('.card', { hasText: 'Animals' }).hover();
    await page.locator('.card', { hasText: 'Animals' }).locator('.card-play').click();
    await waitForState(page, 'playing');
    assert.equal(await page.evaluate(() => window.platter.source.state), 'connected');
  });
});

test('installed app keeps working when its server is not running', { skip }, async () => {
  const app = await startApp();
  const { page } = app;
  try {
    await page.goto(app.url);
    await page.waitForSelector('body:not(.booting)');
    app.files = await sampleLibrary(page);
    await writeDrive(page, app.files);
    await stubFolderPicker(page);
    await page.getByRole('button', { name: 'Choose music folder' }).click();
    await waitForLibrary(page, SAMPLE_TRACKS);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // Shut the server down, as when the Chromebook's Linux environment is off.
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    await assert.rejects(fetch(app.url), 'the server really is gone');

    await page.reload();
    await page.waitForSelector('body:not(.booting)');
    await waitForLibrary(page, SAMPLE_TRACKS);
    await expectCount(page, '.grid .card', 7);
    await page.waitForFunction(() => document.querySelectorAll('.brand img').length === 1 && document.querySelector('.brand img').naturalWidth > 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display), 'flex', 'stylesheet loaded from the saved copy');

    await page.locator('.card', { hasText: 'Animals' }).hover();
    await page.locator('.card', { hasText: 'Animals' }).locator('.card-play').click();
    await waitForState(page, 'playing');

    // SQLite (never used before going offline) comes from the saved copy too.
    await page.locator('.nav-link', { hasText: 'Query' }).click();
    await runQuery(page, 'SELECT count(*) AS n FROM tracks');
    await expectTexts(page, '.query-table tbody td', [String(SAMPLE_TRACKS)]);

    const unexpected = app.problems.filter((p) => !/ERR_CONNECTION_REFUSED|Failed to load resource|Failed to fetch/i.test(p));
    assert.deepEqual(unexpected, []);
  } finally {
    await app.browser.close();
    app.server.close();
  }
});

test('version: shown in the sidebar; a newly published one offers a reload', { skip }, async () => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await withApp(async ({ page }) => {
    assert.equal(await page.locator('#app-version').textContent(), version);
    // The check has to get past the service worker, so let it take over first.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    await page.evaluate(() => window.platter.checkForUpdate());
    assert.equal(await page.locator('#update-banner .banner').count(), 0, 'no banner while the published version is this one');

    // "Publish" a new version. (context.route, not page.route: requests from
    // a page that a service worker controls bypass page.route.)
    const context = page.context();
    const publish = (v) => context.route('**/js/version.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `export const VERSION = '${v}';\n` }));
    await publish('99.0.0');
    await page.evaluate(() => window.platter.checkForUpdate());
    const banner = page.locator('#update-banner .banner');
    await banner.waitFor();
    assert.match(await banner.textContent(), /Platter 99\.0\.0 is available/);

    // Reload starts the published version, which then has nothing to announce.
    await Promise.all([page.waitForEvent('load'), banner.getByRole('button', { name: 'Reload' }).click()]);
    await page.waitForSelector('body:not(.booting)');
    assert.equal(await page.locator('#app-version').textContent(), '99.0.0');
    await page.evaluate(() => window.platter.checkForUpdate());
    assert.equal(await banner.count(), 0);

    // Not now: the banner goes, and this window doesn't bring it back.
    await publish('99.0.1');
    await page.evaluate(() => window.platter.checkForUpdate());
    await banner.waitFor();
    await banner.getByRole('button', { name: 'Not now' }).click();
    await page.evaluate(() => window.platter.checkForUpdate());
    assert.equal(await banner.count(), 0);
    await context.unroute('**/js/version.js');
  });
});

test('layout holds at phone width and in the light theme', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    // Nothing pokes out sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page is ${overflow}px wider than the window`);

    // The sidebar is tucked away behind the menu button and still fully usable.
    assert.equal(await page.locator('#sidebar').evaluate((el) => el.getBoundingClientRect().right <= 0), true);
    await page.locator('#menu-button').click();
    await page.locator('.nav-link', { hasText: 'Genres' }).click();
    await page.waitForSelector('.genre-tile');
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 0);

    await page.locator('.genre-tile', { hasText: 'Jazz' }).getByRole('button', { name: 'Shuffle Jazz' }).click();
    await waitForState(page, 'playing');
    assert.ok(await bar(page).getByRole('button', { name: 'Pause' }).isVisible());
    assert.ok(await bar(page).locator('.pb-title').isVisible());

    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 245, 241)');

    // The Query page fits too, results table included (it scrolls inside its own box).
    await page.goto(`${app.url}#/query`);
    await runQuery(page, 'SELECT title, artist, genres, format, size, mtime, path AS file FROM tracks');
    await page.waitForSelector('.query-table');
    const queryOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(queryOverflow <= 0, `query page is ${queryOverflow}px wider than the window`);
  }, { viewport: { width: 400, height: 760 }, colorScheme: 'light' });
});

// ------------------------------------------------------------------ queries

/** Types SQL into the Query page and runs it with Ctrl+Enter. */
async function runQuery(page, sql) {
  const editor = page.getByRole('textbox', { name: 'SQL query' });
  await editor.fill(sql);
  await editor.press('Control+Enter');
}
const resultFacts = (page) => page.locator('.query-result-bar [role=status]');

test('query: SQLite starts, and results are songs to play, albums to open, or a table', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    assert.match(await page.evaluate(async () => (await window.platter.sql.run('SELECT sqlite_version()')).rows[0][0]), /^3\.\d+\.\d+$/);

    await page.locator('.nav-link', { hasText: 'Query' }).click();
    await page.waitForSelector('.query-page');
    // Nothing runs until asked. The example query it starts with (80s rock)
    // finds nothing in the sample library, but runs.
    await page.waitForSelector('.query-results .empty');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await eventually(() => resultFacts(page).textContent(), (text) => assert.match(text, /^0 songs/));
    await expectTexts(page, '.query-schema summary', ['tracks', 'albums', 'artists', 'genres', 'track_genres', 'album_genres', 'genre_family', 'playlists', 'playlist_tracks', 'songs view', 'track_families view', 'album_families view']);

    // 70s rock: "Progressive Rock" is in the rock family.
    await runQuery(page, `SELECT s.* FROM songs s JOIN track_families f USING (path)
      WHERE f.family = 'rock' AND s.released BETWEEN 1970 AND 1979 ORDER BY s.track_no`);
    await expectTexts(page, '.query-results .track-title', ['Pigs on the Wing 1', 'Dogs', 'Pigs (Three Different Ones)']);
    assert.match(await resultFacts(page).textContent(), /^3 songs · under a minute · (<1|\d+) ms$/);
    await page.locator('.query-results').getByRole('button', { name: 'Shuffle', exact: true }).click();
    await waitForState(page, 'playing');
    assert.equal((await playerState(page)).length, 3);
    await page.locator('.query-results .track', { hasText: 'Dogs' }).click();
    await waitForTitle(page, 'Dogs');

    // The same result as a table, and back.
    await page.locator('.segmented').getByRole('button', { name: 'Table' }).click();
    await expectCount(page, '.query-table tbody tr', 3);
    await page.locator('.segmented').getByRole('button', { name: 'Songs' }).click();
    await expectCount(page, '.query-results .track', 3);

    // An album_key column makes a list of albums.
    await runQuery(page, "SELECT * FROM albums WHERE artist_key = 'pink floyd' ORDER BY COALESCE(original_year, year) LIMIT 1");
    await expectTexts(page, '.query-results .card-title', ['Animals']);
    await page.locator('.query-results .card', { hasText: 'Animals' }).click();
    await page.waitForSelector('.hero h1');
    assert.equal(await page.locator('.hero h1').textContent(), 'Animals');
    await page.goBack();
    await expectTexts(page, '.query-results .card-title', ['Animals'], 'the query runs again on the way back');

    // Anything else is a table.
    await runQuery(page, 'SELECT family, count(*) AS songs FROM track_families GROUP BY family ORDER BY songs DESC, family LIMIT 3');
    await expectTexts(page, '.query-table th', ['family', 'songs']);
    assert.deepEqual(await page.locator('.query-table tbody tr').allInnerTexts(), ['pop\t5', 'rock\t5', 'progressive\t3']);

    // Mistakes are shown on the page (not logged as errors, which withApp would catch).
    await runQuery(page, 'SELECT * FROM nope');
    await expectTexts(page, '.query-error', ['no such table: nope']);

    // The SQL and the last query survive a reload.
    await reloadApp(app);
    await expectTexts(page, '.query-error', ['no such table: nope']);
    assert.equal(await page.getByRole('textbox', { name: 'SQL query' }).inputValue(), 'SELECT * FROM nope');
  });
});

test('query: a song list can be saved as a playlist, and playlists can be queried', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(`${app.url}#/query`);
    await runQuery(page, "SELECT path FROM tracks WHERE genres LIKE '%jazz%' ORDER BY track_no");
    await expectTexts(page, '.query-results .track-title', ['So What', 'Freddie Freeloader']);
    await page.locator('.query-results').getByRole('button', { name: 'Save as playlist' }).click();
    await page.locator('dialog .text-input').fill('Jazz from SQL');
    await page.locator('dialog').getByRole('button', { name: 'Create' }).click();
    await page.waitForSelector('.hero h1');
    assert.equal(await page.locator('.hero h1').textContent(), 'Jazz from SQL');
    await expectTexts(page, '.tracks .track-title', ['So What', 'Freddie Freeloader']);

    // The new playlist is in the tables at once.
    await page.goto(`${app.url}#/query`);
    await runQuery(page, 'SELECT p.name, count(*) AS n FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id GROUP BY p.id');
    assert.deepEqual(await page.locator('.query-table tbody tr').allInnerTexts(), ['Jazz from SQL\t2']);
  });
});

test('query: works with the drive unplugged, and follows the library after a rescan', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(`${app.url}#/query`);
    await unplugDrive(page);
    await page.waitForFunction(() => window.platter.source.state === 'disconnected', null, { timeout: 20000 });
    await runQuery(page, "SELECT path FROM tracks WHERE artist_key = 'miles davis'");
    await expectCount(page, '.query-results .track', 2);

    // Back with one more Miles Davis song: the same query, run again by the page, finds it.
    const extra = buildFlac({ tags: { TITLE: 'Blue in Green', ARTIST: 'Miles Davis', ALBUM: 'Kind of Blue', TRACKNUMBER: '3', DATE: '1959', GENRE: 'Jazz' }, playable: true });
    await replugDrive(page, { ...app.files, 'Miles Davis/Kind of Blue/03 Blue in Green.flac': extra });
    await waitForLibrary(page, SAMPLE_TRACKS + 1);
    await expectCount(page, '.query-results .track', 3);
  });
});

test('query: a song length learned by playing it reaches SQL, and its album total', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    const path = 'Unsorted/Garage Tapes/03 - No Length.flac';
    await writeDrive(page, { [path]: buildFlac({ tags: { TITLE: 'No Length' }, playable: true, unknownLength: true }) });
    await page.evaluate(() => window.platter.rescan());
    await waitForLibrary(page, SAMPLE_TRACKS + 1);

    const sqlDurations = () =>
      page.evaluate(async (p) => {
        const result = await window.platter.sql.run(
          `SELECT t.duration AS track, a.duration AS album FROM tracks t JOIN albums a USING (album_key) WHERE t.path = '${p}'`,
        );
        const [track, album] = result.rows[0];
        return { track, album };
      }, path);
    const before = await sqlDurations();
    assert.equal(before.track, null, 'the tags give no length');

    await page.evaluate((p) => window.platter.play([window.platter.lib.tracks.get(p)], 0), path);
    await page.waitForFunction((p) => window.platter.lib.tracks.get(p).duration > 0, path, { timeout: 10000 });
    const after = await sqlDurations();
    assert.ok(after.track > 0, 'SQL sees the length the player learned');
    assert.ok(Math.abs(after.album - (before.album + after.track)) < 0.001, 'and the album total includes it');
  });
});

test('query: saved queries, and setup SQL that adds genre families of the owner\'s own', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(`${app.url}#/query`);
    const chill = "SELECT s.* FROM songs s JOIN track_families f USING (path) WHERE f.family = 'chill' ORDER BY s.title";

    // Save, and the query is there after a restart: one click runs it.
    await runQuery(page, chill);
    await eventually(() => resultFacts(page).textContent(), (text) => assert.match(text, /^0 songs/));
    await page.getByRole('button', { name: 'Save…' }).click();
    await page.locator('dialog .text-input').fill('Chill');
    await page.locator('dialog').getByRole('button', { name: 'Save' }).click();
    await expectTexts(page, '.query-chip .link-btn', ['Chill']);
    await reloadApp(app);
    await runQuery(page, 'SELECT 1');
    await page.locator('.query-chip').getByRole('button', { name: 'Chill', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'SQL query' }).inputValue(), chill);
    await eventually(() => resultFacts(page).textContent(), (text) => assert.match(text, /^0 songs/));

    // Setup SQL puts Jazz into a "chill" family; the saved query now finds it.
    await page.locator('.query-setup summary').click();
    await page.getByRole('textbox', { name: 'Setup SQL' }).fill("INSERT INTO genre_family VALUES ('jazz', 'chill');");
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expectTexts(page, '.query-results .track-title', ['Freddie Freeloader', 'So What']);
    await reloadApp(app);
    await expectTexts(page, '.query-results .track-title', ['Freddie Freeloader', 'So What'], 'setup SQL is kept, and applied on the next start');

    // Broken setup SQL says so, and the tables still work.
    await page.locator('.query-setup summary').click();
    await page.getByRole('textbox', { name: 'Setup SQL' }).fill('INSERT INTO nowhere VALUES (1);');
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await expectTexts(page, '.query-setup .query-error', ['Setup SQL failed: no such table: nowhere']);
    await eventually(() => resultFacts(page).textContent(), (text) => assert.match(text, /^0 songs/));

    // Deleting a saved query asks first.
    await page.locator('.query-chip').getByRole('button', { name: 'Delete “Chill”' }).click();
    await page.locator('dialog').getByRole('button', { name: 'Delete' }).click();
    await expectCount(page, '.query-chip', 0);
    await reloadApp(app);
    await expectCount(page, '.query-chip', 0);
  });
});

test('query: unsaved setup SQL is kept across a reload until it is discarded or typed back', { skip }, async () => {
  await withApp(async (app) => {
    const { page } = app;
    await page.goto(`${app.url}#/query`);
    const setupBox = page.getByRole('textbox', { name: 'Setup SQL' });
    const discard = page.getByRole('button', { name: 'Discard changes' });
    const panelOpen = () => page.locator('.query-setup').evaluate((details) => details.open);
    assert.equal(await discard.isVisible(), false, 'nothing to discard yet');

    // An unsaved change survives a reload, with the panel open to show it.
    await page.locator('.query-setup summary').click();
    await setupBox.fill('-- not saved yet');
    await discard.waitFor();
    await reloadApp(app);
    assert.equal(await panelOpen(), true);
    assert.equal(await setupBox.inputValue(), '-- not saved yet');

    // Discarding puts the saved setup SQL back, and the next start is clean.
    await discard.click();
    assert.equal(await setupBox.inputValue(), '');
    assert.equal(await discard.isVisible(), false);
    await reloadApp(app);
    assert.equal(await panelOpen(), false);

    // Typing the saved text back is no change either.
    await page.locator('.query-setup summary').click();
    await setupBox.fill('-- changed my mind');
    await setupBox.fill('');
    assert.equal(await discard.isVisible(), false);
    await reloadApp(app);
    assert.equal(await panelOpen(), false);
  });
});
