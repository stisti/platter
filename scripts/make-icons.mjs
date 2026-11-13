#!/usr/bin/env node
// Renders the PNG app icons from the SVG sources (needs a Chromium; see find-chrome.mjs).
//   npm run icons

import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChrome } from './find-chrome.mjs';

const ICONS = new URL('../app/icons/', import.meta.url);
const JOBS = [
  { svg: new URL('icon.svg', ICONS), png: 'icon-192.png', size: 192 },
  { svg: new URL('icon.svg', ICONS), png: 'icon-512.png', size: 512 },
  // Maskable: full-bleed background with the artwork inside the safe zone.
  { svg: new URL('./icon-maskable.svg', import.meta.url), png: 'icon-maskable-512.png', size: 512 },
];

const executablePath = findChrome();
if (!executablePath) {
  console.error('No Chromium found. Set CHROME_PATH or run: npx playwright install chromium');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
try {
  for (const { svg, png, size } of JOBS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const source = await readFile(svg, 'utf8');
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
    await writeFile(new URL(png, ICONS), await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`wrote app/icons/${png}`);
  }
} finally {
  await browser.close();
}
