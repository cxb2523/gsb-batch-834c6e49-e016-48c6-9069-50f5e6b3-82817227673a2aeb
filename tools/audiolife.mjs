/* Does the sound follow the race?
 *
 *   node tools/audiolife.mjs
 *
 * The audio graph is driven off the context clock, so it does not know that a
 * text menu went up, that a race was restarted or that the player crossed the
 * line. Those are the three things this file measures, and every one of them is
 * a scenario a player reaches by pressing a key rather than by calling a
 * method: see the "MANUAL" block at the bottom, which gives the key for each.
 *
 * WHY OFFLINE. Same argument as tools/audio.mjs, which owns it in full: an
 * OfflineAudioContext runs the real graph faster than real time, the noise
 * buffers are seeded and the engine runs on a virtual clock offline, so the
 * same script renders the same samples on every machine. That is what makes
 * "did the output drop" a number rather than an impression — and it is why
 * every check below is a comparison of two renders or two windows of one
 * render, never an absolute level.
 *
 * WHAT IS NOT PROVEN HERE. A live AudioContext cannot be rendered offline, so
 * the suspend half of the pause — the part that freezes the graph rather than
 * ducking it — is not measurable in this file. tools/audio.mjs' live section
 * already boots, starts, stops and restarts a real context; the state machine
 * here is what the game drives, and the number it is judged by is the level,
 * which is what the player hears either way. That gap is named rather than
 * papered over: MANUAL §pause, at the bottom of this file.
 *
 * READING THE EXIT CODE: `node tools/audiolife.mjs | tee log.txt` reports
 * tee's status. Redirect to read the real one:
 *   node tools/audiolife.mjs > log.txt 2>&1 ; echo $?
 */
import { chromium } from 'playwright';
import { serve } from './harness.mjs';
import { finish, guard } from './tame.mjs';

const SR = 44100;
const H = 1 / 60;

/* Blank page, real Web Audio, real module loading — the same envelope
   tools/audio.mjs uses, and for the same reason: src/audio has no dependency
   on the renderer, so a syntax error in a mesh builder must not be able to
   take the sound suite down with it. */
async function inPage(body) {
  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const origin = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--renderer-process-limit=1',
    ],
  });
  guard(browser, srv);
  const errs = [];
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    await page.route(origin + '/__audiolife', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset=utf-8><title>audiolife</title>',
    }));
    console.log(`→ ${origin}/__audiolife  (no game, Web Audio only)`);
    await page.goto(origin + '/__audiolife', { waitUntil: 'domcontentloaded' });
    return await body(page);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
    if (errs.length) {
      console.log('\n─── page errors ───');
      [...new Set(errs)].slice(0, 15).forEach(e => console.log(' ', e));
    }
  }
}

/* Every scenario is the same script with different lifecycle calls in it, so
   the comparison between two renders is a comparison of the LIFECYCLE and
   nothing else. `script(t, audio)` is called once per frame at 60 Hz and is
   the only thing that differs. */
