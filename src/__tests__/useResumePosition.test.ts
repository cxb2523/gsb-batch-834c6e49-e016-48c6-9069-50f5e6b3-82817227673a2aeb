import type { BunnyVodPlayerRef, PlaybackPosition } from '../player/BunnyStreamPlayer.types';
import type * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';
import * as ReactRuntime from 'react';
import { Platform } from 'react-native';
import { createRoot } from 'test-renderer';

import { useResumePosition, type ResumePositionStorage } from '../player/hooks/useResumePosition';

function makeMemoryStorage(): ResumePositionStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
    getAllKeys: async () => Array.from(store.keys()),
  };
}

function makeFakeRef(): React.RefObject<BunnyVodPlayerRef | null> {
  const seekTo = jest.fn();
  const ref = { current: { seekTo } as unknown as BunnyVodPlayerRef };
  return ref as React.RefObject<BunnyVodPlayerRef | null>;
}

describe('useResumePosition', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
  });

  function setPlatform(os: 'ios' | 'android') {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  it('is a no-op on Android (native SDK handles resume)', async () => {
    setPlatform('android');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
      }),
    );
    await act(async () => {
      await result.current.savePosition(60_000, 120_000);
    });
    expect(storage.store.size).toBe(0);
    expect(result.current.restoredPosition).toBeNull();
  });

  it('restores a saved position on iOS and seeks the player', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const position: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 45_000,
      durationMs: 120_000,
      watchPercentage: 0.375,
      timestamp: Date.now(),
      videoTitle: 'Test',
    };
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(position));
    const playerRef = makeFakeRef();
    await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
      }),
    );
    // Wait for the async restore effect to flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playerRef.current?.seekTo).toHaveBeenCalledWith(45_000);
  });

  it('does not re-fire onPositionAvailable when the callback identity changes', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const position: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 45_000,
      durationMs: 120_000,
      watchPercentage: 0.375,
      timestamp: Date.now(),
    };
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(position));
    const playerRef = makeFakeRef();
    const onPositionAvailable = jest.fn(() => false);
    // Mimics the PlayerScreen usage: an inline callback gets a new identity
    // on every render. The restore effect must not re-run because of it.
    const { rerender } = await renderHook(
      ({ cb }: { cb: (pos: PlaybackPosition) => boolean }) =>
        useResumePosition({
          playerRef,
          videoId: 'v1',
          storage,
          onPositionAvailable: cb,
        }),
      { initialProps: { cb: onPositionAvailable } },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onPositionAvailable).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ cb: jest.fn(() => false) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onPositionAvailable).toHaveBeenCalledTimes(1);
  });

  it('does not save positions below minimumWatchMs', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { minimumWatchMs: 30_000 },
      }),
    );
    await act(async () => {
      await result.current.savePosition(10_000, 120_000);
    });
    expect(storage.store.size).toBe(0);
  });

  it('does not save positions near the end (nearEndThreshold)', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { nearEndThreshold: 0.9 },
      }),
    );
    await act(async () => {
      await result.current.savePosition(115_000, 120_000);
    });
    expect(storage.store.size).toBe(0);
  });

  it('saves a valid position and retrieves it via getAllPositions', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        videoTitle: 'My Video',
        storage,
      }),
    );
    await act(async () => {
      await result.current.savePosition(60_000, 120_000);
    });
    expect(storage.store.size).toBe(1);
    const positions = await result.current.getAllPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.videoId).toBe('v1');
    expect(positions[0]?.videoTitle).toBe('My Video');
  });

  it('clears a single position', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
      }),
    );
    await act(async () => {
      await result.current.savePosition(60_000, 120_000);
    });
    expect(storage.store.size).toBe(1);
    await act(async () => {
      await result.current.clearPosition();
    });
    expect(storage.store.size).toBe(0);
  });

  it('clears all positions', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
      }),
    );
    await act(async () => {
      await result.current.savePosition(60_000, 120_000);
      await storage.setItem(
        '@bunny_resume_positions:v2',
        JSON.stringify({
          videoId: 'v2',
          positionMs: 30_000,
          durationMs: 90_000,
          watchPercentage: 0.33,
          timestamp: Date.now(),
        }),
      );
    });
    expect(storage.store.size).toBe(2);
    await act(async () => {
      await result.current.clearAllPositions();
    });
    expect(storage.store.size).toBe(0);
  });

  it('ignores expired positions on restore', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const expiredPosition: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 45_000,
      durationMs: 120_000,
      watchPercentage: 0.375,
      timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    };
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(expiredPosition));
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { retentionDays: 7 },
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playerRef.current?.seekTo).not.toHaveBeenCalled();
    expect(result.current.restoredPosition).toBeNull();
    // Expired position should have been removed.
    expect(storage.store.size).toBe(0);
  });
});

