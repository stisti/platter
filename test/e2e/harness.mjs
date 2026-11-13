// Browser test harness. Runs the real app in headless Chromium against a
// simulated music drive.
//
// The "drive" is a folder in the browser's origin-private file system (OPFS):
// it hands out genuine FileSystemDirectoryHandles, so the app's scanning,
// playback and persistence code runs exactly as it does against a USB drive.
// Unplugging the drive is simulated by deleting that folder - after which the
// handle the app holds fails with NotFoundError, as a detached drive does.

import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { createAppServer } from '../../server.mjs';
import { findChrome } from '../../scripts/find-chrome.mjs';
import { buildFlac } from '../helpers/media.mjs';

export const chromePath = findChrome();

export async function startApp({ viewport = { width: 1280, height: 800 }, colorScheme = 'dark' } = {}) {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://localhost:${server.address().port}/`;

  const browser = await chromium.launch({
    executablePath: chromePath,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });

  return {
    url,
    server,
    browser,
    context,
    page,
    /** Uncaught errors and console.error output seen so far. */
    problems,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Renders a cover image in the page and returns its PNG bytes. */
export async function paintCover(page, { hue, label, size = 600 }) {
  const base64 = await page.evaluate(async ({ hue, label, size }) => {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, `hsl(${hue} 70% 55%)`);
    gradient.addColorStop(1, `hsl(${(hue + 60) % 360} 70% 25%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = `bold ${size / 9}px sans-serif`;
    ctx.fillText(label, size / 12, size - size / 10);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }, { hue, label, size });
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * A small but varied library: tagged albums with folder art and embedded art,
 * a compilation, a multi-disc album, untagged files, and one corrupt file.
 * All audio is real and playable (1.5 s each).
 */
export async function sampleLibrary(page) {
  const song = (tags, pictures = []) => buildFlac({ tags, pictures, playable: true });
  const animals = await paintCover(page, { hue: 340, label: 'Animals' });
  const blue = await paintCover(page, { hue: 215, label: 'Kind of Blue' });
  const files = {
    'Pink Floyd/Animals/cover.png': animals,
    'Pink Floyd/Animals/01 - Pigs on the Wing 1.flac': song({ TITLE: 'Pigs on the Wing 1', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '1', DATE: '1977', GENRE: 'Progressive Rock' }),
    'Pink Floyd/Animals/02 - Dogs.flac': song({ TITLE: 'Dogs', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '2', DATE: '1977', GENRE: 'Progressive Rock' }),
    'Pink Floyd/Animals/03 - Pigs.flac': song({ TITLE: 'Pigs (Three Different Ones)', ARTIST: 'Pink Floyd', ALBUM: 'Animals', TRACKNUMBER: '3', DATE: '1977', GENRE: 'Progressive Rock' }),
    'Miles Davis/Kind of Blue/01 So What.flac': song({ TITLE: 'So What', ARTIST: 'Miles Davis', ALBUM: 'Kind of Blue', TRACKNUMBER: '1', DATE: '1959', GENRE: 'Jazz' }, [{ type: 3, mime: 'image/png', data: blue }]),
    'Miles Davis/Kind of Blue/02 Freddie Freeloader.flac': song({ TITLE: 'Freddie Freeloader', ARTIST: 'Miles Davis', ALBUM: 'Kind of Blue', TRACKNUMBER: '2', DATE: '1959', GENRE: 'Jazz' }),
    'Björk/Homogenic/01 Hunter.flac': song({ TITLE: 'Hunter', ARTIST: 'Björk', ALBUM: 'Homogenic', TRACKNUMBER: '1', DATE: '1997', GENRE: ['Electronic', 'Art Pop'] }),
    'Björk/Homogenic/02 Jóga.flac': song({ TITLE: 'Jóga', ARTIST: 'Björk', ALBUM: 'Homogenic', TRACKNUMBER: '2', DATE: '1997', GENRE: ['Electronic', 'Art Pop'] }),
    'Compilations/Summer Mix/01.flac': song({ TITLE: 'Opening', ARTIST: 'First Band', ALBUM: 'Summer Mix', TRACKNUMBER: '1', GENRE: 'Pop' }),
    'Compilations/Summer Mix/02.flac': song({ TITLE: 'Middle', ARTIST: 'Björk', ALBUM: 'Summer Mix', TRACKNUMBER: '2', GENRE: 'Pop' }),
    'Compilations/Summer Mix/03.flac': song({ TITLE: 'Closing', ARTIST: 'Third Band', ALBUM: 'Summer Mix', TRACKNUMBER: '3', GENRE: 'Pop' }),
    'The Wall Band/Double/CD1/01 - Disc One Opener.flac': song({ TITLE: 'Disc One Opener', ARTIST: 'The Wall Band', ALBUM: 'Double', TRACKNUMBER: '1', DISCNUMBER: '1', GENRE: 'Rock' }),
    'The Wall Band/Double/CD2/01 - Disc Two Opener.flac': song({ TITLE: 'Disc Two Opener', ARTIST: 'The Wall Band', ALBUM: 'Double', TRACKNUMBER: '1', DISCNUMBER: '2', GENRE: 'Rock' }),
    'Unsorted/Garage Tapes/01 - Demo One.flac': song({}),
    'Unsorted/Garage Tapes/02 - Demo Two.flac': song({}),
    'Broken/Damaged Goods/01 - Corrupt.flac': new Uint8Array(4000).fill(0x55),
    'Pink Floyd/Animals/.hidden.flac': song({ TITLE: 'Should not appear' }),
    'readme.txt': new Uint8Array(20),
    'iTunes/Bought Long Ago/01 Locked.m4p': new Uint8Array(200), // copy-protected: counted, never listed
  };
  return files;
}

/** Writes `files` ({ 'relative/path': Uint8Array }) into the simulated drive folder. */
export async function writeDrive(page, files, driveName = 'USB Music') {
  const payload = Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]);
  await page.evaluate(async ({ payload, driveName }) => {
    const opfs = await navigator.storage.getDirectory();
    const drive = await opfs.getDirectoryHandle(driveName, { create: true });
    for (const [path, base64] of payload) {
      const parts = path.split('/');
      let dir = drive;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(parts.at(-1), { create: true });
      const writable = await file.createWritable();
      await writable.write(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
      await writable.close();
    }
  }, { payload, driveName });
}

export async function removeFromDrive(page, path, driveName = 'USB Music') {
  await page.evaluate(async ({ path, driveName }) => {
    const opfs = await navigator.storage.getDirectory();
    const parts = path.split('/');
    let dir = await opfs.getDirectoryHandle(driveName);
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts.at(-1), { recursive: true });
  }, { path, driveName });
}

/**
 * Makes the app's folder picker return the simulated drive (the real picker
 * is a system dialog a test cannot click through).
 */
export async function stubFolderPicker(page, driveName = 'USB Music') {
  await page.evaluate((driveName) => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(driveName);
  }, driveName);
}

/**
 * Simulates pulling the drive out: the folder the app holds a handle to
 * disappears, so every access through that handle fails with NotFoundError.
 */
export async function unplugDrive(page, driveName = 'USB Music') {
  await page.evaluate(async (driveName) => {
    const opfs = await navigator.storage.getDirectory();
    await opfs.removeEntry(driveName, { recursive: true });
  }, driveName);
}

/**
 * Simulates plugging it back in: the same folder, at the same place, with these files.
 *
 * Unlike a real drive, which appears all at once, this one fills up file by
 * file - and the app may notice it (and scan it) half-way. So once everything
 * is written, the app is asked to look again, as it would at a real drive.
 */
export async function replugDrive(page, files, driveName = 'USB Music') {
  await writeDrive(page, files, driveName);
  await page.waitForFunction(() => window.platter.source.state === 'connected' && !window.platter.scan.active, null, { timeout: 20000 });
  await page.evaluate(() => window.platter.rescan({ quiet: true }));
}

/** Waits until no scan is running and at least `tracks` tracks are in the library. */
export async function waitForLibrary(page, tracks = 1) {
  await page.waitForFunction((n) => window.platter && !window.platter.scan.active && window.platter.lib.tracks.size >= n, tracks, { timeout: 20000 });
}

export const playerState = (page) =>
  page.evaluate(() => {
    const { player } = window.platter;
    return { state: player.state, title: player.track?.title ?? null, time: player.currentTime, index: player.queue.index, length: player.queue.length };
  });
