import type { PlaybackPosition, ResumeConfig } from '../BunnyStreamPlayer.types';
import type { BunnyVodPlayerRef } from '../BunnyStreamPlayer.types';
import type { ResumePositionStorage } from './resumeStorage';

import * as React from 'react';
import { Platform } from 'react-native';

import {
  allowAutoSave,
  clearAllStoredPositions,
  clearStoredPosition,
  currentClearEpoch,
  DEFAULT_RETENTION_DAYS,
  getAllStoredPositions,
  getStoredPosition,
  isAutoSaveSuppressed,
  isExpired,
  markAllPositionsCleared,
  markPositionCleared,
  storageKey,
} from './resumeStorage';

export type { ResumePositionStorage };

const DEFAULT_CONFIG: Required<ResumeConfig> = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  minimumWatchMs: 30_000,
  resumeThreshold: 0.05,
  nearEndThreshold: 0.95,
  enableAutoSave: true,
  saveIntervalMs: 10_000,
};

/**
 * iOS JavaScript fallback for resume position. The native iOS SDK does not
 * expose a resume-position API, so this hook tracks playback progress in JS
 * and persists positions to a pluggable async storage (typically
 * `@react-native-async-storage/async-storage`).
 *
 * On Android, the native SDK's `PlaybackPositionManager` is used instead
 * (enabled via the `resumeConfig` prop on `BunnyStreamPlayer`). This hook is
 * a no-op on Android.
 *
 * Semantics matching the Android native implementation:
 * - Positions watched for less than `minimumWatchMs` are not saved.
 * - Positions below `resumeThreshold` (fraction of duration) are not saved.
 * - Positions at or beyond `nearEndThreshold` are not saved (video finished).
 * - Positions older than `retentionDays` are ignored on restore (and removed).
 * - Auto-save fires at most every `saveIntervalMs` while playing; a manual
 *   save (`{ manual: true }`) always writes.
 */
export type UseResumePositionOptions = Readonly<{
  /**
   * Player ref from `useBunnyStreamPlayer` or a direct `ref` to
   * `BunnyStreamPlayer`. Used to seek after restoring a position.
   */
  playerRef: React.RefObject<BunnyVodPlayerRef | null>;
  /** Video ID whose position should be tracked. */
  videoId: string;
  /** Optional video title for display in resume UIs. */
  videoTitle?: string;
  /** Resume configuration. Falls back to sensible defaults. */
  config?: ResumeConfig;
  /** Async storage implementation. Required on iOS; ignored on Android. */
  storage?: ResumePositionStorage;
  /**
   * Whether the native player is ready to accept a seek (i.e. `onReady` has
   * fired). Restores never seek before this is `true`; the pending position is
   * applied once it flips. When omitted, the hook falls back to "the player
   * ref is mounted", which is the best signal available without wiring
   * `onReady` through.
   */
  isReady?: boolean;
  /**
   * Called when a saved position is available to restore. Return `true` to
   * auto-seek, `false` to skip. Defaults to `true`.
   */
  onPositionAvailable?: (position: PlaybackPosition) => boolean | void;
}>;

/** Options for {@link UseResumePositionResult.savePosition}. */
export type SavePositionOptions = Readonly<{
  /**
   * `true` for a user-initiated save: bypasses the `saveIntervalMs` throttle
   * and re-enables tracking after `clearPosition`/`clearAllPositions`.
   * Default `false` (auto-save semantics).
   */
  manual?: boolean;
}>;

export type UseResumePositionResult = Readonly<{
  /** Last restored position, if any. Null until the player is ready. */
  restoredPosition: PlaybackPosition | null;
  /**
   * Save the current position. Auto-saves (the default) are throttled by
   * `saveIntervalMs`; pass `{ manual: true }` for user-initiated saves.
   */
  savePosition: (
    positionMs: number,
    durationMs: number,
    options?: SavePositionOptions,
  ) => Promise<void>;
  /** Clear the saved position for this video. */
  clearPosition: () => Promise<void>;
  /** Clear all saved positions. */
  clearAllPositions: () => Promise<void>;
  /** Get all saved positions (for resume UIs). */
  getAllPositions: () => Promise<PlaybackPosition[]>;
}>;

