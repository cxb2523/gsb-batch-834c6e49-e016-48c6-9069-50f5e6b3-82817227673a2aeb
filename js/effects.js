// js/effects.js: explosions, missile smoke trails and muzzle flashes ("hit feel").
//
// Three instanced meshes hold every particle (fire, debris, smoke), each with a fixed number of slots that are
// reused, so a long run never creates new 3D objects (individual meshes that were never freed once crashed phones,
// see enemies.js TEMPLATES). Fire goes from bright orange to dark red as it shrinks (normal blending: additive fire
// turned white against the bright sky); debris and smoke shrink away.
//
// Graphics quality (quality.js) is read live, at spawn time, from the one shared Quality state — sky.js reads the
// same state. High adds smoke to explosions, more debris and denser missile trails. A drop in the middle of a
// flight therefore stops new smoke/extra debris/trails immediately, while particles already in the air simply live
// out their (short) lives; choosing High again gives the next explosion the full look. Nothing here is rebuilt on a
// quality change: the three InstancedMeshes and their capacities are created once (see stats()).
//
// Kept modest on purpose: no white flash, small short fireballs, and a steady muzzle glow instead of a flicker at the
// fire rate (11 a second). Bright flashes, and anything flashing more than 3 times a second, can trigger
// photosensitive epilepsy, and big explosions also hide the fight.

import * as THREE from 'three';
import { Quality } from './quality.js';

