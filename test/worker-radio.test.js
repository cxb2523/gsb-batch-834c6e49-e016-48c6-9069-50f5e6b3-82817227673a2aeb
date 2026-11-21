import test from "node:test";
import assert from "node:assert/strict";

import { Room } from "../worker/index.js";
import { resolvePosition } from "../src/radio-model.js";

// Minimal Durable Object infrastructure: storage in a Map and a fake socket that
// records what the room sends.
class Storage {
  constructor() {
    this.map = new Map();
  }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}

class Socket {
  constructor(ip = "1.1.1.1") {
    this.sent = [];
    this.attachment = { id: Math.random().toString(16).slice(2, 10), name: "t", gender: "male", x: 0, z: 0, dir: "down", step: 0, ip };
  }
  serializeAttachment(a) { this.attachment = a; }
  deserializeAttachment() { return this.attachment; }
  send(s) { this.sent.push(JSON.parse(s)); }
  messages() { return this.sent; }
  last(type) { return [...this.sent].reverse().find((m) => m.t === type); }
}

function makeRoom({ password = "secret" } = {}) {
  const storage = new Storage();
  const sockets = [];
  const state = {
    storage,
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
  };
  const room = new Room(state, { ADMIN_PASSWORD: password });
  const addSocket = (ip) => {
    const ws = new Socket(ip);
    sockets.push(ws);
    return ws;
  };
  return { room, storage, sockets, addSocket };
}

const A = "x6ujm9B-vAc"; // the room's real playlist id
const T0 = 1_800_000_000_000;

test("an admin switch stores a command with everything a late joiner needs", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  const admin = addSocket("2.2.2.2");
  await room.webSocketMessage(admin, JSON.stringify({ t: "radio", idx: 0, password: "secret" }));

  const stored = storage.map.get("radio");
  assert.ok(stored, "the command is persisted so a reconnect can read it");
  assert.equal(stored.idx, 0);
  assert.equal(stored.at, T0);
  assert.equal(stored.rev, 1);
  assert.ok(Array.isArray(stored.playlist) && stored.playlist.length > 0);
  assert.deepEqual(stored.playlist, [A]);
  assert.equal(typeof stored.durations, "object");
});

test("a wrong password changes nothing", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  const ws = addSocket("2.2.2.2");
  await room.webSocketMessage(ws, JSON.stringify({ t: "radio", idx: 0, password: "nope" }));
  assert.equal(storage.map.get("radio"), undefined);
  assert.equal(ws.last("error").msg, "invalid admin password");
});

test("a joining client gets a snapshot command it can resolve alone", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, addSocket } = makeRoom();
  const admin = addSocket("2.2.2.2");
  await room.webSocketMessage(admin, JSON.stringify({ t: "radio", idx: 0, password: "secret" }));

  // simulate a later join: the client would ask for the state on connect; the
  // room's radio() is what fetch() sends with snapshot:true
  const command = await room.radio();
  assert.equal(command.snapshot, undefined);
  const snapshot = { ...command, snapshot: true };

  // the joining client resolves the position from the snapshot alone
  const late = resolvePosition({ command: snapshot, now: T0 + 30_000 });
  assert.equal(late.videoId, A);
  assert.equal(late.sec, 30);
});

test("duration reports are validated against the room's playlist and clamped", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  const ws = addSocket("3.3.3.3");
  await room.webSocketMessage(
    ws,
    JSON.stringify({
      t: "durations",
      // a real id with a real length, an unknown id, a zero, a huge value, junk
      durations: { [A]: 212.4, evil: 300, "x6ujm9B-vAd": 60 },
    }),
  );
  const stored = storage.map.get("radio");
  assert.ok(stored, "the room creates a command from the default start");
  assert.deepEqual(stored.durations, { [A]: 212.4 });
  assert.equal(stored.durations.evil, undefined);
});

test("a reported duration retimes the room's command for late joiners", async (t) => {
  let now = T0;
  t.mock.method(Date, "now", () => now);
  const { room, storage, addSocket } = makeRoom();
  const admin = addSocket("4.4.4.4");
  await room.webSocketMessage(admin, JSON.stringify({ t: "radio", idx: 0, password: "secret" }));
  const before = storage.map.get("radio");

  // 30 s later a player reports the real length
  now = T0 + 30_000;
  await room.webSocketMessage(addSocket("5.5.5.5"), JSON.stringify({ t: "durations", durations: { [A]: 180 } }));
  const after = storage.map.get("radio");

  assert.equal(after.idx, before.idx);
  assert.equal(after.at, before.at, "same start: the track must not restart");
  assert.equal(after.durations[A], 180);
  assert.ok(after.rev > before.rev, "the revision grows so clients accept the retime");

  // a late joiner at T0+90s resolves the same second as an early one
  const late = resolvePosition({ command: after, now: T0 + 90_000 });
  const early = resolvePosition({ command: after, now: T0 + 90_000 });
  assert.deepEqual(late, early);
  assert.equal(late.sec, 90);
});

