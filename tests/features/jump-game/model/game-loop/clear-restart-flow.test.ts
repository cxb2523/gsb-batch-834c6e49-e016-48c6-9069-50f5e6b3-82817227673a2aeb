import { act, renderHook } from '@testing-library/react';
import { useGameLoop } from '@/features/jump-game/model/game-loop/useGameLoop';
import { ARM_APPEAR_DELAY_MS } from '@/features/jump-game/model/config/gameplay';
import { BOSS_CLEAR_ICON, BOSS_GAME_OVER_ICON } from '@/features/jump-game/model/config/assets';
import * as obstaclesModule from '@/features/jump-game/model/game-loop/obstacles';

vi.mock('@/shared/lib/window', () => ({
  isMobile: () => false,
}));

type RafHarness = {
  callbacks: FrameRequestCallback[];
  requestSpy: ReturnType<typeof vi.spyOn>;
  cancelSpy: ReturnType<typeof vi.spyOn>;
};

/**
 * Builds a controllable requestAnimationFrame harness so frames only advance
 * when the test pumps the clock explicitly.
 */
const installRafHarness = (): RafHarness => {
  const callbacks: FrameRequestCallback[] = [];
  const requestSpy = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
  const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return { callbacks, requestSpy, cancelSpy };
};

/** Executes the loop's next queued frame at the supplied mocked timestamp. */
const flushFrame = (
  harness: RafHarness,
  performanceNowSpy: ReturnType<typeof vi.spyOn>,
  atMs: number,
) => {
  const callback = harness.callbacks.shift();
  performanceNowSpy.mockReturnValue(atMs);
  act(() => {
    callback?.(atMs);
  });
};

const createDivRef = (): React.RefObject<HTMLDivElement | null> => ({
  current: document.createElement('div'),
});
const createImageRef = (): React.RefObject<HTMLImageElement | null> => ({
  current: document.createElement('img'),
});

