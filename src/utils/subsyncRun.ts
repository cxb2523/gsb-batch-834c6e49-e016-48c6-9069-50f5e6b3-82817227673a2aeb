/**
 * The subtitle-sync run state machine, shared by both places a run can live.
 *
 * A sync run is a conversation: `begin` (with the cues and options), a stream
 * of `pcm` windows, then `finish` — or a `cancel` at any point. This module
 * owns the rules of that conversation:
 *
 *  - one run at a time. A new `begin` SUPERSEDES the run in flight, which is
 *    told so (its caller is awaiting a reply that would otherwise never come);
 *  - `pcm`/`finish`/`cancel` carry a runId, and anything whose runId is not
 *    the current run's is dropped. Cancelling mid-extraction otherwise leaves
 *    windows in flight that would be folded into the NEXT run's reference —
 *    the previous film's audio quietly corrupting this film's alignment;
 *  - a run that ends — finished, cancelled, superseded or failed — releases
 *    what it held IMMEDIATELY: the speech accumulator (~8 MB of signal for a
 *    long film) and the FFT twiddle table (~16 MB at feature length). The next
 *    run rebuilds both from its own inputs; nothing is inherited.
 *
 * It is used twice, which is the point of keeping it DOM-free and tested here:
 *
 *  - subsync.worker.ts wraps it in `postMessage` — the production path;
 *  - subtitleSync.ts's no-worker fallback drives the very same class on the
 *    main thread, so the two cannot drift apart on cancellation semantics any
 *    more than they can on the alignment itself.
 *
 * `attachWorkerRun` is the other half of the protocol: the main thread's
 * runId filter, which keeps a late reply from an abandoned run from ever
 * resolving — and therefore from shifting the subtitles of whatever the user
 * has moved on to.
 */

import { runAlignment } from "./subsyncEngine.ts";
import { releaseFftCache } from "./subsyncFft.ts";
import { SpeechAccumulator } from "./subsyncVad.ts";
import type { SubtitleSyncResult } from "../types/subtitleSync.ts";
import type {
  SubsyncBeginMessage,
  SubsyncRequest,
  SubsyncResponse,
} from "./subsyncWorkerProtocol.ts";

interface ActiveRun {
  begin: SubsyncBeginMessage;
  accumulator: SpeechAccumulator;
}

export class SubsyncRunSession {
  private active: ActiveRun | null = null;

  private readonly post: (message: SubsyncResponse) => void;

  constructor(post: (message: SubsyncResponse) => void) {
    this.post = post;
  }

  /**
   * Let go of everything the current run is holding, right now.
   *
   * Both releases are idempotent and both matter: the accumulator because of
   * its size, the twiddle table because a run that ended MID-alignment (an
   * error thrown out of the search, or a cancel that raced a finish) can
   * otherwise leave it held until some unrelated run happens to finish one.
   */
  private releaseActive(): void {
    this.active?.accumulator.reset();
    this.active = null;
    releaseFftCache();
  }

