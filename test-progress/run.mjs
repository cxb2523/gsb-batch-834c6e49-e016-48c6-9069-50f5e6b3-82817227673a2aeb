/**
 * Acceptance tests for the unified playback-progress chain.
 *
 * Run from the repo root:
 *   node --import ./test-progress/register-hooks.mjs test-progress/run.mjs
 *
 * Simulates locally constructed video lists and mock player events against
 * the real appStore module (localStorage / window / document are stubbed).
 */

// --- Browser stubs (must exist before appStore module evaluates) ----------
const storage = new Map();
let writeCount = 0;
const listeners = new Map();

globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => {
    writeCount++;
    storage.set(String(k), String(v));
  },
  removeItem: (k) => {
    storage.delete(k);
  },
  clear: () => storage.clear(),
};

const on = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
const emit = (type) => {
  for (const fn of listeners.get(type) || []) fn();
};

globalThis.window = { addEventListener: on, removeEventListener: () => {} };
globalThis.document = {
  visibilityState: "visible",
  addEventListener: (type, fn) => on(`doc:${type}`, fn),
};

// Pre-seed persisted progress to verify hydration on module load
storage.set("yt.progress", JSON.stringify({ SEED: 7 }));

const { appStore } = await import("../src/lib/appStore.ts");

