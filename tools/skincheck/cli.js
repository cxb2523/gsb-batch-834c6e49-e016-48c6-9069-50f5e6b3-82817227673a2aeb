#!/usr/bin/env node
'use strict';

/*
 * skincheck — a local, dependency-free preview of a TRAX skin.json.
 *
 *   node tools/skincheck/cli.js <skin.json> --screen vita|psp [--track <name>]
 *                                  [--json] [--ascii] [--timeline] [--verify]
 *
 * --track chooses one of the built-in sample tracks (see TRACKS).
 * --timeline prints the background colour through a scripted
 *   track-change / pause / scrub sequence.
 * --verify runs the expectations for this sample and exits non-zero on
 *   failure; `npm test` runs every sample this way.
 */

const fs = require('fs');
const path = require('path');
const { loadSkin } = require('./lib/skin');
const { layoutSkin } = require('./lib/layout');
const { backgroundAt } = require('./lib/background');
const { createPlayback } = require('./lib/playback');
const { preview } = require('./lib/preview');
const { SCREENS } = require('./lib/constants');

const TRACKS = {
  normal: {
    title: 'Blue Monday',
    artist: 'New Order',
    album: 'Power, Corruption & Lies',
    track: '3/12',
    playlist: 'Power, Corruption & Lies',
  },
  'no-artist': {
    title: 'Untitled Demo',
    artist: null,
    album: 'Basement Tapes',
    track: '1/4',
    playlist: 'Basement Tapes',
  },
  'long-title': {
    title:
      'The Rise and Fall of Ziggy Stardust and the Spiders from Mars (2012 Remastered Deluxe Edition)',
    artist: 'David Bowie',
    album: 'The Rise and Fall of Ziggy Stardust and the Spiders from Mars',
    track: '5/11',
    playlist: 'The Rise and Fall of Ziggy Stardust and the Spiders from Mars',
  },
  cjk: {
    title: '夜に駆ける',
    artist: 'YOASOBI',
    album: 'THE BOOK',
    track: '2/9',
    playlist: 'THE BOOK',
  },
  empty: { title: null, artist: null, album: null, track: null, playlist: null },
};

