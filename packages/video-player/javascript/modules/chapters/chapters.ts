import type Player from 'video.js/dist/types/player';
import type { SourceOptions, IKPlayerOptions } from '../../interfaces';
import { ChapterMarker, parseChaptersFromVTT } from './chapterMarkerProgressBar';
import { prepareChaptersVttSrc, CleanupRegistry } from '../../utils';

const BASE_LANG = 'base';
const SYNC_DEBOUNCE_MS = 50;

/**
 * Per-video-source chapter state.
 *
 * A new session is created on every `initChapterMarkers` call (i.e. every video
 * source), so translated chapter caches can never leak across sources. Sessions
 * are keyed by player so multiple players on one page never share state.
 */
interface ChapterSession {
  /** Chapter lists keyed by language code ('base' or e.g. 'es'). */
  cache: Map<string, ChapterMarker[]>;
  /** In-flight fetches, de-duplicated so preload and on-demand loads share one request. */
  inflight: Map<string, Promise<ChapterMarker[]>>;
  /** Languages whose translated VTT URL is known but whose fetch has not started/finished. */
  pendingUrls: Map<string, string>;
  /** Language currently applied (or requested). 'base' when no translation is active. */
  currentLang: string;
  /** Monotonic token; only the result of the latest switch is allowed to apply. */
  switchSeq: number;
  /** Cleanups tied to the currently applied chapter language (track cues, label). */
  perChapterCleanup: CleanupRegistry | null;
  /** Cleanups that live for the whole source (subtitle sync listener, debounce timer). */
  persistentCleanup: CleanupRegistry | null;
  /** Debounce handle for subtitle 'change' events. */
  debounceTimer: number | null;
}

const sessions = new WeakMap<Player, ChapterSession>();

function getSession(player: Player): ChapterSession | null {
  return sessions.get(player) ?? null;
}

function createSession(): ChapterSession {
  return {
    cache: new Map(),
    inflight: new Map(),
    pendingUrls: new Map(),
    currentLang: BASE_LANG,
    switchSeq: 0,
    perChapterCleanup: null,
    persistentCleanup: null,
    debounceTimer: null,
  };
}

/**
 * Clean up existing chapter text tracks from the player.
 */
function cleanupChapterTextTracks(player: Player): void {
  const playerWithTextTracks = player as unknown as {
    remoteTextTracks(): TextTrackList;
    removeRemoteTextTrack(track: TextTrack): void;
  };
  const textTracks = playerWithTextTracks.remoteTextTracks();

  for (let i = textTracks.length - 1; i >= 0; i--) {
    if (textTracks[i].kind === 'chapters') {
      playerWithTextTracks.removeRemoteTextTrack(textTracks[i]);
    }
  }
}

/**
 * Clean up existing chapter label display from the control bar.
 */
function cleanupChapterLabelDisplay(player: Player): void {
  const playerWithQuery = player as unknown as {
    $(selector: string): HTMLElement | null;
  };
  const spacer = playerWithQuery.$('.vjs-control-bar .vjs-spacer') as HTMLElement | null;
  if (spacer) {
    spacer.classList.remove('vjs-control-bar-chapter-wrapper');
    const display = spacer.querySelector('.vjs-control-bar-chapter-display');
    if (display) {
      display.remove();
    }
  }
}

/**
 * Remove every chapter UI element of the currently applied language:
 * chapter text tracks, the control-bar chapter label, cue-change listeners and
 * the chapter marker progress bar (boundaries, hover tooltip, aria suffix).
 * The subtitle sync listener itself is owned by the persistent cleanup and stays.
 */
function teardownActiveChapters(player: Player, session: ChapterSession): void {
  cleanupChapterTextTracks(player);
  cleanupChapterLabelDisplay(player);

  if (session.perChapterCleanup) {
    session.perChapterCleanup.dispose();
    session.perChapterCleanup = null;
  }

  const existing = player.getChild('ChapterMarkersProgressBarControl');
  if (existing) {
    existing.dispose();
  }
}

/**
 * Tear down everything chapter-related for this source, including the
 * subtitle sync listener, and forget the session.
 */
function fullTeardown(player: Player, session: ChapterSession): void {
  if (session.debounceTimer !== null) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = null;
  }
  teardownActiveChapters(player, session);
  if (session.persistentCleanup) {
    session.persistentCleanup.dispose();
    session.persistentCleanup = null;
  }
  sessions.delete(player);
}

/**
 * Whether chapters for a language are already usable, currently loading,
 * or at least known to be fetchable for the active video source.
 */
