'use strict';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Parse "#RRGGBB". Anything else is not a color and comes back null. */
function parseColor(value) {
  if (typeof value !== 'string' || !COLOR_RE.test(value)) return null;
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function toHex(color) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    clamp(color.r).toString(16).padStart(2, '0') +
    clamp(color.g).toString(16).padStart(2, '0') +
    clamp(color.b).toString(16).padStart(2, '0')
  ).toUpperCase();
}

/** Linear blend; t is clamped to [0, 1]. */
function mixColor(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
  };
}

/** Relative luminance on the sRGB values, 0 (black) to 1 (white). */
function luminance(color) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

module.exports = { parseColor, toHex, mixColor, luminance };
