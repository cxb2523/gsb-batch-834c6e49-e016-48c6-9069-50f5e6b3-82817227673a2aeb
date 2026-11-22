import { MeshRendererAdapter } from '../geometry/MeshRendererAdapter.js';
import { SharpUtils } from './SharpUtils.js';

export const SHADING_MODES = ['flat', 'smooth', 'auto'];
export const DEFAULT_SHADING_MODE = 'flat';
export const DEFAULT_SHADING_ANGLE = 60;

export class ShadingUtils {
  static getShading(object) {
    return this.normalize({
      mode: object.userData.shading,
      angle: object.userData.shadingAngle,
    });
  }

  static normalize({ mode, angle } = {}) {
    return {
      mode: SHADING_MODES.includes(mode) ? mode : DEFAULT_SHADING_MODE,
      angle: Number.isFinite(angle) ? Math.min(Math.max(angle, 0), 180) : DEFAULT_SHADING_ANGLE,
    };
  }

  static setShading(object, patch) {
    const state = this.normalize({ ...this.getShading(object), ...patch });

    object.userData.shading = state.mode;
    object.userData.shadingAngle = state.angle;

    this.rebuildShading(object);
    return state;
  }

  // Re-apply shading to an existing object.
  //
  // The duplicated vertex/index buffer layout is identical for every shading
  // mode, so when a render buffer already exists we recompute normals in
  // place through the adapter's single normal entry — no slot reallocation,
  // no BufferGeometry replacement, no GPU resource churn. A full rebuild only
  // happens when there is no usable render buffer yet.
  static rebuildShading(object) {
    const meshData = object.userData.meshData;
    if (!meshData) return;

    const { mode, angle } = this.getShading(object);
    const sharps = SharpUtils.getSharpIds(object);

    const renderBuffer = object.userData.renderBuffer;
    const geometry = object.geometry;

    const appliedInPlace =
      renderBuffer &&
      geometry?.attributes?.normal &&
      MeshRendererAdapter.applyShading(meshData, renderBuffer, geometry, { mode, angle, sharps });

    if (!appliedInPlace) {
      const built = MeshRendererAdapter.toBufferGeometry(meshData, { mode, angle, sharps });
      MeshRendererAdapter.replaceObjectGeometry(object, built.geometry, built.renderBuffer);
    }

    geometry?.computeBoundingBox?.();
    geometry?.computeBoundingSphere?.();
  }
}
