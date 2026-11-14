#!/usr/bin/env node
// Fails unless the second package.json has a higher version than the first.
// Used by .github/workflows/pr.yml when a pull request changes app/.
//
//   node scripts/check-version-bump.mjs <base package.json> <new package.json>

import { readFile } from 'node:fs/promises';

const [basePath, headPath] = process.argv.slice(2);
const versionOf = async (path) => JSON.parse(await readFile(path, 'utf8')).version;
const parse = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`"${version}" is not a plain major.minor.patch version`);
  return match.slice(1).map(Number);
};

const before = await versionOf(basePath);
const after = await versionOf(headPath);
const [a, b] = [parse(before), parse(after)];
const order = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

if (order < 0) {
  console.log(`Version ${before} -> ${after}.`);
} else {
  const what = order === 0 ? `is still ${after}` : `went down from ${before} to ${after}`;
  console.log(`::error title=Version not bumped::This pull request changes app/ but the version ${what}. Run: npm version patch (or minor / major)`);
  process.exit(1);
}
