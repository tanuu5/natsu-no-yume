// Tiny static server for the reel. Also receives raw frames POSTed by the page.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.ttf': 'font/ttf', '.wav': 'audio/wav', '.png': 'image/png', '.css': 'text/css', '.jpg': 'image/jpeg',
};

export function startServer({ port = 0, onFrame } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/frame') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        if (onFrame) await onFrame(+url.searchParams.get('i'), Buffer.concat(chunks));
        res.writeHead(200).end('ok');
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
      return;
    }
    const path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// `node tools/server.mjs` -> preview server on a fixed port.
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = +(process.env.PORT || 5178);
  await startServer({ port });
  console.log(`preview: http://localhost:${port}/src/index.html`);
}
