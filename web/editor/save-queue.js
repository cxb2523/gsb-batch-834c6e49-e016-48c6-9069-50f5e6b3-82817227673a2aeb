// Serialized autosave queue for the browser editor.
//
// Rapid local edits must never produce out-of-order writes: if edit A and
// edit B happen while A's request is in flight, the server must end with B's
// document, not A's. The queue guarantees:
//
//   * at most one save request is in flight at any moment;
//   * every flush serializes the CURRENT document through getDocument(), so a
//     retry after a quick edit always writes the latest state;
//   * the revision used for a request is read at request time and compared
//     against the revision returned for that exact request, so a stale
//     response can never clobber a newer baseline;
//   * revision conflicts (HTTP 409) stop the queue immediately and hand the
//     document to onConflict for the baseline-change flow;
//   * adoption of a new baseline (remote sync) resets all pending state.
//
// Like history.js this module has no three.js/DOM dependencies.

export class SaveQueue {
  #post;
  #getDocument;
  #getRevision;
  #onRevision;
  #onSaved;
  #onConflict;
  #onError;
  #debounceMs;

  #timer = null;
  #inFlight = false;
  #dirty = false;
  #stopped = false;
  #conflict = false;
  #generation = 0;
  #requestSeq = 0;
  #lastAckSeq = 0;
  #requestLog = [];

  constructor({
    post, getDocument, getRevision, onRevision, onSaved, onConflict, onError,
    delay = 700,
  }) {
    if (typeof post !== 'function' || typeof getDocument !== 'function' ||
        typeof getRevision !== 'function') {
      throw new Error('SaveQueue 需要 post/getDocument/getRevision 回调');
    }
    this.#post = post;
    this.#getDocument = getDocument;
    this.#getRevision = getRevision;
    this.#onRevision = onRevision || (() => {});
    this.#onSaved = onSaved || (() => {});
    this.#onConflict = onConflict || (() => {});
    this.#onError = onError || (() => {});
    this.#debounceMs = delay;
  }

  get inFlight() { return this.#inFlight; }
  get dirty() { return this.#dirty; }
  get conflict() { return this.#conflict; }
  get hasPending() { return this.#dirty || this.#inFlight; }
  get pending() { return this.#dirty; }
  get lastAckSeq() { return this.#lastAckSeq; }

  // Mark the current document as needing persistence. Coalesces rapid edits
  // into one trailing flush; if a request is already in flight the flush runs
  // as soon as it settles. While a revision conflict is open the queue stays
  // halted — further edits must not fire doomed requests against the old
  // baseline; reset() clears the halt when the new baseline is adopted.
  requestFlush() {
    if (this.#stopped || this.#conflict) return;
    this.#dirty = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; this.#schedule(); }, this.#debounceMs);
  }

  // Bypass the debounce (used by tests and explicit save actions).
  flushNow() {
    if (this.#conflict) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#schedule();
  }

  // Single scheduling gate. A pending debounce timer always re-enters here,
  // so checking the conflict/stop flags in this one place guarantees a timer
  // queued before a 409 arrived can never start a request afterwards.
  #schedule() {
    if (this.#stopped || this.#conflict || this.#inFlight || !this.#dirty) return;
    this.#dirty = false;
    this.#inFlight = true;
    // Capture everything for THIS request at dispatch time. The document is
    // the newest state; the sequence number identifies the request later so
    // an older response can never update the baseline for a newer edit.
    const generation = this.#generation;
    const seq = ++this.#requestSeq;
    const document = structuredClone(this.#getDocument());
    const requestedRevision = this.#getRevision();
    this.#requestLog.push({ seq, requestedRevision, started: this.#requestLog.length + 1 });
    Promise.resolve(this.#post(document, requestedRevision))
      .then(result => this.#settle(generation, seq, requestedRevision, null, result))
      .catch(error => this.#settle(generation, seq, requestedRevision, error, null));
  }

  #settle(generation, seq, requestedRevision, error, result) {
    // A reset() adopted a new baseline while this request was flying; its
    // response belongs to the discarded chain and must change nothing.
    if (generation !== this.#generation) {
      this.#requestLog.push({ seq, ignoredAfterReset: true });
      return;
    }
    this.#inFlight = false;
    if (this.#stopped) return;
    if (error) {
      const conflict = error && error.status === 409;
      if (conflict) {
        // The server rejected our revision: another client moved the
        // baseline. Halt the queue (including any later requestFlush) until
        // the user adopts the new project through reset().
        this.#conflict = true;
        this.#dirty = false;
        clearTimeout(this.#timer);
        this.#timer = null;
        this.#requestLog.push({ seq, conflict: true });
        this.#onConflict(error);
        return;
      }
      // Transient failure: keep the latest document pending and retry once
      // the debounce window passes again.
      this.#dirty = true;
      this.#requestLog.push({ seq, error: String((error && error.message) || error) });
      this.#onError(error);
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => { this.#timer = null; this.#schedule(); }, this.#debounceMs);
      return;
    }
    if (!result || !Number.isInteger(result.revision)) {
      // A malformed response is treated as a transient failure, not a thrown
      // promise: keep the latest document pending and retry on the same path.
      this.#inFlight = false;
      this.#dirty = true;
      const error = new Error('保存响应缺少 revision，无法确认写入顺序');
      this.#requestLog.push({ seq, error: error.message });
      this.#onError(error);
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => { this.#timer = null; this.#schedule(); }, this.#debounceMs);
      return;
    }
    this.#requestLog.push({ seq, revision: result.revision });
    // Only the request for the revision we actually sent may advance it.
    this.#onRevision(result.revision, requestedRevision, seq);
    this.#lastAckSeq = seq;
    if (!this.#dirty) this.#onSaved(seq);
    this.#schedule();
  }

  // Adopt a fresh server baseline (external revision change / reload remote).
  // Pending edits are dropped deliberately: the live document itself is
  // replaced by the caller before this runs. A generation bump makes any
  // request still in flight a no-op when it settles.
  reset(newRevision) {
    if (!Number.isInteger(newRevision) || newRevision < 0) {
      throw new Error('重置保存队列需要有效的 revision');
    }
    this.#generation += 1;
    this.#stopped = false;
    this.#conflict = false;
    this.#dirty = false;
    this.#inFlight = false;
    this.#requestSeq = 0;
    this.#lastAckSeq = 0;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#onRevision(newRevision, newRevision, 0);
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  // Test/diagnostic view of the serialized write order.
  inspect() {
    return {
      dirty: this.#dirty,
      inFlight: this.#inFlight,
      stopped: this.#stopped,
      conflict: this.#conflict,
      requestSeq: this.#requestSeq,
      lastAckSeq: this.#lastAckSeq,
      log: this.#requestLog.map(entry => ({ ...entry })),
    };
  }
}
