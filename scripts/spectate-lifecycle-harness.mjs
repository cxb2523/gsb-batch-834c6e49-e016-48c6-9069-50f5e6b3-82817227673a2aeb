#!/usr/bin/env node
// Local verification harness for the spectate lifecycle:
// "playing -> eliminated -> spectating -> reconnect/replay".
//
// Runs a REAL 20-fighter crowd match headlessly (the same seed, characters
// and bots ?crowd20=1 uses -- see docs/LOCAL_CROWD_TESTING.md), drives the
// exact helpers Match.tick() drives (buildLocalBots / buildTickInputs plus
// SpectateSession), and then exercises the spectator camera and the replay
// adapter over the same recorded rosters. No browser, no server, no DOM.
//
// What it proves, in order:
//   1. Elimination is detected on the tick it happens and the seat is
//      frozen; from then on the sim only ever sees a neutral frame for it,
//      even though the "poll" keeps returning a held-right frame.
//   2. The spectator camera follows a living fighter, never the frozen
//      seat, and Tab/cycle walks the survivors that are actually alive.
//   3. A "reconnect" (session.startGeneration with the same seat) discards
//      the old generation's unidentified input: nothing buffered before
//      the reconnect is replayed afterwards, and a stale token cannot
//      write.
//   4. Replay: cycling over the recorded rosters uses the survival set of
//      the frame being shown, not the recording's final roster.
//
// Usage:
//   node scripts/spectate-lifecycle-harness.mjs [--seed=1234] [--seat=0] [--ticks=3000]
//
// Exit code is 0 when every invariant holds, 1 when one does not -- so it
// can be wired into CI later without any further work.
import { createMatchSim, ALL_CHARACTERS, pickArenaId } from '../packages/content/src/index.ts';
import { makeInputFrame, fixed as fx } from '../packages/sim/src/index.ts';
import { buildLocalBots, buildTickInputs } from '../packages/app/src/local-crowd-bots.ts';
import { SpectateSession } from '../packages/app/src/spectator/session.ts';
import { SpectatorController } from '../packages/app/src/spectator/controller.ts';
import { ReplayMatchAdapter } from '../packages/app/src/spectator/replay-adapter.ts';
import { SimMatchAdapter } from '../packages/app/src/spectator/sim-adapter.ts';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const N = 20;
const SEED = Number(args.seed ?? 1234);
const SEAT = Number(args.seat ?? 0);
const MAX_TICKS = Number(args.ticks ?? 3000);
const HUMAN_SLOTS = 2;

const HOLD_RIGHT = makeInputFrame(0, fx.ONE, 0);
const NEUTRAL = makeInputFrame();

let failures = 0;
function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures++;
  console.log(`[${mark}] ${label}${detail ? ` -- ${detail}` : ''}`);
}

function crowdSim() {
  const characters = Array.from({ length: N }, (_, i) => ALL_CHARACTERS[i % ALL_CHARACTERS.length].character);
  return createMatchSim(SEED, N, undefined, characters, pickArenaId(SEED));
}

function snapshots(sim) {
  return Array.from({ length: N }, (_, i) => sim.getFighter(i));
}

// ---------------------------------------------------------------- 1. freeze
console.log(`\n== 20-fighter crowd match (seed=${SEED}, seat=${SEAT}, arena=${pickArenaId(SEED)}) ==`);
const sim = crowdSim();
const bots = buildLocalBots(SEED, N, HUMAN_SLOTS);
for (const slot of [SEAT, ...(SEAT !== 1 ? [1] : [])]) bots.delete(slot);

const session = new SpectateSession();
const generation = session.startGeneration(SEAT);

let eliminationTick = -1;
let firstFrozenTick = -1;
let frozenSeatOfferedInputAfterFreeze = false;
let frozenSeatMovedOnItsOwn = 0;
let seatFrozenX = 0;

