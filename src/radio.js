// Room radio: the SYSTEM controls the track and position; pausing is local only.
//
// Everyone hears the same second because radio-core.js resolves it from one
// shared state: the room command ("track idx started at `at`") plus the real
// duration table kept by the server. This file is the browser side of that:
// the YouTube player, the little TV's cover and title, mute, and the pipes to
// the room server. Every desync event (admin switch, ENDED, a duration arriving
// late, an embed error, a reconnect) funnels through the same core resolver.

import {
  PLAYLIST,
  normalizeCommand,
  sanitizePlaylist,
} from "./radio-model.js";
import { createRadioCore } from "./radio-core.js";

export { PLAYLIST };

const CACHE_KEY = "radio-command";
const CACHE_MAX_AGE_MS = 24 * 60 * 60_000; // older than a day is no better than the default clock

const playlist = sanitizePlaylist(PLAYLIST);

const TOUCH = matchMedia("(pointer: coarse)").matches;

let core = null;
let player = null;
let paused = false;
let muted = false;
try { muted = localStorage.getItem("muted") === "1"; } catch {}

let syncTimer = 0;
let coverTimer = 0;
let coverEl = null;
let titleEl = null;

function loadApi() {
  return new Promise((ok) => {
    if (window.YT?.Player) return ok();
    window.onYouTubeIframeAPIReady = ok;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
}

// ---- the room command cache ------------------------------------------------
// A cached command is a bootstrap for the first instant only: the server sends
// its own snapshot on connect and that always wins, so a stale local command
// can never override the room.
function readCache() {
  try {
    const cmd = normalizeCommand(JSON.parse(localStorage.getItem(CACHE_KEY) || "null"), playlist);
    if (!cmd || Date.now() - cmd.at > CACHE_MAX_AGE_MS) return null;
    return cmd;
  } catch {
    return null;
  }
}

function writeCache(cmd) {
  try {
    if (cmd) localStorage.setItem(CACHE_KEY, JSON.stringify(cmd));
    else localStorage.removeItem(CACHE_KEY);
  } catch {}
}

// ---- the little TV: cover + title ------------------------------------------
// The cover hides YouTube's pause/play overlay and logo while the video isn't
// playing. It belongs to exactly one video: every switch clears the pending
// timer and points it at the new thumbnail, so an old cover can never sit on
// top of the new video and the title never keeps the old track's text.
function setTitle(text) {
  if (titleEl) titleEl.textContent = text || "—";
}

function updateCover(playing, videoId) {
  if (!coverEl) return;
  clearTimeout(coverTimer);
  coverTimer = 0;
  if (playing) {
    // YouTube shows its pause button and channel badge for a few seconds after
    // playback starts, so the cover only lifts once that has faded
    coverTimer = setTimeout(() => { coverEl.hidden = true; }, 4500);
    return;
  }
  coverEl.src = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
  coverEl.hidden = !videoId;
}

// A YouTube player adapter for the core. Everything is read fresh from the
// iframe, because its state lags behind loadVideoById/seekTo calls.
function makeAdapter() {
  return {
    getVideoId() {
      try { return player?.getVideoData?.()?.video_id || ""; } catch { return ""; }
    },
    getCurrentTime() {
      try { return player?.getCurrentTime?.() || 0; } catch { return 0; }
    },
    getState() {
      try { return player?.getPlayerState?.() ?? -1; } catch { return -1; }
    },
    load(videoId, seconds) {
      player?.loadVideoById?.({ videoId, startSeconds: seconds });
    },
    seek(seconds) {
      player?.seekTo?.(seconds, true);
    },
    play() {
      player?.playVideo?.();
    },
    pause() {
      player?.pauseVideo?.();
    },
  };
}

// With a server: the command goes to the room's Durable Object, which checks
// the admin password, stamps the command and sends it to everyone.
let sendToServer = null;
export function connectRadioToServer(fn) {
  sendToServer = fn;
}

// Durations we learned locally go to the room so late joiners can replay the
// same timeline. The server validates and clamps them.
let sendDurations = null;
export function connectDurationsToServer(fn) {
  sendDurations = fn;
}

// A track this tab could not play is reported so every tab walks past it.
let sendSkip = null;
export function connectSkipToServer(fn) {
  sendSkip = fn;
}

// Called when the server sends the room's current command (or a duration update
// for the same command). `snapshot` marks the copy sent right after connecting:
// it always wins, so a stale local cache can never override the room.
// Messages can arrive before the player starts (the radio begins on "enter the
// room"), so the last one is kept and replayed by startRadio().
let beforeStart = null;
let beforeStartDurations = null;
let beforeStartSkipped = null;
export function receiveCommand(c) {
  if (!c || typeof c !== "object") return;
  // A command always carries its start time; anything else is an update to the
  // current command.
  const isCommand = c.at != null && Number.isFinite(Number(c.at));
  if (!core) {
    if (isCommand) beforeStart = c;
    else if (c.durations) beforeStartDurations = { ...(beforeStartDurations || {}), ...c.durations };
    else if (c.skipped) beforeStartSkipped = [...new Set([...(beforeStartSkipped || []), ...c.skipped])];
    return;
  }
  if (isCommand) {
    const normalized = normalizeCommand(c, playlist);
    if (!normalized) return;
    core.setCommand(normalized, { snapshot: c.snapshot === true });
    writeCache(core.snapshot().command);
    return;
  }
  // a duration-only update for the current command
  if (c.durations) {
    core.applyDurations(c.durations);
    writeCache(core.snapshot().command);
    return;
  }
  // a skip-list update for the current command
  if (c.skipped) {
    core.applySkipped(c.skipped);
    writeCache(core.snapshot().command);
  }
}

// Admin controls (local when offline; go to the room server in multiplayer).
const currentIdx = () => {
  const s = core?.snapshot();
  if (!s) return 0;
  // the track being heard now: what the player is on, else the resolved one
  // (admin may press restart while the first load is still in flight)
  if (s.playingIdx >= 0) return s.playingIdx;
  return s.resolved?.idx ?? 0;
};
function applyCommand(idx) {
  const list = core?.snapshot().playlist?.length ? core.snapshot().playlist : sanitizePlaylist(playlist);
  idx = ((Math.floor(idx) % list.length) + list.length) % list.length;
  if (sendToServer) return sendToServer(idx); // wait for the server to confirm
  if (!core) return;
  const next = core.admin(idx);
  if (next) writeCache(core.snapshot().command);
}
export const admin = {
  restart: () => applyCommand(currentIdx()),
  next: () => applyCommand(currentIdx() + 1),
  previous: () => applyCommand(currentIdx() - 1),
};

export async function startRadio({ elPlayer, elTitle }) {
  await loadApi();
  titleEl = elTitle;

  const initial = readCache();
  core = createRadioCore({
    playlist,
    command: initial,
    onTitle: setTitle,
    onCover: ({ playing, videoId }) => updateCover(playing, videoId),
    onDurations: (table) => {
      if (sendDurations) {
        try { sendDurations(table); } catch {}
      }
    },
    onSkip: (id) => {
      if (sendSkip) {
        try { sendSkip(id); } catch {}
      }
    },
  });

  // a command that arrived while the player didn't exist yet is the room's
  // latest word: apply it as a snapshot before choosing the first frame
  if (beforeStart) {
    core.setCommand(beforeStart, { snapshot: true });
    beforeStart = null;
  }
  if (beforeStartDurations) {
    core.applyDurations(beforeStartDurations);
    beforeStartDurations = null;
  }
  if (beforeStartSkipped) {
    core.applySkipped(beforeStartSkipped);
    beforeStartSkipped = null;
  }
  // the first frame: the (possibly just replaced) command decides the video and
  // a best-guess second; the core seeks to the exact one on its first sync after
  // ready, so a late joiner is never more than that first seek away
  const boot = core.snapshot();
  const bootVideo = boot.resolved?.videoId || boot.playingVideoId || playlist[0];
  const bootSeconds = boot.resolved?.blocked ? 0 : Math.floor(boot.resolved?.sec || 0);

  const host = document.getElementById(elPlayer);
  // cover with the video's thumbnail whenever it isn't playing, so YouTube's big
  // pause/play overlay and logo never show in the little TV
  coverEl = Object.assign(document.createElement("img"), { className: "tv-cover", alt: "" });
  host.parentElement.append(coverEl);
  updateCover(false, bootVideo);

  player = new YT.Player(elPlayer, {
    width: 176,
    height: 99,
    videoId: bootVideo,
    playerVars: {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      start: bootSeconds, // the backstop for the first moments of playback
    },
    events: {
      onReady: (e) => {
        e.target.setVolume(70);
        // phones only autoplay muted (the tap on "enter" is used up while the API loads):
        // start muted and turn the sound on at the next touch
        if (TOUCH) {
          e.target.mute();
          const unmute = () => {
            if (muted) return;
            e.target.unMute();
            e.target.setVolume(70);
            if (!paused) e.target.playVideo();
          };
          addEventListener("pointerdown", unmute, { once: true, capture: true });
        }
        if (muted) e.target.mute();
        if (paused) e.target.pauseVideo();
        else e.target.playVideo();
        core.ready();
      },
      onStateChange: (e) => {
        core.stateChange({
          state: e.data,
          videoId: e.target.getVideoData?.()?.video_id,
          title: e.target.getVideoData?.()?.title,
          duration: e.target.getDuration?.(),
        });
        writeCache(core.snapshot().command); // a learned duration is worth keeping
      },
      onError: () => {
        // unavailable / embedding disabled: skip it here and resolve again, so
        // this tab walks to the same next track as everyone else
        core.error(e.target.getVideoData?.()?.video_id);
      },
    },
  });
  core.attach(makeAdapter());
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    core.tick();
    writeCache(core.snapshot().command);
  }, 5000);
  writeCache(boot.command);
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("muted", m ? "1" : "0"); } catch {}
  if (!player?.mute) return;
  if (m) player.mute();
  else {
    player.unMute();
    player.setVolume(70);
  }
}

export function pauseRadio() {
  paused = true;
  core?.pause();
  writeCache(core?.snapshot().command);
}

export function resumeRadio() {
  paused = false;
  core?.resume();
}

// Deterministic hook for the local checks (no YouTube in Node).
export const __radioInternals = { getCore: () => core };
