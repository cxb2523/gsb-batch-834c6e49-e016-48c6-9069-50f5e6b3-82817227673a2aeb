// MatchAdapter over an already-precomputed replay: one captured roster per
// recorded frame. Exists so the same SpectatorController that follows live
// survivors can also follow a replay — and, crucially, so it answers "who
// was alive at the moment being shown" rather than the recording's final
// roster. That distinction is the whole replay/spectate requirement:
// scrubbing back to an early frame must offer the fighters alive then,
// including ones the recording ends with eliminated.
//
// Cursor semantics: every `...At(cursor)` call takes a *frame index* into
// the captured roster list (what ReplayViewer already tracks for scrubbing),
// not a sim tick. Frames are captured from the fixture's first advance
// onward in order, so this is the only cursor a replay caller has — and it
// keeps the adapter free of any tick<->index mapping that could silently
// drift.
//
// Pure data in, no Sim, no DOM: build it from ReplayViewer's frames.
import type { FighterMatchStatus, LiveArenaBounds, MatchAdapter } from './types.ts';

export interface ReplayRosterFrame {
  /** Index-aligned with the sim; `eliminated` is as of this frame. */
  fighters: readonly { eliminated: boolean }[];
  /** Sim tick this frame was captured at (reported in status()). */
  tick: number;
  liveArenaBounds?: LiveArenaBounds;
}

export class ReplayMatchAdapter implements MatchAdapter {
  readonly fighterCount: number;
  private readonly frames: readonly ReplayRosterFrame[];
  private current = 0;

  constructor(frames: readonly ReplayRosterFrame[]) {
    if (frames.length === 0) throw new Error('ReplayMatchAdapter: no frames');
    this.frames = frames;
    this.fighterCount = (frames[0] as ReplayRosterFrame).fighters.length;
  }

  /** Point the adapter at the frame being rendered. Every no-argument
   * lookup below is relative to this, so live and replay call sites share
   * one adapter contract. */
  setFrameIndex(index: number): void {
    this.current = Math.max(0, Math.min(this.frames.length - 1, Math.round(index)));
  }

  get frameIndex(): number {
    return this.current;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  update(): void {
    // No bookkeeping: the frames are already captured.
  }

  status(index: number): FighterMatchStatus {
    return this.statusAt(this.current, index);
  }

  statusAt(frameIndex: number, index: number): FighterMatchStatus {
    const frame = this.frameAt(frameIndex);
    const fighter = frame.fighters[index];
    if (!fighter) throw new RangeError(`ReplayMatchAdapter: fighter ${index} out of range`);
    return {
      eliminated: fighter.eliminated,
      eliminationTick: fighter.eliminated ? frame.tick : null,
      placement: null,
      koCount: 0,
    };
  }

  survivorIndices(): number[] {
    return this.survivorIndicesAt(this.current);
  }

  survivorIndicesAt(frameIndex: number): number[] {
    const frame = this.frameAt(frameIndex);
    const out: number[] = [];
    for (let i = 0; i < frame.fighters.length; i++) {
      if (!(frame.fighters[i] as { eliminated: boolean }).eliminated) out.push(i);
    }
    return out;
  }

  liveArenaBounds(): LiveArenaBounds | null {
    return this.frameAt(this.current).liveArenaBounds ?? null;
  }

  liveArenaBoundsAt(frameIndex: number): LiveArenaBounds | null {
    return this.frameAt(frameIndex).liveArenaBounds ?? null;
  }

  isMatchOver(): boolean {
    return false;
  }

  private frameAt(frameIndex: number): ReplayRosterFrame {
    if (!Number.isFinite(frameIndex)) return this.frames[this.current] as ReplayRosterFrame;
    const i = Math.max(0, Math.min(this.frames.length - 1, Math.round(frameIndex)));
    return this.frames[i] as ReplayRosterFrame;
  }
}
