import { renderHook } from '@testing-library/react';
import {
  BOSS_PATTERN_TWO_ALLOWED_OBSTACLE_INDICES,
  BOSS_PATTERN_TWO_SPAWN_INTERVAL_FACTOR,
} from '@/features/jump-game/model/config/scene-spawn';
import {
  useFishSpawnScheduler,
  useObstacleSpawnScheduler,
} from '@/features/jump-game/model/game-scene/spawn';

const PATTERN_TWO_TEST_INTERVAL_MS = Math.floor(1_500 * BOSS_PATTERN_TWO_SPAWN_INTERVAL_FACTOR);

const createNumberRef = (initial: number): React.MutableRefObject<number> => ({
  current: initial,
});
const createBooleanRef = (initial: boolean): React.MutableRefObject<boolean> => ({
  current: initial,
});

describe('useFishSpawnScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses timeout scheduling instead of interval polling', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');

    renderHook(() =>
      useFishSpawnScheduler({
        gameOver: false,
        clearRequestedRef: createBooleanRef(false),
        startTimeRef: createNumberRef(Date.now()) as React.MutableRefObject<number | null>,
        fishSpawnTargetRef: createNumberRef(1),
        fishSpawnedRef: createNumberRef(0),
        nextFishSpawnAtMsRef: createNumberRef(Date.now() + 500),
        lastObstacleSpawnAtMsRef: createNumberRef(0),
        lastFishSpawnAtMsRef: createNumberRef(0),
        spawnFish: vi.fn(),
      }),
    );

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it('never spawns fish while the clear request is active', () => {
    vi.useFakeTimers();
    const spawnFish = vi.fn();
    const baseNow = 10_000;
    vi.setSystemTime(baseNow);

    renderHook(() =>
      useFishSpawnScheduler({
        gameOver: false,
        clearRequestedRef: createBooleanRef(true),
        startTimeRef: createNumberRef(baseNow - 1_000) as React.MutableRefObject<number | null>,
        fishSpawnTargetRef: createNumberRef(5),
        fishSpawnedRef: createNumberRef(0),
        // A due spawn time so the first tick would immediately spawn without the gate.
        nextFishSpawnAtMsRef: createNumberRef(baseNow - 100),
        lastObstacleSpawnAtMsRef: createNumberRef(0),
        lastFishSpawnAtMsRef: createNumberRef(0),
        spawnFish,
      }),
    );

    vi.advanceTimersByTime(5_000);

    expect(spawnFish).not.toHaveBeenCalled();
  });

  it('stops scheduling further fish once the clear flag flips during the wait', () => {
    vi.useFakeTimers();
    const spawnFish = vi.fn();
    const baseNow = 20_000;
    vi.setSystemTime(baseNow);
    const clearRequestedRef = createBooleanRef(false);

    renderHook(() =>
      useFishSpawnScheduler({
        gameOver: false,
        clearRequestedRef,
        startTimeRef: createNumberRef(baseNow - 1_000) as React.MutableRefObject<number | null>,
        fishSpawnTargetRef: createNumberRef(5),
        fishSpawnedRef: createNumberRef(1),
        nextFishSpawnAtMsRef: createNumberRef(baseNow + 300),
        lastObstacleSpawnAtMsRef: createNumberRef(0),
        lastFishSpawnAtMsRef: createNumberRef(0),
        spawnFish,
      }),
    );

    // The spawn becomes due, but the clear request takes effect before the timer fires.
    vi.setSystemTime(baseNow + 300);
    clearRequestedRef.current = true;
    vi.advanceTimersByTime(2_000);

    expect(spawnFish).not.toHaveBeenCalled();
  });
});