const CAP = { fire: 128, debris: 220, smoke: 200 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _axis = new THREE.Vector3(), _c = new THREE.Color();
const R = Math.random;                         // only looks: never part of the simulation (rand.js)
const rnd = (a, b) => a + R() * (b - a);
function randomDir(v) { do { v.set(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1); } while (v.lengthSq() > 1 || v.lengthSq() < 0.01); return v.normalize(); }

export class Effects {
  constructor(scene) {
    this.scene = scene;
    const pool = (geo, mat, n) => {
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      mesh.count = 0;
      mesh.frustumCulled = false;
      if (mesh.instanceMatrix.setUsage) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (mesh.setColorAt) mesh.setColorAt(0, _c.setRGB(1, 1, 1));      // makes instanceColor exist
      scene.add(mesh);
      return { mesh, list: [], cap: n };
    };
    this.fire = pool(new THREE.OctahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }), CAP.fire);
    this.debris = pool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), CAP.debris);
    this.smoke = pool(new THREE.OctahedronGeometry(1, 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }), CAP.smoke);
    this.trailT = new WeakMap();
  }

  add(pool, p) {
    if (pool.list.length >= pool.cap) pool.list.shift();          // full: the oldest particle makes room
    pool.list.push(p);
  }
  particle(pos, vel, s0, s1, life, rgb, extra = {}) {
    return { p: pos.clone(), v: vel.clone(), s0, s1, life, t: 0, rgb, grav: 0, drag: 0, spin: 0, ax: null, ...extra };
  }

  // an explosion: size 1 = a fighter, 2 = a bomber or a plane like yours, 3 = a boss; vel = what it was flying at
  boom(pos, size = 1, vel = null) {
    const hi = Quality.high, v0 = vel ? vel.clone().multiplyScalar(0.35) : new THREE.Vector3();
    const v = new THREE.Vector3(), o = new THREE.Vector3();
    // fireballs (no white flash: see the top of this file)
    const nf = Math.round((hi ? 5 : 3) + size);
    for (let i = 0; i < nf; i++) {
      randomDir(o).multiplyScalar(rnd(0, 7 * size));
      randomDir(v).multiplyScalar(rnd(8, 30) * size).add(v0);
      this.add(this.fire, this.particle(o.add(pos), v, rnd(1.5, 3) * size, rnd(5, 8) * size, rnd(0.35, 0.65),
        [1, rnd(0.55, 0.75), rnd(0.15, 0.3)], { drag: 1.5 }));
    }
    // debris: dark chunks thrown out, falling and tumbling
    const nd = Math.round((hi ? 14 : 8) * Math.min(size, 2.5));
    for (let i = 0; i < nd; i++) {
      randomDir(v).multiplyScalar(rnd(50, 150) * Math.sqrt(size)).add(v0);
      const g = rnd(0.16, 0.34);
      this.add(this.debris, this.particle(pos, v, rnd(1.4, 3) * Math.min(size, 2), 0.2, rnd(1.1, 2.0), [g, g * 0.9, g * 0.8],
        { grav: 150, drag: 0.4, spin: rnd(4, 12), ax: randomDir(new THREE.Vector3()) }));
    }
    // smoke (high quality): a slow dark cloud rising where it happened
    if (hi) {
      for (let i = 0; i < 4 + 2 * size; i++) {
        randomDir(o).multiplyScalar(rnd(0, 6 * size));
        v.set(rnd(-6, 6), rnd(10, 24), rnd(-6, 6)).add(v0.clone().multiplyScalar(0.3));
        const g = rnd(0.16, 0.3);
        this.add(this.smoke, this.particle(o.add(pos), v, rnd(2.5, 4) * size, rnd(9, 14) * size, rnd(1.6, 2.6), [g, g, g], { drag: 0.6 }));
      }
    }
  }

  // muzzle flashes at a plane's cannons (plane-local mounts)
  muzzle(plane, mounts) {
    for (const m of mounts) {
      const p = new THREE.Vector3(m.x, m.y, m.z - 4).applyQuaternion(plane.quat).add(plane.pos);
      // lives longer than the time between shots (0.09 s), so firing shows a steady glow, not a flicker
      this.add(this.fire, this.particle(p, plane.forward().multiplyScalar(plane.speed), 1.6, 2.2, 0.13, [1, 0.8, 0.45], { flash: true }));
    }
  }

  update(dt, weapons = null) {
    // smoke trails behind missiles (yours, and other players' in versus): they also show where a missile is coming from.
    // Read the level once per frame: a quality change takes effect on the next trail puff, not at the next rebuild.
    if (weapons) {
      const hi = Quality.high, every = hi ? 0.03 : 0.06, life = hi ? 0.9 : 0.55;
      for (const list of [weapons.missiles, weapons.pvpMissiles]) {
        for (const m of list) {
          const t = (this.trailT.get(m) || 0) + dt;
          if (t < every) { this.trailT.set(m, t); continue; }
          this.trailT.set(m, 0);
          const back = m.dir ? m.pos.clone().addScaledVector(m.dir, -5) : m.pos;
          this.add(this.smoke, this.particle(back, _s.set(rnd(-3, 3), rnd(-1, 4), rnd(-3, 3)), 1.4, 5.5, life, [0.82, 0.82, 0.85], { drag: 2 }));
        }
      }
    }
    for (const pool of [this.fire, this.debris, this.smoke]) this.step(pool, dt);
  }

  step(pool, dt) {
    const L = pool.list;
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      a.t += dt;
      if (a.t >= a.life) continue;
      if (a.grav) a.v.y -= a.grav * dt;
      if (a.drag) a.v.multiplyScalar(Math.max(0, 1 - a.drag * dt));
      a.p.addScaledVector(a.v, dt);
      L[w++] = a;
    }
    L.length = w;
    const mesh = pool.mesh, fire = pool === this.fire;
    for (let i = 0; i < w; i++) {
      const a = L[i], k = a.t / a.life;
      // fire swells fast then shrinks; the rest go from s0 to s1
      const s = fire && !a.flash ? a.s1 * Math.sin(Math.PI * Math.min(1, Math.sqrt(k) * 0.9 + 0.05)) + a.s0 * (1 - k)
        : a.s0 + (a.s1 - a.s0) * (fire ? Math.sqrt(k) : k);
      if (a.ax) _q.setFromAxisAngle(a.ax, a.spin * a.t); else _q.identity();
      _m.compose(a.p, _q, _s.set(s, s, s));
      mesh.setMatrixAt(i, _m);
      if (mesh.setColorAt) {
        if (fire && !a.flash) {                               // bright orange -> dark red
          const f = Math.min(1, k * 1.3);
          mesh.setColorAt(i, _c.setRGB(a.rgb[0] * (1 - 0.55 * f), a.rgb[1] * (1 - 0.85 * f), a.rgb[2] * (1 - 0.8 * f)));
        } else mesh.setColorAt(i, _c.setRGB(a.rgb[0], a.rgb[1], a.rgb[2]));
      }
    }
    mesh.count = w;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // A new run, back to the hangar, or into an AI Ladder level: no particle (or a missile trail clock) may survive
  // into the next run — leftover smoke would otherwise look like the new run's missiles are already smoking.
  clear() {
    for (const pool of [this.fire, this.debris, this.smoke]) { pool.list.length = 0; pool.mesh.count = 0; }
    this.trailT = new WeakMap();       // every trail timer starts at zero for the next run's missiles
  }

  // Debug/test view of the pools (__sb.effects.stats()): each InstancedMesh is built once with `cap` slots; `live`
  // is what the particle lists hold and `drawn` is what the mesh renders after the last step. Invariants:
  // cap === instances (the buffer was allocated once) and drawn === live <= cap.
  stats() {
    const one = p => ({ cap: p.cap, live: p.list.length, drawn: p.mesh.count, instances: p.mesh.instanceMatrix.count });
    return { level: Quality.level, fire: one(this.fire), debris: one(this.debris), smoke: one(this.smoke) };
  }
}
