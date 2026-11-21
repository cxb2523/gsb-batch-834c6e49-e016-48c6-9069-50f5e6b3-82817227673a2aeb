import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import html from './fixtures/review-page.html?raw';
import { createDefaultPreferences } from '../src/entities/preferences.entity';
import type { ClipData } from '../src/entities/clip.entity';
import type { MessageCatalog } from '../src/shared/services/i18n.service';
import { ValvePlayerHost } from '../src/features/valve-interop/adapters/valve-player-host.adapter';
import { PlyrAdapter } from '../src/features/video-player/adapters/plyr.adapter';
import { PlayerLifecycle } from '../src/features/video-player/player/player-media.utils';

vi.mock('../src/shared/services/i18n.service', async (importOriginal) => ({
  ...await importOriginal<object>(), getMessage: (key: string) => key,
}));

const baseClip: ClipData = {
  taskId: 'task-a', sourceWebmUrl: 'https://replay-video.valve.net/a.webm', videoId: 'video-a',
  reviewType: 'legacy', eventTime: 10, range: { start: 2, end: 70 },
  app: 'cs2', clipCount: null, matchTimestamp: null, webmDuration: 90,
};
const catalog = {
  triggerMarkerLabel: 'Event', videoJsPlay: 'Play', videoJsPause: 'Pause', videoJsReset: 'Restart',
  videoJsVolumeLevel: 'Volume', playerSettings: 'Settings', videoJsFullscreen: 'Fullscreen',
  videoJsExitFullscreen: 'Exit fullscreen', shareClip: 'Share', clipLinkCopied: 'Copied',
  errReviewVideoMetadataLoadFailed: 'metadata-failed', errReviewVideoMetadataTimeout: 'metadata-timeout',
  errReviewVideoSeekFailed: 'seek-failed', errVideoOperationTimeout: 'operation-timeout',
} as MessageCatalog;

let adapter: PlyrAdapter | null;

function createAdapter(): PlyrAdapter {
  adapter = new PlyrAdapter({
    playerHost: new ValvePlayerHost(() => {}),
    catalog: () => catalog,
    onPreferences: vi.fn(),
    onPlayerOverlay: vi.fn(),
  });
  return adapter;
}

/** The shipped fixture is a native review page; drop its markers for legacy-mode tests. */
function forceLegacyPage(): void {
  document.querySelector('#verdictbuttons_cheating')?.remove();
  document.querySelector('[name=verdict_tick]')?.remove();
}

/** Legacy mode mounts a fresh #vacnet-review-video wrapped by Plyr. */
function legacyVideo(): HTMLVideoElement {
  return document.querySelector<HTMLVideoElement>('#vacnet-review-video')!;
}

function hostElement(video: HTMLVideoElement): HTMLDivElement {
  return video.closest<HTMLDivElement>('.vacnet-review-player-host')!;
}

function isLoading(video: HTMLVideoElement): boolean {
  return hostElement(video).classList.contains('vacnet-video-loading');
}

function markerCount(video: HTMLVideoElement): number {
  return hostElement(video).querySelectorAll('.plyr__progress__marker').length;
}

function markerLeft(video: HTMLVideoElement): string {
  return hostElement(video).querySelector('.plyr__progress__marker')!.getAttribute('style') ?? '';
}

/** Plyr nests its UI inside .plyr; wait for the microtask-bound ready cycle. */
async function settlePlyr(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function finishMetadata(video: HTMLVideoElement): void {
  video.dispatchEvent(new Event('loadedmetadata'));
}

function finishSeek(video: HTMLVideoElement): void {
  Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  video.dispatchEvent(new Event('seeked'));
}

beforeEach(() => {
  vi.stubGlobal('TextTrack', class TextTrack {});
  document.documentElement.innerHTML = html;
  sessionStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLVideoElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLVideoElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new Event('play'));
  });
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});

/** Replace the default resolving play() mock with a manually controlled one. */
function installDeferredPlay(): Array<() => void> {
  const pending: Array<() => void> = [];
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLVideoElement) {
    return new Promise<void>((resolve) => {
      pending.push(() => {
        Object.defineProperty(this, 'paused', { configurable: true, value: false });
        this.dispatchEvent(new Event('play'));
        resolve();
      });
    });
  });
  return pending;
}

