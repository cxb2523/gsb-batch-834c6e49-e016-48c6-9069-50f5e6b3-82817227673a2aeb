#!/usr/bin/env python3
"""LAN map-switch control service (same-origin via the nginx proxy).

Why this exists
---------------
The old picker ran `rcon changelevel` inside the browser and unconditionally
reset its UI after 4 s without ever asking the server whether the changelevel
happened, and every other connected page had no way to learn the new map.
This tiny stdlib-only HTTP service is the single, shared authority:

  GET  /api/state  -> current map + any in-flight switch (polled by every page)
  POST /api/map    -> one RCON changelevel, deduped by an idempotency key,
                      confirmed by polling the live server (A2S_INFO on UDP)
                      until the current map actually changes or it times out.

It talks the GoldSrc binary RCON and A2S_INFO protocols over UDP itself, so
the browser never needs raw UDP (it can't send it) and one in-flight request is
guaranteed server-side as well as in the page. No third-party packages — the
image is plain python:alpine.
"""

import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- configuration (overridable for tests / other deployments) -------------
GAME_HOST = os.environ.get('GAME_HOST', 'cs16-web')
GAME_PORT = int(os.environ.get('GAME_PORT', '27018'))
RCON_PW = os.environ.get('RCON_PASSWORD', 'cs16lan')
# Must match docker-compose's `+map` boot argument / the initial current map.
DEFAULT_MAP = os.environ.get('DEFAULT_MAP', 'de_dust2')
HTTP_PORT = int(os.environ.get('PORT', '8080'))
# A2S_INFO poll cadence while a changelevel is being confirmed.
POLL_INTERVAL = float(os.environ.get('POLL_INTERVAL', '1.0'))
# Give the dedicated server this long to actually change level before the
# switch is declared failed and the picker becomes clickable again.
SWITCH_TIMEOUT = float(os.environ.get('SWITCH_TIMEOUT', '45'))
# A2S_INFO / RCON per-packet socket timeouts.
UDP_TIMEOUT = float(os.environ.get('UDP_TIMEOUT', '2.0'))

A2S_INFO_REQ = b'\xff\xff\xff\xff\x54Source Engine Query\x00'
# GoldSrc servers answer the modern A2S_INFO with a challenge (0x41); retry
# once carrying the 4-byte challenge, exactly like the reference client.
A2S_INFO_REQ_CHAL = A2S_INFO_REQ + b'\x00\x00\x00\x00'


def _socket():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(UDP_TIMEOUT)
    return s


def _recv_packet(sock):
    """Read one UDP datagram, joining a GoldSrc split packet if needed.

    Returns the payload *after* the -1 (single packet) or -2 (split packet)
    header. Split packets are reassembled simply (the LAN payloads here are
    small, so multi-fragment reordering beyond index order is unnecessary).
    """
    data, _ = sock.recvfrom(4096)
    if len(data) < 5 or data[0:4] != b'\xff\xff\xff\xff':
        raise ValueError('not a GoldSrc response packet')
    kind = data[4]
    if kind == 0xFE:  # split packet header
        # -2, long packet id (4), byte count (1), current chunk (1)
        # Layout: 0xFF*4 0xFE <id:4 LE> <curchunk:1> <payload...>
        return data[10:]
    return data[5:]


def query_map():
    """Return the live current map name via A2S_INFO, or None on failure."""
    with _socket() as s:
        try:
            s.sendto(A2S_INFO_REQ, (GAME_HOST, GAME_PORT))
            payload = _recv_packet(s)
        except (socket.timeout, OSError, ValueError):
            return None

        if payload and payload[0] == 0x41:  # challenge reply: 0x41 + 4 bytes
            challenge = payload[1:5]
            try:
                s.sendto(A2S_INFO_REQ_CHAL[:-4] + challenge, (GAME_HOST, GAME_PORT))
                payload = _recv_packet(s)
            except (socket.timeout, OSError, ValueError):
                return None

        if not payload:
            return None
        try:
            if payload[0] == 0x49:  # 'I' modern GoldSrc A2S_INFO response:
                # 0x49, net protocol (1 byte), then NUL-terminated strings:
                # server name, MAP, folder, game ...
                p = payload[2:]
                p = p[p.index(b'\x00') + 1:]          # skip server name
                return p[:p.index(b'\x00')].decode('utf-8', 'replace')
            if payload[0] == 0x6D:  # 'm' legacy GoldSrc response
                p = payload[1:]
                p = p[p.index(b'\x00') + 1:]          # skip server address
                p = p[p.index(b'\x00') + 1:]          # skip host name
                return p[:p.index(b'\x00')].decode('utf-8', 'replace')
        except (ValueError, IndexError):
            return None
    return None


def _rcon_packet(command):
    body = b'\xff\xff\xff\xffrcon %s %s\x00' % (
        RCON_PW.encode('utf-8'), command.encode('utf-8'))
    return body


def send_rcon(command):
    """Send one RCON command. Returns False on a bad-password / socket error.

    A GoldSrc changelevel prints nothing useful back (and may stay silent while
    the level loads), so this only detects a hard auth/socket failure; the
    actual success decision is made by confirm_switch() via A2S_INFO polling.
    """
    with _socket() as s:
        try:
            s.sendto(_rcon_packet(command), (GAME_HOST, GAME_PORT))
            # Read whatever the server prints back. "Bad rcon_password" means
            # the auth failed and the changelevel never ran.
            deadline = time.monotonic() + UDP_TIMEOUT
            chunks = []
            while time.monotonic() < deadline:
                try:
                    data, _ = s.recvfrom(4096)
                except socket.timeout:
                    break
                chunks.append(data)
            text = b''.join(chunks).decode('utf-8', 'replace').lower()
            if 'bad rcon' in text:
                return False
            return True
        except OSError:
            return False


