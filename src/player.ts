import { StateMachine } from './stateMachine';
import { CueHandler } from './cueHandler';
import { InteractionManager } from './interactionManager';
import { Analytics } from './analytics';
import { SegmentManager } from './segmentManager';
import { I18n } from './i18n';

import type {
  PlayerConfig,
  CuePoint,
  AnalyticsEvent,
  PlayerState,
  HTMLVideoElementWithControlsList,
  Translations,
  AnalyticsPayload,
  DecisionAdapter,
} from './types';
import { InMemoryDecisionAdapter } from './InMemoryDecisionAdapter';
import { LocalStorageDecisionAdapter } from './localStorageDecisionAdapter';
import { FALLBACK_CSS } from './style';
import { SubtitlesManager } from './subtitlesManager';

const ALL_PLAYER_STATES: PlayerState[] = [
  'idle',
  'playing',
  'waitingForInteraction',
  'ended',
  'error',
];

/**
 * The main class for the Interactive Video Labs Player.
 * This class orchestrates the video playback, cue handling, interaction management,
 * and analytics tracking.
 *
 * Branch segments temporarily replace the main video source. The player keeps
 * the cue handler, the segment manager, the interaction manager and the
 * subtitles manager aligned across that switch so that returning from a
 * segment resumes the main video at the saved position without re-triggering
 * already answered cues.
 */
export class IVLabsPlayer {
  private videoElement: HTMLVideoElementWithControlsList;
  private config: PlayerConfig;
  private stateMachine: StateMachine;
  private cueHandler: CueHandler;
  private interactionManager: InteractionManager;
  private analytics: Analytics;
  private segmentManager: SegmentManager;
  private i18n: I18n;
  private decisionAdapter: DecisionAdapter;
  private subtitlesManager?: SubtitlesManager;

  private videoContainer: HTMLElement;
  private subtitlesElement?: HTMLTrackElement;

  private started = false;
  private destroyed = false;
  private eventsBound = false;

  private boundPlayHandler: () => void;
  private boundPauseHandler: () => void;
  private boundEndedHandler: () => void;

  constructor(target: string, config: PlayerConfig) {
    const targetElement = document.getElementById(target);
    if (!targetElement) throw new Error(`Target container with ID "${target}" not found.`);

    this.config = config;
    this.videoContainer = document.createElement('div');
    this.videoContainer.className = 'ivl-player-container';

    this.videoElement = document.createElement('video') as HTMLVideoElementWithControlsList;
    this.videoElement.controls = true;
    this.videoElement.controlsList = 'nodownload';

    if (config.subtitlesUrl) {
      this.subtitlesElement = document.createElement('track');
      this.subtitlesElement.src = config.subtitlesUrl;
      this.subtitlesElement.kind = 'subtitles';
      this.subtitlesElement.default = true;
      this.subtitlesManager = new SubtitlesManager(
        this.subtitlesElement,
        config.cues,
        this.videoElement,
      );
      this.videoElement.appendChild(this.subtitlesElement);
      this.subtitlesManager.onLoad((cues) => {
        this.handleSubtitleCues(cues);
      });
    }

    this.videoContainer.appendChild(this.videoElement);
    targetElement.innerHTML = '';
    targetElement.appendChild(this.videoContainer);

    this._injectFallbackCss();

    this.i18n = new I18n();
    if (config.translations) {
      for (const [locale, translations] of Object.entries(config.translations)) {
        this.i18n.load(locale, translations);
      }
    }
    if (config.locale) {
      this.i18n.setLocale(config.locale);
    }

    if (config.decisionAdapter) {
      this.decisionAdapter = config.decisionAdapter;
    } else if (config.decisionAdapterType === 'localStorage') {
      this.decisionAdapter = new LocalStorageDecisionAdapter();
    } else {
      this.decisionAdapter = new InMemoryDecisionAdapter();
    }
    this.analytics = new Analytics();
    this.stateMachine = new StateMachine(config.initialState || 'idle');
    this.registerTransitions();
    this.interactionManager = new InteractionManager(
      this.videoContainer,
      this.i18n,
      this.decisionAdapter,
    );
    this.cueHandler = new CueHandler(this.videoElement);
    this.segmentManager = new SegmentManager(this.videoElement, {
      onSegmentStart: this.handleSegmentStart,
      onSegmentEnd: this.handleSegmentEnd,
      onSegmentError: this.handleSegmentError,
    });

    this.boundPlayHandler = () => {
      this.analytics.track('VIDEO_STARTED', {
        event: 'VIDEO_STARTED',
        timestamp: Date.now(),
      });
    };
    this.boundPauseHandler = () => {
      this.analytics.track('VIDEO_PAUSED', {
        event: 'VIDEO_PAUSED',
        timestamp: Date.now(),
      });
    };
    this.boundEndedHandler = () => {
      if (this.destroyed) return;
      // A branch segment's `ended` event is handled by the SegmentManager,
      // which restores the main video. Only the main video's end should put
      // the player into the `ended` state.
      if (this.segmentManager.isPlayingSegment() || this.segmentManager.isRestoringMain()) {
        return;
      }
      this.analytics.track('VIDEO_ENDED', {
        event: 'VIDEO_ENDED',
        timestamp: Date.now(),
      });
      this.setState('ended');
    };

    if (!config.subtitlesUrl) {
      this.start(config.cues);
    }
  }