const RUN = async ([sr, frameDt]) => {
  const H = frameDt;
  const { Audio } = await import('/src/audio/index.js');

  const IDLE = 1050 / 7400;
  const base = {
    speed: 0, rpm: IDLE, gear: 0, throttle: 0, brake: 0, handbrake: 0,
    slipAngle: 0, wheelSlip: 0, offRoad: 0, airborne: false,
    shoreDistance: 70, shoreDrop: 40, oceanSide: -1,
  };
  const at = o => Object.assign({}, base, o);

  /* FIXED SEED, and it is the point of the whole file. The engine's jitter,
     the tyre's chirp and the gravel's scatter are all drawn from a seeded
     generator, so the same script renders to the same samples. A comparison
     between two runs is therefore a comparison of the lifecycle and not of
     two different performances. */
  const SEED = 20261122;

  /**
   * Render one scripted run.
   *
   * `script(t, audio)` is called at every frame AFTER `audio.update` for that
   * frame, which is the order the game uses — the state is fed in, then the
   * events that frame produced are dispatched. That ordering matters for the
   * restart scenario: a restart happens on a frame, and the car that frame is
   * the OLD car until the next update.
   */
  async function render(dur, script, opts = {}) {
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const audio = new Audio({ context: ctx, seed: SEED });
    await audio.start();
    audio.setMasterVolume(opts.volume ?? 0.5);
    const buses = audio.buses();
    if (opts.solo) {
      /* `audio.bus` is the CAR bus, which the finish fade sits behind — a surf
         solo reconnected there would be measured through the car's exit and
         read as leaving at the flag. Each layer is reconnected to the bus it
         actually belongs to: `amb` for the coast, `bus` for the car. */
      const ambLayers = new Set(['surf', 'seaWind', 'gull']);
      const dest = ambLayers.has(opts.solo) ? audio.amb : audio.bus;
      for (const [n, node] of Object.entries(buses)) {
        node.disconnect();
        if (n === opts.solo) node.connect(dest);
      }
    }
    const frames = Math.ceil(dur / H);
    for (let i = 0; i < frames; i++) {
      const t = i * H;
      const st = (opts.state || (() => at({}))) (t);
      audio.update(H, st);
      if (script) script(t, audio, i);
    }
    const buf = await ctx.startRendering();
    audio.dispose();
    return [buf.getChannelData(0), buf.getChannelData(1)];
  }

  /* ---- measurement ------------------------------------------------------ */
  const mono = (L, R, t0, t1) => {
    const a = Math.max(0, Math.floor(t0 * sr));
    const b = Math.min(L.length, Math.ceil(t1 * sr));
    let sq = 0, peak = 0;
    for (let i = a; i < b; i++) {
      const v = (L[i] + R[i]) * 0.5;
      sq += v * v;
      const m = Math.abs(v);
      if (m > peak) peak = m;
    }
    const n = Math.max(1, b - a);
    return { rms: Math.sqrt(sq / n), peak, n };
  };
  const db = x => 20 * Math.log10(Math.max(1e-12, x));

  /* The ratio of two windows, in dB. The only comparison this file trusts:
   every verdict below is "this window is N dB below that one", never "this
   window is at 0.02", because an absolute level depends on the master volume
   and the seed and a ratio does not. */
  const ratio = (a, b) => db(a.rms) - db(b.rms);

  /* ---- scenarios -------------------------------------------------------- */

  /**
   * THE BED. A car on the road, doing the same thing for the whole render.
   * Every measurement elsewhere is relative to a stretch of this, so that a
   * check can say "quieter than the car would have been" rather than "quiet".
   */
  const cruising = t => at({
    rpm: 0.72, speed: 34, throttle: 0.8, gear: 3,
    wheelSlip: 0.4, slipAngle: 0.12,
    shoreDistance: 16, shoreDrop: 10, oceanSide: -1,
  });

  /* 1. PAUSE ---------------------------------------------------------------
   *
   * Reach it: press Escape mid-race. The menu goes up, the picture freezes,
   * and the sound has to go with it. Release: press Escape again.
   *
   * One render: ten seconds of cruising with a pause at 2.0 s and a resume at
   * 5.0 s. If the duck works, 3.5–4.8 s is far below 0.5–1.8 s; if the resume
   * works, 7.0–9.5 s is back at the bed. Continuous, not re-created: the two
   * stretches either side of the menu must have the same level, which a
   * rebuild would break — a re-created graph approaches its parameters again
   * from zero and the first second after a rebuild is measurably quieter.
   */
  const PAUSE_AT = 2.0, RESUME_AT = 5.0;
  const pauseRender = await render(10, (t, audio) => {
    if (t <= PAUSE_AT && t + H > PAUSE_AT) audio.pause();
    if (t <= RESUME_AT && t + H > RESUME_AT) audio.resume();
  }, { state: cruising });
  const pre = mono(...pauseRender, 0.6, 1.8);
  const paused = mono(...pauseRender, 3.5, 4.8);
  const post = mono(...pauseRender, 7.0, 9.5);
  const pauseDrop = ratio(paused, pre);
  const resumeBack = ratio(post, pre);
  /* Continuity at the resume, two ways. The LEVEL over the first half second:
     a rebuild re-creates every source and every smoothed value and has to
     approach all of them from zero, so its first half second is well under the
     bed it settles to. And the STEP: the largest sample-to-sample jump across
     the resume frame, which no legitimate ramp on this graph produces and
     which a re-created graph does, because the re-created oscillators start at
     phase zero regardless of where the old ones were. */
  const resumeStart = mono(...pauseRender, RESUME_AT, RESUME_AT + 0.5);
  const resumeGap = ratio(resumeStart, pre);
  const stepAt = (L, R, t0, t1) => {
    const a = Math.max(1, Math.floor(t0 * sr));
    const b = Math.min(L.length, Math.ceil(t1 * sr));
    let step = 0;
    for (let i = a; i < b; i++) {
      step = Math.max(step, Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
    }
    return step;
  };
  const resumeStep = stepAt(...pauseRender, RESUME_AT - 0.05, RESUME_AT + 0.3);
  /* The bed's own largest step, as the reference. Broadband noise at this
     level legitimately moves a third of full scale between samples, so an
     absolute threshold would be measuring the car and not the resume — the
     same reason tools/audio.mjs scales its click bound to the peak. What the
     resume must not do is step MORE than the signal it is returning to. */
  const bedStep = stepAt(...pauseRender, 0.6, 1.8);

  /* 2. RESTART -------------------------------------------------------------
   *
   * Reach it: press R on the results card, or Escape then RESTART.
   *
   * The defect this catches: the flag chord, the card stamp and the rank notes
   * are scheduled on the audio clock and are still ringing when the new race
   * starts, so a restart replayed the last run's finish over the new grid. The
   * render below fires a flag and restarts 0.6 s later — mid-envelope, the
   * chord is 1.75 s — then keeps cruising. It is compared against a control
   * that never restarts, both soloed on the finish bus, so the difference is
   * entirely the restart.
   */
  const FLAG_AT = 1.0;
  const RESTART_AT = 1.6;         // 0.6 s after the chord starts, mid-envelope
  let flagsCalls = 0;
  const restartRender = await render(4, (t, audio) => {
    if (t <= FLAG_AT && t + H > FLAG_AT) audio.finishTone('flag', false);
    if (t <= RESTART_AT && t + H > RESTART_AT) audio.resetRace();
  }, { state: cruising, solo: 'finish' });
  const controlRender = await render(4, (t, audio) => {
    if (t <= FLAG_AT && t + H > FLAG_AT) audio.finishTone('flag', false);
  }, { state: cruising, solo: 'finish' });
  /* After the restart there should be nothing on the finish bus at all. Before
     it, the control and the restart render must agree — otherwise the restart
     is being credited with a difference the chord does not explain. */
  const chordBefore = mono(...restartRender, FLAG_AT + 0.05, FLAG_AT + 0.4);
  const chordControl = mono(...controlRender, FLAG_AT + 0.05, FLAG_AT + 0.4);
  const afterRestart = mono(...restartRender, RESTART_AT + 0.1, 3.8);
  const controlAfter = mono(...controlRender, RESTART_AT + 0.1, 3.8);

  /* And that the restart re-arms the latch, so the NEW race can sound its own
     flag. Two flagTones in one race: only the first may sound. The counter
     below counts CALLS; the sample energy is what says whether one sounded. */
  const counter = await render(2.4, (t, audio) => {
    if (t <= 0.3 && t + H > 0.3) { audio.finishTone('flag', false); flagsCalls++; }
    if (t <= 1.0 && t + H > 1.0) { audio.finishTone('flag', false); flagsCalls++; }
    if (t <= 1.2 && t + H > 1.2) {
      audio.resetRace();
      audio.finishTone('flag', true); flagsCalls++;
    }
  }, { state: cruising, solo: 'finish' });
  const firstChord = mono(...counter, 0.35, 0.9);
  /* The SECOND call's own attack, isolated. Comparing two long windows fails
     here because a spurious second chord rings inside the same window as the
     first and the comparison cannot see the stack. The attack is the tell: the
     chord's first voice ramps to peak within 8 ms of the call, so the two
     frames AFTER the second call are loud if a chord sounded and quiet if the
     latch refused it. The two frames BEFORE it are the reference — the first
     chord is still carrying them. The ratio is then "did this call add
     anything", which no amount of overlap can hide. */
  const SECOND_AT = 1.0;
  const secondBefore = mono(...counter, SECOND_AT - 0.05, SECOND_AT);
  const secondAfter = mono(...counter, SECOND_AT + 0.005, SECOND_AT + 0.06);
  const secondLift = 20 * Math.log10(
    Math.max(1e-9, secondAfter.rms) / Math.max(1e-9, secondBefore.rms));
  /* After the reset, the new race's chord — the latch must have been cleared
     for this to sound at all. */
  const afterResetChord = mono(...counter, 1.25, 1.75);

  /* 3. FINISH --------------------------------------------------------------
   *
   * Reach it: cross the line with the ending enabled.
   *
   * A render that cruises to 1.0 s, then calls setPhase('finish') and keeps
   * feeding the SAME car state — the car is still rolling, so its state
   * struct is unchanged. The car bus must fall away; the ambience bus must
   * not. Two renders, one soloed on the engine, one on the surf, so the two
   * halves of "engine out, sea stays" are separate numbers.
   */
  const FINISH_AT = 1.0;
  const finishScript = (t, audio) => {
    if (t <= FINISH_AT && t + H > FINISH_AT) audio.setPhase('finish');
  };
  const carAfter = await render(4, finishScript, { state: cruising, solo: 'engine' });
  const carBefore = await render(4, null, { state: cruising, solo: 'engine' });
  const surfAfter = await render(4, finishScript, { state: cruising, solo: 'surf' });
  const surfBefore = await render(4, null, { state: cruising, solo: 'surf' });
  const engineGone = ratio(
    mono(...carAfter, 2.6, 3.8), mono(...carBefore, 2.6, 3.8));
  const surfKept = ratio(
    mono(...surfAfter, 2.6, 3.8), mono(...surfBefore, 2.6, 3.8));
  /* And the fade is a fade, not a cut: the frame after the phase change must
     still be carrying most of the car, or it is a gate. */
  const fadeEdge = ratio(
    mono(...carAfter, FINISH_AT + 0.02, FINISH_AT + 0.12),
    mono(...carBefore, FINISH_AT + 0.02, FINISH_AT + 0.12));

  /* 4. AIRBORNE ACROSS A RESTART ------------------------------------------
   *
   * Reach it: press R while the car is in the air. The landing thump fires on
   * the falling edge of `airborne`, and the latch that holds the previous
   * frame's value survives a restart unless it is cleared. So a restart taken
   * mid-flight makes the first grounded frame of the NEW race look like a
   * landing from the OLD one, and the new race opens with a thump on the grid.
   *
   * Reach it: press R while the car is in the air. The restart puts the car
   * back on the grid GROUNDED, and the landing thump fires on the falling edge
   * of `airborne` — so the latch that holds the previous frame's value is what
   * decides it. A restart taken mid-flight leaves the latch true; the first
   * grounded frame of the new race is then read as a landing from the old one,
   * and the new race opens with a heavy thump while the car is standing still.
   *
   * The render: airborne through the restart frame, then GROUNDED a frame
   * later — which is what a restart does, because `placeAt` puts the car on
   * the road. The impact bus is soloed. The window after the restart must be
   * silent, and the control render — the same flight that lands normally, no
   * restart — must still produce a thump, so a "fix" that stops all landings
   * fails.
   */
  const AIR_RESTART = 1.4, GROUND_AT = 1.42, LAND_AT = 2.0;
  /* Airborne on the restart frame and grounded from the frame after it. ORDER
     MATTERS: the restart must happen while `airborne` is still true, or the
     latch is already false and the bug cannot be reproduced — a mutant that
     skips the airborne reset then passes, which is how this scenario was
     caught measuring nothing. `airborne: t <= AIR_RESTART` keeps exactly one
     full airborne frame spanning the restart. */
  const airState = t => at({
    rpm: 0.7, speed: 30, throttle: 0.9, gear: 3,
    airborne: t <= AIR_RESTART,
    landingForce: 0.9, shoreDistance: 20, shoreDrop: 12,
  });
  const airRender = await render(3, (t, audio) => {
    if (t <= AIR_RESTART && t + H > AIR_RESTART) audio.resetRace();
  }, { state: airState, solo: 'impact' });
  /* The control: the same flight, landing hard at GROUND_AT with no restart.
     Airborne to GROUND_AT and then down, so the landing fires normally. */
  const controlState = t => at({
    rpm: 0.7, speed: 30, throttle: 0.9, gear: 3,
    airborne: t <= GROUND_AT,
    landingForce: 0.9, shoreDistance: 20, shoreDrop: 12,
  });
  const airControl = await render(3, null, { state: controlState, solo: 'impact' });
  /* The window right after the restart. The car is grounded there, so any
     energy is the previous flight's landing firing on the new race. */
  const landAtRestart = mono(...airRender, GROUND_AT + H, GROUND_AT + 0.4);
  const landControl = mono(...airControl, GROUND_AT, GROUND_AT + 0.15);

  /* 5. THE SHORE LATCH -----------------------------------------------------
   *
   * Reach it: drive through a stretch where the coast query returns nothing —
   * between segments, a failed ray. The game passes `{...coastState(p)}`,
   * which is empty in that case, so the audio sees a state struct with no
   * shore fields. The surf must hold where it was, not snap to the default.
   *
   * The engine is stopped in both renders — speed and rpm at rest — so the
   * only thing on the bus is the surf, and the level is a pure function of
   * the shore fields. If the fields latch, omitting them changes nothing. */
  const DROP_AT = 1.0;
  const shoreNear = { shoreDistance: 12, shoreDrop: 8, oceanSide: -1 };
  /* GAP_STATE is the car at rest with NO shore fields at all: exactly what
     `{...coastState(p)}` produces when the query fails. Idle rpm rather than
     zero, because `rpm: 0` is read as the idle floor and the engine would sit
     at a constant note; the point is only that the car is quiet. */
  const GAP_STATE = { speed: 0, rpm: IDLE };
  const latched = await render(4, null, {
    solo: 'surf',
    state: t => (t < DROP_AT ? at(shoreNear) : GAP_STATE),
  });
  const held = await render(4, null, {
    solo: 'surf',
    state: t => (t < DROP_AT ? at(shoreNear) : at(shoreNear)),
  });
  const latchedLevel = mono(...latched, 2.4, 3.8);
  const heldLevel = mono(...held, 2.4, 3.8);
  const latchDrift = ratio(latchedLevel, heldLevel);
  /* And the image, because a distance snap and a side snap are different
     faults with the same level signature. Balance is (right - left) in dB. */
  const bal = (L, R, t0, t1) => {
    const a = Math.max(0, Math.floor(t0 * sr));
    const b = Math.min(L.length, Math.ceil(t1 * sr));
    let l = 0, r = 0;
    for (let i = a; i < b; i++) { l += L[i] * L[i]; r += R[i] * R[i]; }
    return db(Math.sqrt(r / (b - a))) - db(Math.sqrt(l / (b - a)));
  };
  const latchedBal = bal(...latched, 2.4, 3.8);
  const heldBal = bal(...held, 2.4, 3.8);

  /* 6. ONE FLAG ------------------------------------------------------------
   *
   * Already counted in section 2, but the plain case is worth its own number:
   * a single finishTone call must sound, and the flag must not be refused on
   * the first race of a session. */
  const oneFlag = await render(2.4, (t, audio) => {
    if (t <= 0.3 && t + H > 0.3) audio.finishTone('flag', false);
  }, { state: cruising, solo: 'finish' });
  const flagPeak = mono(...oneFlag, 0.3, 0.8).peak;

  /* ---- the live state machine, on a real context ------------------------
   *
   * The renders above prove the gains and the flush. This proves the methods
   * and the context states: pause suspends, resume resumes, resetRace clears
   * the latch and the phase, and none of it throws. Headless Chromium has no
   * audio device but does have a real AudioContext, and the harness launches
   * with autoplay unrestricted so resume() succeeds without a gesture. */
  let live = 'ok';
  try {
    const a = new Audio();
    await a.start();
    for (let i = 0; i < 30; i++) a.update(H, at({ rpm: 0.6, speed: 30, throttle: 0.8 }));
    a.pause();
    const pausedState = a.ctx.state;         // 'suspended' only if the suspend landed
    a.advance(0.5);                           // performs the scheduled suspend
    const settledState = a.ctx.state;
    a.resume();
    for (let i = 0; i < 10; i++) a.update(H, at({ rpm: 0.6, speed: 30, throttle: 0.8 }));
    a.setPhase('finish');
    a.finishTone('flag', true);
    a.resetRace();
    const phaseBack = a._phase;
    a.update(H, at({ rpm: 0.6, speed: 30 }));
    live = { start: 'ok', pausedState, settledState, resumedState: a.ctx.state, phaseBack };
    a.dispose();
  } catch (e) {
    live = 'threw: ' + ((e && e.message) || e);
  }

  return {
    pause: { pre, paused, pauseDrop, resumeBack, resumeGap, resumeStep, bedStep },
    restart: {
      chordBefore, chordControl, afterRestart, controlAfter,
      firstChord, secondLift, afterResetChord, flagsCalls,
    },
    finish: { engineGone, surfKept, fadeEdge },
    air: { landAtRestart, landControl },
    shore: { latchDrift, latchedBal, heldBal, latchedLevel, heldLevel },
    flagPeak,
    live,
  };
};

const out = await inPage(page => page.evaluate(RUN, [SR, H]));

const f = (x, n = 2) => (typeof x === 'number' ? x.toFixed(n) : String(x));

console.log('\n  lifecycle — every figure is dB against the car it interrupted');
console.log('  ' + '─'.repeat(74));

const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); };