function isLanguageAvailable(session: ChapterSession, langCode: string): boolean {
  return (
    langCode === BASE_LANG ||
    session.cache.has(langCode) ||
    session.inflight.has(langCode) ||
    session.pendingUrls.has(langCode)
  );
}

/**
 * Load chapters for a specific language.
 * Results are cached per source; concurrent callers share one in-flight fetch.
 * Failed fetches are not cached so a later switch can retry.
 */
async function loadChaptersForLanguage(
  session: ChapterSession,
  player: Player,
  langCode: string,
  vttUrl: string
): Promise<ChapterMarker[]> {
  const cached = session.cache.get(langCode);
  if (cached) {
    return cached;
  }

  const inflight = session.inflight.get(langCode);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    try {
      const res = await fetch(vttUrl);
      if (!res.ok) {
        player.log.warn(`Chapter VTT fetch failed for ${langCode} with status: (${res.status})`);
        return [];
      }
      const data = await res.text();
      const chapterList = parseChaptersFromVTT(data);
      // Only cache real content. Failures stay retriable: pendingUrls is
      // retained, so selecting this language again re-attempts the fetch.
      if (chapterList.length > 0) {
        session.cache.set(langCode, chapterList);
      }
      return chapterList;
    } catch (e) {
      player.log.error(`Failed to fetch chapters for ${langCode}: ${e}`);
      return [];
    } finally {
      session.inflight.delete(langCode);
    }
  })();

  session.inflight.set(langCode, promise);
  return promise;
}

/**
 * Apply a chapter list to the player: chapter text track, control-bar label,
 * built-in chapters button and the marker progress bar.
 */
function applyChaptersToPlayer(
  player: Player,
  session: ChapterSession,
  chapterList: ChapterMarker[]
): void {
  if (chapterList.length === 0) return;

  if (!session.perChapterCleanup) {
    session.perChapterCleanup = new CleanupRegistry();
  }

  try {
    const trackEl = player.addRemoteTextTrack(
      {
        kind: 'chapters',
        default: true,
      },
      false
    ) as unknown as HTMLTrackElement;

    chapterList.forEach((chapter) => {
      const cue = new VTTCue(chapter.startTime, chapter.endTime, chapter.label);
      trackEl.track.addCue(cue);
    });

    setupChapterLabelDisplay(player, session, trackEl.track);

    // Update the chapters button
    const controlBar = player.getChild('ControlBar');
    if (controlBar) {
      const chaptersButton = controlBar.getChild('ChaptersButton');
      if (chaptersButton && typeof (chaptersButton as any).update === 'function') {
        (chaptersButton as any).update();
      }
    }
  } catch (e) {
    player.log.warn(`Failed to create chapter text track: ${e}`);
  }

  const existing = player.getChild('ChapterMarkersProgressBarControl');
  if (existing) {
    existing.dispose();
  }
  player.addChild('ChapterMarkersProgressBarControl', { chapters: chapterList });
}

/**
 * Switch all chapter UI to the given language.
 *
 * - The previous language's segments, hover tooltip, control-bar label and aria
 *   suffix are removed immediately, before any loading.
 * - If the target language is still pre-loading, we wait for it and apply once
 *   ready (never give up, never fall back and stop switching).
 * - Rapid consecutive switches are last-write-wins: a stale async result is
 *   discarded via the switch sequence token.
 */
async function requestChapterLanguage(
  player: Player,
  session: ChapterSession,
  langCode: string
): Promise<void> {
  const seq = ++session.switchSeq;
  session.currentLang = langCode;

  // Remove the old language first so no stale segments, tooltip or label can linger.
  teardownActiveChapters(player, session);

  const isStale = () =>
    player.isDisposed() ||
    sessions.get(player) !== session ||
    session.switchSeq !== seq;

  try {
    let chapterList: ChapterMarker[] | undefined = session.cache.get(langCode);

    if (!chapterList) {
      const inflight = session.inflight.get(langCode);
      if (inflight) {
        chapterList = await inflight;
      } else {
        const url = session.pendingUrls.get(langCode);
        if (url) {
          // Not loaded yet: wait for it instead of abandoning the switch.
          chapterList = await loadChaptersForLanguage(session, player, langCode, url);
        }
      }
    }

    if (isStale()) {
      return;
    }

    if (!chapterList) {
      chapterList = [];
    }

    // A failed/empty translation must not leave the player without chapters:
    // fall back to the base language content. Record base as the active
    // language (rather than the failed one) so selecting the translation
    // again later retries the fetch instead of being treated as a no-op.
    if (chapterList.length === 0 && langCode !== BASE_LANG) {
      player.log.warn(`No chapters available for language ${langCode}; showing base language chapters`);
      chapterList = session.cache.get(BASE_LANG) ?? [];
      session.currentLang = BASE_LANG;
    }

    applyChaptersToPlayer(player, session, chapterList);
  } catch (err) {
    if (!isStale()) {
      player.log.warn('Chapter switch failed:', err);
    }
  }
}

