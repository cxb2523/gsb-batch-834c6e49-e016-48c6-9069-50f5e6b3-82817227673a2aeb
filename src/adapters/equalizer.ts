import { AudioX } from 'audio';
import { bands, presets } from 'constants/equalizer';
import { isValidArray } from 'helpers/common';

import type { EqualizerStatus, Preset } from 'types/equalizer.types';

interface EqSettings {
  presetId: Preset['id'] | null;
  customGains: number[] | null;
  bassBoostEnabled: boolean;
  bassBoostGain: number;
}

const DEFAULT_SETTINGS: EqSettings = {
  presetId: null,
  customGains: null,
  bassBoostEnabled: false,
  bassBoostGain: 6,
};

class Equalizer {
  private static _instance: Equalizer | undefined;
  private audioCtx: AudioContext | undefined;
  private audioCtxStatus: EqualizerStatus = 'IDEAL';
  private eqFilterBands: BiquadFilterNode[] = [];
  private bassBoostFilter: BiquadFilterNode | undefined;
  private compressor: DynamicsCompressorNode | undefined;
  private mediaSource: MediaElementAudioSourceNode | undefined;
  private resumeListener: (() => void) | undefined;

  /**
   * Tracks every media element already wired into this context. A media
   * element can only be passed to createMediaElementSource once, otherwise the
   * browser throws and the element goes silent; source switches therefore
   * reuse the existing MediaElementSourceNode instead of reconnecting.
   */
  private connectedElements = new WeakSet<HTMLMediaElement>();

  private settings: EqSettings = { ...DEFAULT_SETTINGS };

  /**
   * Creates an instance of Equalizer or returns the existing instance.
   */
  constructor() {
    if (Equalizer._instance) {
      console.warn(
        'Instantiation failed: cannot create multiple instances of Equalizer. Returning existing instance.',
      );
      // biome-ignore lint/correctness/noConstructorReturn: singleton guard
      return Equalizer._instance;
    }

    this.initializeAudioContext();
    Equalizer._instance = this;
  }

  static getInstance(): Equalizer | undefined {
    return Equalizer._instance;
  }

