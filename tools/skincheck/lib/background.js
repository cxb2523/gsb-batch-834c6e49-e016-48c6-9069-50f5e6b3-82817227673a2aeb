'use strict';

const { parseColor, toHex, mixColor } = require('./color');
const { clamp } = require('./geometry');

/*
 * Background colour: a pure function of the *track's playback position*.
 *
 * There is deliberately no clock in here. Wall time is never read. That makes
 * the guarantees the spec asks for true by construction:
 *
 *   - a new track starts at position 0, so the cycle starts at its first
 *     colour again;
 *   - scrubbing moves the position and therefore the colour, forward or back;
 *   - pausing freezes the position, so `while: "always"` holds the colour it
 *     had reached, and `while: "playing"` shows the first colour;
 *   - leaving the tape view and coming back cannot advance the colour, because
 *     nothing accumulated while away.
 *
 * Playback input:
 *   { position: seconds, paused: bool, active: bool }
 * `active` false means there is no track at all (stopped / empty queue); it is
 * treated like paused for the `playing` mode and like a frozen position for
 * `always`.
 */

/**
 * @param {object|null} bg      normalized background from loadSkin()
 * @param {{position:number, paused:boolean, active?:boolean}} playback
 * @returns {{color:string, index:number, fraction:number, phase:number,
 *            held:boolean}}
 */
function backgroundAt(bg, playback) {
  if (!bg) {
    return { color: '#000000', index: 0, fraction: 0, phase: 0, held: true, static: true };
  }
  if (bg.kind === 'static') {
    return { color: bg.colors[0], index: 0, fraction: 0, phase: 0, held: true, static: true };
  }

  const colors = bg.colors.map(parseColor);
  const n = colors.length;
  const seconds = bg.seconds;
  const paused = !playback || playback.paused || playback.active === false;
  const position = playback && Number.isFinite(playback.position)
    ? Math.max(0, playback.position)
    : 0;

  if (n === 1) {
    return { color: toHex(colors[0]), index: 0, fraction: 0, phase: 0, held: paused, static: false };
  }

  // while: "playing" -> first colour whenever not playing. "always" -> the
  // colour at the frozen position (which, if paused, is simply where we are).
  if (paused && bg.while === 'playing') {
    return {
      color: toHex(colors[0]),
      index: 0,
      fraction: 0,
      phase: 0,
      held: true,
      static: false,
    };
  }

  const cycle = n * seconds;
  const phase = position % cycle;
  const index = clamp(Math.floor(phase / seconds), 0, n - 1);
  const frac = clamp((phase - index * seconds) / seconds, 0, 1);
  const next = colors[(index + 1) % n];

  let rgb;
  if (bg.blend === 'step' || frac === 0) {
    rgb = colors[index];
  } else {
    rgb = mixColor(colors[index], next, frac);
  }

  return {
    color: toHex(rgb),
    index,
    fraction: bg.blend === 'step' ? 0 : frac,
    phase,
    held: paused,
    static: false,
  };
}

/**
 * Convenience: the colour at a position, with optional helpers for tests.
 * Same as backgroundAt().color.
 */
function backgroundColor(bg, playback) {
  return backgroundAt(bg, playback).color;
}

module.exports = { backgroundAt, backgroundColor };
