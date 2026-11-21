/**
 * A local, deterministic stand-in for the jPlayer playlist add-on.
 *
 * It reproduces the parts of the real add-on's behaviour that the app relies
 * on, without needing jQuery, the real jPlayer or network audio:
 *
 * - `current` is the authoritative selected index.
 * - `select(index)` sets `current` and fires `setmedia`.
 * - `play(index)` selects then fires the `play` callback.
 * - `next()`/`previous()` wrap around and fire `ended`, like jPlayer does.
 * - `failCurrent()` fires an `error` callback carrying the failing URL.
 * - `failOnLoad` (option) makes `select()` asynchronously fail, as a real 404
 *   would surface shortly after the media URL is set.
 *
 * Shared by the unit/integration tests and the browser harness in
 * `dev-harness.html`, so both exercise the exact same fake behaviour.
 */

/** Renders one playlist row as the add-on would. */
const renderTrack = (track) => {
  const artist = track.artist ? ` <span class="jp-artist">by ${track.artist}</span>` : "";

  return `<li><div><a href="javascript:;" class="jp-playlist-item">${track.title}${artist}</a></div></li>`;
};

export class FakePlaylist {
  constructor(cssSelector, playlist, options = {}) {
    this.cssSelector = cssSelector;
    this.original = playlist.map((track) => ({ ...track }));
    this.playlist = playlist.map((track) => ({ ...track }));
    this.options = { ...options };
    this.current = 0;
    this.removed = false;
    this._failTimer = null;

    this.listEl = document.querySelector(`${cssSelector.cssSelectorAncestor} .jp-playlist ul`);

    this.render();
    this.options.ready?.({ jPlayer: { status: {} } });
  }

  destroy() {
    clearTimeout(this._failTimer);
  }

  render() {
    if (!this.listEl) {
      return;
    }

    this.listEl.innerHTML = this.playlist.map(renderTrack).join("");
  }

  get rows() {
    return this.listEl ? [...this.listEl.children] : [];
  }

  _setCurrent(index) {
    const { rows } = this;

    for (const row of rows) {
      row.classList.remove("jp-playlist-current");
      row.querySelector(".jp-playlist-item")?.classList.remove("jp-playlist-current");
    }

    const row = rows[index];

    if (row) {
      row.classList.add("jp-playlist-current");
      row.querySelector(".jp-playlist-item")?.classList.add("jp-playlist-current");
    }
  }

  _event(index = this.current) {
    const track = this.playlist[index];

    return {
      jPlayer: {
        error: undefined,
        status: { media: track, paused: false, src: track?.mp3 },
      },
    };
  }

  /** Schedules an async error for the selected track when configured to fail. */
  _scheduleFailure(index) {
    clearTimeout(this._failTimer);

    if (!this.willFail(index)) {
      return;
    }

    this._failTimer = setTimeout(() => {
      if (this.current === index) {
        this.failCurrent("e_url", index);
      }
    }, this.options.failDelay ?? 30);
  }

  select(index) {
    if (index < 0 || index >= this.playlist.length) {
      this.current = 0;
      return;
    }

    this.current = index;
    this._setCurrent(index);
    this.options.setmedia?.(this._event(index));
    this._scheduleFailure(index);
  }

  /** True when the fake is configured to fail loading this track. */
  willFail(index = this.current) {
    return Boolean(
      typeof this.options.failOnLoad === "function" &&
      this.options.failOnLoad(this.playlist[index], index),
    );
  }

  play(index) {
    if (typeof index === "number") {
      if (index < 0 || index >= this.playlist.length) {
        return false;
      }
      this.select(index);
    }

    // A real 404 fires `error`, never `play`: playback only starts once the
    // media has actually loaded. Mirror that here so `play` means "proven
    // playable".
    if (!this.willFail(this.current)) {
      this.options.play?.(this._event(this.current));
    }

    return true;
  }

  pause() {
    this.paused = true;
    return true;
  }

  next() {
    const index = this.current + 1 < this.playlist.length ? this.current + 1 : 0;
    this.play(index);
    return index;
  }

  previous() {
    const index = this.current - 1 >= 0 ? this.current - 1 : this.playlist.length - 1;
    this.play(index);
    return index;
  }

  /** Simulates the media load failing for `index` (defaults to current). */
  failCurrent(errorType = "e_url", index = this.current) {
    const track = this.playlist[index];

    this.options.error?.({
      jPlayer: {
        error: {
          context: track?.mp3,
          message: "Media URL could not be loaded.",
          type: errorType,
        },
        status: { media: track, paused: true, src: track?.mp3 },
      },
    });
  }

  /** Fires a late `play` callback for a track index that is no longer current. */
  emitStalePlay(index) {
    this.options.play?.(this._event(index));
  }

  /** Rebuilds the DOM like the add-on's async `_refresh`, dropping classes. */
  refresh() {
    this.render();
    this._setCurrent(this.current);
  }

  refreshWithoutHighlight() {
    this.render();
  }
}

/** Installs the fake as the global `jPlayerPlaylist` and returns a cleanup. */
export const installFakeJPlayer = () => {
  const previous = globalThis.jPlayerPlaylist;

  globalThis.jPlayerPlaylist = FakePlaylist;

  return {
    PlaylistClass: FakePlaylist,
    restore() {
      if (previous === undefined) {
        delete globalThis.jPlayerPlaylist;
      } else {
        globalThis.jPlayerPlaylist = previous;
      }
    },
  };
};