  handle(message: SubsyncRequest): void {
    try {
      if (message.type === "begin") {
        // A run already in flight is superseded, not ignored. Its caller is
        // awaiting a reply that would otherwise never come, and its message
        // listeners would sit on the worker for the life of the page.
        if (this.active) {
          const supersededRunId = this.active.begin.runId;
          this.releaseActive();
          this.post({
            type: "error",
            runId: supersededRunId,
            message: "Superseded by a newer subtitle sync.",
          });
        }
        // Always a FRESH accumulator: a re-run of the same film rebuilds its
        // reference from the audio that arrives after this message, never from
        // whatever the previous run happened to leave behind.
        this.active = { begin: message, accumulator: new SpeechAccumulator() };
        return;
      }

      // A message from a run the player has moved on from. Dropping it silently
      // is the point of the runId: cancelling mid-extraction otherwise leaves
      // windows in flight that would be folded into the NEXT run's reference.
      if (!this.active || this.active.begin.runId !== message.runId) return;

      if (message.type === "cancel") {
        this.releaseActive();
        return;
      }

      if (message.type === "pcm") {
        this.active.accumulator.push(new Int16Array(message.buffer), {
          frameRate: message.frameRate,
          startSeconds: message.startSeconds,
        });
        this.post({
          type: "progress",
          runId: message.runId,
          phase: "detecting-speech",
        });
        return;
      }

      if (message.type === "finish") {
        const run = this.active;
        // Detach FIRST, so nothing the finish does can be folded back into a
        // run that begins while it is still working.
        this.active = null;
        this.finish(run);
      }
    } catch (error) {
      const runId =
        message.type === "begin" ? message.runId : (this.active?.begin.runId ?? message.runId);
      this.releaseActive();
      this.post({
        type: "error",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private finish(run: ActiveRun): void {
    const { begin } = run;
    this.post({ type: "progress", runId: begin.runId, phase: "finding-alignment" });
    try {
      const reference = begin.referenceSpeech ?? run.accumulator.finish();
      if (reference.length === 0) {
        this.post({
          type: "error",
          runId: begin.runId,
          message:
            "No speech was detected in this video, so there is nothing to line the subtitles up with.",
        });
        return;
      }
      const result = runAlignment(
        reference,
        begin.cues,
        begin.reference,
        begin.processingMode,
        begin.engine,
        { ...begin.options, referenceNumFrames: begin.referenceNumFrames ?? null },
      );
      this.post({ type: "result", runId: begin.runId, result });
    } finally {
      // The accumulator is normally emptied by finish() above and the twiddle
      // table by searchFramerate — but a referenceSpeech run never pushed a
      // sample, and a failed alignment never reached the search's own release.
      // Both calls are idempotent, so make certain here rather than per path.
      run.accumulator.reset();
      releaseFftCache();
    }
  }
}

/* ------------------------------------------------------------------------ */
/* The main-thread half                                                      */
/* ------------------------------------------------------------------------ */

/** The slice of `Worker` a run needs — structural, so tests can fake it. */
export interface SubsyncWorkerLike {
  postMessage(message: SubsyncRequest, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface SubsyncRunHandle {
  post: (message: SubsyncRequest, transfer?: Transferable[]) => void;
  done: Promise<SubtitleSyncResult>;
  cancel: () => void;
}

/**
 * Wire one run to one worker and return its handle.
 *
 * The runId filter in `onMessage` is what stands between a late reply and the
 * wrong film's subtitles: a run the caller has abandoned (cancelled, or
 * superseded by a newer one) still has its messages arrive here, and only the
 * runId keeps a stale `result` from resolving — and being applied to whatever
 * the user is watching now.
 *
 * `onWorkerFailure` lets the owner drop a wedged worker so the next run starts
 * fresh; a worker that threw at module scope would do it again.
 */
export const attachWorkerRun = (
  worker: SubsyncWorkerLike,
  runId: number,
  signal?: AbortSignal,
  onWorkerFailure?: () => void,
): SubsyncRunHandle => {
  let settle!: (value: SubtitleSyncResult) => void;
  let fail!: (reason: unknown) => void;
  const done = new Promise<SubtitleSyncResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const onMessage = (event: MessageEvent<SubsyncResponse>) => {
    const message = event.data;
    // A reply from a run we have already abandoned.
    if (message.runId !== runId) return;
    if (message.type === "result") {
      cleanup();
      settle(message.result);
    } else if (message.type === "error") {
      cleanup();
      fail(new Error(message.message));
    }
  };
  const onError = (event: ErrorEvent) => {
    cleanup();
    onWorkerFailure?.();
    fail(new Error(event.message || "The subtitle sync worker stopped."));
  };
  const onAbort = () => {
    worker.postMessage({ type: "cancel", runId } satisfies SubsyncRequest);
    cleanup();
    fail(new DOMException("Subtitle sync was cancelled", "AbortError"));
  };

  const cleanup = () => {
    worker.removeEventListener("message", onMessage as EventListener);
    worker.removeEventListener("error", onError as EventListener);
    signal?.removeEventListener("abort", onAbort);
  };

  worker.addEventListener("message", onMessage as EventListener);
  worker.addEventListener("error", onError as EventListener);
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    done,
    cancel: onAbort,
  };
};
