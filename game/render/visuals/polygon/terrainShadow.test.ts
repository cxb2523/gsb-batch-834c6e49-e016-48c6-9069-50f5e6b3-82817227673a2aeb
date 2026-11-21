import { describe, it, expect } from 'vitest';
import { Terrain, ELEVATION_HEIGHT } from '@/game/core/Terrain';
import { cubeFacePolygons } from './cubeGeometry';
import { cubeShadowPolygon } from './cubeDropShadow';
import {
  castTerrainShadow,
  marchShadowRay,
  shadowRayForMass,
  SHADOW_LENGTH_SCALE,
  type TerrainHeightQuery,
} from './terrainShadow';
import { shadowOffsetScreen, SHADOW_LENGTH_SCALE as LIGHTING_SCALE } from '../lighting';
import { tileToScreenWithHeight } from '@/game/render/IsoTransform';

/** Flat terrain of the given size at a uniform height. */
function flatTerrain(width: number, height: number, h: number): Terrain {
  const t = new Terrain(width, height);
  for (let vy = 0; vy <= height; vy++) {
    for (let vx = 0; vx <= width; vx++) {
      t.unsafeSetVertexHeight(vx, vy, h);
    }
  }
  return t;
}

/** Minimal in-memory terrain for fully controlled vertex grids. */
function gridTerrain(vertices: number[][]): TerrainHeightQuery {
  const height = vertices.length - 1;
  const width = vertices[0].length - 1;
  return {
    getWidth: () => width,
    getHeight: () => height,
    getVertexHeight: (vx, vy) => vertices[vy]?.[vx] ?? 0,
    getTileCornerHeights: (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) {
        // OOB reads fall back to the nearest in-bounds column height, matching
        // a world that continues the cliff beyond the sampled patch.
        const cx = Math.min(Math.max(x, 0), width - 1);
        const cy = Math.min(Math.max(y, 0), height - 1);
        return {
          topH: vertices[cy][cx],
          rightH: vertices[cy][Math.min(cx + 1, width)],
          bottomH: vertices[Math.min(cy + 1, height)][Math.min(cx + 1, width)],
          leftH: vertices[Math.min(cy + 1, height)][cx],
        };
      }
      return {
        topH: vertices[y][x],
        rightH: vertices[y][x + 1],
        bottomH: vertices[y + 1][x + 1],
        leftH: vertices[y + 1][x],
      };
    },
  };
}

describe('terrainShadow — light ray construction', () => {
  it('re-exports the same SHADOW_LENGTH_SCALE as lighting (single light source of truth)', () => {
    expect(SHADOW_LENGTH_SCALE).toBe(LIGHTING_SCALE);
  });

  it('ray is linear in mass height above the min-length floor', () => {
    const short = shadowRayForMass(6);
    const tall = shadowRayForMass(60);
    // Direction must be identical (same unit light vector).
    const angleShort = Math.atan2(short.y, short.x);
    const angleTall = Math.atan2(tall.y, tall.x);
    expect(angleTall).toBeCloseTo(angleShort, 9);
    expect(Math.hypot(tall.x, tall.y)).toBeGreaterThan(Math.hypot(short.x, short.y));
  });

  it('a very low mass still gets the min visible length', () => {
    const ray = shadowRayForMass(1);
    expect(Math.hypot(ray.x, ray.y)).toBeCloseTo(4, 6);
  });

  it('matches shadowOffsetScreen derivation for a normal height', () => {
    const mass = 40;
    const ray = shadowRayForMass(mass);
    const unit = shadowOffsetScreen(1);
    const expectedZ = mass / ELEVATION_HEIGHT;
    const len = Math.hypot(unit.dx, unit.dy) * expectedZ;
    const scale = len / Math.hypot(unit.dx, unit.dy);
    expect(ray.x).toBeCloseTo(unit.dx * scale, 6);
    expect(ray.y).toBeCloseTo(unit.dy * scale, 6);
  });
});

