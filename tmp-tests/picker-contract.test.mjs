// Exercises the same API contract + the picker's exact decision logic (mirrored
// from web/index.html) against the mock control service: unique sequence,
// idempotent replay, 409 handling, confirmed-state reconciliation.
const BASE = 'http://127.0.0.1:8099';

// Mirror of the picker's request + applyState decision rules.
let seq = 0;
const clientId = 'p-test123';
let switching = false;
let localSwitch = false;
let selectedMap = 'de_dust2';
let pendingMap = null;
let lastError = null;

function applyState(s) {
  const pending = s.pending || null;
  if (pending) {
    pendingMap = pending.map;
    lastError = null;
    if (!switching) switching = true;
    return;
  }
  if (switching) {
    switching = false;
    pendingMap = null;
    localSwitch = false;
    if (s.map) selectedMap = s.map;
    lastError = s.last_error || null;
    return;
  }
  if (s.map && !localSwitch) selectedMap = s.map;
  lastError = s.last_error || null;
}

async function getState() {
  const r = await fetch(BASE + '/api/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function switchMap(name) {
  if (switching) throw new Error('double-fire: switch already in flight');
  lastError = null;
  selectedMap = name;
  pendingMap = name;
  switching = true;
  localSwitch = true;
  seq += 1;
  const key = clientId + '-' + seq;
  const r = await fetch(BASE + '/api/map', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ map: name, idempotency_key: key, client: clientId, seq }),
    cache: 'no-store',
  });
  const data = await r.json();
  return { status: r.status, data, key };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

// 1. Fresh page reads the current (boot) map from the API, not a fixed value.
let s = await getState();
applyState(s);
check('initial map read from state', selectedMap === 'de_dust2' && switching === false);

// 2. First switch returns 202 and locks the UI.
const first = await switchMap('cs_italy');
check('first switch accepted (202)', first.status === 202);
check('UI locked while pending', switching === true && localSwitch === true);
check('pending target surfaced', pendingMap === 'cs_italy');

// 3. A duplicate click while pending is rejected by the guard; an identical
//    idempotent replay returns 200 (same request), never a new changelevel.
let guardBlocked = false;
try { await switchMap('cs_office'); } catch (e) { guardBlocked = true; }
check('local guard blocks second switch', guardBlocked);
const replay = await fetch(BASE + '/api/map', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ map: 'cs_italy', idempotency_key: first.key, client: clientId, seq }),
});
check('idempotent replay returns 200', replay.status === 200);

// 4. A different client starting another switch gets 409.
const conflict = await fetch(BASE + '/api/map', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ map: 'de_nuke', idempotency_key: 'p-other-1', client: 'p-other', seq: 1 }),
});
check('concurrent different switch -> 409', conflict.status === 409);

// 5. Polling sees pending, then confirmation clears it and reconciles the map.
s = await getState();
applyState(s);
check('poll sees pending switch', switching === true && pendingMap === 'cs_italy');
await sleep(1800);
s = await getState();
applyState(s);
check('confirmed: unlocked, map updated, no error',
  switching === false && selectedMap === 'cs_italy' && lastError === null);

// 6. A fresh "page" (reset local vars) joining after the switch reads the
//    current map instead of the old fixed highlight.
switching = false; localSwitch = false; selectedMap = 'de_dust2';
s = await getState();
applyState(s);
check('new joiner reads live current map', selectedMap === 'cs_italy');

// 7. Second distinct switch gets a fresh sequence number.
const second = await switchMap('de_dust2');
check('second switch has incremented sequence', second.data.state.pending.seq === 2);
await sleep(1800);
s = await getState();
applyState(s);
check('second switch confirmed', selectedMap === 'de_dust2' && switching === false);

// 8. Failed switch: pending clears WITH an error -> UI re-enables and shows it.
const failRes = await fetch(BASE + '/api/map?fail=1', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ map: 'cs_militia', idempotency_key: clientId + '-fail', client: clientId, seq: 3 }),
});
check('failed switch accepted then resolves', failRes.status === 202);
applyState(await getState());
check('locked while failed switch pending', switching === true);
await sleep(1800);
applyState(await getState());
check('failure unlocks the picker', switching === false);
check('failure message surfaced to the player', typeof lastError === 'string' && lastError.length > 0);
check('map stays at the last confirmed value', selectedMap === 'de_dust2');

// 9. After a failure, a new switch is allowed again (buttons clickable).
const retry = await switchMap('cs_office');
check('retry after failure is accepted', retry.status === 202);
await sleep(1800);
applyState(await getState());
check('retry confirms and clears the error', selectedMap === 'cs_office' && lastError === null);

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures ? 1 : 0);
