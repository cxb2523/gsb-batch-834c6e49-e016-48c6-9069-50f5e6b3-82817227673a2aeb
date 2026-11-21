import type { FramePair } from '../../ports/FramePair';
import type { DecodedFrame } from '../../ports/VideoDecoderPort';
import { ensureIndexInRange } from '../../shared/errors/GyroViewError';
import { seconds, type Seconds } from '../../shared/units/time';

/**
 * Buffers decoded frames per frame source and emits a {@link FramePair} as soon as every source has
 * a frame for the same instant. The tracks of one recording share the camera clock, so their
 * timestamps agree exactly; the tolerance only absorbs floating-point conversion noise.
 *
 * A source that has {@link endSource ended} offers no new instants: once its buffered frames are
 * paired or dropped, whatever the other sources still wait with can never pair and is dropped
 * rather than buffered without bound.
 */
export class FramePairer<Handle = unknown> {
  private readonly queues: DecodedFrame<Handle>[][];
  private readonly ended: boolean[];
  /**
   * The latest timestamp each source has produced, what a dropped frame's lead is measured against.
   */
  private readonly newest: (Seconds | undefined)[];
  private unpairedCount = 0;
  /**
   * When the first and the latest frame dropped since the last pair show, if any was.
   */
  private unpairedFrom: Seconds | undefined;
  private unpairedTo: Seconds | undefined;
  /**
   * The most a frame dropped since the last pair led the other sources' newest frames by.
   */
  private leadOfUnpaired = 0;

  public constructor(
    sourceCount: number,
    private readonly tolerance: Seconds,
    private readonly onPair: (pair: FramePair<Handle>) => void,
  ) {
    this.queues = Array.from({ length: sourceCount }, () => []);
    this.ended = Array.from({ length: sourceCount }, () => false);
    this.newest = Array.from<Seconds | undefined>({ length: sourceCount });
  }

  /**
   * Frames dropped because no other source ever produced a matching instant.
   */
  public get unpaired(): number {
    return this.unpairedCount;
  }

  /**
   * The media time between the first and the latest frame dropped since the last pair: how long
   * the lenses have shown no common instant.
   */
  public get unpairedSpan(): Seconds {
    const { unpairedFrom, unpairedTo } = this;
    return seconds(
      unpairedFrom === undefined || unpairedTo === undefined ? 0 : unpairedTo - unpairedFrom,
    );
  }

  /**
   * How far the frame dropped furthest ahead of the other sources led them, in media time, since
   * the last pair: a source whose frames can never pair may lead by no more than this.
   */
  public get unpairedLead(): Seconds {
    return seconds(this.leadOfUnpaired);
  }

  public push(sourceIndex: number, frame: DecodedFrame<Handle>): void {
    ensureIndexInRange(sourceIndex, this.queues.length, 'frame source');
    this.newest[sourceIndex] = frame.timestamp;
    this.queues[sourceIndex]?.push(frame);
    this.drain();
  }

  /**
   * Marks a source as finished: no more frames will come from it. Frames still waiting whose
   * instant it can no longer offer are dropped as unpaired.
   */
  public endSource(sourceIndex: number): void {
    ensureIndexInRange(sourceIndex, this.queues.length, 'frame source');
    this.ended[sourceIndex] = true;
    this.drain();
  }

  /**
   * Closes everything still buffered, for example when stopping mid-stream.
   */
  public discardAll(): void {
    for (const queue of this.queues) {
      for (const frame of queue) frame.close();
      queue.length = 0;
    }
  }

  private drain(): void {
    while (this.queues.every((queue) => queue.length > 0)) {
      const heads = this.queues.map((queue) => queue[0]).filter((frame) => frame !== undefined);
      const earliest = Math.min(...heads.map((frame) => frame.timestamp));
      const isAligned = heads.every(
        (frame) => Math.abs(frame.timestamp - earliest) <= this.tolerance,
      );
      if (isAligned) this.emit(heads, seconds(earliest));
      else this.dropHeadAt(seconds(earliest));
    }
    // A source that ended with nothing left offers no instant any more: nothing still waiting
    // will ever pair.
    const canNeverPair = this.queues.some(
      (queue, sourceIndex) => queue.length === 0 && this.ended[sourceIndex],
    );
    while (canNeverPair && this.queues.some((queue) => queue.length > 0)) {
      const heads = this.queues.map((queue) => queue[0]).filter((frame) => frame !== undefined);
      const earliest = Math.min(...heads.map((frame) => frame.timestamp));
      this.dropHeadAt(seconds(earliest));
    }
  }

  private emit(frames: readonly DecodedFrame<Handle>[], timestamp: Seconds): void {
    for (const queue of this.queues) queue.shift();
    this.unpairedFrom = undefined;
    this.unpairedTo = undefined;
    this.leadOfUnpaired = 0;
    this.onPair({ timestamp, frames });
  }

  private dropHeadAt(timestamp: Seconds): void {
    const sourceIndex = this.queues.findIndex(
      (candidate) => candidate[0]?.timestamp === timestamp,
    );
    this.queues[sourceIndex]?.shift()?.close();
    this.unpairedCount += 1;
    this.unpairedFrom ??= timestamp;
    this.unpairedTo = timestamp;
    this.leadOfUnpaired = Math.max(this.leadOfUnpaired, this.leadOverOthers(timestamp, sourceIndex));
  }

  /**
   * How far a frame dropped from one source led the newest frames of the others; a source that
   * has shown nothing yet gives no reference to measure against.
   */
  private leadOverOthers(timestamp: Seconds, sourceIndex: number): Seconds {
    const others = this.newest.filter(
      (newest, index): newest is Seconds => index !== sourceIndex && newest !== undefined,
    );
    return seconds(others.length === 0 ? 0 : Math.max(0, timestamp - Math.min(...others)));
  }
}
