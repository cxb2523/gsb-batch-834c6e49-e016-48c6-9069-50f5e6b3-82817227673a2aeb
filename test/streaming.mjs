// Streaming / residency end-to-end check, no browser and no network beyond localhost.
//
// It builds a small procedural asset, serves it over a real HTTP server with HTTP Range support,
// and drives the runtime through the four situations the streaming contract has to survive:
//
//   A. normal path        - load finer levels frame by frame; the drawn triangle count converges
//                           monotonically, no cluster is drawn twice, and the final cut equals the
//                           cut of a non-streaming asset loaded whole.
//   B. rootBytes edge     - a root budget that only fits the coarsest layer still draws that whole
//                           layer (never a partial / non-resident root).
//   C. concurrency        - many instances and many updateStreaming() calls in one frame produce one
//                           load (one set of Range requests), never concurrent duplicates.
//   D. server ignores Range (200 instead of 206) - the load rejects, already-resident state is
//                           untouched, and the next frame retries successfully.
//   E. geometry swap      - the old BufferGeometry is disposed only after every batch already points
//                           at the new one, and a draw list made before the swap stays in range.
//
// Run: node test/streaming.mjs            (prints a table per scenario; exits non-zero on failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildClod } from '../src/build.js';
import { makeSample } from '../examples/make-sample.mjs';
import { loadClod, loadClodStream, updateStreaming, ClodBatch, ClodSelector } from '../src/index.js';

const quiet = () => {};

