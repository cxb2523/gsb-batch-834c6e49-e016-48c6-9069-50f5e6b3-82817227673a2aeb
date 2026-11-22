import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubtitlesManager } from '../src/subtitlesManager';
import { CuePoint } from '../src/types';

const SUBS_URL = 'https://cdn.test/subs.vtt';

describe('SubtitlesManager', () => {
  let video: HTMLVideoElement;
  let track: HTMLTrackElement;
  let manager: SubtitlesManager;
  let cues: CuePoint[];

  const dispatch = (type: string) => track.dispatchEvent(new Event(type));

  beforeEach(() => {
    document.body.innerHTML = '';
    video = document.createElement('video');

    track = document.createElement('track');
    track.src = SUBS_URL;
    track.kind = 'subtitles';
    track.default = true;
    video.appendChild(track);

    cues = [
      { id: 'intro', subtitleText: 'Hello', time: 0 },
      { id: 'later', subtitleText: 'World', time: 0 },
    ];

    manager = new SubtitlesManager(track, cues, video);
  });

  it('resolves cue timings from the text track', () => {
    Object.defineProperty(track, 'track', {
      configurable: true,
      value: {
        mode: 'showing',
        cues: [
          { text: 'Hello', startTime: 2 },
          { text: 'World', startTime: 7 },
        ],
      },
    });

    const callback = vi.fn();
    manager.onLoad(callback);
    dispatch('load');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toEqual([
      { id: 'intro', subtitleText: 'Hello', time: 2 },
      { id: 'later', subtitleText: 'World', time: 7 },
    ]);
  });

  it('falls back to the configured time when the cue is not in the track', () => {
    Object.defineProperty(track, 'track', {
      configurable: true,
      value: { mode: 'showing', cues: [] },
    });

    const callback = vi.fn();
    manager.onLoad(callback);
    dispatch('load');

    expect(callback.mock.calls[0][0]).toEqual([
      { id: 'intro', subtitleText: 'Hello', time: 0 },
      { id: 'later', subtitleText: 'World', time: 0 },
    ]);
  });

  it('emits the configured cues when the track fails to load', () => {
    const callback = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    manager.onLoad(callback);
    dispatch('error');

    expect(callback).toHaveBeenCalledWith(cues);
    consoleSpy.mockRestore();
  });

  it('detaches the track from the video for a branch segment', () => {
    expect(track.parentNode).toBe(video);
    manager.detachForSegment();

    expect(manager.isDetached()).toBe(true);
    expect(track.parentNode).toBeNull();
    expect(track.default).toBe(false);
    expect(manager.getSubtitlesUrl()).toBe(SUBS_URL);
  });

  it('does not emit cues while detached', () => {
    const callback = vi.fn();
    manager.onLoad(callback);
    manager.detachForSegment();

    dispatch('load');
    expect(callback).not.toHaveBeenCalled();
  });

  it('re-attaches the track to the main video and re-resolves cues', () => {
    const callback = vi.fn();
    manager.onLoad(callback);
    manager.detachForSegment();
    callback.mockClear();

    Object.defineProperty(track, 'track', {
      configurable: true,
      value: { mode: 'showing', cues: [{ text: 'Hello', startTime: 3 }] },
    });

    manager.attachForMain();

    expect(manager.isDetached()).toBe(false);
    expect(track.parentNode).toBe(video);
    expect(track.default).toBe(true);
    expect(track.src).toBe(SUBS_URL);
    // The resolved cues are pushed again against the restored main video.
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0][0].time).toBe(3);
  });

  it('does not emit unresolved cues when the track is not ready after re-attach', () => {
    const callback = vi.fn();
    manager.onLoad(callback);
    manager.detachForSegment();
    callback.mockClear();

    Object.defineProperty(track, 'track', {
      configurable: true,
      value: { mode: 'showing', cues: [] },
    });

    manager.attachForMain();

    // The track is re-attached but unresolved cues are not pushed, otherwise
    // every subtitle cue would be re-timed to 0 and drift out of alignment.
    expect(track.parentNode).toBe(video);
    expect(callback).not.toHaveBeenCalled();
  });

  it('re-attaches a detached track on destroy', () => {
    manager.detachForSegment();
    expect(track.parentNode).toBeNull();

    manager.destroy();

    expect(track.parentNode).toBe(video);
    expect(track.default).toBe(true);
    expect(manager.isDetached()).toBe(false);
  });

  it('removes listeners on destroy', () => {
    const callback = vi.fn();
    manager.onLoad(callback);
    manager.destroy();

    dispatch('load');
    dispatch('error');
    expect(callback).not.toHaveBeenCalled();

    // destroy is idempotent
    expect(() => manager.destroy()).not.toThrow();
  });
});
