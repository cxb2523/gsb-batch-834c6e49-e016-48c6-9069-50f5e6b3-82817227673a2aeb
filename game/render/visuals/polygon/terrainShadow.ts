/**
 * Terrain-conforming drop shadows — pure geometry, no Pixi imports.
 *
 * A building's flat shadow polygon (`cubeShadowPolygon`) is a screen-space
 * translation of its mass footprint onto the z = 0 plane. On sloped terrain
 * that plane does not exist: a translated polygon either floats above a
 * falling slope or punches through a rising one, and it can run across the
 * face of a higher neighbouring tile.
 *
 * This module re-casts the SAME mass geometry onto the actual terrain. The
 * march walks the iso tile mesh in a height-relative frame rather than raw
 * screen pixels:
 *
 *   - Every point carries an implicit ground height. A ray point P(t) is the
 *     stylized light translation (length linear in mass height, with the
 *     SHADOW_MIN_LENGTH floor) of the mass's wall-bottom base point.
 *   - At each screen position the terrain surface height is read from the
 *     bilinear corner-height patch. The ray's "clearance" is the vertical
 *     screen-space gap between the ray point and the surface, both measured
 *     from the same zero-height grid, so terrain lift never double-counts.
 *   - Terrain heights are integer steps, so a height change happens exactly
 *     on a shared tile edge. On crossing each edge, a neighbour whose surface
 *     overtops the ray is a blocker and stops the shadow on its front edge;
 *     otherwise the march advances and the landing cell's bilinear height is
 *     used to drape the vertex onto the ground.
 *   - Landing vertices are projected onto the surface, so the polygon drapes
 *     with the ground instead of staying a flat translation.
 *
 * On flat terrain every ray rides its own plane to t = 1 and the output is
 * bit-identical to `cubeShadowPolygon` (pinned in terrainShadow.test.ts).
 *
 * The module only READS corner heights through `TerrainHeightQuery`; it never
 * touches simulation state.
 */

import { ISO_CONFIG, screenToTileRaw, tileToScreenWithHeight } from '@/game/render/IsoTransform';
import { ELEVATION_HEIGHT } from '@/game/core/Terrain';
import { shadowOffsetScreen, SHADOW_LENGTH_SCALE } from '../lighting';
import type { Point } from './cubeGeometry';

/** Read-only terrain surface access needed by the shadow cast. A `Terrain` satisfies this structurally. */
export interface TerrainHeightQuery {
  getWidth(): number;
  getHeight(): number;
  getTileCornerHeights(
    x: number,
    y: number,
  ): { topH: number; rightH: number; bottomH: number; leftH: number };
  getVertexHeight(vx: number, vy: number): number;
}

export interface ShadowCastInput {
  /** Cell the mass stands on (structure anchor for buildings). */
  origin: { x: number; y: number };
  /** Terrain height (elevation units) the mass's feet stand at. */
  originHeight: number;
  /** Mass height above its feet in screen px — drives the linear shadow length. */
  massHeightPx: number;
  /**
   * The mass's footprint top-face polygon in the anchor-local screen frame
   * (e.g. `cubeFacePolygons(...).top` or `massingBoxFaces(...).top`). Ground
   * base points are these vertices dropped by `massHeightPx`; the light ray
   * then carries the flat-ground offset, so on flat terrain the cast output is
   * bit-identical to `cubeShadowPolygon`.
   */
  footprintTop: ReadonlyArray<Point>;
  terrain: TerrainHeightQuery;
}

export interface TerrainShadowPoint extends Point {
  /** Terrain height (elevation units) the draped vertex sits on. */
  groundHeight: number;
  /** True when the ray was stopped by a higher tile's front edge. */
  blocked: boolean;
  /** Fractional tile coords of the landing point (un-lifted frame), for edge/occlusion tests. */
  rawTile: { x: number; y: number };
  /** Fractional tile coords in the real lifted frame — the cell where a blocker edge is met. */
  realRawTile: { x: number; y: number };
}

export interface TerrainShadowPolygon {
  points: TerrainShadowPoint[];
  /** True when at least one vertex was clipped by a blocking slope. */
  blocked: boolean;
}

/** Re-exported so callers/tests pin the same light constant the cast uses. */
export { SHADOW_LENGTH_SCALE };

const HH = ISO_CONFIG.TILE_HEIGHT / 2;

// Minimum on-screen shadow length — kept equal to cubeDropShadow's floor; a
// test pins the two constants together.
const SHADOW_MIN_LENGTH = 4;

/**
 * Stylized light ray for a mass of the given pixel height, as a screen-space
 * Point (x/y) so it feeds `marchShadowRay` directly.
 *
 * Reconstructs `cubeShadowPolygon`'s offset exactly: `shadowOffsetScreen(z)`
 * with `z = massHeightPx / ELEVATION_HEIGHT`, magnitude-clamped to
 * SHADOW_MIN_LENGTH.
 */
