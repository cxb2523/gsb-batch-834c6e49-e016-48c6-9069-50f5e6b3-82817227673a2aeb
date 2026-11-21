// One explicit generation token for the whole "playing -> eliminated ->
// spectating -> reconnect/replay" lifecycle, so every piece of state that
// belonged to a seat can be versioned and dropped at exactly the right
// moment instead of being inferred from "is this client spectating now?".
//
// The rules this exists to enforce (see docs/SPECTATE_LIFECYCLE.md):
//
//   1. Freezing a seat at elimination is permanent for the match
//      generation: its input is never collected, submitted or predicted
//      again, whether or not the client has finished transitioning to
//      spectating in every other subsystem.
//   2. A reconnect / resync is a *new generation*. Anything buffered under
//      the old generation (unconsumed inputs, a pending replay window) is
//      discarded, and the new seat starts with an empty buffer. Old
//      generation writes are rejected rather than silently applied to the
//      new one -- the bug that let a stale input history replay into a
//      freshly rebuilt sim after a reconnect.
//   3. Invalidation is idempotent and cheap, so teardown paths (leaving a
//      match, releasing a spectator camera, a failed resume) can all call
//      it without coordinating.
//
// Deliberately DOM-free and dependency-free (type-only InputFrame import)
// so it runs under `node --test`, unlike the render/Pixi half of the
// spectator package.
import type { InputFrame } from '@bash-fighter/sim';

export type SpectatePhase = 'playing' | 'spectating';

export interface SpectateSessionSnapshot {
  generation: number;
  phase: SpectatePhase;
  /** This client's own seat for the current generation, or -1 for a pure
   * spectator / after the seat has been released. */
  localSlot: number;
  frozenSeats: readonly number[];
  pendingInputTicks: readonly number[];
}

export class SpectateSession {
  private generationCount = 0;
  private frozen = new Set<number>();
  private phase: SpectatePhase = 'playing';
  private localSlot = -1;
  /** Locally-sampled inputs newer than the server's last ack, keyed by the
   * client tick that produced them. Only ever consulted for the current
   * generation; a generation bump clears it. */
  private pendingInputs = new Map<number, InputFrame>();

  /** Current generation. Starts at 0 ("no session") and only moves forward. */
  get generation(): number {
    return this.generationCount;
  }

  get isSpectating(): boolean {
    return this.phase === 'spectating';
  }

  get currentLocalSlot(): number {
    return this.localSlot;
  }

  /** Begin a brand-new match generation at `localSlot` (-1 for a pure
   * spectator). Everything from the previous generation -- frozen seats,
   * phase and unconsumed inputs -- is dropped here, before any new state
   * can be written. Returns the new generation token. */
  startGeneration(localSlot: number): number {
    this.generationCount += 1;
    this.frozen = new Set<number>();
    this.pendingInputs.clear();
    this.phase = 'playing';
    this.localSlot = localSlot;
    return this.generationCount;
  }

  /** Tear the generation down (leaving the match, releasing a spectator
   * runtime, a lost seat). Safe to call repeatedly; always invalidates the
   * previous token and releases buffered inputs. */
  invalidate(): void {
    this.generationCount += 1;
    this.frozen.clear();
    this.pendingInputs.clear();
    this.phase = 'playing';
    this.localSlot = -1;
  }

  /** Permanently stop this seat for the current generation: no more input
   * sampling, submission or prediction, and any unconsumed input from the
   * seat is dropped so it cannot be replayed or re-sent later. */
  freezeSeat(slot: number): void {
    if (slot < 0) return;
    this.frozen.add(slot);
    this.pendingInputs.clear();
  }

  isSeatFrozen(slot: number): boolean {
    return this.frozen.has(slot);
  }

  frozenSeats(): number[] {
    return Array.from(this.frozen);
  }

  /** Whether the current generation's local seat may still produce input.
   * Stale tokens always answer false, even if the slot is not frozen --
   * that is what stops a superseded generation writing into a rebuilt one. */
  acceptsLocalInput(generation: number): boolean {
    if (generation !== this.generationCount) return false;
    if (this.phase === 'spectating') return false;
    if (this.localSlot < 0) return false;
    return !this.frozen.has(this.localSlot);
  }

  /** Enter the spectator phase for `generation`. Returns false (and does
   * not change phase) when the token is stale, so a late 'eliminated'
   * message from a previous connection cannot re-activate spectating on
   * the generation that replaced it. */
  beginSpectating(generation: number): boolean {
    if (generation !== this.generationCount) return false;
    this.phase = 'spectating';
    this.pendingInputs.clear();
    return true;
  }

  endSpectating(): void {
    if (this.phase === 'spectating') this.phase = 'playing';
  }

  /** Buffer one locally-sampled input for replay-against-ack. Rejected
   * (returns false) for a stale generation, during spectating, or for a
   * frozen seat -- the caller must not send it to the authority either. */
  recordInput(generation: number, tick: number, frame: InputFrame): boolean {
    if (!this.acceptsLocalInput(generation)) return false;
    this.pendingInputs.set(tick, frame);
    return true;
  }

  /** Drop acked entries and return the remaining inputs in replay order.
   * A stale generation returns an empty list: its window is not consumed,
   * it is discarded (the buffer was already cleared on generation change;
   * returning [] keeps a caller holding an old token from replaying into a
   * sim that has since been rebuilt). */
  takePendingInputs(generation: number, ackedTick: number): InputFrame[] {
    if (generation !== this.generationCount) return [];
    for (const tick of Array.from(this.pendingInputs.keys())) {
      if (tick <= ackedTick) this.pendingInputs.delete(tick);
    }
    return Array.from(this.pendingInputs.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, frame]) => frame);
  }

  discardPendingInputs(): void {
    this.pendingInputs.clear();
  }

  pendingInputCount(): number {
    return this.pendingInputs.size;
  }

  snapshot(): SpectateSessionSnapshot {
    return {
      generation: this.generationCount,
      phase: this.phase,
      localSlot: this.localSlot,
      frozenSeats: Array.from(this.frozen),
      pendingInputTicks: Array.from(this.pendingInputs.keys()).sort((a, b) => a - b),
    };
  }
}
