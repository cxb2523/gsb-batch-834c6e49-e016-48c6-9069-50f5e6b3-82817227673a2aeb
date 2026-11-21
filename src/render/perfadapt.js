// EXILIUM — performance-adaptive point-light budget. Owner: PerfAdapt.
//
// ## What this does
//
// The scene is fragment-bound and its cost is the forward per-fragment point-light
// loop (see lightcull.js: ~1.6 ms per light above 16 on software GL). The culler
// already quantises the visible count onto a prewarmed rung ladder so count changes
// never recompile a material. This system adds the POLICY that moves a ceiling over
// that ladder:
//
//   frame time over CFG...frameMsDown for downFrames straight frames
//     -> ceiling one rung DOWN (fewer visible lights, cheaper AO, slightly raised
//        ambient so the lost local fill does not crush the image to black)
//   frame time under frameMsUp for upFrames straight frames
//     -> ceiling one rung UP, until the initial ceiling is restored
//
// ## The four chains, coupled atomically on every shift
//
// A rung shift is one function (`applyLevel`) that touches, in order:
//
//   1. lightcull.setAdaptiveCap(rung)  — the visible-light ceiling itself.
//      Contributing lights hidden by the cap stay VISIBLE in the stats: they are
//      counted in both `droppedInFrustum` and `droppedByAdapt`, so adaptation can
//      never silently discard a real light.
//   2. pipeline.setPerfSamples(n)      — GTAO + contact-AO SAMPLES follow the tier,
//      so a dropped light budget can never leave AO sampling at the high tier (and
//      vice versa). Only sample counts change; passes are never enabled/disabled.
//   3. World.setAmbientIntensity(m)    — sky/IBL + hemisphere intensity follow the
//      same tier table; lower local light is partly offset by a modest ambient
//      raise, and restoring the ceiling restores the authored ambient exactly.
//   4. World.rescanCSMMaterials()      — a forced scene sweep at the shift instant.
//      A lit material added in the same frame a shift rebuilds shader registrations
//      is registered onto the CSM cascades immediately instead of waiting for the
//      20-frame backstop sweep, so it cannot render its first frame shadowless.
//
// ## No residual state
//
// setEnabled(false) (or setEnabled(true) after a disable) restores EVERYTHING the
// system ever changed — light cap cleared, AO samples back to the boot tier,
// ambient back to its initial multiplier — and resets every internal counter. The
// only state this system owns lives in this module; there is no new global singleton
// (it is reached via World.perfAdapt, the same blackboard pattern as lightCull).
//
// ## Testability
//
// The frame-time policy is a pure function of the sample stream (decide()), so the
// acceptance scenarios can be driven deterministically with feedFrameTime() without
// waiting on real rAF. All state is readable from `stats` and shows up in F3.
import { CFG } from '../core/config.js';
import { World } from '../core/world.js';

/**
 * Build an adaptive controller against explicit collaborators. The system default
 * wires the live World objects; tests construct this directly with fakes.
 *
 * @param {object} deps
 * @param {() => number[]} deps.getRungs          ladder, low->high (from lightcull)
 * @param {(rung:number|null)=>number|null} deps.setCap  apply/clear the light ceiling
 * @param {(n:number)=>number} deps.setAoSamples  apply the AO sample tier
 * @param {(m:number)=>void} deps.setAmbient      apply the ambient multiplier
 * @param {() => void} [deps.rescanCsm]           force CSM material registration
 * @param {object} [cfg]                          overrides CFG.graphics.perfAdapt
 */