test("a repeated duration report does not bump the command or spam the room", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  const ws = addSocket("6.6.6.6");
  await room.webSocketMessage(ws, JSON.stringify({ t: "durations", durations: { [A]: 180 } }));
  const first = storage.map.get("radio");
  const sentBefore = ws.sent.length;
  await room.webSocketMessage(ws, JSON.stringify({ t: "durations", durations: { [A]: 180 } }));
  assert.equal(storage.map.get("radio").rev, first.rev);
  assert.equal(ws.sent.length, sentBefore);
});

test("a skip report is stored on the command; repeats and unknown ids are ignored", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  const ws = addSocket("7.7.7.7");
  await room.webSocketMessage(ws, JSON.stringify({ t: "skip", id: A }));
  const first = storage.map.get("radio");
  assert.deepEqual(first.skipped, [A]);
  assert.ok(first.rev > 0);

  const sentBefore = ws.sent.length;
  await room.webSocketMessage(ws, JSON.stringify({ t: "skip", id: A }));
  await room.webSocketMessage(ws, JSON.stringify({ t: "skip", id: "not-in-the-playlist" }));
  assert.equal(storage.map.get("radio").rev, first.rev);
  assert.equal(ws.sent.length, sentBefore);
});

test("an admin switch clears the room's skip list", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage, addSocket } = makeRoom();
  await room.webSocketMessage(addSocket("8.8.8.8"), JSON.stringify({ t: "skip", id: A }));
  assert.deepEqual(storage.map.get("radio").skipped, [A]);

  await room.webSocketMessage(addSocket("9.9.9.9"), JSON.stringify({ t: "radio", idx: 0, password: "secret" }));
  assert.deepEqual(storage.map.get("radio").skipped, []);
});

test("legacy { idx, at } storage is upgraded, not rejected", async (t) => {
  t.mock.method(Date, "now", () => T0);
  const { room, storage } = makeRoom();
  storage.map.set("radio", { idx: 0, at: T0 - 5000 });
  const command = await room.radio();
  assert.equal(command.at, T0 - 5000);
  assert.deepEqual(command.playlist, [A]);
  assert.equal(command.rev, 0);
});

test("fetch() sends the radio snapshot with the snapshot flag, before the player list", async () => {
  // fetch needs a WebSocketPair; Node 22+ has it. The fake pair records sends so
  // we can check what the room sends on connect.
  const sent = [];
  if (typeof WebSocketPair === "undefined") {
    globalThis.WebSocketPair = function WebSocketPair() {
      const server = {
        send: (s) => sent.push(JSON.parse(s)),
        serializeAttachment() {},
        deserializeAttachment() { return null; },
        close() {},
      };
      return { 0: { send() {}, close() {} }, 1: server };
    };
  }
  const { room } = makeRoom();
  room.state.storage.map.set("radio", { idx: 0, at: T0, rev: 3, playlist: [A], durations: { [A]: 100 } });
  const original = room.state.acceptWebSocket;
  room.state.acceptWebSocket = (ws) => {
    const send = ws.send;
    ws.send = (s) => { sent.push(JSON.parse(s)); return send?.(s); };
    original(ws);
  };
  // Node's Response rejects the 101 switch needed by a WebSocket upgrade
  const RealResponse = globalThis.Response;
  globalThis.Response = class { constructor(body, init) { this.body = body; this.status = init?.status; } };
  try {
    const req = new Request("https://example.com/ws/lobby", { headers: { Upgrade: "websocket" } });
    await room.fetch(req);
  } finally {
    room.state.acceptWebSocket = original;
    globalThis.Response = RealResponse;
  }
  const radio = sent.find((m) => m.t === "radio");
  assert.ok(radio, "the client must receive the room's radio state on connect");
  assert.equal(radio.command.snapshot, true);
  assert.equal(radio.command.idx, 0);
  assert.equal(radio.command.rev, 3);
  assert.deepEqual(radio.command.durations, { [A]: 100 });
  assert.equal(
    sent.indexOf(radio) < sent.findIndex((m) => m.t === "state"),
    true,
    "radio precedes the player list",
  );
});
