/* Fake stretch worker for the lifecycle tests.
   Loaded as a real Worker via a Blob URL (see makeFakeFactory in the test page), so it has the
   genuine worker message boundary — the engine's id guards run exactly as against stretch-worker.js.
   It mimics the real worker's contract ({id,...} in, {id, channels, quality, formant} out) but does
   no DSP: it resamples the loop into Float32Array channels of exactly targetLen samples, after an
   injectable delay. The delay and forced failures are configured by posting a 'control' message,
   which the engine never sends (it only sends stretch jobs), so the page drives them out of band.
   A terminated worker normally never answers (its pending timers are cleared); the test page can
   instead wrap it so a cancelled request's reply still arrives late (see orphan mode in
   lifecycle.js), proving the engine drops the stale answer on its id guard. */
'use strict';

const state = { delayMs: 0, failIds: [] };
const timers = new Set();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.__control) {
    if (Number.isFinite(msg.delayMs)) state.delayMs = Math.max(0, msg.delayMs);
    if (Array.isArray(msg.failIds)) state.failIds = msg.failIds.slice();
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    try {
      self.postMessage(run(msg));
    } catch (err) {
      self.postMessage({ id: msg.id, error: String((err && err.stack) || err) });
    }
  }, state.delayMs);
  timers.add(timer);
};

// Minimal stand-in for stretch-worker.js run(): resample the loop so the output is exactly
// targetLen samples long and still carries recognizable audio (the tests only need length, level
// and identity, not WSOLA quality).
function run(job) {
  if (state.failIds.includes(job.id)) throw new Error('injected fake-worker failure');
  const targetLen = job.targetLen;
  const scale = job.channels[0] instanceof Int16Array ? 1 / 32768 : 1;
  const n = job.inLen || job.channels[0].length;
  const out = [];
  for (let c = 0; c < 2; c++) {
    const src = job.channels[Math.min(c, job.channels.length - 1)];
    const dst = new Float32Array(targetLen);
    if (targetLen === n) {
      for (let i = 0; i < n; i++) dst[i] = src[i] * scale;
    } else {
      for (let i = 0; i < targetLen; i++) {
        const x = (i * n) / targetLen, k = Math.floor(x), f = x - k;
        const a = src[k % n] * scale, b = src[(k + 1) % n] * scale;
        dst[i] = a + (b - a) * f;
      }
    }
    out.push(dst);
  }
  return { id: job.id, channels: out, quality: 'fast', formant: false };
}