const createGameRect = (): DOMRect =>
  ({
    left: 0,
    right: 1024,
    top: 0,
    bottom: 300,
    width: 1024,
    height: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

describe('useGameLoop clear/fault/restart flow (real arm FSM, mock clock + DOM)', () => {
  let performanceNowSpy: ReturnType<typeof vi.spyOn>;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;
  let harness: RafHarness;

  beforeEach(() => {
    performanceNowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    harness = installRafHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createRefs = () => {
    const bossRef = createDivRef();
    const bossSpriteRef = createImageRef();
    const bossArmRef = createDivRef();
    const gameRef = createDivRef();
    const playerRef = createDivRef();
    gameRef.current!.getBoundingClientRect = vi.fn(createGameRect);
    Object.defineProperty(gameRef.current, 'clientWidth', {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(gameRef.current, 'clientHeight', {
      configurable: true,
      value: 300,
    });
    playerRef.current!.getBoundingClientRect = vi.fn(
      () =>
        ({
          left: 40,
          right: 80,
          top: 260,
          bottom: 296,
          width: 40,
          height: 36,
        }) as DOMRect,
    );
    const obstaclesRef = { current: [] } as React.MutableRefObject<HTMLElement[]>;
    const startTimeRef = { current: null } as React.MutableRefObject<number | null>;
    return { bossRef, bossSpriteRef, bossArmRef, gameRef, playerRef, obstaclesRef, startTimeRef };
  };

  const baseSetters = () => ({
    setGameOver: vi.fn(),
    setTitle: vi.fn(),
    setShowBoss: vi.fn(),
    setGameOverIcon: vi.fn(),
  });

  it('waits for the in-flight arm attack to finish before settling the clear and blocks new attacks', () => {
    const refs = createRefs();
    const setters = baseSetters();
    const clearMovingEntitiesSpy = vi.spyOn(obstaclesModule, 'clearMovingEntities');
    const onRunSettled = vi.fn();
    const clearRequestedRef = { current: false } as React.MutableRefObject<boolean>;
    const bossPatternTwoActiveRef = { current: false } as React.MutableRefObject<boolean>;

    // Phase 1: a normal run segment long enough for the arm to leave idle and attack.
    const runStartEpochMs = 1_000;
    refs.startTimeRef.current = runStartEpochMs;
    dateNowSpy.mockReturnValue(runStartEpochMs);

    renderHook(() =>
      useGameLoop({
        gameOver: false,
        showBoss: true,
        clearRequestedRef,
        bossPatternTwoActiveRef,
        onRunSettled,
        ...refs,
        ...setters,
      }),
    );

    // Pump combat frames until the arm has visibly started an attack.
    let armStartedAttack = false;
    for (let frame = 0; frame < 240; frame += 1) {
      const frameAtMs = ARM_APPEAR_DELAY_MS + 16 + frame * 16;
      flushFrame(harness, performanceNowSpy, frameAtMs);
      if (parseFloat(refs.bossArmRef.current?.style.width ?? '0') > 0) {
        armStartedAttack = true;
        break;
      }
    }
    expect(armStartedAttack).toBe(true);
    expect(setters.setGameOver).not.toHaveBeenCalled();

    // Phase 2: the clear threshold is crossed while the attack is still in flight.
    dateNowSpy.mockReturnValue(runStartEpochMs + 61_000);
    let observedArmWidthDuringWait = 0;
    for (let frame = 0; frame < 400; frame += 1) {
      const frameAtMs = ARM_APPEAR_DELAY_MS + 16 + (240 + frame) * 16;
      flushFrame(harness, performanceNowSpy, frameAtMs);
      expect(clearRequestedRef.current).toBe(true);
      observedArmWidthDuringWait = Math.max(
        observedArmWidthDuringWait,
        parseFloat(refs.bossArmRef.current?.style.width ?? '0'),
      );
      if (setters.setGameOver.mock.calls.length > 0) break;
    }

    // The arm stayed active for at least part of the clear wait, then settled exactly once.
    expect(observedArmWidthDuringWait).toBeGreaterThan(0);
    expect(setters.setGameOver).toHaveBeenCalledTimes(1);
    expect(setters.setGameOver).toHaveBeenCalledWith(true);
    expect(setters.setGameOverIcon).toHaveBeenCalledWith(BOSS_CLEAR_ICON);
    expect(clearMovingEntitiesSpy).toHaveBeenCalled();
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    // Settle must leave the arm FSM at its idle baseline and the arm DOM collapsed.
    expect(refs.bossArmRef.current?.style.width).toBe('0px');
    expect(refs.obstaclesRef.current).toHaveLength(0);
  });

  it('settles immediately when the clear request is already active while the arm is idle', () => {
    const refs = createRefs();
    const setters = baseSetters();
    const onRunSettled = vi.fn();
    const clearRequestedRef = { current: true } as React.MutableRefObject<boolean>;
    const bossPatternTwoActiveRef = { current: false } as React.MutableRefObject<boolean>;
    dateNowSpy.mockReturnValue(1_000);

    renderHook(() =>
      useGameLoop({
        gameOver: false,
        showBoss: false,
        clearRequestedRef,
        bossPatternTwoActiveRef,
        onRunSettled,
        ...refs,
        ...setters,
      }),
    );

    // The mount-time reset effect clears the ref once; re-arm it before the first frame.
    clearRequestedRef.current = true;
    flushFrame(harness, performanceNowSpy, 0);

    expect(setters.setGameOver).toHaveBeenCalledWith(true);
    expect(setters.setGameOverIcon).toHaveBeenCalledWith(BOSS_CLEAR_ICON);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(harness.callbacks).toHaveLength(0);
  });

  it('clears entities and resets the arm FSM through the fault path', () => {
    const refs = createRefs();
    const setters = baseSetters();
    const onRunSettled = vi.fn();
    const clearRequestedRef = { current: false } as React.MutableRefObject<boolean>;
    const bossPatternTwoActiveRef = { current: false } as React.MutableRefObject<boolean>;

    // Spawn an obstacle already overlapping the player so the first frame is a fatal hit.
    const obstacle = document.createElement('img');
    obstacle.dataset.entityWidthPx = '40';
    obstacle.dataset.entityHeightPx = '40';
    obstacle.dataset.entityBottomPx = '0';
    obstacle.dataset.hitboxScale = '1';
    obstacle.dataset.gameOverIcon = BOSS_GAME_OVER_ICON;
    // Keep it inside the collision-proximity window and aligned over the player box.
    obstacle.dataset.spawnLeftPx = '50';
    obstacle.dataset.translateXPx = '0';
    Object.defineProperty(obstacle, 'getBoundingClientRect', {
      value: vi.fn(
        () =>
          ({
            left: 50,
            right: 90,
            top: 260,
            bottom: 300,
            width: 40,
            height: 40,
          }) as DOMRect,
      ),
    });
    refs.obstaclesRef.current = [obstacle];
    // Seed a start time so the first queued frame does not treat the run as brand new.
    refs.startTimeRef.current = 0;
    dateNowSpy.mockReturnValue(1_000);

    renderHook(() =>
      useGameLoop({
        gameOver: false,
        showBoss: false,
        clearRequestedRef,
        bossPatternTwoActiveRef,
        onRunSettled,
        ...refs,
        ...setters,
      }),
    );

    flushFrame(harness, performanceNowSpy, 0);

    expect(setters.setGameOver).toHaveBeenCalledWith(true);
    // Fault icon is taken from the obstacle's gameOverIcon dataset when the boss is hidden.
    expect(setters.setGameOverIcon).toHaveBeenCalledWith(BOSS_GAME_OVER_ICON);
    expect(refs.playerRef.current?.style.opacity).toBe('0');
    expect(refs.playerRef.current?.style.visibility).toBe('hidden');
    expect(refs.obstaclesRef.current).toHaveLength(0);
    expect(obstacle.isConnected).toBe(false);
    expect(onRunSettled).toHaveBeenCalledTimes(1);
    expect(refs.bossArmRef.current?.style.width).toBe('0px');
  });

  it('resets every shared flow flag, boss entry timer and arm FSM when gameOver flips back to false', () => {
    const refs = createRefs();
    const setters = baseSetters();
    const clearRequestedRef = { current: true } as React.MutableRefObject<boolean>;
    const bossPatternTwoActiveRef = { current: true } as React.MutableRefObject<boolean>;

    const { rerender } = renderHook(
      ({ gameOver, showBoss }) =>
        useGameLoop({
          gameOver,
          showBoss,
          clearRequestedRef,
          bossPatternTwoActiveRef,
          ...refs,
          ...setters,
        }),
      { initialProps: { gameOver: true, showBoss: true } },
    );

    // Simulate leftover end-of-run state from the previous match.
    refs.bossArmRef.current!.style.width = '120px';

    rerender({ gameOver: false, showBoss: false });

    // Shared flow flags and arm DOM must be back at their initial values immediately.
    expect(clearRequestedRef.current).toBe(false);
    expect(bossPatternTwoActiveRef.current).toBe(false);
    expect(refs.bossArmRef.current?.style.width).toBe('0px');

    // First frame of the new run with the boss hidden: the loop keeps scheduling frames.
    flushFrame(harness, performanceNowSpy, 16);
    expect(harness.callbacks).toHaveLength(1);

    // Boss becomes visible; its appearance delay must be measured from a fresh entry
    // timestamp rather than any timing baseline carried over from the previous run.
    rerender({ gameOver: false, showBoss: true });

    // A frame still inside the appearance delay keeps the arm collapsed (idle baseline).
    flushFrame(harness, performanceNowSpy, ARM_APPEAR_DELAY_MS - 100);
    expect(refs.bossArmRef.current?.style.width).toBe('0px');

    // Once combat starts, the FSM begins from IDLE with no retained attack window:
    // the first combat frame cannot already be extending an arm.
    flushFrame(harness, performanceNowSpy, ARM_APPEAR_DELAY_MS + 16);
    expect(parseFloat(refs.bossArmRef.current?.style.width ?? '0')).toBe(0);
    expect(refs.obstaclesRef.current).toHaveLength(0);
  });
});
