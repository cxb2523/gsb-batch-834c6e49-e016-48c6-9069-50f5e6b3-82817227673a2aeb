// The Trailer Reel state machine: one current trailer, one pending advance,
// and generations that make a torn-down player's late callbacks harmless.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ReelAction,
  type ReelState,
  REEL_ADVANCE_DELAY_MS,
  REEL_MAX_CONSECUTIVE_FAILURES,
  canAutoAdvance,
  initReel,
  reelReducer,
} from '../../src/discover/reel.js';

/** Applies actions in order, to keep each test's intent readable. */
function run(state: ReelState, ...actions: ReelAction[]): ReelState {
  return actions.reduce(reelReducer, state);
}

/** A reel already holding `total` films, as if its payload had arrived. */
function started(total: number): ReelState {
  return run(initReel(0), { type: 'set-payload', key: 'a|b|c|d', total });
}

/** Fires the pending advance timer if there is one. */
function fireAdvance(state: ReelState): ReelState {
  assert.notEqual(state.pendingAdvance, null, 'expected an advance to be pending');
  return reelReducer(state, { type: 'auto-advance', token: state.pendingAdvance as number });
}

describe('the reel waits before moving on', () => {
  it('schedules a 4-second advance when a preview ends, and moves to the next film when it fires', () => {
    const ended = run(started(3), { type: 'ended', generation: 0 });
    assert.equal(ended.phase, 'ended');
    assert.notEqual(ended.pendingAdvance, null);
    assert.equal(REEL_ADVANCE_DELAY_MS, 4_000);

    const next = fireAdvance(ended);
    assert.equal(next.index, 1);
    assert.equal(next.phase, 'playing');
    assert.equal(next.pendingAdvance, null);
    assert.equal(next.generation, ended.generation + 1, 'a new film gets a new player generation');
  });

  it('does not wrap past the last film', () => {
    const last = run(started(2), { type: 'ended', generation: 0 });
    const atLast = fireAdvance(last);
    assert.equal(atLast.index, 1);
    assert.equal(canAutoAdvance(atLast), false, 'nothing follows the last film');

    const endedAtLast = run(atLast, { type: 'ended', generation: atLast.generation });
    assert.equal(endedAtLast.pendingAdvance, null, 'the reel must not schedule a wrap-around');
  });

  it('keeps playing a single-film reel without any advance', () => {
    const one = run(started(1), { type: 'ended', generation: 0 });
    assert.equal(one.phase, 'ended');
    assert.equal(one.pendingAdvance, null);
  });
});

describe('a stale player cannot move the reel', () => {
  it('ignores an ended or failed callback from an earlier generation', () => {
    const before = started(4);
    const stale = before.generation - 1; // e.g. a player torn down by a manual switch
    assert.equal(run(before, { type: 'ended', generation: stale }), before);
    assert.equal(run(before, { type: 'failed', generation: stale }), before);
  });

  it('ignores a late error after the next film has already started', () => {
    const ended = run(started(3), { type: 'ended', generation: 0 });
    const advanced = fireAdvance(ended);
    // The old player's load fails a beat later, with the generation it mounted with.
    const late = run(advanced, { type: 'failed', generation: ended.generation });
    assert.equal(late, advanced, 'the failure count and the card belong to the wrong film');
    assert.equal(late.failures, 0);
  });

  it('ignores a duplicate end from the same player', () => {
    const ended = run(started(3), { type: 'ended', generation: 0 });
    const again = run(ended, { type: 'ended', generation: 0 });
    assert.equal(again, ended, 'one player ends the preview once');
  });

  it('only accepts a replay from the current generation while it shows its end card', () => {
    const ended = run(started(3), { type: 'ended', generation: 0 });
    assert.equal(run(ended, { type: 'replay', generation: ended.generation - 1 }), ended);
    const replayed = run(ended, { type: 'replay', generation: ended.generation });
    assert.equal(replayed.phase, 'playing');
    assert.equal(replayed.pendingAdvance, null);
    assert.equal(replayed.generation, ended.generation, 'replay keeps the same player');
  });
});

