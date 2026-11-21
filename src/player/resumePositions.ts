import type { PlaybackPosition } from './BunnyStreamPlayer.types';
import type { ResumePositionStorage } from './hooks/resumeStorage';

import { Platform } from 'react-native';

import NativeBunnyStreamPlayer from '../specs/NativeBunnyStreamPlayer';
import {
  clearAllStoredPositions,
  clearStoredPosition,
  cleanupExpiredStoredPositions,
  DEFAULT_RETENTION_DAYS,
  getAllStoredPositions,
  importStoredPositions,
  isExpired,
  mergePositions,
  normalizePosition,
} from './hooks/resumeStorage';

/**
 * Platform-agnostic resume-position management.
 *
 * On Android these delegate to the native SDK's `PlaybackPositionManager`
 * (SharedPreferences `"bunny_resume_positions"`). On iOS the SDK exposes no
 * resume API, so the same operations run against the pluggable async storage
 * used by `useResumePosition` (typically
 * `@react-native-async-storage/async-storage`) — pass it via `storage`.
 *
 * Both platforms share the same public contract:
 * - entries are the normalized {@link PlaybackPosition} shape;
 * - expired entries (`retentionDays`, default 7) are never listed or imported;
 * - imports merge by `videoId`, keeping the newest `timestamp`, skip invalid
 *   entries individually, and still succeed when at least the payload is an
 *   array of positions.
 */

/**
 * Reads the Android SDK's saved positions and normalizes them. Shared by the
 * list/import paths so both apply the same validation.
 */
async function readAndroidPositions(): Promise<PlaybackPosition[]> {
  const json = await NativeBunnyStreamPlayer.getAllSavedPositions();
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizePosition)
      .filter((p): p is PlaybackPosition => p !== null);
  } catch {
    return [];
  }
}

/**
 * Lists all saved positions, newest first. Expired entries are excluded on
 * both platforms.
 */
export async function getAllResumePositions(
  storage?: ResumePositionStorage,
): Promise<PlaybackPosition[]> {
  if (Platform.OS === 'android') {
    const positions = await readAndroidPositions();
    return positions
      .filter((p) => !isExpired(p, DEFAULT_RETENTION_DAYS))
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  if (!storage) return [];
  return getAllStoredPositions(storage, DEFAULT_RETENTION_DAYS);
}

/** Deletes the saved position for a single video. */
export async function clearResumePosition(
  videoId: string,
  storage?: ResumePositionStorage,
): Promise<void> {
  if (Platform.OS === 'android') {
    return NativeBunnyStreamPlayer.clearSavedPosition(videoId);
  }
  if (!storage) return;
  return clearStoredPosition(storage, videoId);
}

/** Deletes every saved position. */
export async function clearAllResumePositions(
  storage?: ResumePositionStorage,
): Promise<void> {
  if (Platform.OS === 'android') {
    return NativeBunnyStreamPlayer.clearAllSavedPositions();
  }
  if (!storage) return;
  return clearAllStoredPositions(storage);
}

/**
 * Exports all positions as a JSON array of `PlaybackPosition` (the public,
 * normalized shape — portable across platforms).
 */
export async function exportResumePositions(
  storage?: ResumePositionStorage,
): Promise<string> {
  const positions = await getAllResumePositions(storage);
  return JSON.stringify(positions);
}

/**
 * Imports positions (merge by `videoId`, newest `timestamp` wins). Accepts the
 * normalized `PlaybackPosition[]` shape produced by
 * {@link exportResumePositions}; on Android it is translated to the SDK's
 * `position`/`duration` field names before delegating.
 *
 * - Invalid entries (missing/empty `videoId`, negative or non-numeric
 *   `positionMs`/`durationMs`, invalid `timestamp`) are skipped individually.
 * - Expired entries are dropped.
 * - Returns `false` only when the payload is not a JSON array; otherwise it
 *   returns `true` even when some entries were skipped.
 */
export async function importResumePositions(
  jsonData: string,
  storage?: ResumePositionStorage,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;

  if (Platform.OS === 'android') {
    // Translate the public shape to the SDK model (position/duration names),
    // dropping invalid/expired entries. Merge against the SDK's current
    // positions so a stale import cannot roll a fresher local entry back —
    // this mirrors the iOS storage path.
    const parsedById = new Map<string, PlaybackPosition>();
    for (const item of parsed as unknown[]) {
      const position = normalizePosition(item);
      if (!position || isExpired(position, DEFAULT_RETENTION_DAYS)) continue;
      const current = parsedById.get(position.videoId);
      if (!current || position.timestamp >= current.timestamp) {
        parsedById.set(position.videoId, position);
      }
    }
    const existing = await readAndroidPositions();
    const merged = mergePositions(
      existing.filter((p) => !isExpired(p, DEFAULT_RETENTION_DAYS)),
      parsedById.values(),
    );
    const sdkPositions = merged.map((p) => ({
      videoId: p.videoId,
      position: p.positionMs,
      duration: p.durationMs,
      timestamp: p.timestamp,
      watchPercentage: p.watchPercentage,
      videoTitle: p.videoTitle ?? '',
    }));
    return NativeBunnyStreamPlayer.importPositions(JSON.stringify(sdkPositions));
  }

  if (!storage) return false;
  return importStoredPositions(storage, jsonData, DEFAULT_RETENTION_DAYS);
}

/**
 * Deletes positions older than `retentionDays` (default 7 — the SDK default).
 */
export async function cleanupExpiredResumePositions(
  storage?: ResumePositionStorage,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<void> {
  if (Platform.OS === 'android') {
    return NativeBunnyStreamPlayer.cleanupExpiredPositions();
  }
  if (!storage) return;
  await cleanupExpiredStoredPositions(storage, retentionDays);
}
