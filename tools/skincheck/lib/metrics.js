'use strict';

/*
 * Deterministic stand-in for the PSP system font, used by the reference
 * renderer and the samples. It is not the console's glyph table: TRAX measures
 * the real font on the machine. What this models is the *fitting* algorithm,
 * which is what the spec pins down:
 *
 *   - a line is laid out at `size`; if wider than the area it is tried at
 *     0.88, 0.88^2 and 0.88^3 of `size` (three steps, ~0.68 of the original);
 *   - if it still does not fit, it is cut and "..." appended.
 *
 * Advance widths: Latin/digits/punctuation ~0.55 em, CJK/fullwidth 1 em.
 * Override `measure` to supply real metrics.
 */

function isWide(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

/** Width of `text` at `size` px in the model font. */
function measure(text, size) {
  let em = 0;
  for (const ch of text) em += isWide(ch.codePointAt(0)) ? 1 : 0.55;
  return em * size;
}

const SHRINK_STEPS = 3;
const SHRINK_FACTOR = 0.88;

/**
 * Fit one line into `maxWidth`.
 * Returns { text, size, steps, truncated }.
 * The returned size is the largest of size, 0.88*size, 0.88^2*size,
 * 0.88^3*size that fits; if none fits, the last size is used and the text is
 * truncated with "...".
 */
function fitLine(text, size, maxWidth, measureFn = measure) {
  let candidate = text;
  let chosen = size;
  for (let step = 0; step <= SHRINK_STEPS; step += 1) {
    const s = size * Math.pow(SHRINK_FACTOR, step);
    if (measureFn(candidate, s) <= maxWidth) {
      return { text: candidate, size: s, steps: step, truncated: false };
    }
    chosen = s;
  }
  // Still too wide at the smallest size. Cut by code point, keeping "...".
  const dots = '...';
  const available = maxWidth - measureFn(dots, chosen);
  if (available <= 0) {
    return { text: '', size: chosen, steps: SHRINK_STEPS, truncated: true };
  }
  let out = '';
  for (const ch of text) {
    const next = out + ch;
    if (measureFn(next, chosen) > available) break;
    out = next;
  }
  return { text: out + dots, size: chosen, steps: SHRINK_STEPS, truncated: true };
}

module.exports = { measure, fitLine, isWide, SHRINK_STEPS, SHRINK_FACTOR };
