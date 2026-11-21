#!/usr/bin/env node
'use strict';

/*
 * Generates samples/REPORT.md: the four verification examples the format work
 * asks for, computed by the same code the tests exercise.
 *
 *   node tools/skincheck/report.js        writes samples/REPORT.md
 *   node tools/skincheck/report.js --stdout
 */

const fs = require('fs');
const path = require('path');
const { loadSkin } = require('./lib/skin');
const { layoutSkin } = require('./lib/layout');
const { backgroundAt } = require('./lib/background');
const { preview } = require('./lib/preview');
const { TRACKS, describe } = require('./cli');

const ROOT = path.resolve(__dirname, '..', '..');

function load(name, screen, trackName = 'normal') {
  const file = path.join(ROOT, 'samples', name, 'skin.json');
  const json = fs.readFileSync(file, 'utf8');
  const skin = loadSkin(json, { screen });
  return { skin, described: describe(skin, TRACKS[trackName]) };
}

function rectRow(a) {
  const r = a.rect;
  return `| \`[${r.x}, ${r.y}, ${r.width}, ${r.height}]\` | ${a.color} | ${a.lines.length} |`;
}

function areaTable(described) {
  const rows = [
    '| rect (screen px) | text colour | lines |',
    '|---|---|---|',
  ];
  for (const a of described.areas) rows.push(rectRow(a));
  return rows.join('\n');
}

function lineTable(described) {
  const rows = ['| text | x, y | size | shrink | truncated |', '|---|---|---|---|---|'];
  for (const a of described.areas) {
    for (const l of a.lines) {
      rows.push(
        `| \`${l.text}\` | ${l.x}, ${l.y} | ${l.size} | ${l.shrinkSteps} | ${l.truncated ? 'yes' : 'no'} |`
      );
    }
  }
  return rows.join('\n');
}

function colourTimeline(skin) {
  const bg = skin.background;
  if (!bg) return '_no background (black)_';
  if (bg.kind === 'static') return `static \`${bg.colors[0]}\``;

  const steps = [
    ['track starts', 0, false],
    [`half way to colour 2`, bg.seconds * 0.5, false],
    [`middle of colour 2`, bg.seconds * 1.5, false],
    ['scrub forward to 30s', 30, false],
    ['scrub back to 3s', 3, false],
    [`paused (while=${bg.while})`, 3, true],
    ['scrub while paused to 2.5 colours', bg.seconds * 2.5, true],
    ['resumed', bg.seconds * 2.5, false],
    ['track changes (position 0)', 0, false],
  ];
  const rows = ['| step | position | paused | colour |', '|---|---|---|---|'];
  for (const [label, position, paused] of steps) {
    const c = backgroundAt(bg, { position, paused, active: true });
    rows.push(`| ${label} | ${position.toFixed(2)} | ${paused ? 'yes' : 'no'} | \`${c.color}\` |`);
  }
  return [
    `${bg.colors.join(' → ')} · ${bg.seconds}s each · ${bg.blend} · while \`${bg.while}\``,
    '',
    rows.join('\n'),
  ].join('\n');
}

