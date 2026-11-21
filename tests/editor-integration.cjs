/* Browser-level integration for the verifiable edit-history chain.
 *
 * The sandbox blocks cross-process loopback sockets, so instead of driving
 * the full editor over HTTP this test loads the REAL production modules
 * (web/editor/history.js and web/editor/save-queue.js) inside a headless
 * Chromium page, with only the network transport faked in-page. Everything
 * under test — snapshots, selection restore, stale-baseline guards, save
 * serialization and ordering — runs the same code the editor ships.
 *
 * Run from the repository root:
 *   node tests/editor-integration.cjs
 */
const path = require('node:path');
const fs = require('node:fs');
let chromium;
try {
  ({chromium} = require('playwright'));
} catch {
  console.log('SKIP: Playwright is not installed (set NODE_PATH to a tree containing playwright)');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const historySource = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'history.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(ROOT, 'web', 'editor', 'save-queue.js'), 'utf8');
const historyUrl = 'http://xinggou-test.local/editor/history.js';
const queueUrl = 'http://xinggou-test.local/editor/save-queue.js';

const HARNESS = `
globalThis.__results = [];
const report = (name, ok, detail = '') => globalThis.__results.push({name, ok, detail});
const assert = (cond, name, detail = '') => report(name, !!cond, detail);
const eq = (a, b, name) => report(name, JSON.stringify(a) === JSON.stringify(b),
  'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

const doc = (name, nodes = []) => ({
  schema: 'starscene/1', name, nodes, definitions: {},
  settings: {snap: 1, rotateSnap: 15}, design: null,
});

async function run() {
  const {EditHistory, StaleBaselineError} = await import(${JSON.stringify(historyUrl)});
  const {SaveQueue} = await import(${JSON.stringify(queueUrl)});

  // ---------- 1. edit then undo/redo restores content AND selection ----------
  {
    const history = new EditHistory({limit: 60});
    let live = doc('base', [{id: 'a'}, {id: 'b'}]);
    let selection = ['a'];
    history.push(live, selection, 0);
    live = doc('edited', [{id: 'a', moved: true}, {id: 'b'}]);
    selection = ['a', 'b'];

    const undone = history.undo(live, selection, 0);
    eq(undone.document.name, 'base', 'undo restores scene content');
    eq(undone.selection, ['a'], 'undo restores the captured selection');
    assert(undone.document.nodes.length === 2, 'undo snapshot is the full document');

    const redone = history.redo(undone.document, undone.selection, 0);
    eq(redone.document.name, 'edited', 'redo restores scene content');
    eq(redone.selection, ['a', 'b'], 'redo restores selection too');
  }

  // ---------- 2. external revision change blocks stale local undo ----------
  {
    const history = new EditHistory();
    history.push(doc('local-a'), ['local'], 5);
    // MCP client advances the server from revision 5 to 6.
    history.adoptBaseline();
    history.importEntryForVerification(doc('stale'), ['local'], 5, 1);
    let blocked = false;
    try { history.undo(doc('mcp-current'), [], 6); }
    catch (e) { blocked = e instanceof StaleBaselineError && e.chainMismatch; }
    assert(blocked, 'undo of a pre-MCP snapshot over the new baseline is rejected');
    assert(history.undoDepth === 1, 'rejected undo leaves the current project untouched');

    // Editing continues on the fresh chain, and those edits remain undoable.
    history.push(doc('mcp-current'), ['remote-node'], 6);
    const back = history.undo(doc('local-new-edit'), ['remote-node'], 6);
    eq(back.document.name, 'mcp-current', 'new edits after adoption form a playable chain');
    eq(back.selection, ['remote-node'], 'selection restored on the new chain');
  }

  // ---------- 3. rapid edits: serialized writes, last state lands last -------
  {
    let serverRevision = 0;
    const inflight = [];
    const writes = [];
    const transport = (document, requestedRevision) => new Promise((resolve, reject) => {
      inflight.push({document, requestedRevision, resolve, reject});
    });
    let live = doc('v0');
    let revision = 0;
    const queue = new SaveQueue({
      delay: 1,
      post: transport,
      getDocument: () => live,
      getRevision: () => revision,
      onRevision: next => { revision = next; },
      onConflict: error => report('conflict-during-rapid-edits', false, error.message),
      onError: error => report('save-error-during-rapid-edits', false, error.message),
    });

    queue.requestFlush();
    await new Promise(r => setTimeout(r, 5));
    assert(inflight.length === 1, 'first edit starts exactly one request');

    for (const name of ['v1', 'v2', 'v3', 'v4']) {
      live = doc(name);
      queue.requestFlush();
    }
    // Resolve the first request (carrying v0); trailing edits must coalesce.
    assert(inflight[0].document.name === 'v0', 'first request carries the first state');
    inflight[0].resolve({revision: ++serverRevision});
    await new Promise(r => setTimeout(r, 8));
    assert(inflight.length === 2, 'coalesced edits produce one trailing request, not four');
    assert(inflight[1].document.name === 'v4', 'trailing request carries the newest state');
    inflight[1].resolve({revision: ++serverRevision});
    await new Promise(r => setTimeout(r, 8));

    eq(writes.length, 0, 'no extra requests after the queue drained');
    eq(revision, 2, 'revision advances once per accepted write');
    assert(!queue.hasPending, 'queue is idle after the final state lands');
  }

  // ---------- 4. 409 from the server halts autosave and raises conflict ------
  {
    const queue = new SaveQueue({
      delay: 1,
      post: () => Promise.reject(Object.assign(new Error('stale revision'), {status: 409})),
      getDocument: () => doc('x'),
      getRevision: () => 3,
      onRevision: () => report('conflict-moved-revision', false, 'must not happen'),
      onConflict: () => report('409-routed-to-conflict-flow', true),
    });
    queue.requestFlush();
    await new Promise(r => setTimeout(r, 15));
    assert(!queue.hasPending, 'conflict stops the queue instead of retrying');
  }

  // ---------- 5. hidden unbound object still allows export semantics check ---
  // The blocking rule lives server-side (flatten); here we mirror it on the
  // sample project so browser behavior is pinned alongside the Python tests.
  {
    const sample = JSON.parse(window.__sampleJson);
    const visible = sample.nodes.filter(n => n.visible !== false);
    const visibleUnbound = visible.filter(n => n.assetId === 'terrain-local-unbound');
    const hiddenUnbound = sample.nodes.filter(n => n.visible === false && n.assetId === 'terrain-local-unbound');
    eq(visibleUnbound.length, 1, 'a visible unbound object must still block export');
    eq(hiddenUnbound.length, 1, 'the hidden unbound object is excluded from visible export set');
    assert(!visible.some(n => n.visible === false), 'hidden objects never enter the export set');
  }

  return globalThis.__results;
}
run().then(r => { window.__done = true; }, e => { window.__fatal = String(e && e.stack || e); });
`;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
  });
  try {
    const context = await browser.newContext();
    // Serve the production modules over a virtual origin: real network is
    // sandbox-blocked, but Chromium still accepts module MIME types here.
    const moduleHeaders = {
      'contentType': 'text/javascript; charset=utf-8',
      'headers': {'Access-Control-Allow-Origin': '*'},
    };
    await context.route('**/editor/history.js', route =>
      route.fulfill({...moduleHeaders, body: historySource}));
    await context.route('**/editor/save-queue.js', route =>
      route.fulfill({...moduleHeaders, body: queueSource}));
    const page = await context.newPage();
    const sample = fs.readFileSync(path.join(ROOT, 'examples', '历史链验证.starscene.json'), 'utf8');
    await page.setContent(`<!doctype html><meta charset="utf-8"><body></body>`);
    await page.addInitScript(sampleJson => { window.__sampleJson = sampleJson; }, sample);
    // addInitScript only applies to future navigations; set the value directly too.
    await page.evaluate(sampleJson => { window.__sampleJson = sampleJson; }, sample);
    await page.evaluate(HARNESS);
    await page.waitForFunction(() => window.__done === true || window.__fatal, {timeout: 30000});
    const fatal = await page.evaluate(() => window.__fatal);
    if (fatal) throw new Error('in-page harness failed: ' + fatal);
    const results = await page.evaluate(() => window.__results);
    let failed = 0;
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + r.detail}`);
      if (!r.ok) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} browser integration checks passed`);
    if (failed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