export function createPerfAdapt(deps, cfg) {
  const baseCfg = { ...CFG.graphics.perfAdapt, ...(cfg || {}) };
  const C = { ...baseCfg };
  const RUNGS = deps.getRungs();
  const TOP = RUNGS.length - 1;
  // The tier tables must cover every rung. A budget-capped ladder is SHORTER, so it
  // aligns from the TOP (its highest rung always takes the high-quality tier); guard
  // the offset against a misconfigured table rather than indexing to undefined.
  const tierOffset = Math.max(0, C.aoSamples.length - RUNGS.length);
  const ambOffset = Math.max(0, C.ambientMult.length - RUNGS.length);
  const tierFor = (level) => C.aoSamples[Math.min(C.aoSamples.length - 1, tierOffset + level)];
  const ambFor = (level) => C.ambientMult[Math.min(C.ambientMult.length - 1, ambOffset + level)];

  // --- captured initial state: the exact values adaptation must restore to -------
  const initial = {
    level: TOP,
    rung: RUNGS[TOP],
    aoSamples: null,        // filled lazily at first frame (pipeline exists by then)
    ambientMult: 1,         // World may already carry a non-1 mult from other tools
  };

  // --- mutable adaptation state --------------------------------------------------
  let enabled = !!C.enabled;
  let level = TOP;                  // index into RUNGS; TOP = no adaptation active
  let overStreak = 0;               // consecutive frames over the down threshold
  let underStreak = 0;              // consecutive frames under the recovery threshold
  let framesSinceShift = Infinity;  // cooldown gate; Infinity = no shift has happened
  let frameAge = 0;                 // frames since (re)enable — warmup gate
  let lastDt = 0;
  let stalls = 0;
  let shiftsDown = 0, shiftsUp = 0, rescans = 0;

  function captureInitial() {
    if (deps.getAoSamples) initial.aoSamples = deps.getAoSamples();
    if (deps.getAmbient) initial.ambientMult = deps.getAmbient();
  }

  /**
   * Pure policy: given the next frame time (seconds) and current state, return the
   * level the controller should move to (or the same level) plus the reason. Pure so
   * the acceptance tests can drive exact sequences without rendering anything.
   */
  function decide(dt) {
    if (!enabled) return { level, reason: 'disabled' };
    frameAge++;
    framesSinceShift++;
    lastDt = dt;
    const ms = dt * 1000;

    // A background-tab / breakpoint pause is not GPU load. Reset both streaks and
    // wait out a fresh warmup so resuming never instant-downgrades on the catch-up
    // frame (the clock itself clamps dt at 100 ms; this catches the band above).
    if (ms > C.stallMs) {
      overStreak = 0; underStreak = 0; stalls++;
      return { level, reason: 'stall' };
    }
    // The first warmupFrames frames after (re)enable make no decision at all, so the
    // boot/compile cost and any prewarm render can't be mistaken for steady load.
    if (frameAge <= C.warmupFrames) {
      overStreak = 0; underStreak = 0;
      return { level, reason: 'warmup' };
    }

    const over = ms > C.frameMsDown;
    const under = ms < C.frameMsUp;
    overStreak = over ? overStreak + 1 : 0;
    underStreak = under ? underStreak + 1 : 0;

    if (overStreak >= C.downFrames && level > 0 && framesSinceShift >= C.cooldownFrames) {
      return { level: level - 1, reason: 'down' };
    }
    if (underStreak >= C.upFrames && level < TOP && framesSinceShift >= C.cooldownFrames) {
      return { level: level + 1, reason: 'up' };
    }
    return { level, reason: 'hold' };
  }

  /** Apply a level across all four chains. This is the ONLY place collaborators are
   *  mutated, so "the four chains stay consistent" reduces to one ordered function. */
  function applyLevel(next, reason) {
    if (next === level && reason !== 'force') return;
    const rung = RUNGS[next];

    // 1. light ceiling — counted drops, never silent (lightcull stats).
    deps.setCap(rung);
    // 2. AO + contact-shadow sample tier, in lockstep with the rung.
    deps.setAoSamples(tierFor(next));
    // 3. sky/ambient intensity from the same tier table.
    deps.setAmbient(ambFor(next));
    // 4. immediate CSM rescan: materials born on this shift frame get cascades now.
    if (deps.rescanCsm) { deps.rescanCsm(); rescans++; }

    if (next < level) shiftsDown++;
    else if (next > level) shiftsUp++;
    level = next;
    overStreak = 0; underStreak = 0; framesSinceShift = 0;
  }

  /** Restore every collaborator to the values captured at construction and clear all
   *  adaptation state. Called on disable, and as the tail of re-enable. */
  function restoreInitial() {
    deps.setCap(null);
    if (initial.aoSamples != null) deps.setAoSamples(initial.aoSamples);
    deps.setAmbient(initial.ambientMult);
    if (deps.rescanCsm) { deps.rescanCsm(); rescans++; }
    level = TOP;
    overStreak = 0; underStreak = 0; framesSinceShift = Infinity; frameAge = 0;
    shiftsDown = 0; shiftsUp = 0; stalls = 0;
  }

  const api = {
    /** One frame of policy. `dt` is the WALL-CLOCK frame interval in seconds — not
     *  the clock's hitstop-scaled sim dt, which would read slow during time freezes. */
    frame(dt) {
      const d = decide(dt);
      if (d.level !== level) applyLevel(d.level, d.reason);
      return d.reason;
    },

    /** Enable/disable the whole adaptation. Disabling restores the initial ceiling,
     *  AO tier and ambient, and leaves no temporary state behind; re-enabling starts
     *  again from the initial level behind the warmup gate. */
    setEnabled(on) {
      on = !!on;
      if (on === enabled) return enabled;
      enabled = on;
      if (!enabled) restoreInitial();
      else {
        // Guarantee a clean start even if the previous session ended mid-ladder.
        restoreInitial();
        captureInitial();
      }
      return enabled;
    },
    get enabled() { return enabled; },

    /** Test/console hooks: feed a frame time as if rAF produced it. */
    feedFrameTime(dt) { return api.frame(dt); },
    /** Test/console hooks: jump straight to a ladder level (still couples all chains). */
    forceLevel(next) {
      next = Math.max(0, Math.min(TOP, Math.floor(next)));
      applyLevel(next, 'force');
      return level;
    },
    /** Debug/test hook: override the frame-count gates without touching production
     *  defaults. Pass {} to restore the config values. The live system never calls
     *  this; it exists so console/F3 checks and the acceptance harness can drive a
     *  deterministic decision sequence. Returns the effective gate set. */
    configure(o = {}) {
      for (const k of ['frameMsDown', 'frameMsUp', 'downFrames', 'upFrames',
                       'cooldownFrames', 'warmupFrames', 'stallMs']) {
        if (o[k] !== undefined) C[k] = o[k];
      }
      return { ...C };
    },
    /** Debug/test hook: reset every gate to the values passed at construction. */
    resetConfig() {
      for (const k of Object.keys(baseCfg)) C[k] = baseCfg[k];
      return { ...C };
    },

    /** Everything the F3 overlay / console needs to verify behaviour. */
    get stats() {
      return {
        enabled,
        level,
        topLevel: TOP,
        rung: RUNGS[level],
        initialRung: RUNGS[TOP],
        aoSamples: tierFor(level),
        ambientMult: ambFor(level),
        initialAoSamples: initial.aoSamples,
        initialAmbientMult: initial.ambientMult,
        overStreak, underStreak,
        framesSinceShift, frameAge,
        lastFrameMs: Math.round(lastDt * 1000),
        stalls, shiftsDown, shiftsUp, rescans,
        thresholds: { downMs: C.frameMsDown, upMs: C.frameMsUp,
                      downFrames: C.downFrames, upFrames: C.upFrames },
      };
    },
  };

  captureInitial();
  return api;
}

