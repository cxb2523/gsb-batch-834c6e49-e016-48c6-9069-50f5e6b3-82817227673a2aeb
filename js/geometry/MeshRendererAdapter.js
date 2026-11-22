import * as THREE from 'three';
import earcut from 'earcut';
import { computePlaneNormal, projectTo2D } from './TriangulationUtils.js';
import { SlotAllocator } from './SlotAllocator.js';
import { MeshRenderBuffer } from './MeshRenderBuffer.js';
import { SharpUtils } from '../utils/SharpUtils.js';

/**
 * Rendering adapter: VEF MeshData  <->  THREE.BufferGeometry.
 *
 * Unified edit pipeline:
 *
 *   one mesh edit -> slot / faceId mapping sync
 *                  -> triangulation validation (full rebuild when triangle
 *                     counts no longer match the stored layout)
 *                  -> normal recomputation through the single
 *                     recomputeNormals entry, honoring normalMode/normalAngle
 *
 * Incremental topology edits (addFace / deleteFace) always keep the slot
 * bookkeeping and the faceId maps in lockstep. Any structural mismatch that
 * cannot be patched locally (face vertex count changed -> triangle count
 * changed) triggers rebuildObject(), which atomically swaps in a fresh
 * BufferGeometry and disposes the previous one.
 */
export class MeshRendererAdapter {
  // ============================================================
  // Full build
  // ============================================================

  static toBufferGeometry(meshData, options = {}) {
    const { mode = 'auto', angle = 60, sharps = null } = options;

    switch (mode) {
      case 'flat':
        return this.generateFlatGeometry(meshData);
      case 'smooth':
        return this.generateSmoothGeometry(meshData, sharps);
      case 'auto':
        return this.generateAngleBasedGeometry(meshData, angle, sharps);
      default:
        return this.generateAngleBasedGeometry(meshData, angle, sharps);
    }
  }

  static generateFlatGeometry(meshData) {
    const { positions, uvs, indices, renderBuffer } = this.buildDuplicatedMeshData(meshData);
    renderBuffer.normalMode = 'flat';
    const normals = this.recomputeNormals(meshData, renderBuffer, { mode: 'flat' });

    const geometry = this._assembleGeometry(positions, normals, uvs, indices);
    return { geometry, renderBuffer };
  }

  static generateSmoothGeometry(meshData, sharps = null) {
    const { positions, uvs, indices, renderBuffer } = this.buildDuplicatedMeshData(meshData);
    renderBuffer.normalMode = 'smooth';
    SharpUtils.setSharps(meshData, renderBuffer, sharps);
    const normals = this.recomputeNormals(meshData, renderBuffer, { mode: 'smooth' });

    const geometry = this._assembleGeometry(positions, normals, uvs, indices);
    return { geometry, renderBuffer };
  }

  static generateAngleBasedGeometry(meshData, angle = 60, sharps = null) {
    const { positions, uvs, indices, renderBuffer } = this.buildDuplicatedMeshData(meshData);
    renderBuffer.normalMode = 'auto';
    renderBuffer.normalAngle = angle;
    SharpUtils.setSharps(meshData, renderBuffer, sharps);
    const normals = this.recomputeNormals(meshData, renderBuffer, { mode: 'auto', angle });

    const geometry = this._assembleGeometry(positions, normals, uvs, indices);
    return { geometry, renderBuffer };
  }