  /**
   * Registers every state-to-state transition so the player can authoritatively
   * reflect the playback state instead of silently failing transitions.
   */
  private registerTransitions(): void {
    for (const from of ALL_PLAYER_STATES) {
      for (const to of ALL_PLAYER_STATES) {
        if (from === to) continue;
        this.stateMachine.addTransition({ from, to });
      }
    }
  }

  /**
   * Moves the player to `next`. If the state machine rejects the transition the
   * state is forced rather than leaving the player in a stale state.
   */
  private setState(next: PlayerState): void {
    if (this.destroyed) return;
    if (this.stateMachine.getState() === next) return;
    if (!this.stateMachine.transitionTo(next)) {
      this.stateMachine.reset(next);
    }
  }

  private start(cues?: CuePoint[]) {
    this.cueHandler.registerCues(cues || []);
    if (!this.config.videoUrl) throw new Error('videoUrl must be provided in the PlayerConfig.');
    this.videoElement.src = this.config.videoUrl;
    if (!this.eventsBound) {
      this.bindEvents();
      this.eventsBound = true;
    }
    this.cueHandler.start();
    this.started = true;
  }

  /**
   * Handles cue points resolved from subtitles. The first resolution starts the
   * player; later resolutions (e.g. after the main video was restored following
   * a branch) refresh cue timings without forgetting which cues already fired.
   */
  private handleSubtitleCues(cues?: CuePoint[]): void {
    if (this.destroyed) return;
    if (!this.started) {
      this.start(cues);
      return;
    }
    this.cueHandler.updateCues(cues || this.config.cues || [], { preserveTriggered: true });
  }

