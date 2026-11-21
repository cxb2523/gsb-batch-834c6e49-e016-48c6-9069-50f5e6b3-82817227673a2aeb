// Owns spectator camera policy: which survivor to follow (or free
// overview), cycling between survivors, and handing the render package's
// SmoothedCamera a fresh target every frame so motion is eased rather
// than snapped. This is the "client side" of spectate-on-death: it reads
// a MatchAdapter and a live fighter-position list, and produces a
// CameraView the renderer paints verbatim via RenderFrame.cameraOverride.
//
// Lifecycle rules (see spectator/session.ts for the generation model and
// docs/SPECTATE_LIFECYCLE.md for the full story):
//
//   * A controller belongs to exactly one match generation. `beginGeneration`
//     is the only way to point it at a new one; it drops every target,
//     buffer and camera state that belonged to the old generation and
//     snaps the camera instead of gliding in from the previous match.
//   * `activate` is idempotent and per-generation. A late frame from a
//     superseded generation cannot turn the camera on again.
//   * `release` is idempotent and is the ONLY place listeners are removed,
//     so calling it from teardown, from a reconnect and from an explicit
//     exit can never stack a second set of key handlers on top of the
//     first (that stacking was what made the camera drift: two handlers
//     each advancing the follow target every frame).
//   * Follow targets are recomputed from the survival set of the *frame
//     being rendered*, not from whatever the final roster was. For replay
//     that means scrubbing backwards can legitimately make an old target
//     selectable again, and a target that is alive at that tick is never
//     treated as eliminated just because the recording ends with it out.
// Deep imports of the Pixi-free camera primitives, deliberately, rather
// than the '@bash-fighter/render' barrel: the barrel pulls in PixiJS and
// the browser-only Renderer, which makes this file (and its lifecycle
// tests, packages/app/test/spectator-lifecycle.test.ts) unimportable
// under `node --test` -- exactly the constraint spectator/session.ts was
// split out for. These modules import nothing but each other, and the app
// bundle resolves them to the same code the barrel re-exports. The one
// runtime import must stay a type-only form so Node never follows it.
import { computeFollowCamera, computeOverviewCamera, SmoothedCamera } from '../../../render/src/spectator-camera.ts';
import type { ArenaBounds, CameraView } from '../../../render/src/camera.ts';
import type { MatchAdapter } from './types.ts';

export type SpectatorMode = 'follow' | 'overview';

export interface SpectatorFrameInput {
  /** Sim tick this frame represents. Optional for callers that only ever
   * have a live adapter; when present, an adapter that knows per-tick
   * survival (replay) is asked for the roster as of this tick. */
  tick?: number;
  positions: readonly { x: number; y: number }[]; // indexed like the sim
  viewWidth: number;
  viewHeight: number;
  arena: ArenaBounds;
  dtSeconds: number;
}

/** Minimal key surface so this file stays DOM-free/testable: exactly the
 * two methods a listener target needs. `window` satisfies it. */
export interface SpectatorKeySource {
  addEventListener(type: 'keydown', handler: (e: SpectatorKeyEvent) => void): void;
  removeEventListener(type: 'keydown', handler: (e: SpectatorKeyEvent) => void): void;
}

export interface SpectatorKeyEvent {
  code: string;
  preventDefault?: () => void;
}

export interface SpectatorKeyOptions {
  /** Return true for keystrokes that belong to a text field / focused
   * button; the controller then leaves them alone. */
  shouldIgnore?(event: SpectatorKeyEvent): boolean;
}

const FOLLOW_SCALE = 4.5;
const FOLLOW_VERTICAL_OFFSET = 8;
const OVERVIEW_MIN_SCALE = 1.6;
const OVERVIEW_MAX_SCALE = 5.5;
const OVERVIEW_PADDING = 20;

export class SpectatorController {
  private mode: SpectatorMode = 'follow';
  private followIndex: number | null = null;
  private readonly camera: SmoothedCamera;
  private active = false;
  // Not TS parameter properties: this file is imported directly by a plain
  // `node --test` regression test (packages/app/test/spectator-lifecycle.
  // test.ts), and Node's strip-only loader rejects parameter properties --
  // same constraint net-match.ts documents for its own constructor.
  private readonly adapter: MatchAdapter;
  private localIndex: number;
  /** The match generation this controller currently belongs to. Anything
   * stamped with a different token is stale. */
  private generation = 0;
  /** Set by beginGeneration so the first update after a reconnect or a
   * replay seek snaps to its target rather than easing across arenas. */
  private snapNextFrame = false;
  /** Per-frame scratch buffers, allocated once and released by release(). */
  private positionsBuffer: { x: number; y: number }[] = [];
  private survivorsBuffer: number[] = [];
  private detachKeys: (() => void) | null = null;