function makePosition(overrides: Partial<PlaybackPosition> = {}): PlaybackPosition {
  return {
    videoId: 'v1',
    positionMs: 45_000,
    durationMs: 120_000,
    watchPercentage: 0.375,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Storage whose `getItem` resolves only when the test calls `resolve()`. */
function makeDeferredStorage(): ResumePositionStorage & {
  store: Map<string, string>;
  resolve: () => void;
} {
  const base = makeMemoryStorage();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ...base,
    getItem: async (key) => {
      await gate;
      return base.getItem(key);
    },
    resolve: () => release?.(),
  };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Renders a hook without `@testing-library/react-native`'s auto-cleanup, so
 * tests can mount several independent hook instances (multiple playback
 * sessions) and assert on each one's own result.
 */
async function renderHarness<T>(useHook: () => T) {
  const result: { current: T | null } = { current: null };
  function Harness() {
    result.current = useHook();
    return null;
  }
  const renderer = createRoot();
  await act(async () => {
    renderer.render(ReactRuntime.createElement(Harness));
  });
  return {
    result: result as { current: T },
    rerender: async () => {
      await act(async () => {
        renderer.render(ReactRuntime.createElement(Harness));
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
}

describe('useResumePosition restore readiness and race handling', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.restoreAllMocks();
  });

  function setPlatform(os: 'ios' | 'android') {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  it('does not seek until the player reports ready, then seeks the restored position', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(makePosition()));
    const playerRef = makeFakeRef();

    const { result, rerender } = await renderHook(
      ({ ready }: { ready: boolean }) =>
        useResumePosition({ playerRef, videoId: 'v1', storage, isReady: ready }),
      { initialProps: { ready: false } },
    );
    await flush();
    // Position restored, but no seek while not ready.
    expect(result.current.restoredPosition?.positionMs).toBe(45_000);
    expect(playerRef.current?.seekTo).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ ready: true });
    });
    expect(playerRef.current?.seekTo).toHaveBeenCalledTimes(1);
    expect(playerRef.current?.seekTo).toHaveBeenCalledWith(45_000);

    // A later re-render must not seek a second time.
    await act(async () => {
      rerender({ ready: true });
    });
    expect(playerRef.current?.seekTo).toHaveBeenCalledTimes(1);
  });

  it('drops a restore that resolves after the video was switched', async () => {
    setPlatform('ios');
    const storage = makeDeferredStorage();
    await storage.store.set('@bunny_resume_positions:v1', JSON.stringify(makePosition()));
    await storage.store.set(
      '@bunny_resume_positions:v2',
      JSON.stringify(makePosition({ videoId: 'v2', positionMs: 12_000 })),
    );
    const playerRef = makeFakeRef();

    const { rerender } = await renderHook(
      ({ videoId }: { videoId: string }) =>
        useResumePosition({ playerRef, videoId, storage, isReady: true }),
      { initialProps: { videoId: 'v1' } },
    );

    // Switch to v2 before the v1 read resolves.
    await act(async () => {
      rerender({ videoId: 'v2' });
    });

    await act(async () => {
      storage.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Only v2's position may ever be sought; v1's late result is discarded.
    const seeks = (playerRef.current?.seekTo as jest.Mock).mock.calls.map((c) => c[0]);
    expect(seeks).toEqual([12_000]);
  });

  it('does not seek after unmount', async () => {
    setPlatform('ios');
    const storage = makeDeferredStorage();
    await storage.store.set('@bunny_resume_positions:v1', JSON.stringify(makePosition()));
    const playerRef = makeFakeRef();

    const { unmount } = await renderHook(() =>
      useResumePosition({ playerRef, videoId: 'v1', storage, isReady: true }),
    );
    await unmount();

    await act(async () => {
      storage.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(playerRef.current?.seekTo).not.toHaveBeenCalled();
  });

  it('reloads and restores the new video when videoId changes (no stale state)', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    await storage.setItem(
      '@bunny_resume_positions:v2',
      JSON.stringify(makePosition({ videoId: 'v2', positionMs: 20_000 })),
    );
    const playerRef = makeFakeRef();
    const { result, rerender } = await renderHook(
      ({ videoId }: { videoId: string }) =>
        useResumePosition({ playerRef, videoId, storage, isReady: true }),
      { initialProps: { videoId: 'v1' } },
    );
    await flush();
    expect(result.current.restoredPosition).toBeNull();

    await act(async () => {
      rerender({ videoId: 'v2' });
    });
    await flush();
    expect(result.current.restoredPosition?.videoId).toBe('v2');
    expect(playerRef.current?.seekTo).toHaveBeenCalledWith(20_000);
  });
});

describe('useResumePosition auto-save throttling', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.restoreAllMocks();
  });

  it('throttles auto-saves by saveIntervalMs but lets a manual save through', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { saveIntervalMs: 10_000, enableAutoSave: true },
      }),
    );

    await act(async () => {
      await result.current.savePosition(50_000, 120_000); // first auto-save
    });
    expect(storage.store.size).toBe(1);
    const firstTimestamp = JSON.parse(storage.store.get('@bunny_resume_positions:v1')!).timestamp;
    expect(firstTimestamp).toBe(1_000_000);

    // Second auto-save inside the window is throttled.
    now += 3_000;
    await act(async () => {
      await result.current.savePosition(55_000, 120_000);
    });
    expect(JSON.parse(storage.store.get('@bunny_resume_positions:v1')!).positionMs).toBe(50_000);

    // Manual save bypasses the throttle.
    now += 1_000;
    await act(async () => {
      await result.current.savePosition(60_000, 120_000, { manual: true });
    });
    const saved = JSON.parse(storage.store.get('@bunny_resume_positions:v1')!);
    expect(saved.positionMs).toBe(60_000);
    expect(saved.timestamp).toBe(1_004_000);

    // Auto-save in the window after the manual save is still throttled, and
    // its clock starts from the manual save.
    now += 2_000;
    await act(async () => {
      await result.current.savePosition(65_000, 120_000);
    });
    expect(JSON.parse(storage.store.get('@bunny_resume_positions:v1')!).positionMs).toBe(60_000);

    now += 10_000;
    await act(async () => {
      await result.current.savePosition(70_000, 120_000);
    });
    expect(JSON.parse(storage.store.get('@bunny_resume_positions:v1')!).positionMs).toBe(70_000);
  });

  it('does not auto-save at all when enableAutoSave is false', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { enableAutoSave: false },
      }),
    );
    await act(async () => {
      await result.current.savePosition(50_000, 120_000);
    });
    expect(storage.store.size).toBe(0);
    // Manual saves still work.
    await act(async () => {
      await result.current.savePosition(50_000, 120_000, { manual: true });
    });
    expect(storage.store.size).toBe(1);
  });
});

