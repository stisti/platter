import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { once } from 'node:events';

import { APP_ROOT, createAppServer } from '../server.mjs';

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(relative(APP_ROOT, full).split('\\').join('/'));
  }
  return out;
}

test('the service worker caches exactly the files the app consists of', async () => {
  const sw = await readFile(join(APP_ROOT, 'sw.js'), 'utf8');
  const listed = [...sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './');
  const actual = (await listFiles(APP_ROOT)).filter((p) => p !== 'sw.js');
  assert.deepEqual(listed.slice().sort(), actual.sort(), 'update the ASSETS list in app/sw.js when adding or removing files');
});

test('every local import and manifest icon points at a file that exists', async () => {
  const files = await listFiles(APP_ROOT);
  for (const file of files.filter((f) => f.endsWith('.js'))) {
    const source = await readFile(join(APP_ROOT, file), 'utf8');
    for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
      const target = join(file, '..', spec).split('\\').join('/');
      assert.ok(files.includes(target), `${file} imports ${spec}, which does not exist`);
    }
  }
  const manifest = JSON.parse(await readFile(join(APP_ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const iconEntry of manifest.icons) assert.ok(files.includes(iconEntry.src), `manifest icon ${iconEntry.src} is missing`);
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'), 'Chrome needs 192px and 512px icons to offer installation');
});

test('the server serves the app, with safe headers, and nothing outside it', async () => {
  const server = createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    assert.match(await index.text(), /<title>Platter<\/title>/);

    const js = await fetch(`${base}/js/main.js`);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);
    // WebAssembly.instantiateStreaming insists on this type (GitHub Pages sends it too).
    const wasm = await fetch(`${base}/vendor/sqlite/sqlite3.wasm`);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');

    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/js`)).status, 404);
    for (const escape of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/js/../../server.mjs']) {
      const res = await fetch(base + escape);
      assert.ok(res.status === 403 || res.status === 404, `${escape} -> ${res.status}`);
      assert.doesNotMatch(await res.text(), /playwright-core|createAppServer/);
    }
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});
