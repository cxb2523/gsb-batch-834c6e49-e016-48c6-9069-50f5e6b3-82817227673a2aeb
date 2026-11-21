import { describe, it, expect } from 'vitest';
import {
  computeWorldZIndex,
  computeBuildingWorldZIndex,
  footprintFrontCell,
  WORLD_Z_HEIGHT_SCALE,
  WORLD_Z_DEPTH_SCALE,
} from './worldZIndex';
import { computeTerrainZIndex } from './terrainZIndex';

describe('worldZIndex — unified render depth vocabulary', () => {
  it('matches computeTerrainZIndex bit-for-bit (terrain/road keep their exact ordering)', () => {
    for (const h of [0, 1, 3, 8]) {
      for (const x of [0, 2, 7]) {
        for (const y of [0, 1, 9]) {
          expect(computeWorldZIndex(h, x, y)).toBe(computeTerrainZIndex(h, x, y));
        }
      }
    }
  });

  it('height is the primary key: a higher cell always sorts above a lower, more-southern cell', () => {
    const low = computeWorldZIndex(1, 10, 10);
    const high = computeWorldZIndex(4, 0, 0);
    expect(high).toBeGreaterThan(low);
  });

  it('iso depth (x+y) is the secondary key at equal height', () => {
    const back = computeWorldZIndex(2, 1, 1);
    const front = computeWorldZIndex(2, 3, 1);
    expect(front).toBeGreaterThan(back);
  });

  it('y is the tertiary key: south wins on a shared forward diagonal', () => {
    const a = computeWorldZIndex(2, 3, 1); // x+y = 4, y = 1
    const b = computeWorldZIndex(2, 2, 2); // x+y = 4, y = 2
    expect(b).toBeGreaterThan(a);
  });

  it('exposes the documented scale constants', () => {
    expect(WORLD_Z_HEIGHT_SCALE).toBe(1_000_000);
    expect(WORLD_Z_DEPTH_SCALE).toBe(1_000);
  });

  it('is camera-independent: pure function of world cell and height (pan stability)', () => {
    // The value contains no screen-space term, so panning the camera cannot
    // reorder two objects. Pin the ordering from two arbitrary positions.
    const z1 = computeWorldZIndex(3, 4, 2);
    const z2 = computeWorldZIndex(3, 4, 3);
    expect(z2).toBeGreaterThan(z1);
    expect(z1).toBe(3 * 1_000_000 + 6 * 1_000 + 2);
  });

  describe('footprintFrontCell', () => {
    it('picks the max x+y cell, tie-broken by max y', () => {
      const footprint = [
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
      ];
      expect(footprintFrontCell(footprint)).toEqual({ x: 1, y: 1 });
    });

    it('tie-break: equal x+y picks the southern cell', () => {
      // (3,1) and (2,2) both have x+y = 4.
      expect(footprintFrontCell([{ x: 3, y: 1 }, { x: 2, y: 2 }])).toEqual({ x: 2, y: 2 });
    });
  });

  describe('computeBuildingWorldZIndex', () => {
    it('uses the footprint front cell for iso-depth tie-breaks', () => {
      const footprint = [
        { x: 2, y: 2 }, { x: 3, y: 2 },
        { x: 2, y: 3 }, { x: 3, y: 3 },
      ];
      const z = computeBuildingWorldZIndex(5, footprint);
      expect(z).toBe(computeWorldZIndex(5, 3, 3));
    });

    it('a building on high ground sorts above a building on low ground', () => {
      const low = computeBuildingWorldZIndex(1, [{ x: 8, y: 8 }]);
      const high = computeBuildingWorldZIndex(6, [{ x: 0, y: 0 }]);
      expect(high).toBeGreaterThan(low);
    });

    it('returns a below-everything sentinel for an empty footprint', () => {
      expect(computeBuildingWorldZIndex(0, [])).toBeLessThan(computeWorldZIndex(0, 0, 0));
    });

    it('single-cell building at height h equals the terrain z of its cell at h', () => {
      expect(computeBuildingWorldZIndex(3, [{ x: 2, y: 3 }])).toBe(computeWorldZIndex(3, 2, 3));
    });
  });
});
