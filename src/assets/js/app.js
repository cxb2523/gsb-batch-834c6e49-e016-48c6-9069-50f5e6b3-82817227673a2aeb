import playlistView, { DISPLAY_MODES } from "./player-view.js";
import posterFallback from "../media/poster-audiotheme.jpg";

/**
 * Thin UI shell: touch detection, playlist-display toggles and a small state
 * probe. Track info / highlight / scrolling all live in PlaylistView driven by
 * PlayerStore; display switching delegates there so it never resets playback or
 * loses the highlight.
 */
class AudioPlayerApp {
  isInitialized = false;

  constructor({ view = playlistView } = {}) {
    this.view = view;
    this.elements = {
      jpAudio: null,
      player: null,
      posterImg: null,
      toggles: null,
    };
  }

  init() {
    AudioPlayerApp.setupTouchDetection();

    this.setupElements();
    this.setInitialPoster();
    this.setupPlaylistDisplay();
    this.isInitialized = true;
  }

  static setupTouchDetection() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const isTouchDevice = "ontouchstart" in window || "onmsgesturechange" in window;
    document.body.classList.add(isTouchDevice ? "touch" : "no-touch");
  }

  setupElements() {
    if (typeof document === "undefined") {
      return;
    }

    this.elements = {
      jpAudio: document.querySelector(".jp-audio"),
      player: document.querySelector(".audio-player"),
      posterImg: document.querySelector("#track-poster-img"),
      toggles: document.querySelectorAll(".playlist-toggles button"),
    };
  }

  setInitialPoster() {
    if (this.elements.posterImg && !this.elements.posterImg.getAttribute("src")) {
      // Placeholder until the first track commits its own poster. The store
      // immediately overwrites this on init, so it only shows pre-hydration.
      this.elements.posterImg.src = posterFallback;
      this.elements.posterImg.alt = "Track poster";
    }
  }

  setupPlaylistDisplay() {
    if (!this.elements.player || !this.elements.toggles?.length) {
      return;
    }

    for (const toggle of this.elements.toggles) {
      toggle.addEventListener("click", this.handlePlaylistToggle.bind(this), false);
    }

    this.syncToggleState(this.view.getDisplayMode());
  }

  static resolveToggle(event, toggles) {
    const target = event?.currentTarget ?? event?.target;

    if (target?.dataset?.display) {
      return target;
    }

    if (typeof target?.closest === "function") {
      return target.closest("[data-display]");
    }

    return [...toggles].find((toggle) => toggle === target) ?? null;
  }

  handlePlaylistToggle(event) {
    const toggles = this.elements.toggles ?? [];
    const selectedToggle = AudioPlayerApp.resolveToggle(event, toggles);

    if (!selectedToggle) {
      return;
    }

    const newDisplay = selectedToggle.dataset.display;

    if (!DISPLAY_MODES.includes(newDisplay)) {
      return;
    }

    // Presentation only: playback, current track and highlight are preserved;
    // the view then re-scrolls the current track into view for the new layout.
    this.view.setDisplayMode(newDisplay);
    this.syncToggleState(newDisplay);
  }

  syncToggleState(activeDisplay) {
    for (const toggle of this.elements.toggles ?? []) {
      const isActive = toggle.dataset.display === activeDisplay;
      toggle.classList.toggle("selected", isActive);
      toggle.setAttribute("aria-pressed", String(isActive));
    }
  }

  getState() {
    const elements = {};
    for (const key of Object.keys(this.elements)) {
      elements[key] =
        this.elements[key] !== null &&
        (typeof this.elements[key].length !== "number" || this.elements[key].length > 0);
    }
    return { displayMode: this.view.getDisplayMode(), elements, isInitialized: this.isInitialized };
  }
}

const app = new AudioPlayerApp();

export { AudioPlayerApp };
export default app;
