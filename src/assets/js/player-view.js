import { computeScrollTop } from "./scroll.js";

export const DISPLAY_MODES = ["hide", "bottom", "scroll", "side"];

export const CURRENT_CLASS = "jp-playlist-current";
export const FAILED_CLASS = "jp-playlist-failed";
export const ITEM_CLASS = "jp-playlist-item";
export const NOTICE_CLASS = "player-notice";

const isDocumentTarget = (container) =>
  typeof document !== "undefined" &&
  (container === document.scrollingElement ||
    container === document.documentElement ||
    container === document.body);

/**
 * Default layout measurement. Reads live geometry from the DOM; the pure
 * scroll maths lives in scroll.js so it can be tested without a layout engine.
 */
export const measureElement = (container, item) => {
  const documentTarget = isDocumentTarget(container);
  const scrollTop = documentTarget
    ? (typeof window !== "undefined" && window.scrollY) || container.scrollTop || 0
    : container.scrollTop || 0;
  const viewportHeight = documentTarget
    ? (typeof window !== "undefined" && window.innerHeight) || container.clientHeight || 0
    : container.clientHeight || 0;
  const containerRect = container.getBoundingClientRect?.() ?? { top: 0 };
  const itemRect = item.getBoundingClientRect?.() ?? { height: 0, top: 0 };

  return {
    itemHeight: itemRect.height || item.offsetHeight || 0,
    itemTop: (itemRect.top || 0) - (containerRect.top || 0) + scrollTop,
    scrollTop,
    viewportHeight,
  };
};

const setScrollTop = (container, top) => {
  if (isDocumentTarget(container)) {
    try {
      window.scrollTo(0, top);
      return;
    } catch {
      // jsdom and some embedded browsers do not implement scrollTo.
    }
  }

  container.scrollTop = top;
};

/**
 * Renders the track info, playlist highlight, error notice and scroll
 * position from a single store view. Every consumer reads the same snapshot,
 * so the four chains cannot disagree with each other.
 */
export class PlaylistView {
  constructor({ measure = measureElement, scrollPadding = 0 } = {}) {
    this.elements = {};
    this.store = null;
    this.displayMode = "hide";
    this.measure = measure;
    this.scrollPadding = scrollPadding;
    this.notice = null;
    this.playlistEl = null;
    this.listEl = null;
    this.unsubscribe = null;
    this.observer = null;
  }

