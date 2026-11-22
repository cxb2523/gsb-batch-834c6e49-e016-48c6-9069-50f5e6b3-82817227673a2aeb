// Headless checks for the shared graphics-quality state and the effect pools (js/quality.js, js/effects.js).
//
//   node tools/check-quality.cjs
//
// No browser and no game server: it copies the pure-ESM modules into a temp folder, points their bare 'three'
// import at a local copy of three.js (downloaded from the CDN on first use, or passed as an argument), and drives
// Quality and Effects directly. It checks the things a build can silently break:
//   - Auto only ever judges real flight frames (pause menu, countdown, results screen and background time excluded);
//   - the first frame after a gap is not mistaken for a slow frame;
//   - a genuinely slow flight drops Auto to Low exactly once, and the readout names the level in force;
//   - explosions and missile trails follow that same level at spawn time (smoke and extra debris only on High);
//   - a drop never deletes existing particles (they decay on their own), and High again restores the full look;
//   - no quality switch rebuilds or leaks an InstancedMesh, and pool capacity always equals the instance count;
//   - effects.clear() empties the pools and resets the missile-trail timers.
//
//   node tools/check-quality.cjs path/to/three.module.js     (skip the download)
const fs = require('fs');
const path = require('path');
const os = require('os');

const repo = path.resolve(__dirname, '..');
const THREE_VERSION = '0.169.0';

let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}${!cond && extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};

