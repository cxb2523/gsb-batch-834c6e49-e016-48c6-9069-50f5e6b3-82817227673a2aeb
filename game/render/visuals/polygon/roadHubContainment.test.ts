/**
 * Intersection-hub containment tests.
 *
 * The road junction hub is a centroid-scaled mini-diamond (scale
 * `s = min(0.95, (halfW / rIns) · HUB_COVERAGE)`) drawn on top of the arm
 * bands, including the center block of cross/tee/corner junctions. On a
 * coplanar ramp the tile diamond deforms (one axis compresses); these tests
 * pin that BOTH the arm-band half-width clamp and the resulting hub stay
 * strictly inside the deformed diamond, so the junction center block never
 * bleeds across a tile edge — the intersection-center-block half of the
 * road-narrowing requirement.
 */

import { describe, it, expect } from 'vitest';
import { projectTileCornerScreen, ISO_CONFIG } from '@/game/render/IsoTransform';
import { maxRoadHalfWidthForDiamond } from './roadHalfWidth';
import type { ScreenCoord } from '@/game/types/coordinates';

const ROAD_HALF_WIDTH = 0.32;
const HUB_COVERAGE = 0.82;
const TARGET_HALF_W = ROAD_HALF_WIDTH * ISO_CONFIG.TILE_HEIGHT;

function perpDist(C: ScreenCoord, a: ScreenCoord, b: ScreenCoord): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len = Math.hypot(abx, aby) || 1;
  return Math.abs(abx * (C.y - a.y) - aby * (C.x - a.x)) / len;
}

/** True iff every corner of the convex `poly` lies inside the diamond half-planes. */
function polygonInsideDiamond(
  poly: ReadonlyArray<ScreenCoord>,
  center: ScreenCoord,
  corners: ReadonlyArray<ScreenCoord>,
): boolean {
  const eps = 1e-9;
  for (let e = 0; e < corners.length; e++) {
    const a = corners[e];
    const b = corners[(e + 1) % corners.length];
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    let nx = -ty / len;
    let ny = tx / len;
    if ((a.x - center.x) * nx + (a.y - center.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const dist = (a.x - center.x) * nx + (a.y - center.y) * ny;
    for (const p of poly) {
      const support = (p.x - center.x) * nx + (p.y - center.y) * ny;
      if (support > dist + eps) return false;
    }
  }
  return true;
}

describe('road junction hub containment on deformed diamonds', () => {
  it('flat tile: hub mini-diamond fits inside the full diamond', () => {
    const tile = { x: 0, y: 0 };
    const corners = [
      projectTileCornerScreen(tile, 'top', 0),
      projectTileCornerScreen(tile, 'right', 0),
      projectTileCornerScreen(tile, 'bottom', 0),
      projectTileCornerScreen(tile, 'left', 0),
    ];
    const center: ScreenCoord = {
      x: corners.reduce((s, c) => s + c.x, 0) / 4,
      y: corners.reduce((s, c) => s + c.y, 0) / 4,
    };
    const halfW = Math.min(TARGET_HALF_W, maxRoadHalfWidthForDiamond(center, corners[0], corners[1], corners[2], corners[3]));
    const rIns = Math.min(
      perpDist(center, corners[0], corners[1]),
      perpDist(center, corners[1], corners[2]),
      perpDist(center, corners[2], corners[3]),
      perpDist(center, corners[3], corners[0]),
    );
    const s = Math.min(0.95, (halfW / rIns) * HUB_COVERAGE);
    const hub = corners.map((c) => ({
      x: center.x + (c.x - center.x) * s,
      y: center.y + (c.y - center.y) * s,
    }));
    expect(s).toBeLessThanOrEqual(1);
    expect(polygonInsideDiamond(hub, center, corners)).toBe(true);
  });

  it('N-S coplanar ramp: clamped halfW and the hub mini-diamond both stay inside the deformed diamond', () => {
    // Same coplanar ramp corner heights road buildability permits.
    const tile = { x: 2, y: 2 };
    const corners = [
      projectTileCornerScreen(tile, 'top', 1),
      projectTileCornerScreen(tile, 'right', 1),
      projectTileCornerScreen(tile, 'bottom', 2),
      projectTileCornerScreen(tile, 'left', 2),
    ];
    const center: ScreenCoord = {
      x: corners.reduce((s, c) => s + c.x, 0) / 4,
      y: corners.reduce((s, c) => s + c.y, 0) / 4,
    };
    const maxH = maxRoadHalfWidthForDiamond(center, corners[0], corners[1], corners[2], corners[3]);
    const halfW = Math.min(TARGET_HALF_W, maxH);
    expect(halfW).toBeLessThan(TARGET_HALF_W); // narrowing fires on the ramp

    const rIns = Math.min(
      perpDist(center, corners[0], corners[1]),
      perpDist(center, corners[1], corners[2]),
      perpDist(center, corners[2], corners[3]),
      perpDist(center, corners[3], corners[0]),
    );
    const s = Math.min(0.95, (halfW / rIns) * HUB_COVERAGE);
    const hub = corners.map((c) => ({
      x: center.x + (c.x - center.x) * s,
      y: center.y + (c.y - center.y) * s,
    }));
    // The junction center block (and, by convexity, every arm band built on the
    // same halfW) cannot cross the deformed tile boundary.
    expect(polygonInsideDiamond(hub, center, corners)).toBe(true);
  });
});