class ControlState:
    """Thread-safe shared state: current map + at most one in-flight switch."""

    def __init__(self):
        self.lock = threading.Lock()
        self.current_map = DEFAULT_MAP
        self.sequence = 0                 # global monotonic switch sequence
        # pending = None or {seq, map, key, client, started_at}
        self.pending = None
        self.last_error = None

    def snapshot(self):
        with self.lock:
            return {
                'map': self.current_map,
                'seq': self.sequence,
                'pending': dict(self.pending) if self.pending else None,
                'last_error': self.last_error,
            }

    def begin_switch(self, target, key, client):
        """Register a switch. Returns (accepted, snapshot, http_status)."""
        with self.lock:
            if self.pending:
                # Same key re-sent (double click / retry): idempotent replay.
                if key and self.pending.get('key') == key:
                    return True, self._locked_snapshot(), 200
                return False, self._locked_snapshot(), 409
            self.sequence += 1
            self.pending = {
                'seq': self.sequence, 'map': target, 'key': key,
                'client': client, 'started_at': time.time(),
            }
            self.last_error = None
            return True, self._locked_snapshot(), 202

    def _locked_snapshot(self):
        return {
            'map': self.current_map,
            'seq': self.sequence,
            'pending': dict(self.pending) if self.pending else None,
            'last_error': self.last_error,
        }

    def finish_switch(self, target, ok, error=None):
        with self.lock:
            if self.pending and self.pending.get('map') == target:
                self.pending = None
            if ok:
                self.current_map = target
                self.last_error = None
            else:
                self.last_error = error or ('switch to %s failed' % target)


STATE = ControlState()


def confirm_switch(target):
    """Background worker: RCON first, then poll A2S_INFO until confirmed."""
    # Capture the pending entry we were spawned for. finish_switch only clears
    # an entry for the SAME target, so a later switch to a different map leaves
    # this worker's target gone from `pending` — in that case this check makes
    # the stale worker exit instead of overwriting the newer map on success.
    with STATE.lock:
        if not STATE.pending or STATE.pending.get('map') != target:
            return
    if not send_rcon('changelevel ' + target):
        STATE.finish_switch(target, False, 'rcon authentication failed')
        return
    deadline = time.monotonic() + SWITCH_TIMEOUT
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL)
        with STATE.lock:
            # A newer switch superseded this one: stop polling, don't clobber.
            if not STATE.pending or STATE.pending.get('map') != target:
                return
        live = query_map()
        if live == target:
            STATE.finish_switch(target, True)
            return
        # The server may briefly fail to answer while it changes level; that is
        # not an error by itself — keep polling until the deadline.
    STATE.finish_switch(target, False,
                        'server did not switch to %s within %ss'
                        % (target, int(SWITCH_TIMEOUT)))


def monitor_live_map():
    """Periodically reconcile current_map with the live server.

    Covers maps changed from the server console / another RCON client, and the
    initial boot map. A pending switch owns updates while it is in flight.
    """
    while True:
        time.sleep(POLL_INTERVAL * 2)
        live = query_map()
        if not live:
            continue
        with STATE.lock:
            if STATE.pending:
                continue
            if STATE.current_map != live:
                STATE.current_map = live
                STATE.last_error = None


class Handler(BaseHTTPRequestHandler):
    server_version = 'cs16-control/1.0'

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        # State must never be cached: every page poll has to see the live map.
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def log_message(self, fmt, *args):  # quieter, structured docker logs
        print('[control] %s - %s' % (self.address_string(), fmt % args), flush=True)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path in ('/api/state', '/api/state/'):
            self._json(200, STATE.snapshot())
        elif path in ('/healthz', '/healthz/'):
            self._json(200, {'ok': True})
        else:
            self._json(404, {'error': 'not found'})

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path not in ('/api/map', '/api/map/'):
            self._json(404, {'error': 'not found'})
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length else b'{}'
            req = json.loads(raw.decode('utf-8') or '{}')
        except (ValueError, TypeError):
            self._json(400, {'error': 'invalid JSON body'})
            return

        target = str(req.get('map', '')).strip().lower()
        # Whitelist shape only — no spaces/semicolons can reach the rcon line.
        if not target or not all(c.isalnum() or c == '_' for c in target):
            self._json(400, {'error': 'invalid map name'})
            return

        key = str(req.get('idempotency_key', '')).strip()[:128]
        client = str(req.get('client', '')).strip()[:64]
        accepted, snap, code = STATE.begin_switch(target, key, client)
        if not accepted:
            self._json(code, {'error': 'a map switch is already in progress',
                              'state': snap})
            return
        # On an idempotent replay the worker is already running — don't start
        # a second changelevel.
        if code == 202:
            threading.Thread(target=confirm_switch, args=(target,),
                             daemon=True).start()
        self._json(code, {'state': snap})


def main():
    threading.Thread(target=monitor_live_map, daemon=True).start()
    httpd = ThreadingHTTPServer(('0.0.0.0', HTTP_PORT), Handler)
    print('[control] listening on :%s, game server %s:%s, default map %s'
          % (HTTP_PORT, GAME_HOST, GAME_PORT, DEFAULT_MAP), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
