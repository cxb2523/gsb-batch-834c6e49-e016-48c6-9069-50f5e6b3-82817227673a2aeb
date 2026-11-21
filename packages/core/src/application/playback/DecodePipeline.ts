import { FramePairer } from './FramePairer';
import type { FramePairQueue } from './FramePairQueue';
import { StartGate } from './StartGate';
import type { VideoTrackReader } from '../../ports/VideoTrackReader';
import type { EncodedVideoPacket } from '../../ports/VideoTrack';
import type {
  DecodedFrame,
  VideoDecoderHandle,
  VideoDecoderPort,
} from '../../ports/VideoDecoderPort';
import { Deferred } from '../../shared/async/Deferred';
import { RunStop, STOPPED } from '../../shared/async/RunStop';
import { ensureInvariant, GyroViewError } from '../../shared/errors/GyroViewError';
import type { Seconds } from '../../shared/units/time';

/**
 * Lens frames left without a partner for this much media time — or leading the other lenses by
 * this much — mean the tracks do not show the same instants (two files whose edit lists or
 * timescales differ): no picture would ever come, and the whole file would be decoded waiting
 * for one. A recording's lenses share the camera clock, and a lens that lost a few frames pairs
 * again long before.
 */
const UNPAIRED_SPAN_LIMIT_SECONDS = 2;

export interface DecodePipelineOptions {
  /**
   * Packets each decoder may hold before the pipeline pauses feeding it.
   */
  readonly maxPendingPackets: number;
  /**
   * How far apart two frame sources' timestamps may be and still count as one instant.
   */
  readonly pairTolerance: Seconds;
}

/**
 * How one run went. The session acts on `hasReachedEnd`; the counts make the run observable,
 * which is how its pairing, backpressure and start gate are tested.
 */
export interface DecodePipelineReport {
  readonly packetsDecoded: number;
  readonly pairsDelivered: number;
  readonly unpairedFrames: number;
  /**
   * Pairs decoded before the requested start and thrown away. The last pair before the start
   * is not among them: it is delivered, being the frame on screen at the start.
   */
  readonly pairsDroppedBeforeStart: number;
  /**
   * Every track ran out of packets; anything shorter — an abort, a closed output queue, a
   * track that led the others too far — is not the end.
   */
  readonly hasReachedEnd: boolean;
}

interface RunTally {
  packets: number;
  pairs: number;
}

type PacketIterator = AsyncIterator<EncodedVideoPacket>;

/**
 * Takes what the decoder of one frame source hands out.
 */
type FrameReceiver<Handle> = (sourceIndex: number, frame: DecodedFrame<Handle>) => void;

/**
 * One frame source's moving parts of a run: its packet reads and its decoder.
 */
interface TrackLeg {
  readonly iterator: PacketIterator;
  readonly decoder: VideoDecoderHandle;
}

/**
 * Everything one run owns, built when the run opens and torn down when it ends.
 */
interface Run<Handle> {
  readonly output: FramePairQueue<Handle>;
  /**
   * Ends every wait of the run at once: remembering only the waits in progress, it keeps nothing
   * of the ones already fed, however long the run.
   */
  readonly stop: RunStop;
  /**
   * Settled by the first decoder or track that reports an error; the run is aborted and rejects
   * with it.
   */
  readonly failure: Deferred<Error>;
  readonly tally: RunTally;
  readonly gate: StartGate<Handle>;
  readonly pairer: FramePairer<Handle>;
  /**
   * One per frame source, in their order.
   */
  readonly legs: readonly TrackLeg[];
}

/**
 * Decodes the frame sources of a recording from a chosen time: starts every decoder at the key
 * packet at or before that time (the first one, for a time before it), feeds each track on a loop
 * of its own with a bounded decoder queue — a track that ends early no longer ends the others —
 * pairs the resulting frames and hands pairs to the output queue through a {@link StartGate}.
 * One instance runs once; each `DecodeRun` creates its own.
 */
export class DecodePipeline<Handle = unknown> {
  private readonly stop = new RunStop();
  private hasRun = false;
  /**
   * The run's packet reads, which an abort returns at once: a read left to the run's unwinding
   * would go on reading until its awaits settle.
   */
  private iterators: readonly PacketIterator[] = [];
  /**
   * The run's decoders, which an abort closes at once too: the run a seek starts opens its own
   * within a few microtasks, and a phone may have no more decoders than one run needs.
   */
  private decoders: readonly VideoDecoderHandle[] = [];

  public constructor(
    private readonly frameSources: readonly VideoTrackReader[],
    private readonly decoderPort: VideoDecoderPort<Handle>,
    private readonly options: DecodePipelineOptions,
  ) {
    if (frameSources.length === 0) {
      throw new GyroViewError(
        'invariant-violation',
        'a decode pipeline needs at least one frame source',
      );
    }
  }

