'use strict';

const { backgroundAt } = require('./background');

/*
 * Playback position, and the only thing the background is allowed to depend on.
 *
 * `tick(positionFromDecoder)` is the host's once-a-frame call: it forwards the
 * position the decoder reports. There is no wall clock in this file, so:
 *
 *   - setTrack() resets to 0, and the background starts at its first colour;
 *   - seek() moves the position, and the colour moves with it;
 *   - while paused, tick() does not advance (a paused decoder reports the same
 *     position), so the background holds;
 *   - while the tape view is not visible, the host stops calling tick(), and
 *     returning finds the position exactly where it was.
 *
 * The player also passes `duration` so a seek can be clamped and the cycle
 * can be checked at the very end of a track.
 */
function createPlayback(options = {}) {
  const hasTrack = options.trackId !== undefined && options.trackId !== null;
  const state = {
    trackId: hasTrack ? options.trackId : null,
    position: 0,
    duration: Number.isFinite(options.duration) ? options.duration : 0,
    paused: options.paused !== undefined ? !!options.paused : !hasTrack,
    active: options.active !== undefined ? !!options.active : hasTrack,
    visible: true,
    // Diagnostics: count of position changes caused by a track switch.
    trackSwitches: 0,
  };

  function clampPosition(p) {
    if (!Number.isFinite(p)) return 0;
    const lo = 0;
    const hi = state.duration > 0 ? state.duration : Infinity;
    return Math.max(lo, Math.min(hi, p));
  }

  return {
    /** Start a different track. Same id is a no-op so a re-render cannot reset it. */
    setTrack(trackId, duration) {
      if (trackId === state.trackId) {
        if (Number.isFinite(duration)) state.duration = duration;
        return false;
      }
      state.trackId = trackId;
      state.position = 0;
      state.active = true;
      state.paused = false;
      if (Number.isFinite(duration)) state.duration = duration;
      state.trackSwitches += 1;
      return true;
    },
    /** The decoder's current position. Ignored while paused, which is what holds the colour. */
    tick(position) {
      if (!state.active || state.paused) return state.position;
      state.position = clampPosition(position);
      return state.position;
    },
    /** Scrubbing: the UI owns the position while the user drags. */
    seek(position) {
      state.position = clampPosition(position);
      return state.position;
    },
    pause() { state.paused = true; },
    resume() { state.paused = false; },
    /**
     * No track at all (the queue ended, or playback was stopped). The position
     * is deliberately kept: `while: "playing"` shows the first colour anyway,
     * and `while: "always"` should hold the colour it had reached rather than
     * snap back as though a new track had started.
     */
    stop() {
      state.active = false;
      state.paused = true;
    },
    /**
     * Back from another view. The host passes the decoder's position as it is
     * now, because the music kept playing while the tape deck was away. With
     * no position (a paused decoder), the stored position is kept.
     */
    enterTapeView(position) {
      state.visible = true;
      if (Number.isFinite(position) && state.active && !state.paused) {
        state.position = clampPosition(position);
      }
    },
    leaveTapeView() { state.visible = false; },
    get state() { return { ...state }; },
    /** The background colour for the current state. */
    colorFor(background) {
      return backgroundAt(background, {
        position: state.position,
        paused: state.paused,
        active: state.active,
      });
    },
  };
}

module.exports = { createPlayback };
