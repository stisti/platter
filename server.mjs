#!/usr/bin/env node
// Tiny static file server for the app/ folder. No dependencies.
//
// A development tool: the published app is served by GitHub Pages
// (.github/workflows/pages.yml). The browser tests also use this server.
//
//   node server.mjs            serve on http://localhost:7373
//   PORT=8000 node server.mjs  use another port

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const APP_ROOT = resolve(fileURLToPath(new URL('./app', import.meta.url)));

export function createAppServer(root = APP_ROOT) {
  return createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed', { Allow: 'GET, HEAD' });

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(400, 'Bad request');
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(root, pathname));
    if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden');

    try {
      const info = await stat(file);
      if (!info.isFile()) return send(404, 'Not found');
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        // Always revalidate, so an updated file is picked up on the next load.
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      send(404, 'Not found');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT) || 7373;
  // Bound to localhost only: this is not meant to be reachable from the network.
  const server = createAppServer();
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is Platter's server already running? (Try PORT=7374 node server.mjs)` : err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Platter is being served at http://localhost:${port}`);
    console.log('Open that address in Chrome, then use "Install Platter" in the address bar.');
  });
}