  static _assembleGeometry(positions, normals, uvs, indices) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  static buildDuplicatedMeshData(meshData) {
    const renderBuffer = new MeshRenderBuffer();

    const positions = [];
    const uvs = [];
    const indices = [];
    let currentIndex = 0;

    for (let f of meshData.faces.values()) {
      let verts = f.vertexIds.map(id => meshData.vertices.get(id));
      const faceUVs = meshData.uvs.get(f.id);

      const baseIndex = currentIndex;
      const faceBufferIndices = [];

      for (let i = 0; i < verts.length; i++) {
        let v = verts[i];

        positions.push(v.position.x, v.position.y, v.position.z);
        uvs.push(faceUVs?.[i]?.u ?? 0, faceUVs?.[i]?.v ?? 0);

        if (!renderBuffer.vertexIdToBufferIndex.has(v.id))
          renderBuffer.vertexIdToBufferIndex.set(v.id, []);
        renderBuffer.vertexIdToBufferIndex.get(v.id).push(currentIndex);

        faceBufferIndices.push(baseIndex + i);

        currentIndex++;
      }
      renderBuffer.faceIdToBufferIndices.set(f.id, faceBufferIndices);

      const tris = this.triangulateFaceVerts(verts);
      const triOffset = indices.length;

      for (let i = 0; i < tris.length; i++) {
        indices.push(baseIndex + tris[i]);
      }

      renderBuffer.faceTriangleOffset.set(f.id, triOffset);
      renderBuffer.faceTriangleCount.set(f.id, tris.length);
    }

    // Orphan (face-less) vertices still need a slot so they can be selected.
    for (let v of meshData.vertices.values()) {
      if (!renderBuffer.vertexIdToBufferIndex.has(v.id)) {
        positions.push(v.position.x, v.position.y, v.position.z);
        uvs.push(0, 0);
        renderBuffer.vertexIdToBufferIndex.set(v.id, [currentIndex]);
        currentIndex++;
      }
    }

    for (let [vertexId, bufferIndices] of renderBuffer.vertexIdToBufferIndex) {
      for (let bufferIndex of bufferIndices) {
        renderBuffer.bufferIndexToVertexId.set(bufferIndex, vertexId);
      }
    }

    const vertCapacity = Math.max(1, Math.ceil(currentIndex * 2));
    const idxCapacity = Math.max(1, Math.ceil(indices.length * 2));

    renderBuffer.slotAllocator = new SlotAllocator(vertCapacity);
    renderBuffer.slotAllocator.alloc(currentIndex);
    renderBuffer.indexSlotAllocator = new SlotAllocator(idxCapacity);
    renderBuffer.indexSlotAllocator.alloc(indices.length);

    const paddedPositions = new Float32Array(vertCapacity * 3);
    paddedPositions.set(positions);
    const paddedUVs = new Float32Array(vertCapacity * 2);
    paddedUVs.set(uvs);
    const paddedIndices = new Uint32Array(idxCapacity);
    paddedIndices.set(indices);

    return { positions: paddedPositions, uvs: paddedUVs, indices: paddedIndices, renderBuffer };
  }

  // ============================================================
  // Triangulation (single implementation shared by every path)
  // ============================================================

  static triangulateFaceVerts(verts) {
    if (verts.length < 3) return [];
    if (verts.length === 3) return [0, 1, 2];

    let hasDuplicatePositions = false;
    for (let i = 0; i < verts.length; i++) {
      for (let j = i + 1; j < verts.length; j++) {
        const p1 = verts[i].position;
        const p2 = verts[j].position;
        if (
          Math.abs(p1.x - p2.x) < 1e-6 &&
          Math.abs(p1.y - p2.y) < 1e-6 &&
          Math.abs(p1.z - p2.z) < 1e-6
        ) {
          hasDuplicatePositions = true;
          break;
        }
      }
      if (hasDuplicatePositions) break;
    }

    if (hasDuplicatePositions) return this._fanTriangles(verts.length);

    const normal = computePlaneNormal(verts);
    const flat = projectTo2D(verts, normal);
    const tris = earcut(flat);
    return tris.length > 0 ? tris : this._fanTriangles(verts.length);
  }

  static _fanTriangles(vertexCount) {
    const tris = [];
    for (let i = 1; i < vertexCount - 1; i++) {
      tris.push(0, i, i + 1);
    }
    return tris;
  }

  // ============================================================
  // Incremental vertex slots (orphan vertices only)
  // ============================================================

  static addVertex(meshData, renderBuffer, geometry, vertexId) {
    const vertex = meshData.vertices.get(vertexId);
    if (!vertex) return;

    if (renderBuffer.vertexIdToBufferIndex.has(vertexId)) return;

    let slot = renderBuffer.slotAllocator.alloc(1);

    if (slot === -1) {
      this._growVertexBuffer(renderBuffer, geometry, 2);
      slot = renderBuffer.slotAllocator.alloc(1);
    }

    const posAttr = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv;
    const normalAttr = geometry.attributes.normal;

    posAttr.setXYZ(slot, vertex.position.x, vertex.position.y, vertex.position.z);
    uvAttr.setXY(slot, 0, 0);
    // Isolated vertex normal fallback, identical to full-build behavior.
    normalAttr.setXYZ(slot, 0, 1, 0);

    renderBuffer.vertexIdToBufferIndex.set(vertexId, [slot]);
    renderBuffer.bufferIndexToVertexId.set(slot, vertexId);

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    normalAttr.needsUpdate = true;
  }

  static deleteVertex(meshData, renderBuffer, geometry, vertexId) {
    const bufferIndices = renderBuffer.vertexIdToBufferIndex.get(vertexId);

    if (!bufferIndices || bufferIndices.length === 0) return;

    // Safe only for standalone vertices.
    // Face vertices must be removed through deleteFace().
    if (bufferIndices.length > 1) return;

    const slot = bufferIndices[0];

    renderBuffer.slotAllocator.free(slot, 1);

    renderBuffer.vertexIdToBufferIndex.delete(vertexId);
    renderBuffer.bufferIndexToVertexId.delete(slot);

    // Drop stale attribute data so a reused slot can never inherit this vertex.
    const posAttr = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv;
    const normalAttr = geometry.attributes.normal;
    posAttr.setXYZ(slot, 0, 0, 0);
    uvAttr.setXY(slot, 0, 0);
    normalAttr.setXYZ(slot, 0, 1, 0);
    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    normalAttr.needsUpdate = true;

    renderBuffer.invalidateNormalCache();
  }

