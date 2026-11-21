#!/usr/bin/env node
'use strict';

/*
 * Runs every shipped sample at every screen that matters, printing a
 * pass/fail line for each. This is the "can I run it locally?" entry point.
 *
 *   node tools/skincheck/verify-all.js
 */

const fs = require('fs');
const path = require('path');
const { loadSkin } = require('./lib/skin');
const { describe, TRACKS } = require('./cli');
const { verifySample } = require('./verify');

const ROOT = path.resolve(__dirname, '..', '..');

const CASES = [
  ['psp-label', 'psp', 'normal'],
  ['psp-label', 'vita', 'normal'],
  ['vita-label', 'vita', 'normal'],
  ['vita-label', 'psp', 'normal'],
  ['missing-artist', 'psp', 'no-artist'],
  ['long-title', 'psp', 'long-title'],
  ['long-title', 'vita', 'long-title'],
  ['max-limits', 'psp', 'normal'],
  ['max-limits', 'vita', 'normal'],
  ['edges', 'psp', 'normal'],
  ['edges', 'vita', 'long-title'],
  ['broken-json', 'psp', 'normal'],
  ['oversize', 'vita', 'normal'],
  ['step-background', 'psp', 'normal'],
  ['no-text', 'vita', 'normal'],
];

let failed = 0;
for (const [name, screen, trackName] of CASES) {
  const file = path.join(ROOT, 'samples', name, 'skin.json');
  const json = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const skin = loadSkin(json, { screen });
  const track = TRACKS[trackName];
  const described = describe(skin, track);
  const ok = verifySample(name, described, skin, track, { screen, trackName });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${screen.padEnd(4)} ${trackName}`);
  if (!ok) failed += 1;
}

console.log('');
if (failed) {
  console.error(`${failed} case(s) failed`);
  process.exit(1);
}
console.log(`${CASES.length} cases passed`);
