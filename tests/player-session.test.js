/*
 * Integration tests for script.js session switching.
 *
 * script.js is loaded into a vm context with a minimal DOM stub so the real
 * playVideo()/event-handler wiring runs unmodified. Two paths are covered:
 *   1. normal source switch (revocation, listener swap, track cleanup)
 *   2. stale callbacks from a previous session (must be discarded)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");

function makeElement(tag = "div") {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    value: "",
    files: [],
    disabled: false,
    className: "",
    textContent: "",
    offsetWidth: 300,
    parent: null,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },
    _listeners: listeners,
    _fire(type, event = {}) {
      (listeners[type] || []).slice().forEach((fn) => fn.call(el, event));
    },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parent) {
        el.parent.children = el.parent.children.filter((c) => c !== el);
        el.parent = null;
      }
    },
    querySelectorAll(selector) {
      if (selector === "track") {
        return el.children.filter((c) => c.tagName === "TRACK");
      }
      return [];
    },
    click() {},
    scrollIntoView() {},
    requestSubmit() {},
    setAttribute() {}
  };
  let innerHTML = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return innerHTML; },
    set(value) {
      innerHTML = value;
      if (value === "") {
        el.children.forEach((c) => { c.parent = null; });
        el.children = [];
      }
    }
  });
  if (el.tagName === "TRACK") {
    el.track = { mode: "disabled" };
  }
  return el;
}

function makePlayer() {
  const el = makeElement("video");
  el.currentTime = 0;
  el.duration = 0;
  el.paused = true;
  el.volume = 1;
  el.muted = false;
  el.loadCount = 0;
  el.load = () => { el.loadCount += 1; };
  el.play = () => Promise.resolve();
  el.pause = () => {};
  Object.defineProperty(el, "textTracks", {
    get() {
      return el.children.filter((c) => c.tagName === "TRACK").map((c) => c.track);
    }
  });
  return el;
}

function createApp() {
  const elements = new Map();
  const revoked = [];
  const storage = new Map();

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, id === "video-player" ? makePlayer() : makeElement());
      }
      return elements.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    addEventListener() {},
    fullscreenElement: null
  };

  const context = {
    console,
    document: documentStub,
    window: {
      addEventListener() {},
      location: { search: "", reload() {} }
    },
    navigator: {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    URL: {
      createObjectURL: (file) => "blob:mock-" + (file && file.name ? file.name : "x"),
      revokeObjectURL: (url) => { revoked.push(url); }
    },
    URLSearchParams,
    Swal: { fire: () => Promise.resolve({ isConfirmed: true, value: "" }) },
    NeovidCore: require("../player-core.js")
  };
  context.globalThis = context;
  vm.createContext(context);

  const scriptSrc = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
  const exposed = `
    ;globalThis.__app = {
      playVideo, saveRecent, state, sessionGuard, DOM,
      getRecent, setRecent, getWatchTime
    };`;
  vm.runInContext(scriptSrc + exposed, context, { filename: "script.js" });

  const app = context.__app;
  return {
    app,
    revoked,
    player: documentStub.getElementById("video-player"),
    skipButton: documentStub.getElementById("skip-button"),
    seedRecent(items) {
      storage.set("recentVideos", JSON.stringify(items));
    }
  };
}

function entry(overrides = {}) {
  return Object.assign({
    title: "", video: "", videoType: "url",
    subtitle: "", subtitleType: "url", progress: 0
  }, overrides);
}

test("normal switch: old blob URL revoked, listeners swapped, progress goes to the new session", () => {
  const { app, revoked, player, skipButton, seedRecent } = createApp();
  seedRecent([
    entry({ title: "a.mp4", video: "blob:persisted-a", videoType: "local", progress: 10 }),
    entry({ title: "b", video: "https://cdn/b.mp4", videoType: "url", progress: 20 })
  ]);

  // Session 1: local file played through a fresh blob URL.
  app.playVideo("blob:session-1", "", "a.mp4", "local", "url");
  assert.equal(app.state.currentEntryId, "local:a.mp4");
  assert.equal(player.loadCount, 1);
  assert.equal(player._listeners.timeupdate.length, 1);

  player.duration = 200;
  player.currentTime = 100;
  player._fire("timeupdate"); // establishes lastTime
  player.currentTime = 102;
  player._fire("timeupdate");
  let recent = app.getRecent();
  assert.equal(recent.find((i) => i.title === "a.mp4").progress, 51);
  assert.equal(app.getWatchTime(), 2);

  skipButton.style.display = "block";

  // Session 2: switch to a URL video.
  app.playVideo("https://cdn/b.mp4", "", "b", "url", "url");
  assert.deepEqual(revoked, ["blob:session-1"]); // old blob released
  assert.equal(app.state.currentEntryId, "url:https://cdn/b.mp4");
  assert.equal(skipButton.style.display, "none"); // skip state reset
  assert.equal(player._listeners.timeupdate.length, 1); // old listener detached
  assert.equal(player.loadCount, 2);

  player.duration = 100;
  player.currentTime = 25;
  player._fire("timeupdate");
  recent = app.getRecent();
  assert.equal(recent.find((i) => i.video === "https://cdn/b.mp4").progress, 25);
  assert.equal(recent.find((i) => i.title === "a.mp4").progress, 51); // untouched
});

test("stale callbacks: queued events from a previous session are discarded", () => {
  const { app, player, skipButton, seedRecent } = createApp();
  seedRecent([
    entry({ title: "a", video: "https://cdn/a.mp4", progress: 10 }),
    entry({ title: "b", video: "https://cdn/b.mp4", progress: 80 })
  ]);

  app.playVideo("https://cdn/a.mp4", "", "a", "url", "url");
  // Capture the session-1 handlers, then switch source. The detached
  // handlers simulate events that were queued before the switch.
  const staleTimeupdate = player._listeners.timeupdate.slice();
  const staleEnded = player._listeners.ended.slice();
  const staleLoadedmetadata = player._listeners.loadedmetadata.slice();
  assert.ok(staleTimeupdate.length > 0);

  app.playVideo("https://cdn/b.mp4", "", "b", "url", "url");

  player.duration = 100;
  player.currentTime = 55;
  const watchTimeBefore = app.getWatchTime();
  const recentBefore = JSON.stringify(app.getRecent());
  staleTimeupdate.forEach((fn) => fn());
  assert.equal(JSON.stringify(app.getRecent()), recentBefore); // no progress write
  assert.equal(app.getWatchTime(), watchTimeBefore); // no watch-time write

  skipButton.style.display = "block";
  staleEnded.forEach((fn) => fn());
  assert.equal(skipButton.style.display, "block"); // stale ended must not touch skip state
  player._fire("ended");
  assert.equal(skipButton.style.display, "none"); // current session's ended works

  staleLoadedmetadata.forEach((fn) => fn());
  assert.equal(player.currentTime, 55); // stale loadedmetadata must not seek
  player._fire("loadedmetadata");
  assert.equal(player.currentTime, 80); // current session resumes at 80%
});

test("subtitle tracks: old track removed on switch, no residue without subtitle", () => {
  const { app, player } = createApp();

  app.playVideo("https://cdn/a.mp4", "https://cdn/a.vtt", "a", "url", "url");
  assert.equal(player.querySelectorAll("track").length, 1);
  assert.equal(player.textTracks.length, 1);
  assert.equal(player.textTracks[0].mode, "showing");

  // Switch to a video without subtitles: no track may remain.
  app.playVideo("https://cdn/b.mp4", "", "b", "url", "url");
  assert.equal(player.querySelectorAll("track").length, 0);
  assert.equal(player.textTracks.length, 0);

  // Switch to a video with subtitles again: exactly one fresh track.
  app.playVideo("https://cdn/c.mp4", "https://cdn/c.vtt", "c", "url", "url");
  const tracks = player.querySelectorAll("track");
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].src, "https://cdn/c.vtt");
  assert.equal(player.textTracks[0].mode, "showing");
});

test("saveRecent: same video played twice keeps a single recent entry", () => {
  const { app } = createApp();
  app.saveRecent("clip.mp4", "blob:1", "local", "", "url");
  app.setRecent(JSON.parse(JSON.stringify(app.getRecent()))); // round-trip
  const recent = app.getRecent();
  recent[0].progress = 33;
  app.setRecent(recent);

  app.saveRecent("clip.mp4", "blob:2", "local", "", "url");
  const after = app.getRecent();
  assert.equal(after.length, 1);
  assert.equal(after[0].video, "blob:2");
  assert.equal(after[0].progress, 33);
});
