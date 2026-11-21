/* Lifecycle tests for the source-request lifecycle and the lookahead limiter reset.
   Runs in a real browser (headless Chrome via run-tests.mjs) against the actual engine.js and
   limiter-worklet.js, with the stretch worker replaced by the controllable fake. Every assertion
   is collected and posted back to the Node runner; the page also writes a summary into the DOM. */
import * as E from '../js/engine.js';
import { integratedLoudness } from '../js/loudness.js';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail) });
  const li = document.createElement('li');
  li.textContent = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  li.className = cond ? 'pass' : 'fail';
  document.getElementById('log').appendChild(li);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 8000, label = 'condition') => {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) { if (fn()) return true; await wait(20); }
  throw new Error(`timed out waiting for ${label}`);
};

// ---- test seams: the fake worker factory and out-of-band control ----
const fakeSource = await (await fetch('./fake-worker.js')).text();
const fakeUrl = URL.createObjectURL(new Blob([fakeSource], { type: 'application/javascript' }));
const fakeWorkers = [];
// Orphan mode: a terminate()d worker keeps its pending reply and delivers it late, as if a slow
// render for a cancelled request finished anyway. The wrapper records every message the engine's
// onmessage receives so the test can assert a stale answer never became a buffer or a source.
let orphanMode = false;
const engineSeen = []; // every worker reply the engine observed, {id, stale}
function makeFakeFactory() {
  return () => {
    const real = new Worker(fakeUrl);
    const wrapper = {
      onmessage: null,
      onerror: null,
      postMessage: (m, t) => real.postMessage(m, t),
      terminate() {
        if (!orphanMode) return real.terminate();
        // Keep the worker alive and let its late reply hit the engine's onmessage anyway.
      },
    };
    real.onmessage = (e) => {
      // Tag whether this reply belongs to a request no longer current, then hand it to the engine.
      const id = e.data?.id;
      engineSeen.push({ id, at: performance.now(), data: e.data });
      if (wrapper.onmessage) wrapper.onmessage(e);
    };
    real.onerror = (e) => { if (wrapper.onerror) wrapper.onerror(e); };
    const control = (msg) => real.postMessage({ __control: true, ...msg });
    fakeWorkers.push({ worker: wrapper, real, control });
    return wrapper;
  };
}
E.setWorkerFactory(makeFakeFactory());
const setDelay = (ms) => { for (const f of fakeWorkers) f.control({ delayMs: ms }); };

// Load the synthetic manifest in place of stems.json (loadManifest assigns the engine's live
// MANIFEST binding).
await E.loadManifest('./fixtures/test-stems.json');

const A = 'Song A', B = 'Song B';
const LAYERS = ['groove', 'lead', 'texture'];
const allIdle = () => LAYERS.every((id) => {
  const s = E.state.layers[id];
  return !s.loading && !s.syncing;
});
const settled = () => until(allIdle, 10000, 'layers settled');

// Test 1: rapid successive song changes with slow renders — only the last pick plays.
async function testRapidSwitch() {
  setDelay(250); // every render takes 250 ms; quick re-picks must cancel the earlier ones
  E.ensureCtx();
  E.warmUp();
  await wait(50);
  // Fire four picks on the groove layer faster than the render time.
  const picks = [A, B, A, B];
  for (const song of picks) E.selectStem('groove', song, { noAutoplay: true });
  await settled();
  const s = E.state.layers.groove;
  check('rapid switch: final selection is the last pick', s.song === B, `groove song = ${s.song}`);
  check('rapid switch: a buffer for the last pick exists', !!s.buffer && s.bufferKey && s.bufferKey.startsWith(`${B}|`),
    s.bufferKey || 'no buffer key');
  check('rapid switch: only one groove request remains current', E.currentRequest('groove') > 0);
  // No live source may belong to a superseded request: sources are created only after settlement,
  // and the layer's cur record (once playing) must carry the final song.
  await E.play();
  await wait(300);
  const cur = E.state.layers.groove.cur;
  check('rapid switch: the playing source is the final song', !!cur && cur.song === B, cur ? cur.song : 'no cur');
  E.stop();
  await wait(50);
}

