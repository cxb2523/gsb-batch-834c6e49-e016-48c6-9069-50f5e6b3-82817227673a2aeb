import type { PlaybackPosition } from '../player/BunnyStreamPlayer.types';
import type { ResumePositionStorage } from '../player/hooks/resumeStorage';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Platform } from 'react-native';

import { getPlaybackSpeeds } from '../player/playbackSpeeds';
import {
  cleanupExpiredResumePositions,
  clearAllResumePositions,
  clearResumePosition,
  exportResumePositions,
  getAllResumePositions,
  importResumePositions,
} from '../player/resumePositions';

jest.mock('../specs/NativeBunnyStreamPlayer', () => ({
  __esModule: true,
  default: {
    getAllSavedPositions: jest.fn(async () => '[]'),
    clearSavedPosition: jest.fn(async () => undefined),
    clearAllSavedPositions: jest.fn(async () => undefined),
    exportPositions: jest.fn(async () => '[]'),
    importPositions: jest.fn(async () => true),
    cleanupExpiredPositions: jest.fn(async () => undefined),
    getPlaybackSpeeds: jest.fn(async () => [0.5, 1.0, 2.0]),
  },
}));

const mockNativePlayer = (
  jest.requireMock('../specs/NativeBunnyStreamPlayer') as {
    default: {
      getAllSavedPositions: jest.MockedFunction<() => Promise<string>>;
      clearSavedPosition: jest.MockedFunction<(videoId: string) => Promise<void>>;
      clearAllSavedPositions: jest.MockedFunction<() => Promise<void>>;
      exportPositions: jest.MockedFunction<() => Promise<string>>;
      importPositions: jest.MockedFunction<(jsonData: string) => Promise<boolean>>;
      cleanupExpiredPositions: jest.MockedFunction<() => Promise<void>>;
      getPlaybackSpeeds: jest.MockedFunction<() => Promise<number[]>>;
    };
  }
).default;

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

const samplePosition: PlaybackPosition = {
  videoId: 'v1',
  positionMs: 60_000,
  durationMs: 120_000,
  watchPercentage: 0.5,
  timestamp: Date.now(),
  videoTitle: 'Demo',
};

