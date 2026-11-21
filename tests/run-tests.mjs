/* Zero-dependency browser test runner.
   Launches a headless Chromium browser (Edge on this machine; Chrome via CHROME_BIN if set) with
   the DevTools protocol, opens each test page and reads the JSON result the page logs
   (LIFECYCLE_TEST_RESULTS / LIMITER_TEST_RESULTS). Exits non-zero if any assertion fails or a page
   errors. No npm packages: Node 24's built-in WebSocket and fetch cover the small slice of CDP used.
   Usage:  node tests/run-tests.mjs [baseUrl]
   The static server (serve.mjs) is started separately by the npm script; baseUrl defaults to it. */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://localhost:8137';
const PAGES = [
  { url: `${BASE}/tests/lifecycle.html`, marker: 'LIFECYCLE_TEST_RESULTS' },
  { url: `${BASE}/tests/limiter.html`, marker: 'LIMITER_TEST_RESULTS' },
];
// Chrome 157 on this host rejects a custom --user-data-dir in every headless mode; Edge 158's
// classic headless accepts it and speaks the same DevTools protocol. CHROME_BIN overrides both.
const BIN = process.env.CHROME_BIN
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9361;

function launchBrowser() {
  const profile = join(tmpdir(), `dcr-test-profile-${process.pid}`);
  const args = [
    '--headless', `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required', // the engine resumes an AudioContext without a tap
    `--user-data-dir=${profile}`,
  ];
  return spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await res.json();
      const tab = tabs.find((t) => t.type === 'page');
      if (tab?.webSocketDebuggerUrl) return tab.webSocketDebuggerUrl;
    } catch { /* browser still starting */ }
    await delay(100);
  }
  throw new Error('DevTools endpoint did not come up');
}

// One CDP connection per page: enable logs, navigate, and resolve on the marked console line.
function runPage(wsUrl, page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
    const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout: ${page.url}`)); }, 60000);
    const errors = [];
    const logs = [];
    ws.onopen = () => {
      send('Runtime.enable');
      send('Log.enable');
      send('Page.enable');
      send('Page.navigate', { url: page.url });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.args?.length) {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        logs.push(text);
        if (text.startsWith(page.marker)) {
          clearTimeout(timer);
          const json = JSON.parse(text.slice(page.marker.length).trim());
          ws.close();
          resolve({ ...json, url: page.url, errors, logs });
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
        errors.push(msg.params.entry.text);
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        // navigation away; ignore
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`CDP socket error: ${e.message || e}`)); };
  });
}

const browser = launchBrowser();
let browserErr = '';
browser.stderr?.on('data', (d) => { browserErr += d; });
let code = 0;
try {
  const wsUrl = await getWsUrl();
  for (const page of PAGES) {
    let r;
    try {
      r = await runPage(wsUrl, page);
    } catch (err) {
      console.error(`\n${page.url}\n  RUNNER ERROR: ${err.message}`);
      code = 1;
      continue;
    }
    console.log(`\n${page.url}\n  ${r.passed}/${r.total} passed`);
    for (const x of r.results) {
      console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.detail ? ` — ${x.detail}` : ''}`);
      if (!x.pass) code = 1;
    }
    for (const e of r.errors) { console.log(`  PAGE-ERROR  ${e}`); code = 1; }
    if (r.errors.length || r.passed === 0) {
      console.log('  --- page console ---');
      for (const l of r.logs.slice(0, 30)) console.log(`  ${l}`);
    }
  }
} catch (err) {
  console.error(err);
  if (browserErr) console.error('browser stderr:', browserErr.split('\n').filter(Boolean).slice(-5).join('\n'));
  code = 1;
} finally {
  browser.kill();
}
process.exit(code);
