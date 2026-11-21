// The radio's state machine, with no DOM and no YouTube types so it can run in
// Node with a fake player adapter:
//
//   node --test test/
//
// It owns the single source of truth for playback (the room command + the
// duration table) and drives one player through a small adapter:
//
//   { getVideoId(), getCurrentTime(), getState(),
//     load(videoId, seconds), seek(seconds), play(), pause() }
//
// Every desync event — admin switch, video ENDED, a duration arriving late, an
// embed error, a reconnect — funnels through sync(), which re-runs the same
// resolver and applies only the difference. That is what makes all clients,
// and all recovery paths, converge on the same track and second.

import {
  PLAYLIST,
  MAX_DURATION,
  MIN_DURATION,
  YT,
  buildCommand,
  decidePlaybackAction,
  mergeDurations,
  normalizeCommand,
  resolvePosition,
  sanitizeDurations,
  sanitizePlaylist,
  sanitizeSkipped,
} from "./radio-model.js";

const LOAD_RETRY_MS = 10_000; // re-issue a load that never landed after this long

export function createRadioCore(options = {}) {
  const {
    playlist = PLAYLIST,
    now = () => Date.now(),
    onTitle = () => {},
    onCover = () => {},
    onDurations = () => {}, // a duration report for the room (late joiners)
    onSkip = () => {}, // this player found a track unplayable: tell the room
  } = options;

  let list = sanitizePlaylist(options.command?.playlist ?? playlist);
  let command = normalizeCommand(options.command ?? null, list);
  const learned = {}; // id -> seconds learned from this player
  const skipped = new Set(); // ids this player could not play
  let adapter = null;
  let ready = false;
  let paused = false;
  let playingIdx = -1;
  let playingVideoId = "";
  let pendingLoad = null; // { videoId, at }
  let pendingSeek = false; // a command just changed: the same video must be seeked
  function durationTable() {
    // the room's table wins over what this tab learned, so every client that has
    // the same command also has the same lengths (a learned value only fills a
    // gap the room doesn't know yet)
    return mergeDurations(learned, command?.durations);
  }

  function target(time = now()) {
    return resolvePosition({ command, durations: durationTable(), skipped, now: time, playlist: list });
  }

  // Two commands describe the same track start when idx and at match; `rev` only
  // orders duration updates for that same start. A duration update must not
  // reset the little TV.
  const sameStart = (a, b) => !!a && !!b && a.idx === b.idx && a.at === b.at;

  function resetTrackUi(videoId) {
    playingVideoId = videoId || "";
    pendingLoad = null;
    pendingSeek = !!videoId;
    onTitle("");
    onCover({ playing: false, videoId: videoId || "" });
  }

  // Fold a duration this player learned into the command so it survives a
  // reconnect, and report it so the room's table can serve late joiners. Never
  // overwrites a value the command already has (that table is the room's).
  // One report per id per session: `learned` is the guard against loops.
  function learnDuration(id, duration) {
    const n = Number(duration);
    if (!id || !Number.isFinite(n) || n < MIN_DURATION || n > MAX_DURATION) return false;
    const value = Math.round(n * 1000) / 1000;
    if (learned[id] === value) return false;
    learned[id] = value;
    try { onDurations({ [id]: value }); } catch {}
    if (command && !(id in (command.durations || {}))) {
      const durations = mergeDurations(command.durations, sanitizeDurations({ [id]: value }, list));
      const next = normalizeCommand({ ...command, durations }, list);
      if (next) command = next;
    }
    return true;
  }

  function sync() {
    if (!ready || paused || !adapter) return;
    const t = target();
    if (t.blocked) {
      onTitle("radio unavailable");
      onCover({ playing: false, videoId: "" });
      pendingSeek = false;
      return;
    }

    let currentVideoId = "";
    let currentSeconds = 0;
    let state = YT.UNSTARTED;
    try {
      currentVideoId = adapter.getVideoId() || "";
      currentSeconds = adapter.getCurrentTime() || 0;
      state = adapter.getState();
    } catch {}

    if (pendingLoad) {
      const landed =
        currentVideoId === pendingLoad.videoId ||
        // before the iframe reports any video data, playing/buffering means the
        // load we issued is the one that is running
        (!currentVideoId &&
          t.videoId === pendingLoad.videoId &&
          (state === YT.PLAYING || state === YT.BUFFERING));
      const stuck = t.videoId !== pendingLoad.videoId || now() - pendingLoad.at > LOAD_RETRY_MS;
      if (landed) pendingLoad = null; // the load arrived: normal corrections resume
      else if (!stuck) {
        playingIdx = t.idx; // still loading the right video: nothing to do yet
        return;
      } else pendingLoad = null; // target changed or the load never landed: retry below
    }

    const a = decidePlaybackAction({
      targetVideoId: t.videoId,
      currentVideoId,
      targetSeconds: t.sec,
      currentSeconds,
      playerState: state,
      paused,
      // after an admin switch the target can be the same video id (one-track
      // playlist, restart): that is a seek, never "already playing that song"
      force: pendingSeek && currentVideoId === t.videoId,
    });

    if (a.type === "load") {
      playingIdx = t.idx;
      playingVideoId = t.videoId;
      pendingSeek = false;
      onTitle("");
      onCover({ playing: false, videoId: t.videoId });
      pendingLoad = { videoId: t.videoId, at: now() };
      adapter.load(t.videoId, Math.floor(a.seconds));
    } else if (a.type === "seek") {
      playingIdx = t.idx;
      pendingSeek = false;
      if (playingVideoId !== t.videoId) {
        playingVideoId = t.videoId;
        onCover({ playing: false, videoId: t.videoId });
      }
      adapter.seek(a.seconds);
      if (state === YT.ENDED || state === YT.UNSTARTED || state === YT.CUED) adapter.play();
    } else if (a.type === "play") {
      adapter.play();
    }
    if (playingIdx < 0) playingIdx = t.idx;
  }

  return {
    /** Bind the player adapter (call once the player exists). */
    attach(a) {
      adapter = a;
    },

    /** Player ready: start driving it to the resolved position. */
    ready() {
      ready = true;
      sync();
    },

    /**
     * The server's command (or a local one). A different track start is always
     * accepted — the server is the source of truth and the WebSocket is ordered;
     * for the same start, only a revision/duration that adds information wins.
     * `snapshot` (sent right after connecting) replaces anything, so a stale
     * local cache can never override the room.
     */
    setCommand(raw, { snapshot = false } = {}) {
      const incoming = normalizeCommand(raw, list);
      if (!incoming) return false;
      if (!snapshot && command && !newerThan(command, incoming)) return false;
      const changed = !sameStart(command, incoming);
      command = incoming;
      list = incoming.playlist;
      if (changed) resetTrackUi(target().videoId);
      sync();
      return true;
    },

    /** A duration-only update for the current command (the room's table wins). */
    applyDurations(table) {
      if (!command) return false;
      const merged = mergeDurations(command.durations, sanitizeDurations(table, list));
      const next = normalizeCommand({ ...command, durations: merged }, list);
      if (!next) return false;
      if (JSON.stringify(next.durations) === JSON.stringify(command.durations)) return false;
      command = next;
      sync();
      return true;
    },

    /** A skip list update for the current command (the room's list wins). */
    applySkipped(list_) {
      if (!command) return false;
      const merged = [...new Set([...(command.skipped || []), ...sanitizeSkipped(list_, list)])];
      if (merged.length === (command.skipped || []).length) return false;
      const next = normalizeCommand({ ...command, skipped: merged }, list);
      if (!next) return false;
      command = next;
      sync();
      return true;
    },

    /** Local admin action (offline). Returns the new command. */
    admin(idx) {
      const next = buildCommand({
        prev: command,
        idx,
        at: now(),
        playlist: list,
        durations: durationTable(),
      });
      if (!next) return null;
      command = next;
      list = next.playlist;
      playingIdx = -1;
      resetTrackUi(next.playlist[next.idx]);
      sync();
      return next;
    },

    /** Map the player's state changes into the timeline. */
    stateChange({ state, videoId, title, duration }) {
      const id = videoId || playingVideoId;
      const t = target();
      // the iframe can still report the previous video for a moment after a
      // switch: its events must not lift the cover off the new video, reset the
      // cover's hide timer, or label the new track with the old title
      const isTarget = !!id && id === t.videoId;
      if (isTarget) onCover({ playing: state === YT.PLAYING, videoId: id });
      if (paused && state === YT.PLAYING) {
        try { adapter?.pause?.(); } catch {}
        return;
      }
      if (state === YT.PLAYING) {
        if (title && isTarget) onTitle(title);
        learnDuration(id, duration);
      }
      if (state === YT.ENDED) sync(); // the same track may come back around
    },

    /** The player reported an unplayable video: skip it here and in the room. */
    error(videoId) {
      const id = videoId || playingVideoId;
      if (id) {
        // the local set makes this tab skip it at once; the room's command (which
        // carries the same list once the server confirms) is what the other tabs
        // follow. Do not bump the revision here: the room stays the only writer
        // of revisions, so its next command is never mistaken for an older one.
        skipped.add(id);
        try { onSkip(id); } catch {}
      }
      playingIdx = -1;
      resetTrackUi("");
      sync();
    },

    /** Periodic drift correction (and recovery if something stalled). */
    tick() {
      sync();
    },

    pause() {
      paused = true;
      try { adapter?.pause?.(); } catch {}
      onCover({ playing: false, videoId: playingVideoId });
    },

    resume() {
      paused = false;
      sync();
    },

    /** Read-only state for tests and the HUD. */
    snapshot() {
      return {
        command,
        playlist: list,
        durations: durationTable(),
        resolved: target(),
        skipped: [...skipped],
        playingIdx,
        playingVideoId,
        pendingLoad,
        paused,
      };
    },
  };
}

// Ordering of two commands. The room's revision grows on every admin action,
// duration update and skip report, so the higher revision always wins, whatever
// track it names. Equal revisions (legacy commands without `rev`) are ordered by
// their start time; for the same start, a table/list that adds a value also wins.
function newerThan(current, incoming) {
  const curRev = Number(current.rev) || 0;
  const nextRev = Number(incoming.rev) || 0;
  if (nextRev !== curRev) return nextRev > curRev;
  const same = current.idx === incoming.idx && current.at === incoming.at;
  if (!same) return Number(incoming.at) >= Number(current.at);
  const cur = current.durations || {};
  const next = incoming.durations || {};
  for (const id of Object.keys(next)) if (cur[id] !== next[id]) return true;
  const curSkip = current.skipped || [];
  const nextSkip = incoming.skipped || [];
  return nextSkip.some((id) => !curSkip.includes(id));
}