  /**
   * Runs until every track ends, the output queue is closed or {@link abort} is called. Resolves
   * with a report; rejects when a decoder fails or a track cannot be read.
   */
  public async run(from: Seconds, output: FramePairQueue<Handle>): Promise<DecodePipelineReport> {
    ensureInvariant(!this.hasRun, 'a decode pipeline runs once; create a new one for each run');
    this.hasRun = true;
    const run = await this.openRun(from, output);
    try {
      const hasReachedEnd = await this.feed(run);
      await settle(run, hasReachedEnd);
      if (run.failure.isSettled) throw await run.failure.promise;
      return reportOf(run, hasReachedEnd);
    } finally {
      closeRun(run);
    }
  }

  /**
   * Ends the run early: its packet reads are let go of and its decoders closed at once, pending
   * decodes discarded. Safe before, during and after the run.
   */
  public abort(): void {
    this.stop.stop();
    closeIterators(this.iterators);
    closeDecoders(this.decoders);
  }

  private async openRun(from: Seconds, output: FramePairQueue<Handle>): Promise<Run<Handle>> {
    const { stop } = this;
    const failure = new Deferred<Error>();
    const tally: RunTally = { packets: 0, pairs: 0 };
    const gate = new StartGate<Handle>(from, this.options.pairTolerance, (pair) => {
      tally.pairs += 1;
      output.push(pair);
    });
    const pairer = new FramePairer<Handle>(
      this.frameSources.length,
      this.options.pairTolerance,
      (pair) => {
        gate.push(pair);
      },
    );
    // A run aborted before it opened, as a seek overtaken by the next one is, opens nothing.
    const iterators = stop.wasStopped ? [] : this.packetIteratorsFrom(from);
    this.iterators = iterators;
    const onError = (error: Error): void => {
      failure.resolve(error);
      stop.stop();
    };
    try {
      const decoders = await this.openDecoders(frameReceiver(pairer, onError), onError);
      return { output, stop, failure, tally, gate, pairer, legs: legsOf(iterators, decoders) };
    } catch (error) {
      closeIterators(iterators);
      throw error;
    }
  }

  /**
   * The run's decoders, none for a run already aborted; an abort that comes while they open
   * closes them as soon as they are there.
   */
  private async openDecoders(
    receive: FrameReceiver<Handle>,
    onError: (error: Error) => void,
  ): Promise<readonly VideoDecoderHandle[]> {
    const decoders = this.stop.wasStopped ? [] : await this.createDecoders(receive, onError);
    this.decoders = decoders;
    if (this.stop.wasStopped) closeDecoders(decoders);
    return decoders;
  }

  /**
   * Opens one decoder per frame source; if any refuses, the ones already open are closed again.
   */
  private async createDecoders(
    receive: FrameReceiver<Handle>,
    onError: (error: Error) => void,
  ): Promise<VideoDecoderHandle[]> {
    const results = await Promise.allSettled(
      this.frameSources.map(async (track, sourceIndex) =>
        this.decoderPort.create(await track.decoderConfiguration(), {
          onFrame: (frame) => {
            receive(sourceIndex, frame);
          },
          onError,
        }),
      ),
    );
    const opened = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const refusal = results.find((result) => result.status === 'rejected');
    if (refusal) {
      for (const decoder of opened) decoder.close();
      throw toError(refusal.reason);
    }
    return opened;
  }

  /**
   * Feeds every track on a loop of its own until each runs out of packets. True when every
   * track ran out, false when aborted or the output queue closed first.
   */
  private async feed(run: Run<Handle>): Promise<boolean> {
    if (shouldStop(run)) return false;
    const finished = await Promise.all(
      run.legs.map((leg, sourceIndex) => this.feedTrack(run, leg, sourceIndex)),
    );
    return !shouldStop(run) && finished.every(Boolean);
  }

  /**
   * One track's loop: a packet at a time into its decoder, bounded by the output queue's room
   * and the decoder's pending limit; once the track runs out, its decoder is flushed so the
   * frames it held back still pair. True when the track ran out; false when the run stopped
   * first. A track that cannot be read fails the whole run.
   */
  private async feedTrack(
    run: Run<Handle>,
    leg: TrackLeg,
    sourceIndex: number,
  ): Promise<boolean> {
    try {
      for (;;) {
        const room = await waitRun(run, () => run.output.waitForRoom());
        if (room === STOPPED) return false;
        const next = await waitRun(run, () => leg.iterator.next());
        if (next === STOPPED) return false;
        if (next.done === true) return await this.finishTrack(run, leg, sourceIndex);
        const ready = await waitRun(run, () =>
          leg.decoder.waitForPendingBelow(this.options.maxPendingPackets),
        );
        if (ready === STOPPED) return false;
        leg.decoder.decode(next.value);
        run.tally.packets += 1;
      }
    } catch (error) {
      failRun(run, error);
      return false;
    }
  }

  /**
   * A track out of packets: flush the frames its decoder held back, then tell the pairer nothing
   * more will come of it. What the other tracks still wait with can never pair and is dropped;
   * when that leads the ended track by more media time than one recording allows, the run fails.
   */
  private async finishTrack(
    run: Run<Handle>,
    leg: TrackLeg,
    sourceIndex: number,
  ): Promise<boolean> {
    const flushed = await run.stop.race(() => leg.decoder.flush());
    if (flushed === STOPPED || shouldStop(run)) return false;
    run.pairer.endSource(sourceIndex);
    const unpaired = unpairedLimitExceeded(run.pairer);
    if (unpaired) {
      failRun(run, unpaired);
      return false;
    }
    return true;
  }

