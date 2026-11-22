import { CuePoint as Cue } from './types';

export type CueCallback = (cue: Cue) => void | boolean;

/**
 * Manages and triggers cue points during video playback.
 * This class is responsible for registering cue points, listening for video
 * time updates, and triggering registered callbacks when a cue point is reached.
 *
 * While a branch segment is playing the handler can be suspended so that the
 * cues belonging to the main video are not triggered against the segment
 * timeline. Triggered cues are remembered across suspensions, therefore a cue
 * that was already answered is not fired again after the main video resumes.
 */
export class CueHandler {
  private cues: Cue[] = [];
  private callback?: CueCallback;
  private triggered: Set<string> = new Set();
  private videoElement: HTMLVideoElement;
  private suspended = false;
  private listening = false;

  /**
   * Creates an instance of CueHandler.
   * @param video - The HTMLVideoElement to monitor for cue points.
   */
  constructor(video: HTMLVideoElement) {
    this.videoElement = video;
    this.handleTimeUpdate = this.handleTimeUpdate.bind(this);
  }

  /**
   * Registers cue points and sets up the video element to listen for time updates.
   * Registering a new set of cues resets the already-triggered bookkeeping
   * because the cue identity may have changed.
   * @param cues - An array of Cue objects to register.
   */
  public registerCues(cues: Cue[]) {
    this.cues = [...cues].sort((a, b) => a.time - b.time);
    this.triggered.clear();
  }

  public loadCues(cues: Cue[]) {
    this.registerCues(cues);
    this.start();
  }

  /**
   * Replaces the cue definitions without discarding which cues already fired.
   *
   * Subtitle-derived cues keep the same id but get their time resolved again
   * once the main video is restored after a branch. Re-registering them must
   * not make an already-answered cue fire a second time.
   *
   * @param cues - The new cue definitions.
   * @param options.preserveTriggered - Keep the triggered bookkeeping for cues
   *   whose id is present in the new set. Defaults to `true`.
   */
  public updateCues(cues: Cue[], options: { preserveTriggered?: boolean } = {}) {
    const preserveTriggered = options.preserveTriggered !== false;
    const liveIds = new Set(cues.filter((cue) => cue.id != null).map((cue) => `id:${cue.id}`));
    const keptTriggered = new Set(
      [...this.triggered].filter((key) => key.startsWith('id:') && liveIds.has(key)),
    );

    this.cues = [...cues].sort((a, b) => a.time - b.time);

    if (preserveTriggered) {
      this.triggered = keptTriggered;
    } else {
      this.triggered.clear();
    }
  }

  /**
   * Sets the callback function to be called when a cue point is reached.
   * @param callback - The callback function to be executed.
   */
  public onCue(callback: CueCallback) {
    this.callback = callback;
  }

  /**
   * Starts listening for cue points. Calling this method more than once is safe.
   */
  public start() {
    if (this.listening) return;
    this.videoElement.addEventListener('timeupdate', this.handleTimeUpdate);
    this.listening = true;
  }

  /**
   * Stops listening for cue points.
   */
  public stop() {
    this.videoElement.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.listening = false;
  }

  /**
   * Suspends cue triggering without forgetting which cues already fired.
   * Used while a branch segment (which has its own timeline and its own cues)
   * is playing: the main video's cues must not be evaluated against the
   * segment's `currentTime`.
   */
  public suspend() {
    this.suspended = true;
  }

  /**
   * Resumes cue triggering. Cues that already fired (including the cue that
   * started the branch) stay marked as triggered and will not fire again.
   */
  public resume() {
    this.suspended = false;
  }

  /** Whether cue triggering is currently suspended. */
  public isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * Stable identity for a cue. Prefers the cue id (two cues may share a time),
   * and falls back to the time for anonymous cues.
   */
  private cueKey(cue: Cue): string {
    return cue.id != null ? `id:${cue.id}` : `time:${cue.time}`;
  }

  /** Whether the given cue has already been triggered. */
  public hasTriggered(cue: Cue): boolean {
    return this.triggered.has(this.cueKey(cue));
  }

  /**
   * Marks a cue as triggered without invoking the callback. Useful when an
   * interaction was answered elsewhere and must not be surfaced again.
   */
  public markTriggered(cue: Cue) {
    this.triggered.add(this.cueKey(cue));
  }

  /** Clears the triggered bookkeeping, e.g. when replaying from the start. */
  public resetTriggered() {
    this.triggered.clear();
  }

  /**
   *  Handles the time update event from the video element.
   *  Checks if the current time matches any registered cue points and triggers the callback.
   */
  private handleTimeUpdate() {
    if (this.suspended) return;

    const currentTime = this.videoElement.currentTime;

    for (const cue of this.cues) {
      const key = this.cueKey(cue);
      if (this.triggered.has(key) || currentTime < cue.time) continue;

      // A callback may refuse to consume the cue (e.g. the player knows a
      // branch segment owns the timeline). In that case the cue is left
      // untriggered so it can fire once the main video is active again.
      const consumed = this.callback ? this.callback(cue) !== false : true;
      if (consumed) this.triggered.add(key);
    }
  }

  /**
   * Destroys the CueHandler instance: removes the listener and clears state.
   */
  public destroy() {
    this.stop();
    this.triggered.clear();
    this.callback = undefined;
    this.suspended = false;
  }
}