// --- Test helpers -----------------------------------------------------------
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${extra ? `  (${extra})` : ""}`);
  }
}
const savedProgress = () => JSON.parse(storage.get("yt.progress") || "{}");
const makeVideo = (id) => ({
  url: `/watch?v=${id}`,
  title: `Video ${id}`,
  thumbnail: "",
  uploaderName: "tester",
  duration: 120,
});

// --- 1. Hydration -----------------------------------------------------------
console.log("\n[1] Hydration from localStorage");
check("hydrates existing yt.progress", appStore.getPlaybackTime("SEED") === 7);
check("unknown id starts at 0", appStore.getPlaybackTime("NOPE") === 0);

// --- 2. Watch <-> miniplayer round trip keeps time continuous ---------------
console.log("\n[2] Watch page <-> miniplayer round trip");
appStore.setPlaybackTime("ROUND", 30); // watch page playing
appStore.flushPlaybackTimes();
const atMinimize = appStore.getPlaybackTime("ROUND");
appStore.setMiniplayer({ video: makeVideo("ROUND"), time: atMinimize });
appStore.setPlaybackTime("ROUND", 47); // keeps playing inside miniplayer
const atExpand = appStore.getPlaybackTime("ROUND"); // expand back to watch page
appStore.setMiniplayer(null);
check("minimize captures current time", atMinimize === 30, `got ${atMinimize}`);
check("expand resumes from miniplayer time, not 0", atExpand === 47, `got ${atExpand}`);

// --- 3. Per-id isolation across consecutive switches ------------------------
console.log("\n[3] Per-video-id progress isolation");
appStore.setPlaybackTime("A", 61);
appStore.setPlaybackTime("B", 12);
appStore.setPlaybackTime("C", 99);
// A late timeupdate from A's player arrives after switching to C.
// Because reports are keyed by the emitting player's id, it lands on A.
appStore.setPlaybackTime("A", 62);
appStore.flushPlaybackTimes();
{
  const p = savedProgress();
  check(
    "each id keeps its own progress",
    p.A === 62 && p.B === 12 && p.C === 99,
    JSON.stringify(p),
  );
}

// --- 4. Queue advance: order, end-of-queue safety, progress flush -----------
console.log("\n[4] Queue auto-advance");
appStore.clearQueue();
["Q1", "Q2", "Q3"].forEach((id) => appStore.addToQueue(makeVideo(id)));
appStore.setQueueIndex(0);
check("advances to 2nd video", appStore.advanceQueue()?.url === "/watch?v=Q2");
appStore.setPlaybackTime("Q2", 88); // still playing Q2, not yet flushed
check("advances to 3rd video", appStore.advanceQueue()?.url === "/watch?v=Q3");
check(
  "advanceQueue flushed previous video progress",
  savedProgress().Q2 === 88,
  `got ${savedProgress().Q2}`,
);
check("end of queue returns null", appStore.advanceQueue() === null);
{
  const snap = appStore.getSnapshot();
  check("index stays on last video (no overrun)", snap.queueIndex === 2, `got ${snap.queueIndex}`);
  check("queue is not cleared at the end", snap.queue.length === 3);
}
appStore.setQueueIndex(-1);
appStore.setQueueIndex(99);
check("no negative / overflow index", appStore.getSnapshot().queueIndex === 2);

// --- 5. Throttled writes + rapid switching ----------------------------------
console.log("\n[5] Throttled persistence");
{
  const w0 = writeCount;
  for (let i = 1; i <= 100; i++) appStore.setPlaybackTime("RAPID", i);
  const syncWrites = writeCount - w0;
  check("no localStorage write per timeupdate", syncWrites <= 1, `writes=${syncWrites}`);
  await new Promise((r) => setTimeout(r, 2300)); // let the trailing flush fire
  check(
    "trailing flush wrote at most once more",
    writeCount - w0 <= 2,
    `writes=${writeCount - w0}`,
  );
  check("trailing flush persisted latest value", savedProgress().RAPID === 100);
}
{
  // Rapid consecutive switches: final persisted progress belongs to the
  // video last stayed on, and every id keeps its own last value.
  const seq = [
    ["S1", 5],
    ["S2", 6],
    ["S3", 7],
    ["S1", 8],
    ["S2", 9],
    ["S3", 42],
  ];
  for (const [id, t] of seq) appStore.setPlaybackTime(id, t);
  appStore.flushPlaybackTimes();
  const p = savedProgress();
  check(
    "rapid switching: last-stayed video wins, ids don't pollute each other",
    p.S3 === 42 && p.S1 === 8 && p.S2 === 9,
    JSON.stringify({ S1: p.S1, S2: p.S2, S3: p.S3 }),
  );
}

// --- 6. Flush on page unload ------------------------------------------------
console.log("\n[6] Flush on unload / hidden");
appStore.setPlaybackTime("UNLOAD", 55);
emit("pagehide"); // unload before the throttle timer fires
check("pagehide flushes final progress", savedProgress().UNLOAD === 55);

appStore.setPlaybackTime("HIDDEN", 66);
globalThis.document.visibilityState = "hidden";
emit("doc:visibilitychange");
check("visibilitychange(hidden) flushes", savedProgress().HIDDEN === 66);
globalThis.document.visibilityState = "visible";

// --- 7. Flush listeners (cloud sync hook) ------------------------------------
console.log("\n[7] Flush listener notification");
{
  let flushed = null;
  const unsub = appStore.onPlaybackProgressFlush((times, ids) => {
    flushed = { ids, time: times.CLOUD };
  });
  appStore.setPlaybackTime("CLOUD", 77);
  appStore.flushPlaybackTimes();
  check(
    "listener receives changed ids and values",
    Array.isArray(flushed?.ids) && flushed.ids.includes("CLOUD") && flushed.time === 77,
    JSON.stringify(flushed),
  );
  unsub();
}

// --- 8. Duplicate reports are ignored ---------------------------------------
console.log("\n[8] Duplicate / invalid reports");
{
  const w0 = writeCount;
  appStore.setPlaybackTime("CLOUD", 77); // same floored value as already stored
  appStore.setPlaybackTime("", 10); // empty id
  appStore.setPlaybackTime("NEG", -5); // negative time
  appStore.flushPlaybackTimes();
  check(
    "duplicate report does not schedule a write",
    writeCount === w0,
    `writes=${writeCount - w0}`,
  );
  check("empty id / negative time rejected", !("NEG" in savedProgress()));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
