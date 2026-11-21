// Walks the acceptance flows through a harness that mirrors how TrailerReel
// wires the reducer to a timer effect: the reducer owns a token, the harness
// arms a timer for it and clears it on cleanup. This catches mistakes the pure
// reducer tests cannot (a token that never restarts, a cancelled timer that
// still jumps).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ReelAction,
  type ReelState,
  REEL_ADVANCE_DELAY_MS,
  initReel,
  reelReducer,
} from '../../src/discover/reel.js';

/**
 * The smallest view the reel needs: current state, the one armed timer, and
 * the "clock" that fires it. `dispatch` reapplies the component's timer effect
 * on every transition, exactly as React would after a render.
 */
class ReelHarness {
  state: ReelState;
  fire: (() => void) | null = null;
  /** Every timer the harness armed, for asserting a full delay was requested. */
  armedAt: number[] = [];
  now = 0;

  constructor(total: number) {
    this.state = initReel(0);
    this.dispatch({ type: 'set-payload', key: 'films', total });
  }

  dispatch(action: ReelAction) {
    this.state = reelReducer(this.state, action);
    // Mirror the view's `useEffect([pendingAdvance])`: clear the old timer,
    // arm one for the new token (with cleanup disabled by the effect teardown).
    this.fire = null;
    if (this.state.pendingAdvance !== null) {
      const token = this.state.pendingAdvance;
      this.armedAt.push(this.now);
      this.fire = () => this.dispatch({ type: 'auto-advance', token });
    }
  }

  /** Advances fake time by the reel's delay and fires any armed timer. */
  tickPastDelay() {
    this.now += REEL_ADVANCE_DELAY_MS;
    const fire = this.fire;
    this.fire = null;
    fire?.();
  }

  /** The player of the current generation reports an outcome. */
  ended() {
    this.dispatch({ type: 'ended', generation: this.state.generation });
  }
  failed() {
    this.dispatch({ type: 'failed', generation: this.state.generation });
  }
  select(index: number) {
    this.dispatch({ type: 'select', index });
  }
  replay() {
    this.dispatch({ type: 'replay', generation: this.state.generation });
  }
  setAuto(on: boolean) {
    this.dispatch({ type: 'set-auto', on });
  }
}

describe('acceptance: a normal play-through', () => {
  it('moves to the next film after the wait, with progress that matches the film on screen', () => {
    const h = new ReelHarness(3);
    assert.equal(h.state.index, 0);

    h.ended();
    assert.equal(h.state.phase, 'ended');
    assert.ok(h.fire, 'a wait is armed');

    h.tickPastDelay();
    assert.equal(h.state.index, 1, 'advanced exactly one film');
    assert.equal(h.state.phase, 'playing');
    assert.equal(h.fire, null, 'no wait while playing');

    h.ended();
    h.tickPastDelay();
    assert.equal(h.state.index, 2);
    assert.equal(h.state.total, 3, 'the "3 / 3" label matches the last film');
  });

  it('stops at the end instead of wrapping, and never arms a timer there', () => {
    const h = new ReelHarness(2);
    h.ended();
    h.tickPastDelay();
    assert.equal(h.state.index, 1);
    h.ended();
    assert.equal(h.state.phase, 'ended');
    assert.equal(h.fire, null);
    assert.equal(h.state.index, 1);
  });
});

describe('acceptance: a manual switch ignores the old player', () => {
  it('drops the old generation, so its late end/error cannot change the current card or count', () => {
    const h = new ReelHarness(3);
    const oldGeneration = h.state.generation;
    h.select(2); // user picks the third film mid-play
    assert.equal(h.state.index, 2);
    assert.equal(h.state.generation, oldGeneration + 1);

    const before = h.state;
    h.dispatch({ type: 'ended', generation: oldGeneration });
    h.dispatch({ type: 'failed', generation: oldGeneration });
    assert.equal(h.state, before, 'a callback from the retired player is inert');
    assert.equal(h.state.failures, 0);
    assert.equal(h.state.phase, 'playing');
  });

  it('cancels a counting-down advance when the user picks a film, and the old timer cannot jump', () => {
    const h = new ReelHarness(4);
    h.ended();
    const staleFire = h.fire;
    assert.ok(staleFire);

    h.select(3);
    assert.equal(h.fire, null, 'the pending advance was dropped');
    staleFire(); // the timer that was already in the browser fires anyway
    assert.equal(h.state.index, 3, 'it must not move the reel');
  });

  it('"next preview" behaves the same way', () => {
    const h = new ReelHarness(4);
    h.ended();
    const staleFire = h.fire;
    h.select(h.state.index + 1);
    assert.equal(h.state.index, 1);
    staleFire?.();
    assert.equal(h.state.index, 1);
  });
});

describe('acceptance: turning auto-advance off cancels the wait', () => {
  it('cancels a pending jump, and turning it back on restarts a full wait instead of jumping', () => {
    const h = new ReelHarness(4);
    h.ended();
    assert.ok(h.fire);

    h.setAuto(false);
    assert.equal(h.fire, null, 'no wait while auto is off');

    h.setAuto(true);
    assert.equal(h.state.index, 0, 're-enabling must not jump straight away');
    assert.equal(h.state.phase, 'ended');
    assert.ok(h.fire, 'a fresh wait is armed');
    assert.equal(h.armedAt.length, 2, 'the timer was re-armed from scratch');

    h.tickPastDelay();
    assert.equal(h.state.index, 1, 'after the full wait it moves on normally');
  });

  it('replay cancels the wait too, and the preview plays again without advancing', () => {
    const h = new ReelHarness(4);
    h.ended();
    h.replay();
    assert.equal(h.state.phase, 'playing');
    assert.equal(h.fire, null);
  });
});

describe('acceptance: the failure limit stops the reel until a manual pick', () => {
  it('stops after three failures, then a manual pick resets the budget and resumes', () => {
    const h = new ReelHarness(10);
    h.failed();
    h.tickPastDelay();
    h.failed();
    h.tickPastDelay();
    h.failed();

    assert.equal(h.state.failures, 3);
    assert.equal(h.state.stopped, true);
    assert.equal(h.fire, null, 'no automatic move after giving up');

    // Stray callbacks or timers are inert.
    h.ended();
    assert.equal(h.state.stopped, true);

    h.select(7);
    assert.equal(h.state.stopped, false);
    assert.equal(h.state.failures, 0);
    assert.equal(h.state.index, 7);

    // The reel advances normally again after a successful preview.
    h.ended();
    assert.ok(h.fire);
    h.tickPastDelay();
    assert.equal(h.state.index, 8);
  });
});
