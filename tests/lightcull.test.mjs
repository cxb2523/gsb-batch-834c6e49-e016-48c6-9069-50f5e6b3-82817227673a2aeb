/**
 * Headless tests for the adaptive ceiling inside the point-light culler.
 *
 * lightcull.js imports three (math classes only — no renderer needed) and the
 * World blackboard. We build a real THREE.Scene with PointLights and a camera so
 * the actual frustum/sphere intersection code runs, then drive the cull system's
 * frame() directly.
 *
 * Run: node --test tests/lightcull.test.mjs
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '../src/core/world.js';
import lightcull from '../src/render/lightcull.js';

const FRUSTUM_FILL = 30;          // lights within this radius of the camera are in frustum
const FAR_Z = 0;

function makeLight({ x, intensity = 20, distance = 10, castShadow = false }) {
  const l = new THREE.PointLight(0xffffff, intensity, distance, 2);
  l.position.set(x, 0, FAR_Z);
  l.castShadow = castShadow;
  return l;
}

function boot(scene, camera, rungsBudget = null) {
  World.scene = scene; World.camera = camera; World.renderer = null;
  const savedBudget = rungsBudget;
  // lightcull reads CFG.graphics at init; lightCull defaults true and lightBudget
  // null in the shipped config, so no patching is needed for the default ladder.
  lightcull.init({ scene, camera, renderer: null });
  if (savedBudget != null) {
    // emulate CFG.graphics.lightBudget by filtering via the public cap path
  }
  return World.lightCull;
}

describe('lightcull adaptive cap', () => {
  let scene, camera, api;

  before(() => {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  });

  beforeEach(() => {
    scene = new THREE.Scene();
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    World.scene = scene; World.camera = camera; World.renderer = null;
    api = boot(scene, camera);
  });

  test('uncapped: demand quantises up the static ladder, zero adaptive drops', () => {
    // 18 in-frustum lights + a deep pool of out-of-frustum lights to pad to the rung
    for (let i = 0; i < 18; i++) scene.add(makeLight({ x: (i % 6) * 2 - 5 }));
    for (let i = 0; i < 20; i++) scene.add(makeLight({ x: 150 + i * 12 }));
    lightcull.frame();
    const s = api.stats;
    assert.equal(s.inFrustum, 18);
    assert.equal(s.rung, 20);
    assert.equal(s.shown, 20);
    assert.equal(s.droppedInFrustum, 0);
    assert.equal(s.droppedByAdapt, 0);
    assert.equal(s.capRung, null);                     // null = uncapped in stats
    assert.equal(s.capped, false);
  });

  test('capped: the effective rung never exceeds the cap and real drops are counted', () => {
    for (let i = 0; i < 18; i++) scene.add(makeLight({ x: (i % 6) * 2 - 5 }));
    for (let i = 0; i < 20; i++) scene.add(makeLight({ x: 150 + i * 12 }));
    const eff = api.setAdaptiveCap(16);
    assert.equal(eff, 16);
    lightcull.frame();
    const s = api.stats;
    assert.equal(s.rung, 16);
    assert.equal(s.shown, 16);
    assert.equal(s.droppedInFrustum, 2);              // 18 in frustum, 16 shown
    assert.equal(s.droppedByAdapt, 2);                // attributable to adaptation
    assert.equal(s.capRung, 16);
    assert.equal(s.offRung, 0);
  });

  test('cap between rungs clamps down to the nearest prewarmed rung', () => {
    // 15 in-frustum lights would take rung 16 uncapped; cap 17 clamps to rung 16
    for (let i = 0; i < 15; i++) scene.add(makeLight({ x: (i % 5) * 2 - 4 }));
    for (let i = 0; i < 20; i++) scene.add(makeLight({ x: 150 + i * 12 }));
    const eff = api.setAdaptiveCap(17);               // not a rung
    assert.equal(eff, 16);
    lightcull.frame();
    assert.equal(api.stats.rung, 16);
    assert.equal(api.stats.capRung, 16);
  });

  test('demand below the cap still quantises to the fitting smaller rung', () => {
    for (let i = 0; i < 10; i++) scene.add(makeLight({ x: i - 5 }));
    api.setAdaptiveCap(24);
    lightcull.frame();
    assert.equal(api.stats.rung, 12);                 // fits rung 12; cap not binding
    assert.equal(api.stats.droppedByAdapt, 0);
  });

  test('clearing the cap restores full-ladder quantisation', () => {
    for (let i = 0; i < 18; i++) scene.add(makeLight({ x: (i % 6) * 2 - 5 }));
    api.setAdaptiveCap(12);
    lightcull.frame();
    assert.equal(api.stats.rung, 12);
    api.setAdaptiveCap(null);
    assert.equal(api.capRung, null);
    lightcull.frame();
    assert.equal(api.stats.rung, 20);
    assert.equal(api.stats.droppedByAdapt, 0);
  });

  test('out-of-frustum lights pad the rung and are NEVER counted as dropped', () => {
    // 3 in-frustum + plenty of far-away zero-contribution lights for padding
    for (let i = 0; i < 3; i++) scene.add(makeLight({ x: i - 1 }));
    for (let i = 0; i < 20; i++) scene.add(makeLight({ x: 150 + i * 12 }));
    lightcull.frame();
    const s = api.stats;
    assert.equal(s.inFrustum, 3);
    assert.equal(s.rung, 12);
    assert.equal(s.shown, 12);
    assert.equal(s.padded, 9);
    assert.equal(s.droppedInFrustum, 0);
    assert.equal(s.droppedByAdapt, 0);
  });

  test('a shadow-casting light survives even under a binding cap', () => {
    // 16 ordinary in-frustum lights + 1 shadow caster, cap at 12
    for (let i = 0; i < 16; i++) scene.add(makeLight({ x: (i % 6) * 2 - 5 }));
    const shadow = makeLight({ x: 0, castShadow: true });
    scene.add(shadow);
    api.setAdaptiveCap(12);
    lightcull.frame();
    const s = api.stats;
    assert.equal(shadow.visible, true);               // never hidden
    assert.equal(s.rung, 12);
    // 17 in frustum, 12 shown -> 5 drops, all non-shadow lights
    assert.equal(s.droppedInFrustum, 5);
    assert.equal(s.droppedByAdapt, 5);
  });

  test('dimmest in-frustum lights are the ones the cap hides (irradiance order)', () => {
    scene.clear();
    const bright = makeLight({ x: 0, intensity: 100, distance: 10 });
    const dim = makeLight({ x: 3, intensity: 1, distance: 10 });
    scene.add(bright, dim);
    for (let i = 0; i < 14; i++) scene.add(makeLight({ x: -4 + (i % 5), intensity: 20 }));
    api.setAdaptiveCap(12);
    lightcull.frame();
    assert.equal(bright.visible, true);
    // the single dimmest light is among the hidden when the cap binds (16 in frustum)
    assert.equal(api.stats.inFrustum, 16);
    assert.equal(dim.visible, false);
  });

  test('cull is a no-op-safe when disabled and re-enables cleanly', () => {
    for (let i = 0; i < 18; i++) scene.add(makeLight({ x: (i % 6) * 2 - 5 }));
    api.setAdaptiveCap(12);
    api.setEnabled(false);
    lightcull.frame();
    for (const o of scene.children) if (o.isPointLight) assert.equal(o.visible, true);
    api.setEnabled(true);
    lightcull.frame();
    // cap state persists across the cull enable toggle (policy owns clearing it)
    assert.equal(api.stats.rung, 12);
  });
});
