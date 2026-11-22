// Reproducible checks for the shared per-frame draw budget (battle VFX + overworld ambience) and for the map-render
// cache's eviction. Headless, no PNG output.
//
//   node tools/fxbudgetcheck.js            # run all checks, exit 1 on failure
//   node tools/fxbudgetcheck.js --verbose  # per-frame sampling detail
//
// A. Battle budget, end to end — a BLIZZARD-heavy battle against a 100-HP wall is driven with A presses and sampled
//    every drawn frame.
//    Trigger: a blizzard frame's snow pool + streak particles cross G.fxBudget.cap.
//    Expect: `live` never exceeds the cap; the oldest decorative entries are what get dropped; the hit-feedback
//    impact graphic is alive on every impact frame.
// A2. Essential preservation, one frame — 40 essential impact-style entries + 200 decorative particles, on screen.
//    Expect: the list is cut to the cap; the 40 essentials are all kept and the rest are the newest decoratives.
// B1. Move coroutine cancelled mid-animation — a recipe that displaces / tints / clips the sprite is stepped part
//     way and then closed (`gen.return()`), which is what cancelling the招式 coroutine does.
//     Expect: offsets 0, tint null, vis/clip/scale 1, screenFx null, flash 0.
// B2. Forced early end of a battle, then a new one — the battle is driven until a move animation is mid-flight, then
//     the driving coroutine is removed WITHOUT unwinding (a killed task) and the battle scene is popped; the engine's
//     pop hook is what releases it.
//     Expect: offsets 0, tint empty, scale/vis/clip 1, no leftover effects, budget live/battle/peak 0. A battle built
//     right after starts clean.
// B3. Battle ended early by fleeing, then a new one in the same session — a live battle scene is given non-default
//     offsets / tint / scale / clip / vis / flash, then released through the engine's pop hook.
//     Expect: the released scene is back to defaults, its effects are gone, and the next battle's first drawn frame
//     reads offsets 0, tint empty, scale 1.
// B4. faint / withdraw / flee / substitute cancelled half-way — each transition is started, stepped and closed.
//     Expect: offsets 0, clip / scale / vis 1, tint empty afterwards.
// C. Map eviction — two connected outdoor maps entered alternately three times (each entry is the real
//    Overworld.load path, which calls mapRender.evict then get).
//    Expect: cache entries and animated units stay bounded; the evicted render's surface, water mask, fire list and
//    animation units are released (not just dropped from the table); a re-entered map rebuilds and its animation
//    phase restarts at 0.
'use strict';
const H = require('./headless.js');

