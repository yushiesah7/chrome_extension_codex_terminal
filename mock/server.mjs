import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = __dirname;
const port = Number(process.env.PORT || 5173);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function safePathFromUrl(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const normalized = decoded.replaceAll('\\', '/');
  const rel = normalized.replace(/^\/+/, '');
  if (rel.includes('..')) return null;
  return rel || 'index.html';
}

const server = http.createServer((req, res) => {
  const rel = safePathFromUrl(req.url || '/');
  if (!rel) {
    res.statusCode = 400;
    res.end('bad request');
    return;
  }

  const filePath = path.join(rootDir, rel);

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`UI mock: http://127.0.0.1:${port}`);
});

