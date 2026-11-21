/// <reference lib="webworker" />
/**
 * The subtitle-sync worker.
 *
 * Everything expensive lives here: voice activity detection over the decoded
 * audio, and the FFT cross-correlation that can run to 2^21 points seven times
 * over. On the main thread that is seconds of frozen UI in the middle of
 * playback; here the video keeps playing.
 *
 * Deliberately thin — it owns no algorithm of its own and no run state either.
 * The work is in src/utils/subsync*.ts and the whole message protocol (runId
 * filtering, supersede, cancel, resource release) is SubsyncRunSession in
 * subsyncRun.ts, which is what lets `node --test` exercise all of it without a
 * DOM, and what lets the main-thread fallback reuse it unchanged.
 *
 * Audio is streamed in as windows and detected as it arrives, so the worker
 * holds one window of PCM plus the 100 Hz signal (~8 MB for a 3-hour film)
 * and never the film.
 */

import { SubsyncRunSession } from "../utils/subsyncRun.ts";
import type { SubsyncRequest, SubsyncResponse } from "../utils/subsyncWorkerProtocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const session = new SubsyncRunSession((message: SubsyncResponse) => scope.postMessage(message));

scope.onmessage = (event: MessageEvent<SubsyncRequest>) => session.handle(event.data);