function shouldSave(
  positionMs: number,
  durationMs: number,
  config: Required<ResumeConfig>,
): boolean {
  if (durationMs <= 0) return false;
  const fraction = positionMs / durationMs;
  if (positionMs < config.minimumWatchMs) return false;
  if (fraction < config.resumeThreshold) return false;
  if (fraction >= config.nearEndThreshold) return false;
  return true;
}

interface PendingRestore {
  videoId: string;
  position: PlaybackPosition;
  shouldSeek: boolean;
  didSeek: boolean;
}

/**
 * iOS JavaScript fallback for resume position. No-op on Android (the native
 * SDK's `PlaybackPositionManager` handles persistence there).
 */
export function useResumePosition(options: UseResumePositionOptions): UseResumePositionResult {
  const { playerRef, videoId, videoTitle, config, storage, isReady, onPositionAvailable } = options;
  const resolvedConfig = React.useMemo<Required<ResumeConfig>>(
    () => ({ ...DEFAULT_CONFIG, ...config }),
    [config],
  );
  const [restoredPosition, setRestoredPosition] = React.useState<PlaybackPosition | null>(null);
  const lastSaveRef = React.useRef(0);

  // Keep the callback in a ref — callers commonly pass an inline function,
  // and depending on its identity would re-run the restore effect (and thus
  // re-fire `onPositionAvailable`) on every render.
  const onPositionAvailableRef = React.useRef(onPositionAvailable);
  onPositionAvailableRef.current = onPositionAvailable;

  // Identifies the restore attempt in flight. Bumped on every video switch /
  // unmount so a late storage read can never seek the wrong (previous) video.
  const restoreGenerationRef = React.useRef(0);
  const currentVideoIdRef = React.useRef(videoId);
  currentVideoIdRef.current = videoId;

  // The position loaded for the current video, whether it still needs a seek,
  // and whether it has already been applied. Kept in a ref so readiness /
  // re-render changes don't re-read storage or re-fire callbacks.
  const pendingRestoreRef = React.useRef<PendingRestore | null>(null);

  // Writes started before a clear; the clear waits for them so a late
  // auto-save cannot re-create the deleted entry.
  const inFlightWritesRef = React.useRef<Set<Promise<void>>>(new Set());
  // Process-wide clear epoch this playback session started from. Auto-saves
  // are suppressed when a `clearAll` happens after the session began.
  const sessionEpochRef = React.useRef(currentClearEpoch());

  const isReadyNow = React.useCallback(
    () => (typeof isReady === 'boolean' ? isReady : playerRef.current != null),
    [isReady, playerRef],
  );

  const trySeekRestored = React.useCallback(() => {
    if (Platform.OS === 'android') return;
    const pending = pendingRestoreRef.current;
    if (!pending || pending.didSeek || !pending.shouldSeek) return;
    if (pending.videoId !== currentVideoIdRef.current) return;
    if (!isReadyNow()) return;
    const player = playerRef.current;
    if (!player) return;
    pending.didSeek = true;
    player.seekTo(pending.position.positionMs);
  }, [isReadyNow, playerRef]);

  // Read in the restore effect without making readiness a dependency of it —
  // otherwise the player becoming ready would re-read storage and re-fire
  // `onPositionAvailable`.
  const trySeekRef = React.useRef(trySeekRestored);
  trySeekRef.current = trySeekRestored;

  // Restore on mount / videoId change (iOS only).
  React.useEffect(() => {
    if (Platform.OS === 'android') return;
    const generation = ++restoreGenerationRef.current;
    pendingRestoreRef.current = null;
    setRestoredPosition(null);
    lastSaveRef.current = 0;
    // A new playback session starts with a clean suppression state: clearing
    // progress for the previous video must not suppress saves for this one.
    allowAutoSave(videoId);
    sessionEpochRef.current = currentClearEpoch();
    if (!storage) return;
    void (async () => {
      const position = await getStoredPosition(storage, videoId);
      // Drop the result when the video changed or the component unmounted
      // while the read was in flight.
      if (generation !== restoreGenerationRef.current) return;
      if (!position) return;
      if (position.videoId !== videoId) return;
      if (isExpired(position, resolvedConfig.retentionDays)) {
        await clearStoredPosition(storage, videoId);
        return;
      }
      if (generation !== restoreGenerationRef.current) return;
      setRestoredPosition(position);
      const shouldSeek = onPositionAvailableRef.current?.(position) !== false;
      pendingRestoreRef.current = { videoId, position, shouldSeek, didSeek: false };
      trySeekRef.current();
    })();
    return () => {
      // Invalidate this attempt; also forget any pending seek so unmounting
      // can never leave a seek queued for a torn-down player.
      restoreGenerationRef.current += 1;
      pendingRestoreRef.current = null;
    };
    // `resolvedConfig.retentionDays` is primitive; the seek callback is read
    // via a ref so readiness changes never re-run the restore.
  }, [videoId, storage, resolvedConfig.retentionDays]);

  // Apply a restore that arrived before the player was ready.
  React.useEffect(() => {
    if (isReady) trySeekRestored();
  }, [isReady, trySeekRestored]);

  const savePosition = React.useCallback(
    async (positionMs: number, durationMs: number, saveOptions?: SavePositionOptions) => {
      if (Platform.OS === 'android') return;
      if (!storage) return;
      const manual = saveOptions?.manual === true;
      if (!shouldSave(positionMs, durationMs, resolvedConfig)) return;

      if (!manual) {
        if (!resolvedConfig.enableAutoSave) return;
        if (isAutoSaveSuppressed(videoId, sessionEpochRef.current)) return;
        const now = Date.now();
        if (now - lastSaveRef.current < resolvedConfig.saveIntervalMs) return;
      }

      // A manual save is an explicit user intent — it resumes tracking for
      // this video (and re-syncs the session if `clearAll` ran meanwhile).
      if (manual) {
        allowAutoSave(videoId);
        sessionEpochRef.current = currentClearEpoch();
      }

      const now = Date.now();
      lastSaveRef.current = now;
      const position: PlaybackPosition = {
        videoId,
        positionMs,
        durationMs,
        watchPercentage: durationMs > 0 ? positionMs / durationMs : 0,
        timestamp: now,
        videoTitle,
      };
      const write = storage
        .setItem(storageKey(videoId), JSON.stringify(position))
        .catch(() => undefined);
      inFlightWritesRef.current.add(write);
      try {
        await write;
      } finally {
        inFlightWritesRef.current.delete(write);
      }
    },
    [storage, videoId, videoTitle, resolvedConfig],
  );

  const clearPosition = React.useCallback(async () => {
    markPositionCleared(videoId);
    if (!storage) {
      setRestoredPosition(null);
      return;
    }
    await clearStoredPosition(storage, videoId);
    pendingRestoreRef.current = null;
    setRestoredPosition(null);
  }, [storage, videoId]);

  const clearAllPositions = React.useCallback(async () => {
    // Bump the process-wide epoch so every live session's next auto-save is
    // suppressed — including this one, whose video is still playing. Tracking
    // resumes only on a manual save or a new playback session.
    markAllPositionsCleared();
    pendingRestoreRef.current = null;
    setRestoredPosition(null);
    if (!storage) return;
    // Wait for writes that already started (they may have been triggered by a
    // progress tick just before the clear) before removing everything, so the
    // final state is empty.
    await Promise.all([...inFlightWritesRef.current]);
    await clearAllStoredPositions(storage);
  }, [storage]);

  const getAllPositions = React.useCallback(async (): Promise<PlaybackPosition[]> => {
    if (!storage) return [];
    return getAllStoredPositions(storage, resolvedConfig.retentionDays);
  }, [storage, resolvedConfig.retentionDays]);

  return { restoredPosition, savePosition, clearPosition, clearAllPositions, getAllPositions };
}