// ----------------------------------------------------------------- live system
let adapt = null;

export default {
  name: 'perfadapt',

  // Registered in main.js immediately AFTER lightcull. Its frame() only publishes a
  // ceiling through World.lightCull; the cull (already in the system list, running on
  // the same frame) reads that ceiling when it next runs, so a decision takes effect
  // on the next cull without perfadapt ever touching light visibility itself.
  init() {
    adapt = createPerfAdapt({
      getRungs: () => World.lightCull.rungs,
      setCap: (rung) => World.lightCull.setAdaptiveCap(rung),
      setAoSamples: (n) => World.pipeline.setPerfSamples(n),
      getAoSamples: () => World.pipeline.perfSamples,
      setAmbient: (m) => World.setAmbientIntensity(m),
      getAmbient: () => (World.getAmbientIntensityMult ? World.getAmbientIntensityMult() : 1),
      rescanCsm: () => World.rescanCSMMaterials && World.rescanCSMMaterials(),
    });
    World.perfAdapt = adapt;
  },

  frame() {
    if (!adapt || !adapt.enabled) return;
    // Wall-clock interval: Clock.tick clamps to 100 ms and perfadapt's own stall
    // guard ignores tab-switch pauses, so neither hitstop nor backgrounding can
    // masquerade as GPU pressure.
    const now = performance.now();
    if (this._lastNow == null) { this._lastNow = now; return; }
    const dt = (now - this._lastNow) / 1000;
    this._lastNow = now;
    adapt.frame(dt);
  },

  dispose() { if (adapt && adapt.enabled) adapt.setEnabled(false); adapt = null; },
};
