// The generation-scoped lifecycle for "playing -> eliminated -> spectating
// -> reconnect/replay". These tests pin the rules the rest of the app now
// relies on (see packages/app/src/spectator/session.ts and
// docs/SPECTATE_LIFECYCLE.md), all without a browser: the session is a
// plain class and the spectator controller's camera math is Pixi-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeInputFrame, fixed as fx } from '@bash-fighter/sim';
import { SpectateSession } from '../src/spectator/session.ts';
import { SpectatorController } from '../src/spectator/controller.ts';
import { ReplayMatchAdapter, type ReplayRosterFrame } from '../src/spectator/replay-adapter.ts';
import type { MatchAdapter } from '../src/spectator/types.ts';

const RIGHT = makeInputFrame(0, fx.ONE, 0);

// ---------------------------------------------------------------- session

test('freezing a seat stops input for that generation and drops its buffered input', () => {
  const session = new SpectateSession();
  const gen = session.startGeneration(3);
  assert.equal(session.acceptsLocalInput(gen), true);
  assert.equal(session.recordInput(gen, 10, RIGHT), true);
  assert.equal(session.pendingInputCount(), 1);

  session.freezeSeat(3);

  assert.equal(session.acceptsLocalInput(gen), false, 'a frozen seat may not act');
  assert.equal(session.recordInput(gen, 11, RIGHT), false, 'nor buffer more input');
  assert.equal(session.pendingInputCount(), 0, 'the unacked window from that seat is dropped');
  assert.deepEqual(session.takePendingInputs(gen, 0), [], 'nothing from a frozen seat can be replayed');
});

test('freezing is permanent for the generation even if the sim revives the seat', () => {
  // Stocks/Timed Brawl can put a fighter back on the field; the lifecycle
  // decision is made once per generation and must not silently reverse.
  const session = new SpectateSession();
  const gen = session.startGeneration(0);
  session.freezeSeat(0);
  session.endSpectating();
  assert.equal(session.acceptsLocalInput(gen), false);
});

test('a reconnect is a new generation: stale writes are rejected, not applied', () => {
  const session = new SpectateSession();
  const oldGen = session.startGeneration(0);
  session.recordInput(oldGen, 5, RIGHT);

  const newGen = session.startGeneration(0);

  assert.notEqual(newGen, oldGen);
  assert.equal(session.pendingInputCount(), 0, 'the previous generation buffer is discarded on rebuild');
  assert.equal(session.recordInput(oldGen, 6, RIGHT), false, 'a stale token may not write');
  assert.deepEqual(session.takePendingInputs(oldGen, 0), [], 'a stale token may not replay');
  assert.equal(session.isSeatFrozen(0), false, 'the rebuilt seat starts unfrozen');
});

test('a late eliminated message from a superseded generation cannot start spectating', () => {
  const session = new SpectateSession();
  const oldGen = session.startGeneration(0);
  session.startGeneration(0); // reconnect
  assert.equal(session.beginSpectating(oldGen), false);
  assert.equal(session.isSpectating, false);
});

test('acknowledged inputs leave the replay window; newer ones stay in order', () => {
  const session = new SpectateSession();
  const gen = session.startGeneration(1);
  session.recordInput(gen, 3, makeInputFrame(0, 1, 0));
  session.recordInput(gen, 1, makeInputFrame(0, 2, 0));
  session.recordInput(gen, 2, makeInputFrame(0, 3, 0));

  const replayed = session.takePendingInputs(gen, 1);
  assert.deepEqual(
    replayed.map((f) => f.stickX),
    [3, 1],
    'only ticks newer than the ack, in tick order',
  );
  assert.equal(session.pendingInputCount(), 2);
});

test('invalidate() releases everything and rejects every outstanding token', () => {
  const session = new SpectateSession();
  const gen = session.startGeneration(0);
  session.recordInput(gen, 1, RIGHT);
  session.freezeSeat(0);
  session.invalidate();
  assert.equal(session.pendingInputCount(), 0);
  assert.deepEqual(session.frozenSeats(), []);
  assert.equal(session.acceptsLocalInput(gen), false);
  // Idempotent: a second teardown keeps moving forward, never back.
  const before = session.generation;
  session.invalidate();
  assert.equal(session.generation, before + 1);
});

test('root generation 0 refuses input, so an un-startable session is never "playing"', () => {
  const session = new SpectateSession();
  assert.equal(session.acceptsLocalInput(0), false);
});

