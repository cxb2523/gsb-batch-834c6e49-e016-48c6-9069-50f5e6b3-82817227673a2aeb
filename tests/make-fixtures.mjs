/* Generates the two short synthetic stems the lifecycle tests jam with, plus a stems.json shaped
   manifest for them. Run once before the tests:  node tests/make-fixtures.mjs
   Output (gitignored, local-only, in tests/fixtures):
     songA-<type>.wav, songB-<type>.wav for groove/lead/texture, and test-stems.json
   Each WAV is a mono-ish stereo 2-bar 44.1 kHz loop. Song A and B differ in content (distinct
   tones and a per-song marker), so a render can be told apart after a switch. Song B carries a
   near-0 dBFS transient at its first samples, to hit the limiter inside its first lookahead. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const BPM = 120;
const BARS = 2;
const BEATS = BARS * 4;
const FRAMES = Math.round((BEATS * 60 / BPM) * SR); // whole samples, like the real loop grid
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');

function tone(freq, i, sr, gain) {
  return gain * Math.sin((2 * Math.PI * freq * i) / sr);
}

// One stem's samples. song A: a warm two-tone pad-like loop; song B: a brighter loop opening on a
// full-scale transient (both channels, one sample), then its own tones. type only changes the
// level/brightness slightly so layers are distinguishable, like the real TYPE_LUFS targets.
function makeSamples(song, type) {
  const data = new Float32Array(FRAMES);
  const base = song === 'A' ? 220 : 330;
  const f2 = song === 'A' ? 277.18 : 415.30;
  const level = type === 'groove' ? 0.5 : type === 'lead' ? 0.42 : 0.36;
  for (let i = 0; i < FRAMES; i++) {
    let v = (tone(base, i, SR, 0.7) + tone(f2, i, SR, 0.3)) * level;
    // A soft kick pulse each beat, stronger on grooves.
    const beatLen = Math.round((60 / BPM) * SR);
    const phase = i % beatLen;
    if (phase < 200) v += (type === 'groove' ? 0.5 : 0.25) * Math.exp(-phase / 60) * Math.sin((2 * Math.PI * 60 * phase) / SR);
    data[i] = Math.max(-1, Math.min(1, v));
  }
  if (song === 'B') {
    // Near-0 dBFS transient in the first lookahead window: one sample at +0.999 each side, then
    // a short decay. This is what the limiter must catch even at a reset at sample 0.
    for (let i = 0; i < 24; i++) data[i] = 0.999 * Math.exp(-i / 6);
  }
  return data;
}

function encodeWav(samples) {
  const n = samples.length, bytes = 44 + n * 2 * 2;
  const buf = new ArrayBuffer(bytes), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2 * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 2 * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const x = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    v.setInt16(o, x, true); v.setInt16(o + 2, x, true); o += 4; // identical on both channels
  }
  return buf;
}

mkdirSync(OUT, { recursive: true });
const manifest = {};
for (const song of ['A', 'B']) {
  const name = `Song ${song}`;
  manifest[name] = {
    code: song, album: 'test', key: song === 'A' ? 'Am' : 'Cm', bpm: BPM,
    stems: {}, oggs: {}, flacs: {}, lufs: {}, frames: {},
  };
  for (const type of ['groove', 'lead', 'texture']) {
    const samples = makeSamples(song, type);
    const buf = encodeWav(samples);
    const file = `song${song}-${type}.wav`;
    writeFileSync(join(OUT, file), Buffer.from(buf));
    manifest[name].stems[type] = `/tests/fixtures/${file}`;
    manifest[name].flacs[type] = `/tests/fixtures/${file}`; // WAV decodes in place of FLAC in tests
    manifest[name].oggs[type] = `/tests/fixtures/${file}`;
    manifest[name].lufs[type] = -13;
    manifest[name].frames[type] = FRAMES;
  }
}
writeFileSync(join(OUT, 'test-stems.json'), JSON.stringify(manifest, null, 2));
console.log(`wrote fixtures to ${OUT} (${FRAMES} samples/loop, ${BARS} bars at ${BPM} BPM)`);
