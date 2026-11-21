'use strict';

/*
 * Unit tests for the reference implementation. Node's built-in test runner;
 * no dependencies.
 *
 *   node --test tools/skincheck/test/
 */

const test = require('node:test');
const assert = require('node:assert');

const { loadSkin } = require('../lib/skin');
const { layoutSkin } = require('../lib/layout');
const { backgroundAt } = require('../lib/background');
const { createPlayback } = require('../lib/playback');
const { createSkinController } = require('../lib/lifecycle');
const { assembleLine, truncateToBytes, utf8Bytes } = require('../lib/text');
const { fitLine, measure } = require('../lib/metrics');
const { resolveDesign, convertRect, scaleFor, convertPixels } = require('../lib/geometry');
const { SCREENS, LIMITS } = require('../lib/constants');

const TRACK = {
  title: 'Blue Monday',
  artist: 'New Order',
  album: 'Power, Corruption & Lies',
  track: '3/12',
  playlist: 'Power, Corruption & Lies',
};

function skinOf(doc) {
  return loadSkin(JSON.stringify(doc), { screen: 'psp' });
}

// ---------------------------------------------------------------- geometry

test('design defaults to the PSP 480 x 272 canvas', () => {
  const { canvas } = resolveDesign(undefined);
  assert.deepStrictEqual(canvas, SCREENS.psp);
});

test('design "vita" resolves to 960 x 544 and an unknown design falls back', () => {
  assert.deepStrictEqual(resolveDesign('vita').canvas, SCREENS.vita);
  const bad = resolveDesign('gameboy');
  assert.deepStrictEqual(bad.canvas, SCREENS.psp);
  assert.match(bad.warning, /gameboy/);
});

test('a PSP-designed rect doubles on a Vita', () => {
  const scale = scaleFor(SCREENS.psp, SCREENS.vita);
  const r = convertRect([91, 31, 263, 22], scale, SCREENS.vita);
  assert.deepStrictEqual(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    { x: 182, y: 62, width: 526, height: 44 }
  );
  assert.strictEqual(r.skipped, false);
});

test('a Vita-designed rect halves on a PSP', () => {
  const scale = scaleFor(SCREENS.vita, SCREENS.psp);
  const r = convertRect([182, 62, 526, 44], scale, SCREENS.psp);
  assert.deepStrictEqual(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    { x: 91, y: 31, width: 263, height: 22 }
  );
});

test('rects are clipped to the screen on every edge', () => {
  const scale = { x: 1, y: 1 };
  const right = convertRect([400, 10, 200, 20], scale, SCREENS.psp);
  assert.deepStrictEqual([right.x, right.width], [400, 80]);
  const left = convertRect([-40, 120, 120, 20], scale, SCREENS.psp);
  assert.deepStrictEqual([left.x, left.width], [0, 80]);
  const bottom = convertRect([20, 240, 200, 80], scale, SCREENS.psp);
  assert.deepStrictEqual([bottom.y, bottom.height], [240, 32]);
  const top = convertRect([20, -30, 200, 50], scale, SCREENS.psp);
  assert.deepStrictEqual([top.y, top.height], [0, 20]);
});

test('a zero-size rect is skipped, and so is one entirely off-screen', () => {
  const scale = { x: 1, y: 1 };
  assert.strictEqual(convertRect([20, 20, 0, 40], scale, SCREENS.psp).skipped, true);
  assert.strictEqual(convertRect([20, 20, 40, 0], scale, SCREENS.psp).skipped, true);
  assert.strictEqual(convertRect([900, 400, 50, 20], scale, SCREENS.psp).skipped, true);
});

test('pixel quantities round half up and never go below 1', () => {
  assert.strictEqual(convertPixels(11, 2, 1), 22);
  assert.strictEqual(convertPixels(1, 0.5, 1), 1);
  assert.strictEqual(convertPixels(3, 0.5, 1), 2); // 1.5 rounds up
});

test('an explicit canvas converts from its own size', () => {
  const scale = scaleFor({ key: 'custom', width: 640, height: 360 }, SCREENS.vita);
  // 640 x 360 is not the Vita's aspect, so each axis scales independently and
  // the full canvas fills the screen exactly.
  const r = convertRect([0, 0, 640, 360], scale, SCREENS.vita);
  assert.deepStrictEqual([r.width, r.height], [960, 544]);
  const skin = loadSkin(
    JSON.stringify({ design: [640, 360], areas: [{ rect: [0, 0, 640, 360], lines: ['title'] }] }),
    { screen: 'vita' }
  );
  assert.strictEqual(skin.areas[0].rect.width, 960);
  assert.strictEqual(skin.areas[0].rect.height, 544);
  assert.strictEqual(skin.areas[0].rect.y, 0);
});