afterEach(async () => {
  adapter?.dispose();
  adapter = null;
  delete (window as Partial<Window> & { videojs?: unknown }).videojs;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PlyrAdapter concurrent clip switching', () => {
  it('keeps the second clip when its metadata arrives before the first load completes', async () => {
    const first: ClipData = { ...baseClip, taskId: 'task-1', sourceWebmUrl: 'https://replay-video.valve.net/1.webm', range: { start: 2, end: 70 }, eventTime: 10 };
    const second: ClipData = { ...baseClip, taskId: 'task-2', sourceWebmUrl: 'https://replay-video.valve.net/2.webm', range: { start: 5, end: 60 }, eventTime: 20 };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), first);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });

    const firstController = new AbortController();
    const firstLoad = player.load(first.sourceWebmUrl, first, firstController.signal);
    expect(video.src).toContain('1.webm');
    expect(isLoading(video)).toBe(true);

    // Switch before any metadata event fires, exactly like PlayerCoordinator does.
    firstController.abort();
    const firstSettled = firstLoad.catch(() => undefined);
    const secondController = new AbortController();
    const secondLoad = player.load(second.sourceWebmUrl, second, secondController.signal);
    expect(video.src).toContain('2.webm');

    // Late arrival of the first clip's metadata must not write its range.
    finishMetadata(video);
    finishMetadata(video);
    await Promise.resolve();
    expect(video.currentTime).not.toBe(2);

    finishSeek(video);
    await Promise.all([firstSettled, secondLoad]);

    expect(video.src).toContain('2.webm');
    expect(video.currentTime).toBe(5);
    expect(video.paused).toBe(false);
    expect(isLoading(video)).toBe(false);
    const markers = hostElement(video).querySelectorAll<HTMLElement>('.plyr__progress__marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.style.left).toBe(`${(20 / 90) * 100}%`);
  });

  it('drops a late seek from an aborted generation instead of moving the new clip', async () => {
    const first: ClipData = { ...baseClip, taskId: 'task-1', range: { start: 2, end: 70 }, eventTime: 10 };
    const second: ClipData = { ...baseClip, taskId: 'task-2', range: { start: 8, end: 60 }, eventTime: 20 };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), first);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });

    const firstController = new AbortController();
    const firstLoad = player.load(first.sourceWebmUrl, first, firstController.signal);
    finishMetadata(video);
    await Promise.resolve();
    expect(video.currentTime).toBe(2);

    // Abort while the first generation is waiting for seeked/canplay.
    firstController.abort();
    const firstSettled = firstLoad.catch(() => undefined);
    const secondController = new AbortController();
    const secondLoad = player.load(second.sourceWebmUrl, second, secondController.signal);
    finishMetadata(video);
    await Promise.resolve();
    expect(video.currentTime).toBe(8);

    // The old seeked event resolves late; it must not revive the old range.
    finishSeek(video);
    finishSeek(video);
    await Promise.all([firstSettled, secondLoad]);
    expect(video.currentTime).toBe(8);
    expect(isLoading(video)).toBe(false);
  });

  it('removes the loading mask when a cancelled legacy load is replaced by a cheating clip', async () => {
    const legacyClip: ClipData = { ...baseClip, taskId: 'legacy', range: { start: 2, end: 70 } };
    const cheatingClip: ClipData = { ...baseClip, taskId: 'cheat', reviewType: 'cheating', sourceWebmUrl: 'https://replay-video.valve.net/site.webm', range: { start: 0, end: 70 }, eventTime: -1 };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), legacyClip);
    const video = legacyVideo();

    const legacyController = new AbortController();
    const legacyLoad = player.load(legacyClip.sourceWebmUrl, legacyClip, legacyController.signal);
    expect(isLoading(video)).toBe(true);
    legacyController.abort();
    const legacySettled = legacyLoad.catch(() => undefined);
    await player.load(cheatingClip.sourceWebmUrl, cheatingClip, new AbortController().signal);

    expect(isLoading(video)).toBe(false);
    await legacySettled;
    await expect(legacyLoad).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('PlyrAdapter cancellation and late arrivals', () => {
  it('rejects with an AbortError and leaves no mask when cancelled before metadata', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    const controller = new AbortController();
    const loading = player.load(baseClip.sourceWebmUrl, baseClip, controller.signal);
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(isLoading(video)).toBe(false);
  });

  it('ignores metadata that arrives after the external abort', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
    const controller = new AbortController();
    const loading = player.load(baseClip.sourceWebmUrl, baseClip, controller.signal);
    controller.abort();
    finishMetadata(video);
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    // No stale range write, no stale mask.
    expect(video.currentTime).not.toBe(baseClip.range.start);
    expect(isLoading(video)).toBe(false);
  });

  it('clears metadata listeners and the timeout when aborted before metadata', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    const remove = vi.spyOn(video, 'removeEventListener');
    const controller = new AbortController();
    const loading = player.load(baseClip.sourceWebmUrl, baseClip, controller.signal);
    controller.abort();
    await loading.catch(() => undefined);
    const removedTypes = remove.mock.calls.map(([type]) => type);
    expect(removedTypes).toContain('loadedmetadata');
    expect(removedTypes).toContain('error');
  });

  it('clears the target-data listeners when aborted while waiting for the seek', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
    const remove = vi.spyOn(video, 'removeEventListener');
    const controller = new AbortController();
    const loading = player.load(baseClip.sourceWebmUrl, baseClip, controller.signal);
    finishMetadata(video);
    await Promise.resolve();
    controller.abort();
    await loading.catch(() => undefined);
    const removedTypes = remove.mock.calls.map(([type]) => type);
    expect(removedTypes).toContain('seeked');
    expect(removedTypes).toContain('canplay');
    expect(removedTypes).toContain('loadeddata');
  });

  it('clears the timeout and listeners when a metadata wait times out', async () => {
    vi.useFakeTimers();
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    const remove = vi.spyOn(video, 'removeEventListener');
    const loading = player.load(baseClip.sourceWebmUrl, baseClip, new AbortController().signal);
    const expectation = expect(loading).rejects.toThrow('metadata-timeout');
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    const removedTypes = remove.mock.calls.map(([type]) => type);
    expect(removedTypes).toContain('loadedmetadata');
    expect(removedTypes).toContain('error');
    // The rejected wait released its 30s timer instead of leaking it.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses the media again when a superseded play() promise resolves late', async () => {
    const first: ClipData = { ...baseClip, taskId: 'task-1', range: { start: 2, end: 70 } };
    const second: ClipData = { ...baseClip, taskId: 'task-2', range: { start: 5, end: 60 } };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), first);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });

    const pendingPlays = installDeferredPlay();

    const firstController = new AbortController();
    const firstLoad = player.load(first.sourceWebmUrl, first, firstController.signal);
    finishMetadata(video);
    finishSeek(video);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingPlays).toHaveLength(1);

    firstController.abort();
    const firstSettled = firstLoad.catch(() => undefined);
    const secondController = new AbortController();
    const secondLoad = player.load(second.sourceWebmUrl, second, secondController.signal);
    finishMetadata(video);
    finishSeek(video);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingPlays).toHaveLength(2);
    // The second generation pauses before its own play; the old promise is still pending.
    expect(video.paused).toBe(true);

    pendingPlays[0]!();
    await Promise.resolve();
    // Stale generation must not leave the new clip playing.
    expect(video.paused).toBe(true);

    pendingPlays[1]!();
    await Promise.all([firstSettled, secondLoad]);
    expect(video.paused).toBe(false);
  });

  it('does not pause the released site video when a pending play() resolves after dispose', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
    const pendingPlays = installDeferredPlay();

    const load = player.load(baseClip.sourceWebmUrl, baseClip, new AbortController().signal);
    finishMetadata(video);
    finishSeek(video);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingPlays).toHaveLength(1);

    player.dispose();
    adapter = null;
    const settled = load.catch(() => undefined);
    // dispose() itself pauses the legacy media once; capture the count after it.
    const pausesAfterDispose = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;

    pendingPlays[0]!();
    await settled;
    // A late play() resolution must not drive another pause() through an
    // adapter whose host was already released back to the site.
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls).toHaveLength(pausesAfterDispose);
  });
});