  /**
   * Initializes the AudioContext, ensuring compatibility with older browsers.
   * When Web Audio is unavailable the equalizer degrades to passthrough
   * playback instead of throwing, so media playback is never blocked.
   * @private
   */
  private initializeAudioContext() {
    const audioContextOptions = { latencyHint: 'playback' };
    const ContextCtor =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : typeof window !== 'undefined' && (window as any).webkitAudioContext
          ? (window as any).webkitAudioContext
          : undefined;

    if (!ContextCtor) {
      console.error('Web Audio API is not supported in this browser.');
      this.audioCtxStatus = 'FAILED';
      return;
    }

    try {
      this.audioCtx = new ContextCtor(audioContextOptions as AudioContextOptions);
      this.audioCtxStatus = 'ACTIVE';
      this.init();

      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.addResumeListener();
      }
    } catch (error) {
      console.error('Equalizer AudioContext creation failed:', error);
      this.audioCtxStatus = 'FAILED';
      this.audioCtx = undefined;
    }
  }

  /**
   * Adds a listener to resume the AudioContext on user interaction.
   * @private
   */
  private addResumeListener() {
    if (typeof document === 'undefined' || !document.body) {
      return;
    }
    const resume = () => {
      if (!this.audioCtx) {
        return;
      }
      this.audioCtx.resume();
      setTimeout(() => {
        if (this.audioCtx && this.audioCtx.state === 'running' && this.resumeListener) {
          document.body.removeEventListener('click', this.resumeListener, false);
        }
      }, 0);
    };

    this.resumeListener = resume;
    document.body.addEventListener('click', resume, false);
  }

  /**
   * Wires the media element into the Web Audio graph. The media element
   * source is created at most once per element; repeated calls (e.g. after
   * source changes) only re-apply the stored EQ settings on the existing
   * graph.
   */
  init() {
    if (!this.audioCtx) {
      this.audioCtxStatus = 'FAILED';
      return;
    }

    try {
      const audioInstance = AudioX.getAudioInstance();
      if (!audioInstance) {
        this.audioCtxStatus = 'FAILED';
        return;
      }

      if (!this.connectedElements.has(audioInstance)) {
        this.mediaSource = this.audioCtx.createMediaElementSource(audioInstance);
        this.connectedElements.add(audioInstance);
        this.buildGraph();
      }

      this.reapplySettings();
      this.audioCtxStatus = 'ACTIVE';
    } catch (error) {
      console.error('Equalizer initialization failed:', error);
      this.audioCtxStatus = 'FAILED';
    }
  }

  /**
   * Builds the filter chain: media source -> EQ bands -> bass boost ->
   * compressor -> destination.
   * @private
   */
  private buildGraph() {
    if (!this.audioCtx || !this.mediaSource) {
      return;
    }

    const equalizerBands = bands.map((band) => {
      const filter = this.audioCtx!.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.q || 1;
      return filter;
    });

    this.compressor = this.audioCtx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 12;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.bassBoostFilter = this.audioCtx.createBiquadFilter();
    this.bassBoostFilter.type = 'lowshelf';
    this.bassBoostFilter.frequency.value = 100;
    this.bassBoostFilter.gain.value = 0;

    this.mediaSource.connect(equalizerBands[0]);
    for (let i = 0; i < equalizerBands.length - 1; i++) {
      equalizerBands[i].connect(equalizerBands[i + 1]);
    }
    equalizerBands[equalizerBands.length - 1].connect(this.bassBoostFilter);
    this.bassBoostFilter.connect(this.compressor);
    this.compressor.connect(this.audioCtx.destination);

    this.eqFilterBands = equalizerBands;
  }

  /**
   * Re-applies the persisted preset/custom gains/bass boost. Used when the
   * graph is rebuilt so EQ settings survive source switches and re-inits.
   * @private
   */
  private reapplySettings() {
    if (this.settings.presetId !== null) {
      this.applyPresetGains(this.settings.presetId);
    }
    if (this.settings.customGains) {
      this.applyGains(this.settings.customGains);
    }
    if (this.settings.bassBoostEnabled) {
      this.applyBassBoost(this.settings.bassBoostGain);
    }
  }

  private applyPresetGains(id: Preset['id']) {
    const preset = presets.find((el) => el.id === id);
    if (!preset || !this.audioCtx || this.eqFilterBands.length !== preset.gains.length) {
      return;
    }
    this.applyGains(preset.gains);
  }

  private applyGains(gains: number[]) {
    if (!this.audioCtx || this.eqFilterBands.length !== gains.length) {
      return;
    }
    const currentTime = this.audioCtx.currentTime;
    for (let index = 0; index < this.eqFilterBands.length; index++) {
      this.eqFilterBands[index].gain.setTargetAtTime(gains[index], currentTime, 0.05);
    }
  }

  private applyBassBoost(gain: number) {
    if (!this.audioCtx || !this.bassBoostFilter) {
      return;
    }
    this.bassBoostFilter.gain.setTargetAtTime(gain, this.audioCtx.currentTime, 0.05);
  }

  /**
   * Sets the equalizer to a predefined preset.
   * @param id - The ID of the preset to apply (see `presets`).
   */
  setPreset(id: Preset['id']) {
    const preset = presets.find((el) => el.id === id);
    if (!preset) {
      console.error('Preset not found:', id);
      return;
    }

    if (!this.eqFilterBands || this.eqFilterBands.length !== preset.gains.length) {
      console.error('Invalid data provided.');
      return;
    }

    this.settings.presetId = id;
    this.settings.customGains = null;
    this.applyPresetGains(id);
  }

  /**
   * Retrieves the list of available presets.
   * @returns {Preset[]} The list of available presets.
   */
  static getPresets() {
    return presets;
  }

  /**
   * Gets the current status of the AudioContext.
   * @returns {EqualizerStatus} The current status of the AudioContext.
   */
  status(): EqualizerStatus {
    if (!this.audioCtx) {
      return this.audioCtxStatus;
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtxStatus;
  }

  /**
   * Sets a custom equalizer configuration.
   * @param {number[]} gains - The gain values for each band.
   */
  setCustomEQ(gains: number[]) {
    if (isValidArray(gains) && this.eqFilterBands && gains.length === this.eqFilterBands.length) {
      this.settings.customGains = [...gains];
      this.settings.presetId = null;
      this.applyGains(gains);
    } else {
      console.error('Invalid array of gains provided.');
    }
  }

  /**
   * Enables or disables bass boost.
   * @param {boolean} enable - Whether to enable or disable bass boost.
   * @param {number} gain - The gain value for bass boost.
   */
  setBassBoost(enable: boolean, gain = 6) {
    this.settings.bassBoostEnabled = enable;
    this.settings.bassBoostGain = gain;
    if (enable) {
      this.applyBassBoost(gain);
    } else {
      this.applyBassBoost(0);
    }
  }

  /**
   * Adjusts the compressor settings.
   * @param {Partial<DynamicsCompressorOptions>} options - The compressor options to adjust.
   */
  setCompressorSettings(options: Partial<DynamicsCompressorOptions>) {
    if (this.compressor && this.audioCtx) {
      if (options.threshold !== undefined)
        this.compressor.threshold.setTargetAtTime(
          options.threshold,
          this.audioCtx.currentTime,
          0.01,
        );
      if (options.knee !== undefined)
        this.compressor.knee.setTargetAtTime(options.knee, this.audioCtx.currentTime, 0.01);
      if (options.ratio !== undefined)
        this.compressor.ratio.setTargetAtTime(options.ratio, this.audioCtx.currentTime, 0.01);
      if (options.attack !== undefined)
        this.compressor.attack.setTargetAtTime(options.attack, this.audioCtx.currentTime, 0.01);
      if (options.release !== undefined)
        this.compressor.release.setTargetAtTime(options.release, this.audioCtx.currentTime, 0.01);
    }
  }

  /**
   * Resets the equalizer to flat response.
   */
  reset() {
    if (!this.audioCtx) {
      return;
    }
    const currentTime = this.audioCtx.currentTime;
    for (const band of this.eqFilterBands) {
      band.gain.setTargetAtTime(0, currentTime, 0.05);
    }
    this.bassBoostFilter?.gain.setTargetAtTime(0, currentTime, 0.05);
    this.settings = { ...DEFAULT_SETTINGS };
  }

  getSettings(): EqSettings {
    return { ...this.settings };
  }

  /**
   * Fully tears down the equalizer: disconnects every node, closes the
   * AudioContext and clears the singleton. A later `new Equalizer()` builds a
   * completely fresh graph, and the same media element may be connected to
   * that new context again.
   */
  destroy() {
    if (typeof document !== 'undefined' && document.body && this.resumeListener) {
      document.body.removeEventListener('click', this.resumeListener, false);
    }
    this.resumeListener = undefined;

    try {
      this.mediaSource?.disconnect();
      for (const band of this.eqFilterBands) {
        band.disconnect();
      }
      this.bassBoostFilter?.disconnect();
      this.compressor?.disconnect();
    } catch (error) {
      console.error('Error while disconnecting equalizer nodes:', error);
    }

    this.mediaSource = undefined;
    this.eqFilterBands = [];
    this.bassBoostFilter = undefined;
    this.compressor = undefined;

    const ctxToClose = this.audioCtx;
    this.audioCtx = undefined;
    this.audioCtxStatus = 'IDEAL';
    this.settings = { ...DEFAULT_SETTINGS };

    if (Equalizer._instance === this) {
      Equalizer._instance = undefined;
    }

    if (ctxToClose) {
      try {
        const result = ctxToClose.close();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((error) => {
            console.error('Error while closing AudioContext:', error);
          });
        }
      } catch (error) {
        console.error('Error while closing AudioContext:', error);
      }
    }
  }
}

export { Equalizer };
