'use strict';

/*
 * Expectations for the shipped samples. `node tools/skincheck/cli.js
 * samples/<name>/skin.json --verify` checks one; `npm test` runs them all.
 *
 * Each entry is a function of (described, skin, track) returning a list of
 * failures. A failure is a string; an empty list passes.
 */

const assert = require('assert');

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    return null;
  } catch (err) {
    return `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  }
}

const SAMPLES = {
  /*
   * The PSP design at Vita size. Every number doubles:
   *   [91, 31, 263, 22] -> [182, 62, 526, 44]
   *   [91, 58, 263, 16] -> [182, 116, 526, 32]
   *   [400, 240, 70, 22] -> [800, 480, 140, 44]
   * size 11 -> 22, 12 -> 24; line spacing 2 -> 4.
   */
  'psp-label': (described, skin, track, ctx) => {
    const fails = [];
    if (ctx.screen === 'vita') {
      fails.push(
        eq(described.scale.x, 2, 'scale.x'),
        eq(described.scale.y, 2, 'scale.y'),
        eq(described.areas.map((a) => a.rect), [
          { x: 182, y: 62, width: 526, height: 44 },
          { x: 182, y: 116, width: 526, height: 32 },
          { x: 800, y: 480, width: 140, height: 44 },
        ], 'rects'),
        eq(described.areas.map((a) => a.lines[0].size), [22, 24, 24], 'sizes'),
        eq(described.areas[0].lines[0].text, 'Power, Corruption & Lies: New Order', 'album: artist'),
      );
      // Lines sit two design pixels apart -> four Vita pixels.
      const l0 = described.areas[0].lines[0];
      fails.push(eq(l0.y, 73, 'first line y'));
    } else {
      fails.push(
        eq(described.areas[0].rect, { x: 91, y: 31, width: 263, height: 22 }, 'psp rect'),
        eq(described.areas[0].lines[0].size, 11, 'psp size'),
      );
    }
    return fails.filter(Boolean);
  },

  /* A Vita design on a PSP: every number halves; nothing survives rounding to 0. */
  'vita-label': (described, skin, track, ctx) => {
    const fails = [];
    if (ctx.screen === 'psp') {
      fails.push(
        eq(described.scale.x, 0.5, 'scale.x'),
        eq(described.areas.map((a) => a.rect), [
          { x: 62, y: 18, width: 356, height: 22 },
          { x: 62, y: 44, width: 356, height: 20 },
          { x: 62, y: 68, width: 356, height: 30 },
        ], 'half-size rects'),
        eq(described.areas.map((a) => a.lines[0].size), [11, 13, 8], 'sizes')
      );
    } else {
      fails.push(eq(described.scale.x, 1, 'identity scale'));
      fails.push(eq(described.areas[0].rect, { x: 124, y: 36, width: 712, height: 44 }, 'vita rect'));
    }
    return fails.filter(Boolean);
  },

  /* Missing artist: the separator disappears, not just the empty field. */
  'missing-artist': (described) => {
    const text = described.areas[0] ? described.areas[0].lines.map((l) => l.text) : [];
    return [
      eq(text, ['Basement Tapes', 'Side A · Untitled Demo', 'Basement Tapes'], 'lines'),
    ].filter(Boolean);
  },

  /* A long title shrinks three times and then ends in "...". */
  'long-title': (described) => {
    const fails = [];
    const [wide, narrow] = described.areas;
    fails.push(eq(wide.lines[0].shrinkSteps, 3, 'wide shrink steps'));
    fails.push(eq(wide.lines[0].truncated, true, 'wide truncated'));
    fails.push(eq(narrow.lines[0].truncated, true, 'narrow truncated'));
    // The narrow one must be visibly shorter than the wide one.
    if (!(narrow.lines[0].text.length < wide.lines[0].text.length)) {
      fails.push('narrow line should be shorter than the wide line');
    }
    fails.push(eq(wide.lines[0].text.endsWith('...'), true, 'ellipsis'));
    return fails.filter(Boolean);
  },

  /* Eight areas, four lines, six pieces: read up to each cap and drop the rest. */
  'max-limits': (described, skin) => {
    const fails = [];
    fails.push(eq(described.areas.length, 8, 'area count'));
    fails.push(eq(skin.background.colors.length, 6, 'background colour cap'));
    fails.push(eq(described.warnings.some((w) => /more than 8 areas/.test(w)), true, 'area warning'));
    fails.push(eq(described.warnings.some((w) => /more than 4 lines/.test(w)), true, 'line warning'));
    // The 6-piece line lost its 7th and 8th piece.
    const sixPiece = described.areas[1].lines[0].text;
    fails.push(eq(/\/\s*$/.test(sixPiece), false, 'trailing separator dropped'));
    return fails.filter(Boolean);
  },

  /* Clipping: rects that leave the screen are trimmed; empty ones are skipped. */
  edges: (described, skin, track, ctx) => {
    const fails = [];
    const k = ctx.screen === 'vita' ? 2 : 1;
    fails.push(eq(described.areas.length, 3, 'drawn areas'));
    fails.push(eq(described.areas[0].rect, { x: 400 * k, y: 10 * k, width: 80 * k, height: 20 * k }, 'right clip'));
    fails.push(eq(described.areas[1].rect, { x: 0, y: 120 * k, width: 80 * k, height: 20 * k }, 'left clip'));
    fails.push(eq(described.areas[2].rect, { x: 20 * k, y: 240 * k, width: 200 * k, height: 32 * k }, 'bottom clip'));
    // The two zero-size rects and the fully off-screen one never appear.
    fails.push(eq(skin.areas.length, 3, 'areas after skip'));
    return fails.filter(Boolean);
  },

  /* Bad JSON: no text, black background, no crash. */
  'broken-json': (described, skin) => {
    return [
      eq(skin.degraded, true, 'degraded'),
      eq(described.areas.length, 0, 'no areas'),
      eq(skin.backgroundColor, '#000000', 'black background'),
    ].filter(Boolean);
  },

  /* Step background: four colours ten seconds each, held while paused. */
  'step-background': (described, skin) => {
    const { backgroundAt } = require('./lib/background');
    const fails = [];
    const bg = skin.background;
    fails.push(eq(bg.seconds, 10, 'seconds'));
    fails.push(eq(bg.blend, 'step', 'blend'));
    fails.push(eq(bg.while, 'always', 'while'));
    fails.push(eq(backgroundAt(bg, { position: 0, paused: false }).color, '#FF0000', 't=0'));
    fails.push(eq(backgroundAt(bg, { position: 9.999, paused: false }).color, '#FF0000', 't<10'));
    fails.push(eq(backgroundAt(bg, { position: 10, paused: false }).color, '#00FF00', 't=10'));
    fails.push(eq(backgroundAt(bg, { position: 39.5, paused: false }).color, '#FFFF00', 't=39.5'));
    fails.push(eq(backgroundAt(bg, { position: 40, paused: false }).color, '#FF0000', 'wrapped'));
    // while: always, paused -> the frozen colour stays.
    fails.push(eq(backgroundAt(bg, { position: 25, paused: true }).color, '#0000FF', 'always holds'));
    return fails.filter(Boolean);
  },

  /* Over 32 KB: ignored wholesale rather than half-read. */
  oversize: (described, skin) => [
    eq(skin.degraded, true, 'degraded'),
    eq(skin.degradationReason, 'json-too-large', 'reason'),
    eq(described.areas.length, 0, 'no areas'),
    eq(skin.backgroundColor, '#000000', 'black background'),
  ].filter(Boolean),

  'no-text': (described) => [
    eq(described.areas.length, 0, 'no areas'),
  ].filter(Boolean),
};

function verifySample(name, described, skin, track, ctx = {}) {
  const entry = SAMPLES[name];
  if (!entry) {
    console.error(`no sample named "${name}"`);
    return false;
  }
  const fails = entry(described, skin, track, ctx).filter(Boolean);
  if (fails.length) {
    console.error(`${name} FAILED:`);
    for (const f of fails) console.error(`  - ${f}`);
    return false;
  }
  console.log(`${name}: ok`);
  return true;
}

module.exports = { SAMPLES, verifySample };