import playlist from "./playlist.js";
import swfFile from "../media/jquery.jplayer.swf?url";
import { PlayerStore } from "./player-store.js";
import playlistView from "./player-view.js";

export const FALLBACK_MESSAGE = "This track could not be loaded. Still showing the previous track.";

/** Last path segment of a media URL, ignoring any query/hash suffix. */
const mediaBasename = (value) => String(value).split(/[?#]/u)[0].split("/").pop();

/**
 * Bridges jPlayer callbacks to the PlayerStore and the PlaylistView.
 *
 * Three rules keep the four chains consistent:
 *
 * 1. One source of truth. jPlayer's playlist object owns *which* track is
 *    current. Every callback reads `jPlaylist.current` at callback time rather
 *    than trusting a payload, so a delayed callback can never paint a track
 *    that is no longer selected.
 * 2. One render. The store hands the view a single snapshot containing track
 *    info, highlight index, error and scroll target; the view applies them in
 *    one pass. Info, highlight and scroll cannot disagree.
 * 3. Stale callbacks lose. A late `play` or `error` whose media URL no longer
 *    matches the selected track is ignored, so out-of-order async work can
 *    never overwrite the newest track's info.
 */
class JPlayerManager {
  jPlaylist = null;
  isInitialized = false;

  constructor({ playlistData = playlist, store, view } = {}) {
    this.store = store ?? new PlayerStore({ loop: true, tracks: playlistData });
    this.view = view ?? playlistView;
    this.elements = {};
  }

  init() {
    this.setupElements();
    this.setupPlayer();
    this.isInitialized = true;
  }

  setupElements(doc = typeof document === "undefined" ? null : document) {
    if (!doc) {
      this.elements = {};
      return;
    }

    this.elements = {
      artist: doc.querySelector(".track-artist"),
      jpAudio: doc.querySelector(".jp-audio"),
      notice: doc.querySelector(".player-notice"),
      player: doc.querySelector(".audio-player"),
      playlist: doc.querySelector(".jp-playlist"),
      poster: doc.querySelector(".track-poster img"),
      record: doc.querySelector(".track-record"),
      title: doc.querySelector(".track-title"),
    };
  }

  setupPlayer() {
    if (typeof jPlayerPlaylist === "undefined") {
      return;
    }

    this.jPlaylist = new jPlayerPlaylist(
      {
        cssSelectorAncestor: "#jplayer-container-1",
        jPlayer: "#jplayer-1",
      },
      this.store.tracks,
      {
        autoBlur: false,
        ended: () => this.handleEnded(),
        error: (event) => this.handlePlayerError(event),
        keyEnabled: true,
        play: (event) => this.handlePlay(event),
        ready: () => this.handleReady(),
        setmedia: () => this.handleSetMedia(),
        supplied: "mp3",
        swfPath: JPlayerManager.getSwfPath(),
        useStateClassSkin: true,
        wmode: "window",
      },
    );

    this.attachView();
  }

  /**
   * Attaches the view to this manager's playlist instance. Exposed so tests
   * (and any re-initialisation) can rebind without owning a real jPlayer.
   */
  attachView() {
    this.view.init({
      elements: {
        artist: this.elements.artist,
        jpAudio: this.elements.jpAudio,
        notice: this.elements.notice,
        player: this.elements.player,
        playlist: this.elements.playlist,
        poster: this.elements.poster,
        record: this.elements.record,
        title: this.elements.title,
      },
      store: this.store,
    });

    if (this.store.length) {
      this.store.notify("init");
    }
  }

  static getSwfPath() {
    return swfFile.replace(/\/[^/]*$/u, "");
  }

  isPlaylistReady() {
    return Boolean(this.jPlaylist && Array.isArray(this.jPlaylist.playlist));
  }

  /** jPlayer's authoritative current index, or null when unavailable. */
  readPlayerIndex() {
    if (!this.isPlaylistReady()) {
      return null;
    }

    const index = this.jPlaylist.current;

    return Number.isInteger(index) ? index : null;
  }

  /**
   * Commits an index to the store (which re-renders via the view) and marks it
   * playable when jPlayer has confirmed the media. Out-of-range indices are
   * ignored so the highlight can never point at a playlist row that does not
   * exist.
   */
  commit(index, { source, playable = false } = {}) {
    if (!this.store.hasIndex(index)) {
      return false;
    }

    const changed = this.store.commitIndex(index, { source });

    if (playable) {
      this.store.markPlayable();
    }

    if (!changed) {
      // Same selection: re-assert highlight + scroll because the playlist
      // add-on may have rebuilt its <li> items and dropped our classes.
      this.view.reassert();
    }

    return changed;
  }

  /** Commits whatever jPlayer currently considers the selected track. */
  syncFromPlayer({ source, playable = false } = {}) {
    const index = this.readPlayerIndex();

    if (index === null) {
      return false;
    }

    return this.commit(index, { playable, source });
  }

  handleReady() {
    this.syncFromPlayer({ playable: true, source: "ready" });
  }

  handleSetMedia() {
    // setMedia is emitted synchronously from select()/play() after jPlayer's
    // playlist updated `current`; it is the earliest reliable change signal.
    this.syncFromPlayer({ source: "setmedia" });
  }

  handlePlay(event) {
    const src = event?.jPlayer?.status?.src;

    // A play event can arrive after the user already skipped on. Only accept
    // it when its media still matches the selected track.
    if (!this.matchesSelectedTrack(src)) {
      return false;
    }

    return this.syncFromPlayer({ playable: true, source: "play" });
  }

  handleEnded() {
    // The playlist add-on binds its ended handler before jPlayer's option
    // handlers, so `current` already points at the next track here.
    this.syncFromPlayer({ source: "ended" });
  }

  /** True when `url` (if provided) is the media of the selected track. */
  matchesSelectedTrack(url) {
    if (typeof url !== "string" || !url) {
      return true;
    }

    const selected = this.store.currentTrack;

    if (typeof selected?.mp3 !== "string" || !selected.mp3) {
      return true;
    }

    return JPlayerManager.sameMedia(url, selected.mp3);
  }

  static sameMedia(a, b) {
    if (a === b) {
      return true;
    }

    const baseA = mediaBasename(a);

    return Boolean(baseA) && baseA === mediaBasename(b);
  }

  /**
   * True when the failing media URL no longer matches the selected track,
   * i.e. the user already skipped to another track before the error arrived.
   */
  isStaleError(event) {
    const context = event?.jPlayer?.error?.context;

    if (typeof context !== "string" || !context) {
      return false;
    }

    // Non-URL contexts such as "{supplied:'mp3'}" describe the whole player,
    // never one track, so they are never stale.
    if (!/^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(context) && !context.startsWith("/")) {
      return false;
    }

    return !this.matchesSelectedTrack(context);
  }

  handlePlayerError(event) {
    console.error(event);

    if (!this.store.length || this.isStaleError(event)) {
      return false;
    }

    return this.store.fail({
      message: JPlayerManager.describeError(event) ?? FALLBACK_MESSAGE,
      type: event?.jPlayer?.error?.type ?? "error",
    });
  }

  static describeError(event) {
    const error = event?.jPlayer?.error;

    if (!error) {
      return null;
    }

    if (error.type === "e_url" || error.type === "e_url_not_set") {
      return FALLBACK_MESSAGE;
    }

    return error.message ? `Playback error: ${error.message}` : null;
  }

  /**
   * Manual track change used by next/previous controls and list clicks.
   * Commits first so the UI reflects the selection immediately, then lets the
   * playlist's select()/setMedia() callbacks confirm it.
   */
  playIndex(index) {
    if (!this.isPlaylistReady() || !this.store.hasIndex(index)) {
      return false;
    }

    this.commit(index, { source: "manual" });
    this.jPlaylist.play(index);
    return true;
  }

  playNext() {
    const index = this.store.nextIndex();

    return index === null ? false : this.playIndex(index);
  }

  playPrevious() {
    const index = this.store.previousIndex();

    return index === null ? false : this.playIndex(index);
  }

  getPlaylistState() {
    if (!this.jPlaylist) {
      return { isInitialized: false };
    }

    return {
      currentTrack: this.jPlaylist.current,
      currentTrackData: this.jPlaylist.playlist[this.jPlaylist.current] || null,
      isInitialized: this.isInitialized,
      totalTracks: this.jPlaylist.playlist.length,
    };
  }

  getJPlaylist() {
    return this.jPlaylist;
  }

  getStore() {
    return this.store;
  }
}

const jPlayerManager = new JPlayerManager();

export { JPlayerManager };
export default jPlayerManager;
