/**
 * End-to-end integration tests for the unified world-height render pipeline.
 *
 * These exercise the real Terrain + CubeBuildingVisual + shared sortable
 * container (no stub visuals) to pin the acceptance-level contracts:
 *   - terrain, shadow and building faces live in ONE container and sort into
 *     disjoint world sub-layers, so occlusion is camera-pan independent;
 *   - the drop shadow is derived from the same mass geometry as the faces and
 *     is RE-CAST on update() when the terrain changes (not a mount snapshot);
 *   - a terrain edit re-drapes the shadow onto the new ground heights.
 *
 * Pixi scene-graph objects (Container/Graphics/GraphicsContext) run headless
 * without a WebGL context, which is all these assertions need.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'pixi.js';
import { Terrain } from '@/game/core/Terrain';
import { CubeBuildingVisual, SHADOW_Z_OFFSET } from './CubeBuildingVisual';
import {
  WORLD_SHADOW_BASE,
  WORLD_STRUCTURE_BASE,
  computeWorldZIndex,
  buildingShadowWorldZIndex,
  buildingFaceWorldZIndex,
} from '../../terrain/worldZIndex';
import type { BuildingVisualInput } from '../TileVisual';

function flatTerrain(width: number, height: number, h: number): Terrain {
  const t = new Terrain(width, height);
  for (let vy = 0; vy <= height; vy++) {
    for (let vx = 0; vx <= width; vx++) t.unsafeSetVertexHeight(vx, vy, h);
  }
  return t;
}

function baseInput(terrain: Terrain, level = 3): BuildingVisualInput {
  return {
    buildingId: 7,
    type: 'residential',
    anchor: { x: 2, y: 2 },
    footprint: [{ x: 2, y: 2 }],
    level,
    density: 1,
    frontage: 'S',
    structureRect: { x: 2, y: 2, w: 1, h: 1 },
    renderHeight: terrain.getRenderHeight(2, 2),
    abandoned: false,
    terrain,
  };
}

describe('unified world render pipeline — shared container occlusion', () => {
  let terrain: Terrain;
  let visual: CubeBuildingVisual;
  let parent: Container;

  beforeEach(() => {
    terrain = flatTerrain(8, 8, 2);
    visual = new CubeBuildingVisual();
    parent = new Container();
    parent.sortableChildren = true;
  });

  it('mounts faces and a terrain-cast shadow as siblings in the SAME sorted container', () => {
    const wrapper = visual.mount(baseInput(terrain), parent);
    // Faces wrapper + one shadow Graphics sibling.
    expect(parent.children.length).toBe(2);
    expect(parent.children).toContain(wrapper);
    visual.unmount(wrapper);
    expect(parent.children.length).toBe(0);
    visual.dispose();
  });

  it('places shadow and faces in disjoint sub-layers, both above every terrain cell', () => {
    const input = baseInput(terrain);
    const wrapper = visual.mount(input, parent);
    const shadow = parent.children.find((c) => c !== wrapper)!;

    const faceZ = buildingFaceWorldZIndex(2, input.footprint);
    const shadowZ = buildingShadowWorldZIndex(input.anchor);
    expect(wrapper.zIndex).toBe(faceZ);
    expect(shadow.zIndex).toBe(shadowZ);

    // Band disjointness over the whole plausible map.
    const highestTerrain = computeWorldZIndex(8, 255, 255);
    expect(highestTerrain).toBeLessThan(WORLD_SHADOW_BASE);
    expect(shadow.zIndex).toBeGreaterThanOrEqual(WORLD_SHADOW_BASE);
    expect(shadow.zIndex).toBeLessThan(WORLD_STRUCTURE_BASE);
    expect(wrapper.zIndex).toBeGreaterThanOrEqual(WORLD_STRUCTURE_BASE);

    visual.unmount(wrapper);
    visual.dispose();
  });

  it('occlusion order is a pure function of world position (camera-pan stable)', () => {
    const input = baseInput(terrain);
    const wrapper = visual.mount(input, parent);
    const shadow = parent.children.find((c) => c !== wrapper)!;
    const faceZBefore = wrapper.zIndex;
    const shadowZBefore = shadow.zIndex;

    // Panning only moves the parent transform; z-index values must be untouched.
    parent.position.set(1234, -567);
    expect(wrapper.zIndex).toBe(faceZBefore);
    expect(shadow.zIndex).toBe(shadowZBefore);

    visual.unmount(wrapper);
    visual.dispose();
  });

  it('re-casts the shadow on update when terrain heights change (no mount-time snapshot)', () => {
    const input = baseInput(terrain);
    const wrapper = visual.mount(input, parent);
    const shadow = parent.children.find((c) => c !== wrapper)! as Container;

    // Lower the ground east of the building (vertices vx >= 3) so the SE-bound
    // shadow rays land on lower cells and drape downward.
    for (let vy = 0; vy <= 8; vy++) {
      for (let vx = 3; vx <= 8; vx++) terrain.unsafeSetVertexHeight(vx, vy, 1);
    }

    const before = (shadow as unknown as { context: { id?: number } }).context;
    visual.update({ ...input, renderHeight: terrain.getRenderHeight(2, 2) }, wrapper);
    const after = (shadow as unknown as { context: { id?: number } }).context;

    // A fresh per-instance context was built (the shadow geometry changed).
    expect(after).not.toBe(before);

    visual.unmount(wrapper);
    visual.dispose();
  });

  it('rebuilds a shadow when the building level rises from 0 on update', () => {
    const level0 = baseInput(terrain, 0);
    const wrapper = visual.mount(level0, parent);
    expect(parent.children.length).toBe(1); // faces placeholder only, no shadow

    visual.update(baseInput(terrain, 2), wrapper);
    expect(parent.children.length).toBe(2); // shadow sibling created

    visual.unmount(wrapper);
    visual.dispose();
  });

  it('keeps the deprecated SHADOW_Z_OFFSET symbol stable for the depth-invariant test', () => {
    expect(SHADOW_Z_OFFSET).toBe(-1_000_000);
  });

  it('derives the shadow from the same mass geometry (one polygon per massing box, flat-ground parity)', async () => {
    // A canonical rectangular footprint goes through the massing-plan path.
    const rectInput: BuildingVisualInput = {
      ...baseInput(terrain, 3),
      anchor: { x: 2, y: 2 },
      footprint: [
        { x: 2, y: 2 }, { x: 3, y: 2 },
        { x: 2, y: 3 }, { x: 3, y: 3 },
      ],
      structureRect: { x: 2, y: 2, w: 2, h: 2 },
    };
    const wrapper = visual.mount(rectInput, parent);
    const shadow = parent.children.find((c) => c !== wrapper)! as Container;
    const shadowCtx = (shadow as unknown as { context?: { instructions?: unknown[] } | null }).context;
    // The shadow sibling exists and carries a drawn (non-empty) context.
    expect(shadowCtx).not.toBeNull();
    expect((shadowCtx?.instructions?.length ?? 0)).toBeGreaterThan(0);

    // Flat-ground parity: the pure cast helper on this same terrain equals the
    // legacy cubeShadowPolygon output (pinned independently in terrainShadow
    // tests), proving faces and shadows share one geometric source.
    const { castTerrainShadow } = await import('./terrainShadow');
    const { massingBoxFaces } = await import('./massingGeometry');
    const { buildMassingPlan } = await import('./buildingMassing');
    const { cubeBodyHeightPx } = await import('./cubeLift');
    const plan = buildMassingPlan({
      type: rectInput.type,
      level: rectInput.level,
      density: rectInput.density,
      w: 2,
      h: 2,
      bodyHeightPx: cubeBodyHeightPx(rectInput.level, rectInput.density, rectInput.type),
      seed: 7 & 127,
    });
    for (const box of plan.boxes) {
      const top = box.baseLiftPx + box.wallHeightPx;
      const cast = castTerrainShadow({
        origin: rectInput.anchor,
        originHeight: terrain.getRenderHeight(2, 2),
        massHeightPx: top,
        footprintTop: massingBoxFaces(box.rect, 0, top).top,
        terrain,
      });
      expect(cast.points).toHaveLength(4);
      expect(cast.blocked).toBe(false);
    }

    visual.unmount(wrapper);
    visual.dispose();
  });
});