// ------------------------------------------------------------- controller

/** A tiny adapter over a mutable "alive" set, so tests can kill fighters
 * and (for replay semantics) query them at an arbitrary cursor. */
class FakeAdapter implements MatchAdapter {
  readonly fighterCount: number;
  private alive: boolean[];
  private readonly history: boolean[][];
  constructor(alive: boolean[], history?: boolean[][]) {
    this.alive = alive;
    this.fighterCount = alive.length;
    this.history = history ?? [];
  }
  update(): void {}
  status(index: number): { eliminated: boolean; eliminationTick: number | null; placement: number | null; koCount: number } {
    return { eliminated: !this.alive[index], eliminationTick: null, placement: null, koCount: 0 };
  }
  survivorIndices(): number[] {
    return this.alive.flatMap((ok, i) => (ok ? [i] : []));
  }
  survivorIndicesAt(tick: number): number[] {
    const frame = this.history[Math.max(0, Math.min(this.history.length - 1, tick))];
    return (frame ?? this.alive).flatMap((ok, i) => (ok ? [i] : []));
  }
  liveArenaBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    return { minX: -200, maxX: 200, minY: -200, maxY: 200 };
  }
  isMatchOver(): boolean {
    return this.survivorIndices().length <= 1;
  }
}

const INITIAL_VIEW = { centerX: 0, centerY: 0, scale: 3 };

function frameInput(positions: { x: number; y: number }[], positionsTick?: number) {
  return {
    tick: positionsTick,
    positions,
    viewWidth: 1280,
    viewHeight: 720,
    arena: { minX: -600, maxX: 600, minY: -200, maxY: 400 },
    dtSeconds: 1 / 60,
  };
}

test('activation follows a survivor, never the eliminated local seat', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);

  assert.equal(controller.isActive, true);
  assert.equal(controller.followedIndex, 1);

  const positions = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: -100, y: 0 },
  ];
  const view = controller.update(frameInput(positions));
  assert.equal(view.centerX, 100, 'camera centres on the followed survivor');
});

test('cycleNext walks only the living and wraps', () => {
  const adapter = new FakeAdapter([false, true, false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);

  const order: (number | null)[] = [controller.followedIndex];
  for (let i = 0; i < 3; i++) {
    controller.cycleNext();
    order.push(controller.followedIndex);
  }
  assert.deepEqual(order, [1, 3, 4, 1]);
});

test('when the followed survivor dies the target moves to another living fighter', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);
  assert.equal(controller.followedIndex, 1);

  (adapter as unknown as { alive: boolean[] }).alive = [false, false, true];
  controller.update(frameInput([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }]));
  assert.equal(controller.followedIndex, 2, 'must not keep watching a dead fighter');
});

test('beginGeneration drops the old target and snaps the camera instead of gliding', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);
  controller.update(frameInput([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 0 }]));

  const newView = { centerX: -400, centerY: 10, scale: 2 };
  assert.equal(controller.beginGeneration(2, newView), true);
  assert.equal(controller.isActive, false, 'a new generation starts not-spectating');
  assert.equal(controller.followedIndex, null);
  assert.equal(controller.currentGeneration, 2);

  controller.activate(2);
  const snapped = controller.update(frameInput([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]));
  // First update after a generation change is exactly the target, not an
  // eased value part-way there from the previous match's framing.
  assert.equal(snapped.centerX, 0);
  assert.equal(snapped.scale, 4.5, 'follow scale, not a blend from the old view');
});

test('a stale generation cannot activate the controller or retarget it', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(4, INITIAL_VIEW);
  controller.activate(3); // stale token
  assert.equal(controller.isActive, false);
  controller.activate(4);
  assert.equal(controller.isActive, true);
  assert.equal(controller.beginGeneration(2), false, 'generations only move forward');
});

test('cycleNext/toggleOverview do nothing while not spectating', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  // Global shortcuts used to fire even after leaving spectating; the
  // controller must own the active check.
  const source = new FakeKeySource();
  controller.attachKeys(source);
  source.fire('Tab');
  assert.equal(controller.followedIndex, null);
  assert.equal(controller.currentMode, 'follow');
});

// ------------------------------------------------------- key registration

