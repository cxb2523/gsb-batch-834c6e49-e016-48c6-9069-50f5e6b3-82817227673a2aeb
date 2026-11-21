// Verifiable single-chain edit history for the browser editor.
//
// Every local edit leaves behind an entry that captures BOTH the complete
// scene document and the selection at that moment, together with the server
// baseline revision it was built on and the id of the edit chain. Undo and
// redo therefore restore scene content and selection together, and an entry
// created against a baseline that the server has since replaced (MCP or
// another client writing through revision) can never be played back over the
// current document.
//
// The module is deliberately free of three.js/DOM dependencies so the whole
// state-chain contract can be exercised by the Node unit tests.

export class StaleBaselineError extends Error {
  constructor(message, entryBaseline, currentBaseline, chainMismatch = false) {
    super(message);
    this.name = 'StaleBaselineError';
    this.entryBaseline = entryBaseline;
    this.currentBaseline = currentBaseline;
    this.chainMismatch = chainMismatch;
  }
}

export class EditHistory {
  #undo = [];
  #redo = [];
  #chainId = 1;
  #limit;

  constructor({ limit = 60 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('历史容量必须是正整数');
    this.#limit = limit;
  }

  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  get chainId() { return this.#chainId; }
  get undoDepth() { return this.#undo.length; }
  get redoDepth() { return this.#redo.length; }

  #capture(document, selection, baselineRevision) {
    if (!document || typeof document !== 'object') {
      throw new Error('历史记录需要完整的工程文档');
    }
    if (!Number.isInteger(baselineRevision) || baselineRevision < 0) {
      throw new Error('历史记录缺少有效的基线 revision');
    }
    const ids = [...selection].map(id => String(id));
    if (new Set(ids).size !== ids.length) {
      throw new Error('历史记录中的选中状态存在重复标识');
    }
    return {
      document: structuredClone(document),
      selection: ids,
      baselineRevision,
      chainId: this.#chainId,
    };
  }

  // Record the state being left behind, immediately before a local edit is
  // applied to the live document. Starting a new edit clears the redo branch.
  push(document, selection, baselineRevision) {
    this.#undo.push(this.#capture(document, selection, baselineRevision));
    if (this.#undo.length > this.#limit) this.#undo.shift();
    this.#redo.length = 0;
    return this.#undo.length;
  }

  #guard(entry, baselineRevision) {
    if (entry.chainId !== this.#chainId) {
      throw new StaleBaselineError(
        '该历史记录属于已被远端替换的旧工程基线，禁止覆盖当前工程',
        entry.baselineRevision, baselineRevision, true);
    }
    if (entry.baselineRevision > baselineRevision) {
      throw new StaleBaselineError(
        '该历史记录基于更新的工程基线，不能回放到当前工程',
        entry.baselineRevision, baselineRevision, false);
    }
  }

  // Move one step back. Returns the document/selection pair to check out;
  // the caller applies it to the live scene. Throws StaleBaselineError
  // without mutating any stack when the entry is no longer playable.
  undo(currentDocument, currentSelection, baselineRevision) {
    const entry = this.#undo[this.#undo.length - 1];
    if (!entry) throw new Error('没有可撤销的编辑');
    this.#guard(entry, baselineRevision);
    this.#redo.push(this.#capture(currentDocument, currentSelection, baselineRevision));
    this.#undo.pop();
    return { document: structuredClone(entry.document), selection: [...entry.selection] };
  }

  // Move one step forward, mirroring undo() exactly.
  redo(currentDocument, currentSelection, baselineRevision) {
    const entry = this.#redo[this.#redo.length - 1];
    if (!entry) throw new Error('没有可重做的编辑');
    this.#guard(entry, baselineRevision);
    this.#undo.push(this.#capture(currentDocument, currentSelection, baselineRevision));
    this.#redo.pop();
    return { document: structuredClone(entry.document), selection: [...entry.selection] };
  }

  // Adopt a document whose baseline moved on the server (MCP write, another
  // client, or an explicit "load remote" action). Old snapshots can never be
  // restored over the new baseline, so both stacks are dropped and the chain
  // id advances. Editing can continue on the returned chain immediately.
  adoptBaseline() {
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#chainId += 1;
    return this.#chainId;
  }

  // Diagnostic/test hook: reconstruct an entry exactly as push() would store
  // it, but on an explicit chain and baseline. Production code never calls
  // this; it exists so the stale-baseline guard can be verified without
  // reaching into private state.
  importEntryForVerification(document, selection, baselineRevision, chainId) {
    const entry = this.#capture(document, selection, baselineRevision);
    entry.chainId = chainId;
    this.#undo.push(entry);
    return entry;
  }

  // Structural verification of the whole chain; used by tests and diagnostics.
  describe(baselineRevision) {
    const entries = [...this.#undo, ...this.#redo];
    return {
      chainId: this.#chainId,
      baselineRevision,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
      undoBaselines: this.#undo.map(entry => entry.baselineRevision),
      redoBaselines: this.#redo.map(entry => entry.baselineRevision),
      intact: entries.every(entry =>
        entry.document && typeof entry.document === 'object' &&
        Array.isArray(entry.selection) &&
        Number.isInteger(entry.baselineRevision) &&
        entry.chainId === this.#chainId),
    };
  }
}
