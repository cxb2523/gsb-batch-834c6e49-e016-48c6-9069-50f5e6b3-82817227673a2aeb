import { JointType, SkeletonRig } from '../../src/types';

export interface RecordedMessage {
  type: string;
  msgId: number;
  payload: any;
  transfers: Transferable[];
  /** Vertex count captured before any transfer detaches the buffers. */
  vertexCount: number;
}

/**
 * Deterministic Worker double for AutoRigger tests.
 *
 * - auto mode (default): replies to INIT immediately and answers every RIG
 *   as soon as it is posted, preserving natural async ordering.
 * - manual mode: posts are only recorded; tests drive replies themselves via
 *   emitRigDone / emitError / emitWorkerError to manufacture out-of-order and
 *   error returns.
 *
 * Transfer semantics mirror the platform: ArrayBuffers listed as transferable
 * are detached on the producer side, while SharedArrayBuffers are never
 * transferred and stay readable by both parties.
 */
export class MockWorker {
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  /** Default mode for every subsequently constructed MockWorker. */
  static auto = true;

  messages: RecordedMessage[] = [];
  terminated = false;

  constructor(_url?: unknown, _options?: unknown) {
    // Intentionally no snapshot: tests may flip MockWorker.auto before the
    // first postMessage even though the worker was constructed inside init().
  }

  postMessage(data: { type: string; msgId: number; payload: any }, transfers: Transferable[] = []): void {
    const detachedPayload = data.payload;

    // Capture geometry sizes before the transfer detaches these buffers.
    const vertexCount = data.type === 'RIG'
      ? data.payload.weightsBuffer.byteLength / (4 * Float32Array.BYTES_PER_ELEMENT)
      : 0;

    // Emulate structured clone + transfer: transferred ArrayBuffers become
    // detached and must never be reused by the sender.
    for (const transferable of transfers) {
      if (transferable instanceof ArrayBuffer) {
        structuredClone(transferable, { transfer: [transferable] });
      }
    }

    this.messages.push({
      type: data.type,
      msgId: data.msgId,
      payload: detachedPayload,
      transfers: [...transfers],
      vertexCount
    });

    if (!MockWorker.auto) return;

    if (data.type === 'INIT') {
      this.queueDispatch({ type: 'INIT_DONE', msgId: data.msgId });
    } else if (data.type === 'RIG') {
      this.queueDispatch(this.buildRigResponse(data.msgId, data.payload, vertexCount));
    }
  }

  get rigRequests(): RecordedMessage[] {
    return this.messages.filter(m => m.type === 'RIG');
  }

  emitInitDone(msgId?: number): void {
    const target = msgId ?? this.messages.find(m => m.type === 'INIT')?.msgId;
    if (target === undefined) throw new Error('MockWorker: no INIT request to answer');
    this.dispatch({ type: 'INIT_DONE', msgId: target });
  }

  emitRigDone(msgId: number): void {
    const request = this.messages.find(m => m.type === 'RIG' && m.msgId === msgId);
    if (!request) throw new Error(`MockWorker: no RIG request with msgId ${msgId}`);
    this.dispatch(this.buildRigResponse(msgId, request.payload, request.vertexCount));
  }

  emitError(msgId: number, message = 'mock worker error'): void {
    this.dispatch({ type: 'ERROR', payload: message, msgId });
  }

  emitWorkerError(message = 'fatal worker crash'): void {
    this.onerror?.({ message });
  }

  terminate(): void {
    this.terminated = true;
  }

  private queueDispatch(data: any): void {
    // Macrotask timing mirrors real worker message delivery.
    setTimeout(() => {
      if (!this.terminated) this.dispatch(data);
    }, 0);
  }

  private dispatch(data: any): void {
    this.onmessage?.({ data });
  }

  /**
   * Builds a reply indistinguishable in shape from rigWorker.ts. The request's
   * msgId is used as a per-session marker so tests can prove that each
   * SkinnedMesh received exactly the skeleton/weights produced for its request.
   */
  private buildRigResponse(msgId: number, payload: any, vertexCount: number): any {
    const marker = msgId;
    const rig = this.buildRig(marker);

    if (payload.mode === 'SAB') {
      this.fillBuffers(payload.indicesBuffer, payload.weightsBuffer, marker);
      return { type: 'RIG_DONE', msgId, payload: { rig } };
    }

    const indicesBuffer = new ArrayBuffer(Math.max(vertexCount * 4 * Uint16Array.BYTES_PER_ELEMENT, 0));
    const weightsBuffer = new ArrayBuffer(Math.max(vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT, 0));
    this.fillBuffers(indicesBuffer, weightsBuffer, marker);

    return {
      type: 'RIG_DONE',
      msgId,
      payload: { rig, indicesBuffer, weightsBuffer }
    };
  }

  private buildRig(marker: number): SkeletonRig {
    const rig = {
      joints: {
        [JointType.Hips]: {
          type: JointType.Hips,
          position: { x: 0, y: marker, z: 0 },
          confidence: 1
        },
        [JointType.Spine]: {
          type: JointType.Spine,
          position: { x: 0, y: marker + 0.5, z: 0 },
          confidence: 1
        }
      },
      hierarchy: {
        [JointType.Hips]: [JointType.Spine],
        [JointType.Spine]: []
      }
    };
    return rig as unknown as SkeletonRig;
  }

  private fillBuffers(indicesBuffer: ArrayBufferLike, weightsBuffer: ArrayBufferLike, marker: number): void {
    const vertexCount = weightsBuffer.byteLength / (4 * Float32Array.BYTES_PER_ELEMENT);
    const skinIndices = new Uint16Array(indicesBuffer);
    const skinWeights = new Float32Array(weightsBuffer);

    for (let i = 0; i < vertexCount; i++) {
      skinIndices[i * 4 + 0] = marker;
      skinIndices[i * 4 + 1] = 0;
      skinIndices[i * 4 + 2] = 0;
      skinIndices[i * 4 + 3] = 0;

      skinWeights[i * 4 + 0] = 1;
      skinWeights[i * 4 + 1] = marker + 0.1;
      skinWeights[i * 4 + 2] = 0;
      skinWeights[i * 4 + 3] = 0;
    }
  }
}
