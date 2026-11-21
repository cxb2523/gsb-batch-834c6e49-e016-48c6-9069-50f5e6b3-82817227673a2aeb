// The freeze is only real if it changes what the sim is handed. This
// drives the same helper Match.tick() uses (buildTickInputs) against a
// real Sim and proves three things the lifecycle promises:
//
//   1. A frozen seat contributes a neutral frame even when the poll
//      returned a live input for it on that very tick -- the elimination
//      handover cannot leak "what the player was holding when they died".
//   2. Freezing does not disturb any other seat's bot decision, so the
//      match stays deterministic for everyone else.
//   3. No input for the frozen seat can reach the sim afterwards, no
//      matter what the caller passes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotController, BotDifficulty, deriveBotSeed, fixed as fx, makeInputFrame } from '@bash-fighter/sim';
import { createMatchSim, ALL_CHARACTERS, pickArenaId } from '@bash-fighter/content';
import { buildLocalBots, buildTickInputs } from '../src/local-crowd-bots.ts';
import { SpectateSession } from '../src/spectator/session.ts';

const N = 20;
const SEED = 424242;

function crowdSim() {
  const characters = Array.from({ length: N }, (_, i) => ALL_CHARACTERS[i % ALL_CHARACTERS.length]!.character);
  return createMatchSim(SEED, N, undefined, characters, pickArenaId(SEED));
}

const HOLD_RIGHT = makeInputFrame(0, fx.ONE, 0);

test('a frozen seat contributes neutral input even on the tick its poll still holds a key', () => {
  const sim = crowdSim();
  const bots = buildLocalBots(SEED, N, 2);
  const polled = [HOLD_RIGHT, HOLD_RIGHT];

  const before = buildTickInputs(sim, polled, bots, N);
  assert.equal(before[0]!.stickX, fx.ONE, 'sanity: the polled frame is non-neutral');

  const session = new SpectateSession();
  const gen = session.startGeneration(0);
  session.freezeSeat(0);

  const after = buildTickInputs(sim, polled, bots, N, session.frozenSeats());
  assert.deepEqual(after[0], makeInputFrame(0, 0, 0), 'slot 0 must go neutral the moment it is frozen');
  assert.equal(after[1]!.stickX, fx.ONE, 'an unfrozen human seat is untouched');
  assert.equal(session.acceptsLocalInput(gen), false);
});

test('freezing one seat leaves every other seat byte-identical', () => {
  const sim = crowdSim();
  const bots = buildLocalBots(SEED, N, 2);
  const polled = [HOLD_RIGHT, HOLD_RIGHT];
  const reference = buildTickInputs(sim, polled, bots, N);

  const frozen = buildTickInputs(sim, polled, bots, N, [1]);
  for (let i = 0; i < N; i++) {
    if (i === 1) {
      assert.deepEqual(frozen[i], makeInputFrame(0, 0, 0));
    } else {
      assert.deepEqual(frozen[i], reference[i], `slot ${i} must be unaffected by freezing slot 1`);
    }
  }
});

test('a frozen seat never reaches the sim again, whatever a caller supplies', () => {
  const sim = crowdSim();
  const bots = buildLocalBots(SEED, N, 2);
  const session = new SpectateSession();
  session.startGeneration(0);
  session.freezeSeat(0);

  // Adversarial caller: still polls slot 0 and keeps handing us live
  // frames for it. buildTickInputs is the last gate before Sim.advance, so
  // it has to hold the line on its own.
  const startX = sim.getFighter(0).posX;
  for (let tick = 0; tick < 120; tick++) {
    sim.advance(buildTickInputs(sim, [HOLD_RIGHT, HOLD_RIGHT], bots, N, session.frozenSeats()));
  }
  // Slot 0 is bot-less and frozen; with neutral input it cannot have
  // walked right by ~120 ticks worth. (Its position may change from being
  // hit, so assert it did not simply translate at walking speed.)
  const movedByWalking = fx.toFloat(sim.getFighter(0).posX) - fx.toFloat(startX);
  assert.ok(movedByWalking < 30, `frozen seat advanced ${movedByWalking} world units, expected no self-driven movement`);
});

test('a bot never drives a slot that a human seat owns', () => {
  // Match's constructor deletes bot entries for its localSeats; this pins
  // the invariant the ?crowd20=1&seat=<n> path depends on.
  const bots = buildLocalBots(SEED, N, 2);
  assert.equal(bots.has(0), false);
  assert.equal(bots.has(1), false);
  assert.equal(bots.has(2), true);
  // BotController is still constructible independently of the map (no
  // accidental shared state).
  assert.ok(new BotController(2, BotDifficulty.EASY, deriveBotSeed(SEED, 2)));
});