function parseArgs(argv) {
  const out = {
    screen: 'psp',
    track: 'normal',
    json: false,
    ascii: false,
    timeline: false,
    verify: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--screen') out.screen = argv[++i];
    else if (a === '--track') out.track = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--ascii') out.ascii = true;
    else if (a === '--timeline') out.timeline = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.file = rest[0];
  return out;
}

function usage() {
  return [
    'usage: node tools/skincheck/cli.js <skin.json> --screen vita|psp [options]',
    '',
    '  --track <name>   one of: ' + Object.keys(TRACKS).join(', '),
    '  --json           print the converted skin as JSON',
    '  --ascii          print a coarse ASCII preview',
    '  --timeline       print colours through track change / pause / scrub',
    '  --verify         exit non-zero if the built-in expectations for this',
    '                   sample do not hold',
  ].join('\n');
}

function describe(skin, track) {
  const layout = layoutSkin(skin, track);
  return {
    screen: skin.screen,
    design: skin.design,
    designDeclared: skin.designDeclared,
    scale: skin.scale,
    degraded: skin.degraded,
    degradationReason: skin.degradationReason,
    warnings: skin.warnings,
    areas: layout.areas.map((area) => ({
      rect: area.rect,
      clipped: area.clipped,
      color: area.color,
      lines: area.lines.map((line) => ({
        text: line.text,
        size: Number(line.size.toFixed(2)),
        x: line.x,
        y: line.y,
        clipRect: line.clipRect,
        shrinkSteps: line.steps,
        truncated: line.truncated,
      })),
    })),
  };
}

function designLabel(described) {
  const d = described.design;
  const declared = described.designDeclared;
  const name = typeof declared === 'string' ? declared : JSON.stringify(declared);
  return `${name} (${d.width} x ${d.height})`;
}

function printHuman(described) {
  console.log(`${described.screen.key}: ${described.screen.width} x ${described.screen.height}`);
  console.log(
    `design ${designLabel(described)} -> scale ` +
      `${described.scale.x.toFixed(3)} x ${described.scale.y.toFixed(3)}`
  );
  if (described.degraded) console.log(`DEGRADED: ${described.degradationReason}`);
  for (const w of described.warnings) console.log(`warning: ${w}`);
  console.log(`areas drawn: ${described.areas.length}`);
  for (const area of described.areas) {
    const r = area.rect;
    console.log(
      `  rect [${r.x}, ${r.y}, ${r.width}, ${r.height}]` +
        (area.clipped ? ' (clipped)' : '') +
        ` color ${area.color}`
    );
    for (const line of area.lines) {
      console.log(
        `    "${line.text}" @${line.x},${line.y} size ${line.size}` +
          (line.shrinkSteps ? ` (shrunk ${line.shrinkSteps}x)` : '') +
          (line.truncated ? ' (truncated)' : '')
      );
    }
  }
}

/**
 * A scripted playback sequence, so the background's dependence on position is
 * visible rather than asserted. Every value is computed from the position; no
 * wall clock is read anywhere.
 */
function printTimeline(skin, track) {
  const bg = skin.background;
  if (!bg) {
    console.log('background: none (black)');
    return;
  }
  if (bg.kind === 'static') {
    console.log(`background: static ${bg.colors[0]}`);
    return;
  }
  console.log(
    `background: ${bg.colors.join(' -> ')} | ${bg.seconds}s each, ${bg.blend}, while ${bg.while}`
  );
  console.log('');
  console.log('  step                    position  paused  colour     phase index');
  console.log('  ----------------------  --------  ------  ---------  ----- -----');

  const player = createPlayback({ trackId: 'A', duration: 240 });
  player.setTrack('A', 240);
  player.resume();

  const row = (label, position, paused) => {
    const col = backgroundAt(bg, { position, paused, active: true });
    console.log(
      '  ' +
        label.padEnd(22) +
        '  ' +
        position.toFixed(2).padStart(8) +
        '  ' +
        (paused ? 'yes   ' : 'no    ') +
        '  ' +
        col.color.padEnd(9) +
        '  ' +
        col.phase.toFixed(2).padStart(5) +
        ' ' +
        String(col.index).padStart(5)
    );
  };

  player.tick(0);
  row('track A starts', 0, false);
  player.tick(bg.seconds * 0.5);
  row('half way to colour 2', bg.seconds * 0.5, false);
  player.tick(bg.seconds * 1.5);
  row('middle of colour 2', bg.seconds * 1.5, false);
  player.seek(30);
  row('scrub forward to 30s', 30, false);
  player.seek(3);
  row('scrub back to 3s', 3, false);
  player.pause();
  row('paused (while=' + bg.while + ')', 3, true);
  player.seek(bg.seconds * 2.5);
  row('scrub while paused', bg.seconds * 2.5, true);
  player.resume();
  row('resumed', bg.seconds * 2.5, false);
  player.leaveTapeView();
  player.enterTapeView();
  row('back from tape view', bg.seconds * 2.5, false);
  player.setTrack('B', 200);
  row('track B starts at 0', 0, false);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }
  if (!SCREENS[args.screen]) {
    console.error(`unknown screen "${args.screen}"`);
    process.exit(2);
  }
  const track = TRACKS[args.track];
  if (!track) {
    console.error(`unknown track "${args.track}"; choose one of ${Object.keys(TRACKS).join(', ')}`);
    process.exit(2);
  }

  const file = path.resolve(args.file);
  const jsonText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const skin = loadSkin(jsonText, { screen: args.screen });
  const described = describe(skin, track);

  if (args.json) {
    console.log(JSON.stringify(described, null, 2));
  } else {
    printHuman(described);
  }

  if (args.ascii) {
    console.log('');
    console.log(preview(layoutSkin(skin, track), { cols: 88, rows: 30 }));
  }

  if (args.timeline) {
    console.log('');
    printTimeline(skin, track);
  }

  if (args.verify) {
    const { verifySample } = require('./verify');
    const ok = verifySample(path.basename(path.dirname(file)), described, skin, track, {
      screen: args.screen,
      trackName: args.track,
    });
    process.exit(ok ? 0 : 1);
  }
}

if (require.main === module) main();

module.exports = { TRACKS, describe, parseArgs, printTimeline, designLabel };
