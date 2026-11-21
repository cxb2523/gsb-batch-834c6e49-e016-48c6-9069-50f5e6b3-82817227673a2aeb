/* Real-page smoke: serve the actual web/ tree through Playwright route
 * interception (cross-process loopback is sandbox-blocked) and stub only the
 * /api boot/save endpoints. Verifies app.js boots with the new history and
 * save-queue modules and that the editor surfaces no page errors.
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

const ROOT = path.resolve(__dirname, '..', 'web');
const mime = p => p.endsWith('.js') ? 'text/javascript; charset=utf-8'
  : p.endsWith('.css') ? 'text/css; charset=utf-8'
  : p.endsWith('.svg') ? 'image/svg+xml'
  : p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';

const bootProject = {
  schema: 'starscene/1', name: '冒烟工程',
  nodes: [
    {id: 'n1', assetId: '10009001', name: '方块', position: [0, 0, 0],
     rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, layer: '场景'},
    {id: 'n2', assetId: '10009002', name: '球体', position: [3, 0, 0],
     rotation: [0, 0, 0], scale: [1, 1, 1], visible: false, locked: false, layer: '场景'},
  ],
  definitions: {}, settings: {snap: 1, rotateSnap: 15, groundHeight: 0}, design: null,
};
const catalog = [10009001, 10009002, 10009008].map((id, i) => ({
  id: String(id), name: ['长方体', '球体', '圆柱'][i], category: '几何体',
  internalName: 'p' + id, aliases: [], templateId: id, tags: ['基元'],
  dimensions: [1, 1, 1], triangles: 0, modelUrl: null, glb: null,
  warnings: [], primitive: ['box', 'sphere', 'cylinder'][i], exportable: true,
}));

(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']});
  const context = await browser.newContext({viewport: {width: 1400, height: 900}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    // The single 409 below is the conflict flow under test; the app handles
    // it in a catch clause, so Chromium's resource log line is expected.
    if (m.type() === 'error' && !m.text().includes('409 (Conflict)')) {
      errors.push('console: ' + m.text());
    }
    if (process.env.DEBUG_SMOKE) console.log('  [' + m.type() + ']', m.text().slice(0, 220));
  });
  page.on('response', r => { if (r.status() >= 400 && r.status() !== 409 && process.env.DEBUG_SMOKE) console.log('  [http ' + r.status() + ']', r.url()); });

  const saves = [];
  const requestLog = [];
  const t0 = Date.now();
  let serverRevision = 0;
  let conflictOnce = false;
  let externalProject = null;

  const json = value => ({contentType: 'application/json; charset=utf-8', body: JSON.stringify(value)});
  if (process.env.DEBUG_SMOKE) {
    page.on('console', m => { const t = m.text(); if (t.includes('POST-STACK')) console.log(t); });
  }
  await context.route(/\/api\//, route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/boot') {
      return route.fulfill(json({
        tool: 'XingGou', displayName: '星构工具箱', version: 'test',
        catalog, catalogStatus: {total: catalog.length, ready: catalog.length, libraryAvailable: false, assetRoot: 'test'},
        provider: {}, revision: serverRevision, project: bootProject,
      }));
    }
    if (url.pathname === '/api/project' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      requestLog.push({sent: body.revision, server: serverRevision, conflictOnce, t: Date.now() - t0});
      // One forced conflict to simulate the MCP writer winning the baseline;
      // afterwards the normal optimistic-revision rule applies, so once the
      // editor adopts the new revision its continued edits save successfully.
      if (conflictOnce) {
        conflictOnce = false;
        serverRevision += 1;
        return route.fulfill({status: 409, ...json({error: '工程已被另一端更新，请重新载入后继续', conflict: true})});
      }
      if (body.revision !== serverRevision) {
        return route.fulfill({status: 409, ...json({error: '工程已被另一端更新，请重新载入后继续', conflict: true})});
      }
      serverRevision += 1;
      saves.push({revision: serverRevision, name: body.project.name, nodes: body.project.nodes.length, source: body.source});
      return route.fulfill(json({revision: serverRevision, project: body.project, source: body.source || 'web'}));
    }
    if (url.pathname === '/api/project') {
      if (externalProject) {
        const project = externalProject;
        requestLog.push({GET: serverRevision, t: Date.now() - t0});
        return route.fulfill(json({revision: serverRevision, project, source: 'mcp'}));
      }
      return route.fulfill(json({revision: serverRevision, project: bootProject, source: 'web'}));
    }
    return route.fulfill({status: 404, ...json({error: 'not stubbed: ' + url.pathname})});
  });

  // The source tree ships only the three.js addons and a manifest; the full
  // build arrives with the packaged release. Resolve it from the pinned
  // scratch dependency (three 0.180.0, matching web/vendor/three/FILES.json).
  const scratchThree = path.resolve(__dirname, '..', '..', 'scratch-npm', 'node_modules', 'three');
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel = 'index.html';
    let file = path.join(ROOT, rel);
    if (!fs.existsSync(file) && rel.startsWith('vendor/three/build/')) {
      file = path.join(scratchThree, rel.slice('vendor/three/'.length));
    }
    if (!file.startsWith(ROOT) && !file.startsWith(scratchThree)) {
      return route.fulfill({status: 403, body: 'path outside served roots'});
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return route.fulfill({status: 404, body: 'not found ' + rel});
    }
    return route.fulfill({
      contentType: mime(file),
      headers: {'Cache-Control': 'no-store'},
      body: fs.readFileSync(file),
    });
  });

  await page.goto('http://xinggou-smoke.local/');
  await page.locator('#loading-overlay').waitFor({state: 'hidden', timeout: 15000});
  await page.waitForTimeout(500);

  // Boot wired the new modules without errors and rendered the two nodes.
  const stats = await page.locator('#object-stats').innerText();
  if (!stats.includes('2 个物件')) throw new Error('boot did not render sample nodes: ' + stats);

  // Undo is disabled with a fresh boot history; redo too.
  if (await page.locator('#undo').isEnabled()) throw new Error('undo must be disabled at boot');
  if (await page.locator('#redo').isEnabled()) throw new Error('redo must be disabled at boot');

  // Rename the project: an edit entry must be pushed (undo enabled) and the
  // serialized save queue must persist exactly the newest state.
  await page.locator('#project-name').fill('冒烟改名');
  await page.locator('#project-name').press('Tab');
  await page.waitForFunction(() => !document.querySelector('#undo').disabled);
  await page.waitForTimeout(900); // autosave debounce + flush
  if (saves.length !== 1 || saves[0].name !== '冒烟改名') {
    throw new Error('autosave did not persist the renamed project in order: ' + JSON.stringify(saves));
  }

  // Undo restores the previous name; selection state machinery stays intact.
  await page.locator('#undo').click();
  await page.waitForTimeout(900);
  const nameAfterUndo = await page.locator('#project-name').inputValue();
  if (nameAfterUndo !== '冒烟工程') throw new Error('undo did not restore prior document: ' + nameAfterUndo);
  if (!(await page.locator('#redo').isEnabled())) throw new Error('redo must be enabled after undo');

  // Redo returns to the renamed state.
  await page.locator('#redo').click();
  await page.waitForTimeout(900);
  const nameAfterRedo = await page.locator('#project-name').inputValue();
  if (nameAfterRedo !== '冒烟改名') throw new Error('redo did not restore the edited document');

  // The final persisted revision must reflect the last state, in order.
  const ordered = saves.every((s, i) => s.revision === i + 1);
  if (!ordered) throw new Error('save revisions arrived out of order: ' + JSON.stringify(saves));

  // --- External revision change: an MCP write moves the baseline, then a
  // local undo-driven save must be refused (409) and never overwrite it.
  const mcpProject = structuredClone(bootProject);
  mcpProject.name = 'MCP 外部工程';
  conflictOnce = true;
  externalProject = mcpProject;
  await page.evaluate(() => { window.__tracePost = true; window.__flushEvents = []; });
  // Trigger a local edit; its save carries the stale revision and gets 409.
  await page.locator('#project-name').fill('本地晚到修改');
  await page.locator('#project-name').press('Tab');
  await page.waitForTimeout(200);
  if (process.env.DEBUG_SMOKE) {
    console.log('queue right after edit:', JSON.stringify(await page.evaluate(() => window.__xinggouSaveQueue.inspect())));
  }
  await page.waitForTimeout(900);
  await page.locator('#external-update').waitFor({state: 'visible', timeout: 8000});
  if (process.env.DEBUG_SMOKE) {
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await page.evaluate(() => {
        const q = window.__xinggouSaveQueue.inspect();
        return {conflict: q.conflict, dirty: q.dirty, inFlight: q.inFlight, seq: q.requestSeq, logLen: q.log.length};
      }));
      await page.waitForTimeout(250);
    }
    console.log('conflict-state samples:', JSON.stringify(samples));
  }
  if (!(await page.locator('#undo').isEnabled())) throw new Error('local edit history must survive the conflict');

  // The conflict banner offers "load remote"; adopting it resets the chain.
  await page.locator('#reload-remote').click();
  await page.waitForFunction(() => document.querySelector('#project-name').value === 'MCP 外部工程');
  if (await page.locator('#undo').isEnabled()) {
    throw new Error('adopting the external baseline must reset local undo history');
  }
  if (await page.locator('#external-update').isVisible()) {
    throw new Error('conflict banner must clear after adopting the remote project');
  }
  // Continued editing on the fresh chain saves against the new revision.
  await page.locator('#project-name').fill('新基线继续编辑');
  await page.locator('#project-name').press('Tab');
  await page.waitForTimeout(900);
  const lastSave = saves[saves.length - 1];
  if (lastSave.name !== '新基线继续编辑') throw new Error('edit after adoption did not save: ' + JSON.stringify(lastSave));

  if (errors.length) {
    console.log('REQUEST LOG', JSON.stringify(requestLog));
    throw new Error('page errors: ' + errors.join(' | '));
  }
  console.log('SMOKE OK', JSON.stringify({saves, finalName: lastSave.name, revisions: serverRevision}));
  await browser.close();
})().catch(async e => { console.error('SMOKE FAIL', e.message); try { await page.screenshot({path: path.join(ROOT, '..', '.runtime', 'smoke-fail.png')}); } catch {} process.exit(1); });