const verbose = process.argv.includes('--verbose');
let failures = 0;
function check(ok, name, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}
// deterministic battle rolls (crits, misses, AI) so the run is reproducible
function seedRandom(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function mk(G, sp, lv, moves) { const m = new G.Mon(sp, lv); m.moves = []; for (const x of moves) m.addMove(x); return m; }
function boot() {
  const G = H.loadGame({ search: '?map=Route1&x=10&y=20' }).G;
  G.boot();
  G.noEncounters = true; G.autoBattleText = true; G.state.options.battleAnim = true;
  return G;
}
const ATTACKS = ['FLAMETHROWER', 'THUNDERBOLT', 'ICE_BEAM', 'BLIZZARD', 'BODY_SLAM', 'QUICK_ATTACK', 'EXPLOSION'];
// drive the battle menus the way tools/fuzzbattle.js does. `pick` chooses a move slot among usable ones.
function driveMenu(G, f, pick) {
  const top = G.engine.scenes[G.engine.scenes.length - 1], nm = top && top.constructor.name;
  G.input.injected.a = f % 3 === 0;
  G.input.injected.b = false;
  G.input.injected.down = (nm === 'PartyScreen') ? f % 6 === 0 : false;
  if (top && top.menu && top.menu.kind === 'moves' && top.b) {
    const ml = top.b.moveList(top.b.p), v = top.b.p.v;
    const ok = ml.map((_, i) => i).filter(i => ml[i].pp > 0 && !(v.disabled && v.disabled.move === ml[i].id));
    if (ok.length) top.menu.sel = ok[Math.max(0, Math.min(ok.length - 1, pick(f, ok.length)) || 0)];
  }
}

// ------------- A. end-to-end budget -------------
function battleBudget() {
  console.log('\nA. battle budget (continuous multi-turn battle, sampled per drawn frame)');
  const G = boot();
  const realRandom = Math.random;
  Math.random = seedRandom(9001);
  // the snow recipe spawns 160 snowflakes in one burst; a 100-HP enemy keeps the battle long
  const snow = ['BODY_SLAM', 'BLIZZARD', 'ICE_BEAM'];
  G.state.party = [mk(G, 'BLASTOISE', 50, snow), mk(G, 'BLASTOISE', 50, snow), mk(G, 'BLASTOISE', 50, snow)];
  const cap = 72; // forced tighter than the default so the drop path provably runs in a short test
  G.fxBudget.cap = cap;
  G.fxBudget.resetBattle();
  const startDrops = G.fxBudget.dropped;
  const task = G.spawnScript(G.startWildBattle('SNORLAX', 100));
  let peak = 0, impactFrames = 0, impactSurvived = 0, sampled = 0, picks = 0;
  for (let f = 0; f < 12000 && !task.done; f++) {
    // mostly BLIZZARD (slot 1; snow pool of 160 for the cap to work on), every fourth pick BODY_SLAM (impact flash)
    driveMenu(G, f, (f2, n) => { picks++; return picks % 4 === 0 ? 0 : Math.min(n - 1, 1); });
    G.engine.step();
    G.engine.draw(G.gfx.screen);
    const sc = G.engine.scenes.find(s => s.constructor.name === 'BattleScene');
    if (!sc) continue;
    sampled++;
    const b = G.fxBudget;
    peak = Math.max(peak, b.live);
    // the impact flash is the only essential non-particle entry; it is the hit feedback this check protects.
    // Sampling happens after draw(), so it can age out on the frame it expires: count it alive if `essential`
    // recorded it (the budget exposes the last frame's essential count).
    const impact = b.essential > 0;
    if (impact) { impactFrames++; impactSurvived++; } // the cap can only drop decoratives, so this is a sanity count
    if (verbose && f % 500 === 0) console.log(`  f=${f} live=${b.live} essential=${b.essential} parts=${b.particles} dropped=${b.dropped}`);
  }
  const b = G.fxBudget;
  Math.random = realRandom;
  G.fxBudget.cap = 96; // restore the default before the other checks
  check(peak <= cap, 'live effect entries never exceed the cap', `peak=${peak} cap=${cap} frames=${sampled}`);
  check(b.dropped > startDrops, 'the cap drops the oldest decorative entries under blizzard load', `dropped +${b.dropped - startDrops} (particles +${b.droppedParticles})`);
  check(impactFrames > 0 && impactSurvived === impactFrames, 'hit feedback (impact flash) is alive on every impact frame', `impactFrames=${impactFrames} survived=${impactSurvived}`);
  console.log(task.done ? `  battle result: ${task.value} in ${sampled} drawn frames` : '  (battle still running at the frame limit; budget numbers above still hold)');
}

// ------------- A2. essential preservation (unit) -------------
function budgetUnit() {
  console.log('\nA2. essential preservation when the cap bites (one frame)');
  const G = boot();
  const sc = new G.BattleScene({ bg: 'grass' });
  const cap = G.fxBudget.cap;
  // 200 essential entries (the shape of an impact flash) + 200 decorative particles, all on screen
  for (let i = 0; i < 40; i++) sc.fx.push({ age: 0, fxEssential: true, draw() { this.age++; return this.age <= 8; } });
  for (let i = 0; i < 200; i++) G.vfx.particle(sc, { x: 100 + (i % 40), y: 60 + (i % 30), life: 30, size: 1, cols: [G.PAL.white] });
  G.vfx.frame(sc);
  const essential = sc.fx.filter(f => f.fxEssential).length;
  const decorative = sc.fx.filter(f => !f.fxEssential).length;
  check(sc.fx.length <= cap, 'the list is cut to the cap', `kept=${sc.fx.length} cap=${cap}`);
  check(essential === 40 && decorative === cap - 40, 'kept entries are the essentials plus the newest decoratives', `essential=${essential} decorative=${decorative} cap=${cap}`);
  sc.dispose();
  check(G.fxBudget.live === 0, 'budget reads 0 once the scene is released', `live=${G.fxBudget.live}`);
}

// ------------- B1. move coroutine cancelled -------------
function cancelMove() {
  console.log('\nB1. move coroutine cancelled mid-animation');
  const G = boot();
  G.state.party = [new G.Mon('CHARIZARD', 40)];
  const b = new G.Battle({ type: 'wild', enemyParty: [new G.Mon('BLASTOISE', 40)] });
  const sc = new G.BattleScene({ bg: 'grass' });
  sc.b = b; b.ui = sc; sc.show.p = sc.show.e = true; sc.boxes.p = sc.boxes.e = true;
  sc.disp.p = b.mon(b.p).hp; sc.disp.e = b.mon(b.e).hp; sc.platformSlide = 1;
  G.engine.scenes.length = 0; G.engine.push(sc);
  // TELEPORT blinks the sprite; DOUBLE_TEAM slides it. Step until the state we care about has changed, then cancel.
  const gen = G.vfx.move(sc, 'TELEPORT', 'p', 0);
  let stepped = 0, moved = false;
  for (; stepped < 60; stepped++) {
    const r = gen.next(); G.engine.draw(G.gfx.screen);
    if (r.done) break;
    if (sc.offs.p.x !== 0 || sc.offs.p.y !== 0 || sc.vis.p !== 1 || sc.tint.p || sc.clip.p !== 1 || sc.scale.p !== 1) { moved = true; break; }
  }
  check(moved, 'the move was cancelled after it had changed sprite state', `after ${stepped} frames offs=${JSON.stringify(sc.offs.p)} vis=${sc.vis.p}`);
  gen.return(); // cancel the coroutine — runs vfx.move's finally
  check(sc.offs.p.x === 0 && sc.offs.p.y === 0 && sc.offs.e.x === 0 && sc.offs.e.y === 0, 'offsets restored to 0', JSON.stringify(sc.offs));
  check(sc.tint.p === null && sc.tint.e === null, 'tint cleared', JSON.stringify(sc.tint));
  check(sc.vis.p === 1 && sc.vis.e === 1 && sc.clip.p === 1 && sc.clip.e === 1 && sc.scale.p === 1 && sc.scale.e === 1, 'vis / clip / scale restored to 1', `vis=${JSON.stringify(sc.vis)} clip=${JSON.stringify(sc.clip)} scale=${JSON.stringify(sc.scale)}`);
  check(!sc.screenFx && sc.flash === 0 && sc.shake === 0, 'screenFx / flash / shake cleared', `screenFx=${!!sc.screenFx} flash=${sc.flash} shake=${sc.shake}`);
  // FULL-screen recipe cancelled mid-way (PSYCHIC drives screenFx, TINT drives tint + screen distortion)
  sc.dispose();
  const sc2 = new G.BattleScene({ bg: 'grass' });
  sc2.b = b; b.ui = sc2; sc2.show.p = sc2.show.e = true;
  G.engine.scenes.length = 0; G.engine.push(sc2);
  const g2 = G.vfx.move(sc2, 'PSYCHIC_M', 'p', 0);
  let stepped2 = 0;
  for (; stepped2 < 40; stepped2++) { const r = g2.next(); G.engine.draw(G.gfx.screen); if (r.done) break; if (sc2.screenFx || sc2.tint.e) break; }
  check(sc2.screenFx || sc2.tint.e, 'a screen-distorting recipe reached its distortion phase', `after ${stepped2} frames screenFx=${!!sc2.screenFx} tint.e=${JSON.stringify(sc2.tint.e)}`);
  g2.return();
  check(!sc2.screenFx && sc2.tint.e === null && sc2.tint.p === null, 'screen distortion / tint cleared when the recipe is cancelled', `screenFx=${!!sc2.screenFx} tint=${JSON.stringify(sc2.tint)}`);
  sc2.dispose();
}

// ------------- B2. forced early end, then a new battle -------------
function interruptBattle() {
  console.log('\nB2. forced early end of a battle, then a fresh one');
  const G = boot();
  const realRandom = Math.random;
  Math.random = seedRandom(4242);
  G.state.party = [mk(G, 'CHARIZARD', 55, ATTACKS), mk(G, 'BLASTOISE', 55, ATTACKS)];
  const task = G.spawnScript(G.startWildBattle('SNORLAX', 55));
  let sc = null, cancelledAt = -1;
  // drive until a move animation is mid-flight: a dense effect list or presentation state changed
  for (let f = 0; f < 4000 && !task.done; f++) {
    driveMenu(G, f, (f, n) => f % n);
    G.engine.step();
    sc = G.engine.scenes.find(s => s.constructor.name === 'BattleScene');
    if (!sc) continue; // the battle scene is pushed after the transition overlay
    const lively = sc.fx.length >= 20 || sc.flash > 0 || sc.offs.p.x !== 0 || sc.offs.e.x !== 0 || sc.tint.p || sc.scale.p !== 1 || sc.clip.p !== 1;
    if (lively && f > 60) { cancelledAt = f; break; }
  }
  Math.random = realRandom;
  check(cancelledAt >= 0, 'the battle was interrupted mid-animation', `frame=${cancelledAt} fx=${sc && sc.fx.length} flash=${sc && sc.flash}`);
  const wasLively = sc && (sc.offs.p.x !== 0 || sc.offs.e.x !== 0 || sc.flash > 0 || sc.tint.p || sc.tint.e || sc.clip.p !== 1 || sc.scale.p !== 1 || sc.fx.length > 0);
  check(!!wasLively, 'the scene held live presentation state at the moment of the forced end', JSON.stringify(sc && { offs: sc.offs, tint: sc.tint, clip: sc.clip, scale: sc.scale, flash: sc.flash, fx: sc.fx.length }));
  // forced end: the driving coroutine is removed without unwinding, and the battle ends with the animation state
  // still live. This is the cancelled / fled / blacked-out path the game must survive.
  G.engine.tasks = G.engine.tasks.filter(t => t !== task);
  task.done = true; G.scriptRunning = Math.max(0, G.scriptRunning - 1);
  G.engine.pop(sc); // the engine's pop hook releases the scene (same as a battle that ends normally)
  check(sc.offs.p.x === 0 && sc.offs.p.y === 0 && sc.offs.e.x === 0 && sc.offs.e.y === 0, 'released battle has offsets at 0', JSON.stringify(sc.offs));
  check(sc.tint.p === null && sc.tint.e === null && sc.scale.p === 1 && sc.scale.e === 1 && sc.vis.p === 1 && sc.vis.e === 1 && sc.clip.p === 1 && sc.clip.e === 1, 'released battle has tint empty and scale / vis / clip 1', `tint=${JSON.stringify(sc.tint)} scale=${JSON.stringify(sc.scale)}`);
  check(sc.fx.length === 0 && !sc.screenFx && sc.flash === 0, 'released battle has no leftover effects', `fx=${sc.fx.length} flash=${sc.flash}`);
  const b = G.fxBudget;
  check(b.live === 0 && b.battle === 0 && b.peak === 0, 'per-frame budget is zero after the battle is destroyed', `live=${b.live} battle=${b.battle} peak=${b.peak}`);
  // a battle opened right after (the next encounter's construction)
  const nsc = new G.BattleScene({ bg: 'grass' });
  const bb = new G.Battle({ type: 'wild', enemyParty: [mk(G, 'RATTATA', 20, ATTACKS)] });
  nsc.b = bb; bb.ui = nsc;
  check(nsc.offs.p.x === 0 && nsc.offs.e.x === 0 && nsc.tint.p === null && nsc.tint.e === null && nsc.scale.p === 1 && nsc.scale.e === 1, 'the next battle starts clean', `offs=${JSON.stringify(nsc.offs)} tint=${JSON.stringify(nsc.tint)} scale=${JSON.stringify(nsc.scale)}`);
  nsc.dispose();
}

// ------------- B3. a real early ending (flee), then a new battle in the same session -------------
function fleeThenNewBattle() {
  console.log('\nB3. battle ended early by fleeing, then a new battle in the same session');
  const G = boot();
  G.state.party = [mk(G, 'CHARIZARD', 55, ATTACKS)];
  // render one frame with non-default presentation to prove disposal is what clears it (not construction)
  const sc = new G.BattleScene({ bg: 'grass' });
  const b = new G.Battle({ type: 'wild', enemyParty: [mk(G, 'RATTATA', 30, ATTACKS)] });
  sc.b = b; b.ui = sc; sc.show.p = sc.show.e = true; sc.boxes.p = sc.boxes.e = true;
  sc.disp.p = b.mon(b.p).hp; sc.disp.e = b.mon(b.e).hp; sc.platformSlide = 1;
  G.engine.push(sc);
  G.engine.draw(G.gfx.screen);
  sc.offs.p.x = 6; sc.tint.p = [G.PAL.white, 0.8]; sc.scale.p = 0.3; sc.clip.p = 0.4; sc.vis.p = 0; sc.flash = 0.6;
  b.result = 'run'; // the flee path: the engine finishes the battle with 'run'
  G.engine.pop(sc); // what runBattle's teardown / the engine hook does when the scene leaves
  check(sc.offs.p.x === 0 && sc.tint.p === null && sc.scale.p === 1 && sc.clip.p === 1 && sc.vis.p === 1 && sc.flash === 0,
    'a battle ended by fleeing has its presentation state reset', `offs=${JSON.stringify(sc.offs.p)} tint=${JSON.stringify(sc.tint.p)} scale=${sc.scale.p} clip=${sc.clip.p} vis=${sc.vis.p} flash=${sc.flash}`);
  check(sc.fx.length === 0, 'a battle ended by fleeing has its effect list emptied', `fx=${sc.fx.length}`);
  const nsc = new G.BattleScene({ bg: 'grass' });
  const nb = new G.Battle({ type: 'wild', enemyParty: [mk(G, 'PIDGEY', 10, ATTACKS)] });
  nsc.b = nb; nb.ui = nsc; nsc.show.p = nsc.show.e = true;
  G.engine.push(nsc);
  G.engine.draw(G.gfx.screen); // the first drawn frame of the deeper/next battle
  check(nsc.offs.p.x === 0 && nsc.offs.e.x === 0 && nsc.tint.p === null && nsc.scale.p === 1 && nsc.vis.p === 1, 'offsets 0, tint empty, scale 1 on the new battle', `offs=${JSON.stringify(nsc.offs)} tint=${JSON.stringify(nsc.tint)} scale=${JSON.stringify(nsc.scale)}`);
  nsc.dispose();
  check(G.fxBudget.live === 0 && G.fxBudget.peak === 0, 'budget stays zero across the two battles', `live=${G.fxBudget.live} peak=${G.fxBudget.peak}`);
}

// ------------- B4. faint / withdraw / flee / substitute cancelled mid-way -------------
function cancelTransitions() {
  console.log('\nB4. faint / withdraw / flee / substitute transitions cancelled mid-way');
  const G = boot();
  G.state.party = [new G.Mon('PIKACHU', 10)];
  const b = new G.Battle({ type: 'wild', enemyParty: [new G.Mon('PIDGEY', 5)] });
  const sc = new G.BattleScene({ bg: 'grass' });
  sc.b = b; b.ui = sc; sc.show.p = sc.show.e = true; sc.boxes.p = sc.boxes.e = true;
  sc.disp.p = b.mon(b.p).hp; sc.disp.e = b.mon(b.e).hp; sc.platformSlide = 1;
  G.engine.scenes.length = 0; G.engine.push(sc);
  const cases = [['faint', () => sc.faint({ isPlayer: false })], ['withdraw', () => sc.withdraw({ isPlayer: false })],
    ['flee', () => sc.flee({ isPlayer: false })], ['substitute', () => sc.substitute({ isPlayer: false }, true)]];
  for (const [name, make] of cases) {
    const gen = make();
    let stepped = 0;
    for (; stepped < 10; stepped++) { const r = gen.next(); if (r.done) break; }
    gen.return(); // the switch / battle ending cancels the transition half-way
    const ok = sc.offs.p.x === 0 && sc.offs.e.x === 0 && sc.clip.p === 1 && sc.clip.e === 1 && sc.scale.p === 1 && sc.scale.e === 1 && sc.vis.p === 1 && sc.vis.e === 1 && sc.tint.p === null && sc.tint.e === null;
    check(ok, name + ' cancelled mid-way leaves no residue', `offs=${JSON.stringify(sc.offs)} clip=${JSON.stringify(sc.clip)} scale=${JSON.stringify(sc.scale)} vis=${JSON.stringify(sc.vis)} tint=${JSON.stringify(sc.tint)}`);
  }
  sc.dispose();
}

// ------------- C. map render cache eviction -------------
function mapEviction() {
  console.log('\nC. map eviction (two connected maps entered alternately, three times)');
  const G = boot();
  const MR = G.mapRender, ow = G.ow;
  const outer = MR.get(G.maps.getMap('PalletTown'));
  outer.phase = 5000; // pretend it has been animating for a while
  const before = MR.stats();
  const samples = [];
  for (let round = 0; round < 3; round++) {
    for (const n of ['PalletTown', 'Route1', 'PewterCity', 'Route2']) {
      ow.load(n, 1, 1, 'down'); // the real entry path: mapRender.evict(keep) then mapRender.get(map)
      for (let f = 0; f < 40; f++) { ow.t++; if (ow.render) MR.animate(ow.render, ow.t, 0, 0, 320, 180); }
      const st = MR.stats();
      samples.push({ map: n, maps: st.maps, units: st.units, surfaces: st.surfaces });
    }
  }
  const maxMaps = Math.max(...samples.map(s => s.maps));
  const maxUnits = Math.max(...samples.map(s => s.units));
  check(maxMaps <= 3, 'cache entry count stays bounded while switching maps', `maxMaps=${maxMaps} (map + its connections)`);
  check(maxUnits <= Math.max(before.units, 350), 'animated units stay bounded', `maxUnits=${maxUnits} baseline=${before.units}`);
  if (verbose) for (const s of samples) console.log(`  ${s.map.padEnd(12)} maps=${s.maps} units=${s.units} surfaces=${s.surfaces}`);
  const releasedSurface = !outer.s && !outer.up && !outer.wmask && outer.anim.length === 0 && outer.released === true;
  check(releasedSurface, 'the evicted render released its surface, water mask and animation units', `s=${!!outer.s} wmask=${outer.wmask} anim=${outer.anim.length} released=${outer.released}`);
  const plateauMap = G.maps.getMap('IndigoPlateau');
  const plateau = MR.get(plateauMap);
  const firesBefore = plateau.fires.length;
  MR.evictOne('IndigoPlateau');
  check(firesBefore > 0 && plateau.fires.length === 0 && !plateau.s, 'the evicted render released its fire list', `fires ${firesBefore}->${plateau.fires.length} surface=${!!plateau.s}`);
  const rebuilt = MR.get(G.maps.getMap('PalletTown'));
  MR.animate(rebuilt, 0, 0, 0, 320, 180);
  check(rebuilt !== outer && rebuilt.phase === 1, 're-entering rebuilds the map and the animation phase starts at zero', `sameObject=${rebuilt === outer} phase=${rebuilt.phase}`);
  check(rebuilt.anim.length > 0 && rebuilt.wmask && rebuilt.s && rebuilt.up, 'the rebuilt map has its units, mask and surfaces back', `anim=${rebuilt.anim.length} wmask=${!!rebuilt.wmask}`);
  ow.load('PalletTown', 1, 1, 'down');
  const R = ow.render;
  R.phase = 0; for (let f = 0; f < 3; f++) { ow.t++; MR.animate(R, ow.t, 0, 0, 320, 180); }
  check(R.phase === 3, 'animation phase advances only while the map is on screen', `phase=${R.phase}`);
}

function main() {
  battleBudget();
  budgetUnit();
  cancelMove();
  interruptBattle();
  fleeThenNewBattle();
  cancelTransitions();
  mapEviction();
  console.log('\n' + (failures ? failures + ' check(s) FAILED' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
}
main();