for (let tick = 0; tick < MAX_TICKS; tick++) {
  // Adversarially keep "polling" a held-right frame for the seat for the
  // whole run, whether or not it is allowed to act: this is what a real
  // InputManager would return if the key were still down, and it is the
  // value the freeze has to neutralise.
  const polled = [HOLD_RIGHT, HOLD_RIGHT];
  const inputs = buildTickInputs(sim, polled, bots, N, session.frozenSeats());
  if (session.isSeatFrozen(SEAT) && inputs[SEAT].stickX !== 0) frozenSeatOfferedInputAfterFreeze = true;
  sim.advance(inputs);

  if (eliminationTick < 0 && sim.getFighter(SEAT).eliminated) {
    eliminationTick = tick;
    session.freezeSeat(SEAT);
    if (firstFrozenTick < 0) {
      firstFrozenTick = tick;
      seatFrozenX = sim.getFighter(SEAT).posX;
    }
    if (!session.beginSpectating(generation)) throw new Error('beginSpectating rejected the live generation');
  }
  // Keep playing a little past the elimination so the spectator has a real
  // multi-fighter field to follow -- the interesting case -- rather than
  // whatever is left at the very end of the match.
  if (eliminationTick >= 0 && tick >= eliminationTick + 240) break;
  if (sim.isMatchOver()) break;
}

const final = sim.getFighter(SEAT);
check('the controlled seat was eliminated within the run', eliminationTick >= 0, `tick ${eliminationTick}`);
check('the seat was frozen on the elimination tick', firstFrozenTick === eliminationTick);
check('no non-neutral frame for the frozen seat reached the sim afterwards', !frozenSeatOfferedInputAfterFreeze);
if (firstFrozenTick >= 0) {
  frozenSeatMovedOnItsOwn = Math.abs(fx.toFloat(final.posX) - fx.toFloat(seatFrozenX));
  check('the frozen seat did not keep walking under held input', frozenSeatMovedOnItsOwn < 20, `${frozenSeatMovedOnItsOwn.toFixed(1)} world units`);
}
check('session reports spectating', session.isSpectating);
check('session refuses further local input', !session.acceptsLocalInput(generation));

// ------------------------------------------------------------- 2. camera
console.log('\n== spectator camera ==');
const adapter = new SimMatchAdapter({ sim, currentSnapshots: () => snapshots(sim) });
const localSlot = -1; // from here on we are a spectator, not a seat
const spectator = new SpectatorController(adapter, localSlot, { centerX: 0, centerY: 0, scale: 3 });
spectator.beginGeneration(1, { centerX: 0, centerY: 0, scale: 3 });
spectator.activate(1);

const live = adapter.survivorIndices();
const follower = spectator.followedIndex;
check('camera follows a living fighter', follower !== null && live.includes(follower), `following slot ${follower}`);

// Cycle through the whole survivor set at the tick we are standing on, and
// make sure every step lands on a living fighter and the walk wraps.
const positions = snapshots(sim).map((s) => ({ x: fx.toFloat(s.posX), y: fx.toFloat(s.posY) }));
const arenaBounds = adapter.liveArenaBounds() ?? { minX: -600, maxX: 600, minY: -100, maxY: 400 };
const visited = [];
let allLiving = true;
for (let i = 0; i < Math.max(2, live.length + 1); i++) {
  const view = spectator.update({
    positions,
    viewWidth: 1280,
    viewHeight: 720,
    arena: arenaBounds,
    dtSeconds: 1 / 60,
  });
  if (!Number.isFinite(view.centerX) || !Number.isFinite(view.scale)) allLiving = false;
  visited.push(spectator.followedIndex);
  spectator.cycleNext();
}
check('camera produces a finite view every frame', allLiving);
check(
  'cycling only ever lands on survivors',
  visited.every((s) => s === null || live.includes(s)),
  `survivors ${live.join(',')}; visited ${visited.join(',')}`,
);
check(
  'cycling wraps around the survivor set',
  live.length < 2 || visited[0] === visited[live.length],
  `survivors ${live.length}, first ${visited[0]}, after a full lap ${visited[live.length]}`,
);
check('toggleOverview switches mode', (spectator.toggleOverview(), spectator.currentMode === 'overview'));

