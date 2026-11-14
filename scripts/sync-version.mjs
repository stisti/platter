#!/usr/bin/env node
// Copies "version" from package.json into app/js/version.js.
//
// npm runs this as the "version" lifecycle script, so `npm version minor`
// (etc.) bumps package.json, updates app/js/version.js, and commits and tags
// both together.

import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const file = new URL('app/js/version.js', root);
const source = await readFile(file, 'utf8');
const line = /export const VERSION = '[^']*';/;
if (!line.test(source)) throw new Error('VERSION line not found in app/js/version.js');
await writeFile(file, source.replace(line, `export const VERSION = '${version}';`));
console.log(`app/js/version.js: ${version}`);
