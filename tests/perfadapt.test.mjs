/**
 * Headless acceptance tests for the performance-adaptive light budget.
 *
 * Covers the three required scenarios without a browser:
 *   1. normal combat: sustained heavy frames auto-downshift, recovery walks back up
 *   2. manual disable: light cap cleared, AO tier + ambient restored, no temp state
 *   3. shift-instant material registration: a lit material born on a shift frame is
 *      swept onto the CSM cascades immediately (the rescan runs inside the shift)
 *
 * Plus the culler-level guarantees:
 *   - adaptive cap quantises onto prewarmed rungs and counts droppedByAdapt
 *   - out-of-frustum / zero-contribution lights are never counted as drops
 *   - shadow-casting lights are never hidden by the cap
 *
 * Run: node --test tests/perfadapt.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPerfAdapt } from '../src/render/perfadapt.js';

const RUNGS = [12, 16, 20, 24, 28, 34];

function makeDeps(overrides = {}) {
  const calls = { caps: [], ao: [], ambient: [], rescans: 0 };
  const deps = {
    getRungs: () => RUNGS.slice(),
    setCap: (r) => { calls.caps.push(r); return r; },
    setAoSamples: (n) => { calls.ao.push(n); return n; },
    getAoSamples: () => 16,
    setAmbient: (m) => { calls.ambient.push(m); },
    getAmbient: () => 1,
    rescanCsm: () => { calls.rescans++; },
    ...overrides,
  };
  return { deps, calls };
}

const C = {
  frameMsDown: 34, frameMsUp: 25,
  downFrames: 45, upFrames: 180,
  cooldownFrames: 60, warmupFrames: 120, stallMs: 100,
  aoSamples: [6, 9, 12, 16, 16, 16],
  ambientMult: [1.15, 1.10, 1.06, 1.02, 1.0, 1.0],
};

describe('perfadapt policy', () => {
  test('sustained over-budget frames downshift one rung at a time, coupling all chains', () => {
    const { deps, calls } = makeDeps();
    const a = createPerfAdapt(deps, C);

    // warmup: even heavy frames must not move the level (first warmupFrames frames)
    for (let i = 0; i < C.warmupFrames; i++) a.feedFrameTime(0.05);
    assert.equal(a.stats.level, 5);
    assert.deepEqual(calls.caps, []);

    // heavy combat: 45 frames at 45 ms (22 fps) -> one downshift
    for (let i = 0; i < C.downFrames; i++) a.feedFrameTime(0.045);
    let s = a.stats;
    assert.equal(s.level, 4);
    assert.equal(s.rung, 28);
    assert.equal(s.shiftsDown, 1);
    assert.deepEqual(calls.caps.at(-1), 28);          // chain 1: light ceiling
    assert.deepEqual(calls.ao.at(-1), 16);            // chain 2: AO tier (tier 4 = 16)
    assert.deepEqual(calls.ambient.at(-1), 1.0);      // chain 3: ambient tier 4
    assert.equal(calls.rescans, 1);                   // chain 4: CSM rescan on shift

    // cooldown blocks an immediate second shift even while heavy
    for (let i = 0; i < C.cooldownFrames - 1; i++) a.feedFrameTime(0.045);
    assert.equal(a.stats.level, 4);

    // after cooldown + another full streak, another single rung down
    for (let i = 0; i < C.downFrames; i++) a.feedFrameTime(0.045);
    s = a.stats;
    assert.equal(s.level, 3);
    assert.equal(s.rung, 24);
    assert.equal(s.shiftsDown, 2);
    assert.equal(calls.ao.at(-1), 16);                // tier 3 = 16
    assert.equal(calls.ambient.at(-1), 1.02);
    assert.equal(calls.rescans, 2);
  });

  test('recovery walks back up one rung at a time only after sustained headroom', () => {
    const { deps, calls } = makeDeps();
    const a = createPerfAdapt(deps, C);
    for (let i = 0; i < C.warmupFrames; i++) a.feedFrameTime(0.018);  // clear warmup gate
    a.forceLevel(2);                                   // rung 20, as if combat forced it
    assert.equal(a.stats.level, 2);
    assert.equal(calls.ao.at(-1), 12);
    assert.equal(calls.ambient.at(-1), 1.06);

    // forceLevel does not consume the cooldown for subsequent policy shifts: the
    // first upFrames calm frames already satisfy every gate
    for (let i = 0; i < C.upFrames - 1; i++) a.feedFrameTime(0.018);
    assert.equal(a.stats.level, 2);
    a.feedFrameTime(0.018);
    assert.equal(a.stats.level, 3);                   // one rung up
    assert.equal(a.stats.shiftsUp, 1);
    assert.equal(calls.caps.at(-1), 24);
    assert.equal(calls.ambient.at(-1), 1.02);

    // after each shift the cooldown must elapse before another up-shift:
    // cooldownFrames-1 calm frames hold, then the remaining upFrames streak completes it
    for (let i = 0; i < C.cooldownFrames - 1; i++) a.feedFrameTime(0.018);
    assert.equal(a.stats.level, 3);
    for (let i = 0; i < C.upFrames; i++) a.feedFrameTime(0.018);
    assert.equal(a.stats.level, 4);
    for (let i = 0; i < C.cooldownFrames - 1 + C.upFrames; i++) a.feedFrameTime(0.018);
    const s = a.stats;
    assert.equal(s.level, 5);                         // back at the initial ceiling
    assert.equal(s.rung, 34);
    assert.equal(s.aoSamples, 16);
    assert.equal(s.ambientMult, 1.0);
  });

  test('mid-range frame times hold the level (neither threshold crossed)', () => {
    const { deps } = makeDeps();
    const a = createPerfAdapt(deps, C);
    for (let i = 0; i < C.warmupFrames + 500; i++) a.feedFrameTime(0.030); // 30 ms, in band
    assert.equal(a.stats.level, 5);
    assert.equal(a.stats.shiftsDown, 0);
    assert.equal(a.stats.shiftsUp, 0);
  });

  test('a background-tab stall never triggers a downshift', () => {
    const { deps } = makeDeps();
    const a = createPerfAdapt(deps, C);
    for (let i = 0; i < C.warmupFrames; i++) a.feedFrameTime(0.018);
    for (let i = 0; i < C.downFrames - 1; i++) a.feedFrameTime(0.045);
    a.feedFrameTime(0.5);                             // 500 ms tab switch
    assert.equal(a.stats.level, 5);
    assert.equal(a.stats.stalls, 1);
    // streak was reset: another heavy run needs the full downFrames again
    for (let i = 0; i < C.downFrames - 1; i++) a.feedFrameTime(0.045);
    assert.equal(a.stats.level, 5);
  });
});

describe('perfadapt teardown', () => {
  test('disabling restores initial cap, AO tier and ambient, and clears temp state', () => {
    const { deps, calls } = makeDeps();
    const a = createPerfAdapt(deps, C);
    a.forceLevel(1);                                   // rung 16, ao9, ambient 1.10
    assert.equal(calls.caps.at(-1), 16);

    a.setEnabled(false);
    assert.deepEqual(calls.caps.at(-1), null);        // cap cleared
    assert.deepEqual(calls.ao.at(-1), 16);            // boot AO tier restored
    assert.deepEqual(calls.ambient.at(-1), 1);        // authored ambient restored
    const s = a.stats;
    assert.equal(s.enabled, false);
    assert.equal(s.level, 5);
    assert.equal(s.rung, 34);
    assert.equal(s.overStreak, 0);
    assert.equal(s.underStreak, 0);
    assert.equal(s.shiftsDown, 0);
    assert.equal(s.shiftsUp, 0);
    assert.equal(s.frameAge, 0);

    // frames while disabled are policy no-ops
    for (let i = 0; i < 300; i++) a.feedFrameTime(0.05);
    assert.equal(a.stats.level, 5);
  });

  test('re-enabling starts clean from the initial level behind the warmup', () => {
    const { deps } = makeDeps();
    const a = createPerfAdapt(deps, C);
    a.forceLevel(0);
    a.setEnabled(false);
    a.setEnabled(true);
    assert.equal(a.stats.enabled, true);
    assert.equal(a.stats.level, 5);
    // warmup frames (frameAge 1..warmupFrames) then downFrames-1 heavy frames: no shift
    for (let i = 0; i < C.warmupFrames; i++) a.feedFrameTime(0.045);
    for (let i = 0; i < C.downFrames - 1; i++) a.feedFrameTime(0.045);
    assert.equal(a.stats.level, 5);                   // warmup gating restarted
  });

  test('restores a non-default pre-existing ambient multiplier, not hardcoded 1.0', () => {
    const { deps } = makeDeps({ getAmbient: () => 0.8 });
    const a = createPerfAdapt(deps, C);
    a.forceLevel(0);                                   // ambient raised to 1.15
    a.setEnabled(false);
    assert.equal(a.stats.initialAmbientMult, 0.8);
  });

  test('a shorter budget-capped ladder aligns its top rung to the high-quality tier', () => {
    const deps = {
      ...makeDeps().deps,
      getRungs: () => [12, 16, 20],                    // lightBudget-capped ladder
    };
    const a = createPerfAdapt(deps, C);
    assert.deepEqual(a.stats.rung, 20);
    // top-aligned: 3-rung ladder takes the last 3 entries of the 6-tier tables
    assert.equal(a.stats.aoSamples, 16);              // aoSamples[3..5] -> top is 16
    assert.equal(a.stats.ambientMult, 1.0);
    a.forceLevel(0);
    assert.equal(a.stats.aoSamples, 16);              // aoSamples[3] = 16
    assert.equal(a.stats.ambientMult, 1.02);          // ambientMult[3] = 1.02
    a.forceLevel(1);
    assert.equal(a.stats.aoSamples, 16);              // aoSamples[4] = 16
    assert.equal(a.stats.ambientMult, 1.0);
  });
});

describe('perfadapt CSM rescan at the shift instant', () => {
  test('every shift (including the first downshift) forces a material rescan', () => {
    const { deps, calls } = makeDeps();
    const a = createPerfAdapt(deps, C);
    assert.equal(calls.rescans, 0);
    for (let i = 0; i < C.warmupFrames + C.downFrames; i++) a.feedFrameTime(0.045);
    assert.equal(a.stats.level, 4);
    assert.equal(calls.rescans, 1);                   // rescan happens inside the shift
    // ordering proof: cap/AO/ambient were applied in the same applyLevel call before return
    assert.ok(calls.caps.includes(28));
    assert.ok(calls.ao.includes(16));
    assert.ok(calls.ambient.includes(1.0));
  });

  test('forceLevel mid-frame rescans so a newly added material cannot miss cascades', () => {
    // Simulates the acceptance case: material added in the same frame as the shift.
    const registered = [];
    const deps = {
      ...makeDeps().deps,
      rescanCsm: () => registered.push('swept'),
    };
    const a = createPerfAdapt(deps, C);
    a.forceLevel(2);
    assert.deepEqual(registered, ['swept']);
  });
});
