// Unit tests for the verifiable edit-history chain and the serialized
// autosave queue. Pure Node, no browser or network: the save transport is an
// in-memory fake whose timing the tests control.
//
// Run from the repository root:
//   node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const {EditHistory, StaleBaselineError} =
  await import(pathToFileURL(path.join(here, '..', 'web', 'editor', 'history.js')));
const {SaveQueue} =
  await import(pathToFileURL(path.join(here, '..', 'web', 'editor', 'save-queue.js')));

const doc = (name, extra = {}) => ({
  schema: 'starscene/1', name, nodes: [], definitions: {},
  settings: {snap: 1, rotateSnap: 15}, design: null, ...extra,
});

// ---------------------------------------------------------------- history
test('history push/undo/redo restores document content together with selection', () => {
  const h = new EditHistory();
  let current = doc('v0');
  let selection = ['a'];
  h.push(current, selection, 0);
  current = doc('v1', {nodes: [{id: 'a'}]});
  selection = ['a', 'b'];
  h.push(current, selection, 0);
  current = doc('v2', {nodes: [{id: 'a'}, {id: 'b'}]});
  selection = ['b'];

  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);
  const back = h.undo(current, selection, 0);
  assert.deepEqual(back.document, doc('v1', {nodes: [{id: 'a'}]}));
  assert.deepEqual(back.selection, ['a', 'b'], 'undo must restore the selection captured with that state');

  const further = h.undo(back.document, back.selection, 0);
  assert.deepEqual(further.document, doc('v0'));
  assert.deepEqual(further.selection, ['a']);
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, true);

  const forward = h.redo(further.document, further.selection, 0);
  assert.deepEqual(forward.document, doc('v1', {nodes: [{id: 'a'}]}));
  assert.deepEqual(forward.selection, ['a', 'b'], 'redo must restore selection as well');
});

test('history snapshots are independent copies, never live references', () => {
  const h = new EditHistory();
  const current = doc('v0', {nodes: [{id: 'a', position: [0, 0, 0]}]});
  h.push(current, ['a'], 0);
  current.nodes[0].position[0] = 42;
  current.name = 'mutated';
  const back = h.undo(doc('v1'), [], 0);
  assert.deepEqual(back.document.nodes[0].position, [0, 0, 0]);
  assert.equal(back.document.name, 'v0');
  // Mutating a restored document must not corrupt the redo stack.
  back.document.name = 'tampered';
  const again = h.redo(doc('v1'), [], 0);
  assert.equal(again.document.name, 'v1');
});

test('a new edit after undo truncates the redo branch', () => {
  const h = new EditHistory();
  h.push(doc('a'), [], 0);
  h.push(doc('b'), [], 0);
  h.undo(doc('b'), [], 0);
  assert.equal(h.redoDepth, 1);
  h.push(doc('b2'), [], 0);
  assert.equal(h.redoDepth, 0);
  assert.equal(h.undoDepth, 2, 'the b2 edit leaves a and b2 reachable by undo');
});

test('history enforces its capacity and keeps the newest entries', () => {
  const h = new EditHistory({limit: 3});
  for (let i = 0; i < 5; i++) h.push(doc('s' + i), [], 0);
  assert.equal(h.undoDepth, 3);
  const first = (() => {
    let state = doc('s5');
    for (let i = 0; i < 3; i++) state = h.undo(state, [], 0).document;
    return state;
  })();
  assert.equal(first.name, 's2');
});

test('history rejects malformed pushes instead of storing unverifiable entries', () => {
  const h = new EditHistory();
  assert.throws(() => h.push(null, [], 0), /工程文档/);
  assert.throws(() => h.push(doc('x'), [], -1), /revision/);
  assert.throws(() => h.push(doc('x'), ['a', 'a'], 0), /重复标识/);
});

test('adoptBaseline invalidates every old snapshot so undo cannot overwrite the new project', () => {
  const h = new EditHistory();
  h.push(doc('local-0'), ['local-a'], 5);
  h.push(doc('local-1'), ['local-b'], 5);
  // MCP / another client writes through revision 5; server now serves 6.
  const chainAfterAdopt = h.adoptBaseline();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(chainAfterAdopt, 2);
  // Editing can continue on the new chain immediately.
  h.push(doc('remote-base'), ['remote-a'], 6);
  const back = h.undo(doc('remote-edit'), ['remote-a'], 6);
  assert.deepEqual(back.document, doc('remote-base'));
  assert.deepEqual(back.selection, ['remote-a']);
});

test('stale-baseline entries cannot be replayed even if the stack is tampered with', () => {
  // Simulate an entry that somehow survived the chain switch: it carries the
  // old chain id (1) and an old baseline revision (3), while the editor is
  // now on chain 2 / revision 4 after an MCP-driven adoption.
  const h = new EditHistory();
  h.adoptBaseline();
  assert.equal(h.chainId, 2);
  h.importEntryForVerification(doc('chain-1-doc'), ['x'], 3, 1);
  assert.throws(() => h.undo(doc('current'), [], 4), error => {
    return error instanceof StaleBaselineError && error.chainMismatch === true &&
      error.entryBaseline === 3 && error.currentBaseline === 4;
  });
  assert.equal(h.redoDepth, 0, 'a failed undo must leave the chain untouched');
  assert.equal(h.undoDepth, 1, 'the rejected entry stays parked rather than being consumed');

  // Same chain, but the entry was captured against a newer revision than the
  // current baseline (a revision that moved backwards). Also rejected.
  const g = new EditHistory();
  g.importEntryForVerification(doc('ahead'), [], 7, g.chainId);
  assert.throws(() => g.undo(doc('current'), [], 2), error =>
    error instanceof StaleBaselineError && error.chainMismatch === false);
});

