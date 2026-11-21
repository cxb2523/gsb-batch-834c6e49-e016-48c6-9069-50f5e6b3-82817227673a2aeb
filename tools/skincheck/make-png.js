'use strict';

/*
 * A tiny deterministic RGBA PNG writer. No dependencies, no clock, no random.
 * Used to generate the sample skins' pictures so the sample folders are
 * complete and can be dropped into a real SKINS folder.
 *
 *   node tools/skincheck/make-png.js
 *
 * writes:
 *   samples/psp-label/psp-label.png   480 x 272
 *   samples/vita-label/vita-label.png 960 x 544
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * paint(x, y, w, h) -> [r, g, b, a] for a pixel. `w`/`h` let a painter draw in
 * a 480 x 272 design space regardless of the output size.
 */
function encodePNG(width, height, paint) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o] = 0; // filter: none
    o += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y, width, height);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
      o += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The sample cassette: opaque dark shell, a pale label across the upper third,
 * two transparent reel windows and a transparent strip where the tape shows.
 * Coordinates are in a 480 x 272 design space and scale to the output.
 */
function cassettePainter(x, y, w, h) {
  // map to 480 x 272
  const dx = (x + 0.5) * (480 / w);
  const dy = (y + 0.5) * (272 / h);

  const label = dx >= 62 && dx <= 418 && dy >= 18 && dy <= 96;
  const reelL = Math.hypot(dx - 150, dy - 175) < 40;
  const reelR = Math.hypot(dx - 330, dy - 175) < 40;
  const window = dx >= 110 && dx <= 370 && dy >= 110 && dy <= 240;
  const hull = dx >= 8 && dx <= 472 && dy >= 8 && dy <= 264;

  if (reelL || reelR) return [0, 0, 0, 0];
  if (!hull) return [0, 0, 0, 0];
  if (label) return [236, 232, 220, 255];
  if (window) return [0, 0, 0, 0];
  return [24, 24, 26, 255];
}

function main() {
  const root = path.resolve(__dirname, '..', '..');
  const samples = path.join(root, 'samples');

  // Every sample folder is a complete skin: a picture named after the folder
  // plus skin.json. The picture is drawn at the size the skin declares, so
  // copying the folder into SKINS works on the machine.
  const dirs = fs
    .readdirSync(samples, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const folder = path.join(samples, dir);
    const jsonFile = path.join(folder, 'skin.json');
    if (!fs.existsSync(jsonFile)) continue;

    let size = [480, 272];
    try {
      const doc = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
      if (doc && doc.design === 'vita') size = [960, 544];
      else if (doc && Array.isArray(doc.design) && doc.design.length === 2) {
        size = [Math.trunc(doc.design[0]), Math.trunc(doc.design[1])];
      }
    } catch (err) {
      // A sample that is deliberately broken still gets a PSP-sized picture.
    }

    const [w, h] = size;
    const target = path.join(folder, `${dir}.png`);
    fs.writeFileSync(target, encodePNG(w, h, cassettePainter));
    console.log(`wrote ${path.relative(root, target)} (${w} x ${h})`);
  }
}

if (require.main === module) main();

module.exports = { encodePNG, cassettePainter, crc32 };