// ---------------------------------------------------------------- local Range server
// Serves any <stem>.json and <stem>.bin out of `dir`. Tracks every request so the test can assert
// on how many Range requests were issued and how many ran concurrently.
function startServer(dir, name) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const bin = fs.readFileSync(path.join(dir, `${name}.bin`));
  const state = { requests: [], ignoreRange: false, delayMs: 0, inflight: 0, maxInflight: 0, started: 0 };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const stem = u.pathname.endsWith('.json') ? u.pathname.slice(1, -5) : u.pathname.endsWith('.bin') ? u.pathname.slice(1, -4) : null;
    if (!stem) { res.writeHead(404); res.end(); return; }
    const file = path.join(dir, u.pathname.slice(1));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const bytes = fs.readFileSync(file);
    if (u.pathname.endsWith('.json')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(bytes); return; }
    state.inflight++; state.maxInflight = Math.max(state.maxInflight, state.inflight);
    res.on('close', () => { state.inflight--; });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (state.ignoreRange || !m) {
      state.requests.push({ asset: stem, status: 200, range: null, bytes: bytes.length });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      res.end(bytes); return;
    }
    const a = +m[1], b = Math.min(+m[2], bytes.length - 1);
    state.requests.push({ asset: stem, status: 206, range: [a, b], bytes: b - a + 1 });
    res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${bytes.length}`, 'content-length': b - a + 1 });
    res.end(bytes.subarray(a, b + 1));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, state, meta, close: () => new Promise((r) => server.close(r)) });
  }));
}

// ---------------------------------------------------------------- helpers
function makeCamera(near = 2.2) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 1000);
  cam.position.set(0, 2.6, near + 4); cam.lookAt(0, 0.4, 0);
  cam.updateMatrixWorld(); return cam;
}
function sceneBatch(asset, count = 12, spread = 1.7, scale = 0.5) {
  const side = Math.ceil(Math.sqrt(count)), matrices = [];
  for (let k = 0; k < count; k++) matrices.push(new THREE.Matrix4().compose(
    new THREE.Vector3((k % side) * spread - (side - 1) * spread / 2, 0.4, Math.floor(k / side) * spread - (side - 1) * spread / 2),
    new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
  return new ClodBatch(asset, new THREE.MeshBasicMaterial(), matrices);
}
// what the draw list actually contains, per instance
function drawList(b) {
  const per = new Map();
  let bytes = 0;
  for (let n = 0; n < b._multiDrawCount; n++) {
    const i = b.indirect[n * 2], c = b.indirect[n * 2 + 1] & 0xffffff;
    if (!per.has(i)) per.set(i, []);
    per.get(i).push({ c, start: b._multiDrawStarts[n], count: b._multiDrawCounts[n] });
    bytes = Math.max(bytes, b._multiDrawStarts[n] + b._multiDrawCounts[n] * 4);
  }
  return { per, bytes };
}
function cutSummary(b) {
  const { per } = drawList(b);
  let tris = 0, entries = 0, duplicates = 0, nonResident = 0, outOfRange = 0;
  const idx = b.asset.idx || b.asset.geometry.index.array;
  const bufBytes = idx.byteLength;
  for (const [i, list] of per) {
    const seen = new Set();
    for (const x of list) {
      entries++; tris += x.count / 3;
      if (seen.has(x.c)) duplicates++; seen.add(x.c);
      if (b.asset.clusterU[x.c * 4 + 3] < b.asset.loadedLevel) nonResident++;
      if (x.start < 0 || x.start + x.count * 4 > bufBytes) outOfRange++;
    }
  }
  return { insts: per.size, entries, tris, duplicates, nonResident, outOfRange };
}
// Residency-aware reference cut: descend only into groups whose members are all loaded.
// Returns the exact set of clusters a correct selector must draw per instance.
function referenceCut(b) {
  const a = b.asset, cU = a.clusterU, gF = a.groupF;
  const K = b._K, per = new Map();
  for (let i = 0; i < b.count; i++) if (b.visible_[i]) {
    const cx = b.camL[i * 3], cy = b.camL[i * 3 + 1], cz = b.camL[i * 3 + 2];
    const err = (g) => { const o = g * 5, dx = gF[o] - cx, dy = gF[o + 1] - cy, dz = gF[o + 2] - cz, d = Math.sqrt(dx * dx + dy * dy + dz * dz) - gF[o + 3]; return d <= 1e-6 ? Infinity : gF[o + 4] * K / d; };
    const S = new Set([0]), q = [0];
    while (q.length) {
      const g = q.pop();
      for (let k = a.memberOff[g]; k < a.memberOff[g + 1]; k++) {
        const s = cU[a.memberIds[k] * 4 + 2];
        if (s < 0 || S.has(s)) continue;
        if (err(s) <= b._threshold) continue;
        if (!a.groupResident(s)) continue;
        S.add(s); q.push(s);
      }
    }
    const D = new Set();
    for (const g of S) for (let k = a.memberOff[g]; k < a.memberOff[g + 1]; k++) {
      const c = a.memberIds[k], s = cU[c * 4 + 2];
      if (s >= 0 && S.has(s)) continue;
      D.add(c);
    }
    per.set(i, D);
  }
  return per;
}
function compareToReference(b, floorPx, sel) {
  b._K = sel.K; b._threshold = floorPx;
  const ref = referenceCut(b), got = drawList(b).per;
  let missing = 0, extra = 0;
  for (const [i, D] of ref) {
    const G = new Set((got.get(i) || []).map((x) => x.c));
    for (const c of D) if (!G.has(c)) missing++;
    for (const c of G) if (!D.has(c)) extra++;
  }
  return { missing, extra };
}
const fmt = (n) => (typeof n === 'number' ? (Math.abs(n) >= 1e5 ? (n / 1e3).toFixed(1) + 'k' : String(n)) : String(n));

// ---------------------------------------------------------------- scenarios
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'three-nanite-stream-'));
let server;
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); return cond; };

try {
  const name = 'stream';
  const glb = path.join(tmp, `${name}.glb`);
  fs.writeFileSync(glb, makeSample('rock', { texture: 32 }));
  const built = await buildClod({ input: glb, outDir: tmp, name, maxTriangles: 60000, lods: false, log: quiet });
  assert.ok(built.meta.levels >= 5, 'need a hierarchy deep enough to stream');
  // a second asset of a different shape, for the multi-asset scenarios
  const name2 = 'stream2';
  fs.writeFileSync(path.join(tmp, `${name2}.glb`), makeSample('column', { texture: 16 }));
  await buildClod({ input: path.join(tmp, `${name2}.glb`), outDir: tmp, name: name2, maxTriangles: 30000, lods: false, log: quiet });
  server = await startServer(tmp, name);
  const LR = server.meta.levelRanges; // coarsest first
  const rootBytes = LR[0].bytes;

  const whole = await loadClod(server.url, name);        // reference: everything resident
  const camera = makeCamera();

  // ---- A. normal path
  console.log('\nA. normal path (progressive load, errorPx 0.5)');
  {
    server.state.requests.length = 0;
    const a = await loadClodStream(server.url, name, { rootBytes });
    a.groupResident = a.groupResident.bind(a);
    const b = sceneBatch(a);
    const sel = new ClodSelector([b]);
    sel.frustumCull = false;
    const rows = []; let prev = -1, mono = true, badCut = 0, dupTotal = 0;
    for (let frame = 0; frame < 40; frame++) {
      const st = sel.select(camera, 1080, { errorPx: 0.5, budget: 0 });
      const c = cutSummary(b);
      const ref = compareToReference(b, 0.5, sel);
      rows.push({ frame, loaded: a.loadedLevel, tris: Math.round(c.tris), stats: Math.round(st.tris), entries: c.entries, dup: c.duplicates, refMiss: ref.missing, refExtra: ref.extra, nonRes: c.nonResident, oob: c.outOfRange });
      if (prev >= 0 && c.tris < prev - 1e-6) mono = false;
      prev = c.tris; dupTotal += c.duplicates;
      if (ref.missing || ref.extra || c.nonResident || c.outOfRange || Math.abs(st.tris - c.tris) > 1e-6) badCut++;
      updateStreaming([a]);
      await new Promise((r) => setTimeout(r, 0));
      if (a.loadedLevel === 0 && !a.loading) { // one more frame to confirm the stable cut
        const st2 = sel.select(camera, 1080, { errorPx: 0.5, budget: 0 });
        const c2 = cutSummary(b);
        const ref2 = compareToReference(b, 0.5, sel);
        rows.push({ frame: frame + 1, loaded: a.loadedLevel, tris: Math.round(c2.tris), stats: Math.round(st2.tris), entries: c2.entries, dup: c2.duplicates, refMiss: ref2.missing, refExtra: ref2.extra, nonRes: c2.nonResident, oob: c2.outOfRange });
        if (prev >= 0 && c2.tris < prev - 1e-6) mono = false;
        if (ref2.missing || ref2.extra || c2.nonResident || c2.outOfRange) badCut++;
        break;
      }
    }
    // the fully streamed cut must equal the cut of an asset loaded whole
    const refBatch = sceneBatch(whole);
    const refSel = new ClodSelector([refBatch]); refSel.frustumCull = false;
    const refSt = refSel.select(camera, 1080, { errorPx: 0.5, budget: 0 });
    const refC = cutSummary(refBatch);
    console.log('  frame loaded   drawn  stats entries dup refMiss refExtra nonRes oob');
    for (const r of rows) console.log(`  ${String(r.frame).padStart(5)} ${String(r.loaded).padStart(6)} ${String(fmt(r.tris)).padStart(8)} ${String(fmt(r.stats)).padStart(6)} ${String(r.entries).padStart(7)} ${String(r.dup).padStart(3)} ${String(r.refMiss).padStart(7)} ${String(r.refExtra).padStart(8)} ${String(r.nonRes).padStart(6)} ${String(r.oob).padStart(3)}`);
    console.log(`  whole-asset cut: ${fmt(refC.tris)} tris, streamed final: ${fmt(rows.at(-1).tris)} tris`);
    check(a.loadedLevel === 0, 'A: asset fully loaded at the end');
    check(mono, 'A: drawn triangle count is monotonically non-decreasing while levels arrive');
    check(dupTotal === 0, 'A: no cluster drawn twice');
    check(badCut === 0, 'A: every frame is a complete, crack-free cut over resident data');
    check(rows.at(-1).tris === refC.tris && Math.abs(refSt.tris - refC.tris) <= 1e-6, 'A: streamed final cut equals the whole-asset cut');
  }

  // ---- B. rootBytes only fits the coarsest layer
  console.log('\nB. rootBytes boundary (only the coarsest layer fits)');
  {
    const rootLevel = Math.min(LR[0].level, server.meta.levelRanges[0].level);
    const rootTris = (() => { // triangles in every cluster at the coarsest level (the root group)
      const meta = server.meta;
      const bin = fs.readFileSync(path.join(tmp, `${name}.bin`));
      const s = meta.sections.clusterU, cU = new Int32Array(bin.buffer, bin.byteOffset + s.offset, s.bytes / 4);
      let t = 0; for (let c = 0; c < meta.clusters; c++) if (cU[c * 4 + 3] >= LR[0].level) t += cU[c * 4 + 1] / 3;
      return t;
    })();
    for (const rb of [0, 1, Math.floor(rootBytes / 2), rootBytes]) {
      const a = await loadClodStream(server.url, name, { rootBytes: rb });
      const b = sceneBatch(a, 1, 0, 1);
      const sel = new ClodSelector([b]); sel.frustumCull = false;
      const st = sel.select(camera, 1080, { errorPx: 1e9, budget: 0 });
      const c = cutSummary(b);
      console.log(`  rootBytes ${String(rb).padStart(7)} -> loadedLevel ${a.loadedLevel} (rootLayer ${LR[0].level}), drawn ${c.tris} tris, expected root layer ${rootTris}, nonResident ${c.nonResident}, oob ${c.outOfRange}`);
      check(a.loadedLevel <= LR[0].level, `B: loadedLevel ${a.loadedLevel} covers the coarsest layer for rootBytes ${rb}`);
      check(c.tris === rootTris, `B: rootBytes ${rb} draws the complete coarse layer (${c.tris} vs ${rootTris})`);
      check(c.nonResident === 0 && c.outOfRange === 0, `B: rootBytes ${rb} never draws non-resident or out-of-range data`);
      check(Math.abs(st.tris - c.tris) <= 1e-6, `B: rootBytes ${rb} stats match the draw list`);
    }
  }

  // ---- C. concurrency: one load per asset per frame
  console.log('\nC. concurrency (many instances, repeated calls in one frame)');
  {
    const a = await loadClodStream(server.url, name, { rootBytes });
    const batches = [sceneBatch(a, 8), sceneBatch(a, 8), sceneBatch(a, 8)];
    const sel = new ClodSelector(batches);
    for (const b of batches) sel.frustumCull = false;
    server.state.requests.length = 0; server.state.maxInflight = 0; server.state.delayMs = 5;
    // frame 1 asks for an intermediate level (a coarse error threshold) so a later frame still has
    // a genuinely finer level to request. Feeds many instances and many updateStreaming calls.
    for (let k = 0; k < 4; k++) sel.select(camera, 1080, { errorPx: 12, budget: 0 });
    let pending = [];
    for (let k = 0; k < 6; k++) pending.push(...updateStreaming([a, a, a]));
    const startedWhileBusy = pending.length;
    await Promise.all(pending);
    const firstLoadRequests = server.state.requests.length;
    check(a.loadedLevel > 0, `C: the first load stopped at an intermediate level (got ${a.loadedLevel})`);
    // frame 2 at a fine threshold while the asset is idle: one more sequential load
    for (let k = 0; k < 4; k++) sel.select(camera, 1080, { errorPx: 0.2, budget: 0 });
    let pending2 = [];
    for (let k = 0; k < 6; k++) pending2.push(...updateStreaming([a, a, a]));
    await Promise.all(pending2);
    const secondLoadRequests = server.state.requests.length - firstLoadRequests;
    server.state.delayMs = 0;
    console.log(`  frame 1: ${startedWhileBusy} load(s), ${firstLoadRequests} Range request(s), max concurrent ${server.state.maxInflight}`);
    console.log(`  frame 2: ${pending2.length} load(s), ${secondLoadRequests} Range request(s)`);
    check(startedWhileBusy === 1, `C: one load started regardless of how many batches/calls ask (got ${startedWhileBusy})`);
    check(firstLoadRequests === 4, `C: one level load = 4 Range requests (position/normal/uv/index), got ${firstLoadRequests}`);
    check(server.state.maxInflight <= 4, `C: no duplicate concurrent Range requests (max in flight ${server.state.maxInflight})`);
    check(pending2.length === 1 && secondLoadRequests === 4, `C: the next frame continues sequentially with one more load (got ${pending2.length}/${secondLoadRequests})`);
    check(a.loadedLevel < LR[Math.min(2, LR.length - 1)].level, `C: the second load reached a finer level than the first (loadedLevel ${a.loadedLevel})`);
  }

  // ---- D. server ignores Range
  console.log('\nD. negative path (HTTP 200 instead of 206)');
  {
    const a = await loadClodStream(server.url, name, { rootBytes });
    const b = sceneBatch(a, 4);
    const sel = new ClodSelector([b]); sel.frustumCull = false;
    sel.select(camera, 1080, { errorPx: 0.05, budget: 0 });
    const before = { loaded: a.loadedLevel, geometry: a.geometry, pos: a.pos, idx: a.idx, version: a.geometryVersion ?? 0 };
    server.state.ignoreRange = true; server.state.requests.length = 0;
    let err = null;
    try { await Promise.all(updateStreaming([a])); } catch (e) { err = e; }
    const after = { loaded: a.loadedLevel, geometry: a.geometry, pos: a.pos, idx: a.idx, version: a.geometryVersion ?? 0 };
    console.log(`  error: ${err && /Range/i.test(err.message) ? 'reported' : 'MISSING'} (${err && err.message})`);
    console.log(`  state preserved: loadedLevel ${before.loaded} -> ${after.loaded}, geometry same ${after.geometry === before.geometry}, pos same ${after.pos === before.pos}, idx same ${after.idx === before.idx}`);
    console.log(`  loading flag after failure: ${a.loading === null ? 'cleared' : 'STUCK'}`);
    check(err && /Range/i.test(err.message), 'D: a 200 response for a Range request reports an error');
    check(after.loaded === before.loaded && after.geometry === before.geometry && after.pos === before.pos && after.idx === before.idx, 'D: already-resident geometry and level are untouched');
    check(a.loading === null, 'D: the failed load does not wedge the asset');
    // selection still works on the preserved state
    const st = sel.select(camera, 1080, { errorPx: 0.05, budget: 0 });
    const c = cutSummary(b);
    check(c.nonResident === 0 && c.outOfRange === 0 && Math.abs(st.tris - c.tris) <= 1e-6, 'D: selection still produces a valid cut from resident data');
    // and the next frame retries successfully once the server is fixed. The failed Promise.all
    // rejects on its first failed range while the other three are still on the wire, so let the
    // request log go quiet before measuring the retry window.
    server.state.ignoreRange = false;
    for (let i = 0, last = -1, still = 0; i < 400 && still < 4; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (server.state.requests.length === last) still++; else { still = 0; last = server.state.requests.length; }
    }
    server.state.requests.length = 0;
    const retry = updateStreaming([a]);
    await Promise.all(retry);
    console.log(`  retry: ${retry.length} load(s), ${server.state.requests.length} Range request(s), loadedLevel now ${a.loadedLevel}`);
    check(retry.length === 1, `D: the next frame retries with exactly one load (got ${retry.length})`);
    check(a.loadedLevel < before.loaded, `D: the retry made progress (loadedLevel ${a.loadedLevel} < ${before.loaded})`);
    check(server.state.requests.length === 4, `D: the retry issued exactly one level's four Range requests (got ${server.state.requests.length})`);
  }

  // ---- E. geometry swap ordering
  console.log('\nE. geometry swap (attach before release)');
  {
    const a = await loadClodStream(server.url, name, { rootBytes });
    const batches = [sceneBatch(a, 4), sceneBatch(a, 4)];
    const sel = new ClodSelector(batches);
    let disposeViolations = 0, disposals = 0, mismatched = 0;
    const proto = THREE.BufferGeometry.prototype, original = proto.dispose;
    proto.dispose = function () {
      disposals++;
      if (a.geometry === this) disposeViolations++; // old geometry still the asset's geometry
      for (const b of batches) if (b.geometry === this) disposeViolations++; // a batch still on the old buffers
      return original.call(this);
    };
    try {
      for (let frame = 0; frame < 20 && a.loadedLevel > 0; frame++) {
        sel.select(camera, 1080, { errorPx: 0.1, budget: 0 });
        // draw list emitted before the swap; every range must stay inside the data that exists
        const pre = drawList(batches[0]);
        for (const [, list] of pre.per) for (const x of list) if (x.start + x.count * 4 > (a.idx || a.geometry.index.array).byteLength) mismatched++;
        updateStreaming([a]);
        await new Promise((r) => setTimeout(r, 0));
        // the same draw list, after the buffers grew and were replaced
        for (const [, list] of pre.per) for (const x of list) if (x.start + x.count * 4 > (a.idx || a.geometry.index.array).byteLength) mismatched++;
        for (const b of batches) if (b.geometry !== a.geometry) mismatched++;
      }
    } finally { proto.dispose = original; }
    console.log(`  swaps: ${a.geometryVersion}, geometries disposed: ${disposals}, disposed-while-referenced: ${disposeViolations}, stale draw ranges: ${mismatched}`);
    check(a.geometryVersion > 0 && disposals > 0, 'E: at least one swap happened');
    check(disposeViolations === 0, 'E: the old geometry is never disposed while a batch or the asset still points at it');
    check(mismatched === 0, 'E: a draw list made before a swap stays valid against the new buffers');
  }

  // ---- F. budget mode does not spend budget on skipped (non-resident) groups
  console.log('\nF. budget accounting with partially resident geometry');
  {
    const a = await loadClodStream(server.url, name, { rootBytes });
    const b = sceneBatch(a, 12);
    const sel = new ClodSelector([b]); sel.frustumCull = false;
    const rows = [];
    for (const level of [LR[Math.min(3, LR.length - 1)].level, 0]) {
      await a.loadTo(level);
      for (const budget of [3000, 8000, 20000]) {
        const st = sel.select(camera, 1080, { errorPx: 0.5, budget });
        const c = cutSummary(b);
        const ref = compareToReference(b, 0.5, sel); // threshold reference is separate; here check cut validity
        rows.push({ level: a.loadedLevel, budget, tris: c.tris, stats: st.tris, nonRes: c.nonResident });
        console.log(`  loadedLevel ${String(a.loadedLevel).padStart(2)} budget ${String(budget).padStart(5)} -> drawn ${fmt(Math.round(c.tris))}, stats ${fmt(Math.round(st.tris))}, nonResident ${c.nonResident}`);
        check(Math.abs(st.tris - c.tris) <= 1e-6, `F: budget stats equal the drawn count (L${level} b${budget})`);
        check(c.nonResident === 0, `F: budget mode never draws non-resident clusters (L${level} b${budget})`);
        check(c.tris <= budget * 1.12 + 512, `F: budget is not overspent by skipped groups (L${level} b${budget}: ${c.tris})`);
      }
    }
    // once fully loaded, the budget must actually be usable up to the resident cut
    const full = sel.select(camera, 1080, { errorPx: 1e9, budget: 0 });
    const fullCut = cutSummary(b);
    const big = sel.select(camera, 1080, { errorPx: 1e9, budget: Math.ceil(fullCut.tris) });
    const bigCut = cutSummary(b);
    console.log(`  fully loaded: threshold cut ${fmt(Math.round(fullCut.tris))}, budget=${fmt(Math.ceil(fullCut.tris))} draws ${fmt(Math.round(bigCut.tris))}`);
    check(Math.abs(bigCut.tris - fullCut.tris) <= 1e-6, 'F: a budget large enough for the resident cut reaches it (no phantom consumption)');
  }

  // ---- G. two assets in one scene: still one load per asset per frame, budget shared correctly
  console.log('\nG. two streaming assets in one frame');
  {
    const a1 = await loadClodStream(server.url, name, { rootBytes });
    const a2 = await loadClodStream(server.url, name2, { rootBytes: server.meta.levelRanges[0].bytes });
    const b1 = sceneBatch(a1, 6, 1.7, 0.5), b2 = sceneBatch(a2, 6, 1.7, 0.5);
    b2.position.x = 4;
    const sel = new ClodSelector([b1, b2]); sel.frustumCull = false;
    for (let k = 0; k < 3; k++) sel.select(camera, 1080, { errorPx: 8, budget: 0 });
    server.state.requests.length = 0;
    let pending = [];
    for (let k = 0; k < 4; k++) pending.push(...updateStreaming([a1, a2, a1, a2]));
    await Promise.all(pending);
    const byAsset = new Map();
    for (const r of server.state.requests) byAsset.set(r.asset, (byAsset.get(r.asset) || 0) + 1);
    console.log(`  ${pending.length} load(s), requests per asset: ${[...byAsset].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    check(pending.length === 2, `G: exactly one load per asset (got ${pending.length})`);
    check(byAsset.get(name) === 4 && byAsset.get(name2) === 4, `G: four Range requests per asset (got ${JSON.stringify([...byAsset])})`);

    // now budget mode over both assets, with one asset fully loaded and the other partial:
    // every cluster in the drawn cut must be resident, stats must match the draw list
    await a1.loadTo(0);
    const st = sel.select(camera, 1080, { errorPx: 0.5, budget: 6000 });
    const c1 = cutSummary(b1), c2 = cutSummary(b2);
    const drawn = c1.tris + c2.tris;
    console.log(`  budget 6000 over two assets: drawn ${fmt(Math.round(drawn))} (${fmt(Math.round(c1.tris))} + ${fmt(Math.round(c2.tris))}), stats ${fmt(Math.round(st.tris))}`);
    check(Math.abs(st.tris - drawn) <= 1e-6, 'G: stats match the combined draw list');
    check(c1.nonResident + c2.nonResident === 0, 'G: neither asset drew a non-resident cluster');
    check(drawn <= 6000 * 1.15 + 512, `G: the shared budget is not overspent (${Math.round(drawn)})`);
  }
} finally {
  if (server) await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nFAILED ${failures.length} check(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nok: streaming residency, request merging, geometry swap and budget accounting behave as specified');
