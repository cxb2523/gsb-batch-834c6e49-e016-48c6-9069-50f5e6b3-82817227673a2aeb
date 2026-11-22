import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CueHandler, CueCallback } from '../src/cueHandler';
import { CuePoint } from '../src/types';

describe('CueHandler', () => {
  let videoElement: HTMLVideoElement;
  let cueHandler: CueHandler;
  let mockCallback: CueCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    videoElement = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      currentTime: 0,
    } as unknown as HTMLVideoElement;

    cueHandler = new CueHandler(videoElement);
    mockCallback = vi.fn();
    cueHandler.onCue(mockCallback);
  });

  it('should register cues and sort them by time', () => {
    const cues: CuePoint[] = [
      { id: 'cue2', time: 10 },
      { id: 'cue1', time: 5 },
      { id: 'cue3', time: 2 },
    ];
    cueHandler.registerCues(cues);

    // @ts-ignore - Accessing private property for testing
    expect(cueHandler.cues).toEqual([
      { id: 'cue3', time: 2 },
      { id: 'cue1', time: 5 },
      { id: 'cue2', time: 10 },
    ]);
    // @ts-ignore
    expect(cueHandler.triggered.size).toBe(0);
  });

  it('should add timeupdate listener on start', () => {
    cueHandler.start();
    expect(videoElement.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
  });

  it('should remove timeupdate listener on stop', () => {
    cueHandler.stop();
    expect(videoElement.removeEventListener).toHaveBeenCalledWith(
      'timeupdate',
      expect.any(Function),
    );
  });

  it('should trigger cues at the correct time', () => {
    const cues: CuePoint[] = [
      { id: 'cue1', time: 5 },
      { id: 'cue2', time: 10 },
    ];
    cueHandler.registerCues(cues);

    // Simulate time update to 4 seconds
    Object.defineProperty(videoElement, 'currentTime', { value: 4 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).not.toHaveBeenCalled();

    // Simulate time update to 5 seconds (cue1 should trigger)
    Object.defineProperty(videoElement, 'currentTime', { value: 5 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledWith(cues[0]);

    // Simulate time update to 7 seconds (no new cue)
    Object.defineProperty(videoElement, 'currentTime', { value: 7 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).toHaveBeenCalledTimes(1); // Still 1

    // Simulate time update to 10 seconds (cue2 should trigger)
    Object.defineProperty(videoElement, 'currentTime', { value: 10 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).toHaveBeenCalledTimes(2);
    expect(mockCallback).toHaveBeenCalledWith(cues[1]);
  });

  it('should not trigger the same cue multiple times', () => {
    const cues: CuePoint[] = [{ id: 'cue1', time: 5 }];
    cueHandler.registerCues(cues);

    Object.defineProperty(videoElement, 'currentTime', { value: 5 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).toHaveBeenCalledTimes(1);

    Object.defineProperty(videoElement, 'currentTime', { value: 6 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    expect(mockCallback).toHaveBeenCalledTimes(1); // Should not be called again
  });

  it('should clear triggered cues on destroy', () => {
    const cues: CuePoint[] = [{ id: 'cue1', time: 5 }];
    cueHandler.registerCues(cues);

    Object.defineProperty(videoElement, 'currentTime', { value: 5 });
    // @ts-ignore
    cueHandler.handleTimeUpdate();
    // @ts-ignore
    expect(cueHandler.triggered.size).toBe(1);

    cueHandler.destroy();
    // @ts-ignore
    expect(cueHandler.triggered.size).toBe(0);
  });

  it('should call loadCues correctly', () => {
    const cues: CuePoint[] = [{ id: 'cue1', time: 5 }];
    const registerCuesSpy = vi.spyOn(cueHandler, 'registerCues');
    cueHandler.loadCues(cues);
    expect(registerCuesSpy).toHaveBeenCalledWith(cues);
    expect(videoElement.addEventListener).toHaveBeenCalledWith('timeupdate', expect.any(Function));
  });

  describe('suspension (branch segments)', () => {
    const setTime = (time: number) => {
      Object.defineProperty(videoElement, 'currentTime', { value: time, configurable: true });
    };

    it('should not trigger cues while suspended', () => {
      cueHandler.registerCues([
        { id: 'cue1', time: 5 },
        { id: 'cue2', time: 10 },
      ]);

      setTime(5);
      // @ts-ignore - invoking private handler directly
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);

      cueHandler.suspend();
      expect(cueHandler.isSuspended()).toBe(true);

      setTime(10);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should not re-trigger the cue that started the branch after resuming', () => {
      cueHandler.registerCues([
        { id: 'cue1', time: 5 },
        { id: 'cue2', time: 10 },
      ]);

      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();

      cueHandler.suspend();
      cueHandler.resume();
      expect(cueHandler.isSuspended()).toBe(false);

      // Replaying the same position (e.g. restored main video) must not fire
      // the cue again, but a later cue still fires once.
      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);

      setTime(10);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(2);
    });

    it('should treat cues with the same time but different ids independently', () => {
      cueHandler.registerCues([
        { id: 'a', time: 5 },
        { id: 'b', time: 5 },
      ]);

      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(2);
    });

    it('should keep triggered state when cues are updated with the same ids', () => {
      cueHandler.registerCues([{ id: 'cue1', time: 5 }]);
      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);

      // Subtitle-derived cue times are re-resolved after the source switch.
      cueHandler.updateCues([{ id: 'cue1', time: 7 }], { preserveTriggered: true });

      setTime(7);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should forget triggered state when updateCues is told not to preserve it', () => {
      cueHandler.registerCues([{ id: 'cue1', time: 5 }]);
      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);

      cueHandler.updateCues([{ id: 'cue1', time: 5 }], { preserveTriggered: false });

      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(2);
    });

    it('should mark a cue as triggered without invoking the callback', () => {
      const cue: CuePoint = { id: 'cue1', time: 5 };
      cueHandler.registerCues([cue]);
      cueHandler.markTriggered(cue);
      expect(cueHandler.hasTriggered(cue)).toBe(true);

      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should not consume a cue when the callback returns false', () => {
      cueHandler.onCue(() => false);
      cueHandler.registerCues([{ id: 'cue1', time: 5 }]);

      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(cueHandler.hasTriggered({ id: 'cue1', time: 5 })).toBe(false);

      // Once the main video is active again the cue can fire.
      cueHandler.onCue(mockCallback);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).toHaveBeenCalledTimes(1);
    });

    it('should remove the listener and release the callback on destroy', () => {
      cueHandler.start();
      cueHandler.destroy();
      expect(videoElement.removeEventListener).toHaveBeenCalledWith(
        'timeupdate',
        expect.any(Function),
      );

      cueHandler.registerCues([{ id: 'cue1', time: 5 }]);
      setTime(5);
      // @ts-ignore
      cueHandler.handleTimeUpdate();
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should only add one timeupdate listener when start is called repeatedly', () => {
      cueHandler.start();
      cueHandler.start();
      cueHandler.start();
      const timeupdateAdds = (videoElement.addEventListener as vi.Mock).mock.calls.filter(
        (call) => call[0] === 'timeupdate',
      );
      expect(timeupdateAdds).toHaveLength(1);
    });
  });
});
