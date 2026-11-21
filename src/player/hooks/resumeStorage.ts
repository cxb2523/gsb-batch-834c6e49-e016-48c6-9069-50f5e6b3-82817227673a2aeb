import type { PlaybackPosition } from '../BunnyStreamPlayer.types';

/**
 * Minimal async key-value storage interface. Matches the subset of
 * `@react-native-async-storage/async-storage` used by the resume fallback.
 */
export interface ResumePositionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet?(keys: readonly string[]): Promise<readonly [string, string | null][]>;
}

export const STORAGE_PREFIX = '@bunny_resume_positions:';

/** Default retention window, matching the Android SDK's `ResumeConfig`. */
export const DEFAULT_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export const storageKey = (videoId: string) => `${STORAGE_PREFIX}${videoId}`;

/** True when [position] is older than [retentionDays] (a non-positive value disables expiry). */
export function isExpired(
  position: PlaybackPosition,
  retentionDays: number,
  now = Date.now(),
): boolean {
  if (!(retentionDays > 0)) return false;
  return now - position.timestamp > retentionDays * DAY_MS;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates an unknown value and coerces it to the public
 * {@link PlaybackPosition} shape. Returns `null` for entries that cannot be
 * migrated safely (missing/empty `videoId`, non-numeric or negative
 * `positionMs`/`durationMs`, invalid `timestamp`).
 *
 * Only the public fields are kept so exported payloads stay portable between
 * iOS storage and the Android SDK model.
 */
export function normalizePosition(value: unknown): PlaybackPosition | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const { videoId, positionMs, durationMs, timestamp } = record;
  if (typeof videoId !== 'string' || videoId.length === 0) return null;
  if (!isNonNegativeFiniteNumber(positionMs)) return null;
  if (!isNonNegativeFiniteNumber(durationMs)) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;

  const watchPercentage =
    typeof record.watchPercentage === 'number' && Number.isFinite(record.watchPercentage)
      ? record.watchPercentage
      : durationMs > 0
        ? positionMs / durationMs
        : 0;
  const videoTitle = typeof record.videoTitle === 'string' ? record.videoTitle : undefined;
  return {
    videoId,
    positionMs,
    durationMs,
    watchPercentage,
    timestamp,
    ...(videoTitle !== undefined && { videoTitle }),
  };
}

