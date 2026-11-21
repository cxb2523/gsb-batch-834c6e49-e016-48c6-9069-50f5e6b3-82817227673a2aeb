// Room server: one Durable Object per room, everyone connected over WebSocket.
// Protocol (JSON):
//   client -> server: { t: "hello", name, gender } | { t: "pos", x, z, dir, step }
//                     { t: "chat", text } | { t: "name", name } | { t: "gender", gender }
//                     { t: "radio", idx, password }   (admin)
//                     { t: "durations", durations }   (a player's learned track lengths)
//                     { t: "skip", id }               (a player could not play a track)
//   server -> client: { t: "you", id } | { t: "state", players: [...] }
//                     { t: "joined", player } | { t: "left", id } | { t: "pos", ... }
//                     { t: "chat", id, name, text, at } | { t: "name", id, name }
//                     { t: "gender", id, gender } | { t: "radio", command } | { t: "error", msg }
//
// The radio command is the room's state, and it must be enough for a client that
// joins (or reconnects) later to compute the same track and second as everyone:
//   { v, idx, at, rev, playlist, durations }
// `at` is the instant the track started, `rev` orders newer over older, and
// `durations` is the room's learned table of real track lengths. The snapshot
// sent right after connecting carries `snapshot: true` and always wins on the
// client, so a stale local cache can never override the room.
//
// Security (the client is public, so nothing coming from it is trusted):
//  - max message size, per-connection rate limit, max players per room
//  - admin password only on the server (ADMIN_PASSWORD secret), constant-time compare,
//    few attempts per connection
//  - allowed origins (ALLOWED_ORIGINS) so other sites can't use this server
//  - per IP: few connections, shared chat budget, admin lockout, progressive mute for spam
//  - all text is stripped of control characters and truncated; numbers finite and clamped
//  - durations and playlist ids from the client are checked against the room's own
//    playlist and clamped, never taken as-is

import {
  DEFAULT_START,
  PLAYLIST as PLAYLIST_SOURCE,
  buildCommand,
  mergeDurations,
  normalizeCommand,
  sanitizeDurations,
  sanitizePlaylist,
  sanitizeSkipped,
} from "../src/radio-model.js";

const MAX_PLAYERS = 100;
// v1 has a single room; any other name is refused so nobody can spin up extra rooms (and extra cost)
const ROOMS = ["lobby"];
const MAX_BYTES = 1024;
const COORD_LIMIT = 500;
const ADMIN_ATTEMPTS = 5; // per IP, then locked for ADMIN_LOCK_MS
const ADMIN_LOCK_MS = 15 * 60_000;
const MAX_PER_IP = 3; // tabs/devices behind one IP
// progressive mute: each spam strike mutes for longer; strikes are forgotten after STRIKE_RESET_MS quiet
const MUTE_STEPS_MS = [0, 15_000, 60_000, 5 * 60_000, 30 * 60_000]; // first strike is only a warning
const STRIKE_RESET_MS = 30 * 60_000;
const REPEAT_LIMIT = 3; // the same text more than this many times in a row...
const REPEAT_WINDOW_MS = 30_000; // ...inside this window counts as spam
// rate buckets: capacity, refill per second
const RATES = { pos: [30, 20], chat: [8, 1], other: [10, 1] };

const DIRS = ["down", "up", "left", "right"];
const PLAYLIST = sanitizePlaylist(PLAYLIST_SOURCE);
const BASE_COMMAND = normalizeCommand({ idx: 0, at: DEFAULT_START, rev: 0, playlist: PLAYLIST }) || null;
const cleanText = (s, max) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const number = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) : 0;
};
const gender = (g) => (g === "female" ? "female" : "male");

