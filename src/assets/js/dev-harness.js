/**
 * Browser harness for the four required scenarios. Run with `npm run dev` and
 * open /dev-harness.html next to the normal demo. It drives the real
 * JPlayerManager + PlaylistView wiring against a deterministic fake jPlayer
 * playlist, so every scenario is reproducible without network audio.
 */
import { AudioPlayerApp } from "./app.js";
import { JPlayerManager } from "./jplayer.js";
import { PlayerStore } from "./player-store.js";
import { PlaylistView } from "./player-view.js";
import { installFakeJPlayer } from "./dev/fake-jplayer.js";

const posterA = new URL("../media/poster-audiotheme.jpg", import.meta.url).href;
const posterB = new URL("../media/poster-stark-palace.jpg", import.meta.url).href;

const tracks = [
  {
    artist: "MDN",
    mp3: "https://cdn.example.com/t-rex-roar.mp3",
    poster: posterA,
    record: "Interactive examples (CC0)",
    title: "T-Rex Roar",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/arcade-bonus-alert.mp3",
    poster: posterB,
    record: "Mixkit Sound Effects Free License",
    title: "Arcade bonus alert",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/soft-ping.mp3",
    poster: posterA,
    record: "Mixkit Sound Effects Free License",
    title: "Soft interface ping",
  },
  {
    artist: "Mixkit",
    mp3: "https://cdn.example.com/game-reward.mp3",
    poster: posterB,
    record: "Mixkit Sound Effects Free License",
    title: "Game reward sting",
  },
];

const log = [];
const logEl = document.querySelector("#harness-log");
const resultsEl = document.querySelector("#harness-results");

const record = (scenario, ok, detail) => {
  log.push({ detail, ok, scenario });
  const row = document.createElement("li");
  row.className = ok ? "pass" : "fail";
  row.textContent = `${ok ? "PASS" : "FAIL"} — ${scenario}${detail ? `: ${detail}` : ""}`;
  logEl?.append(row);
  return ok;
};