  // ============================================================
  // Incremental face slots — mapping always synced with the allocator
  // ============================================================

  static addFace(meshData, renderBuffer, geometry, faceId) {
    const face = meshData.faces.get(faceId);
    if (!face || renderBuffer.faceIdToBufferIndices.has(faceId)) return;

    const verts = face.vertexIds.map(id => meshData.vertices.get(id));
    if (verts.length < 3 || verts.some(v => !v)) return;
    const faceUVs = meshData.uvs.get(faceId);

    let vertSlot = renderBuffer.slotAllocator.alloc(verts.length);
    if (vertSlot === -1) {
      this._growVertexBuffer(renderBuffer, geometry, Math.max(verts.length * 2, 2));
      vertSlot = renderBuffer.slotAllocator.alloc(verts.length);
    }

    const tris = this.triangulateFaceVerts(verts);

    let idxSlot = renderBuffer.indexSlotAllocator.alloc(tris.length);
    if (idxSlot === -1) {
      this._growIndexBuffer(renderBuffer, geometry, Math.max(tris.length * 2, 1));
      idxSlot = renderBuffer.indexSlotAllocator.alloc(tris.length);
    }

    const posAttr = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv;
    const normalAttr = geometry.attributes.normal;
    const indexAttr = geometry.index;
    const faceBufferIndices = [];

    for (let i = 0; i < verts.length; i++) {
      const slot = vertSlot + i;
      const v = verts[i];
      posAttr.setXYZ(slot, v.position.x, v.position.y, v.position.z);
      uvAttr.setXY(slot, faceUVs?.[i]?.u ?? 0, faceUVs?.[i]?.v ?? 0);

      faceBufferIndices.push(slot);
      if (!renderBuffer.vertexIdToBufferIndex.has(v.id))
        renderBuffer.vertexIdToBufferIndex.set(v.id, []);
      renderBuffer.vertexIdToBufferIndex.get(v.id).push(slot);
      renderBuffer.bufferIndexToVertexId.set(slot, v.id);
    }

    for (let i = 0; i < tris.length; i++) {
      indexAttr.setX(idxSlot + i, vertSlot + tris[i]);
    }

    renderBuffer.faceIdToBufferIndices.set(faceId, faceBufferIndices);
    renderBuffer.faceTriangleOffset.set(faceId, idxSlot);
    renderBuffer.faceTriangleCount.set(faceId, tris.length);

    // A new face contributes fresh normals; any prior cache entry is stale.
    renderBuffer.invalidateFaceNormal(faceId);

    // The single normal entry point: recompute every vertex of the new face
    // (and, through adjacency inside recomputeNormals, their smoothing groups).
    this.recomputeNormals(meshData, renderBuffer, geometry, {
      vertexIds: face.vertexIds,
      faceIds: [faceId],
    });

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    indexAttr.needsUpdate = true;
  }

  static deleteFace(meshData, renderBuffer, geometry, faceId) {
    const bufferIndices = renderBuffer.faceIdToBufferIndices.get(faceId);
    if (!bufferIndices) return;

    const triOffset = renderBuffer.faceTriangleOffset.get(faceId);
    const triCount = renderBuffer.faceTriangleCount.get(faceId);
    const indexAttr = geometry.index;

    const touchedVertexIds = [...new Set(
      bufferIndices.map(b => renderBuffer.bufferIndexToVertexId.get(b)).filter(id => id !== undefined)
    )];

    // Clear the triangle slots first. Writing an out-of-range index (0xFFFFFFFF
    // for a Uint32 index) makes the GPU discard these primitives regardless of
    // whether the slots are later reused by another face — a reused slot is
    // overwritten with a valid index, a free slot never references live data.
    for (let i = 0; i < triCount; i++) {
      indexAttr.setX(triOffset + i, 0xFFFFFFFF);
    }

    renderBuffer.indexSlotAllocator.free(triOffset, triCount);
    renderBuffer.slotAllocator.free(bufferIndices[0], bufferIndices.length);

    for (const slot of bufferIndices) {
      const vertId = renderBuffer.bufferIndexToVertexId.get(slot);
      renderBuffer.bufferIndexToVertexId.delete(slot);
      if (vertId !== undefined) {
        const arr = renderBuffer.vertexIdToBufferIndex.get(vertId);
        if (arr) {
          const i = arr.indexOf(slot);
          if (i !== -1) arr.splice(i, 1);
          if (arr.length === 0) renderBuffer.vertexIdToBufferIndex.delete(vertId);
        }
      }

      // Remove stale per-slot attributes so a reallocated slot starts clean.
      const posAttr = geometry.attributes.position;
      const uvAttr = geometry.attributes.uv;
      const normalAttr = geometry.attributes.normal;
      posAttr.setXYZ(slot, 0, 0, 0);
      uvAttr.setXY(slot, 0, 0);
      normalAttr.setXYZ(slot, 0, 1, 0);
    }

    renderBuffer.faceIdToBufferIndices.delete(faceId);
    renderBuffer.faceTriangleOffset.delete(faceId);
    renderBuffer.faceTriangleCount.delete(faceId);

    renderBuffer.invalidateFaceNormal(faceId);

    // Recompute normals of the vertices that lost this face through the same
    // unified entry. meshData still contains the face at this point (callers
    // remove it afterwards), so exclude it explicitly.
    if (touchedVertexIds.length > 0) {
      this.recomputeNormals(meshData, renderBuffer, geometry, {
        vertexIds: touchedVertexIds,
        excludeFaceIds: [faceId],
      });
    }

    indexAttr.needsUpdate = true;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.uv.needsUpdate = true;
  }

