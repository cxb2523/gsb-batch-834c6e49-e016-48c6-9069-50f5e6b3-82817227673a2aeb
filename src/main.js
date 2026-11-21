import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { World } from './core/world.js';
import { bus, EV } from './core/events.js';

import materials from './gen/materials.js';
import sky       from './render/sky.js';
import level     from './world/level.js';
import props     from './world/props.js';
import physics   from './core/physics.js';
import player    from './entity/player.js';
import combat    from './combat/combat.js';
import vfx       from './combat/vfx.js';
import ai        from './game/ai.js';
import loot      from './game/loot.js';
import camera    from './render/camera.js';
import pipeline  from './render/pipeline.js';
import lightcull from './render/lightcull.js';
import perfadapt from './render/perfadapt.js';
import hud       from './ui/hud.js';
import audio     from './audio/audio.js';

const boot = document.getElementById('boot');
const bar = boot.querySelector('.bar i');
const msg = boot.querySelector('[data-boot-msg]');
bus.on(EV.BOOT_PROGRESS, ({ frac, msg: m }) => {
  bar.style.width = `${Math.round(frac * 100)}%`;
  if (m) msg.textContent = m.replace(/[-_]/g, ' ');
});

const canvas = document.getElementById('viewport');
Input.attach(canvas);

const engine = new Engine(canvas);
engine
  .use(materials)   // procedural texture/material library — everything else depends on it
  .use(sky)         // atmosphere, sun/moon, IBL environment
  .use(level)       // terrain + modular dungeon geometry
  .use(props)       // instanced clutter, decals, destructibles
  .use(physics)     // capsule collision, rigid bodies, ragdolls
  .use(player)      // rig, animation, locomotion
  .use(combat)      // skills, damage, hit resolution
  .use(vfx)         // particles, trails, impact FX
  .use(ai)          // enemy brains + encounter director
  .use(loot)        // drops, rarity, pickup
  .use(camera)      // isometric follow cam
  .use(pipeline)    // post stack — LAST so it sees the finished scene
  .use(hud)         // HUD, inventory, tooltips
  .use(audio);      // procedural music + sfx

// End-of-frame input edge clear must run after every system has read it.
// The point-light cull MUST run after every system that moves or shows a light
// (props' brazier pool, combat flashes, projectiles, vfx emitters) and before the
// composer renders — engine._loop() renders after every system's frame(), so last
// in this list is correct. Culling from a separate rAF callback instead let props
// reassign lights afterwards and frames reached the renderer at a light count the
// culler never chose (measured: 18 AND 23 both rendering).
engine.systems.push({ name: 'input-flush', frame: () => Input.endFrame() });
engine.use(lightcull);
// PerfAdapt registers AFTER lightcull on purpose: its frame() sets the adaptive
// ceiling through World.lightCull, and the cull reads that ceiling later in the
// same frame list — so a cap change takes effect the very next cull, one frame
// after the policy decision. It never touches light visibility itself.
engine.use(perfadapt);

engine.boot().then(() => {
  // Compile every light-count rung while the loading curtain is still up. Three.js
  // keys its program cache on the light count, and a cold rung costs SECONDS to
  // link on first use (measured: worst frame 4,295 ms mid-walk). Paying it here
  // costs ~0.65 s of boot and makes rung changes free: 64 consecutive rung swaps
  // measured a 30.7 ms worst frame afterwards, with zero frames over 50 ms.
  const pw = World.lightCull?.prewarm?.();
  if (pw) console.info(`[lightcull] prewarmed rungs ${pw.rungs.join('/')} in ${pw.ms}ms (${pw.programs} programs)`);
  window.__EXILIUM_READY = true;
  setTimeout(() => {
    boot.classList.add('done');
    // Remove the node rather than relying on the opacity transition alone: a
    // dropped transitionend (headless, background tab, reduced-motion) would
    // otherwise leave a full-screen curtain over a live game forever.
    const kill = () => boot.remove();
    boot.addEventListener('transitionend', kill, { once: true });
    setTimeout(kill, 1400);
  }, 260);
}).catch((e) => {
  console.error(e);
  msg.textContent = 'boot failed — see console';
  window.__EXILIUM_ERROR = String(e && e.stack || e);
});

window.__ENGINE = engine;
// Console/F3 debug handles onto the existing blackboards — no new singletons, just
// named access to objects the systems already publish. From DevTools:
//   World.perfAdapt.stats          // adaptive level, rung, AO tier, ambient, streaks
//   World.lightCull.stats          // shown/inFrustum, droppedInFrustum, droppedByAdapt
//   World.lightCull.capRung        // null when the adaptive ceiling is lifted
//   World.perfAdapt.setEnabled(false) // manual off: restores initial lighting
import * as THREE_NS from 'three';
window.World = World;
window.THREE = THREE_NS;
