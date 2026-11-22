/**
 * Headless verification of the finish-freeze rules.
 *
 *   npm run verify:freeze
 *
 * The results screen slow-motion used to keep simulating the field: rivals
 * still circulating would cross the line, be credited a lap, be classified as
 * finishers, and the recovery logic would even teleport a stranding car back
 * onto the racing line. The board then disagreed with the moment the player
 * took the flag.
 *
 * This drives the real RaceDirector headlessly and asserts the freeze holds:
 *   - the classification stops at the player's finish,
 *   - the slow-motion still moves the cars (it is a visual replay, not a pause),
 *   - no rival gains a lap, a finish time or a reset while frozen,
 *   - the player cannot be reset or reclassified after finishing,
 *   - a restart fully thaws the rules.
 *
 * A deliberate wreck is forced after the flag so the recovery logic is given
 * every chance to reset a frozen car; if it is gated correctly it cannot.
 */

import * as THREE from 'three';
import { Track } from '../src/sim/track';
import { Terrain } from '../src/sim/terrain';
import { RaceDirector, LAPS, CAR_COUNT } from '../src/sim/race';
import { RaceAudio } from '../src/audio/raceAudio';
import { Dust } from '../src/render/dust';
import type { SimEnv, ResultsData } from '../src/sim/types';

