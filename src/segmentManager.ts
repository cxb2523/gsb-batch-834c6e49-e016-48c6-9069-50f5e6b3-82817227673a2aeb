import { HTMLVideoElementWithControlsList } from './types';

/**
 * Callbacks emitted by the {@link SegmentManager} while a branch segment is
 * being played and while the main video is being restored.
 */
export type SegmentManagerCallbacks = {
  /** Fired synchronously right before the segment source is loaded. */
  onSegmentStart?: (segmentUrl: string) => void;
  /** Fired once the main video source has been restored (after `loadedmetadata`). */
  onSegmentEnd?: () => void;
  /** Fired when the segment could not be loaded, before the main video is restored. */
  onSegmentError?: (error: unknown) => void;
  /** Fired once the main video has been restored and its position re-applied. */
  onMainRestored?: (mainVideoSrc: string, resumeTime: number) => void;
};

type ListenerEntry = {
  type: string;
  handler: (event: Event) => void;
};

/**
 * Manages the logic for switching to and from video segments.
 *
 * A branch segment temporarily replaces the main video source. While the
 * segment plays, the main video's position is kept so it can be restored once
 * the segment ends (or when the segment fails to load, or when the player is
 * destroyed). Every listener that is added for a segment is tracked so it can
 * be removed deterministically.
 */
export class SegmentManager {
  private videoElement: HTMLVideoElementWithControlsList;
  private callbacks: SegmentManagerCallbacks;
  private _mainVideoSrc: string | null = null;
  private _mainVideoCurrentTime: number = 0;
  private _playingSegment = false;
  private _restoringMain = false;
  private destroyed = false;
  /** Incremented on each restore so stale async callbacks can be ignored. */
  private restoreToken = 0;
  private segmentListeners: ListenerEntry[] = [];
  private mainRestoreListeners: ListenerEntry[] = [];
  private boundEndedHandler: () => void;
  private boundErrorHandler: (event: Event) => void;

  constructor(
    videoElement: HTMLVideoElementWithControlsList,
    callbacks: SegmentManagerCallbacks = {},
  ) {
    this.videoElement = videoElement;
    this.callbacks = callbacks;
    this.boundEndedHandler = this.handleEnded.bind(this);
    this.boundErrorHandler = this.handleError.bind(this);
    this.bindEvents();
  }

