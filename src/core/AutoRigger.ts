import * as THREE from 'three';
import { MeshAnalyzer } from '../topology/MeshAnalyzer';
import { ProceduralIK } from '../ik/ProceduralIK';
import { RiggingOptions, IKTarget, SkeletonRig } from '../types';

type RigMode = 'SAB' | 'TRANSFERABLE';

interface PendingRequest {
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
  /** Set when the request was issued by rig(); absent for INIT requests. */
  sessionId?: number;
}

/**
 * State belonging to a single rig() invocation. Every concurrent or
 * interleaved binding owns an independent session, so out-of-order worker
 * replies can never overwrite another binding's skeleton, weight buffers or
 * the active skeleton.
 */
interface RigSession {
  id: number;
  mode: RigMode;
  mesh: THREE.Mesh;
  /** SAB view used to read back weights after the worker fills the buffer. */
  indicesBuffer?: SharedArrayBuffer;
  weightsBuffer?: SharedArrayBuffer;
  resolve: (skinnedMesh: THREE.SkinnedMesh) => void;
  reject: (error: Error) => void;
}

export class AutoRigger {
  private analyzer: MeshAnalyzer;
  private ikSolver: ProceduralIK;
  private worker: Worker | null = null;
  /** Shared by every session: init() never creates more than one worker. */
  private isInitialized = false;
  /** Serializes concurrent init() calls so the worker is only created once. */
  private initPromise: Promise<void> | null = null;
  private msgIdCounter = 0;
  /** All in-flight worker messages, matched solely by msgId. */
  private pendingRequests = new Map<number, PendingRequest>();
  /** Per-binding session state keyed by the RIG message's msgId. */
  private sessions = new Map<number, RigSession>();
  /** Skeleton of the most recently *successfully* completed binding. */
  private activeSkeleton?: THREE.Skeleton;
  private activeSessionId: number | null = null;

  constructor(private options: RiggingOptions = {}) {
    this.analyzer = new MeshAnalyzer();
    this.ikSolver = new ProceduralIK(options.ikIterations ?? 15);
  }

