/**
 * Tests for the run lifecycle around a subtitle sync: supersede, cancel,
 * re-run, and the main thread's runId filter.
 *
 * The alignment maths itself is covered in subsyncEngine.test.ts; here the
 * questions are the ones a long film makes urgent — does a cancelled run let
 * go of its audio, does a re-run start from nothing, and can a late reply
 * from an abandoned run still move the subtitles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  SubsyncRunSession,
  attachWorkerRun,
  type SubsyncWorkerLike,
} from "./subsyncRun.ts";
import { fftCacheHeld } from "./subsyncFft.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";
import type {
  SubsyncBeginMessage,
  SubsyncRequest,
  SubsyncResponse,
} from "./subsyncWorkerProtocol.ts";
import type { SubtitleCue } from "./subtitles.ts";
import type { SubtitleSyncResult } from "../types/subtitleSync.ts";

const AUDIO_RATE = 16000;

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

/** 25 lines of 3 s, one every 6 s — 152 s of film. */
const dialogue = (): SubtitleCue[] =>
  Array.from({ length: 25 }, (_, i) => cue(5 + i * 6, 8 + i * 6));

/**
 * Synthetic 16 kHz mono PCM: loud exactly where the cues land AFTER `shift`
 * seconds, silent elsewhere. Alternating ±6000 puts every covered window far
 * above the VAD's 50 dB gate, as in subsyncVad.test.ts.
 */
const audioFor = (cues: readonly SubtitleCue[], shift: number, totalSeconds = 160): Int16Array => {
  const out = new Int16Array(totalSeconds * AUDIO_RATE);
  for (const c of cues) {
    const from = Math.round((c.start + shift) * AUDIO_RATE);
    const to = Math.round((c.end + shift) * AUDIO_RATE);
    for (let i = from; i < to && i < out.length; i += 1) out[i] = i % 2 === 0 ? 6000 : -6000;
  }
  return out;
};

const begin = (
  runId: number,
  cues: SubtitleCue[],
  referenceSpeech?: Float64Array,
): SubsyncBeginMessage => ({
  type: "begin",
  runId,
  cues,
  ...(referenceSpeech ? { referenceSpeech, referenceNumFrames: null } : {}),
  reference: referenceSpeech ? "subtitle-track" : "audio-vad",
  processingMode: "web",
  engine: "web",
  options: {},
});

const pcm = (runId: number, samples: Int16Array, startSeconds = 0): SubsyncRequest => ({
  type: "pcm",
  runId,
  buffer: samples.buffer as ArrayBuffer,
  frameRate: AUDIO_RATE,
  startSeconds,
});

const finish = (runId: number): SubsyncRequest => ({ type: "finish", runId });
const cancel = (runId: number): SubsyncRequest => ({ type: "cancel", runId });

/** A session plus the list of everything it has posted. */
const harness = () => {
  const messages: SubsyncResponse[] = [];
  const session = new SubsyncRunSession((message) => messages.push(message));
  const results = () => messages.filter((m) => m.type === "result");
  const errors = () => messages.filter((m) => m.type === "error");
  return { session, messages, results, errors };
};

