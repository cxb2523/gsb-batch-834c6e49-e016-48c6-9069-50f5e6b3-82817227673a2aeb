'use strict';

/*
 * A coarse ASCII preview of a laid-out skin, so a conversion can be seen at a
 * glance in a terminal. It is not a renderer: it draws the area box, the
 * clipped extent, and a marker where each line starts, with the text beside it.
 *
 * The output is deterministic and asserted in the tests only for structure
 * (box present, clipped at the edge, expected text), never pixel-for-pixel.
 */

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function preview(layout, options = {}) {
  const cols = options.cols || 60;
  const rows = options.rows || 24;
  const screen = layout.screen;
  const sx = cols / screen.width;
  const sy = rows / screen.height;

  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));

  const put = (x, y, ch) => {
    if (x >= 0 && x < cols && y >= 0 && y < rows) grid[y][x] = ch;
  };

  for (const area of layout.areas) {
    const r = area.rect;
    const x0 = Math.round(r.x * sx);
    const y0 = Math.round(r.y * sy);
    const x1 = Math.round((r.x + r.width) * sx) - 1;
    const y1 = Math.round((r.y + r.height) * sy) - 1;
    for (let x = x0; x <= x1; x += 1) {
      put(x, y0, '-');
      put(x, y1, '-');
    }
    for (let y = y0; y <= y1; y += 1) {
      put(x0, y, '|');
      put(x1, y, '|');
    }
    for (const line of area.lines) {
      const ly = Math.min(rows - 1, Math.round(line.y * sy));
      let lx = Math.round(line.x * sx) + 1;
      for (const ch of line.text) {
        if (lx >= Math.max(0, x1)) { put(lx, ly, '.'); break; }
        put(lx, ly, ch);
        lx += 1;
      }
    }
  }

  return grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n');
}

module.exports = { preview, pad };