describe('resume position management', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.clearAllMocks();
  });

  function setPlatform(os: 'ios' | 'android') {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  it('delegates getAllResumePositions to the native module on Android', async () => {
    setPlatform('android');
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce(
      JSON.stringify([
        { ...samplePosition, timestamp: Date.now() - 1000 },
        { ...samplePosition, videoId: 'v2', timestamp: Date.now() },
      ]),
    );
    const positions = await getAllResumePositions();
    expect(mockNativePlayer.getAllSavedPositions).toHaveBeenCalledTimes(1);
    // Newest first.
    expect(positions.map((p) => p.videoId)).toEqual(['v2', 'v1']);
  });

  it('returns [] on Android when the payload is malformed', async () => {
    setPlatform('android');
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce('not-json');
    expect(await getAllResumePositions()).toEqual([]);
  });

  it('delegates clear/clearAll/cleanup to the native module on Android', async () => {
    setPlatform('android');
    await clearResumePosition('v1');
    await clearAllResumePositions();
    await cleanupExpiredResumePositions();
    expect(mockNativePlayer.clearSavedPosition).toHaveBeenCalledWith('v1');
    expect(mockNativePlayer.clearAllSavedPositions).toHaveBeenCalledTimes(1);
    expect(mockNativePlayer.cleanupExpiredPositions).toHaveBeenCalledTimes(1);
  });

  it('exports normalized positions and imports them translated to SDK fields', async () => {
    setPlatform('android');
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce(JSON.stringify([samplePosition]));
    const exported = await exportResumePositions();
    const parsed = JSON.parse(exported) as PlaybackPosition[];
    expect(parsed[0]?.positionMs).toBe(60_000);

    const ok = await importResumePositions(exported);
    expect(ok).toBe(true);
    const sentJson = mockNativePlayer.importPositions.mock.calls[0]?.[0] as string;
    const sent = JSON.parse(sentJson) as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({
      videoId: 'v1',
      position: 60_000,
      duration: 120_000,
      videoTitle: 'Demo',
    });
    expect(sent[0]).not.toHaveProperty('positionMs');
  });

  it('rejects malformed import payloads on Android', async () => {
    setPlatform('android');
    expect(await importResumePositions('not-json')).toBe(false);
    expect(await importResumePositions('{"a":1}')).toBe(false);
    expect(mockNativePlayer.importPositions).not.toHaveBeenCalled();
  });

  it('uses storage on iOS for list/clear/export/import', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(samplePosition));

    const positions = await getAllResumePositions(storage);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.videoId).toBe('v1');
    expect(mockNativePlayer.getAllSavedPositions).not.toHaveBeenCalled();

    const exported = await exportResumePositions(storage);
    expect(JSON.parse(exported)).toHaveLength(1);

    await clearResumePosition('v1', storage);
    expect(await getAllResumePositions(storage)).toEqual([]);

    const ok = await importResumePositions(exported, storage);
    expect(ok).toBe(true);
    expect(await getAllResumePositions(storage)).toHaveLength(1);

    await clearAllResumePositions(storage);
    expect(await getAllResumePositions(storage)).toEqual([]);
  });

  it('iOS cleanup removes expired positions only', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const fresh = { ...samplePosition, videoId: 'fresh', timestamp: Date.now() };
    const stale = {
      ...samplePosition,
      videoId: 'stale',
      timestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
    };
    await storage.setItem('@bunny_resume_positions:fresh', JSON.stringify(fresh));
    await storage.setItem('@bunny_resume_positions:stale', JSON.stringify(stale));

    await cleanupExpiredResumePositions(storage, 7);
    const remaining = await getAllResumePositions(storage);
    expect(remaining.map((p) => p.videoId)).toEqual(['fresh']);
  });

  it('returns empty results on iOS without storage', async () => {
    setPlatform('ios');
    expect(await getAllResumePositions()).toEqual([]);
    expect(await exportResumePositions()).toBe('[]');
    expect(await importResumePositions('[]')).toBe(false);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('resume position migration (iOS storage)', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.clearAllMocks();
  });

  function setPlatform(os: 'ios' | 'android') {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  it('imports exported positions and keeps the newest timestamp per videoId', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    // Fresh local save for v1.
    const newer: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 90_000,
      durationMs: 120_000,
      watchPercentage: 0.75,
      timestamp: Date.now(),
    };
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(newer));

    // Export from another device (payload has an older v1 plus a fresh v2).
    const older: PlaybackPosition = { ...newer, positionMs: 10_000, timestamp: Date.now() - 5000 };
    const other: PlaybackPosition = {
      videoId: 'v2',
      positionMs: 30_000,
      durationMs: 60_000,
      watchPercentage: 0.5,
      timestamp: Date.now() - 1000,
    };
    const ok = await importResumePositions(JSON.stringify([older, other]), storage);
    expect(ok).toBe(true);

    const stored = await getAllResumePositions(storage);
    expect(stored.map((p) => p.videoId).sort()).toEqual(['v1', 'v2']);
    // The fresher local v1 wins over the stale imported one.
    expect(stored.find((p) => p.videoId === 'v1')?.positionMs).toBe(90_000);
  });

  it('accepts a newer imported entry over a stale local one', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const stale: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 20_000,
      durationMs: 120_000,
      watchPercentage: 0.16,
      timestamp: Date.now() - 2 * DAY_MS,
    };
    await storage.setItem('@bunny_resume_positions:v1', JSON.stringify(stale));

    const fresh: PlaybackPosition = { ...stale, positionMs: 80_000, timestamp: Date.now() };
    expect(await importResumePositions(JSON.stringify([fresh]), storage)).toBe(true);

    const stored = await getAllResumePositions(storage);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.positionMs).toBe(80_000);
  });

  it('keeps only the newest entry when a payload repeats a videoId', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const now = Date.now();
    const older: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 10_000,
      durationMs: 120_000,
      watchPercentage: 0.08,
      timestamp: now - 60_000,
    };
    const newer: PlaybackPosition = { ...older, positionMs: 70_000, timestamp: now };
    expect(await importResumePositions(JSON.stringify([older, newer, older]), storage)).toBe(true);

    const stored = await getAllResumePositions(storage);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.positionMs).toBe(70_000);
  });

  it('drops invalid entries but imports the valid remainder and returns true', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const valid: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 45_000,
      durationMs: 120_000,
      watchPercentage: 0.375,
      timestamp: Date.now(),
    };
    const payload = [
      valid,
      { ...valid, videoId: 'v2', positionMs: -1 }, // negative position
      { ...valid, videoId: '' }, // empty id
      { ...valid, videoId: 'v4', positionMs: 'x' }, // wrong type
      { ...valid, videoId: 'v5', timestamp: 0 }, // invalid timestamp
      null,
      'nope',
    ];
    expect(await importResumePositions(JSON.stringify(payload), storage)).toBe(true);

    const stored = await getAllResumePositions(storage);
    expect(stored.map((p) => p.videoId)).toEqual(['v1']);
    expect(stored[0]).toEqual(valid);
  });

  it('never stores or lists expired entries on import or list', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const expired: PlaybackPosition = {
      videoId: 'old',
      positionMs: 40_000,
      durationMs: 100_000,
      watchPercentage: 0.4,
      timestamp: Date.now() - 10 * DAY_MS,
    };
    expect(await importResumePositions(JSON.stringify([expired]), storage)).toBe(true);
    // Expired entry is not written.
    expect(storage.store.size).toBe(0);

    // A directly-written expired entry is hidden from the list.
    await storage.setItem('@bunny_resume_positions:old', JSON.stringify(expired));
    expect(await getAllResumePositions(storage)).toEqual([]);
    expect(JSON.parse(await exportResumePositions(storage))).toEqual([]);
  });

  it('normalizes exports to the public PlaybackPosition shape', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    // Stored payload carrying extra fields that are not part of the public shape.
    await storage.setItem(
      '@bunny_resume_positions:v1',
      JSON.stringify({
        videoId: 'v1',
        positionMs: 30_000,
        durationMs: 90_000,
        timestamp: Date.now(),
        extraField: 'ignored',
      }),
    );
    const exported = JSON.parse(await exportResumePositions(storage)) as PlaybackPosition[];
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      videoId: 'v1',
      positionMs: 30_000,
      durationMs: 90_000,
      watchPercentage: 30_000 / 90_000,
    });
    expect(exported[0]).not.toHaveProperty('extraField');
  });

  it('does not import legacy SDK-shaped (position/duration) entries', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    const ok = await importResumePositions(
      JSON.stringify([{ videoId: 'v1', position: 30_000, duration: 90_000, timestamp: Date.now() }]),
      storage,
    );
    // Array payload → succeeds, but the non-public shape is rejected.
    expect(ok).toBe(true);
    expect(storage.store.size).toBe(0);
  });

  it('rejects non-array import payloads without touching storage', async () => {
    setPlatform('ios');
    const storage = makeMemoryStorage();
    expect(await importResumePositions('not-json', storage)).toBe(false);
    expect(await importResumePositions('{"videoId":"v1"}', storage)).toBe(false);
    expect(storage.store.size).toBe(0);
  });
});

