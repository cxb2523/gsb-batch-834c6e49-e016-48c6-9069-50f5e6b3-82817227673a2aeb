"use strict";

/**
 * Playback-session lifecycle race tests.
 *
 * These tests load the REAL server/js/core/player.js and
 * server/js/screen/video.js into a vm sandbox with a fake DOM, fake dashjs,
 * fake session and fake fetch, and reproduce the races described in the
 * playback-session hardening task:
 *
 *  1. Bluetooth headset unplug / system resume schedules delayed rebind
 *     timers (450ms / 1500ms) and in-flight rebindAudioOutput() promises.
 *     After switching to the next episode (new play session, new <video>
 *     element) the stale timers/promises must NOT call setSinkId() or
 *     micro-seek on the OLD element.
 *  2. Concurrent rebind requests share a single in-flight promise.
 *  3. The stream-recovery rate limit (2 per 30s) is scoped to the playback
 *     session: recoveries of episode A must not suppress the first recovery
 *     of episode B, while a recovery-driven replay of the SAME episode keeps
 *     the budget.
 *  4. Both audio-watchdog timer stages (450ms sample + 1600ms verify) are
 *     voided when the session seq moved on or #video-screen is gone; a
 *     stalled-audio watchdog in an intact session still rebinds (pass 1) and
 *     recovers (pass 2).
 *  5. Episode switch ordering: DELETE of the old DRM token settles before
 *     the new stream is requested; an HTTP 500 DELETE is logged, releases
 *     drmLock and local refs, and the new episode still reaches BUFFERING
 *     and finally PLAYING.
 *  6. Late session.refresh callbacks from a previous play session are
 *     dropped by seq; the dashjs RequestModifier always reads the LIVE
 *     session.storage access_token.
 *
 * Run with:  npm test   (or: node --test tests/)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const REPO_ROOT = path.join(__dirname, "..");
const PLAYER_SRC = path.join(REPO_ROOT, "server", "js", "core", "player.js");
const VIDEO_SRC = path.join(REPO_ROOT, "server", "js", "screen", "video.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await sleep(0);
};

/* ------------------------------------------------------------------ */
/* Fake DOM                                                            */
/* ------------------------------------------------------------------ */

function findById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  const kids = node.children || [];
  for (let i = 0; i < kids.length; i++) {
    const hit = findById(kids[i], id);
    if (hit) return hit;
  }
  return null;
}