describe('useObstacleSpawnScheduler', () => {
  beforeEach(() => {
    // Deterministic roll so pattern-2 (rate 0.95) and normal (rate 1) ticks always spawn.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseSchedulerParams = {
    showBoss: false,
    bossPatternTwoActive: false,
    obstacleSpawnInterval: 1_500,
    normalSpawnRate: 1,
    lastObstacleSpawnAtMsRef: createNumberRef(0),
    lastFishSpawnAtMsRef: createNumberRef(0),
  };

  it('suppresses every obstacle spawn once the clear request is active', () => {
    vi.useFakeTimers();
    const spawnObstacle = vi.fn();
    vi.setSystemTime(5_000);

    renderHook(() =>
      useObstacleSpawnScheduler({
        ...baseSchedulerParams,
        gameOver: false,
        bossPatternTwoActiveRef: createBooleanRef(false),
        clearRequestedRef: createBooleanRef(true),
        spawnObstacle,
      }),
    );

    vi.advanceTimersByTime(10_000);

    expect(spawnObstacle).not.toHaveBeenCalled();
  });

  it('does not keep pattern-two interval spawning after the arm window closes', () => {
    vi.useFakeTimers();
    const spawnObstacle = vi.fn();
    vi.setSystemTime(7_000);
    const bossPatternTwoActiveRef = createBooleanRef(true);

    const { rerender } = renderHook(
      ({ bossPatternTwoActive }) =>
        useObstacleSpawnScheduler({
          ...baseSchedulerParams,
          gameOver: false,
          showBoss: true,
          bossPatternTwoActive,
          bossPatternTwoActiveRef,
          clearRequestedRef: createBooleanRef(false),
          spawnObstacle,
        }),
      { initialProps: { bossPatternTwoActive: true } },
    );

    // While the pattern-2 window is open, ticks spawn pattern-2 obstacles.
    vi.advanceTimersByTime(PATTERN_TWO_TEST_INTERVAL_MS);
    expect(spawnObstacle).toHaveBeenCalledTimes(1);
    expect(spawnObstacle).toHaveBeenLastCalledWith({
      allowedIconIndices: [...BOSS_PATTERN_TWO_ALLOWED_OBSTACLE_INDICES],
    });

    // The arm state machine closes the pattern-2 window (same ref the loop writes).
    bossPatternTwoActiveRef.current = false;
    rerender({ bossPatternTwoActive: false });
    spawnObstacle.mockClear();

    vi.advanceTimersByTime(PATTERN_TWO_TEST_INTERVAL_MS * 3);
    expect(spawnObstacle).not.toHaveBeenCalled();
  });

  it('reads the shared pattern-two ref so a stale state prop cannot open a spawn window', () => {
    vi.useFakeTimers();
    const spawnObstacle = vi.fn();
    vi.setSystemTime(9_000);

    renderHook(() =>
      useObstacleSpawnScheduler({
        ...baseSchedulerParams,
        gameOver: false,
        showBoss: true,
        // Prop lagging behind the rAF-driven ref: the ref is the source of truth.
        bossPatternTwoActive: true,
        bossPatternTwoActiveRef: createBooleanRef(false),
        clearRequestedRef: createBooleanRef(false),
        spawnObstacle,
      }),
    );

    vi.advanceTimersByTime(PATTERN_TWO_TEST_INTERVAL_MS * 2);

    expect(spawnObstacle).not.toHaveBeenCalled();
  });

  it('blocks pattern-two obstacle spawns during the clear wait even with the window open', () => {
    vi.useFakeTimers();
    const spawnObstacle = vi.fn();
    vi.setSystemTime(11_000);

    renderHook(() =>
      useObstacleSpawnScheduler({
        ...baseSchedulerParams,
        gameOver: false,
        showBoss: true,
        bossPatternTwoActive: true,
        bossPatternTwoActiveRef: createBooleanRef(true),
        clearRequestedRef: createBooleanRef(true),
        spawnObstacle,
      }),
    );

    vi.advanceTimersByTime(PATTERN_TWO_TEST_INTERVAL_MS * 3);

    expect(spawnObstacle).not.toHaveBeenCalled();
  });
});
