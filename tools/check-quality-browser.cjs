// Browser check for the shared graphics-quality state, driven over the Chrome DevTools Protocol (no extra deps).
//
//   node tools/check-quality-browser.cjs [http://127.0.0.1:8765/index.html] [chrome-path]
//
// Start the game first (python3 server.py 8765), then run this. It loads the real game headlessly with __sbDebug
// on, starts a real sortie, and through the __sb debug handle checks:
//   - a measured drop changes what new explosions emit (no smoke, fewer debris) and leaves existing particles alone
//     to decay, while choosing High again restores the full explosion;
//   - quality switching neither rebuilds/drops InstancedMeshes nor leaks GPU geometries/textures, and pool capacity
//     always equals the instance count;
//   - the pause screen prints the level in force (Auto (Low)) rather than the saved setting, and is not sampled;
//   - restart, the hangar and the AI Ladder empty every pool and reset the missile-trail timers.
//
// You can also check by hand: start the server, open the game with the debug handle on (in the browser console run
// `window.__sbDebug = true` and reload, or use a console snippet before the game loads), then in the console use
// __sb.effects.stats() for the pools and __sb.Quality for the level.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const chromePath = process.argv[3] || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

let failures = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}${!cond && extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome refuses --user-data-dir under a redirected profile folder; a short local temp path always works.
const profileBase = process.platform === 'win32' ? 'C:\\temp' : '/tmp';
fs.mkdirSync(profileBase, { recursive: true });
const profile = fs.mkdtempSync(path.join(profileBase, 'sb-chrome-'));
const PORT = 9377;
const chrome = spawn(chromePath, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile.replace(/\\/g, '/')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
  '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });
const cleanupProfile = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };

async function devtools(pathname) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`); if (r.ok) return await r.json(); } catch {}
    await sleep(100);
  }
  throw new Error('devtools not reachable');
}

(async () => {
  const page = (await devtools('/json/list')).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) events.push(m);
  };
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception ? res.exceptionDetails.exception.description : JSON.stringify(res.exceptionDetails));
    return res.result ? res.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // a save that skips the tutorial, and the debug handle, set before any game code runs
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('skybreak_save', JSON.stringify({ version: 1, tutorialDone: true, runs: 1, quality: 'auto' })); } catch (e) {}
             window.__sbDebug = true;`,
  });

  await send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    await sleep(100);
    try { ready = await evaluate('!!(window.__sb && window.__sb.effects)'); } catch {}
    if (ready) break;
  }
  const banner = await evaluate(`(document.getElementById('sysBanner')||{}).textContent || ''`).catch(() => '');
  ok(ready, 'the real game boots in the browser and exposes __sb', banner);
  if (!ready) throw new Error('game did not boot: ' + banner);
  ok(!banner, 'no runtime error banner after boot', banner);

  // a real sortie, so effects / quality go through the normal flight path
  await evaluate('__sb.hangar.trySortie()');
  await sleep(700);
  ok((await evaluate('__sb.mode')) === 'flight', 'a real sortie starts', await evaluate('__sb.mode'));

  /* ---------- pools are allocated once, capacity === instances ---------- */
  const s0 = await evaluate('__sb.effects.stats()');
  ok(s0.fire.instances === s0.fire.cap && s0.debris.instances === s0.debris.cap && s0.smoke.instances === s0.smoke.cap,
    'pool capacity equals the allocated instance count in the running game', JSON.stringify(s0));
  ok(s0.level === 'high', 'Auto starts on High', s0.level);

  /* ---------- a measured drop changes what new explosions emit ---------- */
  const drop = await evaluate(`(() => {
    const fx = __sb.effects, Q = __sb.Quality, S = __sb.save;
    const p = __sb.plane.pos.clone();
    S.data.quality = 'auto'; S.data.qualityAuto = null; Q.emit();
    fx.clear(); fx.boom(p, 2);
    const hi = { debris: fx.debris.list.length, smoke: fx.smoke.list.length };
    // what Auto does after it measures a slow flight (quality.js: Save.data.qualityAuto = 'low'; emit())
    S.data.qualityAuto = 'low'; Q.emit();
    fx.boom(p, 2);
    const live = { debris: fx.debris.list.length, smoke: fx.smoke.list.length };
    const smokeBefore = fx.smoke.list.length;
    fx.update(0.05, null);                     // one step after the switch: nothing is deleted outright
    const kept = fx.smoke.list.length === smokeBefore;
    fx.clear(); fx.boom(p, 2);                 // now, on Low only
    const lowOnly = { debris: fx.debris.list.length, smoke: fx.smoke.list.length };
    return { hi, live, kept, lowOnly, level: Q.level, label: Q.label() };
  })()`);
  ok(drop.level === 'low', 'Auto drops to Low while flying', JSON.stringify(drop));
  ok(drop.hi.smoke > 0, 'the High explosion emitted smoke', JSON.stringify(drop.hi));
  ok(drop.live.smoke === drop.hi.smoke, 'the post-drop explosion added no smoke', JSON.stringify(drop.live));
  ok(drop.kept, 'a drop does not delete smoke already in the air');
  ok(drop.lowOnly.smoke === 0 && drop.lowOnly.debris < drop.hi.debris,
    'Low explosions carry no smoke and fewer debris', JSON.stringify(drop.lowOnly));

  const decay = await evaluate(`(() => {
    const fx = __sb.effects, S = __sb.save, Q = __sb.Quality;
    S.data.quality = 'auto'; S.data.qualityAuto = null; Q.emit();
    fx.clear(); fx.boom(__sb.plane.pos.clone(), 2);
    const n = fx.smoke.list.length;
    S.data.qualityAuto = 'low'; Q.emit();
    for (let i = 0; i < 200; i++) fx.update(0.05, null);
    return { n, left: fx.smoke.list.length, drawn: fx.smoke.mesh.count };
  })()`);
  ok(decay.n > 0 && decay.left === 0 && decay.drawn === 0, 'existing smoke decays away after the drop', JSON.stringify(decay));

  /* ---------- the pause screen shows the level in force ---------- */
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(250);
  const pause = await evaluate(`({ text: document.getElementById('pausePerf').textContent,
                                  shown: document.getElementById('pauseBox').style.display,
                                  level: __sb.Quality.level, setting: __sb.Quality.setting() })`);
  ok(pause.shown === 'flex' && /Graphics: Auto \(Low\)/.test(pause.text),
    'the pause screen prints the level in force (Auto (Low)), not the saved setting', JSON.stringify(pause));
  const held1 = pause.text;
  await sleep(500);
  ok((await evaluate(`document.getElementById('pausePerf').textContent`)) === held1,
    'nothing is sampled while the pause menu is open');
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);   // test flight: resumes at once
  await sleep(400);

  /* ---------- High again: the next explosion is complete ---------- */
  const back = await evaluate(`(() => {
    const fx = __sb.effects, S = __sb.save, Q = __sb.Quality;
    S.data.quality = 'high'; S.data.qualityAuto = null; Q.emit();
    fx.clear(); fx.boom(__sb.plane.pos.clone(), 2);
    return { level: Q.level, smoke: fx.smoke.list.length, debris: fx.debris.list.length };
  })()`);
  ok(back.level === 'high' && back.smoke > 0, 'choosing High again gives new explosions their smoke back', JSON.stringify(back));

  /* ---------- no rebuild / no leak across 40 switches ---------- */
  const leak = await evaluate(`(() => {
    const fx = __sb.effects, S = __sb.save, info = __sb.glInfo;
    const meshes = () => fx.scene.children.filter(o => o.isInstancedMesh).length;
    const before = { meshes: meshes(), geo: info.memory.geometries, tex: info.memory.textures };
    for (let i = 0; i < 40; i++) {
      S.data.quality = i % 2 ? 'low' : 'high'; S.data.qualityAuto = null; __sb.Quality.emit();
      fx.boom(__sb.plane.pos.clone(), 1.5);
      fx.update(0.016, __sb.weapons);
    }
    return { before, after: { meshes: meshes(), geo: info.memory.geometries, tex: info.memory.textures }, stats: fx.stats() };
  })()`);
  ok(leak.before.meshes === leak.after.meshes, 'quality switching does not rebuild or drop InstancedMeshes',
    JSON.stringify({ before: leak.before.meshes, after: leak.after.meshes }));
  ok(leak.after.geo === leak.before.geo && leak.after.tex === leak.before.tex,
    'quality switching leaks no GPU geometries/textures', JSON.stringify({ before: leak.before, after: leak.after }));
  const st = leak.stats;
  ok(st.fire.instances === st.fire.cap && st.debris.instances === st.debris.cap && st.smoke.instances === st.smoke.cap,
    'capacity still equals instance count after 40 switches', JSON.stringify(st));
  ok(st.fire.drawn === st.fire.live && st.debris.drawn === st.debris.live && st.smoke.drawn === st.smoke.live,
    'drawn counts match live particles after 40 switches', JSON.stringify(st));

  /* ---------- restart / hangar / AI Ladder ---------- */
  const reset = await evaluate(`(() => {
    const fx = __sb.effects, S = __sb.save, Q = __sb.Quality;
    S.data.quality = 'high'; S.data.qualityAuto = null; Q.emit();
    fx.boom(__sb.plane.pos.clone(), 2);
    const filled = fx.stats().fire.live + fx.stats().debris.live + fx.stats().smoke.live;
    __sb.weapons.missiles.push({ pos: __sb.plane.pos.clone(), dir: __sb.plane.forward().clone() });
    fx.update(0.02, __sb.weapons);           // the trail clock has started
    fx.clear();                              // what restart / hangar / a ladder round do
    const empty = fx.stats();
    fx.update(0.01, __sb.weapons);
    const rightAfter = fx.stats().smoke.live; // 0.01 s: not due if the timer was reset
    fx.update(0.02, __sb.weapons);
    const due = fx.stats().smoke.live;        // 0.03 s on High: the new run's own missile starts its trail
    __sb.weapons.missiles.length = 0;
    return { filled, empty, rightAfter, due };
  })()`);
  ok(reset.filled > 0, 'the run had particles before the reset', String(reset.filled));
  ok(reset.empty.fire.live === 0 && reset.empty.debris.live === 0 && reset.empty.smoke.live === 0,
    'effects.clear() empties every pool', JSON.stringify(reset.empty));
  ok(reset.rightAfter === 0 && reset.due === 1,
    'effects.clear() also resets the trail timers (no smoke carried over from the last run)', JSON.stringify(reset));

  // route "Fly again": launch() -> restart(), which now clears the pools
  await evaluate(`__sb.effects.boom(__sb.plane.pos.clone(), 2)`);
  await evaluate(`__sb.hangar.trySortie()`);
  await sleep(700);
  const afterRun = await evaluate(`__sb.effects.stats()`);
  ok(afterRun.fire.live === 0 && afterRun.debris.live === 0 && afterRun.smoke.live === 0,
    'starting a new run begins with empty effect pools', JSON.stringify(afterRun));

  // route "Back to the hangar": enterHangar() clears them too
  await evaluate(`__sb.effects.boom(__sb.plane.pos.clone(), 2)`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(250);
  await evaluate(`document.getElementById('pauseHangar').click()`);
  await sleep(700);
  const hangar = await evaluate(`({ mode: __sb.mode, stats: __sb.effects.stats() })`);
  ok(hangar.mode === 'hangar', 'back to the hangar', String(hangar.mode));
  ok(hangar.stats.fire.live === 0 && hangar.stats.debris.live === 0 && hangar.stats.smoke.live === 0,
    'returning to the hangar empties the effect pools', JSON.stringify(hangar.stats));

  // route "AI Ladder": starting a level goes through launch() -> restart()
  await evaluate(`__sb.effects.boom(__sb.plane.pos.clone(), 2)`);
  const ladder = await evaluate(`(async () => {
    __sb.startLadder(1);
    await new Promise(r => setTimeout(r, 700));
    return { mode: __sb.mode, active: __sb.ladder.active, stats: __sb.effects.stats() };
  })()`);
  ok(ladder.active && ladder.mode === 'flight', 'the AI Ladder starts', JSON.stringify({ mode: ladder.mode, active: ladder.active }));
  ok(ladder.stats.fire.live === 0 && ladder.stats.debris.live === 0 && ladder.stats.smoke.live === 0,
    'entering the AI Ladder clears the previous run\'s particles', JSON.stringify(ladder.stats));

  // a fresh ladder round also clears the pools (newLadderRound)
  const round = await evaluate(`(async () => {
    __sb.effects.boom(__sb.plane.pos.clone(), 2);
    const dirty = __sb.effects.stats().smoke.live + __sb.effects.stats().fire.live;
    __sb.startLadder(1);
    await new Promise(r => setTimeout(r, 700));
    return { dirty, stats: __sb.effects.stats() };
  })()`);
  ok(round.dirty > 0 && round.stats.fire.live === 0 && round.stats.smoke.live === 0,
    'restarting an AI Ladder level leaves no particles behind', JSON.stringify(round));

  const consoleErrors = events
    .filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map(e => e.params.args.map(a => a.value || a.description || '').join(' '));
  ok(consoleErrors.length === 0, 'no console errors during the run', consoleErrors.slice(0, 3).join(' | '));

  ws.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nall browser checks passed');
  chrome.kill();
  await sleep(500);
  cleanupProfile();
  process.exit(failures ? 1 : 0);
})().catch(async e => {
  console.error(e);
  if (chromeErr) console.error('chrome stderr:', chromeErr.slice(0, 2000));
  try { chrome.kill(); } catch {}
  await sleep(500);
  cleanupProfile();
  process.exit(1);
});