  /**
   * Binds event listeners for cue handling, interaction response, and analytics.
   */
  private bindEvents(): void {
    this.cueHandler.onCue((cue: CuePoint) => this.handleCue(cue));
    //eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.interactionManager.onResponse((response: any, cue: CuePoint) => {
      this.handleInteractionResponse(response, cue);
    });

    this.videoElement.addEventListener('play', this.boundPlayHandler);
    this.videoElement.addEventListener('pause', this.boundPauseHandler);
    this.videoElement.addEventListener('ended', this.boundEndedHandler);
  }

  /**
   * Handles a fired cue.
   * @returns `false` when the cue must not be consumed yet (a branch segment is
   *   active), so it can fire once the main video resumes.
   */
  private handleCue(cue: CuePoint): boolean {
    if (this.destroyed) return true;
    // Defensive guard: main-video cues must never be evaluated while a branch
    // segment owns the timeline. Returning `false` leaves the cue untriggered
    // instead of silently swallowing it.
    if (this.segmentManager.isPlayingSegment() || this.cueHandler.isSuspended()) return false;

    this.analytics.track('onCueEnter', {
      event: 'onCueEnter',
      cueId: cue.id,
      timestamp: Date.now(),
    });

    if (cue.payload?.interaction) {
      this.videoElement.pause();
      this.setState('waitingForInteraction');
      this.interactionManager.handleInteractionCue(cue);
      this.analytics.track('onPromptShown', {
        event: 'onPromptShown',
        cueId: cue.id,
        timestamp: Date.now(),
      });
    } else {
      this.setState('playing');
    }

    return true;
  }

  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleInteractionResponse(response: any, cue: CuePoint): void {
    if (this.destroyed) return;

    this.analytics.track('onInteractionSelected', {
      event: 'onInteractionSelected',
      cueId: cue.id,
      data: { response },
      timestamp: Date.now(),
    });

    if (response && response.nextSegment) {
      this.analytics.track('onBranchJump', {
        event: 'onBranchJump',
        cueId: cue.id,
        data: { nextSegment: response.nextSegment },
        timestamp: Date.now(),
      });
      this.startBranch(response.nextSegment, cue);
    } else {
      this.videoElement.play().catch((error) => {
        console.error('Video playback failed:', error);
      });
      this.setState('playing');
    }

    this.analytics.track('INTERACTION_COMPLETED', {
      event: 'INTERACTION_COMPLETED',
      cueId: cue.id,
      data: { response },
      timestamp: Date.now(),
    });
  }

  /**
   * Enters a branch segment: the answered cue is consumed, cue triggering is
   * suspended, subtitles are detached and the segment manager takes over the
   * video source. The main source and position were saved by the segment
   * manager at this point.
   */
  private startBranch(segmentUrl: string, cue?: CuePoint): void {
    if (this.destroyed) return;
    if (this.segmentManager.isPlayingSegment() || this.segmentManager.isRestoringMain()) {
      // Ignore nested branch requests while a branch transition is in flight.
      return;
    }
    if (cue) this.cueHandler.markTriggered(cue);
    this.cueHandler.suspend();
    this.setState('playing');
    this.segmentManager.playSegment(segmentUrl);
  }

  private handleSegmentStart = (segmentUrl: string): void => {
    if (this.destroyed) return;
    this.cueHandler.suspend();
    this.interactionManager.setSourceContext({ source: 'segment', segmentUrl });
    this.subtitlesManager?.detachForSegment();
    this.setState('playing');
  };

  private handleSegmentEnd = (): void => {
    if (this.destroyed) return;
    // Order matters: re-resolve the subtitle track against the restored main
    // video (which refreshes cue timings) before cue triggering resumes, so
    // the first `timeupdate` after the branch already uses main-video times.
    this.subtitlesManager?.attachForMain();
    this.cueHandler.resume();
    this.interactionManager.setSourceContext({ source: 'main' });
    this.setState('playing');
  };

  private handleSegmentError = (error: unknown): void => {
    if (this.destroyed) return;
    this.analytics.track('ERROR', {
      event: 'ERROR',
      timestamp: Date.now(),
      data: { segmentError: String(error) },
    });
  };

  private releaseVideoListeners(): void {
    this.videoElement.removeEventListener('play', this.boundPlayHandler);
    this.videoElement.removeEventListener('pause', this.boundPauseHandler);
    this.videoElement.removeEventListener('ended', this.boundEndedHandler);
  }

  /** Loads cue points into the player. */
  public loadCues(cues: CuePoint[]): void {
    this.cueHandler.loadCues(cues);
  }

  /** Loads interaction segments into the player. */
  public loadInteractions(interactions: CuePoint[]): void {
    this.interactionManager.loadInteractions(interactions);
  }

  /** Returns the current player state. */
  public getState(): PlayerState {
    return this.stateMachine.getState();
  }

  /** Whether a branch segment currently owns the video element. */
  public isPlayingSegment(): boolean {
    return this.segmentManager.isPlayingSegment();
  }

  /** Plays the video. */
  public play(): void {
    this.videoElement.play();
  }

  /** Pauses the video. */
  public pause(): void {
    this.videoElement.pause();
  }

  /**
   * Registers a custom analytics hook for a specific event.
   * @param event - The event to listen for.
   * @param callback - The function to be called when the event is tracked.
   */
  public on(
    event: AnalyticsEvent,
    callback: (payload: AnalyticsPayload | undefined) => void,
  ): void {
    this.analytics.on(event, (event, payload) => callback(payload));
  }

  /**
   * Sets the current language for localization.
   * @param locale - The new locale.
   */
  public setLocale(locale: string): void {
    this.i18n.setLocale(locale);
  }

  /**
   * Loads a set of translations for a specific locale.
   * @param locale - The locale for the translations.
   * @param translations - The translation data.
   */
  public loadTranslations(locale: string, translations: Translations): void {
    this.i18n.load(locale, translations);
  }

  /**
   * Retrieves the user's decision history.
   * @returns A promise that resolves to an array of Decision objects.
   */
  public getDecisionHistory() {
    return this.decisionAdapter.getDecisionHistory();
  }

  /**
   * Clears the user's decision history.
   * @returns A promise that resolves when the history is cleared.
   */
  public clearDecisionHistory() {
    return this.decisionAdapter.clearDecisionHistory();
  }

  /**
   * Injects fallback CSS into the document head.
   * This ensures basic styling is present even if external stylesheets are not loaded.
   */
  private _injectFallbackCss(): void {
    const style = document.createElement('style');
    style.textContent = FALLBACK_CSS;
    document.head.appendChild(style);
  }

  /**
   * Cleans up the player, removes listeners and resets state.
   *
   * When called while a branch segment is playing the main video source and
   * position are restored first (paused), so the underlying video element is
   * left in a state where the main video can be played again.
   */
  public destroy(): void {
    if (this.destroyed) return;
    console.log('IVLabsPlayer destroy() called.');
    this.destroyed = true;

    this.releaseVideoListeners();
    // Restores the main source/time (paused) and removes the segment listeners.
    this.segmentManager.destroy();
    this.cueHandler.destroy();
    this.interactionManager.destroy();
    this.subtitlesManager?.destroy();
    this.started = false;
    this.eventsBound = false;

    this.analytics.track('onSessionEnd', {
      event: 'onSessionEnd',
      timestamp: Date.now(),
    });
  }
}
