import { Equalizer } from 'adapters/equalizer';
import HlsAdapter, { type HlsConstructor } from 'adapters/hls';
import { AudioX } from 'audio';
import { presets } from 'constants/equalizer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type FakeAudioElement,
  type FakeBiquadFilterNode,
  FakeHls,
  createdAudioContexts,
  createdMediaElementSources,
  installAudioStubs,
  resetWebAudioFakes,
  uninstallAudioStubs,
} from './fakes';
import { HLS_A, MP3_A, MP3_B, flushMicrotasks } from './tracks';

const baseInit = {
  mode: 'VANILLA' as const,
  useDefaultEventListeners: false,
  enableHls: true,
  enableEQ: true,
};

describe('Equalizer', () => {
  let audio: AudioX;
  let element: FakeAudioElement;

  beforeEach(() => {
    installAudioStubs();
    resetWebAudioFakes();
    FakeHls.reset();
    HlsAdapter.reset();
    HlsAdapter.setHlsConstructor(FakeHls as unknown as HlsConstructor);
    audio = new AudioX();
    element = AudioX.getAudioInstance() as unknown as FakeAudioElement;
  });

  afterEach(async () => {
    await audio?.destroy();
    HlsAdapter.reset();
    FakeHls.reset();
    resetWebAudioFakes();
    uninstallAudioStubs();
  });

  it('creates exactly one AudioContext and one media element source on repeated attachEq', async () => {
    await audio.init({ ...baseInit });

    audio.attachEq();
    audio.attachEq();
    audio.attachEq();

    expect(createdAudioContexts).toHaveLength(1);
    expect(createdMediaElementSources).toHaveLength(1);
    expect(createdMediaElementSources[0].mediaElement).toBe(element);
    expect(Equalizer.getInstance()?.status()).toBe('ACTIVE');
  });

  it('never calls createMediaElementSource twice for the same element across source switches', async () => {
    await audio.init({ ...baseInit });
    audio.attachEq();

    await audio.addMedia(MP3_A);
    await audio.addMedia(MP3_B);
    await audio.addMedia(HLS_A);

    expect(createdMediaElementSources).toHaveLength(1);
    // The single source node still feeds the filter chain.
    const source = createdMediaElementSources[0];
    expect(source.connects).toHaveLength(1);
  });

  it('preset, custom gains and bass boost stay effective after source switches', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(MP3_A);
    audio.attachEq();
    const eq = Equalizer.getInstance()!;

    const rock = presets.find((preset) => preset.id === 'rock')!;
    audio.setPreset('rock');
    audio.setBassBoost(true, 8);

    await audio.addMedia(MP3_B);
    await audio.addMedia(HLS_A);

    const bands = (eq as any).eqFilterBands as FakeBiquadFilterNode[];
    bands.forEach((band, index) => {
      expect(band.gain.value).toBe(rock.gains[index]);
    });
    expect((eq as any).bassBoostFilter.gain.value).toBe(8);

    const customGains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    audio.setCustomEQ(customGains);
    await audio.addMedia(MP3_A);
    bands.forEach((band, index) => {
      expect(band.gain.value).toBe(customGains[index]);
    });
  });

  it('remembers settings configured before the graph exists and applies them on attachEq', async () => {
    await audio.init({ ...baseInit });

    audio.setPreset('pop');
    audio.setBassBoost(true, 5);
    audio.attachEq();

    const eq = Equalizer.getInstance()!;
    const pop = presets.find((preset) => preset.id === 'pop')!;
    const bands = (eq as any).eqFilterBands as FakeBiquadFilterNode[];
    bands.forEach((band, index) => {
      expect(band.gain.value).toBe(pop.gains[index]);
    });
    expect((eq as any).bassBoostFilter.gain.value).toBe(5);
  });

  it('degrades to passthrough without Web Audio and never blocks playback', async () => {
    Object.defineProperty(globalThis, 'AudioContext', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    await audio.init({ ...baseInit });

    expect(() => audio.attachEq()).not.toThrow();
    expect(Equalizer.getInstance()?.status()).toBe('FAILED');
    expect(createdAudioContexts).toHaveLength(0);

    await audio.addMedia(MP3_A);
    await audio.play();
    expect(element.paused).toBe(false);
    expect(element.src).toBe(MP3_A.source);
  });

  it('destroy closes the context, disconnects every node and clears the singleton', async () => {
    await audio.init({ ...baseInit });
    audio.attachEq();
    const context = createdAudioContexts[0];
    const eq = Equalizer.getInstance()!;
    // Capture the graph nodes before destroy() nulls the references.
    const bands = (eq as any).eqFilterBands as FakeBiquadFilterNode[];
    const compressor = (eq as any).compressor;
    const bassBoostFilter = (eq as any).bassBoostFilter;
    const source = (eq as any).mediaSource;

    await audio.destroy();

    expect(context.closed).toBe(true);
    expect(context.state).toBe('closed');
    expect(source.disconnects.length).toBeGreaterThan(0);
    for (const band of bands) {
      expect(band.disconnects.length).toBeGreaterThan(0);
    }
    expect(compressor.disconnects.length).toBeGreaterThan(0);
    expect(bassBoostFilter.disconnects.length).toBeGreaterThan(0);
    expect(Equalizer.getInstance()).toBeUndefined();
  });

  it('rebuilds a working player after destroy with no AudioContext leak', async () => {
    await audio.init({ ...baseInit });
    audio.attachEq();
    await audio.addMedia(MP3_A);
    audio.setPreset('rock');
    const firstContext = createdAudioContexts[0];

    await audio.destroy();
    expect(firstContext.closed).toBe(true);

    const rebuilt = new AudioX();
    const rebuiltElement = AudioX.getAudioInstance() as unknown as FakeAudioElement;
    await rebuilt.init({ ...baseInit });
    rebuilt.attachEq();
    await rebuilt.addMedia(MP3_B);
    await rebuilt.play();

    expect(createdAudioContexts).toHaveLength(2);
    expect(createdAudioContexts[1].closed).toBe(false);
    expect(rebuiltElement.paused).toBe(false);
    expect(rebuiltElement.src).toBe(MP3_B.source);
    // The new context can connect the media element afresh without throwing.
    expect(createdMediaElementSources).toHaveLength(2);

    await rebuilt.destroy();
    expect(createdAudioContexts.every((context) => context.closed)).toBe(true);
  });

  it('reconnects the same media element to a fresh context after EQ destroy + re-init', async () => {
    await audio.init({ ...baseInit });
    audio.attachEq();
    const firstSource = createdMediaElementSources[0];

    Equalizer.getInstance()!.destroy();
    expect(Equalizer.getInstance()).toBeUndefined();

    audio.attachEq();
    expect(createdAudioContexts).toHaveLength(2);
    expect(createdMediaElementSources).toHaveLength(2);
    expect(createdMediaElementSources[1]).not.toBe(firstSource);
    expect(createdMediaElementSources[1].mediaElement).toBe(element);
  });

  it('EQ remains active on HLS sources: graph stays connected through HLS takeover', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(MP3_A);
    audio.attachEq();
    audio.setPreset('techno');

    await audio.addMedia(HLS_A);
    await flushMicrotasks();

    const eq = Equalizer.getInstance()!;
    const techno = presets.find((preset) => preset.id === 'techno')!;
    const bands = (eq as any).eqFilterBands as FakeBiquadFilterNode[];
    bands.forEach((band, index) => {
      expect(band.gain.value).toBe(techno.gains[index]);
    });
    // Source -> band chain -> bass -> compressor -> destination stays intact.
    const compressor = (eq as any).compressor;
    expect(compressor.connects[0]).toBe(createdAudioContexts[0].destination);
    expect(FakeHls.instances).toHaveLength(1);
  });
});