function makeElement(tag) {
  return {
    tagName: String(tag || "div").toUpperCase(),
    id: "",
    style: {},
    className: "",
    children: [],
    parentNode: null,
    isConnected: true,
    listeners: {},
    innerHTML: "",
    textContent: "",
    disabled: false,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    prepend(child) {
      this.children.unshift(child);
      child.parentNode = this;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      child.isConnected = false;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
      this.isConnected = false;
    },
    querySelector() {
      return null;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    scrollIntoView() {},
  };
}

function makeVideoElement() {
  const el = makeElement("video");
  el.paused = true;
  el.volume = 1;
  el.muted = false;
  el.readyState = 4;
  el.duration = 1440;
  el.sinkId = "";
  el.seeking = false;
  el.error = null;
  el.playbackRate = 1;
  el._currentTime = 0;
  el.currentTimeSets = [];
  Object.defineProperty(el, "currentTime", {
    get() {
      return this._currentTime;
    },
    set(v) {
      this.currentTimeSets.push(v);
      this._currentTime = v;
    },
  });
  el.setSinkIdCalls = [];
  el.setSinkId = function (id) {
    el.setSinkIdCalls.push(id);
    el.sinkId = id;
    return Promise.resolve();
  };
  el.play = function () {
    el.paused = false;
    return Promise.resolve();
  };
  el.pause = function () {
    el.paused = true;
  };
  return el;
}

function makeDocument() {
  const byId = {};
  const content = makeElement("div"); // "#video-screen .content"
  const body = makeElement("body");
  return {
    _byId: byId,
    _content: content,
    body,
    getElementById(id) {
      return byId[id] || findById(content, id) || findById(body, id);
    },
    createElement(tag) {
      return tag === "video" ? makeVideoElement() : makeElement(tag);
    },
    querySelector(sel) {
      if (sel === "#video-screen .content") return content;
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sandbox environment                                                 */
/* ------------------------------------------------------------------ */

function createEnv(overrides) {
  const env = {
    attachSourceCalls: [],
    fetchCalls: [],
    videoV2Calls: [],
    order: [],
    warnings: [],
    errors: [],
    recoveries: 0,
    pluginResets: 0,
    initialized: [],
    plugins: [],
    devices: [{ kind: "audiooutput", deviceId: "default" }],
    videoV2Response: {
      token: "tok2",
      url: "https://cdn.test/ep2.mpd",
      hardSubs: {},
      versions: [],
      audioLocale: "ja-JP",
    },
    fetchResponder: () => ({ ok: true, status: 200 }),
  };
  Object.assign(env, overrides || {});

  const documentStub = makeDocument();

  env.showScreen = () => {
    const el = makeElement("div");
    el.id = "video-screen";
    documentStub._byId["video-screen"] = el;
    return el;
  };
  env.hideScreen = () => {
    delete documentStub._byId["video-screen"];
  };

  const mediaListeners = {};
  env.emitDeviceChange = () => {
    (mediaListeners.devicechange || []).slice().forEach((fn) => fn());
  };

  if (!env.enumerateDevicesImpl) {
    env.enumerateDevicesImpl = () => Promise.resolve(env.devices);
  }
  const navigatorStub = {
    mediaDevices: {
      addEventListener(type, fn) {
        (mediaListeners[type] = mediaListeners[type] || []).push(fn);
      },
      enumerateDevices: () => env.enumerateDevicesImpl(),
    },
  };

  const sessionStub = {
    storage: {
      access_token: "access-1",
      refresh_token: "refresh-1",
      quality: "auto",
      account: {},
      expires_in: Date.now() + 3600e3,
    },
    languages: { audios: {}, subtitles: {} },
    isExpired: () => false,
    update() {
      return sessionStub.storage;
    },
    refresh(cb) {
      env.sessionRefreshImpl(cb);
    },
  };
  if (!env.sessionRefreshImpl) {
    env.sessionRefreshImpl = (cb) => cb.success(sessionStub.storage);
  }

  if (!env.videoV2Impl) {
    env.videoV2Impl = (opts) => opts.success(env.videoV2Response);
  }
  const serviceStub = {
    api: { drm: "https://drm.test" },
    video_v2(opts) {
      env.videoV2Calls.push(opts);
      env.order.push(["video_v2", opts && opts.data && opts.data.id]);
      env.videoV2Impl(opts);
    },
    intro() {},
  };

  const fetchStub = (url, opts) => {
    env.fetchCalls.push({ url, opts });
    env.order.push(["fetch", opts && opts.method, url]);
    return Promise.resolve().then(() => env.fetchResponder(url, opts));
  };

  const dashjsStub = {
    MediaPlayer() {
      return {
        create() {
          const plugin = {
            extend(name, factory) {
              if (name === "RequestModifier" && typeof factory === "function") {
                env.requestModifier = factory();
              }
            },
            updateSettings() {},
            initialize(videoEl, src, autoPlay) {
              env.initialized.push({ videoEl, src, autoPlay });
            },
            on() {},
            setProtectionData(cfg) {
              env.protectionData = cfg;
            },
            registerLicenseRequestFilter(fn) {
              env.licenseRequestFilter = fn;
            },
            registerLicenseResponseFilter(fn) {
              env.licenseResponseFilter = fn;
            },
            attachSource(url, start) {
              env.attachSourceCalls.push({ url, start });
            },
            reset() {
              env.pluginResets++;
            },
          };
          env.plugins.push(plugin);
          return plugin;
        },
      };
    },
  };

  // Chainable no-op jQuery stub.
  const $chain = new Proxy(function () {}, {
    get(t, p) {
      if (p === "then" || p === Symbol.toPrimitive) return undefined;
      return $chain;
    },
    apply() {
      return $chain;
    },
  });
  const $ = () => $chain;

  const consoleStub = {
    log() {},
    warn(...a) {
      env.warnings.push(a.map(String).join(" "));
    },
    error(...a) {
      env.errors.push(a.map(String).join(" "));
    },
  };

  const sandbox = {
    console: consoleStub,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: documentStub,
    navigator: navigatorStub,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    session: sessionStub,
    service: serviceStub,
    dashjs: dashjsStub,
    fetch: fetchStub,
    Headers: class {
      constructor() {
        this.map = {};
      }
      append(k, v) {
        this.map[k] = v;
      }
    },
    $,
    TextDecoder,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PLAYER_SRC, "utf8"), sandbox, {
    filename: "player.js",
  });
  vm.runInContext(fs.readFileSync(VIDEO_SRC, "utf8"), sandbox, {
    filename: "video.js",
  });

  env.sandbox = sandbox;
  env.player = sandbox.player;
  env.video = sandbox.video;
  env.document = documentStub;
  env.session = sessionStub;
  env.service = serviceStub;

  // Stub the DOM/jQuery-heavy UI methods of the video screen; everything
  // lifecycle-related (play, releasePendingSession, onPlaybackStarted,
  // _requestStream) stays real.
  const v = env.video;
  v.syncQualityUI = () => {};
  v.showOSD = () => {};
  v.hideOSD = () => {};
  v.showBTN = () => {};
  v.hideBTN = () => {};
  v.startHistory = () => {};
  v.saveHistory = () => {};
  v.setAudios = () => {};
  v.setSubtitles = () => {};
  v.setSkipIntro = () => {};
  v.renderEpisodesDrawer = () => {};
  v.syncCurrentPlayheadToLists = () => {};
  v.syncHomeEpisodesSlide = () => {};
  v.recoverPlayback = () => {
    env.recoveries++;
  };

  return env;
}

function cleanup(env) {
  try {
    env.player.stop();
  } catch (_) {}
  env.hideScreen();
  env.video._pendingSessionRelease = null;
}

/* ------------------------------------------------------------------ */
/* 1. Stale rebind timers / in-flight rebind vs. session switch        */
/* ------------------------------------------------------------------ */

test("device-change rebind timers and in-flight rebind are voided by episode switch", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, document } = env;

  // Episode 1 playing.
  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v1 = document.getElementById("videoplayer");
  v1._currentTime = 120;
  v1.paused = false;

  // (a) Headset unplugged: devicechange schedules 450ms/1500ms rebind timers
  //     bound to the ep1 session seq.
  env.emitDeviceChange();
  assert.equal(player._deviceChangeTimers.length, 2);

  // (b) A rebind triggered under ep1 is still in flight (enumerateDevices
  //     blocked, e.g. PipeWire slow to register the new sink).
  let resolveDevices;
  const deferred = new Promise((res) => {
    resolveDevices = res;
  });
  env.enumerateDevicesImpl = () => deferred;
  const rebindP = player.rebindAudioOutput(v1, true);

  // User switches to the next episode: new play session, new <video> element.
  player.play({ id: "ep2", token: "t2" }, "https://cdn.test/ep2.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v2 = document.getElementById("videoplayer");
  assert.notEqual(v1, v2);
  assert.equal(v1.isConnected, false);

  // The in-flight rebind resolves only now, and the 450/1500ms timers expire.
  resolveDevices([{ kind: "audiooutput", deviceId: "default" }]);
  await rebindP;
  await sleep(1700);

  // The stale session must not touch the old element at all.
  assert.deepEqual(v1.setSinkIdCalls, []);
  assert.deepEqual(v1.currentTimeSets, []); // no micro-seek on old element
  // ... nor hijack the new episode's element.
  assert.deepEqual(v2.setSinkIdCalls, []);
  cleanup(env);
});

/* ------------------------------------------------------------------ */
/* 2. Single in-flight rebind                                          */
/* ------------------------------------------------------------------ */

test("concurrent rebindAudioOutput requests share one in-flight promise", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, document } = env;

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v = document.getElementById("videoplayer");

  let enumCalls = 0;
  env.enumerateDevicesImpl = () => {
    enumCalls++;
    return Promise.resolve(env.devices);
  };

  const p1 = player.rebindAudioOutput(v, false);
  const p2 = player.rebindAudioOutput(v, false);
  assert.equal(p1, p2); // reused, not stacked
  await p1;
  assert.equal(enumCalls, 1);
  assert.deepEqual(v.setSinkIdCalls, ["default", ""]);

  // Once settled, a later request starts a fresh rebind.
  const p3 = player.rebindAudioOutput(v, false);
  assert.notEqual(p3, p1);
  await p3;
  assert.equal(enumCalls, 2);
  cleanup(env);
});

