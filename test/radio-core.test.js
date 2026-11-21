import test from "node:test";
import assert from "node:assert/strict";

import { createRadioCore } from "../src/radio-core.js";
import { YT, buildCommand, normalizeCommand } from "../src/radio-model.js";

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const C = "ccccccccccc";
const LIST = [A, B, C];
const T0 = 1_800_000_000_000;

// A fake YouTube player: records what the core asked it to do and lets the test
// pretend the iframe lags (with `sticky`, getVideoData keeps reporting the old
// video until the test says the new one buffered, like the real embed).
function fakePlayer({ videoId = A, state = YT.PLAYING, seconds = 0, sticky = false } = {}) {
  const calls = [];
  const p = {
    calls,
    videoId,
    state,
    seconds,
    getVideoId: () => p.videoId,
    getCurrentTime: () => p.seconds,
    getState: () => p.state,
    load(videoId, startSeconds) {
      calls.push({ type: "load", videoId, startSeconds });
      if (sticky) return; // the iframe hasn't switched yet
      p.videoId = videoId;
      p.seconds = startSeconds;
      p.state = YT.BUFFERING;
    },
    seek(seconds) {
      calls.push({ type: "seek", seconds });
      p.seconds = seconds;
    },
    play() {
      calls.push({ type: "play" });
      p.state = YT.PLAYING;
    },
    pause() {
      calls.push({ type: "pause" });
      p.state = YT.PAUSED;
    },
    // what the iframe reports once a load has buffered
    buffered(videoId = p.videoId) {
      p.videoId = videoId;
      p.state = YT.PLAYING;
    },
  };
  return p;
}

function boot({ command = null, at = T0, playlist = LIST, player } = {}) {
  let clock = at;
  const covers = [];
  const titles = [];
  const reports = [];
  const core = createRadioCore({
    playlist,
    command,
    now: () => clock,
    onTitle: (t) => titles.push(t),
    onCover: (c) => covers.push(c),
    onDurations: (d) => reports.push(d),
  });
  const p = player || fakePlayer();
  core.attach(p);
  core.ready();
  return {
    core,
    player: p,
    covers,
    titles,
    reports,
    advance(ms) { clock += ms; },
    now: () => clock,
  };
}

const cmd = (idx, at, durations = {}, playlist = LIST) =>
  buildCommand({ prev: null, idx, at, playlist, durations });

test("normal switch: an admin command loads the right video at the right second", () => {
  const h = boot();
  // 1000 s since the default clock is far off; a fresh command takes over
  h.core.setCommand(cmd(1, h.now(), { [A]: 100, [B]: 200, [C]: 300 }));
  const load = h.player.calls.filter((c) => c.type === "load").at(-1);
  assert.ok(load, "expected a load after the switch");
  assert.equal(load.videoId, B);
  assert.equal(load.startSeconds, 0);

  // the iframe reports the load landed; 45 s later the tick leaves it alone
  h.player.buffered();
  h.advance(45_000);
  h.player.seconds = 45;
  const loadsBefore = h.player.calls.filter((c) => c.type === "load").length;
  const seeksBefore = h.player.calls.filter((c) => c.type === "seek").length;
  h.core.tick();
  assert.equal(h.player.calls.filter((c) => c.type === "load").length, loadsBefore);
  assert.equal(h.player.calls.filter((c) => c.type === "seek").length, seeksBefore);
  assert.equal(h.core.snapshot().resolved.sec, 45);
});

test("late joiner: same track and second as the room, from the command alone", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const startedAt = T0;
  // the room's tab has been playing B for 50 s
  const room = boot({ command: cmd(1, startedAt, durations), at: startedAt + 50_000 });
  assert.equal(room.core.snapshot().resolved.videoId, B);
  assert.equal(room.core.snapshot().resolved.sec, 50);

  // a newcomer with the same server snapshot (no cache) resolves identically
  const late = boot({ command: cmd(1, startedAt, durations), at: startedAt + 50_000 });
  assert.deepEqual(late.core.snapshot().resolved, room.core.snapshot().resolved);
  const load = late.player.calls.find((c) => c.type === "load") || { startSeconds: 50 };
  // the newcomer's first frame may be B from 0 and then seeked to 50, or loaded at 50
  const seek = late.player.calls.find((c) => c.type === "seek");
  assert.ok(load.startSeconds === 50 || (seek && seek.seconds === 50), JSON.stringify(late.player.calls));
});

test("duration arriving late retimes the same command, for every tab", () => {
  const command = cmd(1, T0); // no durations yet: 1 h placeholders
  const early = boot({ command, at: T0 + 90 * 60_000 });
  // with placeholders, 90 min after B starts is C at 30 min
  assert.equal(early.core.snapshot().resolved.videoId, C);
  assert.equal(early.core.snapshot().resolved.sec, 30 * 60);

  // the player finally reports B's real duration; the core retimes immediately
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  early.core.applyDurations(durations);
  assert.equal(early.core.snapshot().resolved.videoId, B);
  assert.equal(early.core.snapshot().resolved.sec, 0);

  // a tab that joins after the report gets exactly the same answer
  const late = boot({ command: cmd(1, T0, durations), at: T0 + 90 * 60_000 });
  assert.deepEqual(late.core.snapshot().resolved, early.core.snapshot().resolved);
});

