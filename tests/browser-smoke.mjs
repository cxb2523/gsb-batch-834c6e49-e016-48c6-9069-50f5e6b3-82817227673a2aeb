/**
 * Browser smoke + acceptance driver for the performance-adaptive light budget.
 *
 * No third-party deps: drives a system Chrome over the DevTools Protocol with
 * Node's built-in fetch + WebSocket. Boots the real game through Vite, then
 * exercises the three acceptance scenarios inside the live page:
 *
 *   1. forced heavy-frame stream downshifts and recovery walks the ladder back up
 *   2. disable restores cap / AO tier / ambient with no residual adaptation state
 *   3. a lit material added on the shift frame is registered to the CSM cascades
 *
 * Also asserts the boot itself is error-free and the F3 data sources are populated.
 *
 * Usage: node tests/browser-smoke.mjs [chromePath]
 * Expects the Vite dev server on http://127.0.0.1:5188 (npm run dev).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
// Node >=22 ships a global WHATWG WebSocket (stable); no third-party dep needed.

const URL = 'http://127.0.0.1:5188/';
// High, env-overridable port so a stale Chrome from another run can't collide.
const PORT = Number(process.env.EXILIUM_CDP_PORT || 9473);
const CHROME = process.argv[2]
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// Chrome 157 refuses --remote-debugging-port whenever the user-data-dir lives under a
// redirected/non-standard profile tree (the sandbox redirects LOCALAPPDATA/USERPROFILE,
// which trips its "non-default data directory" guard). A directory under the real
// C:\Users\Public passes the guard. Overridable with EXILIUM_CDP_PROFILE.
const PROF = process.env.EXILIUM_CDP_PROFILE
  || 'C:\\Users\\Public\\exilium-perfadapt-smoke';

if (existsSync(PROF)) rmSync(PROF, { recursive: true, force: true });
mkdirSync(PROF, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROF}`,
  '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});

let exited = false;
chrome.on('exit', (code) => { exited = true; });

async function waitForCDP(retries = 40) {
  for (let i = 0; i < retries; i++) {
    if (exited) throw new Error('Chrome exited before CDP came up');
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        const j = await r.json();           // non-JSON means another browser owns the port
        if (j.webSocketDebuggerUrl) return j;
      }
    } catch { /* not up yet, or a stale holder returning text */ }
    await sleep(250);
  }
  throw new Error('Chrome CDP did not come up');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  async function send(method, params = {}) {
    await ready;
    const myId = ++id;
    const p = new Promise((resolve, reject) => pending.set(myId, { resolve, reject }));
    ws.send(JSON.stringify({ id: myId, method, params }));
    return p;
  }
  return { send, close: () => ws.close() };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail: detail || (cond ? '' : 'FAILED') });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

