// Local development server: `npm start`. Plain HTTP on 127.0.0.1 only, serving
// public/ and the same lib/api.js handler the Vercel function uses. Storage is
// the filesystem and auth is off unless configured (decisions 006, 014).
// Production is the Vercel deploy, not this file.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleApi, sendJSON } = require('./lib/api.js');
// The Content-Security-Policy lives in vercel.json and nowhere else, so both
// the local server and production send the same one.
const SECURITY_HEADERS = require('./vercel.json').headers[0].headers;

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  try {
    requested = decodeURIComponent(requested);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const filePath = path.join(PUBLIC_DIR, requested);

  // path.relative is the reliable containment check — a startsWith() prefix
  // test would also accept a sibling folder like `public-backup`.
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  SECURITY_HEADERS.forEach(h => res.setHeader(h.key, h.value));

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url.searchParams).catch(e => {
      // Detail to the console, generic text to the client — same reasoning as
      // the serverless entry point in api/[...path].js.
      console.error(`Unhandled API error on ${pathname}: ${e.stack || e.message}`);
      sendJSON(res, 500, { error: 'Something went wrong on the server.' });
    });
  } else {
    serveStatic(req, res, pathname);
  }
}

http.createServer(requestListener).listen(PORT, HOST, () => {
  console.log(`Super-Squares dev server listening on http://${HOST}:${PORT}  (Ctrl+C to stop)`);
});