/* ---- pause ---- */
const P = out.pause;
console.log('\n  PAUSE       press Escape mid-race, press it again to resume');
console.log(`    bed 0.6–1.8 s          ${f(P.pre.rms, 5)} rms`);
console.log(`    ducked 3.5–4.8 s       ${f(P.paused.rms, 5)} rms`);
console.log(`    drop from the bed      ${f(P.pauseDrop)} dB   (want <= -18)`);
console.log(`    resumed 7.0–9.5 s      ${f(P.resumeBack)} dB vs bed   (want within 1.5)`);
console.log(`    first 0.5 s of resume  ${f(P.resumeGap)} dB vs bed   (want within 2.5)`);
console.log(`    click at the resume    ${f(P.resumeStep, 4)} max step vs bed ${f(P.bedStep, 4)}   (want <= the bed)`);
check(P.pauseDrop <= -18,
  `pause does not silence: ${f(P.pauseDrop)} dB from the bed (want <= -18)`);
check(Math.abs(P.resumeBack) <= 1.5,
  `resume does not return to the bed: ${f(P.resumeBack)} dB (want within 1.5)`);
/* Continuous, not rebuilt. The graph is asked for the same parameters it had
   when it was ducked, so the level climbs back over the same time constant the
   duck used and is at the bed well inside half a second. A rebuild would
   re-create every source and every smoothed value, which is a discontinuity —
   caught here as a click, the largest sample-to-sample jump across the resume
   frame compared against the bed's own. */