const f = (v: number, d = 2): string => v.toFixed(d);

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label.padEnd(46)} ${detail}`);
}

console.log('\n=== NOCTIS GP - finish freeze verification ===\n');

// ---- world ---------------------------------------------------------------
const track = new Track().build(2).buildHash().markLaunchRamp();
const terrain = new Terrain();
terrain.buildNatural(track);
track.setHeightsFromTerrain(terrain);
terrain.carve(track);

const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 90000);

function makeEnv(): SimEnv {
  const scene = new THREE.Scene();
  return { scene, camera, terrain, track, audio: new RaceAudio(), dust: new Dust(scene), autopilot: true, menu: null };
}

// A snapshot the board has to reproduce exactly.
interface Snap {
  name: string;
  lap: number;
  finished: boolean;
  finishTime: number;
  totalDist: number;
}

// TS narrows an assigned-in-callback variable to null, so results are kept in
// a box for the assertions further down.
const resultBox: { value: ResultsData | null } = { value: null };
const director = new RaceDirector(makeEnv(), {
  onResults: (d) => {
    resultBox.value = d;
  },
});
director.startRace();

const DT = 1 / 60;
const MAX_SECONDS = 900;

// ---- run until the player's flag freezes the classification --------------
let t = 0;
while (t < MAX_SECONDS && !director.classificationFrozen) {
  director.update(DT);
  t += DT;
}

check('player finish freezes classification', director.classificationFrozen,
      director.classificationFrozen ? `frozen ${f(t, 1)}s into the race` : 'no freeze before the time limit');

if (!director.classificationFrozen) {
  console.log(`\n${failures} CHECK(S) FAILED\n`);
  process.exit(1);
}

// Exactly what the board will classify, captured at the flag.
const snapshot: Snap[] = director.frozenClassification()!.cars;
const snapshotByName = new Map(snapshot.map((c) => [c.name, c]));
const frozenClock = director.frozenClassification()!.clock;
const playerSnap = snapshot.find((c) => c.name === 'YOU')!;

console.log('\n  --- classification at the flag ---');
for (let i = 0; i < snapshot.length; i++) {
  const c = snapshot[i]!;
  const state = c.finished ? `${f(c.finishTime)}s` : `lap ${c.lap + 1}, running`;
  console.log(`  ${String(i + 1).padStart(2)}. ${c.name.padEnd(6)} ${state}`);
}

check('the player is classified as a finisher', playerSnap.finished, playerSnap.finished ? `YOU finished at ${f(playerSnap.finishTime)}s` : 'YOU did not finish');
check('classification covers the whole field', snapshot.length === CAR_COUNT, `${snapshot.length}/${CAR_COUNT} classified`);
check('some rivals were still running', snapshot.some((c) => !c.finished),
      `${snapshot.filter((c) => !c.finished).length} rivals classified in place`);

// ---- let the results slow-motion play out --------------------------------
// The player has finished; the director still has to present the board. Force
// every unfinished rival into a state the recovery logic would normally
// rescue, so the test would fail loudly if the gate ever regressed.
const runningAtFlag = director.cars.filter((c) => !c.finished);
for (const c of runningAtFlag) {
  c.pos.x += 5000; // off in the boulder field, nowhere near the road
  c.wrongWayT = 10;
  c.offRoadT = 10;
  c.stuckTimer = 10;
}
const preWreckS = new Map(director.cars.map((c) => [c, c.s] as const));

// Play well past the board appearing and well past any slow-motion beat.
for (let i = 0; i < 60 * 30; i++) director.update(DT);

check('the results board was shown', director.state === 'results' && resultBox.value !== null, `state=${director.state}`);

// ---- the frozen classification is untouched ------------------------------
const after = director.frozenClassification()!;
const afterByName = new Map(after.cars.map((c) => [c.name, c]));
let lapDrift = 0;
let finishDrift = 0;
let distDrift = 0;
for (const s of snapshot) {
  const a = afterByName.get(s.name)!;
  if (a.lap !== s.lap) lapDrift++;
  if (a.finished !== s.finished) finishDrift++;
  if (Math.abs(a.totalDist - s.totalDist) > 1e-6) distDrift++;
}
check('no rival gains a lap after the flag', lapDrift === 0, `${lapDrift} cars drifted`);
check('no rival is reclassified after the flag', finishDrift === 0, `${finishDrift} cars changed finish state`);
check('classified progress is frozen', distDrift === 0, `${distDrift} cars moved in classification`);
check('the classified clock is frozen', after.clock === frozenClock, `clock stays ${f(after.clock)}s`);
check('the board matches the frozen order', resultBox.value !== null && resultBox.value.standings.map((r) => r.name).join() === snapshot.map((c) => c.name).join(), 'standings order is the flag-time order');

// The rivals' live bookkeeping must not advance either: an unfinished rival
// can never pick up a lap or a finish time just by being driven for the shots.
let liveLap = 0;
let liveFinish = 0;
for (const c of director.cars) {
  const s = snapshotByName.get(c.name)!;
  if (c.lap !== s.lap) liveLap++;
  if (c.finished !== s.finished) liveFinish++;
}
check('live rivals keep their lap count', liveLap === 0, `${liveLap} live cars gained a lap`);
check('live rivals keep their finish state', liveFinish === 0, `${liveFinish} live cars finished during the replay`);

// ---- the slow-motion is still a replay, not a pause ---------------------
let moved = 0;
for (const c of director.cars) {
  const before = preWreckS.get(c)!;
  // Arc position legitimately changes as the cars are driven for the camera.
  if (Math.abs(c.s - before) > 0.01 || c.speed > 0.1) moved++;
}
check('slow-motion still moves the cars', moved > 0, `${moved}/${director.cars.length} cars moving on the results screen`);

// ---- the player is untouchable after the flag ---------------------------
{
  const beforeS = director.player.s;
  const beforePos = director.player.pos.clone();
  director.resetPlayer(); // the R key: must be inert once classified
  const sameS = Math.abs(director.player.s - beforeS) < 1e-6;
  const samePos = director.player.pos.distanceTo(beforePos) < 1e-6;
  check('player cannot be reset after finishing', sameS && samePos, sameS && samePos ? 'reset ignored' : 'player was moved');
  const stillSecond = director.playerPosition === snapshot.findIndex((c) => c.name === 'YOU') + 1;
  check('player position is frozen', stillSecond, `still P${director.playerPosition}`);
}

// The rival recovery logic must not fire while frozen even though every
// unfinished car was just dumped five kilometres off the circuit.
let resets = 0;
for (const c of director.cars) {
  const s = snapshotByName.get(c.name)!;
  // A reset would snap the car back inside the corridor and rewrite its arc
  // position; the classified progress is the authoritative check.
  if (Math.abs(c.totalDist - s.totalDist) > 1e-6) resets++;
}
check('recovery never resets a frozen car', resets === 0, `${resets} cars were pulled back to the track`);

// ---- HUD standings mirror the frozen classification ---------------------
{
  const hud = director.hudStandings();
  const hudOk =
    hud.length === snapshot.length &&
    hud.every((row, i) => {
      const s = snapshot[i]!;
      const shownLap = Math.min(LAPS, s.lap + (s.finished ? 0 : 1));
      return row.name === s.name && row.finished === s.finished && row.lap === shownLap;
    });
  check('HUD standings are the flag-time standings', hudOk, `${hud.length} rows match the snapshot`);
  check('HUD shows the player as finished', hud.find((r) => r.me)?.finished === true, 'player row is FIN');
  check('HUD progress is the classified progress', director.raceProgress > 0 && director.raceProgress <= 1, `progress ${f(director.raceProgress, 3)}`);
}

// ---- restart fully thaws the rules --------------------------------------
{
  director.startRace();
  check('restart clears the freeze', !director.classificationFrozen, 'classification is live again');
  check('restart clears the car locks', director.cars.every((c) => !c.rulesLocked), 'every car is rule-eligible');
  check('restart clears finish state', director.cars.every((c) => !c.finished && c.lap === 0 && c.cpIndex === 0), 'all cars re-grided clean');

  // After a restart the normal rules must work again: run the race and confirm
  // cars count laps and the player can be reset while genuinely racing.
  let restarted = 0;
  while (restarted < 60 * 60 && director.state !== 'results') {
    director.update(DT);
    restarted += DT;
  }
  const anyLap = director.cars.some((c) => c.lap > 0 || c.cpIndex > 0);
  check('laps are counted again after restart', anyLap, `max lap ${Math.max(...director.cars.map((c) => c.lap))}, max cp ${Math.max(...director.cars.map((c) => c.cpIndex))}`);

  // Reset only exists during a live race, so prove the gate actually lets it
  // through on a fresh, unfrozen grid.
  director.startRace();
  for (let i = 0; i < 60 * 5; i++) director.update(DT); // clear the countdown
  const beforePos = director.player.pos.clone();
  director.resetPlayer();
  const moved = director.player.pos.distanceTo(beforePos) > 0.01;
  check('player reset works again after restart', moved, moved ? 'player reset onto the racing line' : `reset still ignored (state=${director.state}, frozen=${director.classificationFrozen})`);
}

// ---- driving to a real finish after a restart shows a frozen board ------
{
  let finished = false;
  for (let i = 0; i < 60 * MAX_SECONDS && !finished; i++) {
    director.update(DT);
    finished = director.classificationFrozen;
  }
  check('a restarted race freezes again at the flag', finished, finished ? 'classification frozen at the second flag' : 'never froze');
  if (finished) {
    const again = director.frozenClassification()!;
    const stillRunning = again.cars.filter((c) => !c.finished);
    check('in-place classification holds on a second race', again.cars.length === CAR_COUNT, `${stillRunning.length} rivals classified in place`);
    check('the second board covers the field', (resultBox.value?.standings.length ?? 0) === CAR_COUNT, `${resultBox.value?.standings.length ?? 0}/${CAR_COUNT}`);
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