describe('useResumePosition clear-then-auto-save', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    // Control the clock so a save that clears the throttle window is still
    // suppressed only by the post-clear guard.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.useRealTimers();
  });

  async function mount() {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    const { result } = await renderHook(() =>
      useResumePosition({
        playerRef,
        videoId: 'v1',
        storage,
        config: { saveIntervalMs: 10_000 },
      }),
    );
    return { storage, playerRef, result };
  }

  it('does not let a later auto-save recreate progress after clearAllPositions', async () => {
    const { storage, result } = await mount();
    await act(async () => {
      await result.current.savePosition(50_000, 120_000);
    });
    expect(storage.store.size).toBe(1);

    await act(async () => {
      await result.current.clearAllPositions();
    });
    expect(storage.store.size).toBe(0);

    // A progress tick arrives after the clear (well past the throttle window,
    // so only the clear-suppression can stop it) — must not write back.
    await act(async () => {
      jest.setSystemTime(Date.now() + 60_000);
    });
    await act(async () => {
      await result.current.savePosition(55_000, 120_000);
    });
    expect(storage.store.size).toBe(0);

    // A manual save is an explicit action and resumes tracking.
    await act(async () => {
      await result.current.savePosition(60_000, 120_000, { manual: true });
    });
    expect(storage.store.size).toBe(1);
  });

  it('does not let an auto-save recreate a single cleared position', async () => {
    const { storage, result } = await mount();
    await act(async () => {
      await result.current.savePosition(50_000, 120_000);
    });
    await act(async () => {
      await result.current.clearPosition();
    });
    expect(storage.store.size).toBe(0);

    await act(async () => {
      jest.setSystemTime(Date.now() + 60_000);
    });
    await act(async () => {
      await result.current.savePosition(55_000, 120_000);
    });
    expect(storage.store.size).toBe(0);
  });

  it('suppresses auto-save in another live session after clearAllPositions', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const storage = makeMemoryStorage();
    const playerRef = makeFakeRef();
    // Two sessions (e.g. player + resume-management screen) share storage.
    const sessionA = await renderHarness(() =>
      useResumePosition({ playerRef, videoId: 'v1', storage }),
    );
    const sessionB = await renderHarness(() =>
      useResumePosition({ playerRef, videoId: 'v1', storage }),
    );
    await act(async () => {
      await sessionB.result.current.savePosition(50_000, 120_000);
    });
    expect(storage.store.size).toBe(1);

    await act(async () => {
      await sessionA.result.current.clearAllPositions();
    });
    expect(storage.store.size).toBe(0);

    // Session B's next auto-save must honour the clear issued elsewhere.
    await act(async () => {
      await sessionB.result.current.savePosition(55_000, 120_000);
    });
    expect(storage.store.size).toBe(0);

    await sessionB.unmount();
    await sessionA.unmount();
  });
});
