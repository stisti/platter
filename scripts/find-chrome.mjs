// Locates a Chromium/Chrome binary for the scripts and browser tests.
// Order: $CHROME_PATH, a Playwright-downloaded Chromium, a system install.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);

  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse();
    for (const build of builds) {
      candidates.push(join(cache, build, 'chrome-linux64', 'chrome'), join(cache, build, 'chrome-linux', 'chrome'));
    }
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  return candidates.find((path) => existsSync(path)) ?? null;
}