test('a custom canvas must be sane or the PSP default is used', () => {
  assert.deepStrictEqual(resolveDesign([0, 200]).canvas, SCREENS.psp);
  assert.deepStrictEqual(resolveDesign([-10, 200]).canvas, SCREENS.psp);
  assert.deepStrictEqual(resolveDesign([200000, 200]).canvas, SCREENS.psp);
  assert.deepStrictEqual(resolveDesign([640]).canvas, SCREENS.psp);
});

// -------------------------------------------------------------------- text

test('album: artist drops the colon when the artist is missing', () => {
  const line = ['album', ': ', 'artist'];
  assert.strictEqual(assembleLine(line, TRACK), 'Power, Corruption & Lies: New Order');
  assert.strictEqual(assembleLine(line, { ...TRACK, artist: null }), 'Power, Corruption & Lies');
});

test('leading text before a missing field prints nothing', () => {
  assert.strictEqual(assembleLine(['Side A · ', 'title'], { ...TRACK, title: null }), '');
  assert.strictEqual(assembleLine(['Side A · ', 'title'], TRACK), 'Side A · Blue Monday');
});

test('trailing text after a missing last field is dropped', () => {
  assert.strictEqual(assembleLine(['artist', ' — ', 'album'], { ...TRACK, album: null }), 'New Order');
});

test('a line with no field is printed as written', () => {
  assert.strictEqual(assembleLine(['SIDE A'], TRACK), 'SIDE A');
  assert.strictEqual(assembleLine('C-90', TRACK), 'C-90');
});

test('an empty line prints nothing', () => {
  assert.strictEqual(assembleLine(['title'], { title: null }), '');
});

test('line assembly is capped at six pieces', () => {
  // The 7th piece ("track") is never read, so it cannot reach the output.
  const line = ['title', ' / ', 'artist', ' / ', 'album', ' !!', 'track'];
  assert.strictEqual(
    assembleLine(line, TRACK),
    'Blue Monday / New Order / Power, Corruption & Lies !!'
  );
});

test('a piece is capped at 47 bytes and never splits a character', () => {
  const long = 'あ'.repeat(40); // 120 bytes
  const cut = truncateToBytes(long, LIMITS.pieceBytes);
  assert.ok(utf8Bytes(cut) <= LIMITS.pieceBytes);
  assert.ok(cut.endsWith('...'));
  // No lone replacement character or broken code point.
  assert.strictEqual(cut.includes('�'), false);
});

// -------------------------------------------------------------------- fit

test('a line that fits is left at its size', () => {
  const r = fitLine('short', 14, 400);
  assert.strictEqual(r.size, 14);
  assert.strictEqual(r.steps, 0);
  assert.strictEqual(r.truncated, false);
});

test('too wide shrinks three times, to 0.88^3 of the size', () => {
  const size = 14;
  const width = measure('abcdefghij', size) * 0.7; // fits only after shrinking
  const r = fitLine('abcdefghij', size, width);
  assert.ok(r.steps >= 1 && r.steps <= 3);
  assert.strictEqual(r.truncated, false);
});

test('still too wide truncates at the smallest size with three dots', () => {
  const r = fitLine('The Rise and Fall of Ziggy Stardust', 14, 40);
  assert.strictEqual(r.steps, 3);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.text.endsWith('...'));
  assert.ok(Math.abs(r.size / 14 - Math.pow(0.88, 3)) < 1e-9);
});

test('never shrinks past 0.88^3 of size', () => {
  const r = fitLine('x'.repeat(200), 20, 1);
  assert.ok(r.size >= 20 * Math.pow(0.88, 3) - 1e-9);
});

// ------------------------------------------------------------------ limits

test('more than eight areas: the rest are ignored with a warning', () => {
  const areas = [];
  for (let i = 0; i < 10; i += 1) {
    areas.push({ rect: [10, 10 + i * 20, 100, 16], lines: ['title'] });
  }
  const skin = skinOf({ areas });
  assert.strictEqual(skin.areas.length, 8);
  assert.ok(skin.warnings.some((w) => /more than 8 areas/.test(w)));
});

