'use strict';

const { LIMITS, SCREENS } = require('./constants');

function roundHalfUp(value) {
  // Math.round already rounds .5 toward +Infinity; every coordinate we feed it
  // is non-negative after the finite check, so this is a stable definition.
  return Math.round(value);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Resolve the `design` key to a canvas.
 * Accepted forms:
 *   "psp"  -> 480 x 272 (the default when the key is absent)
 *   "vita" -> 960 x 544
 *   [w, h] -> a custom design canvas
 * Anything else falls back to the PSP canvas and reports a warning.
 */
function resolveDesign(raw) {
  if (raw === undefined || raw === null) {
    return { canvas: SCREENS.psp, declared: 'psp', warning: null };
  }
  if (typeof raw === 'string') {
    const key = raw.toLowerCase();
    if (key === 'psp') return { canvas: SCREENS.psp, declared: 'psp', warning: null };
    if (key === 'vita') return { canvas: SCREENS.vita, declared: 'vita', warning: null };
    return {
      canvas: SCREENS.psp,
      declared: raw,
      warning: `design "${raw}" is not "psp" or "vita"; using the 480 x 272 default`,
    };
  }
  if (Array.isArray(raw) && raw.length === 2 && raw.every(isFiniteNumber)) {
    const [w, h] = raw.map((n) => Math.trunc(n));
    if (w >= 1 && h >= 1 && w <= LIMITS.maxDesign && h <= LIMITS.maxDesign) {
      return {
        canvas: { key: 'custom', width: w, height: h },
        declared: [w, h],
        warning: null,
      };
    }
  }
  return {
    canvas: SCREENS.psp,
    declared: raw,
    warning: 'design must be "psp", "vita" or [width, height]; using the 480 x 272 default',
  };
}

/** Target screen from its key; unknown keys are a programming error. */
function resolveScreen(key) {
  const screen = SCREENS[key];
  if (!screen) throw new Error(`unknown screen "${key}"`);
  return screen;
}

/** The scale factors from a design canvas to a target screen. */
function scaleFor(design, screen) {
  return {
    x: screen.width / design.width,
    y: screen.height / design.height,
  };
}

/**
 * Convert a design-space rect to screen space, then clip it to the screen.
 *
 * The result always has integer coordinates. A rect that ends up with no
 * width or height is marked `skipped` so callers do not try to draw into it.
 *
 * Clipping is done on both edges after scaling, so a rect that starts off the
 * left/top and one that runs off the right/bottom both come back trimmed
 * rather than translated.
 */
function convertRect(rect, scale, screen) {
  const [dx, dy, dw, dh] = rect;
  const x = roundHalfUp(dx * scale.x);
  const y = roundHalfUp(dy * scale.y);
  const w = roundHalfUp(dw * scale.x);
  const h = roundHalfUp(dh * scale.y);

  const x0 = clamp(x, 0, screen.width);
  const y0 = clamp(y, 0, screen.height);
  const x1 = clamp(x + w, 0, screen.width);
  const y1 = clamp(y + h, 0, screen.height);

  const out = {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
    skipped: false,
    reason: null,
    clipped: x0 !== x || y0 !== y || x1 !== x + w || y1 !== y + h,
  };

  if (w <= 0 || h <= 0) {
    out.skipped = true;
    out.reason = 'empty-rect';
  } else if (out.width === 0 || out.height === 0) {
    out.skipped = true;
    out.reason = 'outside-screen';
  }
  return out;
}

/** Scale a single pixel quantity (font size, line gap) by one axis. */
function convertPixels(value, factor, floor = 1) {
  const scaled = roundHalfUp(value * factor);
  return Math.max(floor, scaled);
}

module.exports = {
  roundHalfUp,
  clamp,
  isFiniteNumber,
  resolveDesign,
  resolveScreen,
  scaleFor,
  convertRect,
  convertPixels,
  LIMITS,
};