test("a learned duration is reported and folded into the command (survives reconnect)", () => {
  const h = boot({ command: cmd(0, T0) });
  h.player.buffered();
  h.core.stateChange({ state: YT.PLAYING, videoId: A, title: "Song A", duration: 42.5 });
  assert.deepEqual(h.reports.at(-1), { [A]: 42.5 });
  assert.equal(h.core.snapshot().command.durations[A], 42.5);

  // a bad duration (0, NaN, absurd) is ignored
  h.core.stateChange({ state: YT.PLAYING, videoId: B, duration: 0 });
  h.core.stateChange({ state: YT.PLAYING, videoId: B, duration: NaN });
  h.core.stateChange({ state: YT.PLAYING, videoId: B, duration: 1e9 });
  assert.equal(B in h.core.snapshot().command.durations, false);
});

test("player error skips that track and resolves to the same next one", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const h = boot({ command: cmd(0, T0, durations), at: T0 + 10_000 });
  assert.equal(h.core.snapshot().resolved.videoId, A);

  h.core.error(A);
  // A counts as zero-length for this tab: 10 s after start is 10 s into B
  const after = h.core.snapshot().resolved;
  assert.equal(after.videoId, B);
  assert.equal(after.sec, 10);
  const load = h.player.calls.filter((c) => c.type === "load").at(-1);
  assert.equal(load.videoId, B);

  // another tab that hits the same error converges on the same answer
  const other = boot({ command: cmd(0, T0, durations), at: T0 + 10_000 });
  other.core.error(A);
  assert.deepEqual(other.core.snapshot().resolved, after);
});

test("an error is reported to the room and a room skip changes this tab too", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const reports = [];
  const core = createRadioCore({
    playlist: LIST,
    command: cmd(0, T0, durations),
    now: () => T0 + 10_000,
    onSkip: (id) => reports.push(id),
  });
  core.attach(fakePlayer());
  core.ready();
  core.error(A);
  assert.deepEqual(reports, [A]);

  // the server broadcasts the room's skip list; a tab that never saw the error
  // walks past A as well
  const quiet = boot({ command: cmd(0, T0, durations), at: T0 + 10_000 });
  assert.equal(quiet.core.snapshot().resolved.videoId, A);
  quiet.core.applySkipped([A]);
  const r = quiet.core.snapshot().resolved;
  assert.equal(r.videoId, B);
  assert.equal(r.sec, 10);
});

test("single-track playlist: a switch seeks instead of 'already playing that song'", () => {
  const ONE = [A];
  const h = boot({ command: cmd(0, T0, { [A]: 600 }, ONE), at: T0 + 300_000, playlist: ONE });
  h.player.buffered();
  h.player.seconds = 300;
  const seeksBefore = h.player.calls.filter((c) => c.type === "seek").length;
  h.core.tick();
  assert.equal(h.core.snapshot().resolved.videoId, A);
  assert.equal(h.core.snapshot().resolved.sec, 300);
  // in position already: no correction
  assert.equal(h.player.calls.filter((c) => c.type === "seek").length, seeksBefore);

  // admin restarts the only track: same video id, but a new start -> a seek to 0
  h.core.setCommand(cmd(0, h.now(), { [A]: 600 }, ONE));
  const seek = h.player.calls.filter((c) => c.type === "seek").at(-1);
  assert.ok(seek, "a restart of the same video must seek, not be a no-op");
  assert.equal(seek.seconds, 0);
});

test("video ENDED re-resolves: next track, or the same track next loop", () => {
  const h = boot({ command: cmd(0, T0, { [A]: 60, [B]: 60, [C]: 60 }), at: T0 + 59_000 });
  assert.equal(h.core.snapshot().resolved.videoId, A);
  h.advance(2000); // now 61 s in: A ended, B started 1 s ago
  h.player.state = YT.ENDED;
  h.core.stateChange({ state: YT.ENDED, videoId: A });
  const action = h.player.calls.at(-1);
  // the core loads B (different id) or seeks it if the iframe already reports B
  assert.ok(
    (action.type === "load" && action.videoId === B) || (action.type === "seek"),
    JSON.stringify(h.player.calls),
  );
  assert.equal(h.core.snapshot().resolved.videoId, B);
  assert.equal(h.core.snapshot().resolved.sec, 1);

  // one-track list: ENDED puts the same song back at the looped position
  const one = boot({ command: cmd(0, T0, { [A]: 60 }, [A]), at: T0 + 60_500, playlist: [A] });
  one.player.state = YT.ENDED;
  one.core.stateChange({ state: YT.ENDED, videoId: A });
  const seek = one.player.calls.filter((c) => c.type === "seek").at(-1);
  assert.ok(seek, JSON.stringify(one.player.calls));
  assert.ok(Math.abs(seek.seconds - 0.5) < 1e-6, `seek=${seek.seconds}`);
});