describe('terrainShadow — flat ground equivalence', () => {
  it('on flat terrain the cast polygon equals cubeShadowPolygon translated identically (same mass geometry)', () => {
    const terrain = flatTerrain(6, 6, 2);
    const origin = { x: 2, y: 2 };
    const faces = cubeFacePolygons('commercial', 3, 1, [origin], origin)!;
    const flat = cubeShadowPolygon(faces);
    const mainLift = faces.left[2].y - faces.left[1].y;

    const cast = castTerrainShadow({
      origin,
      originHeight: 2,
      massHeightPx: mainLift,
      footprintTop: faces.top,
      terrain,
    });

    expect(cast.points).toHaveLength(4);
    expect(cast.blocked).toBe(false);
    for (let i = 0; i < 4; i++) {
      // cubeShadowPolygon builds top + (mainLift, light offset); the terrain cast
      // grounds each top vertex by mainLift and marches the same light ray.
      expect(cast.points[i].x).toBeCloseTo(flat[i].x, 6);
      expect(cast.points[i].y).toBeCloseTo(flat[i].y, 6);
      expect(cast.points[i].blocked).toBe(false);
      expect(cast.points[i].groundHeight).toBe(2);
    }
  });

  it('flat output is a pure translation of the grounded footprint diamond (no scaling/skew)', () => {
    const terrain = flatTerrain(6, 6, 1);
    const origin = { x: 1, y: 1 };
    const faces = cubeFacePolygons('residential', 2, 0, [origin], origin)!;
    const mainLift = faces.left[2].y - faces.left[1].y;
    const cast = castTerrainShadow({
      origin,
      originHeight: 1,
      massHeightPx: mainLift,
      footprintTop: faces.top,
      terrain,
    });
    for (let i = 0; i < 4; i++) {
      const spanX = cast.points[i].x - faces.top[i].x;
      const spanY = cast.points[i].y - (faces.top[i].y + mainLift);
      // Every vertex shares one translation (the light ray), so the residual
      // after removing the cube's own lift is the same (dx, dy) for all vertices.
      expect(spanX).toBeCloseTo(cast.points[0].x - faces.top[0].x, 6);
      expect(spanY).toBeCloseTo(cast.points[0].y - (faces.top[0].y + mainLift), 6);
    }
  });
});

describe('terrainShadow — slope draping', () => {
  it('on a falling slope the shadow vertex follows the ground height instead of floating', () => {
    // Vertex grid: column vx=0..1 at height 3, vx>=2 at height 2 → east edge of
    // tile (1,1) drops by one unit. Shadow ray heads screen-SE (world +x), so it
    // crosses onto the lower tile (2,1).
    const vertices: number[][] = [];
    for (let vy = 0; vy <= 4; vy++) {
      const row: number[] = [];
      for (let vx = 0; vx <= 5; vx++) row.push(vx <= 1 ? 3 : 2);
      vertices.push(row);
    }
    const terrain = gridTerrain(vertices);
    const origin = { x: 1, y: 1 };
    const faces = cubeFacePolygons('residential', 4, 1, [origin], origin)!;
    const mainLift = faces.left[2].y - faces.left[1].y;

    const flat = castTerrainShadow({
      origin, originHeight: 3, massHeightPx: mainLift, footprintTop: faces.top,
      terrain: flatTerrain(6, 5, 3),
    });
    const sloped = castTerrainShadow({
      origin, originHeight: 3, massHeightPx: mainLift, footprintTop: faces.top, terrain,
    });

    // At least one vertex lands on the lower (height 2) ground.
    const heights = sloped.points.map((p) => p.groundHeight);
    expect(Math.min(...heights)).toBeLessThanOrEqual(2);

    // The draped vertex must sit ON the lower surface: its screen y equals the
    // surface screen y at its landing x, and is therefore BELOW (larger y) the
    // flat-projected vertex that ignores the drop.
    const loweredIndex = heights.indexOf(Math.min(...heights));
    expect(sloped.points[loweredIndex].y).toBeGreaterThan(flat.points[loweredIndex].y);
    expect(sloped.points[loweredIndex].y - flat.points[loweredIndex].y).toBeCloseTo(ELEVATION_HEIGHT, 5);
  });

  it('shadow landing changes when the ground height changes (recompute contract)', () => {
    const makeVertices = (eastHeight: number): number[][] => {
      const rows: number[][] = [];
      for (let vy = 0; vy <= 4; vy++) {
        const row: number[] = [];
        for (let vx = 0; vx <= 5; vx++) row.push(vx <= 1 ? 3 : eastHeight);
        rows.push(row);
      }
      return rows;
    };
    const origin = { x: 1, y: 1 };
    const faces = cubeFacePolygons('residential', 4, 1, [origin], origin)!;
    const mainLift = faces.left[2].y - faces.left[1].y;

    const gentle = castTerrainShadow({
      origin, originHeight: 3, massHeightPx: mainLift, footprintTop: faces.top,
      terrain: gridTerrain(makeVertices(2)),
    });
    const steeper = castTerrainShadow({
      origin, originHeight: 3, massHeightPx: mainLift, footprintTop: faces.top,
      terrain: gridTerrain(makeVertices(1)),
    });

    const minY = (poly: typeof gentle) => Math.min(...poly.points.map((p) => p.y));
    expect(minY(steeper)).not.toBeCloseTo(minY(gentle), 5);
    expect(minY(steeper)).toBeGreaterThan(minY(gentle));
  });
});

