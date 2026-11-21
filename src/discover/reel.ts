// ─────────────────────────────────────────────────────────────────────────
// Bitflix Discover — Trailer Reel state machine
// ─────────────────────────────────────────────────────────────────────────
// The reel has one current trailer. Switching, replaying, cancelling an
// automatic advance and giving up after repeated failures are all transitions
// of this one reducer, so a late callback from a player that has already been
// torn down cannot move the reel or bump its failure count: those callbacks
// carry the generation they were mounted with, and only the current
// generation is accepted.
//
// The module is pure and holds no catalogue data, so views and unit tests can
// both import it. Timers live in the view: the reducer only issues (and
// invalidates) advance tokens.
// ─────────────────────────────────────────────────────────────────────────

/** How long an end or error card stays up before the reel moves on. */
export const REEL_ADVANCE_DELAY_MS = 4_000;

/** Consecutive previews that could not play before the reel gives up. */
export const REEL_MAX_CONSECUTIVE_FAILURES = 3;

/** What the current preview is doing. */
export type ReelPhase = 'playing' | 'ended' | 'error';

export interface ReelState {
  /** Number of films in the reel; used to keep the index and stop at the last. */
  readonly total: number;
  /** Identity of the film list this state was built for (their ids). */
  readonly payloadKey: string;
  /** Index of the current trailer; the progress label reads `index + 1`. */
  readonly index: number;
  readonly phase: ReelPhase;
  /** Previews in a row that failed in this reel session. */
  readonly failures: number;
  readonly autoAdvance: boolean;
  /** Set when repeated failures stopped the reel; a manual pick clears it. */
  readonly stopped: boolean;
  /**
   * Identifies the player instance the current state belongs to. Every switch
   * increments it, and callbacks that arrive with an older value are ignored.
   */
  readonly generation: number;
  /**
   * Token of the pending automatic advance, or null when none is scheduled.
   * A timer may only advance the reel with the token it was scheduled for, so
   * cancelling (or replacing) the wait makes any late timer harmless.
   */
  readonly pendingAdvance: number | null;
  /** Next token to hand out; monotonically increasing. */
  readonly nextToken: number;
}

export type ReelAction =
  /** The user picked a film in the queue or pressed "Next preview". */
  | { type: 'select'; index: number }
  /** The current player reports that the preview window played through. */
  | { type: 'ended'; generation: number }
  /** The current player reports that the preview cannot play. */
  | { type: 'failed'; generation: number }
  /** The user replayed the preview from its end card. */
  | { type: 'replay'; generation: number }
  /** The auto-advance switch was toggled. */
  | { type: 'set-auto'; on: boolean }
  /** The advance timer for `token` fired. */
  | { type: 'auto-advance'; token: number }
  /** The payload's film list changed (initially, or on a new tool result). */
  | { type: 'set-payload'; key: string; total: number };

export function initReel(total: number): ReelState {
  return {
    total: Math.max(0, total),
    payloadKey: '',
    index: 0,
    phase: 'playing',
    failures: 0,
    autoAdvance: true,
    stopped: false,
    generation: 0,
    pendingAdvance: null,
    nextToken: 1,
  };
}

const hasNext = (s: ReelState) => s.index < s.total - 1;

/** Whether an automatic move is currently allowed: not last, not stopped, auto on. */
export function canAutoAdvance(s: ReelState): boolean {
  return s.autoAdvance && !s.stopped && s.failures < REEL_MAX_CONSECUTIVE_FAILURES && s.total > 1 && hasNext(s);
}

/**
 * Issues a fresh advance token when the reel may move on; otherwise makes sure
 * no stale token remains. A new token (rather than reusing the old) is what
 * lets the view's timer effect restart the full delay when auto-advance is
 * turned back on over a card.
 */
function withSchedule(s: ReelState): ReelState {
  if (!canAutoAdvance(s)) {
    return s.pendingAdvance === null ? s : { ...s, pendingAdvance: null };
  }
  return { ...s, pendingAdvance: s.nextToken, nextToken: s.nextToken + 1 };
}

function cancelPending(s: ReelState): ReelState {
  return s.pendingAdvance === null ? s : { ...s, pendingAdvance: null };
}

const normalizeIndex = (index: number, total: number) => (total <= 0 ? 0 : ((index % total) + total) % total);

export function reelReducer(state: ReelState, action: ReelAction): ReelState {
  switch (action.type) {
    case 'set-payload': {
      const total = Math.max(0, action.total);
      if (action.key === state.payloadKey && total === state.total) {
        return state;
      }
      // Before the first payload arrives there is no player to reset: only
      // record the list, so the first preview mounts once, not twice.
      if (state.payloadKey === '' && state.total === 0) {
        return { ...state, payloadKey: action.key, total };
      }
      // A new tool result is a new reel session: start at the first film, count
      // failures afresh and drop any pending advance. The generation bump
      // remounts the player, so a late callback from the old one is ignored.
      return {
        ...state,
        payloadKey: action.key,
        total,
        index: 0,
        phase: 'playing',
        failures: 0,
        stopped: false,
        generation: state.generation + 1,
        pendingAdvance: null,
      };
    }

    case 'select': {
      if (state.total <= 0) {
        return state;
      }
      const index = normalizeIndex(action.index, state.total);
      // Picking the film that is already playing does nothing: the card's own
      // Replay restarts it. Picking it while it shows an end or error card (or
      // after the reel stopped) does restart it below.
      if (index === state.index && state.phase === 'playing' && !state.stopped) {
        return state;
      }
      // Any manual pick is a new reel session for the failure budget, and it
      // always restarts the preview (a fresh generation tears the old player
      // down before the new one mounts) and cancels a pending automatic move.
      return {
        ...state,
        index,
        phase: 'playing',
        failures: 0,
        stopped: false,
        generation: state.generation + 1,
        pendingAdvance: null,
      };
    }

    case 'ended': {
      if (action.generation !== state.generation || state.phase !== 'playing') {
        return state;
      }
      // A preview that played through breaks the failure streak.
      return withSchedule({ ...state, phase: 'ended', failures: 0 });
    }

    case 'failed': {
      if (action.generation !== state.generation || state.phase !== 'playing') {
        return state;
      }
      const failures = state.failures + 1;
      return withSchedule({
        ...state,
        phase: 'error',
        failures,
        stopped: failures >= REEL_MAX_CONSECUTIVE_FAILURES,
      });
    }

    case 'replay': {
      if (action.generation !== state.generation || state.phase !== 'ended') {
        return state;
      }
      return { ...cancelPending(state), phase: 'playing', failures: 0 };
    }

    case 'set-auto': {
      const autoAdvance = action.on;
      if (!autoAdvance) {
        return { ...cancelPending(state), autoAdvance };
      }
      // Turning auto-advance back on while an end or error card is up starts a
      // fresh wait for that card; it never jumps immediately.
      const next = { ...state, autoAdvance };
      if (state.pendingAdvance === null && (state.phase === 'ended' || state.phase === 'error')) {
        return withSchedule(next);
      }
      return next;
    }

    case 'auto-advance': {
      // The token is the whole cancellation mechanism: a timer that was
      // replaced or cancelled carries a token the state no longer holds.
      if (action.token !== state.pendingAdvance) {
        return state;
      }
      if (!canAutoAdvance(state) || (state.phase !== 'ended' && state.phase !== 'error')) {
        return cancelPending(state);
      }
      return {
        ...state,
        index: state.index + 1,
        phase: 'playing',
        generation: state.generation + 1,
        pendingAdvance: null,
      };
    }
  }
}
