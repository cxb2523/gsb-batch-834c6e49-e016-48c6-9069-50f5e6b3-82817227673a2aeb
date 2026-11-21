import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JPlayerManager } from "../src/assets/js/jplayer.js";
import { PlayerStore } from "../src/assets/js/player-store.js";
import { PlaylistView } from "../src/assets/js/player-view.js";
import { createFixture, demoPlaylist, installStackLayout } from "./helpers/fixture.js";
import { installFakeJPlayer } from "../src/assets/js/dev/fake-jplayer.js";

/**
 * End-to-end wiring of the four chains (callbacks -> info -> highlight/scroll
 * -> display mode) against a deterministic fake jPlayer playlist.
 */
const boot = ({ display = "bottom", tracks = demoPlaylist } = {}) => {
  const elements = createFixture({ display });
  const store = new PlayerStore({ tracks });
  const view = new PlaylistView();
  const manager = new JPlayerManager({ playlistData: tracks, store, view });

  manager.elements = elements;
  // Constructs the fake playlist and wires the view.
  manager.setupPlayer();

  const layout = installStackLayout({ container: elements.playlist });

  return {
    elements,
    layout,
    manager,
    playlist: elements.playlist,
    store,
    view,
  };
};

const highlighted = (playlistEl) => {
  const current = playlistEl.querySelector("li.jp-playlist-current");
  if (!current) {
    return -1;
  }
  return [...playlistEl.querySelectorAll("li")].indexOf(current);
};

const noticeText = (elements) =>
  elements.notice && !elements.notice.hidden ? elements.notice.textContent : "";