test('more than four lines in an area: the rest are ignored', () => {
  const skin = skinOf({
    areas: [{ rect: [10, 10, 200, 100], lines: ['title', 'artist', 'album', 'track', 'playlist'] }],
  });
  assert.strictEqual(skin.areas[0].lines.length, 4);
  assert.ok(skin.warnings.some((w) => /more than 4 lines/.test(w)));
});

test('more than six background colours: the rest are ignored', () => {
  const colors = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006', '#000007'];
  const skin = skinOf({ background: { colors } });
  assert.strictEqual(skin.background.colors.length, 6);
  assert.strictEqual(skin.background.colors[5], '#000006');
});

test('a skin.json over 32 KB is ignored: no text, black', () => {
  const big = JSON.stringify({ areas: [{ rect: [0, 0, 10, 10], lines: ['x'.repeat(40)] }] });
  const padded = big + ' '.repeat(LIMITS.jsonBytes);
  const skin = loadSkin(padded, { screen: 'psp' });
  assert.strictEqual(skin.degraded, true);
  assert.strictEqual(skin.areas.length, 0);
  assert.strictEqual(skin.backgroundColor, '#000000');
});

test('invalid JSON degrades to no text and a black background', () => {
  const skin = loadSkin('{ "areas": [ }', { screen: 'psp' });
  assert.strictEqual(skin.degraded, true);
  assert.strictEqual(skin.areas.length, 0);
  assert.strictEqual(skin.backgroundColor, '#000000');
});

test('missing skin.json is no text and black, not a crash', () => {
  const skin = loadSkin(null, { screen: 'vita' });
  assert.strictEqual(skin.degraded, true);
  assert.strictEqual(skin.areas.length, 0);
  assert.strictEqual(skin.backgroundColor, '#000000');
});

test('an unreadable colour is ignored rather than fatal', () => {
  const skin = skinOf({ background: '#FFF', areas: [{ rect: [0, 0, 100, 20], color: 'white' }] });
  assert.strictEqual(skin.background.colors[0], '#000000');
  assert.strictEqual(skin.areas[0].color, null);
});

// ---------------------------------------------------------- conversion caps

test('conversion still honours all caps at Vita size', () => {
  const areas = [];
  for (let i = 0; i < 10; i += 1) {
    areas.push({
      rect: [10, 10 + i * 20, 100, 16],
      lines: ['title', 'artist', 'album', 'track', 'playlist'],
    });
  }
  const skin = loadSkin(
    JSON.stringify({ design: 'psp', areas, background: { colors: Array(9).fill('#101010') } }),
    { screen: 'vita' }
  );
  assert.strictEqual(skin.areas.length, 8);
  assert.strictEqual(skin.areas[0].lines.length, 4);
  assert.strictEqual(skin.background.colors.length, 6);
  // Every converted rect is inside the Vita screen.
  for (const a of skin.areas) {
    assert.ok(a.rect.x >= 0 && a.rect.y >= 0);
    assert.ok(a.rect.x + a.rect.width <= 960);
    assert.ok(a.rect.y + a.rect.height <= 544);
  }
});

test('line spacing scales with the screen', () => {
  const doc = {
    areas: [{ rect: [10, 10, 400, 200], size: 10, lines: ['title', 'artist'] }],
  };
  const psp = layoutSkin(loadSkin(JSON.stringify(doc), { screen: 'psp' }), TRACK);
  const vita = layoutSkin(loadSkin(JSON.stringify(doc), { screen: 'vita' }), TRACK);
  const pspGap = psp.areas[0].lines[1].y - psp.areas[0].lines[0].y;
  const vitaGap = vita.areas[0].lines[1].y - vita.areas[0].lines[0].y;
  assert.strictEqual(pspGap, 12); // size 10 + gap 2
  assert.strictEqual(vitaGap, 24); // size 20 + gap 4
});

// -------------------------------------------------------------- background

const CYCLE = {
  kind: 'cycle',
  colors: ['#FF0000', '#00FF00', '#0000FF'],
  seconds: 10,
  blend: 'step',
  while: 'playing',
};

test('background is a pure function of position', () => {
  assert.strictEqual(backgroundAt(CYCLE, { position: 0, paused: false }).color, '#FF0000');
  assert.strictEqual(backgroundAt(CYCLE, { position: 10, paused: false }).color, '#00FF00');
  assert.strictEqual(backgroundAt(CYCLE, { position: 30, paused: false }).color, '#FF0000');
});