export function shadowRayForMass(massHeightPx: number): Point {
  const unit = shadowOffsetScreen(1);
  const unitLen = Math.hypot(unit.dx, unit.dy);
  if (unitLen === 0) return { x: 0, y: 0 };
  const naturalLen = unitLen * (massHeightPx / ELEVATION_HEIGHT);
  const finalLen = Math.max(SHADOW_MIN_LENGTH, naturalLen);
  const scale = finalLen / unitLen;
  return { x: unit.dx * scale, y: unit.dy * scale };
}

/** Bilinear terrain height (elevation units) at a fractional in-tile position. */
function bilinearHeight(
  corners: { topH: number; rightH: number; bottomH: number; leftH: number },
  u: number,
  v: number,
): number {
  const { topH, rightH, bottomH, leftH } = corners;
  const top = topH + (rightH - topH) * u;
  const bottom = leftH + (bottomH - leftH) * u;
  return top + (bottom - top) * v;
}

interface Located {
  x: number;
  y: number;
  u: number;
  v: number;
  rawX: number;
  rawY: number;
}

/** Fractional tile coords of a screen point plus the containing tile index. */
function locate(terrain: TerrainHeightQuery, sx: number, sy: number): Located | null {
  const raw = screenToTileRaw(sx, sy);
  let x = Math.floor(raw.x);
  let y = Math.floor(raw.y);
  // Snap points resting on a shared edge/corner back inside the valid range:
  // a value that floors to the boundary index must index an in-bounds tile.
  if (x >= terrain.getWidth()) x = terrain.getWidth() - 1;
  if (y >= terrain.getHeight()) y = terrain.getHeight() - 1;
  if (x < 0 || y < 0) return null;
  return {
    x,
    y,
    u: Math.min(Math.max(raw.x - x, 0), 1),
    v: Math.min(Math.max(raw.y - y, 0), 1),
    rawX: raw.x,
    rawY: raw.y,
  };
}

/**
 * Terrain surface height (elevation units) under a screen point, or null off
 * the map. Bilinear over the tile's four shared corner heights.
 */
function surfaceHeightAt(terrain: TerrainHeightQuery, sx: number, sy: number): number | null {
  const loc = locate(terrain, sx, sy);
  if (loc === null) return null;
  return bilinearHeight(terrain.getTileCornerHeights(loc.x, loc.y), loc.u, loc.v);
}

interface RayHit {
  t: number;
  groundHeight: number;
  blocked: boolean;
  /** Fractional tile coords in the un-lifted frame, used for the local y projection. */
  rawTile: { x: number; y: number };
  /** Fractional tile coords in the REAL lifted frame — the cells the march
   *  actually traversed and where a blocker edge is detected. */
  realRawTile: { x: number; y: number };
}

/**
 * Parameter distance along `dir` from a fractional tile position to the nearest
 * tile boundary the ray crosses. Returns the parameter delta; a small positive
 * floor keeps the march advancing even when a point lands on a shared edge.
 */
function paramToTileEdge(loc: Located, dir: Point): number {
  const dRaw = screenToTileRaw(dir.x, dir.y);
  let best = Infinity;
  // Clamp the in-cell fractions away from the exact boundaries so a point
  // resting on an edge measures the distance through the cell, not zero.
  const u = Math.min(Math.max(loc.u, 1e-9), 1 - 1e-9);
  const v = Math.min(Math.max(loc.v, 1e-9), 1 - 1e-9);
  if (dRaw.x > 1e-12) best = Math.min(best, (1 - u) / dRaw.x);
  else if (dRaw.x < -1e-12) best = Math.min(best, u / -dRaw.x);
  if (dRaw.y > 1e-12) best = Math.min(best, (1 - v) / dRaw.y);
  else if (dRaw.y < -1e-12) best = Math.min(best, v / -dRaw.y);
  if (!Number.isFinite(best) || best <= 0) return 1;
  return best;
}

/**
 * March one stylized shadow ray.
 *
 * Coordinates are in the UN-LIFTED anchor frame (zero-height grid); the
 * terrain lookup internally re-adds `originHeight · ELEVATION_HEIGHT` to the
 * screen y because `locate`/`surfaceHeightAt` speak real (lifted) screen
 * coordinates. The ray rides a constant elevation equal to the origin ground,
 * matching `cubeShadowPolygon`'s pure horizontal translation.
 *
 * Blocker rule: on crossing a shared edge, a neighbour whose surface at entry
 * is at or above the ray stops the shadow on that front edge. On flat ground
 * the ray rides its own plane to t = 1.
 */