describe("jPlayer integration", () => {
  let fake;
  let ctx;

  beforeEach(() => {
    fake = installFakeJPlayer();
  });

  afterEach(() => {
    fake?.restore();
    ctx?.layout?.restore();
    ctx = null;
  });

  describe("normal track changes", () => {
    beforeEach(() => {
      ctx = boot();
    });

    it("keeps info, highlight and scroll in sync on play", () => {
      ctx.manager.getJPlaylist().play(2);

      expect(ctx.elements.title.textContent).toBe("Soft interface ping");
      expect(ctx.elements.artist.textContent).toBe("Mixkit");
      expect(ctx.elements.poster.getAttribute("src")).toBe("poster-c.jpg");
      expect(highlighted(ctx.playlist)).toBe(2);
      expect(ctx.store.getView().error).toBeNull();
    });

    it("follows ended -> next track through the store", () => {
      ctx.manager.getJPlaylist().play(0);
      // next() fires setmedia then play for track 1.
      ctx.manager.getJPlaylist().next();

      expect(ctx.elements.title.textContent).toBe("Arcade bonus alert");
      expect(highlighted(ctx.playlist)).toBe(1);
    });

    it("wraps from the last track to the first on next without throwing", () => {
      ctx.manager.getJPlaylist().play(3);
      expect(() => ctx.manager.playNext()).not.toThrow();

      expect(ctx.elements.title.textContent).toBe("T-Rex Roar");
      expect(highlighted(ctx.playlist)).toBe(0);
    });

    it("wraps from the first track back to the last on previous", () => {
      ctx.manager.getJPlaylist().play(0);
      ctx.manager.playPrevious();

      expect(ctx.elements.title.textContent).toBe("Game reward sting");
      expect(highlighted(ctx.playlist)).toBe(3);
    });

    it("ignores an out-of-range manual index instead of highlighting a missing row", () => {
      expect(ctx.manager.playIndex(99)).toBe(false);
      expect(highlighted(ctx.playlist)).toBe(0);
    });
  });

  describe("rapid consecutive changes", () => {
    beforeEach(() => {
      ctx = boot();
    });

    it("only the last of several quick nexts wins", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(0);

      // Three quick next clicks in one tick.
      ctx.manager.playNext();
      ctx.manager.playNext();
      ctx.manager.playNext();

      expect(ctx.elements.title.textContent).toBe("Game reward sting");
      expect(highlighted(ctx.playlist)).toBe(3);
    });

    it("a late play callback for a superseded track cannot overwrite the new info", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(1);
      expect(ctx.elements.title.textContent).toBe("Arcade bonus alert");

      // User skips to track 3; then track 1's delayed play callback lands.
      playlist.play(3);
      playlist.emitStalePlay(1);

      expect(ctx.elements.title.textContent).toBe("Game reward sting");
      expect(highlighted(ctx.playlist)).toBe(3);
    });

    it("a late error for a superseded URL is ignored, not shown on the new track", () => {
      const playlist = ctx.manager.getJPlaylist();
      // Start on "Arcade bonus alert".
      playlist.play(1);

      // User skips to track 3, then track 1's error arrives late.
      playlist.play(3);
      ctx.manager.handlePlayerError({
        jPlayer: {
          error: {
            context: demoPlaylist[1].mp3,
            message: "Media URL could not be loaded.",
            type: "e_url",
          },
        },
      });

      expect(ctx.elements.title.textContent).toBe("Game reward sting");
      expect(highlighted(ctx.playlist)).toBe(3);
      expect(ctx.store.getView().error).toBeNull();
      expect(noticeText(ctx.elements)).toBe("");
    });
  });

  describe("switching display mode while playing", () => {
    beforeEach(() => {
      ctx = boot({ display: "bottom" });
    });

    it("preserves current track, highlight and playing state across modes", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(2);

      const title = ctx.elements.title.textContent;
      const pausedBefore = playlist.options.status?.paused;

      for (const mode of ["hide", "scroll", "side", "bottom"]) {
        ctx.view.setDisplayMode(mode);

        expect(ctx.view.getDisplayMode()).toBe(mode);
        expect(ctx.elements.title.textContent).toBe(title);
        expect(highlighted(ctx.playlist)).toBe(2);
        // No play/pause/select is issued by a mode switch.
        expect(playlist.current).toBe(2);
        expect(playlist.options.status?.paused).toBe(pausedBefore);
      }
    });

    it("scrolls the current track into view after a mode switch", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(3);

      ctx.view.setDisplayMode("side");
      // The side column is a scroll pane; our stack layout stacks rows so the
      // last row is below the fold of the fake viewport.
      ctx.view.setDisplayMode("bottom");

      expect(highlighted(ctx.playlist)).toBe(3);
      expect(ctx.store.getView().index).toBe(3);
    });
  });

  describe("load failure", () => {
    beforeEach(() => {
      ctx = boot();
    });

    it("keeps the previous track's info and shows a visible notice", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(0);
      ctx.store.markPlayable();

      // Jump to track 2 and have it 404.
      playlist.select(2);
      playlist.failCurrent("e_url");

      // The last good track's info stays on screen.
      expect(ctx.elements.title.textContent).toBe("T-Rex Roar");
      expect(highlighted(ctx.playlist)).toBe(0);
      expect(noticeText(ctx.elements)).toContain("Still showing the previous track");

      // The failed row is marked, but never as the current highlight.
      const rows = [...ctx.playlist.querySelectorAll("li")];
      expect(rows[2].classList.contains("jp-playlist-failed")).toBe(true);
      expect(rows[2].classList.contains("jp-playlist-current")).toBe(false);
    });

    it("recovers normally when a good track is selected after a failure", () => {
      const playlist = ctx.manager.getJPlaylist();
      playlist.play(0);
      playlist.select(2);
      playlist.failCurrent("e_url");
      expect(noticeText(ctx.elements)).not.toBe("");

      playlist.play(1);

      expect(ctx.elements.title.textContent).toBe("Arcade bonus alert");
      expect(highlighted(ctx.playlist)).toBe(1);
      expect(noticeText(ctx.elements)).toBe("");
      expect(ctx.store.getView().error).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("does not throw with an empty playlist", () => {
      ctx = boot({ tracks: [] });
      expect(() => ctx.manager.playNext()).not.toThrow();
      expect(() => ctx.manager.playPrevious()).not.toThrow();
      expect(() => ctx.manager.handleEnded()).not.toThrow();
      expect(() =>
        ctx.manager.handlePlayerError({ jPlayer: { error: { type: "e_url" } } }),
      ).not.toThrow();
      expect(highlighted(ctx.playlist)).toBe(-1);
      expect(ctx.store.getView().track).toBeNull();
    });

    it("ignores an error on an empty playlist", () => {
      ctx = boot({ tracks: [] });
      expect(ctx.manager.store.fail()).toBe(false);
    });
  });
});
