import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IVLabsPlayer } from '../src/player';
import { PlayerConfig, CuePoint } from '../src/types';

const MAIN_URL = 'https://cdn.test/main.mp4';
const SEGMENT_A_URL = 'https://cdn.test/segment-a.mp4';
const SUBS_URL = 'https://cdn.test/subs.vtt';

type TestVideo = HTMLVideoElement & {
  load: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  controlsList: string;
};

function makeBranchCue(time = 5): CuePoint {
  return {
    id: 'branch',
    time,
    payload: {
      interaction: {
        type: 'choice-video-segment-change',
        question: 'Where to?',
        options: [{ level: 'Segment A', video: SEGMENT_A_URL }],
      },
    },
  };
}

describe('IVLabsPlayer branch segment flow (integration)', () => {
  let container: HTMLDivElement;
  let video: TestVideo;
  let player: IVLabsPlayer | null;
  let originalCreateElement: typeof document.createElement;

  const setTime = (time: number) => {
    video.currentTime = time;
    video.dispatchEvent(new Event('timeupdate'));
  };

  const dispatch = (type: string, target: EventTarget = video) => {
    target.dispatchEvent(new Event(type));
  };

  const clickFirstChoice = () => {
    const button = container.querySelector('.ivl-choice-button') as HTMLButtonElement | null;
    if (!button) throw new Error('choice button not rendered');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };

  const createPlayer = (config: Partial<PlayerConfig> = {}) => {
    const fullConfig: PlayerConfig = {
      videoUrl: MAIN_URL,
      cues: [makeBranchCue(), { id: 'later', time: 8, payload: { message: 'later' } }],
      initialState: 'idle',
      ...config,
    };
    return new IVLabsPlayer('player', fullConfig);
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    container.id = 'player';
    document.body.appendChild(container);

    originalCreateElement = document.createElement.bind(document);
    video = originalCreateElement('video') as TestVideo;
    video.load = vi.fn();
    video.play = vi.fn(() => Promise.resolve());
    video.pause = vi.fn();
    // jsdom does not expose controlsList as a writable reflected property.
    Object.defineProperty(video, 'controlsList', {
      configurable: true,
      writable: true,
      value: '',
    });

    vi.spyOn(document, 'createElement').mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      if (tagName === 'video') return video;
      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    player = null;
  });

  afterEach(() => {
    player?.destroy();
    player = null;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('round-trips a branch: no main cue during segment, no re-trigger, state playing, one decision', async () => {
    player = createPlayer();
    const cueEntries: string[] = [];
    player.on('onCueEnter', (payload) => {
      if (payload?.cueId) cueEntries.push(payload.cueId);
    });

    // 1. Reaching the branch cue pauses the main video and asks the user.
    setTime(5);
    expect(player.getState()).toBe('waitingForInteraction');
    expect(container.querySelector('.ivl-interaction-overlay')).not.toBeNull();
    expect(video.pause).toHaveBeenCalled();

    // 2. Choosing a segment switches the source and records one decision.
    clickFirstChoice();
    expect(video.src).toBe(SEGMENT_A_URL);
    expect(player.isPlayingSegment()).toBe(true);
    expect(player.getState()).toBe('playing');

    // Segment metadata arrives -> segment plays.
    dispatch('loadedmetadata');
    expect(video.play).toHaveBeenCalled();

    // 3. While the segment plays, main cues at the segment timeline must not fire.
    const cueCountBeforeSegmentProgress = cueEntries.length;
    setTime(8);
    setTime(10);
    expect(cueEntries.length).toBe(cueCountBeforeSegmentProgress);
    expect(container.querySelector('.ivl-interaction-overlay')).toBeNull();
    expect(player.getState()).toBe('playing');

    const history = await player.getDecisionHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      cueId: 'branch',
      choice: SEGMENT_A_URL,
      source: 'main',
      segmentUrl: SEGMENT_A_URL,
      metadata: { source: 'main', branch: true, selectedSegment: SEGMENT_A_URL },
    });

    // 4. The segment ends: main source and time are restored and playback resumes.
    dispatch('ended');
    expect(video.src).toBe(MAIN_URL);
    expect(video.currentTime).toBe(5);
    expect(player.isPlayingSegment()).toBe(false);

    dispatch('loadedmetadata');
    expect(player.getState()).toBe('playing');
    expect(video.play).toHaveBeenCalledTimes(2);

    // 5. Re-scrubbing past the answered cue must not show it again.
    setTime(5);
    setTime(6);
    expect(cueEntries.filter((id) => id === 'branch')).toHaveLength(1);
    expect(container.querySelector('.ivl-interaction-overlay')).toBeNull();

    // 6. Unanswered cues after the branch still fire exactly once.
    setTime(8);
    expect(cueEntries.filter((id) => id === 'later')).toHaveLength(1);

    const finalHistory = await player.getDecisionHistory();
    expect(finalHistory).toHaveLength(1);
  });

  it('restores the main video when the segment fails to load', async () => {
    player = createPlayer();
    const cueEntries: string[] = [];
    player.on('onCueEnter', (payload) => {
      if (payload?.cueId) cueEntries.push(payload.cueId);
    });

    setTime(5);
    clickFirstChoice();
    expect(video.src).toBe(SEGMENT_A_URL);
    expect(player.isPlayingSegment()).toBe(true);

    // The segment media errors before metadata is available.
    dispatch('error');
    expect(video.src).toBe(MAIN_URL);
    expect(video.currentTime).toBe(5);
    expect(player.isPlayingSegment()).toBe(false);

    dispatch('loadedmetadata');
    expect(player.getState()).toBe('playing');

    setTime(6);
    expect(cueEntries.filter((id) => id === 'branch')).toHaveLength(1);
    setTime(8);
    expect(cueEntries.filter((id) => id === 'later')).toHaveLength(1);
  });

  it('destroy during a segment restores the main video and releases listeners', async () => {
    player = createPlayer();
    const cueEntries: string[] = [];
    player.on('onCueEnter', (payload) => {
      if (payload?.cueId) cueEntries.push(payload.cueId);
    });

    setTime(5);
    clickFirstChoice();
    dispatch('loadedmetadata');

    const playCallsBeforeDestroy = video.play.mock.calls.length;
    player.destroy();

    // Main source/time restored without auto-play.
    expect(video.src).toBe(MAIN_URL);
    expect(video.currentTime).toBe(5);
    expect(video.play.mock.calls.length).toBe(playCallsBeforeDestroy);

    // Listeners are released: further media events cannot drive the player.
    const cueEntriesBefore = cueEntries.length;
    setTime(8);
    dispatch('ended');
    dispatch('loadedmetadata');
    expect(cueEntries.length).toBe(cueEntriesBefore);
    expect(video.src).toBe(MAIN_URL);

    // destroy is idempotent.
    expect(() => player?.destroy()).not.toThrow();
  });

  it('keeps the subtitle track attached to the main video across a branch', async () => {
    const cues: CuePoint[] = [
      { id: 'sub-cue', subtitleText: 'Hello', time: 0, payload: { message: 'sub' } },
      makeBranchCue(),
      { id: 'later', time: 8, payload: { message: 'later' } },
    ];
    player = createPlayer({ subtitlesUrl: SUBS_URL, cues });

    const track = video.querySelector('track') as HTMLTrackElement;
    expect(track).not.toBeNull();
    // jsdom does not resolve a TextTrack; provide a stable fake track.
    Object.defineProperty(track, 'track', {
      configurable: true,
      value: {
        mode: 'showing',
        cues: [{ text: 'Hello', startTime: 2 }],
      },
    });

    const cueEntries: string[] = [];
    player.on('onCueEnter', (payload) => {
      if (payload?.cueId) cueEntries.push(payload.cueId);
    });

    // Subtitle resolution starts the player and maps the cue to 2s.
    dispatch('load', track);
    expect(cueEntries).toEqual([]);

    setTime(2);
    expect(cueEntries).toEqual(['sub-cue']);

    setTime(5);
    expect(player.getState()).toBe('waitingForInteraction');
    clickFirstChoice();
    expect(player.isPlayingSegment()).toBe(true);

    // Subtitles must not be attached to the branch segment.
    expect(track.parentNode).toBeNull();
    expect(track.src).toBe(SUBS_URL);

    dispatch('loadedmetadata');
    dispatch('ended');
    dispatch('loadedmetadata');

    // Back on the main video the track is attached again and unchanged.
    expect(video.src).toBe(MAIN_URL);
    expect(track.parentNode).toBe(video);
    expect(track.src).toBe(SUBS_URL);
    expect(player.getState()).toBe('playing');

    // Re-resolving subtitles after the source switch must not re-fire cues.
    dispatch('load', track);
    setTime(6);
    expect(cueEntries.filter((id) => id === 'branch')).toHaveLength(1);
    expect(cueEntries.filter((id) => id === 'sub-cue')).toHaveLength(1);

    setTime(8);
    expect(cueEntries.filter((id) => id === 'later')).toHaveLength(1);
  });
});
