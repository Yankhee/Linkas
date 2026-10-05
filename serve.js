'use strict';

// Only for trying Linkas on this PC: serves the public/ folder on http://localhost:3000
// (browsers allow the camera and microphone on localhost). Online, Linkas needs no server of its own:
// public/ is a static site (GitHub Pages, Netlify, Cloudflare Pages ...), see README.md.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.tflite': 'application/octet-stream',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(ROOT, url.endsWith('/') ? `${url}index.html` : url);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  });
}).listen(PORT, () => console.log(`Linkas (local test) on http://localhost:${PORT} - press Ctrl+C to stop`));
