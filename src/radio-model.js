// The radio timeline, shared by the browser (src/radio.js) and the room server
// (worker/index.js). Everything here is pure (no DOM, no timers, no storage), so
// both ends compute the exact same answer and it can be tested locally:
//
//   node --test test/
//
// The room state is:
//   - a command: "track <idx> started at <at>" (null = the radio's default loop
//     from DEFAULT_START), plus the playlist it refers to;
//   - a duration table: video id -> seconds, learned from YouTube players and
//     kept by the server so a late joiner can replay the same timeline.
//
// Position = (now - at) walked through the playlist using the real durations.
// Unknown durations are only a last-resort placeholder; they never overwrite a
// duration reported by the server or by the player.

export const PLAYLIST = [
  "x6ujm9B-vAc",
  // add more YouTube IDs here
];

export const DEFAULT_START = Date.UTC(2026, 0, 1); // radio's time zero
export const FALLBACK_DURATION = 3600; // only until a real duration is known
export const MIN_DURATION = 1; // seconds; shorter values are not real tracks
export const MAX_DURATION = 12 * 60 * 60; // 12 h; keeps a bad report bounded
export const MAX_TRACKS = 100;
export const SEEK_TOLERANCE = 3; // seconds of drift before correcting
export const SEEK_TOLERANCE_DEFAULT_TRACK = 15; // longer tracks drift more in practice
export const COMMAND_VERSION = 1;

// The YouTube iframe API states, mirrored here so playback decisions are pure.
export const YT = Object.freeze({
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const seconds = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : NaN;
};

/** A stable list of video ids, falling back to `fallback` when the input is unusable. */
export function sanitizePlaylist(list, fallback = PLAYLIST) {
  const take = (source) => {
    const out = [];
    if (!Array.isArray(source)) return out;
    for (const raw of source) {
      if (out.length >= MAX_TRACKS) break;
      const id = String(raw ?? "");
      if (ID_RE.test(id)) out.push(id); // duplicates are allowed on purpose
    }
    return out;
  };
  const out = take(list);
  return out.length ? out : take(fallback);
}

/** Keep only real durations of tracks in `playlist`, in seconds and within bounds. */
export function sanitizeDurations(raw, playlist = PLAYLIST) {
  const allowed = new Set(sanitizePlaylist(playlist));
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!allowed.has(id)) continue;
    const n = seconds(value);
    if (Number.isFinite(n) && n >= MIN_DURATION && n <= MAX_DURATION) out[id] = n;
  }
  return out;
}

/** Merge duration tables; later tables win, invalid values are dropped. */
export function mergeDurations(...tables) {
  const out = {};
  for (const table of tables) {
    if (!table || typeof table !== "object") continue;
    for (const [id, value] of Object.entries(table)) {
      const n = seconds(value);
      if (Number.isFinite(n) && n >= MIN_DURATION && n <= MAX_DURATION) out[id] = n;
    }
  }
  return out;
}

/**
 * Validate a command coming from storage, the cache or the network.
 * Returns null for anything without a usable timestamp; legacy `{ idx, at }`
 * commands are upgraded with the fallback playlist and an empty duration table.
 */
export function normalizeCommand(raw, fallbackPlaylist = PLAYLIST) {
  if (!raw || typeof raw !== "object") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const playlist = sanitizePlaylist(raw.playlist, fallbackPlaylist);
  if (!playlist.length) return null;
  const idxRaw = Number(raw.idx);
  const idx = Number.isFinite(idxRaw)
    ? ((Math.floor(idxRaw) % playlist.length) + playlist.length) % playlist.length
    : 0;
  const revRaw = Number(raw.rev);
  const rev = Number.isFinite(revRaw) && revRaw >= 0 ? Math.floor(revRaw) : 0;
  return {
    v: COMMAND_VERSION,
    idx,
    at,
    rev,
    playlist,
    durations: sanitizeDurations(raw.durations, playlist),
    skipped: sanitizeSkipped(raw.skipped, playlist),
  };
}