check(Math.abs(P.resumeGap) <= 2.5,
  `resume does not reach the bed promptly: ${f(P.resumeGap)} dB over the first 0.5 s`);
check(P.resumeStep <= P.bedStep * 1.15,
  `the resume is a discontinuity, not a ramp: ${f(P.resumeStep, 4)} sample-to-sample vs a bed that steps ${f(P.bedStep, 4)}`);

/* ---- restart ---- */
const R = out.restart;
console.log('\n  RESTART     R after a flag; the old finish must not follow it');
console.log(`    chord before restart   ${f(R.chordBefore.rms, 5)} rms vs control ${f(R.chordControl.rms, 5)}`);
console.log(`    after restart           ${f(R.afterRestart.rms, 5)} rms vs control ${f(R.controlAfter.rms, 5)}`);
console.log(`    previous-run chord left ${f(R.afterRestart.rms > 0
  ? 20 * Math.log10(R.controlAfter.rms / Math.max(1e-12, R.afterRestart.rms)) : 99)} dB below where it would be   (want >= 20)`);
/* The control's after-window is not silence — the cruise bed leaks a little
   into the finish bus through the bus gain. That leak is the reference. */
const residue = R.controlAfter.rms > 1e-7
  ? 20 * Math.log10(R.controlAfter.rms / Math.max(1e-12, R.afterRestart.rms))
  : 99;