test("reconnect: the server's snapshot replaces a newer-looking stale local command", () => {
  const stale = normalizeCommand(
    { idx: 2, at: T0, rev: 9, playlist: LIST, durations: { [C]: 300 } },
    LIST,
  );
  const h = boot({ command: stale, at: T0 + 5000 });

  // the server's snapshot has an older rev but is the room's truth after reconnect
  const snapshot = normalizeCommand(
    { idx: 1, at: T0 + 4000, rev: 2, playlist: LIST, durations: { [B]: 200 }, snapshot: true },
    LIST,
  );
  assert.equal(h.core.setCommand(snapshot, { snapshot: true }), true);
  assert.equal(h.core.snapshot().command.idx, 1);
  assert.equal(h.core.snapshot().command.at, T0 + 4000);
  const load = h.player.calls.filter((c) => c.type === "load").at(-1);
  assert.equal(load.videoId, B);
});

test("reconnect: without the snapshot flag a stale broadcast cannot roll back a newer command", () => {
  const h = boot({ command: cmd(1, T0 + 10_000) });
  const older = buildCommand({ prev: null, idx: 0, at: T0, playlist: LIST });
  assert.equal(h.core.setCommand(older), false);
  assert.equal(h.core.snapshot().command.idx, 1); // unchanged
});

test("switching tracks resets cover and title so the old one cannot cover the new video", () => {
  const h = boot({ command: cmd(0, T0, { [A]: 100 }), at: T0 + 10_000 });
  h.core.stateChange({ state: YT.PLAYING, videoId: A, title: "Old Song", duration: 100 });
  assert.equal(h.titles.at(-1), "Old Song");

  h.core.setCommand(cmd(1, h.now(), { [A]: 100, [B]: 200 }));
  // the moment of the switch: title cleared and the cover points at the new video
  assert.equal(h.titles.at(-1), "");
  assert.deepEqual(h.covers.at(-1), { playing: false, videoId: B });
  const load = h.player.calls.filter((c) => c.type === "load").at(-1);
  assert.equal(load.videoId, B);

  // the new title only shows once the new video reports it
  h.player.buffered();
  h.core.stateChange({ state: YT.PLAYING, videoId: B, title: "New Song", duration: 200 });
  assert.equal(h.titles.at(-1), "New Song");
});

test("a duration update for the same start retimes without resetting the little TV", () => {
  const h = boot({ command: cmd(1, T0), at: T0 + 20_000 });
  h.player.buffered();
  h.core.stateChange({ state: YT.PLAYING, videoId: B, title: "Song B", duration: 200 });
  const titlesBefore = h.titles.length;

  h.core.applyDurations({ [A]: 100, [B]: 200, [C]: 300 });
  assert.equal(h.titles.length, titlesBefore, "no reset for a duration-only change");
  assert.equal(h.core.snapshot().resolved.sec, 20);
});

test("a load that the iframe ignores is retried, not left stuck", () => {
  const h = boot({ player: fakePlayer({ sticky: true }) });
  h.core.setCommand(cmd(1, h.now(), { [A]: 100, [B]: 200 }));
  const loads = () => h.player.calls.filter((c) => c.type === "load").length;
  // the core may have issued the initial load for the default clock first; count
  // only the switch's load
  const first = loads();
  assert.ok(first >= 1);

  // the iframe never reports the new video: a tick inside the wait does nothing,
  // a tick after LOAD_RETRY_MS issues the load again
  h.advance(2000);
  h.core.tick();
  assert.equal(loads(), first);
  h.advance(11_000);
  h.core.tick();
  assert.ok(loads() > first, "the load must be retried");
});

test("a lagging iframe is not stolen back by the tick while the new video loads", () => {
  const h = boot({ player: fakePlayer({ sticky: true }) });
  h.core.setCommand(cmd(1, h.now(), { [A]: 100, [B]: 200 }));
  const loads = h.player.calls.filter((c) => c.type === "load");
  assert.equal(loads.at(-1).videoId, B);

  // the iframe still reports A for a moment: it must not be loaded back to A
  h.advance(500);
  h.core.tick();
  assert.equal(h.player.calls.filter((c) => c.type === "load").at(-1).videoId, B);
});

test("paused: no player calls until resume", () => {
  const h = boot({ command: cmd(0, T0, { [A]: 100 }), at: T0 + 10_000 });
  h.core.pause();
  const before = h.player.calls.length;
  h.advance(5000);
  h.core.tick();
  assert.equal(h.player.calls.length, before);
  h.core.resume();
  assert.ok(h.player.calls.length > before);
});