// --------------------------------------------------------- 3. reconnect
console.log('\n== reconnect / new generation ==');
const beforeReconnect = session.generation;
// Simulate unacked inputs that were buffered for the old generation.
session.recordInput(beforeReconnect, 1, HOLD_RIGHT);
const beforeCount = session.pendingInputCount();
const newGeneration = session.startGeneration(SEAT);
check('a reconnect produces a strictly newer generation', newGeneration > beforeReconnect);
check('unacked input from the old generation is discarded', session.pendingInputCount() === 0, `was ${beforeCount}`);
check('the old token can no longer write', session.recordInput(beforeReconnect, 2, HOLD_RIGHT) === false);
check('the old token replays nothing', session.takePendingInputs(beforeReconnect, 0).length === 0);
check('the rebuilt seat starts unfrozen', !session.isSeatFrozen(SEAT) && session.acceptsLocalInput(newGeneration));

// The spectator controller must drop the previous match's target/camera
// when the generation changes, and snap rather than glide.
const oldTarget = spectator.followedIndex;
check('spectator accepts the new generation', spectator.beginGeneration(newGeneration, { centerX: 0, centerY: 0, scale: 3 }));
check('the old follow target is dropped', spectator.followedIndex === null, `was ${oldTarget}`);

// ------------------------------------------------------------- 4. replay
console.log('\n== replay (per-tick survival) ==');
// Record a short roster timeline from the match we just ran, where the
// eliminated set only grows: cycle at an EARLY frame must offer fighters
// the recording ends without.
const replaySim = crowdSim();
const replayBots = buildLocalBots(SEED, N, 2);
const replaySession = new SpectateSession();
replaySession.startGeneration(0);
const rosters = [];
for (let tick = 0; tick < 1200; tick++) {
  const polled = [NEUTRAL, HOLD_RIGHT];
  const inputs = buildTickInputs(replaySim, polled, replayBots, N, replaySession.frozenSeats());
  replaySim.advance(inputs);
  rosters.push({
    fighters: snapshots(replaySim).map((s) => ({ eliminated: s.eliminated })),
    tick: replaySim.getTick(),
    liveArenaBounds: null,
  });
  if (replaySim.isMatchOver()) break;
}
const replayAdapter = new ReplayMatchAdapter(rosters);
const early = replayAdapter.survivorIndicesAt(0);
const late = replayAdapter.survivorIndicesAt(rosters.length - 1);
const replaySpectator = new SpectatorController(replayAdapter, -1, { centerX: 0, centerY: 0, scale: 3 });
replaySpectator.beginGeneration(1, { centerX: 0, centerY: 0, scale: 3 });
replaySpectator.activate(1);

replayAdapter.setFrameIndex(0);
const cycleTargets = new Set();
for (let i = 0; i < early.length + 2; i++) {
  replaySpectator.cycleNext(replayAdapter.frameIndex);
  cycleTargets.add(replaySpectator.followedIndex);
}
check(
  'replay at the first frame cycles over that frame\'s survivors',
  [...cycleTargets].every((s) => s === null || early.includes(s)),
  `early survivors: ${early.join(',')}; cycled: ${[...cycleTargets].join(',')}`,
);
check(
  'the final roster really is smaller (so this is not vacuous)',
  late.length < early.length,
  `early ${early.length} vs final ${late.length}`,
);
replayAdapter.setFrameIndex(rosters.length - 1);
const onlyFinal = replayAdapter.survivorIndices();
check(
  'scrubbing to the end restricts targets to the final roster',
  onlyFinal.every((s) => late.includes(s)),
);
replaySpectator.cycleNext(replayAdapter.frameIndex);
check(
  'the last-frame follow target is a final-roster survivor',
  replaySpectator.followedIndex === null || onlyFinal.includes(replaySpectator.followedIndex),
);

// ------------------------------------------------------------- 5. release
console.log('\n== teardown ==');
let listenerCount = 0;
const fakeWindow = {
  addEventListener: () => {
    listenerCount++;
  },
  removeEventListener: () => {
    listenerCount--;
  },
};
spectator.attachKeys(fakeWindow);
spectator.attachKeys(fakeWindow); // re-attach must replace, never stack
check('re-attaching keys leaves exactly one registration', listenerCount === 1, `${listenerCount} live`);
spectator.release();
check('release removes the registration', listenerCount === 0);
check('release drops the follow target', spectator.followedIndex === null && !spectator.isActive);
spectator.release();
check('release is idempotent', listenerCount === 0);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