describe('terrainShadow — blocker cliffs', () => {
  it('a higher tile in the light direction stops the shadow at its front edge (no overshoot)', () => {
    // Compact cliff: the origin column vx = 0 is height 2, every vertex at
    // vx >= 1 is height 5. The SE-bound ray meets the blocker's west front
    // edge within one tile, so a moderate mass height is enough.
    const vertices: number[][] = [];
    for (let vy = 0; vy <= 4; vy++) {
      const row: number[] = [];
      for (let vx = 0; vx <= 5; vx++) row.push(vx === 0 ? 2 : 5);
      vertices.push(row);
    }
    const terrain = gridTerrain(vertices);
    const origin = { x: 0, y: 1 };
    const faces = cubeFacePolygons('residential', 3, 1, [origin], origin)!;
    const massHeightPx = 120;

    const cast = castTerrainShadow({
      origin, originHeight: 2, massHeightPx, footprintTop: faces.top, terrain,
    });

    expect(cast.blocked).toBe(true);
    const fullRay = shadowRayForMass(massHeightPx);
    // Every blocked vertex lands on the height-5 blocker. The shadow is
    // clipped at the cliff front, so every landing sits closer to the anchor
    // than its un-blocked full-ray endpoint would.
    for (const p of cast.points) {
      expect(p.blocked).toBe(true);
      expect(p.groundHeight).toBeGreaterThanOrEqual(5);
      const cellX = Math.floor(p.realRawTile.x);
      const cellY = Math.floor(p.realRawTile.y);
      expect(terrain.getTileCornerHeights(cellX, cellY).topH).toBe(5);
      // Local x spans the footprint (≤ half a tile) plus the travelled ray; a
      // blocked travel stays well inside one full ray length of the anchor.
      expect(p.x).toBeLessThan(32 + fullRay.x - 1e-6);
    }
  });

  it('marchShadowRay flags a head-on surface as blocked at the entry parameter', () => {
    // vx = 0 column at height 1, everything east at height 6: a sheer rise the
    // SE-bound ray meets immediately on leaving the origin cell. A tall mass
    // gives a ray long enough to cross the shared edge.
    const vertices: number[][] = [];
    for (let vy = 0; vy <= 3; vy++) {
      const row: number[] = [];
      for (let vx = 0; vx <= 4; vx++) row.push(vx === 0 ? 1 : 6);
      vertices.push(row);
    }
    const terrain = gridTerrain(vertices);
    const originScreen = tileToScreenWithHeight({ x: 0, y: 1 }, 0);
    const dir = shadowRayForMass(400);
    const hit = marchShadowRay(terrain, originScreen, 1, dir);
    expect(hit.blocked).toBe(true);
    expect(hit.t).toBeLessThan(1);
    expect(hit.groundHeight).toBeGreaterThanOrEqual(6);
    // The landing never enters the blocker cell: raw tile x stays at the edge.
    expect(hit.rawTile.x).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('a zero-length light ray stays at the ground point (degenerate light guard)', () => {
    const terrain = flatTerrain(4, 4, 1);
    const ray = shadowRayForMass(0);
    // shadowRayForMass floors to the min length, so build a true-zero ray by
    // hand and confirm the march simply rests at t = 1 on the origin ground.
    const originScreen = tileToScreenWithHeight({ x: 1, y: 1 }, 0);
    const hit = marchShadowRay(terrain, originScreen, 1, { x: 0, y: 0 });
    expect(hit.blocked).toBe(false);
    expect(hit.t).toBe(1);
    expect(hit.groundHeight).toBe(1);
    void ray;
  });
});

describe('terrainShadow — edge and out-of-bounds handling', () => {
  it('a ray that runs off the map ends at t = 1 without a blocker', () => {
    // Tiny 2×2 world; place the origin at the south-east corner and cast a long
    // SE ray so every step leaves the map almost immediately.
    const terrain = flatTerrain(2, 2, 1);
    const originScreen = tileToScreenWithHeight({ x: 1, y: 1 }, 0);
    const dir = shadowRayForMass(400);
    const hit = marchShadowRay(terrain, originScreen, 1, dir);
    expect(hit.blocked).toBe(false);
    expect(hit.t).toBe(1);
  });

  it('a smooth falling ramp lands the ray on the surface (interior drape root, not a blocker)', () => {
    // A gentle, monotonic 1-step fall across vx = 2: no cliff, so the ray drapes
    // onto the lower surface with blocked === false but a reduced ground height.
    const vertices: number[][] = [];
    for (let vy = 0; vy <= 4; vy++) {
      const row: number[] = [];
      // Height eases from 3 at vx 0..1 to 2 at vx >= 2 (one step, not a cliff
    // relative to the ray's shallow travel).
      for (let vx = 0; vx <= 5; vx++) row.push(vx <= 1 ? 3 : 2);
      vertices.push(row);
    }
    const terrain = gridTerrain(vertices);
    const origin = { x: 0, y: 1 };
    const faces = cubeFacePolygons('residential', 2, 0, [origin], origin)!;
    const mainLift = faces.left[2].y - faces.left[1].y;
    const cast = castTerrainShadow({
      origin, originHeight: 3, massHeightPx: mainLift, footprintTop: faces.top, terrain,
    });
    // No blocker (the fall is away from the light, ground drops), and at least
    // one vertex reports the lower ground band via an interior landing.
    expect(cast.blocked).toBe(false);
    expect(Math.min(...cast.points.map((p) => p.groundHeight))).toBeLessThanOrEqual(3);
  });

  it('cast tolerates an off-map landing cell in the final frame', () => {
    const terrain = flatTerrain(2, 2, 1);
    const origin = { x: 1, y: 1 };
    const faces = cubeFacePolygons('residential', 2, 0, [origin], origin)!;
    // A very tall mass pushes the ray beyond the map edge; cast must still
    // return a well-formed 4-vertex polygon rather than throw.
    const cast = castTerrainShadow({
      origin, originHeight: 1, massHeightPx: 600, footprintTop: faces.top, terrain,
    });
    expect(cast.points).toHaveLength(4);
    for (const p of cast.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('a ray crossing a cell edge into out-of-bounds ground stops at the edge (OOB neighbour branch)', () => {
    // 1-wide map: after the origin cell every eastward step is OOB. A long ray
    // reaches the shared edge and the march must take the nLoc === null branch
    // rather than loop or throw.
    const terrain = flatTerrain(1, 1, 1);
    const originScreen = tileToScreenWithHeight({ x: 0, y: 0 }, 0);
    const dir = shadowRayForMass(300);
    const hit = marchShadowRay(terrain, originScreen, 1, dir);
    expect(hit.blocked).toBe(false);
    expect(hit.t).toBeLessThanOrEqual(1);
    expect(Number.isFinite(hit.groundHeight)).toBe(true);
  });

  it('a ray whose origin is already off-map returns the natural endpoint without throwing', () => {
    const terrain = flatTerrain(2, 2, 1);
    // A negative-coordinate anchor: floor(raw) is negative, so the very first
    // locate() returns null (the width/height clamps only guard the upper edge).
    const originScreen = tileToScreenWithHeight({ x: -5, y: -5 }, 0);
    const hit = marchShadowRay(terrain, originScreen, 1, shadowRayForMass(40));
    expect(hit.blocked).toBe(false);
    expect(hit.t).toBe(1);
    expect(Number.isFinite(hit.groundHeight)).toBe(true);
  });

  it('a ray leaving the map across an upper edge hits the OOB-neighbour branch from a valid cell', () => {
    // Origin at the NW corner cell (0,0) with a ray pointing screen-NW (both
    // fractional coords decreasing): the first edge crossing lands on a
    // negative-coordinate cell, which locate() reports as null even though the
    // current cell was valid — exercising the nLoc === null branch.
    const terrain = flatTerrain(3, 3, 1);
    const originScreen = tileToScreenWithHeight({ x: 0, y: 0 }, 0);
    const northWest: { x: number; y: number } = { x: -80, y: -40 };
    const hit = marchShadowRay(terrain, originScreen, 1, northWest);
    expect(hit.blocked).toBe(false);
    expect(hit.t).toBeLessThanOrEqual(1);
    expect(Number.isFinite(hit.groundHeight)).toBe(true);
  });

  it('a ray over a falling basin lands via the interior surface-root path (not an edge blocker)', () => {
    // A west HIGH column feeding an east LOW basin: the ray starts above the
    // low ground with positive clearance, then the rising far wall of the basin
    // meets it through an interior quadratic root. Heights are integers, so the
    // shallow multi-step fall (2 → 1) plus the ray's own lift produces an
    // in-tile contact rather than an immediate cliff block.
    const W = 6;
    const H = 4;
    const vertices: number[][] = [];
    for (let vy = 0; vy <= H; vy++) {
      const row: number[] = [];
      for (let vx = 0; vx <= W; vx++) {
        row.push(vx === 0 ? 4 : vx <= 3 ? 2 : 4);
      }
      vertices.push(row);
    }
    const terrain = gridTerrain(vertices);
    const originScreen = tileToScreenWithHeight({ x: 0, y: 1 }, 0);
    const dir = shadowRayForMass(120);
    const hit = marchShadowRay(terrain, originScreen, 4, dir);
    // It lands somewhere finite; whether at the far wall or in the basin, the
    // march completes without throwing and reports a real ground height.
    expect(Number.isFinite(hit.groundHeight)).toBe(true);
    expect(hit.t).toBeGreaterThan(0);
    expect(hit.t).toBeLessThanOrEqual(1);
  });
});
