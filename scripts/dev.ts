// Development server with automatic rebuilds and the production Content
// Security Policy, so blocked resources fail locally as well.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { build, copyStatic, dist, root, tsc } from './build.ts';

const PORT = Number(process.env.PORT ?? 5173);
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'";
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

build();
spawn(
  tsc,
  ['-p', `${root}tsconfig.json`, '--watch', '--preserveWatchOutput'],
  { stdio: 'inherit' },
);
watch(`${root}public`, { recursive: true }, () => copyStatic());

createServer((request, response) => {
  const path = normalize(
    decodeURIComponent(
      new URL(request.url ?? '/', 'http://localhost').pathname,
    ),
  );
  let file = join(dist, path);
  if (!file.startsWith(dist)) {
    response.writeHead(403).end();
    return;
  }

  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, 'index.html');
  }

  if (!existsSync(file)) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-store',
  });
  response.end(readFileSync(file));
}).listen(PORT, () => console.log(`Signal Lab at http://localhost:${PORT}/`));