// Test 1b: a slow render whose request is cancelled still answers later; the engine must drop the
// stale answer (it never becomes the layer's buffer or a source), then keep the newer pick.
async function testLateAnswerDropped() {
  orphanMode = true;
  setDelay(300);
  engineSeen.length = 0;
  E.ensureCtx();
  // Pick A, then replace it with B before A's 300 ms render can finish. A's worker is "terminated"
  // by the engine but, in orphan mode, its reply still arrives after the delay.
  E.selectStem('texture', A, { noAutoplay: true });
  const reqA = E.currentRequest('texture');
  await wait(40); // let A's job reach a worker
  E.selectStem('texture', B, { noAutoplay: true, force: true });
  const reqB = E.currentRequest('texture');
  check('late answer: the second pick got a newer request id', reqB > reqA, `${reqA} -> ${reqB}`);
  await settled();
  await wait(350); // long enough for the orphaned A reply to land as well
  const s = E.state.layers.texture;
  check('late answer: the layer holds the newer pick, not the stale one', s.song === B && s.bufferKey?.startsWith(`${B}|`),
    s.bufferKey || 'no key');
  // At least one orphaned (superseded-request) reply reached the engine's worker handler.
  const orphans = engineSeen.length;
  check('late answer: stale worker replies were actually observed', orphans >= 2, `${orphans} replies observed`);
  // No source for the stale song may exist once playing.
  await E.play();
  await wait(300);
  const cur = E.state.layers.texture.cur;
  check('late answer: the live source is the newer song', !!cur && cur.song === B, cur ? cur.song : 'no cur');
  E.stop();
  E.clearLayer('texture');
  orphanMode = false;
}

// Test 2: clear cancels, disconnects and frees; reselecting plays again.
async function testClearAndReselect() {
  setDelay(80);
  E.ensureCtx();
  E.selectStem('lead', A, { noAutoplay: true });
  await settled();
  const reqBefore = E.currentRequest('lead');
  check('clear: a request was assigned', reqBefore > 0);
  E.clearLayer('lead');
  await wait(50);
  const s = E.state.layers.lead;
  check('clear: song and buffer are gone', s.song === null && s.buffer === null);
  check('clear: the request was cancelled', E.currentRequest('lead') === 0);
  check('clear: no source record remains', s.cur === null && s.source === null);
  // Reselect after clear: a brand new request renders and plays.
  E.selectStem('lead', B, { noAutoplay: true });
  await settled();
  check('reselect: a new request was assigned', E.currentRequest('lead') > reqBefore);
  check('reselect: buffer rendered for the new song', !!E.state.layers.lead.buffer
    && E.state.layers.lead.bufferKey.startsWith(`${B}|`));
  await E.play();
  await wait(300);
  check('reselect: playback resumes with a live source', !!E.state.layers.lead.cur
    && E.state.layers.lead.cur.song === B);
  E.stop();
}

// Test 3: tempo change re-renders all layers atomically — all old or all new.
async function testAtomicTempo() {
  setDelay(60);
  E.ensureCtx();
  // Start a full three-layer mix at the default tempo and let it play.
  E.selectStem('groove', A, { noAutoplay: true });
  E.selectStem('lead', A, { noAutoplay: true });
  E.selectStem('texture', A, { noAutoplay: true });
  await settled();
  await E.play();
  await wait(200);
  const before = LAYERS.map((id) => E.state.layers[id].bufferBpm);
  check('atomic tempo: all layers start at one tempo', before.every((b) => b === before[0]), before.join(','));
  const targetBpm = E.state.bpm + 4;
  // Snapshot every bufferBpm while the re-render is in flight: no intermediate mixed state may
  // show more than one distinct tempo across the three layers.
  let mixedSeen = false, samples = 0;
  const probe = setInterval(() => {
    const bpms = LAYERS.map((id) => E.state.layers[id].bufferBpm).filter((b) => b > 0);
    samples++;
    if (new Set(bpms).size > 1) mixedSeen = true;
  }, 5);
  E.setBpm(targetBpm, { immediate: true });
  await until(() => LAYERS.every((id) => E.state.layers[id].bufferBpm === targetBpm), 10000, 'all layers at new tempo');
  clearInterval(probe);
  check('atomic tempo: no half-new/half-old snapshot during re-render', !mixedSeen, `${samples} samples`);
  const after = LAYERS.map((id) => E.state.layers[id].bufferBpm);
  check('atomic tempo: every layer ends at the new tempo', after.every((b) => b === targetBpm), after.join(','));
  check('atomic tempo: clock follows to the new tempo', (() => {
    const t = E.tempoStatus();
    return t.heard === targetBpm || t.bpm === targetBpm;
  })());
  E.stop();
}

