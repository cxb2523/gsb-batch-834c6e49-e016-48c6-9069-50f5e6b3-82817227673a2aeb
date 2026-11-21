// The project render's part cache, without Chrome or ffmpeg: renderVideo and ffprobe are injected fakes, so the three
// cache behaviours run locally and fast.
//  1. the cache key covers the content of the shared files a scene fetched (script, font, picture); a change re-renders
//     that scene and the transitions touching it,
//  2. when the parallel pass fails and falls back to serial, parts that finished are not rendered again, only the
//     missing ones are, and the original parallel failure stays on the final error,
//  3. part MP4s and manifests are written through temp files and an atomic rename; abort or failure removes the temp
//     files and the cache sweep never mistakes them for parts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PartCache, atomicWriteJson, dependencyHashes, partKey } from '../src/partcache.js';
import { renderProject } from '../src/project.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-cache-test-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');
const quiet = { log: () => {} };
// Each test uses its own project folder, hence its own parts subfolder, so the cache of one test never reaches another;
// the whole tree is removed at the end. Do not clear it between runs inside a test — that is what the cache tests test.
after(() => rmSync(dir, { recursive: true, force: true }));

const fade = { type: 'fade', duration: 0.5, ease: 'linear' };
const flat = (proj, name, colour) => {
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
  const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
  window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 320, 180); };</script>`);
};

// Every rendered part is 30 1/30-s frames at 320x180, full range, software h264 — the shape of a real summary. The
// fake "renders" by writing a small file to the requested out path and reporting which project files the page fetched.
function makeRenderer({ failPage = null, failFirstOnly = false, alwaysFail = false, fetchedFor = null } = {}) {
  const calls = [];
  const renderer = async o => {
    const id = o.page ? `scene:${o.page.split(/[\\/]/).pop()}`
      : `transition:${new URLSearchParams(o.query).get('from')}->${new URLSearchParams(o.query).get('to')}`;
    calls.push(id);
    if (o.signal?.aborted) throw o.signal.reason || new Error('aborted');
    if (failPage && o.page && o.page.endsWith(failPage)) {
      if (alwaysFail) throw new Error(`persistent failure in ${failPage}`);
      // failFirstOnly: the parallel attempt fails, the serial retry of the same part succeeds
      if (failFirstOnly) { failFirstOnly = false; throw new Error(`parallel failure in ${failPage}`); }
    }
    const pageName = o.page ? o.page.split(/[\\/]/).pop() : null;
    // the real server records fetched files as paths relative to the served project root. By default only scene b
    // pulls in the shared script, so a change to it invalidates just b and the transition that draws b's frames.
    const defaultFetched = pageName === 'b.html' ? ['b.html', 'lib/shared.js']
      : pageName ? [pageName] : ['a.html', 'b.html', 'lib/shared.js'];
    const fetched = fetchedFor ? fetchedFor(o) : defaultFetched;
    writeFileSync(o.out, Buffer.from(`part ${calls.length} ${id}`));
    return { out: o.out, frames: 30, pageFrames: 30, duration: 1, width: 320, height: 180, fullRange: true, codec: 'h264', hw: false, fps: 30, fetched };
  };
  return { renderer, calls };
}
const fakeProbe = async file => ({ frames: 30, duration: 1, width: 320, height: 180 });
const fakeFinalize = async ({ inputs, out }) => writeFileSync(out, inputs.map(() => 'x').join(''));

function partsDir(proj) {
  return join(process.env.MOTLAB_CACHE_DIR, 'parts', partKey(join(proj, 'project.json')).slice(0, 16));
}

// ---------------------------------------------------------------- 1. fetched shared resources are in the cache key

test('cache key: a fetched shared script changing re-renders the scene and both adjacent transitions, nothing else', async () => {
  const proj = join(dir, 'dep');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00'); flat(proj, 'd.html', '#00f');
  mkdirSync(join(proj, 'lib'), { recursive: true });
  writeFileSync(join(proj, 'lib', 'shared.js'), 'export const x = 1;');
  // b sits between two transitions: a->b (into b) and b->c (out of b); d follows on a hard cut
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, { file: 'c.html', transition: fade }, 'd.html'] }));
  const { renderer, calls } = makeRenderer();
  await renderProject({ dir: proj, out: join(dir, 'dep1.mp4'), scale: 1, parallel: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  assert.equal(calls.length, 6);   // 4 scenes + 2 transitions
  const cache = partsDir(proj);
  const mp4s = () => readdirSync(cache).filter(f => f.endsWith('.mp4'));
  assert.equal(mp4s().length, 6);

  // nothing changed: every part, including both transitions, is reused from the cache
  calls.length = 0;
  const logs2 = [];
  await renderProject({ dir: proj, out: join(dir, 'dep2.mp4'), scale: 1, parallel: 1, log: m => logs2.push(m), renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  assert.deepEqual(calls, []);
  assert.equal(mp4s().length, 6);
  assert.ok(logs2.some(l => l.includes('Transition 1 to 2: fade, 15 frames (cached)')), logs2.join('\n'));

  // the shared script changes content without a page changing: scene b (which fetches it) and the two transitions
  // touching b re-render; scenes a, c, d and no other part are touched
  writeFileSync(join(proj, 'lib', 'shared.js'), 'export const x = 2;');
  calls.length = 0;
  const logs3 = [];
  await renderProject({ dir: proj, out: join(dir, 'dep3.mp4'), scale: 1, parallel: 1, log: m => logs3.push(m), renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  const rendered = calls;
  assert.deepEqual(new Set(rendered), new Set(['scene:b.html', 'transition:a.html->b.html', 'transition:b.html->c.html']));
  assert.ok(logs3.some(l => l.includes('Scene 2/4: b.html')), logs3.join('\n'));
  assert.equal(mp4s().length, 6);   // the three old parts are pruned as the new ones are published
});

test('cache key: --only still forces its scenes and touching transitions, regardless of deps', async () => {
  const proj = join(dir, 'dep-only');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html'] }));
  const { renderer, calls } = makeRenderer();
  const opts = { scale: 1, parallel: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize };
  await renderProject({ dir: proj, out: join(dir, 'do1.mp4'), ...opts });
  calls.length = 0;
  await renderProject({ dir: proj, out: join(dir, 'do2.mp4'), ...opts, only: [2] });
  // scene b is forced by --only, and the transition touching it is forced too; a and c stay cached
  assert.deepEqual(new Set(calls), new Set(['scene:b.html', 'transition:a.html->b.html']));
});

test('cache key: fetched font and picture files are hashed too, and a file appearing or disappearing invalidates', async () => {
  const proj = join(dir, 'dep2');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'font.woff2'), 'font-bytes-1');
  writeFileSync(join(proj, 'pic.png'), 'png-bytes-1');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'] }));
  const fetchedFor = o => o.page.endsWith('a.html') ? ['a.html', 'font.woff2', 'pic.png'] : ['b.html'];
  const { renderer, calls } = makeRenderer({ fetchedFor });
  await renderProject({ dir: proj, out: join(dir, 'f1.mp4'), scale: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  assert.equal(calls.length, 2);

  // the font changes: only scene a re-renders
  writeFileSync(join(proj, 'font.woff2'), 'font-bytes-2');
  calls.length = 0;
  await renderProject({ dir: proj, out: join(dir, 'f2.mp4'), scale: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  assert.deepEqual(calls, ['scene:a.html'], calls.join('|'));

  // the picture disappears: its hash turns to null, scene a is stale again
  rmSync(join(proj, 'pic.png'));
  calls.length = 0;
  await renderProject({ dir: proj, out: join(dir, 'f3.mp4'), scale: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  assert.deepEqual(calls, ['scene:a.html'], calls.join('|'));
});

test('cache key: dependencyHashes is content-addressed and order-independent', () => {
  const root = join(dir, 'hash-root');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.js'), 'aaa'); writeFileSync(join(root, 'b.js'), 'bbb');
  const h1 = dependencyHashes(root, ['a.js', 'b.js']);
  const h2 = dependencyHashes(root, ['b.js', 'a.js', 'a.js']);
  assert.deepEqual(h1, h2);
  assert.deepEqual(Object.keys(h1), ['a.js', 'b.js']);
  const h3 = dependencyHashes(root, ['a.js', 'gone.js']);
  assert.equal(h3['gone.js'], null);   // a missing file cannot match any recorded content hash
  writeFileSync(join(root, 'a.js'), 'aaa-changed');
  assert.notEqual(dependencyHashes(root, ['a.js'])['a.js'], h1['a.js']);   // a content change changes the hash
  // feeding a manifest object (the lookup path) hashes the same files as feeding the fetched path list
  assert.deepEqual(dependencyHashes(root, { 'b.js': 'whatever' }), { 'b.js': h1['b.js'] });
});

// --------------------------------------------- 2. parallel failure falls back to serial without re-rendering the done

test('parallel fallback: finished parts are kept, only missing parts render again, and the first failure is reported', async () => {
  const proj = join(dir, 'fallback');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00'); flat(proj, 'd.html', '#00f');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html', { file: 'd.html', transition: fade }] }));
  const { renderer, calls } = makeRenderer({ failPage: 'c.html', failFirstOnly: true });
  // Mark the parts whose render actually finished (returned) during the parallel pass; those must never render again.
  const finished = new Set();
  const trackingRenderer = async o => {
    const r = await renderer(o);
    const id = o.page ? `scene:${o.page.split(/[\\/]/).pop()}`
      : `transition:${new URLSearchParams(o.query).get('from')}->${new URLSearchParams(o.query).get('to')}`;
    finished.add(id);
    return r;
  };
  const logs = [];
  await renderProject({ dir: proj, out: join(dir, 'fb.mp4'), scale: 1, parallel: 3, log: m => logs.push(m), renderer: trackingRenderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });

  const count = id => calls.filter(c => c === id).length;
  // Requirement: every part that had finished before the parallel failure is rendered exactly once. The failed scene
  // (the only part allowed a second attempt) and the transition still waiting on it are excluded from that check.
  for (const id of finished) {
    if (id === 'scene:c.html') continue;
    assert.equal(count(id), 1, `finished part ${id} was rendered again (${count(id)} times)`);
  }
  assert.equal(count('scene:c.html'), 2, 'the failed scene is tried once in parallel and once serially');
  assert.ok(logs.some(l => l.includes('Rendering the remaining parts one at a time')), logs.join('\n'));
  assert.ok(existsSync(join(dir, 'fb.mp4')));
});

test('parallel fallback: a part that fails again stops the render with both failure reasons', async () => {
  const proj = join(dir, 'fallback2');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html'] }));
  const { renderer, calls } = makeRenderer({ failPage: 'c.html', alwaysFail: true });   // fails in parallel and again on its own
  await assert.rejects(
    renderProject({ dir: proj, out: join(dir, 'fb2.mp4'), scale: 1, parallel: 3, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize }),
    e => /persistent failure in c\.html/.test(e.message) && /parallel render had first failed with:.*persistent failure in c\.html/s.test(e.message)
  );
  const count = id => calls.filter(c => c === id).length;
  for (const id of new Set(calls)) {
    if (id === 'scene:c.html') assert.equal(count(id), 2, `${id} should be tried once in parallel and once serially`);
    else assert.equal(count(id), 1, `${id} rendered ${count(id)} times`);
  }
  assert.ok(!existsSync(join(dir, 'fb2.mp4')));
});

test('parallel fallback: an external abort does not start the serial pass', async () => {
  const proj = join(dir, 'fallback3');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html'] }));
  const ac = new AbortController();
  const renderer = async o => {
    if (o.page && o.page.endsWith('b.html')) ac.abort();
    if (o.signal?.aborted) throw o.signal.reason ?? new Error('aborted');
    writeFileSync(o.out, Buffer.from('x'));
    return { out: o.out, frames: 30, pageFrames: 30, duration: 1, width: 320, height: 180, fullRange: true, codec: 'h264', hw: false, fps: 30, fetched: [o.page.split(/[\\/]/).pop()] };
  };
  const logs = [];
  await assert.rejects(
    renderProject({ dir: proj, out: join(dir, 'fb3.mp4'), scale: 1, parallel: 3, log: m => logs.push(m), renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize, signal: ac.signal }),
    /abort/
  );
  assert.ok(!logs.some(l => l.includes('one at a time')), logs.join('\n'));
});

// ------------------------------------------------- 3. atomic writes: temp files only while writing, swept afterwards

test('atomic writes: a finished cache holds only keyed parts, never .tmp- files', async () => {
  const proj = join(dir, 'atomic');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', { file: 'b.html', transition: fade }] }));
  const { renderer } = makeRenderer();
  await renderProject({ dir: proj, out: join(dir, 'at.mp4'), scale: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize });
  const files = readdirSync(partsDir(proj));
  assert.ok(files.length >= 4);
  assert.deepEqual(files.filter(f => f.startsWith('.tmp-')), []);
  for (const f of files) assert.match(f, /^[0-9a-f]{64}\.(mp4|json)$/, f);
  // each manifest (named by the part's base key) points at an MP4 that exists, and every MP4 has a manifest for it
  const mp4s = new Set(files.filter(f => f.endsWith('.mp4')).map(f => f.slice(0, -4)));
  const manifests = files.filter(f => f.endsWith('.json'));
  assert.equal(mp4s.size, manifests.length);
  for (const jf of manifests) {
    const m = JSON.parse(readFileSync(join(partsDir(proj), jf)));
    assert.ok(mp4s.has(m.fullKey), `manifest ${jf} points at a missing MP4 ${m.fullKey}`);
    assert.equal(m.baseKey, jf.slice(0, -5));
  }
});

test('atomic writes: a render that fails removes its temp MP4 and leaves no half part behind', async () => {
  const proj = join(dir, 'atomic-fail');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html'] }));
  const renderer = async o => {
    if (o.page && o.page.endsWith('b.html')) throw new Error('b exploded');
    writeFileSync(o.out, Buffer.from('a-part'));
    return { out: o.out, frames: 30, pageFrames: 30, duration: 1, width: 320, height: 180, fullRange: true, codec: 'h264', hw: false, fps: 30, fetched: ['a.html'] };
  };
  await assert.rejects(
    renderProject({ dir: proj, out: join(dir, 'af.mp4'), scale: 1, parallel: 1, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize }),
    /b exploded/
  );
  const files = readdirSync(partsDir(proj));
  assert.deepEqual(files.filter(f => f.startsWith('.tmp-')), [], files.join(','));
  // scene a did finish and is a real, reusable part; scene b left nothing
  assert.ok(files.some(f => f.endsWith('.mp4')));
});

test('atomic writes: aborting mid-render deletes the in-flight temp files', async () => {
  const proj = join(dir, 'atomic-abort');
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'c.html', '#f00');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html', 'b.html', 'c.html'] }));
  const ac = new AbortController();
  const renderer = async o => {
    if (o.page && o.page.endsWith('c.html')) { ac.abort(); throw new Error('aborted'); }
    if (o.signal?.aborted) throw new Error('aborted');
    writeFileSync(o.out, Buffer.from('part'));
    return { out: o.out, frames: 30, pageFrames: 30, duration: 1, width: 320, height: 180, fullRange: true, codec: 'h264', hw: false, fps: 30, fetched: [o.page.split(/[\\/]/).pop()] };
  };
  await assert.rejects(
    renderProject({ dir: proj, out: join(dir, 'aa.mp4'), scale: 1, parallel: 2, ...quiet, renderer, probeVideoFn: fakeProbe, finalizeFn: fakeFinalize, signal: ac.signal }),
    /abort/
  );
  assert.deepEqual(readdirSync(partsDir(proj)).filter(f => f.startsWith('.tmp-')), []);
});

test('atomic writes: leftover .tmp- files from a dead run are swept, not read as parts', async () => {
  const proj = join(dir, 'atomic-sweep');
  flat(proj, 'a.html', '#000');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 30, scenes: ['a.html'] }));
  const cache = new PartCache(partsDir(proj), proj, { probe: fakeProbe });
  writeFileSync(join(cache.cacheRoot, '.tmp-123-1-x.mp4'), 'half');
  writeFileSync(join(cache.cacheRoot, '.tmp-123-2-y.json'), 'half');
  cache.sweep();
  assert.deepEqual(readdirSync(cache.cacheRoot).filter(f => f.startsWith('.tmp-')), []);

  // atomicWriteJson never leaves the target half-written: the temp file is gone after the rename
  const json = join(cache.cacheRoot, 'doc.json'), tmp = join(cache.cacheRoot, '.tmp-doc.json');
  atomicWriteJson(json, { ok: true }, tmp);
  assert.ok(existsSync(json)); assert.ok(!existsSync(tmp));
  assert.deepEqual(JSON.parse(readFileSync(json)), { ok: true });
});