/**
 * Setup listener for subtitle track changes so chapters follow the active
 * subtitle language. Lives for the whole source session.
 */
function setupSubtitleChapterSync(player: Player, session: ChapterSession): void {
  if (!session.persistentCleanup) {
    session.persistentCleanup = new CleanupRegistry();
  }
  const persistentCleanup = session.persistentCleanup;

  const handler = () => {
    // Get fresh reference to textTracks inside handler to avoid stale references
    // when source changes and textTracks are cleared/reset.
    const currentTextTracks = player.textTracks();
    if (!currentTextTracks || player.isDisposed() || sessions.get(player) !== session) {
      return;
    }

    let targetLang = BASE_LANG;

    // Find the active subtitle/caption track.
    // TextTrackList is array-like, iterate using index access.
    const textTracksList = currentTextTracks as unknown as TextTrack[];
    for (let i = 0; i < textTracksList.length; i++) {
      const track = textTracksList[i];

      if ((track.kind === 'subtitles' || track.kind === 'captions') && track.mode === 'showing') {
        targetLang = track.language || 'en';
        break;
      }
    }

    // If no translated chapters exist for this language (e.g. disabled track or
    // a URL that failed signing), chapters return to the base language.
    if (!isLanguageAvailable(session, targetLang)) {
      targetLang = BASE_LANG;
    }

    // Skip if already on this language.
    if (targetLang === session.currentLang) {
      return;
    }

    // Debounce rapid toggling; only the last selection survives.
    if (session.debounceTimer !== null) {
      clearTimeout(session.debounceTimer);
    }

    session.debounceTimer = window.setTimeout(() => {
      session.debounceTimer = null;
      if (player.isDisposed() || sessions.get(player) !== session) {
        return;
      }
      // Re-validate availability at fire time (preload may have failed in between).
      const lang = isLanguageAvailable(session, targetLang) ? targetLang : BASE_LANG;
      if (lang === session.currentLang) {
        return;
      }
      void requestChapterLanguage(player, session, lang);
    }, SYNC_DEBOUNCE_MS); // Small delay to let Video.js finish internal updates
  };

  // Defer listener setup to next tick to ensure TextTrackList is stable.
  const setupTimer = window.setTimeout(() => {
    if (player.isDisposed() || sessions.get(player) !== session) return;

    const textTracks = player.textTracks();
    persistentCleanup.registerEventListener(
      textTracks as unknown as EventTarget,
      'change',
      handler
    );
    handler(); // initial sync
  }, 0);

  persistentCleanup.register(() => clearTimeout(setupTimer));
}

/**
 * Setup chapter label display in the control bar.
 * Displays the current chapter name and updates on cuechange events.
 */
function setupChapterLabelDisplay(
  player: Player,
  session: ChapterSession,
  chaptersTrack: TextTrack
): void {
  const playerWithQuery = player as unknown as {
    $(selector: string): HTMLElement | null;
  };

  const controlBarChapterHolder =
    (playerWithQuery.$('.vjs-control-bar-chapter-display') as HTMLElement) ||
    document.createElement('div');
  controlBarChapterHolder.setAttribute('class', 'vjs-control-bar-chapter-display');

  const spacer = playerWithQuery.$('.vjs-control-bar .vjs-spacer') as HTMLElement | null;
  if (!spacer) {
    player.log.warn('Control bar spacer not found, cannot setup chapter display');
    return;
  }

  const existingDisplay = spacer.querySelector('.vjs-control-bar-chapter-display');
  if (existingDisplay) {
    existingDisplay.remove();
  }

  spacer.classList.add('vjs-control-bar-chapter-wrapper');
  spacer.appendChild(controlBarChapterHolder);

  const cueChangeHandler = () => {
    // Safari needs Array.from() for activeCues
    const activeCues = Array.from(chaptersTrack.activeCues);
    if (activeCues.length > 0) {
      const cue = activeCues[0] as VTTCue;
      controlBarChapterHolder.innerText = cue.text || '';
    } else {
      controlBarChapterHolder.innerText = '';
    }
  };

  if (!session.perChapterCleanup) {
    session.perChapterCleanup = new CleanupRegistry();
  }
  session.perChapterCleanup.registerEventListener(chaptersTrack, 'cuechange', cueChangeHandler);
  cueChangeHandler();
}