/* ------------------------------------------------------------------ */
/* 3. Recovery rate limit is scoped to the playback session            */
/* ------------------------------------------------------------------ */

test("recovery rate limit resets on episode switch but not on same-episode replay", () => {
  const env = createEnv();
  env.showScreen();
  const { player, video } = env;
  video.episode = "ep1";

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  assert.equal(player._triggerStreamRecovery("resume-1", false), true);
  assert.equal(player._triggerStreamRecovery("resume-2", false), true);
  assert.equal(player._triggerStreamRecovery("resume-3", false), false); // limited
  assert.equal(env.recoveries, 2);

  // A recovery-driven replay of the SAME episode keeps the session budget.
  player.play({ id: "ep1", token: "t1b" }, "https://cdn.test/ep1.mpd", 0, false);
  assert.equal(player._triggerStreamRecovery("resume-4", false), false);
  assert.equal(env.recoveries, 2);

  // Switching to the next episode starts a fresh session budget: the first
  // recovery of the new episode is NOT suppressed by the previous episode.
  video.episode = "ep2";
  player.play({ id: "ep2", token: "t2" }, "https://cdn.test/ep2.mpd", 0, false);
  assert.equal(player._triggerStreamRecovery("resume-5", false), true);
  assert.equal(env.recoveries, 3);
  cleanup(env);
});