  private packetIteratorsFrom(from: Seconds): PacketIterator[] {
    return this.frameSources.map((track) => track.packetsFrom(from)[Symbol.asyncIterator]());
  }
}

/**
 * One leg per frame source: both lists are empty for a run stopped before it opened, and hold
 * one entry per source otherwise.
 */
function legsOf(
  iterators: readonly PacketIterator[],
  decoders: readonly VideoDecoderHandle[],
): TrackLeg[] {
  return iterators.map((iterator, index) => {
    const decoder = decoders[index];
    ensureInvariant(decoder !== undefined, 'every frame source has its decoder');
    return { iterator, decoder };
  });
}

/**
 * Pairs the decoders' frames, failing the run once the lenses have gone unpaired for too long to
 * be one recording.
 */
function frameReceiver<Handle>(
  pairer: FramePairer<Handle>,
  onError: (error: Error) => void,
): FrameReceiver<Handle> {
  return (sourceIndex, frame) => {
    pairer.push(sourceIndex, frame);
    const unpaired = unpairedLimitExceeded(pairer);
    if (unpaired) onError(unpaired);
  };
}

/**
 * The tracks stopped agreeing, if they ever did: frames kept being dropped for too long a span,
 * or one track's frames lead the others' by too much, to be one recording.
 */
function unpairedLimitExceeded<Handle>(pairer: FramePairer<Handle>): GyroViewError | undefined {
  if (pairer.unpairedSpan > UNPAIRED_SPAN_LIMIT_SECONDS) return unpairedLenses();
  return pairer.unpairedLead > UNPAIRED_SPAN_LIMIT_SECONDS ? lensTooFarAhead() : undefined;
}

function unpairedLenses(): GyroViewError {
  return new GyroViewError(
    'unsupported-layout',
    `the lens tracks showed no common instant for ${UNPAIRED_SPAN_LIMIT_SECONDS} seconds: their timestamps do not agree`,
  );
}

function lensTooFarAhead(): GyroViewError {
  return new GyroViewError(
    'unsupported-layout',
    `one lens track ran more than ${UNPAIRED_SPAN_LIMIT_SECONDS} seconds of media ahead of the others without a common instant: their timestamps do not agree`,
  );
}

function shouldStop<Handle>(run: Run<Handle>): boolean {
  return run.stop.wasStopped || run.output.isClosedForGood;
}

/**
 * One wait of a track's loop: STOPPED whenever the run is over, however the wait itself ended.
 */
async function waitRun<Handle, Value>(
  run: Run<Handle>,
  start: () => Promise<Value>,
): Promise<Value | typeof STOPPED> {
  const value = await run.stop.race(start);
  return shouldStop(run) ? STOPPED : value;
}

/**
 * A track that cannot be read or a limit passed: the run rejects with the first such error.
 */
function failRun<Handle>(run: Run<Handle>, error: unknown): void {
  run.failure.resolve(
    error instanceof Error
      ? error
      : new GyroViewError('decode', 'a frame source could not be read', { cause: error }),
  );
  run.stop.stop();
}

/**
 * After the feed: a finished run drains the decoders and, having reached the end, releases the
 * pair the gate held back. An abort, before or while draining, leaves what is pending to the
 * decoders' closing.
 */
async function settle<Handle>(run: Run<Handle>, hasReachedEnd: boolean): Promise<void> {
  const drained = await run.stop.race(() =>
    drain(
      run.legs.map((leg) => leg.decoder),
      run.failure,
    ),
  );
  if (drained !== STOPPED && hasReachedEnd) run.gate.release();
}

/**
 * A decoder that fails while draining has already aborted the run and settled its failure.
 */
async function drain(
  decoders: readonly VideoDecoderHandle[],
  failure: Deferred<Error>,
): Promise<void> {
  try {
    await Promise.all(decoders.map((decoder) => decoder.flush()));
  } catch (error) {
    if (!failure.isSettled) throw error;
  }
}

function closeRun<Handle>(run: Run<Handle>): void {
  closeDecoders(run.legs.map((leg) => leg.decoder));
  run.pairer.discardAll();
  run.gate.discard();
  closeIterators(run.legs.map((leg) => leg.iterator));
}

/**
 * An abort and the run's own end may both close a decoder, which the port allows.
 */
function closeDecoders(decoders: readonly VideoDecoderHandle[]): void {
  for (const decoder of decoders) decoder.close();
}

function closeIterators(iterators: readonly PacketIterator[]): void {
  for (const iterator of iterators) void iterator.return?.();
}

function reportOf<Handle>(run: Run<Handle>, hasReachedEnd: boolean): DecodePipelineReport {
  return {
    packetsDecoded: run.tally.packets,
    pairsDelivered: run.tally.pairs,
    unpairedFrames: run.pairer.unpaired,
    pairsDroppedBeforeStart: run.gate.dropped,
    hasReachedEnd,
  };
}

function toError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new GyroViewError('decode', 'a decoder could not be created', { cause: reason });
}
