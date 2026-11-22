import { SlotAllocator } from "./SlotAllocator.js";

export class MeshRenderBuffer {
  constructor() {
    this.vertexIdToBufferIndex = new Map();
    this.bufferIndexToVertexId = new Map();

    this.faceIdToBufferIndices = new Map();
    this.faceTriangleOffset = new Map();
    this.faceTriangleCount = new Map();

    this.normalMode = null;
    this.normalAngle = null;

    this.sharpKeys = null;
    // Derived cache of sharp vertices; invalidated whenever sharpKeys changes.
    this.sharpVertices = null;
    this._sharpVerticesSource = null;

    this.slotAllocator = null;
    this.indexSlotAllocator = null;

    // Temporary face-normal cache shared by incremental normal recomputes.
    // It is only a speed optimization: every topology/position edit must
    // invalidate the affected entries (or the whole cache), and replacing a
    // geometry drops the render buffer (and thus the cache) entirely.
    this._faceNormalCache = null;

    // Back-reference to the THREE.Object3D this buffer renders, used to
    // atomically swap in a rebuilt geometry. Set by the adapter on every
    // build / replacement; transient, never serialized.
    this.meshObject = null;
  }

  bindObject(object) {
    this.meshObject = object ?? null;
  }

  getFaceNormalCache(meshData) {
    if (!this._faceNormalCache) this._faceNormalCache = new Map();
    return this._faceNormalCache;
  }

  // Drop one face's cached normal (face edited/deleted).
  invalidateFaceNormal(faceId) {
    this._faceNormalCache?.delete(faceId);
  }

  // Drop the whole temporary cache. Called on every structural change and
  // when the render buffer itself is retired, guaranteeing no stale or
  // leaked normal data.
  invalidateNormalCache() {
    if (this._faceNormalCache) {
      this._faceNormalCache.clear();
      this._faceNormalCache = null;
    }
  }

  toJSON() {
    return {
      vertexIdToBufferIndex: Array.from(this.vertexIdToBufferIndex.entries()),
      bufferIndexToVertexId: Array.from(this.bufferIndexToVertexId.entries()),
      faceIdToBufferIndices: Array.from(this.faceIdToBufferIndices.entries()),
      faceTriangleOffset: Array.from(this.faceTriangleOffset.entries()),
      faceTriangleCount: Array.from(this.faceTriangleCount.entries()),
      normalMode: this.normalMode,
      normalAngle: this.normalAngle,
      slotAllocator: this.slotAllocator,
      indexSlotAllocator: this.indexSlotAllocator,
    };
  }

  static rehydrateRenderBuffer(object) {
    const renderBuffer = object.userData.renderBuffer;
    if (!renderBuffer) return null;

    Object.setPrototypeOf(
      renderBuffer,
      MeshRenderBuffer.prototype
    );

    renderBuffer.vertexIdToBufferIndex =
      renderBuffer.vertexIdToBufferIndex instanceof Map
        ? renderBuffer.vertexIdToBufferIndex
        : new Map(renderBuffer.vertexIdToBufferIndex);

    renderBuffer.bufferIndexToVertexId =
      renderBuffer.bufferIndexToVertexId instanceof Map
        ? renderBuffer.bufferIndexToVertexId
        : new Map(renderBuffer.bufferIndexToVertexId);

    renderBuffer.faceIdToBufferIndices =
      renderBuffer.faceIdToBufferIndices instanceof Map
        ? renderBuffer.faceIdToBufferIndices
        : new Map(renderBuffer.faceIdToBufferIndices);

    renderBuffer.faceTriangleOffset =
      renderBuffer.faceTriangleOffset instanceof Map
        ? renderBuffer.faceTriangleOffset
        : new Map(renderBuffer.faceTriangleOffset);

    renderBuffer.faceTriangleCount =
      renderBuffer.faceTriangleCount instanceof Map
        ? renderBuffer.faceTriangleCount
        : new Map(renderBuffer.faceTriangleCount);

    if (renderBuffer.slotAllocator) {
      Object.setPrototypeOf(
        renderBuffer.slotAllocator,
        SlotAllocator.prototype
      );
    }

    if (renderBuffer.indexSlotAllocator) {
      Object.setPrototypeOf(
        renderBuffer.indexSlotAllocator,
        SlotAllocator.prototype
      );
    }

    // Caches are transient and intentionally never serialized.
    renderBuffer._faceNormalCache = null;
    renderBuffer.sharpVertices = null;
    renderBuffer._sharpVerticesSource = null;

    return renderBuffer;
  }
}