describe('PlyrAdapter cheating clips stay site-owned', () => {
  it('never reloads, pauses or seeks a cheating clip and rebuilds its marker', async () => {
    const cheatingClip: ClipData = { ...baseClip, taskId: 'cheat', reviewType: 'cheating', eventTime: 12, range: { start: 0, end: 70 } };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), cheatingClip);
    await settlePlyr();
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
    video.currentTime = 6.25;
    const loadCalls = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;
    const pauseCalls = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;

    await player.load(cheatingClip.sourceWebmUrl, cheatingClip, new AbortController().signal);

    expect(vi.mocked(HTMLMediaElement.prototype.load).mock.calls).toHaveLength(loadCalls);
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls).toHaveLength(pauseCalls);
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.currentTime).toBe(6.25);
    expect(markerCount(video)).toBe(1);
    expect(markerLeft(video)).toContain(`${(12 / 90) * 100}%`);
  });

  it('clears the previous marker when the next cheating clip has no event time', async () => {
    const withEvent: ClipData = { ...baseClip, taskId: 'cheat-1', reviewType: 'cheating', eventTime: 12, range: { start: 0, end: 70 } };
    const withoutEvent: ClipData = { ...baseClip, taskId: 'cheat-2', reviewType: 'cheating', eventTime: -1, range: { start: 0, end: 70 } };
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), withEvent);
    await settlePlyr();
    const video = legacyVideo();
    Object.defineProperty(video, 'duration', { configurable: true, value: 90 });
    await player.load(withEvent.sourceWebmUrl, withEvent, new AbortController().signal);
    expect(markerCount(video)).toBe(1);

    await player.load(withoutEvent.sourceWebmUrl, withoutEvent, new AbortController().signal);
    expect(markerCount(video)).toBe(0);
  });
});