const start = () => {
  // Which track index (if any) will 404 on load. Mutated by the scenarios.
  let failingTrackIndex = -1;

  const fake = installFakeJPlayer();

  const elements = {
    artist: document.querySelector(".track-artist"),
    jpAudio: document.querySelector(".jp-audio"),
    notice: document.querySelector(".player-notice"),
    player: document.querySelector(".audio-player"),
    playlist: document.querySelector(".jp-playlist"),
    poster: document.querySelector(".track-poster img"),
    record: document.querySelector(".track-record"),
    title: document.querySelector(".track-title"),
  };

  const store = new PlayerStore({ tracks });
  const view = new PlaylistView();
  const manager = new JPlayerManager({ playlistData: tracks, store, view });

  manager.elements = elements;

  // Wrap the fake so scenarios can make a chosen track fail to load.
  globalThis.jPlayerPlaylist = class extends fake.PlaylistClass {
    constructor(cssSelector, playlist, options) {
      super(cssSelector, playlist, {
        ...options,
        failOnLoad: (_track, index) => index === failingTrackIndex,
      });
    }
  };

  manager.setupPlayer();

  const app = new AudioPlayerApp({ view });
  app.setupElements();
  app.setupPlaylistDisplay();

  const playlist = manager.getJPlaylist();
  const highlighted = () => {
    const row = elements.playlist.querySelector("li.jp-playlist-current");
    return row ? [...elements.playlist.querySelectorAll("li")].indexOf(row) : -1;
  };

  const requireConsistent = (scenario, expectedIndex) => {
    const title = elements.title.textContent;
    const ok =
      highlighted() === expectedIndex &&
      title === tracks[expectedIndex].title &&
      store.getView().index === expectedIndex;
    return record(scenario, ok, `highlight=${highlighted()} title="${title}"`);
  };

  // --- Scenario 1: normal track change -------------------------------------
  playlist.play(2);
  requireConsistent("Normal change: play track 3", 2);

  // --- Scenario 2: rapid consecutive changes -------------------------------
  failingTrackIndex = -1;
  playlist.play(0);
  manager.playNext();
  manager.playNext();
  manager.playNext();
  requireConsistent("Rapid next ×3 lands on track 4", 3);

  const before = elements.title.textContent;
  // Late callback for a track that is no longer selected.
  playlist.emitStalePlay(1);
  record(
    "Late play callback cannot overwrite current info",
    elements.title.textContent === before && highlighted() === 3,
    `title="${elements.title.textContent}"`,
  );

  // --- Scenario 3: switch display mode while playing -----------------------
  playlist.play(2);
  let modesOk = true;
  for (const mode of ["hide", "bottom", "scroll", "side", "bottom"]) {
    const toggle = document.querySelector(`[data-display="${mode}"]`);
    toggle?.click();
    modesOk &&= view.getDisplayMode() === mode && highlighted() === 2;
  }
  record(
    "Display switch keeps track + highlight",
    modesOk && elements.title.textContent === tracks[2].title,
    `mode="${view.getDisplayMode()}" highlight=${highlighted()}`,
  );

  // Scroll-position check: in `side` mode the playlist column is its own
  // bounded pane. Constrain it below the row height so a row can be off-screen,
  // park the pane at the top, switch away and back, and confirm the current
  // row ends up inside the pane's visible rectangle.
  const sidePane = elements.playlist;
  const naturalOverflow = sidePane.style.overflow;
  const naturalMaxHeight = sidePane.style.maxHeight;
  const rowHeight = elements.playlist.querySelector("li")?.getBoundingClientRect().height || 0;
  // One row tall: the row fits, but only one row is visible at a time.
  sidePane.style.maxHeight = `${Math.ceil(rowHeight)}px`;
  sidePane.style.overflow = "auto";
  sidePane.scrollTop = 0;
  document.querySelector('[data-display="bottom"]')?.click();
  document.querySelector('[data-display="side"]')?.click();

  const paneRect = sidePane.getBoundingClientRect();
  const currentRow = elements.playlist.querySelector("li.jp-playlist-current");
  const rowRect = currentRow?.getBoundingClientRect();
  const paneTooSmall = sidePane.scrollHeight > sidePane.clientHeight + 1;
  const rowVisible =
    Boolean(currentRow) && rowRect.top >= paneRect.top - 1 && rowRect.bottom <= paneRect.bottom + 1;
  record(
    "Mode switch scrolls current track into view",
    paneTooSmall && rowVisible && sidePane.scrollTop > 0,
    `scrollTop=${sidePane.scrollTop} pane=${Math.round(paneRect.height)}px`,
  );

  sidePane.style.maxHeight = naturalMaxHeight;
  sidePane.style.overflow = naturalOverflow;

  // --- Scenario 4: load failure --------------------------------------------
  // Establish track 4 as the last good one, then let track 3 fail on load so
  // the fallback (keep track 4's info, highlight it, flag track 3) is visible.
  failingTrackIndex = -1;
  playlist.play(3);

  setTimeout(() => {
    failingTrackIndex = 2;
    // This selection will 404 shortly after it is staged.
    playlist.play(2);

    setTimeout(() => {
      const { notice } = elements;
      const failedRow = elements.playlist.querySelector("li.jp-playlist-failed");
      const ok =
        !notice.hidden &&
        notice.textContent.length > 0 &&
        highlighted() === 3 &&
        Boolean(failedRow) &&
        elements.title.textContent === tracks[3].title;

      record(
        "Load failure keeps last good info + shows notice",
        ok,
        `notice="${notice.textContent}" highlight=${highlighted()} title="${elements.title.textContent}"`,
      );

      const total = log.length;
      const passed = log.filter((entry) => entry.ok).length;
      if (resultsEl) {
        resultsEl.textContent = `${passed}/${total} harness checks passed`;
        resultsEl.className = passed === total ? "pass" : "fail";
      }

      // Exposed for manual smoke-testing from the console.
      globalThis.__harness = { app, fake, manager, store, view };
    }, 120);
  }, 60);
};

start();