/** Tracks the room agreed are unplayable (embed off / unavailable), in playlist order. */
export function sanitizeSkipped(raw, playlist = PLAYLIST) {
  const allowed = new Set(sanitizePlaylist(playlist));
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const value of raw) {
    const id = String(value ?? "");
    if (allowed.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The next command after an admin action. `rev` grows so the newest command is
 * identifiable after a reconnect; `at` is when the new track starts. The
 * unplayable list is cleared: an explicit admin action is the undo for a track
 * someone reported as broken (clients that still cannot play it re-report it).
 */
export function buildCommand({
  prev = null,
  idx = 0,
  at = Date.now(),
  playlist = PLAYLIST,
  durations = {},
  skipped = [],
} = {}) {
  const list = sanitizePlaylist(playlist, prev?.playlist || PLAYLIST);
  const known = mergeDurations(prev?.durations, sanitizeDurations(durations, list));
  const rev = (Number(prev?.rev) || 0) + 1;
  return normalizeCommand(
    { idx, at, rev, playlist: list, durations: known, skipped: sanitizeSkipped(skipped, list) },
    list,
  );
}

/** Effective duration: 0 when the track is unplayable (room report or local error). */
export function durationOf(id, { durations = {}, skipped = null } = {}) {
  const skip = skipped instanceof Set ? skipped : Array.isArray(skipped) ? skipped : null;
  if (skip && (skip.has?.(id) || skip.includes?.(id))) return 0;
  const known = seconds(durations?.[id]);
  if (Number.isFinite(known) && known >= MIN_DURATION && known <= MAX_DURATION) return known;
  return FALLBACK_DURATION;
}

/**
 * The one and only timeline calculation. Given the room command, the merged
 * duration table, the current time, and any extra ids this player could not
 * play, returns the track and second everyone in the room should be hearing:
 *
 *   { idx, videoId, sec, duration, blocked }
 *
 * Unplayable tracks (in the command's `skipped` list, or passed in `skipped`)
 * count as zero-length and are walked past. If every track is unplayable,
 * `blocked` is true and there is nothing to play.
 */
export function resolvePosition({
  command = null,
  durations = {},
  skipped = null,
  now = Date.now(),
  playlist = PLAYLIST,
} = {}) {
  const list = sanitizePlaylist(command?.playlist, playlist);
  if (!list.length) return { idx: 0, videoId: "", sec: 0, duration: 0, blocked: true };
  const cmd = command ? normalizeCommand({ ...command, playlist: list }, list) : null;
  if (command && !cmd) return { idx: 0, videoId: list[0], sec: 0, duration: 0, blocked: true };
  const local = skipped instanceof Set ? [...skipped] : Array.isArray(skipped) ? skipped : [];
  const dead = new Set([...(cmd?.skipped || []), ...local]);
  const merged = mergeDurations(durations, cmd?.durations); // the command's snapshot as a floor
  const lengths = list.map((id) => durationOf(id, { durations: merged }));
  const total = list.reduce((sum, id, i) => (dead.has(id) ? sum : sum + lengths[i]), 0);

  if (!(total > 0)) {
    const idx = cmd ? cmd.idx : 0;
    return { idx, videoId: list[idx], sec: 0, duration: 0, blocked: true };
  }

  const start = cmd ? cmd.idx : 0;
  const since = cmd ? (now - cmd.at) / 1000 : (now - DEFAULT_START) / 1000;
  let elapsed = Number.isFinite(since) && since > 0 ? since : 0;
  // A full loop costs `total` and lands on the same track, so drop whole loops
  // instead of walking years of history (skipped tracks are already 0-length).
  elapsed %= total;

  let last = -1;
  for (let n = 0; n < list.length; n++) {
    const idx = (start + n) % list.length;
    if (dead.has(list[idx])) continue;
    const d = lengths[idx];
    last = idx;
    if (elapsed < d) {
      return {
        idx,
        videoId: list[idx],
        sec: Math.max(0, Math.min(elapsed, d)),
        duration: d,
        blocked: false,
      };
    }
    elapsed -= d;
  }
  // Floating-point edge: elapsed was a hair below `total` and fell through.
  const idx = last < 0 ? start : last;
  const d = lengths[idx] || FALLBACK_DURATION;
  return { idx, videoId: list[idx], sec: Math.max(0, d - 1e-9), duration: d, blocked: false };
}

/**
 * What to do with the player for a target. Pure so the single-track case is
 * testable: the same video id at a different position is a SEEK, never a no-op
 * ("it's already that video"). ENDED/CUED/UNSTARTED always need a seek too.
 */
export function decidePlaybackAction({
  targetVideoId = "",
  currentVideoId = "",
  targetSeconds = 0,
  currentSeconds = 0,
  playerState = YT.UNSTARTED,
  paused = false,
  tolerance = SEEK_TOLERANCE,
  force = false,
} = {}) {
  if (!targetVideoId) return { type: "none", seconds: 0 };
  if (!currentVideoId || targetVideoId !== currentVideoId) {
    return { type: "load", seconds: targetSeconds };
  }
  if (
    force ||
    playerState === YT.ENDED ||
    playerState === YT.UNSTARTED ||
    playerState === YT.CUED
  ) {
    return { type: "seek", seconds: targetSeconds };
  }
  if (Number.isFinite(currentSeconds) && Math.abs(currentSeconds - targetSeconds) > tolerance) {
    return { type: "seek", seconds: targetSeconds };
  }
  if (!paused && playerState !== YT.PLAYING && playerState !== YT.BUFFERING) {
    return { type: "play", seconds: targetSeconds };
  }
  return { type: "none", seconds: targetSeconds };
}