class FakeKeySource {
  listeners = new Set<(e: { code: string; preventDefault?: () => void }) => void>();
  addEventListener(_type: 'keydown', handler: (e: { code: string; preventDefault?: () => void }) => void): void {
    this.listeners.add(handler);
  }
  removeEventListener(_type: 'keydown', handler: (e: { code: string; preventDefault?: () => void }) => void): void {
    this.listeners.delete(handler);
  }
  fire(code: string): void {
    for (const listener of this.listeners) listener({ code, preventDefault: () => {} });
  }
}

test('attachKeys replaces (never stacks) and release() removes the listener', () => {
  const adapter = new FakeAdapter([false, true, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);

  const source = new FakeKeySource();
  controller.attachKeys(source);
  controller.attachKeys(source); // re-attach, e.g. after a reconnect
  assert.equal(source.listeners.size, 1, 'only one registration may be live');

  const first = controller.followedIndex;
  source.fire('Tab');
  const second = controller.followedIndex;
  assert.notEqual(second, first, 'the single listener advanced the target');
  source.fire('Tab');
  const third = controller.followedIndex;
  // Exactly one step per keypress: a stacked pair would jump two slots.
  const survivors = adapter.survivorIndices().filter((i) => i !== 0);
  assert.ok(second !== null);
  assert.equal(third, survivors[(survivors.indexOf(second) + 1) % survivors.length]);

  controller.release();
  assert.equal(source.listeners.size, 0, 'release() removes the registration');
  assert.equal(controller.isActive, false);
  assert.equal(controller.followedIndex, null);
  // Idempotent: a second release must not throw or double-remove.
  controller.release();
  assert.equal(source.listeners.size, 0);
});

test('release() then reattach leaves exactly one live listener', () => {
  const adapter = new FakeAdapter([false, true, true]);
  const controller = new SpectatorController(adapter, 0, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);
  const source = new FakeKeySource();
  controller.attachKeys(source);
  controller.release();
  controller.beginGeneration(2, INITIAL_VIEW);
  controller.activate(2);
  controller.attachKeys(source);
  assert.equal(source.listeners.size, 1);
});

// ------------------------------------------------------- replay adapter

function rosterFrame(eliminated: boolean[], tick: number): ReplayRosterFrame {
  return {
    fighters: eliminated.map((e) => ({ eliminated: e })),
    tick,
    liveArenaBounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  };
}

test('replay adapter answers survival for the frame being shown, not the final roster', () => {
  // Fighter 1 dies at frame 1; a final-roster answer would hide it at frame 0.
  const frames = [
    rosterFrame([false, false, true], 10),
    rosterFrame([false, true, true], 11),
    rosterFrame([true, true, true], 12),
  ];
  const adapter = new ReplayMatchAdapter(frames);

  adapter.setFrameIndex(0);
  assert.deepEqual(adapter.survivorIndices(), [0, 1]);
  assert.equal(adapter.status(1).eliminated, false);

  adapter.setFrameIndex(1);
  assert.deepEqual(adapter.survivorIndices(), [0]);
  assert.equal(adapter.status(1).eliminated, true);

  // Scrubbing back makes the earlier roster authoritative again.
  adapter.setFrameIndex(0);
  assert.deepEqual(adapter.survivorIndicesAt(0), [0, 1]);
});

test('replay controller cycles to whoever was alive at the shown tick', () => {
  const frames = [
    rosterFrame([false, false, false], 0),
    rosterFrame([false, false, false], 1),
    rosterFrame([true, true, false], 2),
  ];
  const adapter = new ReplayMatchAdapter(frames);
  const controller = new SpectatorController(adapter, -1, INITIAL_VIEW);
  controller.beginGeneration(1, INITIAL_VIEW);
  controller.activate(1);

  adapter.setFrameIndex(0);
  assert.equal(controller.followedIndex, 0);
  controller.cycleNext(adapter.frameIndex);
  assert.equal(controller.followedIndex, 1);
  controller.cycleNext(adapter.frameIndex);
  assert.equal(controller.followedIndex, 2);
  controller.cycleNext(adapter.frameIndex);
  assert.equal(controller.followedIndex, 0, 'wraps over the early-frame survivors');

  // Same recording, shown at its end: only fighter 2 is selectable.
  adapter.setFrameIndex(2);
  controller.cycleNext(adapter.frameIndex);
  assert.equal(controller.followedIndex, 2);
  assert.deepEqual(adapter.survivorIndicesAt(2), [2]);
});
