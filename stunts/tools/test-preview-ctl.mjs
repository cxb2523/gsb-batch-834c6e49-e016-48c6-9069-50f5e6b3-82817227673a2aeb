// Unit tests for the track-menu overview's interaction lifecycle (stunts/preview-ctl.js).
// The controller has no DOM or three.js dependencies, so its whole contract runs under plain Node:
//   node stunts/tools/test-preview-ctl.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'preview-ctl.js'), 'utf8');
// (the file is a browser IIFE on globalThis; evaluate it in this realm and grab the class)
const root = {};
new Function('root', src.replace('typeof window !== \'undefined\' ? window : globalThis', 'root'))(root);
const Ctl = root.StuntsPreviewCtl;
assert.ok(Ctl, 'StuntsPreviewCtl is published');

// a typical track's world box, world units (1 tile = 1024; a 30-tile map is about 30720 across)
const BOX = { x0: -15360, x1: 15360, z0: -15360, z1: 15360, y1: 1200 };
const K = 1, F = 1 / Math.tan((54 * Math.PI / 180) / 2), EL0 = 0.19, SHIFT = -0.1, FRAMING = 0.96;
const frame = (c, t) => c.frame(t, BOX, K, F, EL0, SHIFT, FRAMING);
let n = 0;
const ok = name => { n++; console.log('  ok -', name); };

// 1. lifecycle: enter starts at the defaults; exit releases everything; re-entry inherits nothing
{
  const c = new Ctl();
  assert.equal(c.active, false, 'starts inactive');
  assert.equal(c.enter(0), true, 'enter reports the edge');
  assert.equal(c.enter(10), false, 'a second enter is not an edge');
  let a = frame(c, 100);
  assert.ok(a.dist > 0 && Math.abs(a.el - EL0) < 1e-9, 'enters at the default tilt and a real distance');
  assert.ok(Math.abs(a.az - (0.7 + 100 * 0.00008)) < 1e-12, 'the first heading is the default plus this frame\'s self-turn');

  // change heading, tilt and zoom, then leave and come back
  c.setPointer({ x: 0.5, y: 0.4, b: 1 });
  c.setPointer({ x: 0.8, y: 0.6, b: 1 });
  c.wheel(-1200);
  frame(c, 200);
  assert.ok(Math.abs(c.hovTo) > 0, 'drag changes the heading target');
  assert.notEqual(c.zoomTo, 1, 'wheel changes the zoom target');
  assert.equal(c.exit(), true, 'exit reports the edge');
  assert.equal(c.exit(), false, 'a second exit is not an edge');
  assert.equal(c.active, false); assert.equal(c.dragging, false); assert.equal(c.zoomTo, 1, 'exit resets zoom');
  assert.equal(c.hovTo, 0, 'exit resets the heading'); assert.equal(c.auto, 0, 'exit resets the self-turn');

  c.enter(300);
  const b = frame(c, 400);
  assert.ok(Math.abs(b.az - (0.7 + 100 * 0.00008)) < 1e-12, 're-entry is back at the default heading plus this frame\'s turn');
  assert.equal(b.el, EL0, 're-entry is back at the default tilt');
  assert.ok(Math.abs(b.dist - a.dist) < 1e-6, 're-entry is back at the default framing distance');
  ok('lifecycle: enter defaults, exit releases, re-entry inherits nothing');
}

// 2. a drag starts only while active and on the picture; release and cancel end it; it never crosses an exit
{
  const c = new Ctl();
  c.setPointer({ x: 0.5, y: 0.5, b: 1 });
  assert.equal(c.dragging, false, 'a press while inactive never starts a drag');
  c.enter(0);
  c.setPointer({ x: 0.5, y: 0.05, b: 1 });   // the title band
  assert.equal(c.dragging, false, 'a press in the title band does not start a drag');
  c.setPointer({ x: 0.5, y: 0.9, b: 1 });    // the buttons band
  assert.equal(c.dragging, false, 'a press in the buttons band does not start a drag');
  c.setPointer({ x: 0.5, y: 0.5, b: 1 });
  assert.equal(c.dragging, true, 'a press on the picture starts the drag');
  c.setPointer({ x: 0.7, y: 0.55, b: 1 });
  frame(c, 200);   // the drag's heading and tilt are applied on the next frame
  const hov = c.hovTo;
  assert.ok(hov < 0, 'rightward drag turns the heading');
  c.setPointer({ x: 0.7, y: 0.55, b: 0 });   // button up
  assert.equal(c.dragging, false, 'letting go ends the drag');
  // press again, then cancel (pointercancel / window blur)
  c.setPointer({ x: 0.4, y: 0.5, b: 1 }); c.setPointer({ x: 0.3, y: 0.4, b: 1 });
  assert.equal(c.dragging, true);
  c.release();
  assert.equal(c.dragging, false, 'release() ends the drag without leaving the visit');
  assert.equal(c.active, true, 'release keeps the visit alive');
  // a drag in flight is dropped by exit()
  c.setPointer({ x: 0.4, y: 0.5, b: 1 });
  assert.equal(c.dragging, true);
  c.exit();
  assert.equal(c.dragging, false, 'exit drops an in-flight drag');
  assert.equal(c.hovTo, 0, 'exit discards the drag heading');
  c.enter(500);
  c.setPointer(null);   // the pointer leaving the window
  assert.equal(c.dragging, false, 'a null pointer cannot be a drag');
  ok('drag: only on the visible picture; up / cancel / exit all end it');
}