/* ------------------------------------------------------------------ */
/* 4. Watchdog timers are seq/screen guarded                           */
/* ------------------------------------------------------------------ */

test("watchdog stage timers do nothing once #video-screen is gone", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, video, document } = env;
  video.episode = "ep1";

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v = document.getElementById("videoplayer");
  v.paused = false;
  v.readyState = 4;
  v.webkitAudioDecodedByteCount = 1000;
  v._currentTime = 10;

  let enumCalls = 0;
  env.enumerateDevicesImpl = () => {
    enumCalls++;
    return Promise.resolve([]);
  };

  // Stage 1 (450ms) fires after the screen was destroyed (e.g. user backed
  // out of the player): must not even sample the element.
  player._startAudioHealthWatchdog(player._playSeq, false);
  env.hideScreen();
  await sleep(700);
  assert.equal(enumCalls, 0);
  assert.equal(env.recoveries, 0);

  // Stage 2 (1600ms) pending while the screen goes away: must not rebind
  // or trigger stream recovery.
  env.showScreen();
  player.state = player.states.PLAYING;
  player._startAudioHealthWatchdog(player._playSeq, false);
  await sleep(700); // stage 1 sampled t0/a0
  v._currentTime = 11; // time advances, audio bytes do not
  env.hideScreen();
  await sleep(1800);
  assert.equal(enumCalls, 0);
  assert.equal(env.recoveries, 0);
  cleanup(env);
});

