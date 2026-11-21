'use strict';

/*
 * Limits and defaults transcribed from SKINS.html.
 * The numbers here are the contract the executable reference checks against.
 */

const LIMITS = Object.freeze({
  jsonBytes: 32 * 1024,
  areas: 8,
  lines: 4,
  pieces: 6,
  pieceBytes: 47,
  colors: 6,
  // A design canvas is a drawing size, not a coordinate that can be trusted
  // to a 32-bit signed int. 16384 is far past either real screen.
  maxDesign: 16384,
  // Coordinates are clamped before arithmetic so a hostile skin.json cannot
  // overflow the integer scale maths.
  maxPixel: 10000000,
});

const SCREENS = Object.freeze({
  psp: Object.freeze({ key: 'psp', width: 480, height: 272 }),
  vita: Object.freeze({ key: 'vita', width: 960, height: 544 }),
});

const TEXT_DEFAULTS = Object.freeze({
  size: 14,
  align: 'left',
  lineGap: 2,
});

const BACKGROUND_DEFAULTS = Object.freeze({
  seconds: 6,
  blend: 'fade',
  while: 'playing',
});

const FIELDS = Object.freeze([
  'title',
  'artist',
  'album',
  'track',
  'playlist',
]);

const FALLBACK_COLOR = '#000000';
const LIGHT_TEXT = '#202020';
const DARK_TEXT = '#F0F0F0';

module.exports = {
  LIMITS,
  SCREENS,
  TEXT_DEFAULTS,
  BACKGROUND_DEFAULTS,
  FIELDS,
  FALLBACK_COLOR,
  LIGHT_TEXT,
  DARK_TEXT,
};
