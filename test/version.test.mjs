import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { VERSION } from '../app/js/version.js';

test('the app reports the version in package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, 'bump with `npm version`, or run scripts/sync-version.mjs');
});

test('update.js can read the version back out of version.js', async () => {
  const source = await readFile(new URL('../app/js/version.js', import.meta.url), 'utf8');
  assert.equal(source.match(/VERSION = '([^']+)'/)?.[1], VERSION);
});