/**
 * Initialize chapter markers for the video player.
 * Supports three methods:
 * 1. Auto-generate: chapters: true (with optional translations)
 * 2. VTT URL: chapters: { url: string }
 * 3. Manual object: chapters: { [timeInSec]: title }
 *
 * Every call starts a fresh per-source session, so chapter caches and listeners
 * from a previous video are never reused.
 */
export async function initChapterMarkers(
  player: Player,
  source: SourceOptions | SourceOptions[] | null,
  ikGlobalSettings: IKPlayerOptions
): Promise<void> {
  // Drop the previous source's chapters, sync listener and translated cache.
  const previousSession = sessions.get(player);
  if (previousSession) {
    fullTeardown(player, previousSession);
  }

  const session = createSession();
  sessions.set(player, session);

  if (!source) return;

  const src = Array.isArray(source) ? source[0] : source;
  if (!src.chapters) return;

  let chapterList: ChapterMarker[] = [];

  function waitForLoadedMetadata(player: Player): Promise<void> {
    return new Promise((resolve) => {
      if (player.readyState() > 0) {
        resolve();
        return;
      }
      player.one('loadedmetadata', () => resolve());
    });
  }

  await waitForLoadedMetadata(player);

  // A newer source may have started while we waited; its init owns the player now.
  if (sessions.get(player) !== session || player.isDisposed()) {
    return;
  }

  if (typeof src.chapters === 'object' && 'url' in src.chapters) {
    // Manual VTT URL - load directly
    try {
      let vttUrl = src.chapters.url;

      if (ikGlobalSettings.signerFn) {
        try {
          vttUrl = await ikGlobalSettings.signerFn(vttUrl);
        } catch (err) {
          player.log.error(`Failed to sign chapter VTT URL: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }

      const res = await fetch(vttUrl);
      if (!res.ok) {
        player.log.warn(`VTT fetch failed with status: (${res.status}); skipping chapters.`);
        return;
      }
      const data = await res.text();
      chapterList = parseChaptersFromVTT(data);
    } catch (e) {
      player.log.error(`Failed to fetch chapters VTT: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  } else if (typeof src.chapters === 'object') {
    // Manual chapter object - convert to ChapterMarker[]
    const entries = Object.entries(src.chapters)
      .map(([time, label]) => ({ startTime: Number(time), label: String(label) }))
      .sort((a, b) => a.startTime - b.startTime);

    const duration = player.duration() || 0;

    chapterList = entries.map((entry, index) => {
      const endTime =
        index < entries.length - 1
          ? entries[index + 1].startTime
          : duration || entry.startTime + 10;
      return {
        startTime: entry.startTime,
        endTime: endTime,
        label: entry.label,
      };
    });
  } else if (src.chapters === true) {
    // Auto-generate chapters with translations support
    try {
      const { baseUrl, translatedUrls } = await prepareChaptersVttSrc(src, ikGlobalSettings);

      if (sessions.get(player) !== session || player.isDisposed()) {
        return;
      }

      // Remember every translated URL so an on-demand switch can wait for /
      // trigger its load even before background preloading finishes.
      for (const [langCode, url] of translatedUrls.entries()) {
        session.pendingUrls.set(langCode, url);
      }

      // Load and apply the base language first.
      const baseChapters = await loadChaptersForLanguage(session, player, BASE_LANG, baseUrl);
      if (sessions.get(player) !== session || player.isDisposed()) {
        return;
      }
      if (baseChapters.length > 0) {
        applyChaptersToPlayer(player, session, baseChapters);
      }

      // Pre-load translated chapters in background (de-duplicated against on-demand loads).
      for (const [langCode, url] of translatedUrls.entries()) {
        loadChaptersForLanguage(session, player, langCode, url).catch((err) => {
          player.log.warn(`Failed to pre-load chapters for ${langCode}:`, err);
        });
      }

      // Keep chapter displays in sync with the active subtitle language.
      if (translatedUrls.size > 0) {
        setupSubtitleChapterSync(player, session);
      }
      return;
    } catch (e) {
      player.log.error(`Failed to fetch default chapters VTT: ${e}`);
      return;
    }
  }

  // Apply the default chapters (manual VTT URL or manual chapter object).
  if (chapterList.length > 0) {
    applyChaptersToPlayer(player, session, chapterList);
  }
}