  async init(): Promise<void> {
    // Repeated/concurrent init() reuses one worker and one INIT round trip.
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initializeWorker();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async initializeWorker(): Promise<void> {
    // Fallback URL resolving for both Vite and plain build output
    const workerUrl = new URL(
      // @ts-ignore
      import.meta.env ? '../worker/rigWorker.ts' : './worker/rigWorker.js',
      import.meta.url
    );
    this.worker = new Worker(workerUrl, { type: 'module' });

    this.worker.onmessage = (e) => this.handleWorkerMessage(e);
    this.worker.onerror = (e) => this.handleWorkerError(e);

    console.log('[AutoRig] Initializing ML Engine in Worker...');

    try {
      await this.postWorkerMessage('INIT', {
        modelPath: this.options.modelPath || '/models/joint_estimator_v1.onnx'
      });
    } catch (err) {
      // A failed INIT must leave no half-initialized worker behind so a
      // later init() can start clean.
      this.worker.terminate();
      this.worker = null;
      throw err;
    }

    this.isInitialized = true;
    console.log('[AutoRig] Ready.');
  }

  private handleWorkerMessage(e: MessageEvent) {
    const { type, payload, msgId } = e.data;
    const req = this.pendingRequests.get(msgId);

    if (!req) {
      // Unknown/stale reply: ignore instead of touching shared state.
      console.error('[AutoRig] Received reply for unknown request:', msgId);
      return;
    }

    this.pendingRequests.delete(msgId);

    if (type === 'ERROR') {
      const error = payload instanceof Error ? payload : new Error(String(payload));
      req.reject(error);
      this.failSession(req.sessionId, error);
      return;
    }

    if (req.sessionId !== undefined) {
      this.completeSession(req.sessionId, payload);
    } else {
      req.resolve(payload);
    }
  }

  /**
   * A worker-level error rejects every in-flight request independently.
   * Already-settled requests are untouched, and no partial session buffer
   * can leak into the active skeleton.
   */
  private handleWorkerError(e: ErrorEvent) {
    const error = new Error(e?.message || 'Worker error');
    console.error('[AutoRig] Worker error:', error);

    for (const [msgId, req] of this.pendingRequests) {
      req.reject(error);
      if (req.sessionId !== undefined) {
        this.sessions.delete(req.sessionId);
      }
    }
    this.pendingRequests.clear();
    this.sessions.clear();

    this.isInitialized = false;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private failSession(sessionId: number | undefined, error: Error): void {
    if (sessionId === undefined) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    // The active skeleton belongs to a previous successful binding and is
    // deliberately left intact; this failed binding never publishes one.
    session.reject(error);
  }

  private completeSession(sessionId: number, payload: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Session was already failed/cleaned up (e.g. worker crash).
      return;
    }

    try {
      let skinIndices: Uint16Array;
      let skinWeights: Float32Array;

      if (session.mode === 'SAB') {
        // Shared buffers stay on the session and are read through fresh views.
        skinIndices = new Uint16Array(session.indicesBuffer!);
        skinWeights = new Float32Array(session.weightsBuffer!);
      } else {
        // Transferred buffers are only valid for this one reply; they are
        // consumed here and never handed back to the worker or reused.
        skinIndices = new Uint16Array(payload.indicesBuffer);
        skinWeights = new Float32Array(payload.weightsBuffer);
      }

      const rig = payload.rig as SkeletonRig;
      const skinnedMesh = this.analyzer.bindSkeletonWithWeights(
        session.mesh,
        rig,
        skinIndices,
        skinWeights
      );

      this.sessions.delete(sessionId);
      // Whichever binding completes last becomes the active one; a failure
      // never changes it, and animate() only drives this skeleton.
      this.activeSkeleton = skinnedMesh.skeleton;
      this.activeSessionId = sessionId;
      session.resolve(skinnedMesh);
    } catch (err) {
      this.sessions.delete(sessionId);
      session.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private nextMsgId(): number {
    return ++this.msgIdCounter;
  }

  /** Posts a non-session control message (currently only INIT). RIG posts
   *  are made directly inside rig() so the session and its promise share one
   *  msgId from the moment they are created. */
  private postWorkerMessage(type: string, payload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const msgId = this.nextMsgId();
      this.pendingRequests.set(msgId, { resolve, reject });
      this.worker!.postMessage({ type, payload, msgId });
    });
  }

  /**
   * Dual-Pipe Autonomous Auto-Rigging:
   * 1. If crossOriginIsolated & SharedArrayBuffer are available: zero-copy shared memory.
   * 2. Otherwise: zero-copy Transferable ArrayBuffers (works anywhere without COOP/COEP headers).
   *
   * Each invocation runs as an independent session on the shared worker:
   * its buffers, rig result and resulting SkinnedMesh never touch instance
   * state shared with other in-flight bindings.
   */
  async rig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    if (!this.isInitialized || !this.worker) {
      return Promise.reject(new Error('[AutoRig] Engine not initialized.'));
    }

    return new Promise<THREE.SkinnedMesh>((resolve, reject) => {
      console.log('[AutoRig] Analyzing topology & detecting joints in Worker...');

      const geometry = mesh.geometry;
      const positions = geometry.attributes.position.array as Float32Array;
      const vertexCount = positions.length / 3;
      const msgId = this.nextMsgId();

      const isSABSupported = typeof SharedArrayBuffer !== 'undefined' &&
        (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false);

      if (isSABSupported) {
        // Tier 1: SharedArrayBuffer Zero-Copy. Buffers are owned by this
        // session and are never transferred, so they remain valid regardless
        // of when the worker replies.
        const posBuffer = new SharedArrayBuffer(positions.length * Float32Array.BYTES_PER_ELEMENT);
        new Float32Array(posBuffer).set(positions);

        const indicesBuffer = new SharedArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
        const weightsBuffer = new SharedArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

        this.sessions.set(msgId, {
          id: msgId,
          mode: 'SAB',
          mesh,
          indicesBuffer,
          weightsBuffer,
          resolve,
          reject
        });
        this.pendingRequests.set(msgId, { resolve, reject, sessionId: msgId });

        this.worker!.postMessage({
          type: 'RIG',
          payload: {
            mode: 'SAB',
            posBuffer,
            indicesBuffer,
            weightsBuffer,
            falloff: this.options.skinningFalloff ?? 2.0
          },
          msgId
        });
      } else {
        // Tier 2: Universal Transferable ArrayBuffer Zero-Copy. All buffers
        // are detached on this side by the transfer; the worker returns fresh
        // buffers that are consumed by this session only.
        const posBuffer = new Float32Array(positions).buffer;
        const indicesBuffer = new ArrayBuffer(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT);
        const weightsBuffer = new ArrayBuffer(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT);

        this.sessions.set(msgId, {
          id: msgId,
          mode: 'TRANSFERABLE',
          mesh,
          resolve,
          reject
        });
        this.pendingRequests.set(msgId, { resolve, reject, sessionId: msgId });

        this.worker!.postMessage({
          type: 'RIG',
          payload: {
            mode: 'TRANSFERABLE',
            posBuffer,
            indicesBuffer,
            weightsBuffer,
            falloff: this.options.skinningFalloff ?? 2.0
          },
          msgId
        }, [posBuffer, indicesBuffer, weightsBuffer]);
      }
    });
  }

  /**
   * Alias for rig(mesh) for backward compatibility.
   */
  async autoRig(mesh: THREE.Mesh): Promise<THREE.SkinnedMesh> {
    return this.rig(mesh);
  }

  animate(): void {
    if (this.activeSkeleton) {
      this.ikSolver.solve(this.activeSkeleton);
    }
  }

  setIKTarget(target: IKTarget): void {
    this.ikSolver.addTarget(target);
  }

  /** Skeleton driven by animate(); belongs to the latest successful binding. */
  getActiveSkeleton(): THREE.Skeleton | undefined {
    return this.activeSkeleton;
  }

  /** Session id (RIG msgId) of the active skeleton, or null before success. */
  getActiveSessionId(): number | null {
    return this.activeSessionId;
  }

  /** Number of bindings still awaiting a worker reply. */
  getPendingSessionCount(): number {
    return this.sessions.size;
  }
}

export { AutoRigger as RiggingEngine };
