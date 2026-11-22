/*
 * Neovid core playback-session and recent-list logic.
 *
 * This module is pure and environment-agnostic: it is exposed as
 * `window.NeovidCore` in the browser and as a CommonJS module in Node.js
 * so the same logic that guards the player can be unit-tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NeovidCore = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const RECENT_LIMIT = 30;

  /**
   * Monotonic session-generation counter. Every play/resume begins a new
   * session; callbacks created for an older generation must be discarded.
   */
  function createSessionGuard() {
    let generation = 0;
    return {
      /** Start a new session and return its generation id. */
      begin() {
        generation += 1;
        return generation;
      },
      /** Current (latest) generation id. */
      current() {
        return generation;
      },
      /** True only when `gen` is the live generation. */
      isCurrent(gen) {
        return gen === generation;
      }
    };
  }

  /**
   * Wrap `callback` so it runs only while `generation` is still current.
   * Stale calls are dropped silently and return `undefined`.
   */
  function guardCallback(guard, generation, callback) {
    return function (...args) {
      if (!guard.isCurrent(generation)) {
        return undefined;
      }
      return callback.apply(this, args);
    };
  }

  /** Clamp a progress value to an integer percentage in [0, 100]. */
  function clampProgress(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  /**
   * Stable identity of a recent entry. For URL videos the URL itself is
   * stable. For local files the blob: URL changes on every selection, so
   * the file name (stored as the title) is the stable identifier.
   */
  function getEntryId(item) {
    if (!item) {
      return "";
    }
    if (item.videoType === "local") {
      return "local:" + (item.title || "");
    }
    return "url:" + (item.video || "");
  }

  function normalizeEntry(entry) {
    return {
      title: typeof entry.title === "string" ? entry.title : "",
      video: typeof entry.video === "string" ? entry.video : "",
      videoType: entry.videoType === "local" ? "local" : "url",
      subtitle: typeof entry.subtitle === "string" ? entry.subtitle : "",
      subtitleType: entry.subtitleType === "local" ? "local" : "url",
      progress: clampProgress(entry.progress)
    };
  }

  /**
   * Insert or update a recent entry, keyed by its stable id. Re-playing the
   * same video moves the existing entry to the top and keeps its progress
   * instead of adding a duplicate. The list is capped at `limit` entries.
   */
  function upsertRecent(recent, entry, limit = RECENT_LIMIT) {
    const list = Array.isArray(recent) ? recent.slice() : [];
    const id = getEntryId(entry);
    const existing = list.find((item) => getEntryId(item) === id);
    const merged = normalizeEntry(entry);
    if (existing) {
      merged.progress = clampProgress(existing.progress);
    }
    const kept = list.filter((item) => getEntryId(item) !== id);
    kept.unshift(merged);
    return kept.slice(0, limit);
  }

  /** Remove the entry with the given stable id. */
  function removeRecentById(recent, id) {
    const list = Array.isArray(recent) ? recent : [];
    return list.filter((item) => getEntryId(item) !== id);
  }

  /** Find an entry by stable id, or -1. */
  function findRecentIndex(recent, id) {
    const list = Array.isArray(recent) ? recent : [];
    return list.findIndex((item) => getEntryId(item) === id);
  }

  function isValidImportEntry(item) {
    return Boolean(item) &&
      typeof item === "object" &&
      typeof item.title === "string" &&
      typeof item.video === "string" &&
      (item.videoType === "url" || item.videoType === "local") &&
      (item.subtitle == null || typeof item.subtitle === "string") &&
      (item.subtitleType == null ||
        item.subtitleType === "url" ||
        item.subtitleType === "local") &&
      typeof item.progress === "number" &&
      Number.isFinite(item.progress);
  }

  /**
   * Validate and normalize imported recent data: entries are deduplicated
   * by stable id (first occurrence wins), progress is clamped to 0-100 and
   * the result is truncated to `limit` entries. Returns `null` when the
   * data is not a valid recent list.
   */
  function normalizeImport(data, limit = RECENT_LIMIT) {
    if (!Array.isArray(data)) {
      return null;
    }
    if (!data.every(isValidImportEntry)) {
      return null;
    }
    const seen = new Set();
    const items = [];
    for (const raw of data) {
      const entry = normalizeEntry(raw);
      const id = getEntryId(entry);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      items.push(entry);
      if (items.length >= limit) {
        break;
      }
    }
    return items;
  }

  return {
    RECENT_LIMIT,
    createSessionGuard,
    guardCallback,
    clampProgress,
    getEntryId,
    upsertRecent,
    removeRecentById,
    findRecentIndex,
    normalizeImport
  };
});