test('a new track restarts the cycle at the first colour', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(25);
  assert.strictEqual(player.colorFor(CYCLE).color, '#0000FF');
  player.setTrack('B', 100);
  assert.strictEqual(player.colorFor(CYCLE).color, '#FF0000');
});

test('re-setting the same track does not reset the colour', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(25);
  player.setTrack('A', 100);
  assert.strictEqual(player.colorFor(CYCLE).color, '#0000FF');
});

test('scrubbing moves the colour forward and back', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.seek(15);
  assert.strictEqual(player.colorFor(CYCLE).color, '#00FF00');
  player.seek(5);
  assert.strictEqual(player.colorFor(CYCLE).color, '#FF0000');
});

test('while playing: pausing shows the first colour', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(15);
  assert.strictEqual(player.colorFor(CYCLE).color, '#00FF00');
  player.pause();
  assert.strictEqual(player.colorFor(CYCLE).color, '#FF0000');
  // A pause must not advance the position either.
  const before = player.state.position;
  player.tick(45);
  assert.strictEqual(player.state.position, before);
});

test('while always: pausing holds the colour it had reached', () => {
  const bg = { ...CYCLE, while: 'always' };
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(25);
  player.pause();
  assert.strictEqual(player.colorFor(bg).color, '#0000FF');
  // Scrubbing while paused still moves (the dot moves; the colour follows).
  player.seek(15);
  assert.strictEqual(player.colorFor(bg).color, '#00FF00');
});

test('fade blends between adjacent colours', () => {
  const bg = { ...CYCLE, blend: 'fade' };
  const mid = backgroundAt(bg, { position: 5, paused: false });
  assert.strictEqual(mid.color, '#808000'); // half red -> green
  assert.ok(mid.fraction > 0 && mid.fraction < 1);
});

test('leaving the tape view and returning cannot advance the colour', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(12);
  const before = player.colorFor(CYCLE).color;
  player.leaveTapeView();
  // No ticks happen while away; time passing on the wall changes nothing.
  // Coming back with no decoder reading (the paused case) holds the colour.
  player.enterTapeView();
  assert.strictEqual(player.colorFor(CYCLE).color, before);
});

test('coming back to the tape view catches up to the music, not to the clock', () => {
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(12);
  player.leaveTapeView();
  // The decoder reports where the music actually reached, which is the only
  // input; a colour left from the old track cannot survive it.
  player.enterTapeView(22);
  assert.strictEqual(player.colorFor(CYCLE).color, '#0000FF');
});

test('stopping shows the first colour under while playing, holds under while always', () => {
  const always = { ...CYCLE, while: 'always' };
  const player = createPlayback({ trackId: 'A', duration: 100 });
  player.setTrack('A', 100);
  player.resume();
  player.tick(25);
  player.stop();
  assert.strictEqual(player.colorFor(CYCLE).color, '#FF0000');
  assert.strictEqual(player.colorFor(always).color, '#0000FF');
});

test('an empty queue is black-or-first, not a crash', () => {
  const player = createPlayback({});
  assert.strictEqual(player.state.active, false);
  assert.strictEqual(player.colorFor(CYCLE).color, '#FF0000');
});

// --------------------------------------------------------------- lifecycle

const SKIN_A = JSON.stringify({
  design: 'psp',
  background: { colors: ['#111111', '#222222'] },
  areas: [{ rect: [10, 10, 100, 20], lines: ['title'] }],
});
const SKIN_B = JSON.stringify({
  design: 'psp',
  background: { colors: ['#333333', '#444444'] },
  areas: [{ rect: [20, 20, 200, 20], lines: ['artist'] }],
});

test('switching skins drops the old picture and opens one for the new skin', () => {
  const c = createSkinController();
  const a = c.switchSkin('A', SKIN_A);
  assert.ok(c.installDecodedImage('A', a.generation, { id: 'A' }));
  assert.strictEqual(c.stats.decodedImagesOpen, 1);

  const b = c.switchSkin('B', SKIN_B);
  assert.strictEqual(c.background.colors[0], '#333333');
  assert.strictEqual(c.stats.decodedImagesOpen, 0, 'old picture released on switch');
  assert.ok(c.installDecodedImage('B', b.generation, { id: 'B' }));
  assert.strictEqual(c.stats.decodedImagesOpen, 1);
});

