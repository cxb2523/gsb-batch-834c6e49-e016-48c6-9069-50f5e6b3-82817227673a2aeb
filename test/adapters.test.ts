import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryDecisionAdapter } from '../src/InMemoryDecisionAdapter';
import { LocalStorageDecisionAdapter } from '../src/localStorageDecisionAdapter';
import { Decision } from '../src/types';

describe('InMemoryDecisionAdapter', () => {
  let adapter: InMemoryDecisionAdapter;

  beforeEach(() => {
    adapter = new InMemoryDecisionAdapter();
  });

  it('should save and retrieve decisions', async () => {
    const decision1: Decision = {
      cueId: 'cue1',
      choice: 'linear',
      timestamp: Date.now(),
      metadata: { reason: 'test' },
    };
    const decision2: Decision = {
      cueId: 'cue2',
      choice: 'nonlinear',
      timestamp: Date.now(),
      metadata: { reason: 'test' },
    };

    await adapter.saveDecision(decision1);
    await adapter.saveDecision(decision2);

    const history = await adapter.getDecisionHistory();
    expect(history).toEqual([decision1, decision2]);
  });

  it('should clear decision history', async () => {
    const decision: Decision = {
      cue: { id: 'cue1', startTime: 0, endTime: 10 },
      type: 'linear',
      time: 5,
      reason: 'test',
    };

    await adapter.saveDecision(decision);
    let history = await adapter.getDecisionHistory();
    expect(history).toEqual([decision]);

    await adapter.clearDecisionHistory();
    history = await adapter.getDecisionHistory();
    expect(history).toEqual([]);
  });

  it('should keep a single entry when the same decision is saved twice', async () => {
    const decision: Decision = {
      cueId: 'cue1',
      choice: '4',
      timestamp: 1,
      source: 'main',
      metadata: { source: 'main' },
    };
    const updated: Decision = { ...decision, choice: '5', timestamp: 2 };

    await adapter.saveDecision(decision);
    await adapter.saveDecision(decision);
    expect(await adapter.getDecisionHistory()).toHaveLength(1);

    // Re-answering the same cue in the same source replaces the entry.
    await adapter.saveDecision(updated);
    const history = await adapter.getDecisionHistory();
    expect(history).toHaveLength(1);
    expect(history[0].choice).toBe('5');
  });

  it('should keep main-video and segment decisions for the same cue separate', async () => {
    const mainDecision: Decision = {
      cueId: 'shared',
      choice: 'main-choice',
      timestamp: 1,
      source: 'main',
      metadata: { source: 'main' },
    };
    const segmentDecision: Decision = {
      cueId: 'shared',
      choice: 'segment-choice',
      timestamp: 2,
      source: 'segment',
      segmentUrl: 'segment.mp4',
      metadata: { source: 'segment', segmentUrl: 'segment.mp4' },
    };

    await adapter.saveDecision(mainDecision);
    await adapter.saveDecision(segmentDecision);

    const history = await adapter.getDecisionHistory();
    expect(history).toHaveLength(2);
    expect(history.map((d) => d.source)).toEqual(['main', 'segment']);
  });

  it('should not deduplicate decisions that cannot be identified', async () => {
    // Legacy decisions without a cue id have no stable identity.
    const legacyA = { choice: 'a', timestamp: 1 } as unknown as Decision;
    const legacyB = { choice: 'b', timestamp: 2 } as unknown as Decision;

    await adapter.saveDecision(legacyA);
    await adapter.saveDecision(legacyB);
    expect(await adapter.getDecisionHistory()).toHaveLength(2);
  });
});

