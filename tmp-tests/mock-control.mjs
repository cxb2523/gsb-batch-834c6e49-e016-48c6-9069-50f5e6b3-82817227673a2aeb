// Mock of control/server.py's HTTP contract, used to validate the browser
// picker's state machine against the real API shape (same JSON fields/codes).
// Runs standalone with node (no deps). Lives outside the repo's runtime code.
import http from 'node:http';

let state = {
  map: 'de_dust2',
  seq: 0,
  pending: null,
  last_error: null,
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && path === '/api/state') {
    return json(res, 200, state);
  }
  if (req.method === 'GET' && path === '/healthz') {
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/map') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch { return json(res, 400, { error: 'invalid JSON body' }); }
      const target = String(body.map || '').trim().toLowerCase();
      if (!target || !/^[a-z0-9_]+$/.test(target)) {
        return json(res, 400, { error: 'invalid map name' });
      }
      if (state.pending) {
        if (body.idempotency_key && state.pending.key === body.idempotency_key) {
          return json(res, 200, { state });
        }
        return json(res, 409, { error: 'a map switch is already in progress', state });
      }
      // ?fail=1: simulate a changelevel the server never confirms (timeout path).
      const willFail = (req.url || '').includes('fail=1');
      state.seq += 1;
      state.pending = { seq: state.seq, map: target, key: body.idempotency_key, client: body.client };
      state.last_error = null;
      const snap = JSON.parse(JSON.stringify(state));
      setTimeout(() => {
        if (willFail) {
          state.pending = null;
          state.last_error = 'server did not switch to ' + target + ' within 45s';
        } else {
          state.pending = null;
          state.map = target;
        }
      }, 1500);
      return json(res, 202, { state: snap });
    });
    return;
  }
  json(res, 404, { error: 'not found' });
});

server.listen(8099, () => console.log('mock control on http://127.0.0.1:8099'));
