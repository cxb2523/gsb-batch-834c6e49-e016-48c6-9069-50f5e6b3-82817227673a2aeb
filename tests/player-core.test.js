const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../player-core.js");

test("session guard: begin() increments and invalidates older generations", () => {
  const guard = core.createSessionGuard();
  const g1 = guard.begin();
  assert.equal(guard.isCurrent(g1), true);
  const g2 = guard.begin();
  assert.notEqual(g1, g2);
  assert.equal(guard.isCurrent(g1), false);
  assert.equal(guard.isCurrent(g2), true);
  assert.equal(guard.current(), g2);
});

test("guardCallback: stale callbacks are dropped, current ones run", () => {
  const guard = core.createSessionGuard();
  const calls = [];
  const g1 = guard.begin();
  const stale = core.guardCallback(guard, g1, (x) => calls.push(["g1", x]));
  const g2 = guard.begin();
  const fresh = core.guardCallback(guard, g2, (x) => calls.push(["g2", x]));

  stale("a"); // belongs to previous session -> discarded
  assert.deepEqual(calls, []);
  assert.equal(stale("b"), undefined);
  assert.deepEqual(calls, []);

  fresh("c");
  assert.deepEqual(calls, [["g2", "c"]]);
});

test("getEntryId: local videos are stable across different blob URLs", () => {
  const first = { title: "movie.mp4", video: "blob:https://x/1", videoType: "local" };
  const second = { title: "movie.mp4", video: "blob:https://x/2", videoType: "local" };
  assert.equal(core.getEntryId(first), core.getEntryId(second));

  const urlA = { title: "movie.mp4", video: "https://cdn/a.mp4", videoType: "url" };
  const urlB = { title: "renamed.mp4", video: "https://cdn/a.mp4", videoType: "url" };
  assert.equal(core.getEntryId(urlA), core.getEntryId(urlB));
  assert.notEqual(core.getEntryId(first), core.getEntryId(urlA));
});

test("upsertRecent: replaying the same video updates instead of duplicating", () => {
  let recent = [];
  recent = core.upsertRecent(recent, { title: "a", video: "https://x/a", videoType: "url" });
  recent = core.upsertRecent(recent, { title: "b", video: "https://x/b", videoType: "url" });
  recent[1].progress = 42; // simulate stored progress for "a"

  recent = core.upsertRecent(recent, { title: "a", video: "https://x/a", videoType: "url" });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].video, "https://x/a"); // moved to top
  assert.equal(recent[0].progress, 42); // progress preserved, not reset
});

test("upsertRecent: local replay with a new blob URL matches the same entry", () => {
  let recent = core.upsertRecent([], {
    title: "clip.mp4", video: "blob:1", videoType: "local"
  });
  recent[0].progress = 77;
  recent = core.upsertRecent(recent, {
    title: "clip.mp4", video: "blob:2", videoType: "local"
  });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].video, "blob:2");
  assert.equal(recent[0].progress, 77);
});

test("upsertRecent: list is capped at the limit", () => {
  let recent = [];
  for (let i = 0; i < 35; i++) {
    recent = core.upsertRecent(recent, {
      title: "v" + i, video: "https://x/" + i, videoType: "url"
    }, 30);
  }
  assert.equal(recent.length, 30);
  assert.equal(recent[0].video, "https://x/34");
  assert.equal(recent[29].video, "https://x/5");
});

test("clampProgress clamps to 0-100 and handles junk", () => {
  assert.equal(core.clampProgress(-5), 0);
  assert.equal(core.clampProgress(250), 100);
  assert.equal(core.clampProgress(33.6), 34);
  assert.equal(core.clampProgress(NaN), 0);
  assert.equal(core.clampProgress(undefined), 0);
});

test("normalizeImport: dedupes by stable id, clamps progress, truncates to limit", () => {
  const data = [];
  for (let i = 0; i < 35; i++) {
    data.push({
      title: "v" + i, video: "https://x/" + i, videoType: "url",
      subtitle: "", subtitleType: "url", progress: i
    });
  }
  // duplicate of an earlier entry plus out-of-range progress values
  data.push({ title: "dup", video: "https://x/0", videoType: "url", subtitle: "", subtitleType: "url", progress: 55 });
  data.push({ title: "neg", video: "https://x/neg", videoType: "url", subtitle: "", subtitleType: "url", progress: -20 });
  data.push({ title: "over", video: "https://x/over", videoType: "url", subtitle: "", subtitleType: "url", progress: 400 });

  const items = core.normalizeImport(data, 30);
  assert.equal(items.length, 30); // truncated to the cap
  const ids = items.map(core.getEntryId);
  assert.equal(new Set(ids).size, ids.length); // no duplicates
  assert.ok(items.every((item) => item.progress >= 0 && item.progress <= 100));

  const small = core.normalizeImport([
    { title: "neg", video: "https://x/neg", videoType: "url", subtitle: "", subtitleType: "url", progress: -20 },
    { title: "over", video: "https://x/over", videoType: "url", subtitle: "", subtitleType: "url", progress: 400 }
  ]);
  assert.deepEqual(small.map((i) => i.progress), [0, 100]);
});

test("normalizeImport: rejects invalid data", () => {
  assert.equal(core.normalizeImport(null), null);
  assert.equal(core.normalizeImport({}), null);
  assert.equal(core.normalizeImport([{ title: 1 }]), null);
  assert.equal(core.normalizeImport([
    { title: "a", video: "u", videoType: "url", subtitle: "", subtitleType: "url", progress: NaN }
  ]), null);
});