check(residue >= 20,
  `the previous run's chord survives the restart: only ${f(residue)} dB down`);
check(R.chordBefore.rms > R.chordControl.rms * 0.5,
  'the control and the restart render disagree BEFORE the restart — the comparison is invalid');
/* One flag per race, and the latch clears on resetRace. */
console.log(`    flag in one race        first ${f(R.firstChord.rms, 5)} rms`);
console.log(`    second call in the race ${f(R.secondLift)} dB at its own attack   (want <= 1)`);
console.log(`    after resetRace         ${f(R.afterResetChord.rms, 5)} rms (flag #2 of the new race)`);
check(R.firstChord.rms > 1e-3, 'the first flag of a session did not sound at all');
check(R.secondLift <= 1,
  `a second flag sounded in the same race: ${f(R.secondLift)} dB added at its attack`);
check(R.afterResetChord.rms > 1e-3,
  'resetRace did not re-arm the flag: the next race can never finish');
console.log(`    flag peak (one call)    ${f(out.flagPeak, 4)}   (want > 0.02)`);
check(out.flagPeak > 0.02, `one flag is inaudible: peak ${f(out.flagPeak, 4)}`);

/* ---- finish ---- */
const F = out.finish;
console.log('\n  FINISH      cross the line; engine and tyres out, sea stays');
console.log(`    engine 2.6–3.8 s        ${f(F.engineGone)} dB vs racing   (want <= -20)`);
console.log(`    surf   2.6–3.8 s        ${f(F.surfKept)} dB vs racing   (want within 3)`);
console.log(`    car at the fade edge    ${f(F.fadeEdge)} dB vs racing   (want >= -6, a fade not a gate)`);
check(F.engineGone <= -20,
  `the engine does not leave at the flag: ${f(F.engineGone)} dB`);