async function threeSource(arg) {
  if (arg) return fs.readFileSync(arg, 'utf8');
  const cached = path.join(os.tmpdir(), `three-${THREE_VERSION}.module.js`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  console.log(`(downloading three.js ${THREE_VERSION} once...)`);
  const r = await fetch(`https://unpkg.com/three@${THREE_VERSION}/build/three.module.js`);
  if (!r.ok) throw new Error(`could not download three.js: HTTP ${r.status}`);
  const src = await r.text();
  fs.writeFileSync(cached, src);
  return src;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quality-'));
  const url = f => 'file:///' + path.join(tmp, f).replace(/\\/g, '/');
  try {
    fs.writeFileSync(path.join(tmp, 'three.module.js'), await threeSource(process.argv[2]));
    for (const f of ['quality.js', 'save.js', 'blueprint.js', 'parts.js', 'effects.js']) {
      const src = fs.readFileSync(path.join(repo, 'js', f), 'utf8')
        .replace(/from 'three'/g, `from ${JSON.stringify(url('three.module.js'))}`);
      fs.writeFileSync(path.join(tmp, f), src);
    }

    const THREE = await import(url('three.module.js'));
    const { Quality } = await import(url('quality.js'));
    const { Save } = await import(url('save.js'));
    const { Effects } = await import(url('effects.js'));

    /* ---------------- Quality: which frames may be judged ---------------- */
    const reset = s => {
      Save.data.quality = s; Save.data.qualityAuto = null;
      Quality.listeners = []; Quality.resetSampling(); Quality.last = null;
    };
    const feed = (n, ms, eligible = true) => { for (let i = 0; i < n; i++) Quality.sample(ms, eligible); };

    reset('auto');
    feed(481, 1000 / 60);                        // resetSampling drops one frame, then 3 s warm-up + 5 s window
    ok(Quality.level === 'high', 'a 60 fps flight keeps Auto on High', Quality.readout());
    ok(Quality.last && Quality.last.fps >= 55, 'the readout shows the measured frame rate', JSON.stringify(Quality.last));

    reset('auto');
    let changed = 0;
    Quality.onChange(() => changed++);
    for (let i = 0; i < 500; i++) { feed(1, 1000 / 60); Quality.sample(15000, false); }
    ok(changed === 0 && Quality.level === 'high', 'paused / results / hidden frames never cause a drop');
    ok(Quality.frames.length === 0 || Quality.frames.every(f => f < 1000), 'no pause length ever enters the window');

    reset('auto');
    Quality.sample(16.7, true);                  // first frame after reset: a marker, not a sample
    Quality.sample(3000, true);                  // would be a terrible "frame" if it were counted
    Quality.interrupt();
    Quality.sample(16.7, true);                  // first frame back: dropped because of the gap
    ok(Quality.last === null && Quality.frames.length === 0, 'no sample is taken from the frame that spans a gap',
      JSON.stringify({ last: Quality.last, frames: Quality.frames.length }));

    reset('auto');
    let emits = 0;
    Quality.onChange(() => emits++);
    for (let i = 0; i < 2000 && Quality.level === 'high'; i++) Quality.sample(40, true);   // 25 fps
    ok(Quality.level === 'low', 'Auto drops to Low on a 25 fps flight');
    ok(Quality.last && Quality.last.fps < 45, 'the readout keeps the measurement that caused the drop', JSON.stringify(Quality.last));
    ok(emits === 1, 'exactly one change event per drop', String(emits));
    ok(/Graphics: Auto \(Low\)/.test(Quality.readout()), 'the pause readout names the level in force, not the saved setting', Quality.readout());
    ok(Quality.setting() === 'auto' && Quality.effective === 'low', 'the setting stays Auto; the effective level is Low');

    /* ---------------- Effects: pools, spawn rules, lifecycle ---------------- */
    const scene = new THREE.Scene();
    const fx = new Effects(scene);
    const pos = new THREE.Vector3(0, 500, 0);
    const spawn = (size = 2) => { fx.boom(pos, size); return { fire: fx.fire.list.length, debris: fx.debris.list.length, smoke: fx.smoke.list.length }; };
    const instanced = () => scene.children.filter(o => o.isInstancedMesh).length;
    const setLevel = l => { Save.data.quality = l; Save.data.qualityAuto = null; };

    const s0 = fx.stats();
    ok(s0.fire.instances === s0.fire.cap && s0.debris.instances === s0.debris.cap && s0.smoke.instances === s0.smoke.cap,
      'each InstancedMesh allocates exactly its pool capacity', JSON.stringify(s0));
    const meshes0 = instanced();

    setLevel('high'); fx.clear();
    const hi = spawn();
    ok(hi.smoke > 0, 'a High explosion emits smoke', JSON.stringify(hi));
    ok(hi.debris === Math.round(14 * 2), 'a High explosion emits the full debris count', JSON.stringify(hi));

    setLevel('low'); fx.clear();
    const lo = spawn();
    ok(lo.smoke === 0, 'a Low explosion emits no smoke', JSON.stringify(lo));
    ok(lo.debris < hi.debris, 'a Low explosion emits fewer debris', `${lo.debris} vs ${hi.debris}`);

    for (let i = 0; i < 30; i++) { setLevel(i % 2 ? 'low' : 'high'); spawn(1); fx.update(0.016); }
    const s1 = fx.stats();
    ok(instanced() === meshes0 && meshes0 === 3, 'quality switching never adds or removes InstancedMeshes', `now ${instanced()}, was ${meshes0}`);
    ok(s1.fire.instances === s1.fire.cap && s1.debris.instances === s1.debris.cap && s1.smoke.instances === s1.smoke.cap,
      'capacity still equals the allocated instance count', JSON.stringify(s1));
    ok(s1.fire.drawn === s1.fire.live && s1.debris.drawn === s1.debris.live && s1.smoke.drawn === s1.smoke.live,
      'the drawn count tracks live particles exactly', JSON.stringify(s1));
    ok(s1.fire.live <= s1.fire.cap && s1.debris.live <= s1.debris.cap && s1.smoke.live <= s1.smoke.cap,
      'live particles never exceed capacity');

    setLevel('high'); fx.clear();
    for (let i = 0; i < 40; i++) spawn(3);
    fx.update(0.016);
    const s2 = fx.stats();
    ok(s2.fire.live === s2.fire.cap && s2.debris.live === s2.debris.cap && s2.smoke.live === s2.smoke.cap,
      'a full pool recycles its oldest slots instead of growing', JSON.stringify(s2));

    setLevel('high'); fx.clear(); spawn(2);
    const before = fx.smoke.list.length;
    ok(before > 0, 'High smoke exists before the drop');
    setLevel('low');
    fx.update(0.05, null);
    ok(fx.smoke.list.length === before, 'a drop does not delete particles already in the air',
      `${fx.smoke.list.length} after, ${before} before`);
    for (let i = 0; i < 200; i++) fx.update(0.05, null);
    ok(fx.smoke.list.length === 0 && fx.smoke.mesh.count === 0, 'existing smoke decays away naturally');

    reset('auto');                                // Auto, never measured slow -> High
    fx.clear();
    const again = spawn();
    ok(again.smoke > 0 && again.debris === hi.debris, 'switching back to High restores the full explosion', JSON.stringify(again));

    /* ---------------- Missile trails: timers reset by clear() ---------------- */
    const mkMissile = () => ({ pos: pos.clone(), dir: new THREE.Vector3(0, 0, 1) });
    const weapons = { missiles: [mkMissile()], pvpMissiles: [] };

    setLevel('high'); fx.clear();
    fx.update(0.02, weapons);
    ok(fx.smoke.list.length === 0, 'no trail puff before the emit interval');
    fx.clear();                                   // restart / hangar / new ladder round
    ok(fx.stats().smoke.live === 0, 'clear() empties every pool');
    fx.update(0.01, weapons);
    ok(fx.smoke.list.length === 0, 'clear() resets the old trail timer too (0.01 s is not yet due)');
    fx.update(0.02, weapons);                     // 0.03 s since the reset -> due on High
    ok(fx.smoke.list.length === 1, 'trails restart from zero for the next run', `puffs=${fx.smoke.list.length}`);

    setLevel('low'); fx.clear();
    fx.update(0.03, weapons);
    ok(fx.smoke.list.length === 0, 'on Low, trails use the slower interval (0.03 s is not yet due)');
    fx.update(0.03, weapons);
    ok(fx.smoke.list.length === 1, 'on Low, a trail puff is emitted at 0.06 s', `puffs=${fx.smoke.list.length}`);

    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
