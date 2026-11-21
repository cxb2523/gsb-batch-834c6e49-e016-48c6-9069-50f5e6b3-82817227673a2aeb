declare global {
  interface Window {
    Hls: any;
  }
}

import { AudioX } from 'audio';
import { URLS } from 'constants/common';
import { HLS_EVENTS_CALLBACK_MAP } from 'events/hlsEvents';
import { attachHlsEventsListeners } from 'events/listeners';
import { loadScript } from 'helpers/common';
import type { MediaTrack } from 'types';
import type Hls from 'types/hls.js.js';
import type { HlsConfig, HlsListeners } from 'types/hls.js.js';

/**
 * Constructor shape of an HLS implementation (the real hls.js class or an
 * injectable fake used in tests). Keeping this structural type allows the
 * adapter to be driven without loading any script from the network.
 */
export interface HlsConstructor {
  new (config?: HlsConfig | Record<string, unknown>): Hls;
  isSupported(): boolean;
  Events: Record<string, string>;
}

let hlsInstance: Hls | undefined;
let hlsConstructor: HlsConstructor | undefined;
/**
 * Pending constructor seam: when set, init() awaits it before building the
 * engine. Tests use it to model a slow script load so race behavior can be
 * exercised deterministically.
 */
let pendingHlsConstructor: Promise<HlsConstructor | undefined> | undefined;
let hlsAdapterInstance: HlsAdapter | undefined;

class HlsAdapter {
  private HlsClass: HlsConstructor | undefined;
  private enablePlayLog = false;
  private eventsAttached = false;
  /**
   * Whether the current engine has ever been attached to the media element.
   * An engine created eagerly in init() but never used can be reused by the
   * first HLS switch; an engine that already drove playback must be destroyed
   * before a plain source can take over the element.
   */
  private mediaAttached = false;

  constructor() {
    if (hlsAdapterInstance) {
      // biome-ignore lint/correctness/noConstructorReturn: singleton guard
      return hlsAdapterInstance;
    }
    hlsAdapterInstance = this;
  }

  /**
   * Test/advanced-usage seam: inject an HLS constructor directly so that no
   * remote script has to be loaded. Passing `undefined` clears the override.
   */
  static setHlsConstructor(HlsClass: HlsConstructor | undefined) {
    hlsConstructor = HlsClass;
  }

  /**
   * Test seam: provide a constructor that becomes available asynchronously.
   * The pending value takes precedence over the synchronous override.
   */
  static setPendingHlsConstructor(pending: Promise<HlsConstructor | undefined> | undefined) {
    pendingHlsConstructor = pending;
  }

  static getAdapterInstance(): HlsAdapter | undefined {
    return hlsAdapterInstance;
  }

  /**
   * Tears down the singleton state. Used by AudioX.destroy() and by tests to
   * get a clean slate without reloading the module graph.
   */
  static reset() {
    hlsAdapterInstance = undefined;
    hlsConstructor = undefined;
    pendingHlsConstructor = undefined;
    hlsInstance = undefined;
  }

  async load(): Promise<HlsConstructor | undefined> {
    // An injected constructor (tests / bundler-provided hls.js) wins and never
    // touches the document or the network.
    if (pendingHlsConstructor) {
      this.HlsClass = await pendingHlsConstructor;
      return this.HlsClass;
    }
    if (hlsConstructor) {
      this.HlsClass = hlsConstructor;
      return this.HlsClass;
    }

    await loadScript(
      URLS.HLS,
      () => {
        console.log('HLS Loaded');
      },
      'hls',
    )
      .then(() => {
        this.HlsClass = typeof window !== 'undefined' ? window.Hls : undefined;
        if (typeof window !== 'undefined') {
          window.Hls = undefined;
        }
      })
      .catch((msg: string) => {
        console.log(msg);
      });

    return this.HlsClass;
  }

  async init(
    enablePlayLog = false,
    _config: HlsConfig | Record<string, unknown> = {},
    isAborted: () => boolean = () => false,
  ): Promise<Hls | undefined> {
    const config = _config;
    this.enablePlayLog = enablePlayLog;

    const Hls = await this.load();

    // The switch that started this initialization was superseded: do not
    // construct an engine that nobody is going to use.
    if (isAborted()) {
      return undefined;
    }
    if (!Hls || !Hls.isSupported()) {
      return undefined;
    }

    // Repeated init must not leak instances: recycle the existing one instead
    // of constructing a second engine on the same media element.
    if (!hlsInstance) {
      hlsInstance = new Hls(config);
      this.HlsClass = Hls;
      hlsAdapterInstance = this;
    }
    this.attachHlsEvents();
    return hlsInstance;
  }

  private attachHlsEvents() {
    if (this.eventsAttached || !hlsInstance) {
      return;
    }
    attachHlsEventsListeners(HLS_EVENTS_CALLBACK_MAP, this.enablePlayLog);
    this.eventsAttached = true;
  }

  /**
   * Atomically points the HLS engine at a new source.
   *
   * Order matters: detach first so the old pipeline stops pulling fragments,
   * then load the new source and re-attach the same media element. The same
   * HLS instance is reused for every HLS -> HLS switch.
   */
  switchSource(mediaTrack: MediaTrack): Hls | undefined {
    const audioElement = AudioX.getAudioInstance();
    if (!hlsInstance || !this.HlsClass || !audioElement) {
      return undefined;
    }

    hlsInstance.detachMedia();
    hlsInstance.loadSource(mediaTrack.source);
    hlsInstance.attachMedia(audioElement);
    this.mediaAttached = true;
    hlsInstance.on(this.HlsClass.Events.MEDIA_ATTACHED as keyof HlsListeners, () => {
      console.log('hls media attached');
    });

    return hlsInstance;
  }

  /**
   * Whether the active engine has ever been attached to the media element.
   */
  isMediaAttached(): boolean {
    return this.mediaAttached;
  }

  /**
   * Backwards-compatible alias used by earlier callers.
   */
  addHlsMedia(mediaTrack: MediaTrack): Hls | undefined {
    return this.switchSource(mediaTrack);
  }

  /**
   * Destroys the HLS engine. After this call the instance is fully detached,
   * all of its listeners are removed and the module-level reference is
   * released so a later init() builds a fresh pipeline.
   */
  destroy(): void {
    if (hlsInstance) {
      hlsInstance.detachMedia();
      hlsInstance.removeAllListeners();
      hlsInstance.destroy();
      hlsInstance = undefined;
    }
    this.eventsAttached = false;
    this.mediaAttached = false;
    this.HlsClass = undefined;
  }

  getHlsInstance(): Hls | undefined {
    return hlsInstance;
  }
}

export default HlsAdapter;