describe('resume position migration (Android native)', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
    jest.clearAllMocks();
  });

  function setPlatform(os: 'ios' | 'android') {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }

  it('translates valid entries to SDK fields, drops invalid/expired ones, returns true', async () => {
    setPlatform('android');
    const now = Date.now();
    const payload = [
      { videoId: 'v1', positionMs: 30_000, durationMs: 90_000, timestamp: now, videoTitle: 'A' },
      { videoId: 'v2', positionMs: -5, durationMs: 90_000, timestamp: now },
      { videoId: '', positionMs: 10_000, durationMs: 90_000, timestamp: now },
      { videoId: 'v4', positionMs: 10_000, durationMs: 90_000, timestamp: now - 10 * DAY_MS },
      { videoId: 'v5', positionMs: 5_000, timestamp: now }, // missing duration
    ];
    const existing: PlaybackPosition[] = [
      { videoId: 'v1', positionMs: 5_000, durationMs: 90_000, watchPercentage: 0.05, timestamp: now - 1000 },
    ];
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce(JSON.stringify(existing));

    expect(await importResumePositions(JSON.stringify(payload))).toBe(true);

    const sent = JSON.parse(
      mockNativePlayer.importPositions.mock.calls[0]?.[0] as string,
    ) as Array<Record<string, unknown>>;
    // Only the valid v1 remains; the imported (newer) v1 wins and is translated.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      videoId: 'v1',
      position: 30_000,
      duration: 90_000,
      videoTitle: 'A',
    });
    expect(sent[0]).not.toHaveProperty('positionMs');
  });

  it('keeps a fresher local position over a stale import', async () => {
    setPlatform('android');
    const now = Date.now();
    const existing: PlaybackPosition = {
      videoId: 'v1',
      positionMs: 80_000,
      durationMs: 90_000,
      watchPercentage: 0.88,
      timestamp: now,
    };
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce(JSON.stringify([existing]));

    await importResumePositions(
      JSON.stringify([{ videoId: 'v1', positionMs: 10_000, durationMs: 90_000, timestamp: now - 5000 }]),
    );
    const sent = JSON.parse(
      mockNativePlayer.importPositions.mock.calls[0]?.[0] as string,
    ) as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ videoId: 'v1', position: 80_000 });
  });

  it('hides expired entries from the Android list', async () => {
    setPlatform('android');
    const now = Date.now();
    mockNativePlayer.getAllSavedPositions.mockResolvedValueOnce(
      JSON.stringify([
        { videoId: 'fresh', positionMs: 10_000, durationMs: 90_000, timestamp: now },
        { videoId: 'stale', positionMs: 10_000, durationMs: 90_000, timestamp: now - 10 * DAY_MS },
      ]),
    );
    const positions = await getAllResumePositions();
    expect(positions.map((p) => p.videoId)).toEqual(['fresh']);
  });
});

describe('getPlaybackSpeeds', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
  });

  it('returns the native list on Android', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    expect(await getPlaybackSpeeds()).toEqual([0.5, 1.0, 2.0]);
    expect(mockNativePlayer.getPlaybackSpeeds).toHaveBeenCalledTimes(1);
  });

  it('returns the iOS fallback list without calling native', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    jest.clearAllMocks();
    const speeds = await getPlaybackSpeeds();
    expect(speeds).toEqual([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);
    expect(mockNativePlayer.getPlaybackSpeeds).not.toHaveBeenCalled();
  });
});