  constructor(
    adapter: MatchAdapter,
    /** The local slot spectating (excluded from follow/cycle targets). */
    localIndex: number,
    initialView: CameraView,
  ) {
    this.adapter = adapter;
    this.localIndex = localIndex;
    this.camera = new SmoothedCamera(initialView);
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get currentMode(): SpectatorMode {
    return this.mode;
  }

  get followedIndex(): number | null {
    return this.followIndex;
  }

  /** Point this controller at a new match generation. Everything carried
   * over from the previous generation -- the follow target, overview mode,
   * and any buffered positions -- is dropped here, and the camera snaps
   * to `initialView` (when given) so a reconnect never glides in from the
   * old match's framing. Returns false when the token was not newer than
   * the current one, in which case nothing changes. */
  beginGeneration(generation: number, initialView?: CameraView): boolean {
    if (generation <= this.generation) return false;
    this.generation = generation;
    this.active = false;
    this.mode = 'follow';
    this.followIndex = null;
    this.positionsBuffer = [];
    this.survivorsBuffer = [];
    this.snapNextFrame = true;
    if (initialView) this.camera.snapTo(initialView);
    return true;
  }

  /** Change which slot is "ours" (the one excluded from targets). Used by
   * online play, where the seat is only known once 'welcome' arrives. */
  setLocalSlot(slot: number): void {
    this.localIndex = slot;
    if (this.followIndex === slot) this.followIndex = null;
  }

  /** Called once, the frame the local player is eliminated. Idempotent
   * per generation: a repeated call (or a late call carrying an old
   * generation token) cannot re-run the handover or reset the camera. */
  activate(generation = this.generation): void {
    if (generation !== this.generation) return;
    if (this.active) return;
    this.active = true;
    this.mode = 'follow';
    this.followIndex = this.pickInitialTarget();
  }

  deactivate(): void {
    this.active = false;
    this.followIndex = null;
  }

  /** Drop every listener and buffer this controller holds, and stop
   * driving the camera. Safe to call any number of times: the second call
   * is a no-op, which is what makes "exit spectating" and "reconnect
   * teardown" both able to call it without coordinating. */
  release(): void {
    this.detachKeys?.();
    this.detachKeys = null;
    this.deactivate();
    this.positionsBuffer = [];
    this.survivorsBuffer = [];
    this.snapNextFrame = true;
  }

  /** Install the Tab/O shortcuts on `source`. Registering twice replaces
   * the first registration (never stacks); release() removes whichever
   * one is current. Returns a disposer for callers that do not own the
   * controller's lifetime. */
  attachKeys(source: SpectatorKeySource, options: SpectatorKeyOptions = {}): () => void {
    this.detachKeys?.();
    const handler = (event: SpectatorKeyEvent): void => {
      if (!this.active) return;
      if (options.shouldIgnore?.(event)) return;
      if (event.code === 'Tab') {
        event.preventDefault?.();
        this.cycleNext();
      } else if (event.code === 'KeyO') {
        event.preventDefault?.();
        this.toggleOverview();
      }
    };
    source.addEventListener('keydown', handler);
    const detach = (): void => {
      source.removeEventListener('keydown', handler);
      if (this.detachKeys === detach) this.detachKeys = null;
    };
    this.detachKeys = detach;
    return detach;
  }

  toggleOverview(): void {
    this.mode = this.mode === 'overview' ? 'follow' : 'overview';
    if (this.mode === 'follow' && this.followIndex === null) {
      this.followIndex = this.pickInitialTarget();
    }
  }

  /** Cycle to the next surviving fighter (wraps around). Uses the survival
   * set of the moment being watched. */
  cycleNext(tick?: number): void {
    const survivors = this.targetsAt(tick);
    if (survivors.length === 0) {
      this.followIndex = null;
      return;
    }
    this.mode = 'follow';
    const currentPos = this.followIndex === null ? -1 : survivors.indexOf(this.followIndex);
    const next = survivors[(currentPos + 1 + survivors.length) % survivors.length];
    this.followIndex = next ?? null;
  }

  private pickInitialTarget(tick?: number): number | null {
    const survivors = this.targetsAt(tick);
    return survivors.length > 0 ? (survivors[0] as number) : null;
  }

  /** Followable slots right now: everyone alive at `tick`, minus our own
   * seat. Deliberately does not consult `adapter.status()` -- during a
   * replay that status reflects the recording's final roster, which is
   * exactly the wrong answer for an earlier tick. */
  private targetsAt(tick?: number): number[] {
    const at = tick !== undefined ? this.adapter.survivorIndicesAt?.(tick) : undefined;
    const source = at ?? this.adapter.survivorIndices();
    const out = this.survivorsBuffer;
    out.length = 0;
    for (const index of source) {
      if (index !== this.localIndex) out.push(index);
    }
    return out.slice();
  }

  /** Compute this frame's smoothed camera. Safe to call with zero
   * survivors (falls back to framing the whole arena). */
  update(input: SpectatorFrameInput): CameraView {
    // Keep the follow target valid against THIS frame's survival set, not
    // the latest/current one: a replay scrubbed backwards may have the
    // target alive again, while a live frame may have just seen it die.
    // A null target is also retried every frame -- online spectating can
    // activate before the first snapshot has arrived (no known survivors
    // yet), and must pick one up as soon as the roster exists.
    if (this.followIndex === null) {
      if (this.mode === 'follow') this.followIndex = this.pickInitialTarget(input.tick);
    } else {
      const survivors = this.targetsAt(input.tick);
      if (!survivors.includes(this.followIndex)) {
        this.followIndex = this.pickInitialTarget(input.tick);
      }
    }

    let target: CameraView;
    if (this.mode === 'follow' && this.followIndex !== null && input.positions[this.followIndex]) {
      target = computeFollowCamera(input.positions[this.followIndex] as { x: number; y: number }, {
        viewWidth: input.viewWidth,
        viewHeight: input.viewHeight,
        scale: FOLLOW_SCALE,
        verticalOffset: FOLLOW_VERTICAL_OFFSET,
      });
    } else {
      const buffer = this.positionsBuffer;
      buffer.length = 0;
      for (const i of this.targetsAt(input.tick)) {
        const p = input.positions[i];
        if (p) buffer.push(p);
      }
      target = computeOverviewCamera(
        buffer,
        input.arena,
        input.viewWidth,
        input.viewHeight,
        OVERVIEW_MIN_SCALE,
        OVERVIEW_MAX_SCALE,
        OVERVIEW_PADDING,
      );
    }
    if (this.snapNextFrame) {
      this.camera.snapTo(target);
      this.snapNextFrame = false;
      return this.camera.current;
    }
    return this.camera.update(target, input.dtSeconds);
  }
}