function build() {
  const out = [];
  const pspAtPsp = load('psp-label', 'psp');
  const pspAtVita = load('psp-label', 'vita');
  const vitaAtPsp = load('vita-label', 'psp');
  const missing = load('missing-artist', 'psp', 'no-artist');
  const longTitle = load('long-title', 'psp', 'long-title');
  const step = load('step-background', 'psp');
  const broken = load('broken-json', 'psp');

  out.push('# Verifying a skin locally');
  out.push('');
  out.push(
    'Everything below is produced by `tools/skincheck` from the files in `samples/`. ' +
      'No dependencies beyond Node 18+. Regenerate with `npm run report`; check with `npm test`.'
  );
  out.push('');
  out.push('```');
  out.push('npm test                 # every unit rule + every sample');
  out.push('npm run verify           # every sample at every relevant screen');
  out.push('node tools/skincheck/cli.js samples/psp-label/skin.json --screen vita --ascii');
  out.push('```');

  // 1. PSP design at Vita size
  out.push('');
  out.push('## 1. A PSP design rendered at Vita size');
  out.push('');
  out.push('`samples/psp-label/skin.json` declares `"design": "psp"`. At 960 × 544 ' +
    'every pixel quantity is multiplied by two.');
  out.push('');
  out.push('| | design (480 × 272) | Vita (960 × 544) |');
  out.push('|---|---|---|');
  const designRects = pspAtPsp.described.areas.map((a) => a.rect);
  const vitaRects = pspAtVita.described.areas.map((a) => a.rect);
  for (let i = 0; i < designRects.length; i += 1) {
    const d = designRects[i];
    const v = vitaRects[i];
    out.push(
      `| area ${i + 1} rect | \`[${d.x}, ${d.y}, ${d.width}, ${d.height}]\` | ` +
        `\`[${v.x}, ${v.y}, ${v.width}, ${v.height}]\` |`
    );
  }
  const sizesPsp = pspAtPsp.described.areas.map((a) => a.lines[0].size);
  const sizesVita = pspAtVita.described.areas.map((a) => a.lines[0].size);
  out.push(`| text size | ${sizesPsp.join(', ')} | ${sizesVita.join(', ')} |`);
  out.push('| line gap | 2 | 4 |');
  out.push('');
  out.push('Laid out at Vita size:');
  out.push('');
  out.push('```text');
  out.push(preview(layoutSkin(pspAtVita.skin, TRACKS.normal), { cols: 80, rows: 22 }));
  out.push('```');
  out.push('');
  out.push('The reverse also holds — a Vita design on a PSP halves (`samples/vita-label`):');
  out.push('');
  out.push(areaTable(vitaAtPsp.described));

  // 2. missing artist
  out.push('');
  out.push('## 2. A track with no artist tag');
  out.push('');
  out.push(
    '`samples/missing-artist/skin.json` prints `["album", ": ", "artist"]`, ' +
      '`["Side A · ", "title"]` and `["artist", " — ", "album"]`. The track is ' +
      '`samples`\' "no-artist" track: album *Basement Tapes*, title *Untitled Demo*, no artist.'
  );
  out.push('');
  out.push(lineTable(missing.described));
  out.push('');
  out.push(
    'The colon disappears because a separator survives only when both fields on ' +
      'either side have text. `"Side A · "` survives because it is followed by a ' +
      'title that exists; with no title, the whole line would be empty and be skipped.'
  );

  // 3. long title
  out.push('');
  out.push('## 3. A title too long for its area');
  out.push('');
  out.push(
    'The same title at three widths. Each line is offered at `size`, then 0.88×, ' +
      '0.88²×, 0.88³× before it is cut with `...`.'
  );
  out.push('');
  out.push(lineTable(longTitle.described));
  out.push('');
  out.push(
    'The 400 px area still ends in `...` after three shrinks because the title is ' +
      'much too long; the 120 px one is visibly shorter. A line only gets smaller ' +
      'if that makes it fit — a step that does not is not taken.'
  );

  // 4. background colours
  out.push('');
  out.push('## 4. Background colour under track change, pause and scrub');
  out.push('');
  out.push('### `samples/psp-label` — three colours, 6 s each, fade, while `playing`');
  out.push('');
  out.push(colourTimeline(pspAtPsp.skin));
  out.push('');
  out.push('### `samples/step-background` — four colours, 10 s each, step, while `always`');
  out.push('');
  out.push(colourTimeline(step.skin));
  out.push('');
  out.push(
    'With `while: "always"`, pausing *and then scrubbing* still moves the colour, ' +
      'because the colour follows the position, not the clock. With `while: "playing"` ' +
      'a pause shows the first colour whichever position it is paused at.'
  );

  // 5. degradation
  out.push('');
  out.push('## 5. Degradation');
  out.push('');
  out.push(
    `\`samples/broken-json/skin.json\` has a trailing comma. Loaded at any size it ` +
      `yields no text and a \`${broken.skin.backgroundColor}\` background, and no exception.`
  );
  out.push('');
  out.push('```');
  out.push(`degraded: ${broken.skin.degraded}`);
  out.push(`reason:   ${broken.skin.degradationReason}`);
  out.push(`areas:    ${broken.described.areas.length}`);
  out.push(`background: ${broken.skin.backgroundColor}`);
  out.push('```');

  out.push('');
  return out.join('\n');
}

function main() {
  const text = build();
  if (process.argv.includes('--stdout')) {
    process.stdout.write(text);
    return;
  }
  const target = path.join(ROOT, 'samples', 'REPORT.md');
  fs.writeFileSync(target, text);
  console.log(`wrote ${path.relative(ROOT, target)} (${text.length} bytes)`);
}

if (require.main === module) main();

module.exports = { build };