test('describe() verifies structural integrity of the whole chain', () => {
  const h = new EditHistory();
  h.push(doc('a'), ['n1'], 0);
  h.push(doc('b'), [], 0);
  h.undo(doc('b'), [], 0);
  const report = h.describe(0);
  assert.equal(report.intact, true);
  assert.deepEqual(report.undoBaselines, [0]);
  assert.deepEqual(report.redoBaselines, [0]);
  assert.equal(report.chainId, 1);
});

// ------------------------------------------------------------- save queue
function makeServer() {
  // In-memory revision store; rejects writes whose revision is stale.
  let revision = 0;
  const writes = [];
  const pending = [];
  return {
    writes, pending,
    revision: () => revision,
    post(document, requestedRevision) {
      return new Promise((resolve, reject) => {
        pending.push({document, requestedRevision, resolve, reject});
      });
    },
    acceptNext() {
      const job = pending.shift();
      if (!job) throw new Error('no pending save');
      if (job.requestedRevision !== revision) {
        const error = new Error('工程已被另一端更新，请重新载入后继续');
        error.status = 409;
        job.reject(error);
        return null;
      }
      revision += 1;
      writes.push({revision, name: job.document.name, requested: job.requestedRevision});
      job.resolve({revision, project: job.document, source: 'web'});
      return revision;
    },
    rejectNext(status = 500, message = 'boom') {
      const job = pending.shift();
      const error = new Error(message);
      error.status = status;
      job.reject(error);
    },
    inflight: () => pending.length,
  };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function makeQueue(server, callbacks = {}) {
  let live = doc('start');
  let revision = 0;
  const saved = [];
  const conflicts = [];
  const errors = [];
  const queue = new SaveQueue({
    delay: 1,
    post: (d, r) => server.post(d, r),
    getDocument: () => live,
    getRevision: () => revision,
    onRevision: (next, requested, seq) => { revision = next; callbacks.onRevision?.(next, requested, seq); },
    onSaved: seq => { saved.push(seq); callbacks.onSaved?.(seq); },
    onConflict: error => { conflicts.push(error); callbacks.onConflict?.(error); },
    onError: error => { errors.push(error); callbacks.onError?.(error); },
  });
  return {
    queue,
    setDocument: next => { live = next; },
    getRevision: () => revision,
    saved, conflicts, errors,
  };
}

test('rapid consecutive edits coalesce and the final persisted state is the last one', async () => {
  const server = makeServer();
  const harness = makeQueue(server);
  harness.queue.requestFlush();
  await tick();
  assert.equal(server.inflight(), 1, 'the first edit starts one in-flight request');

  // Three more edits land while that request is still flying.
  harness.setDocument(doc('edit-A'));
  harness.queue.requestFlush();
  harness.setDocument(doc('edit-B'));
  harness.queue.requestFlush();
  harness.setDocument(doc('edit-C'));
  harness.queue.requestFlush();

  server.acceptNext(); // resolves the first request with document "start"
  await tick(5);
  // The coalesced trailing request must carry the newest document, not A/B.
  assert.equal(server.inflight(), 1);
  const finalRevision = server.acceptNext();
  await tick(5);

  assert.equal(server.writes.length, 2);
  assert.deepEqual(server.writes.map(w => w.name), ['start', 'edit-C']);
  assert.equal(server.writes.at(-1).name, 'edit-C', 'last write wins, in order');
  assert.equal(finalRevision, 2);
  assert.equal(harness.getRevision(), 2);
  assert.equal(harness.queue.hasPending, false);
  assert.equal(harness.saved.at(-1), harness.queue.lastAckSeq);
});

test('save requests never overlap and each retry reads the newest document', async () => {
  const server = makeServer();
  const harness = makeQueue(server);
  harness.queue.requestFlush();
  await tick();
  assert.equal(server.inflight(), 1);
  harness.queue.requestFlush();
  harness.queue.requestFlush();
  assert.equal(server.inflight(), 1, 'a second flush cannot start while one request is in flight');
  server.acceptNext();
  await tick(5);
  assert.equal(server.inflight(), 1, 'the pending trailing edit schedules exactly one request');
  server.acceptNext();
  await tick(5);
  assert.equal(server.inflight(), 0);
});

test('a response settling after reset cannot move the adopted baseline', async () => {
  // Deliberately slow transport: the editor adopts a remote baseline while
  // its own save request is still in flight.
  let resolveSlow;
  let liveRevision = 0;
  const revisionUpdates = [];
  const queue = new SaveQueue({
    delay: 1,
    post: () => new Promise(resolve => { resolveSlow = resolve; }),
    getDocument: () => doc('old-chain'),
    getRevision: () => liveRevision,
    onRevision: next => { liveRevision = next; revisionUpdates.push(next); },
  });
  queue.requestFlush();
  await tick();
  assert.equal(queue.inFlight, true);

  queue.reset(9); // remote adoption (MCP revision 9) while the request flies
  assert.equal(liveRevision, 9);
  resolveSlow({revision: 1}); // stale response from the old chain lands late
  await tick(5);
  assert.equal(liveRevision, 9, 'the late response must not touch the adopted baseline');
  assert.equal(queue.inspect().log.some(entry => entry.ignoredAfterReset), true);
  assert.equal(queue.inFlight, false);
});

test('revision conflict (409) stops the queue and routes to the conflict flow', async () => {
  const conflicts = [];
  const queue = new SaveQueue({
    delay: 1,
    post: () => Promise.reject(Object.assign(new Error('工程已被另一端更新'), {status: 409})),
    getDocument: () => doc('local'),
    getRevision: () => 4,
    onRevision: () => { throw new Error('conflict must not update revision'); },
    onConflict: error => conflicts.push(error),
  });
  queue.requestFlush();
  await tick(10);
  assert.equal(conflicts.length, 1);
  assert.equal(queue.hasPending, false, 'the queue halts instead of retrying a conflict');
  assert.equal(queue.conflict, true);
  assert.equal(queue.inspect().log.at(-1).conflict, true);

  // Further local edits while the conflict banner is open must not fire
  // doomed requests against the stale baseline.
  let conflictCalls = 0;
  const conflictQueue = new SaveQueue({
    delay: 1,
    post: () => { conflictCalls += 1; return Promise.reject(Object.assign(new Error('conflict'), {status: 409})); },
    getDocument: () => doc('x'),
    getRevision: () => 4,
    onConflict: () => {},
  });
  conflictQueue.requestFlush();
  await tick(10);
  conflictQueue.requestFlush();
  conflictQueue.requestFlush();
  conflictQueue.flushNow();
  await tick(10);
  assert.equal(conflictCalls, 1, 'only the original conflicting request reached the transport');
  assert.equal(conflictQueue.conflict, true);
  assert.equal(conflictQueue.inspect().log.filter(e => e.conflict).length, 1);

  // Adopting the new baseline clears the halt and saves resume normally.
  conflictQueue.reset(8);
  assert.equal(conflictQueue.conflict, false);
  const server = makeServer();
  const harness = makeQueue(server);
  harness.setDocument(doc('after-adopt'));
  harness.queue.requestFlush();
  await tick(5);
  server.acceptNext();
  await tick(5);
  assert.equal(harness.getRevision(), 1);
  assert.equal(server.writes[0].name, 'after-adopt');
});

test('transient failures keep the newest document pending and retry it', async () => {
  let attempts = 0;
  const queue = new SaveQueue({
    delay: 1,
    post: (document, revision) => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(Object.assign(new Error('network'), {status: 502}));
      return Promise.resolve({revision: revision + 1});
    },
    getDocument: () => doc('retry-me'),
    getRevision: () => 0,
    onRevision: next => { assert.equal(next, 1); },
  });
  queue.requestFlush();
  await tick(20);
  assert.equal(attempts, 2);
  assert.equal(queue.dirty, false);
});