// 3. wheel zoom is clamped on both ends and refused entirely while inactive
{
  const c = new Ctl();
  assert.equal(c.wheel(-1000), false, 'the wheel does nothing before enter()');
  c.enter(0);
  for (let i = 0; i < 200; i++) c.wheel(-100);   // zoom in hard
  assert.ok(c.zoomTo >= Ctl.ZOOM_MIN - 1e-12 && c.zoomTo < 0.4, 'zoom-in stops at the near limit, never near zero');
  assert.equal(c.zoomTo, Ctl.ZOOM_MIN, 'the near limit is the declared ZOOM_MIN');
  for (let i = 0; i < 200; i++) c.wheel(100);    // zoom out hard
  assert.equal(c.zoomTo, Ctl.ZOOM_MAX, 'zoom-out stops at the far limit, never to nothing');
  c.exit();
  assert.equal(c.wheel(-100), false, 'the wheel does nothing after exit()');
  c.enter(10);
  assert.equal(c.zoomTo, 1, 'a new visit starts at the default zoom, not the old limit');
  ok('wheel: clamped near/far, inactive visits ignore it, fresh visit resets it');
}

// 4. the geometry-aware distance never enters the track and eases instead of jumping
{
  const c = new Ctl(); c.enter(0);
  for (let i = 0; i < 60; i++) c.wheel(-100);
  const f = frame(c, 1000);
  const cx = (BOX.x0 + BOX.x1) / 2, cz = (BOX.z0 + BOX.z1) / 2;
  const horiz = Math.hypot(f.cx + Math.sin(f.az) * Math.cos(f.el) * f.dist - cx,
                           f.cz + Math.cos(f.az) * Math.cos(f.el) * f.dist - cz);
  const eyeY = BOX.y1 * 0.5 + Math.sin(f.el) * f.dist;
  const groundR = Math.hypot(BOX.x1 - cx, BOX.z1 - cz) * 1.08;
  assert.ok(horiz >= groundR * 0.999, 'the closest camera stays outside the map\'s ground extent');
  assert.ok(eyeY >= BOX.y1 + 250 - 1e-6, 'the closest camera stays above the highest track piece');
  assert.ok(f.dist >= 600, 'the closest camera keeps a real viewing distance (near plane)');

  // the eased zoom moves toward the target, it never teleports
  const c2 = new Ctl(); c2.enter(0); c2.wheel(-600);
  const f1 = c2.frame(16, BOX, K, F, EL0, SHIFT, FRAMING);
  const f2 = c2.frame(32, BOX, K, F, EL0, SHIFT, FRAMING);
  assert.ok(f2.dist < f1.dist, 'zoom-in eases the distance inward over frames');
  assert.ok(f1.dist - f2.dist < f1.dist, 'the first eased step is partial, not a jump');
  ok('zoom distance: outside the map, above the track, eased not jumped');
}

// 5. self-turn runs only while not dragging and resets with the lifecycle
{
  const c = new Ctl(); c.enter(0);
  const f0 = frame(c, 100);
  const f1 = frame(c, 1100);   // one second of self-turn
  assert.ok(f1.az > f0.az, 'it turns on its own when left alone');
  c.setPointer({ x: 0.5, y: 0.5, b: 1 });
  const a0 = frame(c, 1200).az;
  const a1 = frame(c, 2200).az;   // a second held: no self-turn added
  assert.ok(Math.abs(a1 - a0) < 1e-9, 'the self-turn stops while held');
  c.setPointer({ x: 0.5, y: 0.5, b: 0 });
  const a2 = frame(c, 2300).az;
  assert.ok(frame(c, 3300).az > a2, 'the self-turn resumes after release');
  c.exit(); c.enter(4000);
  assert.ok(Math.abs(frame(c, 4100).az - (0.7 + 100 * 0.00008)) < 1e-12, 'the self-turn does not carry into a new visit');
  ok('self-turn: runs when free, stops while held, resets per visit');
}

// 6. tilt is clamped to its band however hard the drag pulls
{
  const c = new Ctl(); c.enter(0);
  c.setPointer({ x: 0.5, y: 0.5, b: 1 });
  for (let i = 0; i < 50; i++) c.setPointer({ x: 0.5, y: 0.01, b: 1 });
  frame(c, 100);
  assert.ok(c.elTo <= Ctl.TILT_MAX + 1e-12, 'tilt never goes past the top of its band');
  for (let i = 0; i < 50; i++) c.setPointer({ x: 0.5, y: 0.99, b: 1 });
  frame(c, 200);
  assert.ok(c.elTo >= Ctl.TILT_MIN - 1e-12, 'tilt never goes below the bottom of its band');
  ok('tilt: clamped to the declared band');
}

// 7. frame() is null outside a visit, so the renderer cannot orbit a hidden overview
{
  const c = new Ctl();
  assert.equal(c.frame(0, BOX, K, F, EL0, SHIFT, FRAMING), null, 'no frame before enter()');
  c.enter(0); assert.ok(c.frame(10, BOX, K, F, EL0, SHIFT, FRAMING), 'a frame during the visit');
  c.exit();
  assert.equal(c.frame(20, BOX, K, F, EL0, SHIFT, FRAMING), null, 'no frame after exit()');
  ok('frame(): only produced during a live visit');
}

console.log(`\nAll ${n} preview-ctl test groups passed.`);