// constant-time compare (timing doesn't leak how many characters match)
function equal(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map(); // "ip|type" or "ws-id|pos" -> { tokens, at } (in memory)
    this.spam = new Map(); // ip -> { strikes, mutedUntil, lastStrike, lastText, lastAt }
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.state.getWebSockets().length >= MAX_PLAYERS) return new Response("room is full", { status: 503 });
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const sameIp = this.state.getWebSockets().filter((w) => w.deserializeAttachment()?.ip === ip).length;
    if (sameIp >= MAX_PER_IP) return new Response("too many connections", { status: 429 });

    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    // hibernation: the DO can sleep with connections open; each player's
    // state lives on its own socket (serializeAttachment)
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, name: "trainer", gender: "male", x: 0, z: 0, dir: "down", step: 0, ip });
    server.send(JSON.stringify({ t: "you", id }));
    // The room's radio state, marked as a snapshot: on the client it replaces any
    // cached command unconditionally, newest or not. This is what makes a
    // reconnect resume from the room and not from a stale local copy.
    server.send(JSON.stringify({ t: "radio", command: { ...(await this.radio()), snapshot: true } }));
    server.send(JSON.stringify({ t: "state", players: this.players().filter((p) => p.id !== id) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // The stored command, or the default clock (same anchor every client uses when
  // it has no command). Always a valid command object with its duration table.
  async radio() {
    const stored = normalizeCommand(await this.state.storage.get("radio"), PLAYLIST);
    if (stored) return stored;
    return normalizeCommand(BASE_COMMAND, PLAYLIST) || BASE_COMMAND;
  }

  // only each player's public fields (never the IP)
  public(p) {
    return { id: p.id, name: p.name, gender: p.gender, x: p.x, z: p.z, dir: p.dir, step: p.step };
  }
  players() {
    return this.state.getWebSockets().map((ws) => ws.deserializeAttachment()).filter(Boolean).map((p) => this.public(p));
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }

  // rate limit (token bucket): movement per connection, chat and the rest shared by everyone on one IP
  allowed(p, type) {
    const [cap, refill] = RATES[type] || RATES.other;
    const key = (type === "pos" ? p.id : p.ip) + "|" + type;
    const now = Date.now() / 1000;
    let k = this.buckets.get(key);
    if (!k) this.buckets.set(key, (k = { tokens: cap, at: now }));
    k.tokens = Math.min(cap, k.tokens + (now - k.at) * refill);
    k.at = now;
    if (k.tokens < 1) return false;
    k.tokens -= 1;
    return true;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const p = ws.deserializeAttachment();
    if (!p) return;
    const type = m.t === "pos" ? "pos" : m.t === "chat" ? "chat" : "other";
    if (!this.allowed(p, type)) {
      if (type === "chat") this.strike(ws, p.ip);
      return;
    }

    if (m.t === "hello") {
      p.name = cleanText(m.name, 16) || "trainer";
      p.gender = gender(m.gender);
      ws.serializeAttachment(p);
      this.broadcast({ t: "joined", player: this.public(p) }, ws);
    } else if (m.t === "gender") {
      p.gender = gender(m.gender);
      ws.serializeAttachment(p);
      this.broadcast({ t: "gender", id: p.id, gender: p.gender }, ws);
    } else if (m.t === "name") {
      p.name = cleanText(m.name, 16) || "trainer";
      ws.serializeAttachment(p);
      this.broadcast({ t: "name", id: p.id, name: p.name }, ws);
    } else if (m.t === "pos") {
      p.x = number(m.x);
      p.z = number(m.z);
      p.dir = DIRS.includes(m.dir) ? m.dir : "down";
      p.step = Math.abs(m.step | 0) % 4;
      ws.serializeAttachment(p);
      this.broadcast({ t: "pos", id: p.id, x: p.x, z: p.z, dir: p.dir, step: p.step }, ws);
    } else if (m.t === "radio") {
      // failures counted per IP in storage, so reconnecting doesn't reset them
      const lockKey = "admin-fail:" + p.ip;
      const lock = (await this.state.storage.get(lockKey)) || { fails: 0, until: 0 };
      if (lock.until > Date.now()) return void ws.send(JSON.stringify({ t: "error", msg: "admin locked, try later" }));
      if (!this.env.ADMIN_PASSWORD || typeof m.password !== "string" || !equal(m.password, this.env.ADMIN_PASSWORD)) {
        lock.fails = lock.until ? 1 : lock.fails + 1; // a finished lock starts over
        lock.until = lock.fails >= ADMIN_ATTEMPTS ? Date.now() + ADMIN_LOCK_MS : 0;
        if (lock.until) lock.fails = 0;
        await this.state.storage.put(lockKey, lock);
        ws.send(JSON.stringify({ t: "error", msg: "invalid admin password" }));
        return;
      }
      await this.state.storage.delete(lockKey);
      const prev = await this.radio();
      const command = buildCommand({
        prev,
        idx: Math.max(0, Math.min(999, m.idx | 0)),
        at: Date.now(),
        playlist: PLAYLIST,
      });
      if (!command) return;
      await this.state.storage.put("radio", command);
      this.broadcast({ t: "radio", command });
    } else if (m.t === "durations") {
      // A player learned real track lengths. Never trusted as-is: only ids of the
      // room's playlist, clamped seconds; the first report for an id wins, so a
      // later (or hostile) client cannot retime the room or churn broadcasts.
      // The table is stored with the command so late joiners replay the timeline.
      const report = sanitizeDurations(m.durations, PLAYLIST);
      if (!Object.keys(report).length) return;
      const current = await this.radio();
      const fresh = {};
      for (const [id, value] of Object.entries(report)) {
        if (!(id in (current.durations || {}))) fresh[id] = value;
      }
      if (!Object.keys(fresh).length) return;
      const merged = mergeDurations(current.durations, fresh);
      // same track start (`idx`, `at`); only the revision and the duration table
      // grow, so clients retime without resetting the little TV
      const command = normalizeCommand(
        { ...current, rev: (Number(current.rev) || 0) + 1, durations: merged },
        PLAYLIST,
      );
      if (!command) return;
      await this.state.storage.put("radio", command);
      this.broadcast({ t: "radio", command });
    } else if (m.t === "skip") {
      // A player found a track unplayable (embed off / removed video). Only the
      // room's own ids count, a repeat changes nothing, and an admin action
      // clears the list (it is the undo). Everyone then walks past the same
      // track, so the timeline does not fork per tab.
      const [id] = sanitizeSkipped([m.id], PLAYLIST);
      if (!id) return;
      const current = await this.radio();
      if ((current.skipped || []).includes(id)) return;
      const command = normalizeCommand(
        {
          ...current,
          rev: (Number(current.rev) || 0) + 1,
          skipped: [...(current.skipped || []), id],
        },
        PLAYLIST,
      );
      if (!command) return;
      await this.state.storage.put("radio", command);
      this.broadcast({ t: "radio", command });
    } else if (m.t === "chat") {
      const text = cleanText(m.text, 140);
      if (!text) return;
      const now = Date.now();
      const s = this.spamOf(p.ip, now);
      if (s.mutedUntil > now) return this.tellMuted(ws, s.mutedUntil);
      s.repeats = text === s.lastText && now - s.lastAt < REPEAT_WINDOW_MS ? s.repeats + 1 : 1;
      if (s.repeats > REPEAT_LIMIT) return this.strike(ws, p.ip);
      s.lastText = text;
      s.lastAt = now;
      this.broadcast({ t: "chat", id: p.id, name: p.name, text, at: now });
    }
  }

  spamOf(ip, now) {
    let s = this.spam.get(ip);
    if (!s) this.spam.set(ip, (s = { strikes: 0, mutedUntil: 0, lastStrike: 0, lastText: "", lastAt: 0, repeats: 0 }));
    if (s.strikes && now - s.lastStrike > STRIKE_RESET_MS) s.strikes = 0;
    return s;
  }
  // a spam strike: mute this IP, longer each time
  strike(ws, ip) {
    const now = Date.now();
    const s = this.spamOf(ip, now);
    if (s.mutedUntil > now) return; // already muted; don't stack while muted
    const ms = MUTE_STEPS_MS[Math.min(s.strikes, MUTE_STEPS_MS.length - 1)];
    s.strikes++;
    s.lastStrike = now;
    s.mutedUntil = now + ms;
    if (!ms) {
      try { ws.send(JSON.stringify({ t: "error", msg: "slow down, next time you get muted" })); } catch {}
      return;
    }
    this.tellMuted(ws, s.mutedUntil);
  }
  tellMuted(ws, until) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    const wait = secs >= 60 ? Math.ceil(secs / 60) + " min" : secs + " s";
    try { ws.send(JSON.stringify({ t: "error", msg: `muted for spam, ${wait} left` })); } catch {}
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const p = ws.deserializeAttachment();
    if (!p) return;
    for (const k of this.buckets.keys()) if (k.startsWith(p.id + "|")) this.buckets.delete(k);
    this.broadcast({ t: "left", id: p.id }, ws);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // /ws/<room>  ->  that room's Durable Object. Everything else is the static site (assets).
    const m = url.pathname.match(/^\/ws\/([a-z0-9-]{1,32})$/i);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("lofi-lobby", { status: 404 });
    if (!ROOMS.includes(m[1].toLowerCase())) return new Response("unknown room", { status: 404 });

    // only accept connections from the site itself (or origins listed in ALLOWED_ORIGINS)
    const origin = req.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    allowed.push(url.origin);
    if (!origin || !allowed.includes(origin)) return new Response("origin not allowed", { status: 403 });

    const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toLowerCase()));
    return stub.fetch(req);
  },
};