  /** Updates the callbacks without recreating the manager. */
  public setCallbacks(callbacks: SegmentManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  /** Whether a branch segment is currently the active source. */
  public isPlayingSegment(): boolean {
    return this._playingSegment;
  }

  /** Whether the main video source is being restored after a branch. */
  public isRestoringMain(): boolean {
    return this._restoringMain;
  }

  /** The saved main video source, or `null` when no branch is active. */
  public getMainVideoSrc(): string | null {
    return this._mainVideoSrc;
  }

  /** The saved main video position, in seconds. */
  public getMainVideoTime(): number {
    return this._mainVideoCurrentTime;
  }

  private bindEvents(): void {
    this.videoElement.addEventListener('ended', this.boundEndedHandler);
    this.videoElement.addEventListener('error', this.boundErrorHandler);
  }

  /**
   * Handles the segment's `ended` event. When a branch is active the main
   * video is restored and playback resumes from the saved position.
   *
   * Exposed so the owning player can delegate its own `ended` handling when
   * the two listeners are registered from different places.
   * @returns `true` when a main video restore was initiated.
   */
  public handleVideoEnded(): boolean {
    if (this.destroyed) return false;
    if (!this._playingSegment) return false;
    console.log('Segment ended. Resuming main video:', this._mainVideoSrc);
    return this.restoreMain({ play: true });
  }

  private handleEnded(): void {
    this.handleVideoEnded();
  }

  /**
   * Handles media `error` events. Only failures of the branch segment are
   * relevant; an error from the main video must not trigger a restore.
   */
  private handleError(event: Event): void {
    if (this.destroyed) return;
    if (!this._playingSegment || this._restoringMain) return;
    this.handleSegmentFailure(event);
  }

  private handleSegmentFailure(error: unknown): void {
    if (!this._playingSegment) return;
    console.error('Failed to load segment video:', error);
    this.callbacks.onSegmentError?.(error);
    // A failed segment must not leave the player stuck: restore the main
    // video and continue from the saved position.
    this.restoreMain({ play: true });
  }

  /**
   * Handles the transition to a new video segment.
   * Saves the current main video state and plays the new segment.
   * @param newSegmentUrl The URL of the new video segment to play.
   */
  public playSegment(newSegmentUrl: string): void {
    if (this.destroyed || this._playingSegment || this._restoringMain) return;
    if (!newSegmentUrl) return;

    this._mainVideoSrc = this.videoElement.src;
    this._mainVideoCurrentTime = this.videoElement.currentTime;
    this._playingSegment = true;
    this._restoringMain = false;
    this.clearSegmentListeners();

    this.callbacks.onSegmentStart?.(newSegmentUrl);

    this.videoElement.src = newSegmentUrl;
    this.videoElement.load();

    this.addSegmentListener('loadedmetadata', () => {
      if (!this._playingSegment) return;
      this.videoElement.play().catch((error) => {
        console.error('Error playing segment video:', error);
        // A segment that cannot start playing is treated like a load failure:
        // fall back to the main video rather than stranding the player.
        this.handleSegmentFailure(error);
      });
      console.log('Playing segment video:', newSegmentUrl);
    });

    // Segment load failures are handled by the persistent `error` listener
    // installed in `bindEvents`, which routes to `handleSegmentFailure`.
  }

  /**
   * Restores the main video source and re-applies the saved position.
   * Safe to call when no segment is playing (it becomes a no-op).
   *
   * @param options.play - Whether to resume playback once the main video has
   *   been restored. Defaults to `true`.
   * @returns `true` when a main video restore was initiated.
   */
  public restoreMain(options: { play?: boolean } = {}): boolean {
    if (!this._playingSegment) return false;

    const shouldPlay = options.play !== false;
    const resumeSrc = this._mainVideoSrc ?? this.videoElement.src;
    const resumeTime = this._mainVideoCurrentTime;

    this._mainVideoSrc = null;
    this._mainVideoCurrentTime = 0;
    this._playingSegment = false;
    this._restoringMain = true;

    this.clearSegmentListeners();
    this.clearMainRestoreListeners();

    const token = ++this.restoreToken;

    this.videoElement.src = resumeSrc;
    // Apply the saved position eagerly (spec allows this before metadata) so
    // the video element reports the correct position even if the caller
    // inspects it synchronously, then re-apply once metadata is available.
    this.setCurrentTime(resumeTime);
    this.videoElement.load();
    this.setCurrentTime(resumeTime);

    this.addMainRestoreListener('loadedmetadata', () => {
      if (token !== this.restoreToken || this.destroyed) return;
      this.clearMainRestoreListeners();
      this.setCurrentTime(resumeTime);
      this._restoringMain = false;
      this.callbacks.onMainRestored?.(resumeSrc, resumeTime);
      this.callbacks.onSegmentEnd?.();
      if (shouldPlay && !this.destroyed) {
        this.videoElement.play().catch((err) => {
          console.error('Error resuming main video:', err);
        });
      }
    });

    this.addMainRestoreListener('error', (event) => {
      if (token !== this.restoreToken || this.destroyed) return;
      this.clearMainRestoreListeners();
      this._restoringMain = false;
      this.callbacks.onSegmentError?.(event);
      // The player must still leave the waiting branch: cues are resumed and
      // the state machine returns to `playing` through `onSegmentEnd`.
      this.callbacks.onSegmentEnd?.();
    });

    return true;
  }

  private setCurrentTime(time: number): void {
    try {
      this.videoElement.currentTime = time;
    } catch (error) {
      // Setting currentTime before metadata is available can throw in some
      // environments; it is re-applied in the loadedmetadata handler.
      void error;
    }
  }

  private addSegmentListener<T extends Event>(
    type: string,
    handler: (event: T) => void,
    once = true,
  ): void {
    this.videoElement.addEventListener(type, handler as EventListener, { once });
    this.segmentListeners.push({ type, handler: handler as (event: Event) => void });
  }

  private addMainRestoreListener<T extends Event>(
    type: string,
    handler: (event: T) => void,
    once = true,
  ): void {
    this.videoElement.addEventListener(type, handler as EventListener, { once });
    this.mainRestoreListeners.push({ type, handler: handler as (event: Event) => void });
  }

  private clearSegmentListeners(): void {
    for (const { type, handler } of this.segmentListeners) {
      this.videoElement.removeEventListener(type, handler as EventListener);
    }
    this.segmentListeners = [];
  }

  private clearMainRestoreListeners(): void {
    for (const { type, handler } of this.mainRestoreListeners) {
      this.videoElement.removeEventListener(type, handler as EventListener);
    }
    this.mainRestoreListeners = [];
  }

  /**
   * Destroys the SegmentManager instance.
   * If a branch segment is playing, the main video source and position are
   * restored (paused) so the underlying video element is left in a playable
   * state. All event listeners added by this manager are removed.
   */
  public destroy(): void {
    if (this.destroyed) return;

    if (this._playingSegment) {
      // Restore the main source/position without auto-play; teardown happens
      // immediately afterwards.
      this.restoreMain({ play: false });
    }

    this.destroyed = true;
    this.restoreToken++;
    this.clearSegmentListeners();
    this.clearMainRestoreListeners();
    this.videoElement.removeEventListener('ended', this.boundEndedHandler);
    this.videoElement.removeEventListener('error', this.boundErrorHandler);
    this._playingSegment = false;
    this._restoringMain = false;
    this._mainVideoSrc = null;
    this._mainVideoCurrentTime = 0;
    this.callbacks = {};
  }
}