  static _growVertexBuffer(renderBuffer, geometry, additionalSlots) {
    const posAttr = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv;
    const normalAttr = geometry.attributes.normal;
    const oldCount = posAttr.count;
    const newCount = oldCount + additionalSlots;

    const newPos = new Float32Array(newCount * 3);
    newPos.set(posAttr.array);
    const newUV = new Float32Array(newCount * 2);
    newUV.set(uvAttr.array);
    const newNormal = new Float32Array(newCount * 3);
    newNormal.set(normalAttr.array);

    geometry.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(newUV, 2));
    geometry.setAttribute('normal', new THREE.BufferAttribute(newNormal, 3));

    renderBuffer.slotAllocator.grow(additionalSlots);
    renderBuffer.invalidateNormalCache();
  }

  static _growIndexBuffer(renderBuffer, geometry, additionalSlots) {
    const idxAttr = geometry.index;
    const newCount = idxAttr.count + additionalSlots;

    const newIdx = new Uint32Array(newCount);
    newIdx.set(idxAttr.array);
    geometry.setIndex(new THREE.BufferAttribute(newIdx, 1));

    renderBuffer.indexSlotAllocator.grow(additionalSlots);
  }

  // ============================================================
  // Unified normal recomputation entry
  //
  // recomputeNormals(meshData, renderBuffer, geometry?, options?)
  //   options: { mode, angle, vertexIds, faceIds, excludeFaceIds }
  //
  // - Full build path (no geometry): returns a brand-new padded Float32Array.
  // - Incremental path (with geometry): updates only the slots of the given
  //   vertices in place and flags needsUpdate.
  // Every normal change in the adapter flows through this method, so mode /
  // angle switches and topology edits share exactly one implementation.
  // ============================================================

  static recomputeNormals(meshData, renderBuffer, geometryOrOptions = null, maybeOptions = {}) {
    // Support both (meshData, renderBuffer, geometry, options) and
    // (meshData, renderBuffer, options) full-build call shapes.
    let geometry = null;
    let options;
    if (geometryOrOptions instanceof THREE.BufferGeometry) {
      geometry = geometryOrOptions;
      options = maybeOptions ?? {};
    } else {
      options = geometryOrOptions ?? {};
    }

    const mode = options.mode ?? renderBuffer.normalMode ?? 'auto';
    const angle = options.angle ?? renderBuffer.normalAngle ?? 60;
    const excludeFaceIds = new Set(options.excludeFaceIds ?? []);

    const fullBuild = !geometry;
    const capacity = renderBuffer.slotAllocator.capacity;
    const normals = fullBuild
      ? new Float32Array(capacity * 3)
      : geometry.attributes.normal.array;

    const faceNormalCache = renderBuffer.getFaceNormalCache(meshData);
    const getFaceNormal = (fId) => {
      if (excludeFaceIds.has(fId)) return null;
      let n = faceNormalCache.get(fId);
      if (!n) {
        const face = meshData.faces.get(fId);
        if (!face) return null;
        const verts = face.vertexIds.map(id => meshData.vertices.get(id));
        if (verts.some(v => !v)) return null;
        n = computePlaneNormal(verts);
        faceNormalCache.set(fId, n);
      }
      return n;
    };

    const sharpKeys = SharpUtils.getSharpKeys(renderBuffer);
    const sharpVertices = SharpUtils.getSharpVertices(renderBuffer);

    // Decide which vertices need writing. On a full build every vertex is
    // visited; incremental edits touch only the affected vertex set.
    let targetVertexIds;
    if (fullBuild || options.vertexIds === undefined) {
      targetVertexIds = [...meshData.vertices.keys()];
    } else {
      const set = new Set(options.vertexIds);
      for (const fId of options.faceIds ?? []) {
        const face = meshData.faces.get(fId);
        if (face) for (const vId of face.vertexIds) set.add(vId);
      }
      targetVertexIds = [...set];
    }

    const writeSlot = (bufferIdx, x, y, z) => {
      normals[bufferIdx * 3] = x;
      normals[bufferIdx * 3 + 1] = y;
      normals[bufferIdx * 3 + 2] = z;
    };

    for (const vertexId of targetVertexIds) {
      const vertex = meshData.vertices.get(vertexId);
      const slots = renderBuffer.vertexIdToBufferIndex.get(vertexId);
      if (!slots || slots.length === 0) continue;

      const liveFaceIds = vertex
        ? [...vertex.faceIds].filter(fId => meshData.faces.has(fId) && !excludeFaceIds.has(fId))
        : [];

      if (liveFaceIds.length === 0) {
        // Isolated / fully-deleted-around vertex: fixed fallback normal.
        for (const slot of slots) writeSlot(slot, 0, 1, 0);
        continue;
      }

      if (mode === 'flat') {
        // One normal per face corner.
        for (const fId of liveFaceIds) {
          const n = getFaceNormal(fId);
          if (!n) continue;
          const corner = meshData.faces.get(fId).vertexIds.indexOf(vertexId);
          const slot = renderBuffer.faceIdToBufferIndices.get(fId)?.[corner];
          if (slot !== undefined) writeSlot(slot, n.x, n.y, n.z);
        }
        continue;
      }

      if (mode === 'smooth' && !sharpVertices.has(vertexId)) {
        // One shared normal across every corner slot of this vertex.
        const sum = new THREE.Vector3();
        for (const fId of liveFaceIds) {
          const n = getFaceNormal(fId);
          if (n) sum.add(n);
        }
        if (sum.lengthSq() > 0) sum.normalize();
        for (const slot of slots) writeSlot(slot, sum.x, sum.y, sum.z);
        continue;
      }

      // smooth + sharp edge, or auto: smoothing groups per corner.
      const threshold = mode === 'smooth'
        ? Math.PI
        : THREE.MathUtils.degToRad(angle);

      const cornerNormals = this._computeCornerNormals(
        meshData, vertexId, liveFaceIds, getFaceNormal, threshold, sharpKeys
      );

      this._forEachCornerSlot(meshData, renderBuffer, vertexId, cornerNormals, (slot, n) => {
        writeSlot(slot, n.x, n.y, n.z);
      });
    }

    if (fullBuild) return normals;

    const normalAttr = geometry.attributes.normal;
    if (normalAttr) normalAttr.needsUpdate = true;
    return normals;
  }

  // Backward-compatible wrappers used by older call sites / tests.
  static calculateFlatNormals(meshData, renderBuffer) {
    return this.recomputeNormals(meshData, renderBuffer, null, { mode: 'flat' });
  }

  static calculateSmoothNormalsMap(meshData, renderBuffer) {
    return this.recomputeNormals(meshData, renderBuffer, null, { mode: 'smooth' });
  }

  static calculateAngleBasedNormalsMap(meshData, renderBuffer, angleDegree = renderBuffer.normalAngle ?? 60) {
    return this.recomputeNormals(meshData, renderBuffer, null, { mode: 'auto', angle: angleDegree });
  }

  // Incremental normal update for transformed / edited regions.
  // Flat mode rewrites the affected face corners; smooth/auto recompute the
  // affected vertices — both via recomputeNormals.
  static updateNormalsForAffectedFaces(meshData, renderBuffer, geometry, affectedFaces, affectedVertices) {
    const mode = renderBuffer.normalMode ?? 'auto';
    const angle = renderBuffer.normalAngle ?? 60;

    const vertexIds = new Set(affectedVertices ?? []);
    for (const faceId of affectedFaces ?? []) {
      const face = meshData.faces.get(faceId);
      if (face) for (const vId of face.vertexIds) vertexIds.add(vId);
    }

    this.recomputeNormals(meshData, renderBuffer, geometry, {
      mode,
      angle,
      vertexIds: [...vertexIds],
      faceIds: [...(affectedFaces ?? [])],
    });
  }

  // ============================================================
  // Triangulation validation after vertex movement / face edits
  // ============================================================

  // Returns 'ok' when the stored triangulation still matches, 'skip' for
  // faces that cannot be handled locally, and 'rebuilt' when a full rebuild
  // was performed because the triangle count changed.
  static retriangulateFace(meshData, renderBuffer, geometry, faceId) {
    const face = meshData.faces.get(faceId);
    if (!face) return 'skip';

    const verts = face.vertexIds.map(id => meshData.vertices.get(id));
    if (verts.length < 3 || verts.some(v => !v)) return 'skip';

    const faceBufferIndices = renderBuffer.faceIdToBufferIndices.get(faceId);
    const triOffset = renderBuffer.faceTriangleOffset.get(faceId);
    const storedCount = renderBuffer.faceTriangleCount.get(faceId);
    if (!faceBufferIndices || triOffset === undefined || storedCount === undefined) return 'skip';

    const tris = this.triangulateFaceVerts(verts);

    // A face vertex count change (or an earcut result of a different size)
    // cannot be patched into fixed slots: rebuild the whole geometry instead
    // of corrupting neighboring index ranges.
    if (tris.length !== storedCount) {
      this.rebuildObject(renderBuffer.meshObject ?? null, meshData, renderBuffer, geometry);
      return 'rebuilt';
    }

    const indexAttr = geometry.index;
    for (let i = 0; i < tris.length; i++) {
      indexAttr.setX(triOffset + i, faceBufferIndices[tris[i]]);
    }
    indexAttr.needsUpdate = true;
    return 'ok';
  }

  static retriangulateFaces(meshData, renderBuffer, geometry, faceIds) {
    // Validate every face first; a single triangle-count mismatch forces one
    // atomic full rebuild instead of partially rewritten index slots.
    for (const faceId of faceIds) {
      const face = meshData.faces.get(faceId);
      if (!face) continue;
      const storedCount = renderBuffer.faceTriangleCount.get(faceId);
      if (storedCount === undefined) continue;
      const tris = this.triangulateFaceVerts(face.vertexIds.map(id => meshData.vertices.get(id)));
      if (tris.length !== storedCount) {
        this.rebuildObject(renderBuffer.meshObject ?? null, meshData, renderBuffer, geometry);
        return 'rebuilt';
      }
    }

    for (const faceId of faceIds) {
      this.retriangulateFace(meshData, renderBuffer, geometry, faceId);
    }
    return 'ok';
  }

  // ============================================================
  // Shading mode / angle / sharp edge switches
  // ============================================================

  // Apply a shading mode/angle switch in place through the same normal entry.
  // The duplicated buffer layout is identical for all three modes, so no
  // slot reallocation or geometry rebuild is required. Returns false when a
  // full rebuild was unavoidable (should not happen for valid buffers).
  static applyShading(meshData, renderBuffer, geometry, { mode, angle = renderBuffer.normalAngle ?? 60, sharps = undefined } = {}) {
    if (!geometry?.attributes?.normal) {
      return false;
    }

    renderBuffer.normalMode = mode;
    if (mode === 'auto') renderBuffer.normalAngle = angle;

    if (sharps !== undefined) {
      SharpUtils.setSharps(meshData, renderBuffer, sharps);
    }

    // Whole-mesh normal recomputation, same entry as an incremental edit.
    this.recomputeNormals(meshData, renderBuffer, geometry, { mode, angle });
    return true;
  }

  static updateSharpEdges(meshData, renderBuffer, geometry, sharps) {
    const oldKeys = SharpUtils.getSharpKeys(renderBuffer);
    const newKeys = SharpUtils.setSharps(meshData, renderBuffer, sharps);

    // Flat shading splits at every edge; sharp marks only matter once the
    // user switches to smooth/auto, where the full recompute will read them.
    const mode = renderBuffer.normalMode;
    if (mode !== 'auto' && mode !== 'smooth') return;
    if (!geometry.attributes.normal) return;

    const affectedVertices = SharpUtils.diffSharpVertices(oldKeys, newKeys);
    if (affectedVertices.size === 0) return;

    // Only vertices incident to a changed sharp edge are recomputed.
    const angle = renderBuffer.normalAngle ?? 60;
    this.recomputeNormals(meshData, renderBuffer, geometry, {
      mode,
      angle,
      vertexIds: [...affectedVertices],
    });
  }

  // Refresh the cached sharp-key set after topology edits (edge
  // deletion/creation). Stale keys pointing at removed edges are dropped.
  static syncSharpEdges(meshData, renderBuffer, sharpEdgeIds) {
    const live = sharpEdgeIds
      ? new Set([...sharpEdgeIds].filter(id => meshData.edges.has(id)))
      : null;
    SharpUtils.setSharps(meshData, renderBuffer, live);
  }

  // ============================================================
  // Lifecycle: atomic replacement + disposal
  // ============================================================

  // Full rebuild used when the slot layout can no longer represent the
  // topology (triangle count changes). If a host object is supplied the
  // geometry is swapped and the previous BufferGeometry is disposed; the
  // temporary normal cache is dropped with the old render buffer.
  // Returns the new { geometry, renderBuffer }.
  static rebuildObject(object, meshData, currentRenderBuffer = null, currentGeometry = null) {
    const mode = currentRenderBuffer?.normalMode ?? 'auto';
    const angle = currentRenderBuffer?.normalAngle ?? 60;
    const sharps = this._sharpIdsFromBuffer(meshData, currentRenderBuffer);

    const { geometry, renderBuffer } = this.toBufferGeometry(meshData, { mode, angle, sharps });

    if (object) {
      const oldGeometry = object.geometry ?? currentGeometry;
      object.geometry = geometry;
      object.userData.renderBuffer = renderBuffer;
      renderBuffer.bindObject(object);
      if (oldGeometry && oldGeometry !== geometry) oldGeometry.dispose();
    } else if (currentGeometry) {
      // No host binding: mutate the supplied geometry in place so callers
      // holding local references keep working, and release the old arrays.
      const oldGeometry = currentGeometry;
      oldGeometry.setAttribute('position', geometry.getAttribute('position').clone());
      oldGeometry.setAttribute('normal', geometry.getAttribute('normal').clone());
      oldGeometry.setAttribute('uv', geometry.getAttribute('uv').clone());
      oldGeometry.setIndex(geometry.getIndex().clone());
      geometry.dispose();
      if (currentRenderBuffer) {
        // Surface the fresh mapping through the old buffer reference.
        currentRenderBuffer.vertexIdToBufferIndex = renderBuffer.vertexIdToBufferIndex;
        currentRenderBuffer.bufferIndexToVertexId = renderBuffer.bufferIndexToVertexId;
        currentRenderBuffer.faceIdToBufferIndices = renderBuffer.faceIdToBufferIndices;
        currentRenderBuffer.faceTriangleOffset = renderBuffer.faceTriangleOffset;
        currentRenderBuffer.faceTriangleCount = renderBuffer.faceTriangleCount;
        currentRenderBuffer.slotAllocator = renderBuffer.slotAllocator;
        currentRenderBuffer.indexSlotAllocator = renderBuffer.indexSlotAllocator;
        currentRenderBuffer.sharpKeys = renderBuffer.sharpKeys;
      }
      return { geometry: oldGeometry, renderBuffer: currentRenderBuffer ?? renderBuffer };
    }

    // The old render buffer owns nothing GPU-side except its temporary
    // normal cache; make sure it is released.
    currentRenderBuffer?.invalidateNormalCache();

    return { geometry, renderBuffer };
  }

  // Replace the geometry of an object wholesale, guaranteeing the previous
  // BufferGeometry is disposed and temporary caches are released. Every
  // geometry-replacing call site should go through this helper.
  static replaceObjectGeometry(object, geometry, renderBuffer) {
    const oldGeometry = object.geometry;
    object.geometry = geometry;
    if (renderBuffer) {
      object.userData.renderBuffer = renderBuffer;
      renderBuffer.bindObject(object);
    }
    if (oldGeometry && oldGeometry !== geometry) oldGeometry.dispose();
  }

  static _sharpIdsFromBuffer(meshData, renderBuffer) {
    if (!renderBuffer?.sharpKeys) return null;
    const ids = new Set();
    for (const key of renderBuffer.sharpKeys.keys()) {
      const [a, b] = key.split('_').map(Number);
      const edge = meshData.getEdge(a, b);
      if (edge) ids.add(edge.id);
    }
    return ids;
  }

  // ============================================================
  // Consistency validation (tests + debug)
  // ============================================================

  // Verifies that allocator state and every renderBuffer map agree, and that
  // the index buffer only references allocated vertex slots. Throws on the
  // first inconsistency and returns true otherwise.
  static validateConsistency(meshData, renderBuffer, geometry) {
    const va = renderBuffer.slotAllocator;
    const ia = renderBuffer.indexSlotAllocator;
    if (!va.checkInvariant()) throw new Error('vertex SlotAllocator invariant violated');
    if (!ia?.checkInvariant()) throw new Error('index SlotAllocator invariant violated');

    // Every face mapping must reference allocated vertex slots.
    for (const [faceId, slots] of renderBuffer.faceIdToBufferIndices) {
      if (!meshData.faces.has(faceId)) throw new Error(`face ${faceId} mapped but absent from meshData`);
      for (const slot of slots) {
        if (!va.isAllocated(slot)) throw new Error(`face ${faceId} references free vertex slot ${slot}`);
        if (renderBuffer.bufferIndexToVertexId.get(slot) === undefined) {
          throw new Error(`slot ${slot} missing reverse vertex mapping`);
        }
      }
      const face = meshData.faces.get(faceId);
      if (slots.length !== face.vertexIds.length) {
        throw new Error(`face ${faceId} slot count ${slots.length} != vertex count ${face.vertexIds.length}`);
      }
      const offset = renderBuffer.faceTriangleOffset.get(faceId);
      const count = renderBuffer.faceTriangleCount.get(faceId);
      if (offset === undefined || count === undefined) {
        throw new Error(`face ${faceId} missing triangle layout`);
      }
      if (!ia.isAllocated(offset, Math.max(count, 1))) {
        throw new Error(`face ${faceId} triangle range [${offset}, ${count}) is not allocated`);
      }
    }

    // Reverse map and forward map must be exact inverses over used slots.
    for (const [vertexId, slots] of renderBuffer.vertexIdToBufferIndex) {
      if (!meshData.vertices.has(vertexId)) throw new Error(`vertex ${vertexId} mapped but absent`);
      for (const slot of slots) {
        if (renderBuffer.bufferIndexToVertexId.get(slot) !== vertexId) {
          throw new Error(`vertex ${vertexId} forward/reverse mapping mismatch at slot ${slot}`);
        }
      }
    }
    for (const [slot, vertexId] of renderBuffer.bufferIndexToVertexId) {
      const slots = renderBuffer.vertexIdToBufferIndex.get(vertexId);
      if (!slots || !slots.includes(slot)) {
        throw new Error(`slot ${slot} reverse mapping has no forward entry`);
      }
    }

    // Live index entries may only point at allocated vertex slots.
    if (geometry?.index) {
      const arr = geometry.index.array;
      const usedIndexSlots = ia.usedCount;
      // Only the allocated prefix regions are meaningful; check every slot
      // that is not part of a free block.
      for (let i = 0; i < arr.length; i++) {
        if (!ia.isAllocated(i)) continue;
        const value = arr[i];
        if (value === 0xFFFFFFFF) continue;
        if (value >= va.capacity || !va.isAllocated(value)) {
          throw new Error(`index slot ${i} references non-allocated vertex slot ${value}`);
        }
      }
      if (usedIndexSlots < 0) throw new Error('negative index usage');
    }

    return true;
  }

  // ---------- Corner normal helpers ----------

  // Calls fn(bufferIdx, normal) for this vertex's corner slot in each face
  static _forEachCornerSlot(meshData, renderBuffer, vertexId, cornerNormals, fn) {
    for (const [fId, n] of cornerNormals) {
      const face = meshData.faces.get(fId);
      if (!face) continue;
      const corner = face.vertexIds.indexOf(vertexId);
      const bufferIdx = renderBuffer.faceIdToBufferIndices.get(fId)?.[corner];
      if (bufferIdx !== undefined) fn(bufferIdx, n);
    }
  }

  static _computeCornerNormals(meshData, vertexId, faceIds, getFaceNormal, threshold, sharpKeys) {
    const faces = [...faceIds];
    const result = new Map();
    if (faces.length === 0) return result;

    const parent = faces.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (i, j) => {
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[ri] = rj;
    };

    // Edges incident to this vertex, keyed by their other endpoint -> local indices of faces that use them
    const edgeFaces = new Map();
    faces.forEach((fId, i) => {
      const ids = meshData.faces.get(fId).vertexIds;
      const n = ids.length;
      const c = ids.indexOf(vertexId);
      if (c === -1) return;
      for (let k = -1; k <= 1; k += 2) {
        const u = ids[(c + n + k) % n];
        let list = edgeFaces.get(u);
        if (!list) edgeFaces.set(u, list = []);
        list.push(i);
      }
    });

    for (const [u, list] of edgeFaces) {
      if (list.length < 2) continue;   // boundary: no smoothing across
      if (sharpKeys.size > 0 && sharpKeys.has(SharpUtils.edgeKey(vertexId, u))) continue;   // sharp: no smoothing across
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const nA = getFaceNormal(faces[list[a]]);
          const nB = getFaceNormal(faces[list[b]]);
          if (!nA || !nB) continue;
          if (nA.angleTo(nB) <= threshold) union(list[a], list[b]);
        }
      }
    }

    // Average face normals per group
    const groupSums = new Map();
    faces.forEach((fId, i) => {
      const root = find(i);
      if (!groupSums.has(root)) groupSums.set(root, new THREE.Vector3());
      const n = getFaceNormal(fId);
      if (n) groupSums.get(root).add(n);
    });
    for (const sum of groupSums.values()) {
      if (sum.lengthSq() > 0) sum.normalize();
    }

    faces.forEach((fId, i) => result.set(fId, groupSums.get(find(i))));
    return result;
  }
}