check(Math.abs(F.surfKept) <= 3,
  `the sea does not survive the flag: ${f(F.surfKept)} dB against the racing level`);
check(F.fadeEdge >= -6,
  `the car is cut, not faded: ${f(F.fadeEdge)} dB one frame after the flag`);

/* ---- airborne ---- */
const A = out.air;
console.log('\n  AIRBORNE    R pressed in mid-air; the landing must not fire');
console.log(`    thump after the restart ${f(A.landAtRestart.peak, 4)} peak   (want < 0.02)`);
console.log(`    control landing         ${f(A.landControl.peak, 4)} peak   (want > 0.2 — landings still land)`);
check(A.landAtRestart.peak < 0.02,
  `a landing fired on the first grounded frame after a restart: peak ${f(A.landAtRestart.peak, 4)}`);
check(A.landControl.peak > 0.2,
  `landings are silent in the control too: peak ${f(A.landControl.peak, 4)} — the fix must not mute them`);

/* ---- shore ---- */
const S = out.shore;
console.log('\n  SHORE       coast query returns nothing for two seconds');
console.log(`    latched vs held         ${f(S.latchDrift)} dB   (want within 2)`);
console.log(`    image latched vs held   ${f(S.latchedBal)} / ${f(S.heldBal)} dB   (want within 1)`);
check(Math.abs(S.latchDrift) <= 2,
  `the shore does not latch: ${f(S.latchDrift)} dB from the held value`);
