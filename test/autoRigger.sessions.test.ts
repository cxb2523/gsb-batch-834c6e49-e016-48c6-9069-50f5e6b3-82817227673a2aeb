import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { AutoRigger } from '../src/core/AutoRigger';
import { JointType } from '../src/types';
import { MockWorker, RecordedMessage } from './helpers/mockWorker';

type Mode = 'SAB' | 'TRANSFERABLE';

function setCrossOriginIsolated(value: boolean): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    value,
    configurable: true,
    writable: true
  });
}

function createMesh(vertexCount: number): THREE.Mesh {
  const positions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i + 1;
    positions[i * 3 + 2] = i + 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function getWorker(engine: AutoRigger): MockWorker {
  return (engine as unknown as { worker: MockWorker }).worker;
}

/** init() against a manual MockWorker: drive the INIT handshake explicitly. */
async function initManualEngine(): Promise<{ engine: AutoRigger; worker: MockWorker }> {
  const engine = new AutoRigger();
  const initPromise = engine.init();
  const worker = getWorker(engine);
  worker.emitInitDone();
  await initPromise;
  return { engine, worker };
}

function rigMessageIds(worker: MockWorker): number[] {
  return worker.rigRequests.map((m: RecordedMessage) => m.msgId);
}

/** Per-session marker stamped into every reply built for a given RIG msgId. */
function expectSessionMarkers(
  mesh: THREE.SkinnedMesh,
  marker: number,
  vertexCount: number
): void {
  expect(mesh.skeleton.bones[0].name).toBe(JointType.Hips);
  expect(mesh.skeleton.bones[0].position.y).toBe(marker);

  const skinIndex = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = mesh.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  expect(skinIndex.count).toBe(vertexCount);
  expect(skinWeight.count).toBe(vertexCount);

  const indices = skinIndex.array as Uint16Array;
  const weights = skinWeight.array as Float32Array;
  expect(indices[0]).toBe(marker);
  expect(weights[0]).toBe(1);
  // Float32 storage: marker + 0.1 is only representable to ~1e-7.
  expect(weights[1]).toBeCloseTo(marker + 0.1, 5);
}

describe('AutoRigger session isolation', () => {
  beforeEach(() => {
    MockWorker.auto = true;
    // @ts-ignore
    globalThis.Worker = MockWorker;
    setCrossOriginIsolated(false);
  });

  afterEach(() => {
    MockWorker.auto = true;
    vi.restoreAllMocks();
  });

  describe('init() lifecycle', () => {
    it('reuses one Worker across repeated init() calls', async () => {
      const engine = new AutoRigger();
      await engine.init();
      const firstWorker = getWorker(engine);

      await engine.init();
      await engine.init();

      expect(getWorker(engine)).toBe(firstWorker);
      expect(firstWorker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);
    });

    it('collapses concurrent init() calls into one Worker and one INIT message', async () => {
      MockWorker.auto = false;
      const engine = new AutoRigger();

      const first = engine.init();
      const second = engine.init();
      const worker = getWorker(engine);
      expect(worker).toBeInstanceOf(MockWorker);
      expect(worker.messages.filter(m => m.type === 'INIT')).toHaveLength(1);

      worker.emitInitDone();
      await Promise.all([first, second]);
      expect(engine.getPendingSessionCount()).toBe(0);
    });

    it('rejects rig() before initialization without touching any worker', async () => {
      const engine = new AutoRigger();
      await expect(engine.rig(createMesh(3))).rejects.toThrow(/not initialized/i);
      expect((engine as unknown as { worker: unknown }).worker).toBeNull();
    });

    it('rejects rig() while init() is still in flight without registering a session', async () => {
      MockWorker.auto = false;
      const engine = new AutoRigger();
      const initPromise = engine.init();

      await expect(engine.rig(createMesh(3))).rejects.toThrow(/not initialized/i);
      expect(engine.getPendingSessionCount()).toBe(0);

      getWorker(engine).emitInitDone();
      await initPromise;
      expect(engine.getPendingSessionCount()).toBe(0);
    });

    it('cleans up a failed INIT so a later init() starts a fresh worker', async () => {
      MockWorker.auto = false;
      const engine = new AutoRigger();

      const firstInit = engine.init();
      const brokenWorker = getWorker(engine);
      brokenWorker.emitError(brokenWorker.messages[0].msgId, 'model load failed');
      await expect(firstInit).rejects.toThrow('model load failed');
      expect(brokenWorker.terminated).toBe(true);
      expect(getWorker(engine)).toBeNull();
      expect(engine.getPendingSessionCount()).toBe(0);

      MockWorker.auto = true;
      await engine.init();
      expect(getWorker(engine)).not.toBe(brokenWorker);
      expect(engine.getPendingSessionCount()).toBe(0);
    });
  });

  describe.each<Mode>(['SAB', 'TRANSFERABLE'])('concurrent bindings in %s mode', (mode) => {
    beforeEach(() => {
      setCrossOriginIsolated(mode === 'SAB');
    });

    it('binds each request with its own skeleton and weights when replies arrive out of order', async () => {
      MockWorker.auto = false;
      const { engine, worker } = await initManualEngine();

      const meshA = createMesh(3);
      const meshB = createMesh(4);
      const meshC = createMesh(5);

      const rigA = engine.rig(meshA);
      const rigB = engine.rig(meshB);
      const rigC = engine.rig(meshC);

      const [idA, idB, idC] = rigMessageIds(worker);
      expect(engine.getPendingSessionCount()).toBe(3);

      if (mode === 'TRANSFERABLE') {
        // Transferable buffers must be detached on the sender and never reused.
        for (const request of worker.rigRequests) {
          expect(request.payload.posBuffer.byteLength).toBe(0);
          expect(request.payload.indicesBuffer.byteLength).toBe(0);
          expect(request.payload.weightsBuffer.byteLength).toBe(0);
        }
      } else {
        // Shared buffers stay owned and readable by the sending session.
        for (const request of worker.rigRequests) {
          expect(request.payload.posBuffer.byteLength).toBeGreaterThan(0);
          expect(request.payload.weightsBuffer.byteLength).toBeGreaterThan(0);
          expect(request.transfers).toHaveLength(0);
        }
      }

      // Complete last request first, then the middle one, then the first.
      worker.emitRigDone(idC);
      const resultC = await rigC;
      expect(engine.getActiveSessionId()).toBe(idC);
      expect(engine.getActiveSkeleton()).toBe(resultC.skeleton);

      worker.emitRigDone(idA);
      const resultA = await rigA;

      worker.emitRigDone(idB);
      const resultB = await rigB;

      expectSessionMarkers(resultA, idA, 3);
      expectSessionMarkers(resultB, idB, 4);
      expectSessionMarkers(resultC, idC, 5);

      // Distinct skeletons, geometries and attribute buffers per binding.
      const skeletons = [resultA.skeleton, resultB.skeleton, resultC.skeleton];
      expect(new Set(skeletons).size).toBe(3);
      const geometries = [resultA.geometry, resultB.geometry, resultC.geometry];
      expect(new Set(geometries).size).toBe(3);
      const indexBuffers = skeletons.map((_, i) =>
        (geometries[i].getAttribute('skinIndex') as THREE.BufferAttribute).array);
      expect(new Set(indexBuffers).size).toBe(3);

      // Most recently completed binding owns the active skeleton.
      expect(engine.getActiveSessionId()).toBe(idB);
      expect(engine.getActiveSkeleton()).toBe(resultB.skeleton);
      expect(engine.getPendingSessionCount()).toBe(0);
      expect(worker.messages.filter(m => m.type === 'RIG')).toHaveLength(3);
    });

    it('resolves every interleaved rig() independently in automatic mode', async () => {
      const engine = new AutoRigger();
      await engine.init();
      const worker = getWorker(engine);

      const meshes = [createMesh(2), createMesh(3), createMesh(4)];
      const results = await Promise.all(meshes.map(m => engine.rig(m)));
      const ids = rigMessageIds(worker);

      results.forEach((skinned, i) => {
        expectSessionMarkers(skinned, ids[i], meshes[i].geometry.attributes.position.count);
      });
      expect(new Set(results.map(r => r.skeleton)).size).toBe(3);
      expect(engine.getActiveSessionId()).toBe(ids[ids.length - 1]);
    });

    it('isolates a failed request: other in-flight bindings still succeed and no partial state leaks', async () => {
      MockWorker.auto = false;
      const { engine, worker } = await initManualEngine();

      const meshA = createMesh(3);
      const meshB = createMesh(4);
      const meshC = createMesh(5);

      const rigA = engine.rig(meshA);
      const rigB = engine.rig(meshB);
      const rigC = engine.rig(meshC);
      const [idA, idB, idC] = rigMessageIds(worker);

      // A succeeds and becomes active before B fails.
      worker.emitRigDone(idA);
      const resultA = await rigA;
      expect(engine.getActiveSkeleton()).toBe(resultA.skeleton);

      worker.emitError(idB, 'boom in worker');
      await expect(rigB).rejects.toThrow('boom in worker');

      // C remains in flight and completes with its own data.
      expect(engine.getPendingSessionCount()).toBe(1);
      worker.emitRigDone(idC);
      const resultC = await rigC;

      expectSessionMarkers(resultA, idA, 3);
      expectSessionMarkers(resultC, idC, 5);
      expect(resultA.skeleton).not.toBe(resultC.skeleton);

      // The failure removed B's session without leaving buffers behind, and
      // the latest successful binding now owns the active skeleton.
      expect(engine.getPendingSessionCount()).toBe(0);
      expect(engine.getActiveSessionId()).toBe(idC);
      expect(engine.getActiveSkeleton()).toBe(resultC.skeleton);
      expect((engine as unknown as { sessions: Map<unknown, unknown> }).sessions.size).toBe(0);
      expect((engine as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size).toBe(0);
    });

    it('never replaces the active skeleton when a binding fails', async () => {
      MockWorker.auto = false;
      const { engine, worker } = await initManualEngine();

      const goodMesh = createMesh(3);
      const badMesh = createMesh(4);

      const goodRig = engine.rig(goodMesh);
      const badRig = engine.rig(badMesh);
      const [goodId, badId] = rigMessageIds(worker);

      worker.emitRigDone(goodId);
      const goodResult = await goodRig;

      worker.emitError(badId, 'weights exploded');
      await expect(badRig).rejects.toThrow('weights exploded');

      expect(engine.getActiveSkeleton()).toBe(goodResult.skeleton);
      expect(engine.getActiveSessionId()).toBe(goodId);
      expect(engine.getPendingSessionCount()).toBe(0);
    });
  });

  describe('worker-level failures', () => {
    it('rejects all in-flight requests together and keeps the previously active skeleton', async () => {
      MockWorker.auto = false;
      setCrossOriginIsolated(true);
      const { engine, worker } = await initManualEngine();

      const settled = engine.rig(createMesh(3));
      const [settledId] = rigMessageIds(worker);
      worker.emitRigDone(settledId);
      const settledMesh = await settled;

      const rigA = engine.rig(createMesh(4));
      const rigB = engine.rig(createMesh(5));
      expect(engine.getPendingSessionCount()).toBe(2);

      worker.emitWorkerError('worker crashed');

      await expect(rigA).rejects.toThrow('worker crashed');
      await expect(rigB).rejects.toThrow('worker crashed');

      // No partial session buffers survive the crash.
      expect(engine.getPendingSessionCount()).toBe(0);
      expect((engine as unknown as { sessions: Map<unknown, unknown> }).sessions.size).toBe(0);
      expect((engine as unknown as { pendingRequests: Map<unknown, unknown> }).pendingRequests.size).toBe(0);

      // The last successfully bound skeleton remains available to animate().
      expect(engine.getActiveSkeleton()).toBe(settledMesh.skeleton);
      expect(worker.terminated).toBe(true);
      expect(getWorker(engine)).toBeNull();
    });

    it('allows re-initialization on a new worker after a crash', async () => {
      MockWorker.auto = false;
      const { engine, worker: firstWorker } = await initManualEngine();

      const crashingRig = engine.rig(createMesh(3));
      firstWorker.emitWorkerError('fatal');
      await expect(crashingRig).rejects.toThrow('fatal');
      await vi.waitFor(() => expect(engine.getPendingSessionCount()).toBe(0));

      MockWorker.auto = true;
      await engine.init();
      expect(getWorker(engine)).not.toBe(firstWorker);

      const rebuilt = await engine.rig(createMesh(2));
      expect(rebuilt).toBeInstanceOf(THREE.SkinnedMesh);
    });

    it('ignores stale replies with unknown msgIds instead of corrupting state', async () => {
      MockWorker.auto = false;
      const { engine, worker } = await initManualEngine();

      const rigPromise = engine.rig(createMesh(3));
      const [id] = rigMessageIds(worker);

      // A duplicate/late reply for a request the engine never tracked.
      worker.onmessage?.({ data: { type: 'RIG_DONE', msgId: 9999, payload: {} } });
      worker.onmessage?.({ data: { type: 'ERROR', payload: 'late error', msgId: 9998 } });

      worker.emitRigDone(id);
      const result = await rigPromise;
      expect(result).toBeInstanceOf(THREE.SkinnedMesh);
      expect(engine.getActiveSessionId()).toBe(id);
      expect(engine.getPendingSessionCount()).toBe(0);
    });
  });

  describe('animate()', () => {
    it('drives only the skeleton of the most recently successful binding', async () => {
      setCrossOriginIsolated(true);
      const engine = new AutoRigger();
      await engine.init();

      const solveSpy = vi.spyOn(
        (engine as unknown as { ikSolver: { solve: (s: THREE.Skeleton) => void } }).ikSolver,
        'solve'
      );

      const first = await engine.rig(createMesh(3));
      const second = await engine.rig(createMesh(4));

      engine.animate();
      expect(solveSpy).toHaveBeenCalledTimes(1);
      expect(solveSpy).toHaveBeenLastCalledWith(second.skeleton);

      engine.animate();
      expect(solveSpy).toHaveBeenCalledTimes(2);
      expect(solveSpy).toHaveBeenLastCalledWith(second.skeleton);
      expect(engine.getActiveSkeleton()).toBe(second.skeleton);
      expect(engine.getActiveSkeleton()).not.toBe(first.skeleton);
    });

    it('is a no-op before any successful binding', () => {
      const engine = new AutoRigger();
      expect(() => engine.animate()).not.toThrow();
      expect(engine.getActiveSkeleton()).toBeUndefined();
    });
  });
});
