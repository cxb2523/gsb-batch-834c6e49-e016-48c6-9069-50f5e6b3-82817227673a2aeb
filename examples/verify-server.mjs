// Static server for the browser verification page.
// Serves the repo's src/ and three.js as ES modules, the built demo data with HTTP Range support,
// and lets the page flip the Range behaviour at runtime to exercise the 200-instead-of-206 path.
//
//   node examples/verify-server.mjs [port]     (default 5292)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.join(import.meta.dirname, '..');
const dataDir = path.join(import.meta.dirname, 'public', 'data');
const port = +(process.argv[2] || 5292);
const state = { ignoreRange: false, delayMs: 0, requests: [] };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg' };

function sendFile(res, file, rangeHeader) {
  const st = fs.statSync(file), size = st.size;
  res.setHeader('accept-ranges', 'bytes');
  const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || '');
  if (m) {
    const a = +m[1], b = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1);
    if (a >= size || b < a) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    state.requests.push({ file: path.basename(file), status: 206, range: [a, b], bytes: b - a + 1 });
    res.writeHead(206, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
    return;
  }
  // the fault-injection path: a client asked for a Range but the server sends the whole file with 200
  state.requests.push({ file: path.basename(file), status: 200, range: null, bytes: size });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': size });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/__state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); return; }
  if (p === '/__config') {
    if (url.searchParams.has('ignoreRange')) state.ignoreRange = url.searchParams.get('ignoreRange') === '1';
    if (url.searchParams.has('delayMs')) state.delayMs = +url.searchParams.get('delayMs');
    if (url.searchParams.has('reset')) state.requests.length = 0;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); return;
  }
  if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
  let file = null;
  if (p === '/' || p === '/verify.html') file = path.join(import.meta.dirname, 'verify.html');
  else if (p === '/verify.js') file = path.join(import.meta.dirname, 'verify.js');
  else if (p === '/three.module.js') file = path.join(root, 'node_modules/three/build/three.module.js');
  else if (p === '/three.core.js') file = path.join(root, 'node_modules/three/build/three.core.js');
  else if (p.startsWith('/src/')) file = path.join(root, p);
  else if (p.startsWith('/data/')) file = path.join(dataDir, p.slice('/data/'.length));
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(`not found: ${p}`); return; }
  const isBin = file.endsWith('.bin');
  if (isBin && state.ignoreRange) { sendFile(res, file, null); return; }
  sendFile(res, file, req.headers.range);
});
server.listen(port, '127.0.0.1', () => console.log(`verify page: http://127.0.0.1:${port}/`));