check(Math.abs(S.latchedBal - S.heldBal) <= 1,
  `the shore jumps side when the fields are missing: ${f(S.latchedBal)} vs ${f(S.heldBal)} dB`);

/* ---- the live state machine ---- */
const L = out.live;
console.log('\n  LIVE        the methods on a real AudioContext');
console.log(`    ${typeof L === 'string' ? L : JSON.stringify(L)}`);
check(typeof L === 'object' && L.start === 'ok',
  `live lifecycle threw: ${typeof L === 'string' ? L : JSON.stringify(L)}`);
if (typeof L === 'object') {
  /* The suspend is asynchronous — it lands a task later — so the state right
     after pause() is not the assertion. What IS asserted is that resume()
     returns a running context and that resetRace puts the phase back. */
  check(L.resumedState === 'running', `resume() left the context ${L.resumedState}`);
  check(L.phaseBack === 'race', `resetRace left the phase ${L.phaseBack}`);
}

/* ---- what this file does NOT cover ---- */
console.log('\n  MANUAL — how to reach each scenario, and what is not covered');
console.log('    pause   : press Escape mid-race. The picture freezes (main.js frame)');
console.log('              and the sound ducks to silence before the context is');
console.log('              suspended. Escape again resumes from the same parameters.');
console.log('    restart : press R on the results card, or Escape > RESTART. The old');
console.log('              finish does not follow the new grid and the new race can');
console.log('              sound its own flag.');
console.log('    finish  : cross the line with the ending on. Engine and tyres fade');
console.log('              out over ~0.55 s, the surf stays, the flag sounds once.');
console.log('    airborne: press R while the car is off the ground. No landing thump');
console.log('              on the first grounded frame of the new race.');
console.log('    shore   : drive anywhere the coast query fails (between segments).');
console.log('              The surf holds its distance and side instead of snapping.');
console.log('    NOT measured here: the suspend half of the pause, which needs a real');
console.log('    audio thread to observe. tools/audio.mjs proves a live context boots,');
console.log('    stops and restarts; the level drop measured above is what is heard.');

console.log('');
if (fails.length) {
  for (const x of fails) console.log('  ✗ ' + x);
  process.exitCode = 1;
} else {
  console.log('  ✓ pause ducks and continues, restart carries nothing over,');
  console.log('    the flag sounds once, the car leaves at the line and the sea stays,');
  console.log('    no landing fires across a restart, the shore latch holds');
}
finish(process.exitCode || 0);