test('a decode that finishes late for an old skin is discarded', () => {
  const c = createSkinController();
  const a = c.switchSkin('A', SKIN_A);
  c.switchSkin('B', SKIN_B);
  const accepted = c.installDecodedImage('A', a.generation, { id: 'A' });
  assert.strictEqual(accepted, false);
  assert.strictEqual(c.stats.staleCallbacksDropped, 1);
  assert.strictEqual(c.stats.decodedImagesOpen, 0);
});

test('rapid switching leaves one picture open, not one per switch', () => {
  const c = createSkinController();
  for (let i = 0; i < 50; i += 1) {
    const { generation } = c.switchSkin(`S${i}`, i % 2 ? SKIN_A : SKIN_B);
    c.installDecodedImage(`S${i}`, generation, { id: i });
  }
  assert.strictEqual(c.stats.decodedImagesOpen, 1);
  assert.strictEqual(c.stats.decodedImagesTotal, 50);
  assert.strictEqual(c.stats.releasedImages, 49);
});

test('a frame callback from an old generation does not run', () => {
  const c = createSkinController();
  const a = c.switchSkin('A', SKIN_A);
  c.switchSkin('B', SKIN_B);
  let ran = false;
  c.frame(a.generation, () => { ran = true; });
  assert.strictEqual(ran, false);
});

test('a bad skin switched to mid-view does not crash or leave old text', () => {
  const c = createSkinController();
  const a = c.switchSkin('A', SKIN_A);
  c.setDrawnText(a.generation, ['Blue Monday']);
  assert.deepStrictEqual(c.drawnText, ['Blue Monday']);
  const bad = c.switchSkin('bad', '{ not json');
  assert.strictEqual(bad.skin.degraded, true);
  assert.strictEqual(bad.skin.areas.length, 0);
  assert.strictEqual(c.background, null);
  assert.strictEqual(c.skin.areas.length, 0);
  // The old skin's line is gone, not merely overwritten later.
  assert.deepStrictEqual(c.drawnText, []);
  assert.ok(c.stats.textCleared >= 1);
});

test('a late draw pass for an old skin cannot put its text back', () => {
  const c = createSkinController();
  const a = c.switchSkin('A', SKIN_A);
  c.switchSkin('B', SKIN_B);
  const accepted = c.setDrawnText(a.generation, ['stale line']);
  assert.strictEqual(accepted, false);
  assert.deepStrictEqual(c.drawnText, []);
});

test('switching re-reads skin.json rather than reusing the parsed skin', () => {
  let reads = 0;
  const loader = (json, opts) => {
    reads += 1;
    return loadSkin(json, opts);
  };
  const c = createSkinController({ loadSkin: loader });
  c.switchSkin('A', SKIN_A);
  c.switchSkin('B', SKIN_B);
  c.switchSkin('A', SKIN_A);
  assert.strictEqual(reads, 3);
});

// --------------------------------------------------------------- samples

test('every shipped sample passes its own expectations', () => {
  const fs = require('fs');
  const path = require('path');
  const { verifySample } = require('../verify');
  const { describe } = require('../cli');
  const { TRACKS } = require('../cli');

  const root = path.resolve(__dirname, '..', '..', '..');
  const cases = [
    ['psp-label', 'vita', 'normal'],
    ['psp-label', 'psp', 'normal'],
    ['vita-label', 'psp', 'normal'],
    ['vita-label', 'vita', 'normal'],
    ['missing-artist', 'psp', 'no-artist'],
    ['long-title', 'psp', 'long-title'],
    ['max-limits', 'vita', 'normal'],
    ['edges', 'psp', 'normal'],
    ['edges', 'vita', 'long-title'],
    ['broken-json', 'psp', 'normal'],
    ['oversize', 'vita', 'normal'],
    ['step-background', 'psp', 'normal'],
    ['no-text', 'vita', 'normal'],
  ];

  const orig = console.error;
  console.error = () => {};
  try {
    for (const [name, screen, trackName] of cases) {
      const file = path.join(root, 'samples', name, 'skin.json');
      const json = fs.readFileSync(file, 'utf8');
      const skin = loadSkin(json, { screen });
      const track = TRACKS[trackName];
      const described = describe(skin, track);
      const ok = verifySample(name, described, skin, track, { screen, trackName });
      assert.strictEqual(ok, true, `${name} at ${screen} failed`);
    }
  } finally {
    console.error = orig;
  }
});

test('no library file reads the wall clock', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.resolve(__dirname, '..', 'lib');
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
      // Strip comments so prose about clocks does not trip the check.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.strictEqual(/Date\.now|new Date\(|performance\.now/.test(src), false, `${file} reads a clock`);
  }
});