export function marchShadowRay(
  terrain: TerrainHeightQuery,
  originScreen: Point,
  originHeight: number,
  dir: Point,
): RayHit {
  const liftPx = originHeight * ELEVATION_HEIGHT;
  // Translate an un-lifted-frame point to the real lifted screen frame for
  // terrain queries. x is unaffected by elevation; only screen y shifts.
  const realY = (frameY: number): number => frameY + liftPx;
  const frameSurfaceH = (px: number, frameY: number): number | null =>
    surfaceHeightAt(terrain, px, realY(frameY));
  // Landing fractional tile coords. The un-lifted pair drives the local y
  // projection (no origin lift double-count); the real (lifted) pair records
  // the cells the march actually traversed, where blocker edges are detected.
  const rawTileAt = (frameX: number, frameY: number) => ({
    rawTile: screenToTileRaw(frameX, frameY),
    realRawTile: screenToTileRaw(frameX, realY(frameY)),
  });

  const clearance = (tt: number): number => {
    const px = originScreen.x + dir.x * tt;
    const py = originScreen.y + dir.y * tt;
    const surfaceH = frameSurfaceH(px, py);
    if (surfaceH === null) return Number.POSITIVE_INFINITY; // off-map: nothing to hit
    // Ray elevation above the zero grid minus the surface elevation.
    return liftPx - surfaceH * ELEVATION_HEIGHT;
  };

  let t = 0;
  for (let guard = 0; guard < 256; guard++) {
    const sx = originScreen.x + dir.x * t;
    const sy = originScreen.y + dir.y * t;
    const loc = locate(terrain, sx, realY(sy));
    if (loc === null) {
      return { t: 1, groundHeight: originHeight, blocked: false, ...rawTileAt(sx, sy) };
    }

    const dtEdge = paramToTileEdge(loc, dir);
    const tExit = Math.min(1, t + dtEdge);

    if (tExit >= 1) break;

    // Inspect the neighbour across the exit edge before committing to it.
    // Integer elevation steps mean a height change occurs exactly on a shared
    // vertex/edge, so surface contact is always detected at tile entry — there
    // is no in-tile crossing to solve for (the bilinear patch is only used to
    // read the landing height once the cell is reached).
    const nextT = tExit + 1e-9;
    const nx = originScreen.x + dir.x * nextT;
    const ny = originScreen.y + dir.y * nextT;
    const nLoc = locate(terrain, nx, realY(ny));
    if (nLoc === null) {
      const edgeH = frameSurfaceH(sx, sy) ?? originHeight;
      return { t: tExit, groundHeight: edgeH, blocked: false, ...rawTileAt(sx, sy) };
    }
    if (clearance(nextT) < -1e-9) {
      // Strictly negative clearance: the neighbour's surface overtops the ray —
      // a blocker. Zero clearance is same-height ground continuation (flat
      // ground rides clearance 0 for its whole path) and must not block.
      const h = bilinearHeight(terrain.getTileCornerHeights(nLoc.x, nLoc.y), nLoc.u, nLoc.v);
      return { t: tExit, groundHeight: h, blocked: true, ...rawTileAt(nx, ny) };
    }
    t = nextT;
  }

  const endX = originScreen.x + dir.x;
  const endY = originScreen.y + dir.y;
  const groundHeight = frameSurfaceH(endX, endY) ?? originHeight;
  return { t: 1, groundHeight, blocked: false, ...rawTileAt(endX, endY) };
}

/**
 * Cast the full terrain-conforming shadow polygon for one mass.
 *
 * Each footprint top vertex is dropped to its wall-bottom base point, then the
 * light ray is marched in the un-lifted anchor frame. The landed point is
 * projected onto the surface by re-deriving its screen y from the landing
 * cell's height, so the polygon drapes on slopes while staying bit-identical to
 * `cubeShadowPolygon` on flat ground.
 */
export function castTerrainShadow(input: ShadowCastInput): TerrainShadowPolygon {
  const { origin, originHeight, massHeightPx, footprintTop, terrain } = input;
  // Anchor-local frame origin = un-lifted anchor screen position. The Pixi
  // wrapper supplies the terrain lift, so the cached context geometry must be
  // expressed against this frame regardless of originHeight.
  const anchorScreen = tileToScreenWithHeight(origin, 0);
  const dir = shadowRayForMass(massHeightPx);

  let anyBlocked = false;
  const points: TerrainShadowPoint[] = footprintTop.map((topVertex) => {
    // Wall-bottom base point in the un-lifted frame.
    const bx = anchorScreen.x + topVertex.x;
    const by = anchorScreen.y + topVertex.y + massHeightPx;
    const hit = marchShadowRay(terrain, { x: bx, y: by }, originHeight, dir);
    if (hit.blocked) anyBlocked = true;

    const landX = bx + dir.x * hit.t;
    // Zero-height grid screen-y at the landing point (fractional tile coords),
    // expressed anchor-local.
    const gridLocalY = (hit.rawTile.x + hit.rawTile.y) * HH - anchorScreen.y;
    // Surface local y = grid y minus the RELATIVE terrain lift (the wrapper
    // already carries the origin's own lift). Flat ground: relative lift 0 →
    // the natural translated y.
    const drapedLocalY = gridLocalY - (hit.groundHeight - originHeight) * ELEVATION_HEIGHT;

    return {
      x: landX - anchorScreen.x,
      y: drapedLocalY,
      groundHeight: hit.groundHeight,
      blocked: hit.blocked,
      rawTile: hit.rawTile,
      realRawTile: hit.realRawTile,
    };
  });

  return { points, blocked: anyBlocked };
}