test("watchdog stage-2 timer is voided when the play session seq moved on", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, video, document } = env;
  video.episode = "ep1";

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v = document.getElementById("videoplayer");
  v.paused = false;
  v.readyState = 4;
  v.webkitAudioDecodedByteCount = 1000;
  v._currentTime = 10;

  let enumCalls = 0;
  env.enumerateDevicesImpl = () => {
    enumCalls++;
    return Promise.resolve([]);
  };

  player._startAudioHealthWatchdog(player._playSeq, false);
  await sleep(700); // stage 1 fired under the old seq, stage 2 pending
  v._currentTime = 11;
  player._playSeq++; // a new play session started before stage 2 fired
  await sleep(1800);

  assert.equal(enumCalls, 0); // no rebind of the stale session
  assert.equal(env.recoveries, 0); // no stale stream recovery
  assert.deepEqual(v.setSinkIdCalls, []);
  cleanup(env);
});

test("watchdog in an intact session rebinds on pass 1 and recovers on pass 2", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, video, document } = env;
  video.episode = "ep1";

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.state = player.states.PLAYING;
  const v = document.getElementById("videoplayer");
  v.paused = false;
  v.readyState = 4;
  v.webkitAudioDecodedByteCount = 1000;
  v._currentTime = 10;

  let enumCalls = 0;
  env.enumerateDevicesImpl = () => {
    enumCalls++;
    return Promise.resolve(env.devices);
  };

  // Pass 1: silent audio (time moves, decoded audio bytes do not) -> rebind.
  player._startAudioHealthWatchdog(player._playSeq, false);
  await sleep(1000);
  v._currentTime = 11; // dt = 1s > 0.6s, da = 0
  await sleep(1300); // stage 2 fired at ~2050ms
  assert.equal(enumCalls, 1);
  assert.deepEqual(v.setSinkIdCalls, ["default", ""]);
  assert.equal(env.recoveries, 0);
  cleanup(env);

  // Pass 2 (second pass after a failed rebind): -> stream recovery.
  const env2 = createEnv();
  env2.showScreen();
  env2.video.episode = "ep1";
  env2.player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  env2.player.state = env2.player.states.PLAYING;
  const v2 = env2.document.getElementById("videoplayer");
  v2.paused = false;
  v2.readyState = 4;
  v2.webkitAudioDecodedByteCount = 1000;
  v2._currentTime = 10;
  env2.player._startAudioHealthWatchdog(env2.player._playSeq, true);
  await sleep(1000);
  v2._currentTime = 11;
  await sleep(1300);
  assert.equal(env2.recoveries, 1);
  cleanup(env2);
});

/* ------------------------------------------------------------------ */
/* 5. DRM session ordering and DELETE failure fallback                 */
/* ------------------------------------------------------------------ */

test("episode switch deletes old DRM token before new stream; HTTP 500 does not block playback", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, video } = env;

  // Every DELETE of the old token fails server-side.
  env.fetchResponder = () => ({ ok: false, status: 500 });

  // A live ep1 session with an unreleased DRM token.
  player.drmLock = true;
  video._playReqId = 0;
  video._pendingSessionRelease = {
    reqId: 0,
    playSeq: player._playSeq,
    id: "ep1",
    token: "tok1",
  };

  video.play({ id: "ep2", title: "Episode 2", playhead: 0, duration: 24 });
  await flush();

  // Ordering: DELETE of the old token settled before the new stream request.
  assert.deepEqual(env.order[0], [
    "fetch",
    "DELETE",
    "https://drm.test/v1/token/ep1/tok1",
  ]);
  assert.deepEqual(env.order[1], ["video_v2", "ep2"]);

  // Failure was logged and local DRM state was released anyway.
  assert.equal(player.drmLock, false);
  assert.ok(
    env.warnings.some((w) => w.includes("DRM session delete failed")),
    "expected a logged warning for the failed DELETE"
  );

  // The new episode still reached BUFFERING with its stream attached.
  assert.equal(player.state, player.states.BUFFERING);
  assert.equal(env.attachSourceCalls.length, 1);
  assert.equal(env.attachSourceCalls[0].url, "https://cdn.test/ep2.mpd");
  assert.equal(video._pendingSessionRelease.id, "ep2");
  assert.equal(video._pendingSessionRelease.token, "tok2");

  // Playback starts: the episode reaches PLAYING and its own token is
  // released on start (that DELETE also 500s and is also swallowed).
  player.onbufferingcomplete();
  await flush();
  assert.equal(player.state, player.states.PLAYING);
  assert.equal(video._pendingSessionRelease, null);
  assert.ok(
    env.order.some(
      (e) =>
        e[0] === "fetch" &&
        e[1] === "DELETE" &&
        e[2] === "https://drm.test/v1/token/ep2/tok2"
    ),
    "expected the new episode's token to be released on playback start"
  );
  assert.equal(player.drmLock, false);
  cleanup(env);
});

