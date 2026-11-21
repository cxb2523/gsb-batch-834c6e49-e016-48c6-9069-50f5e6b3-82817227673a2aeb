/**
 * Single source of truth for "the current track".
 *
 * Everything that renders the track info, the playlist highlight or the
 * scroll position reads from this store. The store is deliberately free of
 * DOM and jPlayer references so it can be exercised in isolation.
 *
 * Two indices matter:
 * - `currentIndex`  the selection jPlayer (or a manual action) last made.
 * - `lastGoodIndex` the last selection confirmed as playable (jPlayer's play
 *   or ready callback). It is only advanced by confirmed playback, so a failed
 *   selection never destroys the last track whose info is still valid.
 */
export class PlayerStore {
  constructor({ loop = true, tracks = [] } = {}) {
    this.loop = Boolean(loop);
    this.tracks = Array.isArray(tracks) ? [...tracks] : [];
    this.currentIndex = 0;
    this.lastGoodIndex = null;
    this.revision = 0;
    this.error = null;
    this.listeners = new Set();
  }

  get length() {
    return this.tracks.length;
  }

  get currentTrack() {
    return this.trackAt(this.currentIndex);
  }

  hasIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < this.tracks.length;
  }

  trackAt(index) {
    return this.hasIndex(index) ? this.tracks[index] : null;
  }

  setTracks(tracks) {
    this.tracks = Array.isArray(tracks) ? [...tracks] : [];
    this.currentIndex = 0;
    this.lastGoodIndex = null;
    this.error = null;
    this.revision += 1;
    this.notify("tracks");
  }

  /**
   * Records a new current index coming from jPlayer (setmedia / select / play
   * / ended) or from a manual track change. Returns true when state changed.
   */
  commitIndex(index, { source = "player" } = {}) {
    if (!this.hasIndex(index)) {
      return false;
    }

    if (index === this.currentIndex && !this.error) {
      return false;
    }

    this.currentIndex = index;
    this.error = null;
    this.revision += 1;
    this.notify("commit", { index, source });
    return true;
  }

  /**
   * Confirms the current selection is actually playable. Called from jPlayer's
   * play / ready callbacks. Mirrors the current index into `lastGoodIndex`.
   */
  markPlayable() {
    if (!this.hasIndex(this.currentIndex)) {
      return false;
    }

    this.lastGoodIndex = this.currentIndex;
    return true;
  }

  /**
   * Records a load failure for the current track while keeping the last
   * valid track available for rendering.
   */
  fail({ message = "Unable to play this track.", type = "error" } = {}) {
    if (!this.tracks.length) {
      return false;
    }

    if (this.error && this.error.index === this.currentIndex) {
      return false;
    }

    this.revision += 1;
    this.error = {
      index: this.hasIndex(this.currentIndex) ? this.currentIndex : -1,
      message,
      revision: this.revision,
      type,
    };
    this.notify("error");
    return true;
  }

  clearError() {
    if (!this.error) {
      return false;
    }

    this.error = null;
    this.revision += 1;
    this.notify("clear-error");
    return true;
  }

  step(delta) {
    const total = this.tracks.length;

    if (!total) {
      return null;
    }

    const base = this.hasIndex(this.currentIndex) ? this.currentIndex : 0;
    const raw = base + delta;

    if (raw >= 0 && raw < total) {
      return raw;
    }

    return this.loop ? ((raw % total) + total) % total : null;
  }

  nextIndex() {
    return this.step(1);
  }

  previousIndex() {
    return this.step(-1);
  }

  /** Index whose info should be shown, or -1 when there is nothing to show. */
  resolveVisibleIndex() {
    if (!this.tracks.length) {
      return -1;
    }

    if (this.error) {
      // Keep the last confirmed-playable track on screen. Only on a first-load
      // failure (nothing playable yet) do we show the failed track itself.
      if (this.hasIndex(this.lastGoodIndex) && this.lastGoodIndex !== this.error.index) {
        return this.lastGoodIndex;
      }
      return this.hasIndex(this.currentIndex) ? this.currentIndex : -1;
    }

    return this.hasIndex(this.currentIndex) ? this.currentIndex : -1;
  }

  /**
   * The view model every consumer renders from. `highlightIndex` is always a
   * real index or -1, so the playlist highlight can never point at a row that
   * does not exist.
   */
  getView() {
    const visibleIndex = this.resolveVisibleIndex();

    return {
      currentIndex: this.currentIndex,
      error: this.error,
      highlightIndex: visibleIndex,
      index: visibleIndex,
      isFallback: Boolean(this.error) && visibleIndex !== this.currentIndex,
      revision: this.revision,
      track: this.trackAt(visibleIndex),
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => null;
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(type, detail = {}) {
    const view = this.getView();

    for (const listener of this.listeners) {
      try {
        listener(view, { detail, type });
      } catch (error) {
        console.error(error);
      }
    }
  }
}

export default PlayerStore;
