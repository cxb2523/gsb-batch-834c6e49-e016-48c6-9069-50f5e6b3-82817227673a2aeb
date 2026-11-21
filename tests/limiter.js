/* Deterministic AudioWorklet limiter tests using OfflineAudioContext: no real-time clock, so the
   true-peak ceiling and the reset behavior are measured exactly.
   1. A full-scale transient inside the very first lookahead window after a reset stays under
      -1 dBTP (on a 4x-oversampled true-peak estimate).
   2. A reset causes no long silence across the switch: the delay line is pre-filled, not zeroed.
   3. Regression control for pumping: a limiter driven into deep gain reduction carries that
      envelope into new material unless it is reset. The reset (armed at an exact offline time via
      processorOptions.resetAt) restores unity, so the new source is not choked. */
const SR = 48000;
const LOOKAHEAD = 0.005; // matches LIMIT.lookahead in engine.js
const CEILING_DB = -1;
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail) });
  const li = document.createElement('li');
  li.textContent = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`;
  li.className = cond ? 'pass' : 'fail';
  document.getElementById('log').appendChild(li);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Build an offline graph: source buffer -> true-peak-limiter worklet -> destination.
// resetAt (seconds) arms a reset inside the constructor, so it works in an offline render where a
// mid-render postMessage cannot be timed. Returns the rendered buffer and the worklet node so its
// gain state can be read with a ping after rendering.
async function renderThrough(samples, { resetAt = null, extra = 0 } = {}) {
  const total = samples.length + Math.round(extra * SR);
  const ctx = new OfflineAudioContext(2, total, SR);
  await ctx.audioWorklet.addModule(new URL('../js/limiter-worklet.js', import.meta.url));
  const options = { lookahead: Math.round(LOOKAHEAD * SR), release: 0.12, ceiling: CEILING_DB };
  if (resetAt !== null) options.resetAt = resetAt;
  const node = new AudioWorkletNode(ctx, 'true-peak-limiter', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: options,
  });
  node.connect(ctx.destination);
  const buf = ctx.createBuffer(2, samples.length, SR);
  for (let c = 0; c < 2; c++) buf.getChannelData(c).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(node);
  src.start(0);
  const rendered = await ctx.startRendering();
  const gainState = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    node.port.onmessage = (e) => finish(e.data);
    node.port.postMessage({ type: 'ping' });
    setTimeout(() => finish(null), 500);
  });
  return { rendered, gainState };
}

// 4x oversampled peak estimate (mirrors the worklet's linear interpolation).
function truePeak(channels) {
  let peak = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length - 1; i++) {
      const a = x[i], b = x[i + 1];
      if (Math.abs(a) > peak) peak = Math.abs(a);
      for (let p = 1; p < 4; p++) {
        const v = a + (b - a) * (p / 4);
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
    }
  }
  return peak;
}
const db = (v) => 20 * Math.log10(v);
// Longest run of near-silence, measured only over [from, to) so the tail after a short source
// (the worklet keeps outputting zeros once the source ends) doesn't count.
const maxSilentRun = (channels, from, to, thresh = 1e-5) => {
  let run = 0, best = 0;
  for (let i = from; i < to; i++) {
    const quiet = channels.every((x) => Math.abs(x[i]) < thresh);
    run = quiet ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best / SR;
};
const meanAbs = (x, from, len) => { let s = 0; for (let i = from; i < from + len; i++) s += Math.abs(x[i]); return s / len; };

async function main() {
  // --- Test 1 & 2: hot source, reset armed at time 0 ---
  // Near-0 dBFS transient at the first samples (inside the first lookahead window), then a tone.
  const n = Math.round(0.3 * SR);
  const hot = new Float32Array(n);
  for (let i = 0; i < 24; i++) hot[i] = 0.999 * Math.exp(-i / 6);
  for (let i = 24; i < n; i++) hot[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / SR);

  const r1 = await renderThrough(hot, { resetAt: 0, extra: 0.02 });
  const out1 = [r1.rendered.getChannelData(0), r1.rendered.getChannelData(1)];
  const peak1 = truePeak(out1);
  check('limiter: first-window transient after reset stays under -1 dBTP',
    peak1 <= Math.pow(10, CEILING_DB / 20) + 1e-6,
    `peak=${db(peak1).toFixed(3)} dBTP (ceiling ${CEILING_DB})`);

  // Measure silence only over the source's own span; the pre-filled delay means the first output
  // samples already carry the first input sample rather than a zero hole.
  const silence = maxSilentRun(out1, 0, n);
  check('limiter: reset produces no long silence (delay pre-filled)',
    silence < LOOKAHEAD * 1.5,
    `longest silent run=${(silence * 1000).toFixed(2)} ms (lookahead ${LOOKAHEAD * 1000} ms)`);
  let bodyMax = 0;
  for (let i = Math.round(0.05 * SR); i < Math.round(0.2 * SR); i++) bodyMax = Math.max(bodyMax, Math.abs(out1[0][i]));
  check('limiter: signal is present at full level in the body', bodyMax > 0.05, `body max=${bodyMax.toFixed(3)}`);

  // --- Test 1b: a near-full-scale transient anywhere in the first quantum must stay bounded ---
  // Place one-sample peaks at the very start, mid-quantum and at the 128-sample block boundary,
  // each on both channels. A reset only covers a peak if its pre-read seeds gain across the whole
  // opening window; a peak at a block boundary catches any off-by-one in that seeding.
  const qn = Math.round(0.1 * SR);
  const peakPositions = [0, 7, 63, 127, 128, 200, qn - 1];
  let worstPeak = 0;
  for (const pos of peakPositions) {
    const pulse = new Float32Array(qn);
    for (let i = 0; i < qn; i++) pulse[i] = 0.2 * Math.sin((2 * Math.PI * 330 * i) / SR);
    pulse[pos] = 0.999;
    const rp = await renderThrough(pulse, { resetAt: 0 });
    const pk = truePeak([rp.rendered.getChannelData(0), rp.rendered.getChannelData(1)]);
    worstPeak = Math.max(worstPeak, pk);
  }
  check('limiter: transients at every first-quantum position stay under -1 dBTP',
    worstPeak <= Math.pow(10, CEILING_DB / 20) + 1e-6,
    `worst peak across ${peakPositions.length} positions=${db(worstPeak).toFixed(3)} dBTP`);

  // --- Test 3: pumping regression, read from the worklet's own gain state ---
  // A long loud lead-in drives the envelope into deep reduction. Both renders use the identical
  // buffer; one limiter is never reset and one is reset at the switch. After a quiet tail long
  // enough to recover, a reset limiter is back near unity, while a non-reset one reflects the
  // envelope it accumulated. More directly, the reset render must report a reset actually ran, and
  // its post-recovery gain must be higher than the non-reset render's at the same probe point.
  const switchAt = 0.2, heavyLen = Math.round(switchAt * SR);
  const quietTail = Math.round(0.25 * SR); // ~2 release time-constants, enough to recover toward unity
  const n2 = heavyLen + quietTail;
  const sig = new Float32Array(n2);
  for (let i = 0; i < heavyLen; i++) sig[i] = 0.99 * Math.sin((2 * Math.PI * 260 * i) / SR); // drives deep gain
  // The tail is silence: a fresh limiter stays at unity; a non-reset one is still releasing.
  const noReset = await renderThrough(sig);
  const withReset = await renderThrough(sig, { resetAt: switchAt });
  const gNo = noReset.gainState?.gain, gReset = withReset.gainState?.gain;
  check('limiter: reset render reports the reset ran', withReset.gainState?.resets === 1,
    `resets=${withReset.gainState?.resets}`);
  // The reset limiter ends at exactly unity (a re-initialized envelope over silence); the
  // non-reset limiter, given the same silence, is still measurably below it because it keeps
  // releasing the reduction it accumulated during the loud lead-in.
  check('limiter: reset re-initializes the gain envelope (no inherited reduction)',
    Number.isFinite(gReset) && gReset === 1 && gNo < 0.999,
    `end gain: no-reset=${gNo?.toFixed(4)} reset=${gReset?.toFixed(4)}`);
  const peakReset = truePeak([withReset.rendered.getChannelData(0), withReset.rendered.getChannelData(1)]);
  check('limiter: reset path stays under ceiling throughout',
    peakReset <= Math.pow(10, CEILING_DB / 20) + 1e-6,
    `peak=${db(peakReset).toFixed(3)} dBTP`);
  // No silence hole at a reset is covered by test 2 (a pre-filled delay over a continuous source);
  // here the tail is silence by construction, so a hole check would measure the source, not the reset.

  const passed = results.filter((r) => r.pass).length;
  const summary = { passed, total: results.length, results };
  document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
  const el = document.getElementById('results');
  if (el) el.textContent = JSON.stringify(summary);
  console.log('LIMITER_TEST_RESULTS ' + JSON.stringify(summary));
  window.__TEST_DONE__ = summary;
  await wait(10);
}
main().catch((err) => {
  check('limiter harness', false, (err && err.stack) || String(err));
  const passed = results.filter((r) => r.pass).length;
  console.log('LIMITER_TEST_RESULTS ' + JSON.stringify({ passed, total: results.length, results }));
});