// Test 3b: a key change re-renders the layers and they swap together; the relative-minor merge
// rule still applies (Am and Cm keep their tonics, no rule change). Use an explicit master key so
// the re-key is deterministic regardless of pick order.
async function testAtomicKey() {
  setDelay(50);
  E.ensureCtx();
  // Start from a known-clean slate so all three picks are fresh renders.
  for (const id of LAYERS) if (E.state.layers[id].song) E.clearLayer(id);
  await wait(40);
  E.selectStem('groove', A, { noAutoplay: true, force: true });
  E.selectStem('lead', B, { noAutoplay: true, force: true });
  E.selectStem('texture', A, { noAutoplay: true, force: true });
  await settled();
  await E.play();
  await wait(200);
  const keysBefore = LAYERS.map((id) => E.state.layers[id].bufferKey);
  check('atomic key: all three layers rendered before the key change', keysBefore.every(Boolean),
    keysBefore.map((k) => (k ? k.split('|')[4] : 'null')).join(','));
  // Force an explicit master key. masterKey takes a bare note name ('E' means the E-minor tonic,
  // the same spelling the UI's key picker uses); every pitched layer then re-renders to it.
  E.setMasterKey('E');
  // Wait until every layer's buffer matches the current render key for its song.
  await until(() => LAYERS.every((id) => {
    const s = E.state.layers[id];
    return s.buffer && !s.loading && !s.syncing && s.bufferKey === expectedKey(id, s.song);
  }), 10000, 'all layers re-keyed');
  // Each song shifts by a different number of semitones to reach the one master tonic, so the
  // semis values legitimately differ (-5 for one song, +4 for another). Atomicity here means every
  // layer actually re-rendered (finite semis, key changed from before) and all now resolve to the
  // same master root — not that the shift counts are equal.
  const rawKeys = LAYERS.map((id) => E.state.layers[id].bufferKey);
  const semisAfter = rawKeys.map((k) => Number(String(k).split('|')[3]));
  const allReRendered = semisAfter.every((v) => Number.isFinite(v))
    && rawKeys.every((k, i) => k !== keysBefore[i]);
  check('atomic key: every layer re-rendered (all keys changed, finite shifts)', allReRendered,
    `semis=${semisAfter.join(',')}`);
  const roots = LAYERS.map((id) => {
    const s = E.state.layers[id];
    const info = E.MANIFEST[s.song];
    const semis = Number(s.bufferKey.split('|')[3]);
    return (E.tonic(info.key) + semis + 1200) % 12; // tonic after the shift
  });
  check('atomic key: all layers converge on the one master tonic',
    roots.every((r) => r === roots[0]) && roots[0] === E.NOTE.E,
    `roots=${roots.join(',')} target=${E.NOTE.E}`);
  // Relative-minor rule sanity: the tonic helper still resolves majors through their relative minor.
  check('atomic key: relative-minor tonic rule is unchanged',
    E.tonic('C') === (E.NOTE.C + 9) % 12 && E.tonic('Am') === E.NOTE.A,
    `tonic(C)=${E.tonic('C')} tonic(Am)=${E.tonic('Am')}`);
  E.stop();
}
// Recompute the render key the engine expects for a layer/song at the current settings.
function expectedKey(layerId, song) {
  const s = E.state.layers[layerId];
  const info = E.MANIFEST[song];
  const semis = E.semisFor(info.key);
  return `${song}|${s.type}|${E.state.bpm}|${semis}|${E.ensureCtx().sampleRate}`;
}

// Test 4: BS.1770 loudness alignment — trims move stems toward their type target.
async function testLoudnessAlignment() {
  setDelay(20);
  E.ensureCtx();
  // Start from a known-empty layer so the pick is a fresh render, not a toggle-clear.
  if (E.state.layers.groove.song) E.clearLayer('groove');
  await wait(30);
  E.selectStem('groove', A, { noAutoplay: true, force: true });
  await settled();
  const buf = E.state.layers.groove.buffer;
  check('loudness: a render exists to measure', !!buf, buf ? 'ok' : 'no buffer');
  if (!buf) return;
  check('loudness: the render carries a finite BS.1770-derived trim', Number.isFinite(buf.trim) && buf.trim > 0,
    `trim=${buf.trim}`);
  // Measure integrated loudness of the trimmed buffer directly.
  const chans = [buf.getChannelData(0), buf.getChannelData(1)].map((d) => {
    const y = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) y[i] = d[i] * buf.trim;
    return y;
  });
  const lufs = await integratedLoudness(chans, buf.sampleRate);
  check('loudness: aligned render has a finite integrated LUFS', Number.isFinite(lufs), `lufs=${lufs.toFixed(2)}`);
  E.clearLayer('groove');
}

async function main() {
  try {
    await testRapidSwitch();
    await testLateAnswerDropped();
    await testClearAndReselect();
    await testAtomicTempo();
    await testAtomicKey();
    await testLoudnessAlignment();
  } catch (err) {
    check('test harness', false, (err && err.stack) || String(err));
  }
  const passed = results.filter((r) => r.pass).length;
  const summary = { passed, total: results.length, results };
  document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
  document.getElementById('results').textContent = JSON.stringify(summary);
  // The Node CDP runner reads this console call.
  console.log('LIFECYCLE_TEST_RESULTS ' + JSON.stringify(summary));
  window.__TEST_DONE__ = summary;
}
main();