try {
  await waitForCDP();
  // New page target on the game URL, then attach to it. Chrome 157 only accepts PUT
  // on /json/new (GET returns a plain-text "unsafe verb" page, not JSON).
  const tRes = await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`,
    { method: 'PUT' });
  if (!tRes.ok) throw new Error(`/json/new failed: ${tRes.status} ${(await tRes.text()).slice(0, 120)}`);
  const target = await tRes.json();
  const conn = cdp(target.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');

  await conn.send('Runtime.evaluate', {
    expression: 'window.__errs=[];addEventListener("error",e=>window.__errs.push(String(e.message)))',
  });

  // Wait for the game's own readiness signal.
  let boot = null;
  for (let i = 0; i < 120; i++) {
    const r = await conn.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ready:!!window.__EXILIUM_READY,err:window.__EXILIUM_ERROR||null,errs:window.__errs||[]})',
      returnByValue: true,
    });
    boot = JSON.parse(r.result.value);
    if (boot.ready || boot.err) break;
    await sleep(500);
  }
  check('game boots without runtime errors', !!boot?.ready && !(boot?.err)
    && (!boot?.errs || boot.errs.length === 0), JSON.stringify(boot).slice(0, 200));

  const evalJs = async (expr) => {
    const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // Let a few real frames render so the systems populate.
  await sleep(1500);

  const base = await evalJs(`(() => {
    const pa = World.perfAdapt.stats, lc = World.lightCull.stats;
    return JSON.stringify({
      paOn: pa.enabled, paLevel: pa.level, paRung: pa.rung,
      lcRung: lc.rung, lcShown: lc.shown, lcCap: lc.capRung,
      ao: World.pipeline.perfSamples, amb: World.getAmbientIntensityMult(),
      sweeps: World.getCSMSweepCount(),
    });
  })()`);
  const b = JSON.parse(base);
  check('perfAdapt exposed on World and enabled by default', b.paOn === true, JSON.stringify(b));
  check('initial state is the top rung with no cap', b.lcCap === null,
    `rung ${b.lcRung}, shown ${b.lcShown}, cap ${b.lcCap}`);
  check('AO tier and ambient are readable through the coupled interfaces',
    typeof b.ao === 'number' && b.ao > 0 && typeof b.amb === 'number');

  // ---- scenario 1: synthetic heavy frames force a downshift -------------------
  // Suspend the live rAF policy (it would otherwise interleave its own frame() with
  // the synthetic stream), then drive the SAME coupled applyLevel() path directly.
  // The gates are shrunk via the debug configure() hook so the sequence is fast and
  // deterministic; production defaults are restored at the end.
  const down = await evalJs(`(() => {
    const a = World.perfAdapt;
    a.setEnabled(false);                       // live frame() becomes a no-op
    a.setEnabled(true);                        // fresh state, behind warmup
    a.configure({ warmupFrames: 2, downFrames: 3, upFrames: 3, cooldownFrames: 2 });
    const before = a.stats.level;
    for (let i = 0; i < 2; i++) a.feedFrameTime(0.012);   // warmup
    for (let i = 0; i < 3; i++) a.feedFrameTime(0.045);   // heavy -> one downshift
    const s = a.stats, lc = World.lightCull.stats;
    // Read the cap from the live GETTER (authoritative immediately), not stats,
    // which only refreshes on the next cull frame.
    const capNow = World.lightCull.capRung;
    return JSON.stringify({ before, level: s.level, rung: s.rung, ao: s.aoSamples,
      amb: s.ambientMult, lcCap: capNow, lcDropAdapt: lc.droppedByAdapt,
      shiftsDown: s.shiftsDown, rescans: s.rescans });
  })()`);
  const d = JSON.parse(down);
  check('heavy frames downshift exactly one rung', d.before - d.level === 1,
    `level ${d.before} -> ${d.level}, rung ${d.rung}`);
  // The CAP equals the adapted rung even though live demand may render on a lower
  // rung (the cap is a ceiling, not a forced count).
  check('lightcull cap follows the shift onto a prewarmed rung', d.lcCap === d.rung && d.rung > 0,
    `cap ${d.lcCap} on rung ${d.rung}`);
  check('all four chains coupled on downshift (AO + ambient + rescan)',
    typeof d.ao === 'number' && typeof d.amb === 'number' && d.rescans >= 1,
    `ao${d.ao} amb${d.amb} rescans${d.rescans}`);

  // A real cull frame under the cap must stay exactly on-rung (no recompile risk).
  await sleep(200);
  const onRung = await evalJs(`(() => {
    const lc = World.lightCull.stats;
    return JSON.stringify({ rung: lc.rung, shown: lc.shown, offRung: lc.offRung,
      cap: lc.capRung, capped: lc.capped });
  })()`);
  const o = JSON.parse(onRung);
  // The live controller stays disabled, so the cap set by the synthetic shift holds;
  // the culler still lands exactly on a rung and never above its ceiling.
  check('culled frame lands exactly on-rung and never above its cap',
    o.shown === o.rung && o.offRung === 0 && o.capped === true && o.rung <= o.cap,
    JSON.stringify(o));

  // Recovery: calm frames climb back, one rung per (cooldown + upFrames) gate.
  const up = await evalJs(`(() => {
    const a = World.perfAdapt;
    const low = a.stats.level;
    for (let k = 0; k < low + 1; k++) {
      for (let i = 0; i < 2 + 3; i++) a.feedFrameTime(0.012);   // cooldown + upFrames
    }
    return JSON.stringify({ low, level: a.stats.level, rung: a.stats.rung,
      ao: a.stats.aoSamples, amb: a.stats.ambientMult, shiftsUp: a.stats.shiftsUp });
  })()`);
  const u = JSON.parse(up);
  check('recovery walks all the way back to the initial rung', u.level === 5 && u.rung === 34,
    `from L${u.low} to L${u.level} rung ${u.rung}`);
  check('AO and ambient restored with the ceiling', u.ao === b.ao && Math.abs(u.amb - b.amb) < 1e-9,
    `ao ${u.ao}/${b.ao}, amb ${u.amb}/${b.amb}`);

  // ---- scenario 2: disable restores everything, no residual state -------------
  const dis = await evalJs(`(() => {
    const a = World.perfAdapt;
    a.forceLevel(1);                          // push it off the initial rung
    const lcMid = World.lightCull.capRung;    // live getter: the cap really is set
    a.setEnabled(false);
    const pa = a.stats;
    const capGetter = World.lightCull.capRung;     // authoritative, not stale stats
    const lc = World.lightCull.stats;
    return JSON.stringify({ lcMid,
      enabled: pa.enabled, level: pa.level, rung: pa.rung,
      cap: capGetter, capNull: capGetter === null,
      statsCap: lc.capRung, statsCapped: lc.capped,
      ao: World.pipeline.perfSamples, amb: World.getAmbientIntensityMult(),
      over: pa.overStreak, under: pa.underStreak, sd: pa.shiftsDown, su: pa.shiftsUp,
      age: pa.frameAge });
  })()`);
  const x = JSON.parse(dis);
  check('forceLevel set a real cap before disable', x.lcMid !== null && x.lcMid > 0,
    `mid cap ${x.lcMid}`);
  check('disable restores the initial rung and clears the cap',
    x.enabled === false && x.level === 5 && x.rung === 34 && x.cap === null && x.capNull === true,
    JSON.stringify(x));
  check('disable restores initial AO tier and ambient multiplier',
    x.ao === b.ao && Math.abs(x.amb - b.amb) < 1e-9, `ao ${x.ao}/${b.ao} amb ${x.amb}/${b.amb}`);
  check('no temporary adaptation state survives disable',
    x.over === 0 && x.under === 0 && x.sd === 0 && x.su === 0 && x.age === 0);

  // ---- scenario 3: material born on a shift frame gets CSM cascades -----------
  const mat = await evalJs(`(() => {
    const a = World.perfAdapt;
    a.setEnabled(false);                       // keep the live rAF policy suspended
    a.setEnabled(true);
    a.configure({ warmupFrames: 2, downFrames: 3, upFrames: 3, cooldownFrames: 2 });
    for (let i = 0; i < 2; i++) a.feedFrameTime(0.012);
    for (let i = 0; i < 3; i++) a.feedFrameTime(0.045);
    const shiftedTo = a.stats.level;
    // Add a brand-new lit mesh in the same moment, then force the rescan the shift
    // contract guarantees. forceLevel re-runs the exact applyLevel() coupling.
    const geo = new THREE.TorusGeometry(1, 0.3, 8, 24);
    const m = new THREE.MeshStandardMaterial({ color: 0x887766, roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.copy(World.player.pos).add(new THREE.Vector3(2, 1, 0));
    World.scene.add(mesh);
    const sweepsBefore = World.getCSMSweepCount();
    a.forceLevel(Math.max(0, shiftedTo - 1));
    const sweepsAfter = World.getCSMSweepCount();
    // CSM setupMaterial injects USE_CSM/CSM_CASCADES defines — the durable proof the
    // new material is bound to the cascades. (needsUpdate is a one-shot that the next
    // render consumes, so the define, not the flag, is the authoritative marker.)
    const hasCsmDefines = !!(m.defines && Object.keys(m.defines).some(k => k.startsWith('USE_CSM')));
    World.scene.remove(mesh); geo.dispose(); m.dispose();
    return JSON.stringify({ shiftedTo, sweepsBefore, sweepsAfter, hasCsmDefines });
  })()`);
  const mm = JSON.parse(mat);
  check('shift-instant rescan ran inside the coupled shift', mm.sweepsAfter > mm.sweepsBefore,
    `sweeps ${mm.sweepsBefore} -> ${mm.sweepsAfter}`);
  check('newly added lit material registered onto CSM cascades',
    mm.hasCsmDefines, JSON.stringify(mm));

  // Re-enable the live controller with production gates restored, and confirm it
  // returns to the initial ceiling — the page is left exactly as production would.
  const reen = await evalJs(`(() => {
    World.perfAdapt.resetConfig();
    World.perfAdapt.setEnabled(false);        // clears cap/state, restores initial lighting
    World.perfAdapt.setEnabled(true);         // live policy back on, fresh warmup
    const pa = World.perfAdapt.stats;
    const capGetter = World.lightCull.capRung;
    return JSON.stringify({ enabled: pa.enabled, level: pa.level, rung: pa.rung,
      cap: capGetter, capNull: capGetter === null,
      ao: World.pipeline.perfSamples, amb: World.getAmbientIntensityMult() });
  })()`);
  const rn = JSON.parse(reen);
  check('live controller re-enabled at the initial rung with no cap',
    rn.enabled && rn.level === 5 && rn.rung === 34 && rn.capNull === true
      && rn.ao === b.ao && Math.abs(rn.amb - b.amb) < 1e-9, JSON.stringify(rn));

  // Final console error sweep.
  const tail = await evalJs('JSON.stringify(window.__errs||[])');
  check('no uncaught page errors during the whole run', JSON.parse(tail).length === 0, tail.slice(0, 200));

  conn.close();
} catch (e) {
  check('browser smoke harness ran', false, String(e && e.stack || e).slice(0, 300));
} finally {
  // Kill the root we spawned; Chrome tears its own child tree down with it. Never a
  // name-based kill — only the process handle this harness created.
  chrome.kill();
  await sleep(800);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
// The profile can briefly stay locked while the tree exits; tolerate a cleanup miss
// rather than masking the real test result with a throwaway EPERM.
try { rmSync(PROF, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
catch (e) { console.warn(`(profile cleanup skipped: ${e.code})`); }
process.exit(failed.length ? 1 : 0);