  init({ elements = {}, store, initialDisplay } = {}) {
    this.elements = elements;
    this.store = store;
    this.notice =
      elements.notice ||
      (typeof document === "undefined" ? null : document.querySelector(`.${NOTICE_CLASS}`));

    const playerRoot =
      elements.player ||
      (typeof document === "undefined" ? null : document.querySelector(".audio-player"));
    this.playlistEl = elements.playlist || playerRoot?.querySelector?.(".jp-playlist") || null;
    this.listEl = this.playlistEl?.querySelector?.("ul") || null;

    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribe = this.store ? this.store.subscribe((view) => this.render(view)) : null;

    this.observePlaylist();

    const mode =
      typeof initialDisplay === "string"
        ? initialDisplay
        : PlaylistView.detectDisplayMode(playerRoot);

    this.setDisplayMode(mode);

    if (this.store) {
      this.render(this.store.getView());
    }
  }

  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.disconnectObserver();
  }

  /**
   * The jPlayer playlist add-on rebuilds its <li> items asynchronously (it
   * slides the <ul> up, empties it, appends items and slides back down). Any
   * rebuild drops our highlight class, so re-assert after child changes.
   */
  observePlaylist() {
    this.disconnectObserver();

    if (!this.listEl || typeof MutationObserver === "undefined") {
      return;
    }

    this.observer = new MutationObserver(() => this.reassert());
    this.observer.observe(this.listEl, { childList: true });
  }

  disconnectObserver() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  static detectDisplayMode(root) {
    if (!root) {
      return "hide";
    }

    for (const mode of DISPLAY_MODES) {
      if (root.classList.contains(`playlist-${mode}`)) {
        return mode;
      }
    }

    return "hide";
  }

  getDisplayMode() {
    return this.displayMode;
  }

  /**
   * Switches presentation only. Playback, the store and the highlight are all
   * untouched; afterwards the current track is brought back into view for the
   * new layout.
   */
  setDisplayMode(mode) {
    const next = DISPLAY_MODES.includes(mode) ? mode : "hide";
    const root = this.elements.player;
    const changed = next !== this.displayMode;

    this.displayMode = next;

    if (root) {
      for (const candidate of DISPLAY_MODES) {
        root.classList.remove(`playlist-${candidate}`);
      }
      root.classList.add(`playlist-${next}`);
    }

    this.reassert();
    return changed;
  }

  /** Re-applies highlight + visibility for the current store state. */
  reassert() {
    if (!this.store) {
      return;
    }

    const view = this.store.getView();
    this.renderHighlight(view);
    this.ensureVisible(view.highlightIndex);
  }

  render(view) {
    if (!view) {
      return;
    }

    this.renderTrackInfo(view.track);
    this.renderHighlight(view);
    this.renderNotice(view.error);
    this.ensureVisible(view.highlightIndex);
  }

  renderTrackInfo(track) {
    const { artist, poster, record, title } = this.elements;

    if (title) {
      title.textContent = track?.title ?? "";
    }
    if (artist) {
      artist.textContent = track?.artist ?? "";
    }
    if (record) {
      record.textContent = track?.record ?? "";
    }

    if (poster && track?.poster) {
      poster.setAttribute("src", track.poster);
      poster.setAttribute(
        "alt",
        track.artist ? `${track.artist} - ${track.title}` : (track.title ?? "Track poster"),
      );
    }
  }

  renderHighlight(view) {
    const items = this.getItems();

    for (const item of items) {
      item.classList.remove(CURRENT_CLASS, FAILED_CLASS);

      for (const link of item.querySelectorAll(`.${ITEM_CLASS}`)) {
        link.classList.remove(CURRENT_CLASS);
      }
    }

    const highlightIndex = view?.highlightIndex ?? -1;

    if (Number.isInteger(highlightIndex) && highlightIndex >= 0 && items[highlightIndex]) {
      items[highlightIndex].classList.add(CURRENT_CLASS);
      const link = items[highlightIndex].querySelector(`.${ITEM_CLASS}`);

      if (link) {
        link.classList.add(CURRENT_CLASS);
      }
    }

    const failedIndex = view?.error?.index;

    if (Number.isInteger(failedIndex) && failedIndex >= 0 && items[failedIndex]) {
      items[failedIndex].classList.add(FAILED_CLASS);
    }
  }

  renderNotice(error) {
    if (!this.notice) {
      return;
    }

    if (error) {
      this.notice.textContent = error.message ?? "Unable to play this track.";
      this.notice.hidden = false;
      this.notice.classList.add("is-visible");
    } else {
      this.notice.textContent = "";
      this.notice.hidden = true;
      this.notice.classList.remove("is-visible");
    }
  }

  /**
   * Only real playlist rows count: the add-on renders each row with a
   * `.jp-playlist-item` link. The placeholder `<li>` in index.html and any
   * in-flight duplicates are ignored, so an index can never highlight a
   * non-track row.
   */
  getItems() {
    if (!this.listEl) {
      return [];
    }

    return [...this.listEl.children].filter(
      (child) => child.tagName === "LI" && child.querySelector(`.${ITEM_CLASS}`),
    );
  }

  /**
   * The element that scrolls for the active display mode, or null when the
   * playlist is not visible. In "hide" mode the list is clipped outside the
   * scroll area, so scrolling would shift the interface instead; it is
   * deliberately skipped.
   *
   * - bottom: the list grows in normal flow, so the page scrolls.
   * - scroll: `.jp-audio` is the overflow-auto pane (see playlist-display.css).
   * - side:   the playlist column itself is overflow-auto.
   */
  getScrollContainer() {
    if (this.displayMode === "hide") {
      return null;
    }

    if (this.displayMode === "side") {
      return this.playlistEl;
    }

    if (this.displayMode === "scroll") {
      return this.elements.jpAudio;
    }

    return typeof document === "undefined"
      ? null
      : document.scrollingElement || document.documentElement;
  }

  ensureVisible(index) {
    if (!Number.isInteger(index) || index < 0) {
      return;
    }

    const items = this.getItems();
    const item = items[index];

    if (!item) {
      return;
    }

    const container = this.getScrollContainer();

    if (!container) {
      return;
    }

    const metrics = this.measure(container, item);

    if (!metrics) {
      return;
    }

    const next = computeScrollTop({
      itemHeight: metrics.itemHeight,
      itemTop: metrics.itemTop,
      padding: this.scrollPadding,
      scrollTop: metrics.scrollTop,
      viewportHeight: metrics.viewportHeight,
    });

    if (next !== metrics.scrollTop) {
      setScrollTop(container, next);
    }
  }
}

export const playlistView = new PlaylistView();

export default playlistView;