test("deleteSession releases drmLock and reports error on network failure", async () => {
  const env = createEnv();
  const { player } = env;
  player.drmLock = true;
  env.fetchResponder = () => {
    throw new Error("network down");
  };

  let errored = false;
  let succeeded = false;
  player.deleteSession({
    data: { id: "ep1", token: "tok1" },
    success: () => {
      succeeded = true;
    },
    error: () => {
      errored = true;
    },
  });
  await flush();

  assert.equal(succeeded, false);
  assert.equal(errored, true);
  assert.equal(player.drmLock, false); // never stuck on the old session
  assert.ok(env.warnings.some((w) => w.includes("DRM session delete failed")));
  cleanup(env);
});

/* ------------------------------------------------------------------ */
/* 6. Late session.refresh callbacks are dropped by seq                */
/* ------------------------------------------------------------------ */

test("late session.refresh success from a previous session is dropped; modifier uses live token", async () => {
  const env = createEnv();
  env.showScreen();
  const { player } = env;

  const pendingRefreshes = [];
  env.sessionRefreshImpl = (cb) => pendingRefreshes.push(cb);

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.play({ id: "ep2", token: "t2" }, "https://cdn.test/ep2.mpd", 0, false);
  assert.equal(pendingRefreshes.length, 2);

  // ep1's refresh resolves LATE, after ep2's play started: dropped by seq.
  pendingRefreshes[0].success({ access_token: "stale-token", quality: "auto" });
  assert.equal(env.attachSourceCalls.length, 0);

  // ep2's refresh resolves: the stream attaches exactly once, for ep2.
  pendingRefreshes[1].success(env.session.storage);
  assert.equal(env.attachSourceCalls.length, 1);
  assert.equal(env.attachSourceCalls[0].url, "https://cdn.test/ep2.mpd");

  // The dashjs RequestModifier reads the LIVE session token, so a refreshed
  // token is used even though the play call captured older storage.
  env.session.storage.access_token = "fresh-token";
  const xhr = {
    headers: {},
    setRequestHeader(k, v) {
      this.headers[k] = v;
    },
  };
  env.requestModifier.modifyRequestHeader(xhr);
  assert.equal(xhr.headers["Authorization"], "Bearer fresh-token");
  cleanup(env);
});

test("late session.refresh error from a previous session does not trigger recovery", async () => {
  const env = createEnv();
  env.showScreen();
  const { player, video } = env;
  video.episode = "ep2";

  const pendingRefreshes = [];
  env.sessionRefreshImpl = (cb) => pendingRefreshes.push(cb);

  player.play({ id: "ep1", token: "t1" }, "https://cdn.test/ep1.mpd", 0, false);
  player.play({ id: "ep2", token: "t2" }, "https://cdn.test/ep2.mpd", 0, false);
  assert.equal(pendingRefreshes.length, 2);

  // Stale error callback: dropped by seq, no recovery for the old episode.
  pendingRefreshes[0].error(new Error("token refresh failed"));
  assert.equal(env.recoveries, 0);

  // The current session's error callback still triggers recovery.
  pendingRefreshes[1].error(new Error("token refresh failed"));
  assert.equal(env.recoveries, 1);
  cleanup(env);
});
