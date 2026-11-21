// Browser verification of the streaming / residency contract, on a real WebGL2 renderer.
//
// It loads one asset with loadClodStream, draws many instances through a real ClodBatch, and runs
// the whole acceptance list the same way a game loop would: select -> updateStreaming -> render.
// Everything it measures is shown on screen and also exposed as window.verify.* so a headless
// runner can read the same numbers back.
//
// The page needs examples/verify-server.mjs, which serves Range requests and can be told to answer
// 200 instead (the "server ignores Range" case). Query: ?asset=rock&count=12&rootBytes=auto
import * as THREE from 'three';
import { loadClodStream, updateStreaming, ClodBatch, ClodSelector, patchDebug, debugUniform } from '/src/index.js';

const q = new URLSearchParams(location.search);
const ASSET = q.get('asset') || 'rock';
const COUNT = +(q.get('count') || 12);
const DBG = +(q.get('dbg') || 1);
const hud = document.getElementById('hud'), out = document.getElementById('out');
const lines = [];
function log(text, cls = '') { lines.push(cls ? `<span class="${cls}">${text}</span>` : text); out.innerHTML = lines.join('\n'); }
function check(cond, msg) { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`, cond ? 'ok' : 'bad'); return !!cond; }
const api = async (p) => (await fetch(p)).json();

// ---- real renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
const gl = renderer.getContext();
const multiDraw = !!gl.getExtension('WEBGL_multi_draw');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x223044);
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(4, 8, 5); scene.add(sun);
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.02, 100);
camera.position.set(0, 1.5, 4.2); camera.lookAt(0, 0.4, 0);

// ---- asset: load the hierarchy plus a root page only
const rootBytes = q.get('rootBytes') === 'off' ? 0 : (q.get('rootBytes') ? +q.get('rootBytes') : 96 * 1024);
const asset = await loadClodStream('/data', ASSET, { rootBytes });
const meta = asset.meta;
const material = patchDebug(new THREE.MeshStandardMaterial({ color: 0xb8b0a4, roughness: 0.9, metalness: 0 }));
debugUniform.value = DBG;

// instances in a row so most are on screen
const side = Math.ceil(Math.sqrt(COUNT)), scale = 1 / Math.max(meta.bbMax[0] - meta.bbMin[0], meta.bbMax[1] - meta.bbMin[1], meta.bbMax[2] - meta.bbMin[2]);
const matrices = [];
for (let k = 0; k < COUNT; k++) matrices.push(new THREE.Matrix4().compose(
  new THREE.Vector3((k % side - (side - 1) / 2) * 1.5, 0, (Math.floor(k / side) - (side - 1) / 2) * 1.5),
  new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)));
const batch = new ClodBatch(asset, material, matrices);
scene.add(batch);
const selector = new ClodSelector([batch]);
selector.frustumCull = false;
const opts = { errorPx: +(q.get('errorPx') || 0.25), budget: +(q.get('budget') || 0) };

// ---- what the draw list contains, per frame (reads the same arrays the renderer uses)
let prevTris = -1, frames = 0, monotone = true, duplicateTotal = 0, badCutFrames = 0;
const trace = [];
function inspect() {
  const idxBytes = (asset.idx || asset.geometry.index.array).byteLength;
  const per = new Map(); let tris = 0, entries = 0, dup = 0, nonResident = 0, oob = 0;
  for (let n = 0; n < batch._multiDrawCount; n++) {
    const i = batch.indirect[n * 2], c = batch.indirect[n * 2 + 1] & 0xffffff;
    if (!per.has(i)) per.set(i, new Set());
    if (per.get(i).has(c)) dup++; per.get(i).add(c);
    entries++; tris += batch._multiDrawCounts[n] / 3;
    if (asset.clusterU[c * 4 + 3] < asset.loadedLevel) nonResident++;
    const end = batch._multiDrawStarts[n] + batch._multiDrawCounts[n] * 4;
    if (end > idxBytes) oob++;
  }
  return { tris, entries, dup, nonResident, oob };
}
function frame() {
  const st = selector.select(camera, canvas.clientHeight, opts);
  const info = inspect();
  renderer.render(scene, camera);
  if (prevTris >= 0 && info.tris < prevTris - 1e-6) monotone = false;
  prevTris = info.tris; duplicateTotal += info.dup;
  if (info.dup || info.nonResident || info.oob || Math.abs(st.tris - info.tris) > 1e-6) badCutFrames++;
  frames++;
  trace.push({ frame: frames, loadedLevel: asset.loadedLevel, tris: Math.round(info.tris), entries: info.entries, statsTris: Math.round(st.tris), effPx: +st.threshold.toFixed(2) });
  return info;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// =====================================================================================
window.verify = { trace, result: null };
(async () => {
  log(`three r${THREE.REVISION}  ·  ${multiDraw ? 'WEBGL_multi_draw present' : 'no WEBGL_multi_draw'}`);
  log(`asset ${ASSET}: ${meta.clusters} clusters, ${meta.groups} groups, ${meta.levelRanges.length} levels, root level ${asset.rootLevel}, fully loaded level 0`);
  log(`camera looks at ${COUNT} instances, errorPx ${opts.errorPx}${opts.budget ? `, budget ${opts.budget}` : ''}`);
  log('');

  // ---- A. progressive load: watch the cut while levels arrive.
  // Selection normally asks for the finest level it wants in one go. To make the step-by-step
  // arrival visible, this loop caps each request one level finer than what is already resident,
  // so a viewer sees the cut refine frame after frame instead of jumping to the end.
  log('A. progressive load (select -> updateStreaming -> render each frame, one level per frame)', 'dim');
  const startLevel = asset.loadedLevel;
  const levelsDesc = meta.levelRanges.map((l) => l.level); // coarsest .. finest
  let pending = [];
  for (let i = 0; i < 1200 && (asset.loadedLevel > 0 || asset.loading); i++) {
    frame();
    asset.wantLevel = 255;
    selector.select(camera, canvas.clientHeight, opts);
    if (asset.wantLevel < asset.loadedLevel) {
      // next finer level, one step at a time
      const next = levelsDesc.find((l) => l < asset.loadedLevel && l >= asset.wantLevel);
      asset.wantLevel = next;
    }
    pending.push(...updateStreaming([asset]));
    if (pending.length) await Promise.all(pending);
    pending = [];
    await nextFrame();
  }
  frame(); await nextFrame();
  const last = trace.at(-1);
  log(`   loaded ${startLevel} -> ${asset.loadedLevel}; frames ${frames}; drawn ${last.tris} tris in ${last.entries} ranges; ` +
      `stats ${last.statsTris}; duplicate clusters ${duplicateTotal}; non-monotone frames ${monotone ? 0 : 'yes'}; invalid frames ${badCutFrames}`);
  hud.textContent = `A  loaded ${startLevel} -> ${asset.loadedLevel}\n   ${last.tris} tris, ${last.entries} ranges, ${duplicateTotal} dup\n   frames ${frames}, invalid ${badCutFrames}`;
  check(asset.loadedLevel === 0, 'all levels arrived');
  check(monotone, 'drawn triangle count never decreased while levels arrived');
  check(duplicateTotal === 0, 'no cluster drawn twice');
  check(badCutFrames === 0, 'every frame was a valid cut whose stats matched the draw list');
  check(last.tris > trace[0].tris, 'the cut got finer as data arrived (more triangles drawn)');
  check(trace.length > 2 && new Set(trace.map((r) => r.loadedLevel)).size > 2, `the cut was drawn at several intermediate levels (saw ${[...new Set(trace.map((r) => r.loadedLevel))].join(', ')})`);

  // ---- B. root layer only: reload with rootBytes = 0, must draw the complete coarse layer
  log('', 'dim');
  log('B. rootBytes boundary (a fresh asset whose root page only fits the coarsest layer)', 'dim');
  const rootOnly = await loadClodStream('/data', ASSET, { rootBytes: 0 });
  // expected: the complete coarsest layer, once per visible instance
  const coarsePerInst = (() => { let t = 0; const cU = rootOnly.clusterU; for (let c = 0; c < rootOnly.meta.clusters; c++) if (cU[c * 4 + 3] >= rootOnly.meta.levelRanges[0].level) t += cU[c * 4 + 1] / 3; return t; })();
  const bBatch = new ClodBatch(rootOnly, material, matrices); scene.add(bBatch);
  const bSel = new ClodSelector([bBatch]); bSel.frustumCull = false;
  bBatch.visible = true; batch.visible = false;
  bSel.select(camera, canvas.clientHeight, { errorPx: 1e9, budget: 0 });
  renderer.render(scene, camera);
  let bTris = 0, bNonRes = 0, bInsts = new Set();
  for (let n = 0; n < bBatch._multiDrawCount; n++) {
    const c = bBatch.indirect[n * 2 + 1] & 0xffffff;
    bInsts.add(bBatch.indirect[n * 2]);
    bTris += bBatch._multiDrawCounts[n] / 3;
    if (rootOnly.clusterU[c * 4 + 3] < rootOnly.loadedLevel) bNonRes++;
  }
  const coarseExpected = coarsePerInst * bInsts.size;
  log(`   loadedLevel ${rootOnly.loadedLevel} (coarsest level ${rootOnly.meta.levelRanges[0].level}); drawn ${bTris} tris over ${bInsts.size} instances, coarse layer is ${coarsePerInst} tris/instance (${coarseExpected} total), non-resident ${bNonRes}`);
  check(rootOnly.loadedLevel <= rootOnly.meta.levelRanges[0].level, 'rootBytes 0 still loads the coarsest level');
  check(bTris === coarseExpected && bInsts.size > 0, 'the complete coarse layer is drawn for every visible instance, not a partial one');
  check(bNonRes === 0, 'nothing non-resident was drawn');
  scene.remove(bBatch); batch.visible = true;

  // ---- C. one load per frame for one asset: reset the server counter, then hammer it
  log('', 'dim');
  log('C. request merging (many instances + many updateStreaming calls in one frame)', 'dim');
  const fresh = await loadClodStream('/data', ASSET, { rootBytes });
  const cBatches = [0, 1, 2].map(() => { const b = new ClodBatch(fresh, material, matrices); scene.add(b); return b; });
  const cSel = new ClodSelector(cBatches); cSel.frustumCull = false;
  for (let k = 0; k < 4; k++) cSel.select(camera, canvas.clientHeight, { errorPx: 32, budget: 0 });
  await api('/__config?reset=1');
  let cPending = [];
  for (let k = 0; k < 8; k++) cPending.push(...updateStreaming([fresh, fresh, fresh]));
  for (const b of cBatches) b.visible = false;
  await Promise.all(cPending);
  const afterC = await api('/__state');
  log(`   ${cPending.length} load promise(s) started; server saw ${afterC.requests.length} Range request(s) for the frame`);
  check(cPending.length === 1, 'exactly one load was started for the asset in one frame');
  check(afterC.requests.length === 4, 'one level load issued exactly four Range requests (position, normal, uv, index)');

  // ---- D. server answers 200 to a Range request: must reject, preserve state, then recover
  log('', 'dim');
  log('D. negative path (server ignores Range and answers 200)', 'dim');
  const dAsset = await loadClodStream('/data', ASSET, { rootBytes });
  const dBatch = new ClodBatch(dAsset, material, matrices); scene.add(dBatch);
  const dSel = new ClodSelector([dBatch]); dSel.frustumCull = false;
  dSel.select(camera, canvas.clientHeight, { errorPx: 0.05, budget: 0 });
  const dBefore = { level: dAsset.loadedLevel, geo: dAsset.geometry, version: dAsset.geometryVersion };
  await api('/__config?ignoreRange=1');
  let dErr = null;
  try { await Promise.all(updateStreaming([dAsset])); } catch (e) { dErr = e; }
  const dAfter = { level: dAsset.loadedLevel, geo: dAsset.geometry, version: dAsset.geometryVersion, loading: dAsset.loading };
  const dSt = dSel.select(camera, canvas.clientHeight, { errorPx: 0.05, budget: 0 });
  renderer.render(scene, camera);
  log(`   error: ${dErr ? dErr.message : 'none'}; loadedLevel ${dBefore.level} -> ${dAfter.level}; geometry kept ${dAfter.geo === dBefore.geo}; loading cleared ${dAfter.loading === null}; cut still ${Math.round(dSt.tris)} tris`);
  check(dErr && /Range/i.test(dErr.message), 'a 200 answer to a Range request is reported as an error');
  check(dAfter.level === dBefore.level && dAfter.geo === dBefore.geo, 'already-loaded geometry and level are untouched');
  check(dAfter.loading === null, 'the failed load did not wedge the asset');
  check(dSt.tris > 0, 'a valid cut is still drawn from the resident data');
  await api('/__config?ignoreRange=0&reset=1');
  const dRetry = updateStreaming([dAsset]);
  await Promise.all(dRetry);
  const afterD = await api('/__state');
  log(`   retry: ${dRetry.length} load(s), ${afterD.requests.length} Range request(s), loadedLevel now ${dAsset.loadedLevel}`);
  check(dRetry.length === 1 && dAsset.loadedLevel < dBefore.level, 'the next frame retried and made progress');
  scene.remove(dBatch);

  // ---- E. budget mode with partial residency: skipped groups must not consume budget
  log('', 'dim');
  log('E. budget mode (partially resident: skipped groups must not spend budget)', 'dim');
  const eAsset = await loadClodStream('/data', ASSET, { rootBytes });
  const eBatch = new ClodBatch(eAsset, material, matrices); scene.add(eBatch);
  const eSel = new ClodSelector([eBatch]); eSel.frustumCull = false;
  const budget = 4000;
  const eSt = eSel.select(camera, canvas.clientHeight, { errorPx: 0.5, budget });
  renderer.render(scene, camera);
  let eTris = 0, eNonRes = 0;
  for (let n = 0; n < eBatch._multiDrawCount; n++) {
    const c = eBatch.indirect[n * 2 + 1] & 0xffffff;
    eTris += eBatch._multiDrawCounts[n] / 3;
    if (eAsset.clusterU[c * 4 + 3] < eAsset.loadedLevel) eNonRes++;
  }
  log(`   loadedLevel ${eAsset.loadedLevel}; budget ${budget}; drawn ${Math.round(eTris)} tris, stats ${Math.round(eSt.tris)}, non-resident ${eNonRes}`);
  check(Math.abs(eSt.tris - eTris) <= 1e-6, 'budget stats equal the drawn triangle count');
  check(eNonRes === 0, 'budget mode never drew a non-resident cluster');
  check(eTris <= budget * 1.15 + 512, 'the budget was not consumed by skipped groups');
  scene.remove(eBatch);

  // restore the primary batch for a live view
  for (const b of cBatches) scene.remove(b);
  debugUniform.value = DBG;
  const ok = !lines.some((l) => l.includes('FAIL'));
  log('');
  log(ok ? 'RESULT: all checks passed' : 'RESULT: failures above', ok ? 'ok' : 'bad');
  api.result = { ok, frames, loadedLevel: asset.loadedLevel, finalTris: last.tris, duplicateTotal, monotone, badCutFrames, trace };
  window.verify.result = api.result;
  document.title = ok ? 'verify: OK' : 'verify: FAILED';

  // ---- keep rendering so the result can be watched on screen; steer the camera with the mouse
  let drag = false, yaw = 0, pitch = 0;
  canvas.addEventListener('mousedown', () => { drag = true; });
  window.addEventListener('mouseup', () => { drag = false; });
  window.addEventListener('mousemove', (e) => { if (!drag) return; yaw -= e.movementX * 0.005; pitch = Math.max(-1.2, Math.min(1.2, pitch - e.movementY * 0.005)); camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')); });
  for (;;) {
    selector.select(camera, canvas.clientHeight, opts);
    updateStreaming([asset]);
    renderer.render(scene, camera);
    await nextFrame();
  }
})().catch((e) => { log('EXCEPTION: ' + (e && e.stack || e), 'bad'); window.verify.result = { ok: false, error: String(e && e.message || e) }; document.title = 'verify: EXCEPTION'; });
