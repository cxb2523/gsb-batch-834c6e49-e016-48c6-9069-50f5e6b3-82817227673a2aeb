import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

// Footage is read with Range requests, and the browser aborts many of them while seeking. Every file stream the
// server opens must close when its request is aborted, or the viewer runs out of file handles (EMFILE).
test('a file stream closes when its request is aborted', async () => {
  const open = new Set(), real = fs.createReadStream;
  fs.createReadStream = (...args) => { const s = real(...args); open.add(s); s.on('close', () => open.delete(s)); return s; };
  syncBuiltinESMExports();
  const dir = fs.mkdtempSync(join(tmpdir(), 'motlab-server-')), file = join(dir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024));
  const { startServer } = await import(`../src/server.js?abort=${Date.now()}`);
  const server = await startServer({ root: dir });
  try {
    const abortAfterFirstChunk = range => new Promise(ok => {
      const req = request(`${server.origin}/big.bin`, { headers: range ? { Range: range } : {} }, res => res.once('data', () => { req.destroy(); ok(); }));
      req.on('error', ok); req.end();
    });
    for (let i = 0; i < 20; i++) await abortAfterFirstChunk(i % 2 ? 'bytes=0-' : null);
    for (let i = 0; i < 50 && open.size; i++) await sleep(20);
    assert.equal(open.size, 0, `${open.size} file streams still open after 20 aborted requests`);
  } finally {
    await server.close(); fs.createReadStream = real; syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// With trackFetches the server records the project files the page fetches, relative to the served root, so the render
// cache key can hash them. Built-in /__motlab libraries and uploads are not project files and are not recorded.
test('trackFetches records the project files fetched, relative to the root, and skips built-in libs', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'motlab-server-fetch-'));
  fs.mkdirSync(join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(join(dir, 'scene.html'), '<html></html>');
  fs.writeFileSync(join(dir, 'lib', 'shared.js'), 'export const x = 1;');
  const { startServer } = await import(`../src/server.js?fetch=${Date.now()}`);
  const plain = await startServer({ root: dir });
  assert.equal(typeof plain.fetchedFiles, 'function');
  assert.deepEqual(plain.fetchedFiles(), []);   // tracking is opt-in
  await plain.close();
  const server = await startServer({ root: dir, trackFetches: true });
  try {
    const get = path => new Promise((ok, no) => request(`${server.origin}${path}`, r => { r.resume(); r.on('end', ok); }).on('error', no).end());
    await get('/scene.html');
    await get('/lib/shared.js');
    await get('/scene.html');   // a repeat is deduplicated
    await get('/__motlab/motion.js');   // a built-in library, not a project file
    assert.deepEqual(server.fetchedFiles().sort(), ['lib/shared.js', 'scene.html']);
    await get('/missing.bin');   // a 404 is not a fetched dependency
    assert.ok(!server.fetchedFiles().includes('missing.bin'));
  } finally {
    await server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
