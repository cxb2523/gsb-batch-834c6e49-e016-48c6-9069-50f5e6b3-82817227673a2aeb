/**
 * Unified world-depth ordering for the render layer.
 *
 * Before this module the terrain layer and the building layer each owned a
 * private z-index scale (`computeTerrainZIndex` vs `computeZIndex`) and lived
 * in separate Pixi containers, so a building on a low cell could paint over a
 * higher neighbouring slope and a drop shadow could never be occluded by the
 * terrain it falls on.
 *
 * This module is the ONE depth vocabulary every visible object now speaks:
 *   - primary key  : the world height (elevation units) the object's feet
 *                    stand on — terrain/roads use their tile render height,
 *                    buildings use their structure anchor's render height,
 *                    shadows use the ground height they actually land on;
 *   - secondary key: iso forward-diagonal depth x + y (painter's order);
 *   - tertiary key : y (south wins on a shared forward diagonal).
 *
 * All three callers (DiamondTileVisual, CubeBuildingVisual, the structure
 * visuals, shadows, decorations) feed the same formula, so once terrain and
 * buildings share one sortable container the front/back relation between any
 * two objects is a property of world position alone — it cannot change when
 * the camera pans, because camera translation is applied by a parent
 * transform and never touches these values.
 *
 * Pure math — no Pixi imports, safe to coverage-gate and unit test.
 */

/** Scale of the elevation band; within one elevation row the iso depth key spans 1000. */
export const WORLD_Z_HEIGHT_SCALE = 1_000_000;

/** Scale of the iso forward-diagonal (x + y) key inside one elevation band. */
export const WORLD_Z_DEPTH_SCALE = 1_000;

/**
 * Named sub-layers inside the single sorted world container. Every visible
 * object belongs to exactly one band, so the relative order is a pure function
 * of world position + layer role and cannot change when the camera pans:
 *
 *   terrain/road/yard  → raw world z (see computeWorldZIndex), max ≈ 8.5·10⁶
 *   drop shadows       → WORLD_SHADOW_BASE + compact depth key (above every
 *                        ground cell, below every structure face); vertical
 *                        correctness against higher terrain comes from geometric
 *                        clipping in terrainShadow, not from z fighting
 *   structure faces    → WORLD_STRUCTURE_BASE + world z (always above shadows)
 */
export const WORLD_SHADOW_BASE = 9_000_000;
export const WORLD_STRUCTURE_BASE = 10_000_000;

/**
 * Unified world z-index for an object whose feet occupy world cell (x, y) at
 * the given ground height.
 *
 * Equals `computeTerrainZIndex(renderHeight, x, y)` bit-for-bit, which keeps
 * every existing terrain ordering invariant while admitting building-layer
 * objects into the same sorted container.
 */
export function computeWorldZIndex(groundHeight: number, x: number, y: number): number {
  return groundHeight * WORLD_Z_HEIGHT_SCALE + (x + y) * WORLD_Z_DEPTH_SCALE + y;
}

/**
 * Backmost (largest x + y, then y) cell of a footprint — the natural "feet"
 * position of an extruded mass, since its south corner is the last point a
 * painter's-order sweep reaches.
 */
export function footprintFrontCell(
  footprint: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } {
  let best = footprint[0];
  for (let i = 1; i < footprint.length; i++) {
    const c = footprint[i];
    if (c.x + c.y > best.x + best.y || (c.x + c.y === best.x + best.y && c.y > best.y)) {
      best = c;
    }
  }
  return best;
}

/**
 * World z-index of a building mass standing on `groundHeight` terrain.
 *
 * The footprint front cell drives the iso-depth tie-breaks so two buildings
 * on equal ground sort exactly as the old building-only `computeZIndex` did
 * relative to each other; the elevation band is what now lets raised terrain
 * and neighbouring buildings interleave correctly.
 *
 * Returns a below-everything sentinel for an empty footprint so callers never
 * index into an undefined cell.
 */
export function computeBuildingWorldZIndex(
  groundHeight: number,
  footprint: ReadonlyArray<{ x: number; y: number }>,
): number {
  if (footprint.length === 0) return -WORLD_Z_HEIGHT_SCALE;
  const front = footprintFrontCell(footprint);
  return computeWorldZIndex(groundHeight, front.x, front.y);
}

/**
 * World z-index for a structure visual whose anchor cell stands on
 * `groundHeight` terrain. Structures are single-cell or 2×2 masses whose
 * anchor is the NW cell; the footprint front cell gives the painter depth.
 */
export function structureWorldZIndex(
  groundHeight: number,
  footprint: ReadonlyArray<{ x: number; y: number }>,
): number {
  return WORLD_STRUCTURE_BASE + computeBuildingWorldZIndex(groundHeight, footprint);
}

/**
 * World z-index for a building's face wrapper in the unified container.
 */
export function buildingFaceWorldZIndex(
  groundHeight: number,
  footprint: ReadonlyArray<{ x: number; y: number }>,
): number {
  return WORLD_STRUCTURE_BASE + computeBuildingWorldZIndex(groundHeight, footprint);
}

/**
 * World z-index for a cast drop shadow. Shadows form one compact sub-layer
 * above every terrain/road cell but below every structure face. The compact
 * key preserves iso painter order among shadows while keeping the band clear
 * of the terrain and structure ranges.
 */
export function buildingShadowWorldZIndex(
  origin: { x: number; y: number },
): number {
  return WORLD_SHADOW_BASE + (origin.x + origin.y) * WORLD_Z_DEPTH_SCALE + origin.y;
}