test('save queue only serializes the current history position', async () => {
  const server = makeServer();
  const harness = makeQueue(server);
  // Edit to v1, let it land.
  harness.setDocument(doc('v1'));
  harness.queue.requestFlush();
  await tick(5);
  server.acceptNext();
  await tick(5);
  assert.equal(harness.queue.lastAckSeq, 1);
  // Edit to v2 then immediately undo back to v1 before the debounce fires.
  harness.setDocument(doc('v2'));
  harness.queue.requestFlush();
  harness.setDocument(doc('v1-restored'));
  harness.queue.requestFlush();
  await tick(5);
  server.acceptNext();
  await tick(5);
  assert.deepEqual(server.writes.map(w => w.name), ['v1', 'v1-restored'],
    'autosave lands the live (current) document, never a superseded snapshot');
});

// ------------------------------------------------------- sample project
test('sample history-scene project is a valid starscene document with one hidden unbound node', () => {
  const samplePath = path.join(here, '..', 'examples', '历史链验证.starscene.json');
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  assert.equal(sample.schema, 'starscene/1');
  assert.ok(Array.isArray(sample.nodes) && sample.nodes.length >= 2);
  const hiddenUnbound = sample.nodes.find(n => n.visible === false && n.assetId === 'terrain-local-unbound');
  assert.ok(hiddenUnbound, 'sample must keep a hidden unbound object for export-policy checks');
  const visibleUnbound = sample.nodes.find(n => n.visible !== false && n.assetId === 'terrain-local-unbound');
  assert.ok(visibleUnbound, 'sample also keeps a visible unbound object for blocking checks');
  const bound = sample.nodes.filter(n => n.visible !== false && n.assetId !== 'terrain-local-unbound');
  assert.ok(bound.length >= 1);
});
