import HlsAdapter, { type HlsConstructor } from 'adapters/hls';
import { AudioX } from 'audio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeAudioElement, FakeHls, installAudioStubs, uninstallAudioStubs } from './fakes';
import { HLS_A, HLS_B, flushMicrotasks, track } from './tracks';

describe('HlsAdapter', () => {
  let audio: AudioX;

  beforeEach(() => {
    installAudioStubs();
    FakeHls.reset();
    HlsAdapter.reset();
    HlsAdapter.setHlsConstructor(FakeHls as unknown as HlsConstructor);
    audio = new AudioX();
  });

  afterEach(async () => {
    await audio?.destroy();
    HlsAdapter.reset();
    FakeHls.reset();
    uninstallAudioStubs();
    vi.restoreAllMocks();
  });

  it('initializes a single HLS engine from the injected constructor without network', async () => {
    const adapter = new HlsAdapter();
    const engine = await adapter.init(false, {});

    expect(engine).toBeInstanceOf(FakeHls);
    expect(FakeHls.instances).toHaveLength(1);
    expect(adapter.getHlsInstance()).toBe(engine);
  });

  it('reuses the same engine and instance across repeated init calls', async () => {
    const adapter = new HlsAdapter();

    const first = await adapter.init();
    const second = await adapter.init();

    expect(first).toBe(second);
    expect(FakeHls.instances).toHaveLength(1);
    expect(new HlsAdapter()).toBe(adapter);
  });

  it('switchSource detaches before loading the new source and re-attaching the media element', async () => {
    const adapter = new HlsAdapter();
    await adapter.init();
    const engine = adapter.getHlsInstance() as unknown as FakeHls;
    const element = AudioX.getAudioInstance() as unknown as FakeAudioElement;

    adapter.switchSource(HLS_A);
    adapter.switchSource(HLS_B);

    expect(engine.detachMediaCalls).toBe(2);
    expect(engine.loadSourceCalls).toEqual([HLS_A.source, HLS_B.source]);
    expect(engine.attachMediaCalls).toEqual([element, element]);
    // Detach must always precede the load for the same switch.
    expect(engine.detachMediaCalls).toBeGreaterThanOrEqual(engine.loadSourceCalls.length);
  });

  it('destroys the engine, removes listeners and releases the reference', async () => {
    const adapter = new HlsAdapter();
    const engine = (await adapter.init()) as unknown as FakeHls;

    adapter.destroy();

    expect(engine.destroyed).toBe(true);
    expect(engine.removeAllListenersCalls).toBe(1);
    expect(engine.detachMediaCalls).toBe(1);
    expect(adapter.getHlsInstance()).toBeUndefined();
  });

  it('a destroyed engine can be rebuilt by init and re-used', async () => {
    const adapter = new HlsAdapter();
    const first = (await adapter.init()) as unknown as FakeHls;
    adapter.destroy();

    const rebuilt = await adapter.init();

    expect(rebuilt).not.toBe(first);
    expect(FakeHls.instances).toHaveLength(2);
    expect(adapter.getHlsInstance()).toBe(rebuilt);
  });

  it('returns undefined when HLS is unsupported instead of throwing', async () => {
    FakeHls.isSupportedImpl = () => false;
    const adapter = new HlsAdapter();

    const engine = await adapter.init();

    expect(engine).toBeUndefined();
    expect(adapter.getHlsInstance()).toBeUndefined();
  });

  it('does not touch the document when a constructor is injected', async () => {
    const createSpy = vi.fn();
    (document as any).createElement = createSpy;
    const adapter = new HlsAdapter();
    await adapter.init();

    expect(createSpy).not.toHaveBeenCalled();
  });

  it('refuses to switch source without an initialized engine', () => {
    const adapter = new HlsAdapter();
    expect(adapter.switchSource(track('x', 'https://example.test/x.m3u8'))).toBeUndefined();
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('flushes the pending switch before the engine is attached', async () => {
    const adapter = new HlsAdapter();
    const pending = adapter.init();
    await flushMicrotasks();
    const engine = (await pending) as unknown as FakeHls;

    adapter.switchSource(HLS_A);
    expect(engine.loadSourceCalls).toEqual([HLS_A.source]);
  });
});