describe('PlyrAdapter disposal and rebuild', () => {
  it('rejects loads after disposal and never touches the released host again', async () => {
    const player = createAdapter();
    forceLegacyPage();
    player.configure(createDefaultPreferences(), baseClip);
    const video = legacyVideo();
    const controller = new AbortController();
    const inFlight = player.load(baseClip.sourceWebmUrl, baseClip, controller.signal);
    player.dispose();
    adapter = null;
    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' });
    await expect(player.load(baseClip.sourceWebmUrl, baseClip, new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    // The host element was removed; late waits must not have resurrected a mask.
    expect(video.isConnected).toBe(false);
    expect(document.querySelector('.vacnet-video-loading')).toBeNull();
  });

  it('rebuilds a fresh player after disposal while keeping the site video node and listeners', async () => {
    const nativeClip: ClipData = { ...baseClip, reviewType: 'cheating', eventTime: -1 };
    document.documentElement.innerHTML = html;
    vi.stubGlobal('TextTrack', class TextTrack {});
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const siteVideo = document.querySelector<HTMLVideoElement>('#video_html5_api')!;
    const source = siteVideo.querySelector('source');
    const siteListener = vi.fn();
    siteVideo.addEventListener('timeupdate', siteListener);

    const first = createAdapter();
    first.configure(createDefaultPreferences(), nativeClip);
    await settlePlyr();
    const root = siteVideo.closest<HTMLDivElement>('.vacnet-review-player-host')!;
    expect(root.querySelector('.plyr__controls')).not.toBeNull();
    first.dispose();
    adapter = null;
    expect(document.querySelector('#video_html5_api')).toBe(siteVideo);
    expect(siteVideo.querySelector('source')).toBe(source);

    const second = createAdapter();
    second.configure(createDefaultPreferences(), nativeClip);
    await settlePlyr();
    expect(document.querySelector('#video_html5_api')).toBe(siteVideo);
    expect(siteVideo.closest('.vacnet-review-player-host')!.querySelector('.plyr__controls')).not.toBeNull();
    siteVideo.currentTime = 9.5;
    siteVideo.dispatchEvent(new Event('timeupdate'));
    expect(siteListener).toHaveBeenCalled();
  });

  it('keeps Plyr proxy events from bubbling into site handlers after rebuild', async () => {
    const nativeClip: ClipData = { ...baseClip, reviewType: 'cheating', eventTime: -1 };
    document.documentElement.innerHTML = html;
    vi.stubGlobal('TextTrack', class TextTrack {});
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const siteVideo = document.querySelector<HTMLVideoElement>('#video_html5_api')!;

    const first = createAdapter();
    first.configure(createDefaultPreferences(), nativeClip);
    await settlePlyr();
    first.dispose();
    adapter = null;

    const second = createAdapter();
    second.configure(createDefaultPreferences(), nativeClip);
    await settlePlyr();
    const host = siteVideo.closest<HTMLDivElement>('.vacnet-review-player-host')!;
    const mountedPlyr = (second as unknown as { instance: { plyr: unknown } }).instance.plyr;
    // Site-level handlers live on an ancestor of the extension host, exactly
    // like Video.js handlers bound to #video/.videocontainer.
    const site = vi.fn();
    host.parentElement!.addEventListener('timeupdate', site);

    // Plyr's media listener re-dispatches the tech event on the container as a
    // Plyr-tagged bubbling CustomEvent. The host stops it before ancestors run.
    host.dispatchEvent(new CustomEvent('timeupdate', { detail: { plyr: mountedPlyr }, bubbles: true }));
    expect(site).not.toHaveBeenCalled();

    // A CustomEvent tagged with a foreign instance is not this Plyr's and
    // still reaches the site, proving the guard is narrowly scoped.
    host.dispatchEvent(new CustomEvent('timeupdate', { detail: { plyr: {} }, bubbles: true }));
    expect(site).toHaveBeenCalledOnce();
  });
});

describe('PlayerLifecycle generation bookkeeping', () => {
  it('aborts the previous generation when a new one starts', () => {
    const lifecycle = new PlayerLifecycle();
    const first = lifecycle.nextGeneration();
    const firstSignal = lifecycle.operationSignal(new AbortController().signal);
    const second = lifecycle.nextGeneration();
    expect(firstSignal.aborted).toBe(true);
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(second)).toBe(true);
  });

  it('aborts every wait on dispose', () => {
    const lifecycle = new PlayerLifecycle();
    const generation = lifecycle.nextGeneration();
    const signal = lifecycle.operationSignal(new AbortController().signal);
    lifecycle.dispose();
    expect(signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(generation)).toBe(false);
  });

  it('combines the external signal with the generation signal', () => {
    const lifecycle = new PlayerLifecycle();
    lifecycle.nextGeneration();
    const external = new AbortController();
    const signal = lifecycle.operationSignal(external.signal);
    external.abort();
    expect(signal.aborted).toBe(true);
  });
});