describe('the pending advance is cancellable', () => {
  it('is cancelled by picking a film from the queue', () => {
    const waiting = run(started(4), { type: 'ended', generation: 0 });
    const token = waiting.pendingAdvance as number;
    const picked = run(waiting, { type: 'select', index: 2 });
    assert.equal(picked.index, 2);
    assert.equal(picked.phase, 'playing');
    assert.equal(picked.pendingAdvance, null);
    assert.equal(run(picked, { type: 'auto-advance', token }), picked, 'the old timer must be a no-op');
  });

  it('is cancelled by "next preview"', () => {
    const waiting = run(started(4), { type: 'ended', generation: 0 });
    const token = waiting.pendingAdvance as number;
    const next = run(waiting, { type: 'select', index: waiting.index + 1 });
    assert.equal(next.index, 1);
    assert.equal(run(next, { type: 'auto-advance', token }), next);
  });

  it('is cancelled by replay and does not then advance', () => {
    const waiting = run(started(4), { type: 'ended', generation: 0 });
    const token = waiting.pendingAdvance as number;
    const replayed = run(waiting, { type: 'replay', generation: waiting.generation });
    assert.equal(replayed.pendingAdvance, null);
    assert.equal(run(replayed, { type: 'auto-advance', token }), replayed);
  });

  it('is cancelled by turning auto-advance off, and a late timer cannot jump', () => {
    const waiting = run(started(4), { type: 'ended', generation: 0 });
    const token = waiting.pendingAdvance as number;
    const off = run(waiting, { type: 'set-auto', on: false });
    assert.equal(off.pendingAdvance, null);
    assert.equal(run(off, { type: 'auto-advance', token }), off);
    assert.equal(off.index, waiting.index, 'turning auto off must not move the reel');
  });

  it('restarts the full wait, not an immediate jump, when auto is turned back on over a card', () => {
    const waiting = run(started(4), { type: 'ended', generation: 0 });
    const off = run(waiting, { type: 'set-auto', on: false });
    const on = run(off, { type: 'set-auto', on: true });
    assert.equal(on.index, off.index, 're-enabling auto must not jump straight away');
    assert.equal(on.phase, 'ended');
    assert.notEqual(on.pendingAdvance, null, 'a fresh wait is scheduled');
    assert.notEqual(on.pendingAdvance, waiting.pendingAdvance, 'it is a new token, so the timer restarts');
  });

  it('re-enabling auto on a film that is still playing schedules nothing', () => {
    const playing = run(started(4), { type: 'set-auto', on: false }, { type: 'set-auto', on: true });
    assert.equal(playing.phase, 'playing');
    assert.equal(playing.pendingAdvance, null);
  });
});

describe('consecutive failures stop the reel until a manual pick', () => {
  it(`stops after ${REEL_MAX_CONSECUTIVE_FAILURES} previews in a row fail, without scheduling more`, () => {
    let s = started(10);
    s = run(s, { type: 'failed', generation: s.generation });
    assert.equal(s.failures, 1);
    assert.equal(s.stopped, false);
    s = fireAdvance(s);
    s = run(s, { type: 'failed', generation: s.generation });
    assert.equal(s.failures, 2);
    assert.equal(s.stopped, false);
    s = fireAdvance(s);
    s = run(s, { type: 'failed', generation: s.generation });
    assert.equal(s.failures, 3);
    assert.equal(s.stopped, true);
    assert.equal(s.pendingAdvance, null, 'no advance after the reel has given up');
    assert.equal(canAutoAdvance(s), false);

    // A stray late timer cannot move it either.
    assert.equal(reelReducer(s, { type: 'auto-advance', token: s.nextToken }), s);
  });

  it('resets the failure budget when the user picks a film', () => {
    let s = started(10);
    for (let i = 0; i < REEL_MAX_CONSECUTIVE_FAILURES; i++) {
      s = run(s, { type: 'failed', generation: s.generation });
      if (s.stopped) {
        break;
      }
      s = fireAdvance(s);
    }
    assert.equal(s.stopped, true);
    const recovered = run(s, { type: 'select', index: 5 });
    assert.equal(recovered.stopped, false);
    assert.equal(recovered.failures, 0);
    assert.equal(recovered.index, 5);
    assert.equal(recovered.phase, 'playing');
    assert.equal(canAutoAdvance(run(recovered, { type: 'ended', generation: recovered.generation })), true);
  });

  it('a successful end breaks the streak', () => {
    let s = started(10);
    s = run(s, { type: 'failed', generation: s.generation });
    s = fireAdvance(s);
    s = run(s, { type: 'failed', generation: s.generation });
    assert.equal(s.failures, 2);
    s = fireAdvance(s);
    s = run(s, { type: 'ended', generation: s.generation });
    assert.equal(s.failures, 0);
    assert.equal(s.stopped, false);
  });

  it('a pick of the same film while it is playing changes nothing', () => {
    const playing = started(3);
    assert.equal(run(playing, { type: 'select', index: 0 }), playing);
  });

  it('a pick of the same film on its error card restarts it and clears the stop', () => {
    let s = started(1);
    s = run(s, { type: 'failed', generation: s.generation });
    assert.equal(s.phase, 'error');
    const restarted = run(s, { type: 'select', index: 0 });
    assert.equal(restarted.phase, 'playing');
    assert.equal(restarted.generation, s.generation + 1, 'the player remounts');
    assert.equal(restarted.failures, 0);
  });
});

describe('payload changes', () => {
  it('records the first payload without bumping the generation', () => {
    const s = run(initReel(0), { type: 'set-payload', key: 'a|b', total: 2 });
    assert.equal(s.total, 2);
    assert.equal(s.generation, 0, 'the first payload must not force a second player mount');
  });

  it('starts a new session for a different payload', () => {
    const deep = run(started(4), { type: 'select', index: 3 }, { type: 'failed', generation: 1 });
    const fresh = run(deep, { type: 'set-payload', key: 'x|y', total: 2 });
    assert.equal(fresh.index, 0);
    assert.equal(fresh.total, 2);
    assert.equal(fresh.failures, 0);
    assert.equal(fresh.stopped, false);
    assert.equal(fresh.phase, 'playing');
    assert.equal(fresh.pendingAdvance, null);
  });

  it('ignores an identical payload', () => {
    const s = started(4);
    assert.equal(run(s, { type: 'set-payload', key: 'a|b|c|d', total: 4 }), s);
  });
});