function parsePosition(json: string | null | undefined): PlaybackPosition | null {
  if (!json) return null;
  try {
    return normalizePosition(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Merges position lists by `videoId`, keeping the entry with the newest
 * `timestamp` (an equal timestamp favours the later list, i.e. `incoming`).
 * The result is sorted newest first.
 */
export function mergePositions(
  existing: Iterable<PlaybackPosition>,
  incoming: Iterable<PlaybackPosition>,
): PlaybackPosition[] {
  const byVideoId = new Map<string, PlaybackPosition>();
  for (const position of [...existing, ...incoming]) {
    const current = byVideoId.get(position.videoId);
    if (!current || position.timestamp >= current.timestamp) {
      byVideoId.set(position.videoId, position);
    }
  }
  return [...byVideoId.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export async function getStoredPosition(
  storage: ResumePositionStorage,
  videoId: string,
): Promise<PlaybackPosition | null> {
  try {
    return parsePosition(await storage.getItem(storageKey(videoId)));
  } catch {
    return null;
  }
}

async function readEntries(
  storage: ResumePositionStorage,
  keys: readonly string[],
): Promise<Array<[string, string | null]>> {
  if (storage.multiGet) {
    const entries = await storage.multiGet(keys);
    return entries.map(([key, json]) => [key, json]);
  }
  return Promise.all(
    keys.map(async (key) => [key, await storage.getItem(key)] as [string, string | null]),
  );
}

export async function getAllStoredPositions(
  storage: ResumePositionStorage,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<PlaybackPosition[]> {
  const keys = await storage.getAllKeys();
  const resumeKeys = keys.filter((k) => k.startsWith(STORAGE_PREFIX));
  if (resumeKeys.length === 0) return [];
  const entries = await readEntries(storage, resumeKeys);
  const positions: PlaybackPosition[] = [];
  for (const [, json] of entries) {
    const position = parsePosition(json);
    if (!position) continue;
    if (!isExpired(position, retentionDays)) positions.push(position);
  }
  return positions.sort((a, b) => b.timestamp - a.timestamp);
}

export async function clearStoredPosition(
  storage: ResumePositionStorage,
  videoId: string,
): Promise<void> {
  await storage.removeItem(storageKey(videoId));
}

// --- Auto-save suppression after an explicit clear ---
//
// Clearing progress is an explicit user action. Auto-save ticks that were
// already scheduled (or come from a still-mounted player) must not recreate
// the entries that were just deleted. This registry is process-wide so a clear
// performed from a resume-management screen also stops the live player's
// auto-save. Suppression ends when the user saves manually or a new playback
// session starts for that video.

let clearEpoch = 0;
const clearedVideos = new Set<string>();

/** Monotonic counter bumped by {@link markAllPositionsCleared}. */
export function currentClearEpoch(): number {
  return clearEpoch;
}

/** Marks every saved position as deliberately cleared. */
export function markAllPositionsCleared(): void {
  clearEpoch += 1;
}

/** Marks a single video's position as deliberately cleared. */
export function markPositionCleared(videoId: string): void {
  clearedVideos.add(videoId);
}

/** Re-allows auto-save for [videoId] (manual save or a new playback session). */
export function allowAutoSave(videoId: string): void {
  clearedVideos.delete(videoId);
}

/**
 * `true` when an auto-save for [videoId] must be skipped: the video was
 * cleared individually, or `clearAll` ran after the caller's session started
 * (its captured epoch no longer matches).
 */
export function isAutoSaveSuppressed(videoId: string, sessionEpoch: number): boolean {
  return clearedVideos.has(videoId) || sessionEpoch !== clearEpoch;
}

export async function clearAllStoredPositions(storage: ResumePositionStorage): Promise<void> {
  const keys = await storage.getAllKeys();
  await Promise.all(
    keys.filter((k) => k.startsWith(STORAGE_PREFIX)).map((k) => storage.removeItem(k)),
  );
}

/**
 * Deletes positions older than `retentionDays`. Returns the number removed.
 */
export async function cleanupExpiredStoredPositions(
  storage: ResumePositionStorage,
  retentionDays: number,
): Promise<number> {
  const keys = await storage.getAllKeys();
  const resumeKeys = keys.filter((k) => k.startsWith(STORAGE_PREFIX));
  const entries = await readEntries(storage, resumeKeys);
  const removals: Promise<void>[] = [];
  for (const [key, json] of entries) {
    if (!json) continue;
    const position = parsePosition(json);
    // Malformed payloads are removed too — they can never be restored.
    if (position && !isExpired(position, retentionDays)) continue;
    removals.push(storage.removeItem(key));
  }
  await Promise.all(removals);
  return removals.length;
}

/**
 * Imports positions (merge by `videoId`) into storage.
 *
 * - Malformed entries (see {@link normalizePosition}) and entries older than
 *   `retentionDays` are skipped individually; valid entries are still written.
 * - Entries already stored for the same video are only replaced when the
 *   imported `timestamp` is at least as new, so a stale import cannot roll a
 *   fresher local position back.
 *
 * Returns `false` only when the payload is not a JSON array.
 */
export async function importStoredPositions(
  storage: ResumePositionStorage,
  jsonData: string,
  retentionDays = DEFAULT_RETENTION_DAYS,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonData);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;

  // Validate + drop expired entries, keeping the newest entry per video.
  const incoming = new Map<string, PlaybackPosition>();
  for (const item of parsed as unknown[]) {
    const position = normalizePosition(item);
    if (!position || isExpired(position, retentionDays)) continue;
    const current = incoming.get(position.videoId);
    if (!current || position.timestamp >= current.timestamp) {
      incoming.set(position.videoId, position);
    }
  }
  if (incoming.size === 0) return true;

  const ids = [...incoming.keys()];
  const keys = ids.map(storageKey);
  const existingEntries = await readEntries(storage, keys);
  const existingByKey = new Map(existingEntries);

  const writes: Promise<void>[] = [];
  for (const [index, videoId] of ids.entries()) {
    const existing = parsePosition(existingByKey.get(keys[index]!) ?? null);
    const candidate = incoming.get(videoId)!;
    // A fresher, still-valid local position wins over an older imported one.
    if (existing && !isExpired(existing, retentionDays) && existing.timestamp > candidate.timestamp) {
      continue;
    }
    writes.push(storage.setItem(storageKey(videoId), JSON.stringify(candidate)));
  }
  await Promise.all(writes);
  // Importing progress is an explicit action — resume auto-save tracking for
  // the videos that were just restored.
  for (const videoId of ids) allowAutoSave(videoId);
  return true;
}
