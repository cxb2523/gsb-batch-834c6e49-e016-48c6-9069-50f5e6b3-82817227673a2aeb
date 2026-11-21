import HlsAdapter, { type HlsConstructor } from 'adapters/hls';
import { AudioX } from 'audio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeAudioElement, FakeHls, installAudioStubs, uninstallAudioStubs } from './fakes';
import { HLS_A, HLS_B, HLS_C, MP3_A, MP3_B, flushMicrotasks } from './tracks';

const baseInit = {
  mode: 'VANILLA' as const,
  useDefaultEventListeners: false,
  enableHls: true,
};

/**
 * Deferred holder for a slow HLS constructor: init() parks on the promise
 * until `resolve` is called, modeling a slow remote script load with no
 * network involved.
 */
function deferredConstructor() {
  let resolve: (value: HlsConstructor | undefined) => void = () => {};
  const promise = new Promise<HlsConstructor | undefined>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AudioX atomic source switching', () => {
  let audio: AudioX;
  let element: FakeAudioElement;

  beforeEach(() => {
    installAudioStubs();
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
    uninstallAudioStubs();
  });

  it('mp3 -> HLS attaches the HLS engine and leaves no plain src behind', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(MP3_A);
    expect(element.src).toBe(MP3_A.source);

    await audio.addMedia(HLS_A);

    const engine = FakeHls.instances[0];
    expect(FakeHls.instances).toHaveLength(1);
    expect(engine.detachMediaCalls).toBe(1);
    expect(engine.loadSourceCalls).toEqual([HLS_A.source]);
    expect(engine.attachMediaCalls).toEqual([element]);
    expect(element.src).toBe('');
    expect(element.srcObject).toBeNull();
  });

  it('uses native HLS playback (direct src) when the browser can play the playlist', async () => {
    element.canPlayType = (type: string) =>
      type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
    await audio.init({ ...baseInit });

    await audio.addMedia(HLS_A);

    // The MSE engine is never attached; the URL is assigned straight to the
    // element and no source is ever loaded through hls.js.
    const engine = FakeHls.instances[0];
    expect(engine.attachMediaCalls).toHaveLength(0);
    expect(engine.loadSourceCalls).toHaveLength(0);
    expect(HlsAdapter.getAdapterInstance()?.isMediaAttached()).toBe(false);
    expect(element.src).toBe(HLS_A.source);
  });

  it('HLS -> mp3 destroys the HLS engine and clears the media element source slots', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(HLS_A);
    const engine = FakeHls.instances[0];

    await audio.addMedia(MP3_A);

    expect(engine.destroyed).toBe(true);
    expect(engine.removeAllListenersCalls).toBe(1);
    expect(HlsAdapter.getAdapterInstance()?.getHlsInstance()).toBeUndefined();
    expect(element.srcObject).toBeNull();
    expect(element.src).toBe(MP3_A.source);
  });

  it('HLS -> HLS reuses the same engine instance and only switches its source', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(HLS_A);
    await audio.addMedia(HLS_B);
    await audio.addMedia(HLS_C);

    expect(FakeHls.instances).toHaveLength(1);
    const engine = FakeHls.instances[0];
    expect(engine.loadSourceCalls).toEqual([HLS_A.source, HLS_B.source, HLS_C.source]);
    expect(engine.detachMediaCalls).toBe(3);
    expect(engine.attachMediaCalls).toHaveLength(3);
    expect(engine.destroyed).toBe(false);
  });

  it('mp3 -> HLS -> mp3 leaves no residual HLS instance and the final src is the mp3', async () => {
    await audio.init({ ...baseInit });

    await audio.addMedia(MP3_A);
    await audio.addMedia(HLS_A);
    await audio.addMedia(MP3_B);

    expect(FakeHls.instances[0].destroyed).toBe(true);
    expect(FakeHls.instances.every((instance) => instance.destroyed)).toBe(true);
    expect(element.src).toBe(MP3_B.source);
    expect(element.srcObject).toBeNull();
  });

  it('rapid HLS -> mp3 -> HLS switches keep only the last source when the first init is slow', async () => {
    // Do NOT init HLS eagerly; the first addMedia(HLS) triggers a slow init.
    await audio.init({ ...baseInit, enableHls: false });

    const slow = deferredConstructor();
    HlsAdapter.setPendingHlsConstructor(slow.promise);

    const first = audio.addMedia(HLS_A);
    const second = audio.addMedia(MP3_A);
    await second;
    await flushMicrotasks();
    // The mp3 switch has settled: it owns the element while the slow HLS
    // initialization is still pending.
    expect(FakeHls.instances).toHaveLength(0);
    expect(element.src).toBe(MP3_A.source);

    const third = audio.addMedia(HLS_B);

    slow.resolve(FakeHls as unknown as HlsConstructor);
    await Promise.all([first, third]);
    await flushMicrotasks();

    // Exactly one engine, bound to the last requested source only.
    expect(FakeHls.instances).toHaveLength(1);
    const engine = FakeHls.instances[0];
    expect(engine.destroyed).toBe(false);
    expect(engine.loadSourceCalls).toEqual([HLS_B.source]);
    expect(engine.attachMediaCalls).toEqual([element]);
    expect(element.src).toBe('');
    expect(element.srcObject).toBeNull();
  });

  it('a slow first HLS load cannot overwrite the final mp3 source', async () => {
    await audio.init({ ...baseInit, enableHls: false });

    const slow = deferredConstructor();
    HlsAdapter.setPendingHlsConstructor(slow.promise);

    const staleHls = audio.addMedia(HLS_A);
    await audio.addMedia(MP3_A);
    await flushMicrotasks();

    expect(element.src).toBe(MP3_A.source);
    slow.resolve(FakeHls as unknown as HlsConstructor);
    await staleHls;
    await flushMicrotasks();

    // The obsolete continuation never attached an engine or touched src.
    expect(FakeHls.instances).toHaveLength(0);
    expect(element.src).toBe(MP3_A.source);
    expect(element.srcObject).toBeNull();
  });

  it('events emitted by a destroyed HLS engine cannot reach the live engine', async () => {
    await audio.init({ ...baseInit });
    await audio.addMedia(HLS_A);
    const oldEngine = FakeHls.instances[0];

    await audio.addMedia(MP3_A);
    await audio.addMedia(HLS_B);
    const newEngine = FakeHls.instances[1];

    // The old engine's listener table was wiped, so any late event it emits
    // cannot invoke callbacks registered on the new pipeline.
    expect(oldEngine.destroyed).toBe(true);
    expect(oldEngine.removeAllListenersCalls).toBe(1);
    expect(() => oldEngine.emit('hlsError', { type: 'networkError' })).not.toThrow();
    expect(newEngine.destroyed).toBe(false);
    expect(newEngine.loadSourceCalls).toEqual([HLS_B.source]);
  });

  it('reports TRACK_CHANGE only for the latest switch', async () => {
    await audio.init({ ...baseInit, enableHls: false });
    const reported: string[] = [];
    audio.subscribe('AUDIO_STATE', (state: any) => {
      if (state.playbackState === 'trackchanged' && state.currentTrack) {
        reported.push(state.currentTrack.id);
      }
    });

    const slow = deferredConstructor();
    HlsAdapter.setPendingHlsConstructor(slow.promise);

    const first = audio.addMedia(HLS_A);
    const last = audio.addMedia(HLS_B);
    slow.resolve(FakeHls as unknown as HlsConstructor);
    await Promise.all([first, last]);

    expect(reported).toEqual([HLS_B.id]);
  });
});
