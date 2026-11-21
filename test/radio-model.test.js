import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_START,
  FALLBACK_DURATION,
  YT,
  buildCommand,
  decidePlaybackAction,
  durationOf,
  mergeDurations,
  normalizeCommand,
  resolvePosition,
  sanitizeDurations,
  sanitizePlaylist,
} from "../src/radio-model.js";

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";
const C = "ccccccccccc";
const LIST = [A, B, C];
const T0 = 1_800_000_000_000; // a fixed "now" for every case

test("sanitizePlaylist keeps ids, drops junk, falls back when empty", () => {
  assert.deepEqual(sanitizePlaylist([A, "has space", B, 42]), [A, B, "42"]);
  assert.deepEqual(sanitizePlaylist([], []), []);
  assert.deepEqual(sanitizePlaylist(["  "], [A, B]), [A, B]);
  assert.deepEqual(sanitizePlaylist([]).length > 0, true); // default playlist
  assert.deepEqual(sanitizePlaylist([A, A]), [A, A]); // duplicates are legal
});

test("sanitizeDurations keeps only playlist ids inside the bounds", () => {
  const out = sanitizeDurations({ [A]: 120, [B]: 0, [C]: 1e9, nope: 60 }, LIST);
  assert.deepEqual(out, { [A]: 120 });
});

test("mergeDurations: later tables win, invalid values are dropped", () => {
  assert.deepEqual(
    mergeDurations({ [A]: 0 }, { [A]: 90 }, { [B]: "150" }, null, { [B]: Infinity }),
    { [A]: 90, [B]: 150 },
  );
});

test("normalizeCommand accepts legacy {idx,at} and rejects garbage", () => {
  const legacy = normalizeCommand({ idx: 2, at: T0 }, LIST);
  assert.equal(legacy.idx, 2);
  assert.equal(legacy.at, T0);
  assert.deepEqual(legacy.playlist, LIST);
  assert.deepEqual(legacy.durations, {});
  assert.equal(legacy.rev, 0);

  assert.equal(normalizeCommand(null, LIST), null);
  assert.equal(normalizeCommand({ idx: 1 }, LIST), null); // no timestamp
  assert.equal(normalizeCommand({ idx: 1, at: "soon" }, LIST), null);
  assert.equal(normalizeCommand({ idx: 7, at: T0 }, LIST).idx, 1); // wraps into range
  assert.equal(normalizeCommand({ idx: -1, at: T0 }, LIST).idx, 2);
});

test("buildCommand stamps a new start and bumps rev, keeping known durations", () => {
  const first = buildCommand({ prev: null, idx: 1, at: T0, playlist: LIST });
  assert.equal(first.idx, 1);
  assert.equal(first.at, T0);
  assert.equal(first.rev, 1);

  const second = buildCommand({
    prev: first,
    idx: 2,
    at: T0 + 1000,
    playlist: LIST,
    durations: { [A]: 200 },
  });
  assert.equal(second.idx, 2);
  assert.equal(second.rev, 2);
  assert.deepEqual(second.durations, { [A]: 200 });
});

test("durationOf: known > placeholder, skipped is zero", () => {
  assert.equal(durationOf(A, { durations: { [A]: 80 } }), 80);
  assert.equal(durationOf(B, { durations: {} }), FALLBACK_DURATION);
  assert.equal(durationOf(A, { durations: { [A]: 80 }, skipped: new Set([A]) }), 0);
});

test("resolvePosition without a command walks from DEFAULT_START", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const r = resolvePosition({ durations, now: DEFAULT_START + 250_000, playlist: LIST });
  assert.equal(r.videoId, B);
  assert.equal(r.idx, 1);
  assert.ok(Math.abs(r.sec - 150) < 1e-9, `sec=${r.sec}`);
  assert.equal(r.blocked, false);
});

test("resolvePosition with a command: normal switch to track idx 1 at t+30s", () => {
  const command = normalizeCommand({ idx: 1, at: T0, rev: 3, playlist: LIST, durations: { [A]: 100, [B]: 200, [C]: 300 } }, LIST);
  const r = resolvePosition({ command, now: T0 + 30_000 });
  assert.equal(r.idx, 1);
  assert.equal(r.videoId, B);
  assert.equal(r.sec, 30);
  assert.equal(r.duration, 200);
});

test("resolvePosition: a late joiner gets the same answer as the player who was there", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const command = normalizeCommand({ idx: 1, at: T0, rev: 1, playlist: LIST, durations }, LIST);
  // 50 s into B: both the original tab and the one joining now resolve to B@50
  const fresh = resolvePosition({ command, durations, now: T0 + 50_000 });
  const local = resolvePosition({ command, localDurations: durations, now: T0 + 50_000 });
  assert.deepEqual(fresh, local);
});

test("resolvePosition walks past the end of the cycle into the next track", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const command = normalizeCommand({ idx: 1, at: T0, rev: 1, playlist: LIST, durations }, LIST);
  // 200 s after B started (at the exact end of B) lands at the start of C
  const r = resolvePosition({ command, now: T0 + 200_000 });
  assert.equal(r.idx, 2);
  assert.equal(r.videoId, C);
  assert.equal(r.sec, 0);

  // 350 s after B started: 150 s into C
  const s = resolvePosition({ command, now: T0 + 350_000 });
  assert.equal(s.idx, 2);
  assert.ok(Math.abs(s.sec - 150) < 1e-9);
});

test("resolvePosition wraps the whole playlist after a full cycle", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 }; // total 600
  const command = normalizeCommand({ idx: 1, at: T0, rev: 1, playlist: LIST, durations }, LIST);
  const r = resolvePosition({ command, now: T0 + 600_000 + 25_000 });
  assert.equal(r.idx, 1);
  assert.equal(r.sec, 25);
});