test("SubsyncRunSession", async (t) => {
  await t.test("aligns streamed pcm windows to the right offset", () => {
    const { session, results, errors } = harness();
    const cues = dialogue();
    // The film's speech sits 3 s AFTER the subtitle timings.
    session.handle(begin(1, cues));
    session.handle(pcm(1, audioFor(cues, 3)));
    session.handle(finish(1));

    assert.deepEqual(errors(), []);
    assert.equal(results().length, 1);
    const result = results()[0] as Extract<SubsyncResponse, { type: "result" }>;
    assert.equal(result.runId, 1);
    assert.equal(result.result.applied, true, result.result.qualityReasons.join("; "));
    assert.equal(result.result.framerateScaleFactor, 1);
    assert.ok(
      Math.abs(result.result.offsetMs - 3000) < 50,
      `offsetMs ${result.result.offsetMs}`,
    );
    assert.deepEqual(result.result.qualityReasons, []);
    // The FFT table went back once the search was done with it.
    assert.equal(fftCacheHeld(), false);
  });

  await t.test("aligns a ready-made referenceSpeech with no pcm at all", () => {
    const { session, results, errors } = harness();
    const cues = dialogue();
    const reference = new Float64Array(160 * SAMPLE_RATE);
    for (const c of cues) {
      reference.fill(
        1,
        Math.round((c.start + 4.2) * SAMPLE_RATE),
        Math.round((c.end + 4.2) * SAMPLE_RATE),
      );
    }
    session.handle(begin(1, cues, reference));
    session.handle(finish(1));

    assert.deepEqual(errors(), []);
    assert.equal(results().length, 1);
    const result = results()[0] as Extract<SubsyncResponse, { type: "result" }>;
    assert.equal(result.result.applied, true, result.result.qualityReasons.join("; "));
    assert.ok(Math.abs(result.result.offsetMs - 4200) < 50, `offsetMs ${result.result.offsetMs}`);
    assert.equal(fftCacheHeld(), false);
  });

  await t.test("a cancelled run's audio does not leak into the re-run", () => {
    const { session, results, errors, messages } = harness();
    const cues = dialogue();

    // First run: real audio arrives, then the user cancels.
    session.handle(begin(1, cues));
    session.handle(pcm(1, audioFor(cues, 3)));
    session.handle(cancel(1));
    assert.deepEqual(messages.filter((m) => m.runId === 1 && m.type !== "progress"), []);

    // Second run: nothing but a finish. If the cancelled run's speech were
    // still sitting in the accumulator, this would "align" against it.
    session.handle(begin(2, cues));
    session.handle(finish(2));

    assert.deepEqual(results(), []);
    assert.equal(errors().length, 1);
    assert.equal(errors()[0].runId, 2);
    assert.match(
      (errors()[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /No speech was detected/,
    );
  });

  await t.test("a superseded run's late pcm and finish are dropped", () => {
    const { session, messages, results, errors } = harness();
    const cues = dialogue();

    session.handle(begin(1, cues));
    session.handle(pcm(1, audioFor(cues, 3)));
    session.handle(begin(2, cues));

    // The old run is told, once, that it was replaced.
    const superseded = errors().filter((m) => m.runId === 1);
    assert.equal(superseded.length, 1);
    assert.match(
      (superseded[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /Superseded/,
    );

    // Its windows and finish arrive anyway — in flight when it was replaced.
    const before = messages.length;
    session.handle(pcm(1, audioFor(cues, 3)));
    session.handle(finish(1));
    assert.equal(messages.length, before, "a stale runId must not produce anything");

    // And the new run holds none of the old run's audio.
    session.handle(finish(2));
    assert.deepEqual(results(), []);
    const noSpeech = errors().filter((m) => m.runId === 2);
    assert.equal(noSpeech.length, 1);
    assert.match(
      (noSpeech[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /No speech was detected/,
    );
  });

  await t.test("re-running the same film rebuilds the reference from scratch", () => {
    const { session, results, errors } = harness();
    const cues = dialogue();
    const audio = audioFor(cues, 3);

    session.handle(begin(1, cues));
    session.handle(pcm(1, audio));
    session.handle(finish(1));

    session.handle(begin(2, cues));
    session.handle(pcm(2, audio));
    session.handle(finish(2));

    assert.deepEqual(errors(), []);
    assert.equal(results().length, 2);
    const [first, second] = results() as Extract<SubsyncResponse, { type: "result" }>[];
    // Same film, same answer — and computed from THIS run's audio alone.
    assert.equal(first.result.offsetMs, second.result.offsetMs);
    assert.ok(Math.abs(second.result.offsetMs - 3000) < 50);

    // A third run with no audio of its own must find nothing, not run 2's.
    session.handle(begin(3, cues));
    session.handle(finish(3));
    assert.equal(results().length, 2);
    assert.equal(errors().length, 1);
    assert.match(
      (errors()[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /No speech was detected/,
    );
  });

  await t.test("fifty rapid begin/cancel cycles accumulate nothing", () => {
    const { session, results, errors } = harness();
    const cues = dialogue();
    const burst = audioFor(cues, 3, 20);

    for (let runId = 1; runId <= 50; runId += 1) {
      session.handle(begin(runId, cues));
      session.handle(pcm(runId, burst));
      session.handle(cancel(runId));
    }
    // Every run was cancelled before the next began: no results, no supersede
    // errors, nothing.
    assert.deepEqual(results(), []);
    assert.deepEqual(errors(), []);

    // The fifty-first run starts empty.
    session.handle(begin(51, cues));
    session.handle(finish(51));
    assert.equal(errors().length, 1);
    assert.match(
      (errors()[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /No speech was detected/,
    );
    assert.equal(fftCacheHeld(), false);
  });

  await t.test("fifty rapid begins each supersede the last, once", () => {
    const { session, results, errors } = harness();
    const cues = dialogue();
    const burst = audioFor(cues, 3, 20);

    for (let runId = 1; runId <= 50; runId += 1) {
      session.handle(begin(runId, cues));
      session.handle(pcm(runId, burst));
    }
    // Runs 1..49 were each told exactly once, in order.
    assert.deepEqual(results(), []);
    assert.deepEqual(
      errors().map((m) => m.runId),
      Array.from({ length: 49 }, (_, i) => i + 1),
    );

    // And the survivor still holds only its own audio: cancel it, and a fresh
    // run with no pcm finds nothing.
    session.handle(cancel(50));
    session.handle(begin(51, cues));
    session.handle(finish(51));
    const noSpeech = errors().filter((m) => m.runId === 51);
    assert.equal(noSpeech.length, 1);
    assert.match(
      (noSpeech[0] as Extract<SubsyncResponse, { type: "error" }>).message,
      /No speech was detected/,
    );
  });

  await t.test("a failed alignment still releases the FFT cache", () => {
    const { session, results, errors } = harness();
    // A zero offset tolerance masks the whole correlation, so every candidate
    // is discarded and the search THROWS out of the finish.
    const cues = dialogue();
    const run = begin(1, cues, new Float64Array(160 * SAMPLE_RATE));
    session.handle({ ...run, options: { maxOffsetSeconds: 0 } });
    session.handle(finish(1));
    assert.deepEqual(results(), []);
    assert.equal(errors().length, 1);
    assert.equal(errors()[0].runId, 1);
    assert.equal(fftCacheHeld(), false);
  });
});

/* ------------------------------------------------------------------------ */
/* The main-thread half: attachWorkerRun                                     */
/* ------------------------------------------------------------------------ */

class FakeWorker implements SubsyncWorkerLike {
  readonly posted: SubsyncRequest[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  postMessage(message: SubsyncRequest): void {
    this.posted.push(message);
  }
  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(message: SubsyncResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message } as unknown as MessageEvent);
    }
  }
  listenerCount(type = "message"): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const fakeResult = (offsetMs: number): SubtitleSyncResult => ({
  subtitles: [],
  offsetMs,
  confidence: 1,
  processingMode: "web",
  engine: "web",
  reference: "audio-vad",
  framerateScaleFactor: 1,
  score: 100,
  perCueOffsetsMs: null,
  qualityReasons: [],
  applied: true,
});

/** Watch a promise's settlement without awaiting it. */
const track = (promise: Promise<unknown>): { state: "pending" | "resolved" | "rejected" } => {
  const tracked: { state: "pending" | "resolved" | "rejected" } = { state: "pending" };
  promise.then(
    () => {
      tracked.state = "resolved";
    },
    () => {
      tracked.state = "rejected";
    },
  );
  return tracked;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("attachWorkerRun", async (t) => {
  await t.test("delivers a reply only to the run it belongs to", async () => {
    const worker = new FakeWorker();
    const run1 = attachWorkerRun(worker, 1);
    const run2 = attachWorkerRun(worker, 2);
    const state1 = track(run1.done);
    const state2 = track(run2.done);

    worker.emit({ type: "result", runId: 1, result: fakeResult(1200) });
    await flush();
    assert.equal(state1.state, "resolved");
    assert.equal(state2.state, "pending", "run 2 must not see run 1's result");
    assert.equal((await run1.done).offsetMs, 1200);

    worker.emit({ type: "error", runId: 2, message: "boom" });
    await flush();
    assert.equal(state2.state, "rejected");
    // Both runs settled: no listeners may be left on the worker.
    assert.equal(worker.listenerCount(), 0);
  });

  await t.test("a late result for a cancelled run is ignored", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const run = attachWorkerRun(worker, 7, controller.signal);
    const state = track(run.done);

    controller.abort();
    // The worker is told to stop, the promise rejects as an abort, and every
    // listener comes off — so the reply that was mid-flight finds nothing.
    assert.deepEqual(worker.posted, [{ type: "cancel", runId: 7 }]);
    assert.equal(worker.listenerCount(), 0);
    await assert.rejects(run.done, (error: unknown) => {
      assert.equal((error as DOMException).name, "AbortError");
      return true;
    });

    worker.emit({ type: "result", runId: 7, result: fakeResult(9999) });
    await flush();
    assert.equal(state.state, "rejected", "the late result must not resurrect the run");
  });

  await t.test("cancel() without an AbortSignal behaves the same", async () => {
    const worker = new FakeWorker();
    const run = attachWorkerRun(worker, 3);
    run.cancel();
    assert.deepEqual(worker.posted, [{ type: "cancel", runId: 3 }]);
    await assert.rejects(run.done, (error: unknown) => {
      assert.equal((error as DOMException).name, "AbortError");
      return true;
    });
    worker.emit({ type: "error", runId: 3, message: "too late" });
    await flush();
    assert.equal(worker.listenerCount(), 0);
  });
});
