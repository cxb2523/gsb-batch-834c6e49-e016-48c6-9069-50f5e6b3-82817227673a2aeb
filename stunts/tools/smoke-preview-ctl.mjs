// Browser-realm smoke test without a browser: load preview-ctl.js the way index.html does (a classic
// script whose IIFE attaches to the global), then exercise the contract through that global binding.
// Run: node stunts/tools/smoke-preview-ctl.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'preview-ctl.js'), 'utf8');

// a minimal browser-like realm: the IIFE's root expression resolves to this global object
const realm = vm.createContext({ console });
vm.runInContext(src, realm, { filename: 'preview-ctl.js' });
const C = realm.StuntsPreviewCtl;
assert.ok(C, 'the classic script publishes StuntsPreviewCtl on the global (as index.html relies on)');

const c = new C();
assert.equal(c.active, false);
assert.equal(c.wheel(-100), false, 'wheel ignored while not on screen');
c.enter(1000);
const B = { x0: -15360, x1: 15360, z0: -15360, z1: 15360, y1: 1200 };
const f = 1 / Math.tan((54 * Math.PI / 180) / 2);
const fr = c.frame(1100, B, 1, f, 0.19, -0.1, 0.96);
assert.ok(fr && fr.dist > 0 && Math.abs(fr.el - 0.19) < 1e-12, 'default framing on enter');
c.setPointer({ x: 0.5, y: 0.5, b: 1 });
c.setPointer({ x: 0.75, y: 0.6, b: 1 });
c.frame(1200, B, 1, f, 0.19, -0.1, 0.96);
assert.ok(c.hovTo < 0 && c.dragging, 'drag turns the view while visible');
for (let i = 0; i < 100; i++) c.wheel(-100);
assert.equal(c.zoomTo, C.ZOOM_MIN, 'wheel zoom is clamped');
c.exit();
assert.equal(c.active, false);
assert.equal(c.dragging, false);
assert.equal(c.zoomTo, 1, 'exit restores the default zoom');
assert.equal(c.frame(1300, B, 1, f, 0.19, -0.1, 0.96), null, 'no camera frames after exit');
c.enter(2000);
const fr2 = c.frame(2100, B, 1, f, 0.19, -0.1, 0.96);
assert.ok(Math.abs(fr2.el - 0.19) < 1e-12 && Math.abs(fr2.az - (0.7 + 100 * 0.00008)) < 1e-12, 're-entry starts from defaults');
console.log('smoke: preview-ctl.js loads as a classic browser script and its full contract holds');
