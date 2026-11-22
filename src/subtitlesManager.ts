import { CuePoint } from './types';

/**
 * Represents an extended text track cue with additional properties.
 */
interface ExtendedTextTrackCue extends TextTrackCue {
  text: string;
}

type CuesCallback = (cues?: CuePoint[]) => void;

/**
 * Manages subtitles for a video element.
 * Handles loading and processing of subtitle cues.
 *
 * The subtitle `<track>` belongs to the main video only. When a branch segment
 * takes over the same `<video>` element the track is detached from the element
 * so the segment never inherits main-video subtitles; once the main video is
 * restored the track is re-attached (and re-resolved) so subtitles stay aligned
 * with the main video's timeline instead of the segment's.
 */
export class SubtitlesManager {
  private subtitlesElement: HTMLTrackElement;
  private cuePoints: CuePoint[] = [];
  private videoElement?: HTMLVideoElement;
  private callbacks: CuesCallback[] = [];
  private detached = false;
  private destroyed = false;
  private readonly boundLoadHandler: () => void;
  private readonly boundErrorHandler: (event: Event) => void;

  /**
   * Creates an instance of SubtitlesManager.
   * @param subtitlesElement - The HTML track element for subtitles.
   * @param cuePoints - Optional array of cue points to initialize with.
   * @param videoElement - Optional video element the track is attached to.
   */
  constructor(
    subtitlesElement: HTMLTrackElement,
    cuePoints: CuePoint[] = [],
    videoElement?: HTMLVideoElement,
  ) {
    this.subtitlesElement = subtitlesElement;
    this.cuePoints = [...cuePoints];
    this.videoElement = videoElement;
    this.boundLoadHandler = this.handleLoad.bind(this);
    this.boundErrorHandler = this.handleError.bind(this);
  }

  /**
   * Registers a callback to be invoked when subtitles are loaded, when the
   * track is re-attached to the main video, or when an error occurs.
   * @param callback - A function to be called with the resolved cues.
   */
  public onLoad(callback: CuesCallback): void {
    this.callbacks.push(callback);
    this.subtitlesElement.addEventListener('load', this.boundLoadHandler);
    this.subtitlesElement.addEventListener('error', this.boundErrorHandler);
    this.setTrackMode('showing');
  }

  /** The subtitle URL this manager keeps attached to the main video. */
  public getSubtitlesUrl(): string {
    return this.subtitlesElement.src || this.subtitlesElement.getAttribute('src') || '';
  }

  /** Resolves the configured cue points against the currently loaded track. */
  public getCuePoints(): CuePoint[] {
    return this.resolveCues();
  }

  /**
   * Detaches the subtitle track while a branch segment owns the video element.
   * The track URL is preserved so it can be restored for the main video.
   */
  public detachForSegment(): void {
    if (this.destroyed || this.detached) return;
    this.detached = true;
    this.setTrackMode('disabled');
    this.subtitlesElement.default = false;
    if (this.subtitlesElement.parentNode) {
      this.subtitlesElement.parentNode.removeChild(this.subtitlesElement);
    }
    this.suppressVideoTextTracks();
  }

  /**
   * Re-attaches the subtitle track to the main video and forces the browser to
   * resolve it against the restored source. Resolved cue timings are pushed to
   * the registered callbacks so cue mapping follows the main video again.
   */
  public attachForMain(): void {
    if (this.destroyed) return;
    const wasDetached = this.detached;
    this.detached = false;

    this.ensureAttached();
    this.subtitlesElement.default = true;
    this.setTrackMode('showing');

    if (wasDetached && !this.hasResolvedTrack()) {
      // Re-assigning the source makes the media element parse the track again
      // against the newly restored main video instead of keeping the stale
      // cue list from before the branch. Only needed when re-attaching did not
      // already resolve the track, to avoid a redundant fetch.
      const src = this.getSubtitlesUrl();
      if (src) {
        this.subtitlesElement.src = src;
      }
    }

    // Only push cue timings when returning from a detached track and the track
    // could actually be resolved against the restored video. Emitting
    // unresolved cues (time 0) would move every subtitle cue to the start of
    // the main video.
    if (wasDetached && this.hasResolvedTrack()) {
      this.emitCues();
    }
  }

  /**
   * Whether the track currently has resolved cues that can be matched against
   * the configured cue points.
   */
  private hasResolvedTrack(): boolean {
    try {
      const track = this.subtitlesElement.track;
      return !!track && Array.isArray(track.cues) && track.cues.length > 0;
    } catch {
      return false;
    }
  }

  /** Whether the subtitle track is currently detached for a branch segment. */
  public isDetached(): boolean {
    return this.detached;
  }

  private ensureAttached(): void {
    const parent = this.videoElement;
    if (parent && this.subtitlesElement.parentNode !== parent) {
      parent.appendChild(this.subtitlesElement);
    }
  }

  private suppressVideoTextTracks(): void {
    const tracks = this.videoElement?.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (track && track.mode === 'showing') {
        try {
          track.mode = 'hidden';
        } catch {
          // Some environments expose a read-only TextTrackList.
        }
      }
    }
  }

  private setTrackMode(mode: TextTrackMode): void {
    try {
      const track = this.subtitlesElement.track;
      if (track) track.mode = mode;
    } catch {
      // `track` may not be available (e.g. not attached to a media element).
    }
  }

  private handleLoad(): void {
    if (this.destroyed || this.detached) return;
    this.emitCues();
  }

  private handleError(event: Event): void {
    if (this.destroyed) return;
    console.error('Failed to load subtitles:', event);
    this.emitCues();
  }

  private emitCues(): void {
    const cues = this.resolveCues();
    for (const callback of this.callbacks) {
      callback(cues.map((cue) => ({ ...cue })));
    }
  }

  private resolveCues(): CuePoint[] {
    const track = this.subtitlesElement.track;
    const trackCues = track ? Array.from(track.cues || []) : [];

    return this.cuePoints.map((cueConfig) => {
      const match = trackCues.find(
        (cue) => (cue as ExtendedTextTrackCue)?.text === cueConfig.subtitleText,
      );
      return {
        ...cueConfig,
        time: match ? match.startTime : (cueConfig.time ?? 0),
      };
    });
  }

  /**
   * Removes listeners and clears registered callbacks.
   *
   * If the track was detached for a branch segment, it is re-attached to the
   * (restored) main video first so the element does not advertise main-video
   * subtitles while the track belongs to a segment that is no longer playing.
   */
  public destroy(): void {
    if (this.destroyed) return;
    if (this.detached) {
      this.ensureAttached();
      this.subtitlesElement.default = true;
    }
    this.destroyed = true;
    this.detached = false;
    this.subtitlesElement.removeEventListener('load', this.boundLoadHandler);
    this.subtitlesElement.removeEventListener('error', this.boundErrorHandler);
    this.callbacks = [];
  }
}