test("resolvePosition: a duration that arrives late retimes the same wall clock", () => {
  const command = normalizeCommand({ idx: 1, at: T0, rev: 1, playlist: LIST }, LIST);
  // with the placeholder (1 h each), 90 minutes in means track C at 30 min
  const before = resolvePosition({ command, now: T0 + 90 * 60_000 });
  assert.equal(before.idx, 2);
  assert.ok(Math.abs(before.sec - 30 * 60) < 1e-9);

  // once A and B report their real 100 s and 200 s, the answer moves but is the
  // same for everyone: 90 min after idx 1 with real durations is 5400 s into a
  // 600 s cycle -> 5400 % 600 = 0 -> back at B.
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const after = resolvePosition({ command, durations, now: T0 + 90 * 60_000 });
  assert.equal(after.idx, 1);
  assert.equal(after.sec, 0);
});

test("resolvePosition: skipped (error) tracks are walked past for everyone", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const command = normalizeCommand({ idx: 0, at: T0, rev: 1, playlist: LIST, durations }, LIST);
  const r = resolvePosition({ command, skipped: new Set([A]), now: T0 + 150_000 });
  // A is 0-length, so 150 s after the start is 150 s into B
  assert.equal(r.idx, 1);
  assert.equal(r.sec, 150);
});

test("resolvePosition: a skip carried by the command applies to every client", () => {
  const durations = { [A]: 100, [B]: 200, [C]: 300 };
  const command = normalizeCommand(
    { idx: 0, at: T0, rev: 2, playlist: LIST, durations, skipped: [A] },
    LIST,
  );
  // no local knowledge of the error, only the room's list
  const r = resolvePosition({ command, now: T0 + 150_000 });
  assert.equal(r.idx, 1);
  assert.equal(r.sec, 150);
  assert.equal(r.duration, 200);

  // a local skip adds to the room's, never removes from it: A and B are gone,
  // so 150 s after the start is 150 s into C
  const both = resolvePosition({ command, skipped: new Set([B]), now: T0 + 150_000 });
  assert.equal(both.idx, 2);
  assert.equal(both.sec, 150);
});

test("buildCommand clears the skip list (an admin action undoes a bad report)", () => {
  const prev = normalizeCommand({ idx: 0, at: T0, rev: 4, playlist: LIST, skipped: [A] }, LIST);
  const next = buildCommand({ prev, idx: 1, at: T0 + 1, playlist: LIST });
  assert.deepEqual(next.skipped, []);
  assert.equal(next.rev, 5);
});

test("resolvePosition: everything skipped is blocked, not an infinite walk", () => {
  const command = normalizeCommand({ idx: 0, at: T0, rev: 1, playlist: LIST }, LIST);
  const r = resolvePosition({ command, skipped: new Set(LIST), now: T0 + 10_000 });
  assert.equal(r.blocked, true);
  assert.equal(r.sec, 0);
});

test("resolvePosition: single-track playlist loops the same track", () => {
  const one = [A];
  const command = normalizeCommand({ idx: 0, at: T0, rev: 1, playlist: one, durations: { [A]: 60 } }, one);
  const r = resolvePosition({ command, now: T0 + 75_000 });
  assert.equal(r.idx, 0);
  assert.equal(r.videoId, A);
  assert.equal(r.sec, 15);
});

test("resolvePosition ignores time before the command (clock skew)", () => {
  const command = normalizeCommand({ idx: 1, at: T0, rev: 1, playlist: LIST, durations: { [B]: 200 } }, LIST);
  const r = resolvePosition({ command, now: T0 - 60_000 });
  assert.equal(r.idx, 1);
  assert.equal(r.sec, 0);
});

test("decidePlaybackAction: a different id is a load", () => {
  const a = decidePlaybackAction({
    targetVideoId: B,
    currentVideoId: A,
    targetSeconds: 12,
    currentSeconds: 3,
    playerState: YT.PLAYING,
  });
  assert.deepEqual(a, { type: "load", seconds: 12 });
});

test("decidePlaybackAction: a different position of the SAME id is a seek (single-track list)", () => {
  const a = decidePlaybackAction({
    targetVideoId: A,
    currentVideoId: A,
    targetSeconds: 40,
    currentSeconds: 5,
    playerState: YT.PLAYING,
  });
  assert.deepEqual(a, { type: "seek", seconds: 40 });
});

test("decidePlaybackAction: ENDED on the same id seeks back to the target", () => {
  const a = decidePlaybackAction({
    targetVideoId: A,
    currentVideoId: A,
    targetSeconds: 2,
    currentSeconds: 61,
    playerState: YT.ENDED,
  });
  assert.deepEqual(a, { type: "seek", seconds: 2 });
});

test("decidePlaybackAction: forced seek wins even when the position looks close", () => {
  const a = decidePlaybackAction({
    targetVideoId: A,
    currentVideoId: A,
    targetSeconds: 40,
    currentSeconds: 40.5,
    playerState: YT.PLAYING,
    force: true,
  });
  assert.equal(a.type, "seek");
});

test("decidePlaybackAction: drift inside the tolerance only resumes playback", () => {
  const a = decidePlaybackAction({
    targetVideoId: A,
    currentVideoId: A,
    targetSeconds: 40,
    currentSeconds: 39,
    playerState: YT.PAUSED,
  });
  assert.equal(a.type, "play");
  const b = decidePlaybackAction({
    targetVideoId: A,
    currentVideoId: A,
    targetSeconds: 40,
    currentSeconds: 40.5,
    playerState: YT.PLAYING,
  });
  assert.equal(b.type, "none");
});
