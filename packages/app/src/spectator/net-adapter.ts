// MatchAdapter over a *live* match whose authoritative roster arrives as
// per-snapshot fighter states rather than a directly readable Sim — i.e.
// online play (NetMatch) and anything else that renders remote fighters
// from decoded snapshots. SimMatchAdapter stays the local-match path: it
// reads packages/sim directly. Both satisfy the same MatchAdapter contract,
// so the spectator controller never knows which kind of match it is
// attached to.
//
// Like SimMatchAdapter this keeps zero bookkeeping of its own: every call
// reads the source fresh, so it can never drift from what is being drawn.
// Deliberately DOM-free and Pixi-free (types + plain data only) so it is
// importable under `node --test`.
import type { FighterMatchStatus, LiveArenaBounds, MatchAdapter } from './types.ts';

/** The slice of a live match this adapter needs. NetMatch satisfies it
 * structurally, which keeps this file free of a runtime import cycle. */
export interface LiveRosterSource {
  /** Current per-slot snapshots, index-aligned with the sim. */
  roster(): readonly {
    eliminated: boolean;
    eliminatedTick: number;
    placement: number;
    koCount: number;
  }[];
  isOver(): boolean;
  liveArenaBounds(): LiveArenaBounds | null;
}

export class SnapshotMatchAdapter implements MatchAdapter {
  private readonly source: LiveRosterSource;

  constructor(source: LiveRosterSource) {
    this.source = source;
  }

  /** Read live rather than captured at construction: online play builds
   * this adapter before 'matchStart' has created the prediction sim, so a
   * fixed count taken then would be 0 for the whole match. */
  get fighterCount(): number {
    return this.source.roster().length;
  }

  update(): void {
    // No cross-tick bookkeeping: the source always has the latest state.
  }

  status(index: number): FighterMatchStatus {
    const fighter = this.source.roster()[index];
    if (!fighter) throw new RangeError(`SnapshotMatchAdapter: fighter ${index} out of range`);
    return {
      eliminated: fighter.eliminated,
      eliminationTick: fighter.eliminated ? fighter.eliminatedTick : null,
      placement: fighter.placement > 0 ? fighter.placement : null,
      koCount: fighter.koCount,
    };
  }

  survivorIndices(): number[] {
    const roster = this.source.roster();
    const out: number[] = [];
    for (let i = 0; i < roster.length; i++) {
      if (!(roster[i] as { eliminated: boolean }).eliminated) out.push(i);
    }
    return out;
  }

  liveArenaBounds(): LiveArenaBounds | null {
    return this.source.liveArenaBounds();
  }

  isMatchOver(): boolean {
    return this.source.isOver();
  }
}