describe('LocalStorageDecisionAdapter', () => {
  let adapter: LocalStorageDecisionAdapter;
  const MOCK_STORAGE_KEY = 'ivl_decision_history';
  let localStorageMock: { [key: string]: string };

  beforeEach(() => {
    localStorageMock = {};
    vi.stubGlobal('localStorage', {
      setItem: vi.fn((key, value) => {
        localStorageMock[key] = value;
      }),
      getItem: vi.fn((key) => localStorageMock[key] || null),
      removeItem: vi.fn((key) => {
        delete localStorageMock[key];
      }),
      clear: vi.fn(() => {
        localStorageMock = {};
      }),
    });
    adapter = new LocalStorageDecisionAdapter();
  });

  it('should save and retrieve decisions from local storage', async () => {
    const decision1: Decision = {
      cue: { id: 'cueA', startTime: 0, endTime: 10 },
      type: 'linear',
      time: 5,
      reason: 'test-ls',
    };
    const decision2: Decision = {
      cue: { id: 'cueB', startTime: 10, endTime: 20 },
      type: 'nonlinear',
      time: 15,
      reason: 'test-ls',
    };

    await adapter.saveDecision(decision1);
    expect(localStorage.setItem).toHaveBeenCalledWith(
      MOCK_STORAGE_KEY,
      JSON.stringify([decision1]),
    );

    await adapter.saveDecision(decision2);
    expect(localStorage.setItem).toHaveBeenCalledWith(
      MOCK_STORAGE_KEY,
      JSON.stringify([decision1, decision2]),
    );

    const history = await adapter.getDecisionHistory();
    expect(history).toEqual([decision1, decision2]);
    expect(localStorage.getItem).toHaveBeenCalledWith(MOCK_STORAGE_KEY);
  });

  it('should clear decision history in local storage', async () => {
    const decision: Decision = {
      cue: { id: 'cueC', startTime: 0, endTime: 10 },
      type: 'linear',
      time: 5,
      reason: 'test-ls-clear',
    };

    await adapter.saveDecision(decision);
    let history = await adapter.getDecisionHistory();
    expect(history).toEqual([decision]);

    await adapter.clearDecisionHistory();
    expect(localStorage.removeItem).toHaveBeenCalledWith(MOCK_STORAGE_KEY);
    history = await adapter.getDecisionHistory();
    expect(history).toEqual([]);
  });

  it('should return empty array if no history in local storage', async () => {
    vi.spyOn(localStorage, 'getItem').mockReturnValueOnce(null);
    const history = await adapter.getDecisionHistory();
    expect(history).toEqual([]);
  });

  it('should preserve the storage error when saving fails', async () => {
    const error = new Error('storage unavailable');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw error;
    });

    await expect(
      adapter.saveDecision({
        cue: { id: 'cueD', startTime: 0, endTime: 10 },
        type: 'linear',
        time: 5,
        reason: 'test-ls-error',
      }),
    ).rejects.toMatchObject({
      message: 'Decision storage failed',
      cause: error,
    });
  });

  it('should preserve the storage error when retrieving fails', async () => {
    const error = new Error('storage unavailable');
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw error;
    });

    await expect(adapter.getDecisionHistory()).rejects.toMatchObject({
      message: 'Decision retrieval failed',
      cause: error,
    });
  });

  it('should preserve the storage error when clearing fails', async () => {
    const error = new Error('storage unavailable');
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw error;
    });

    await expect(adapter.clearDecisionHistory()).rejects.toMatchObject({
      message: 'Failed to clear decision history',
      cause: error,
    });
  });

  it('should keep a single entry when the same decision is saved twice', async () => {
    const decision: Decision = {
      cueId: 'cue1',
      choice: '4',
      timestamp: 1,
      source: 'main',
      metadata: { source: 'main' },
    };

    await adapter.saveDecision(decision);
    await adapter.saveDecision(decision);

    const history = await adapter.getDecisionHistory();
    expect(history).toHaveLength(1);
  });

  it('should keep main-video and segment decisions for the same cue separate', async () => {
    await adapter.saveDecision({
      cueId: 'shared',
      choice: 'main-choice',
      timestamp: 1,
      source: 'main',
      metadata: { source: 'main' },
    });
    await adapter.saveDecision({
      cueId: 'shared',
      choice: 'segment-choice',
      timestamp: 2,
      source: 'segment',
      segmentUrl: 'segment.mp4',
      metadata: { source: 'segment', segmentUrl: 'segment.mp4' },
    });

    const history = await adapter.getDecisionHistory();
    expect(history).toHaveLength(2);
  });
});
