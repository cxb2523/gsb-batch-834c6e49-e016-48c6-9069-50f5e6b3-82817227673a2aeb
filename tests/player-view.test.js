import { beforeEach, describe, expect, it } from "vitest";

import { PlayerStore } from "../src/assets/js/player-store.js";
import { PlaylistView } from "../src/assets/js/player-view.js";
import { computeScrollTop } from "../src/assets/js/scroll.js";
import { createFixture, demoPlaylist } from "./helpers/fixture.js";

const setupView = ({ display = "hide", tracks = demoPlaylist } = {}) => {
  const elements = createFixture({ display });
  const store = new PlayerStore({ tracks });
  const view = new PlaylistView();
  view.init({ elements, initialDisplay: display, store });

  return { elements, playlist: elements.playlist, store, view };
};

/** Renders playlist rows so PlaylistView has real <li> targets. */
const renderRows = (playlistEl, tracks) => {
  playlistEl.querySelector("ul").innerHTML = tracks
    .map((track) => `<li><div><a class="jp-playlist-item">${track.title}</a></div></li>`)
    .join("");
};

const highlighted = (playlistEl) => {
  const current = playlistEl.querySelector(".jp-playlist-current");
  if (!current) {
    return -1;
  }
  const row = current.closest("li");
  return [...playlistEl.querySelectorAll("li")].indexOf(row);
};

describe("computeScrollTop", () => {
  it("scrolls down just enough to reveal an item below the fold", () => {
    expect(
      computeScrollTop({ itemHeight: 40, itemTop: 400, scrollTop: 0, viewportHeight: 200 }),
    ).toBe(240);
  });

  it("scrolls up to reveal an item above the fold", () => {
    expect(
      computeScrollTop({ itemHeight: 40, itemTop: 20, scrollTop: 200, viewportHeight: 200 }),
    ).toBe(20);
  });

  it("leaves an already-visible item untouched", () => {
    expect(
      computeScrollTop({ itemHeight: 40, itemTop: 120, scrollTop: 100, viewportHeight: 200 }),
    ).toBe(100);
  });

  it("honours padding and never returns a negative offset", () => {
    expect(
      computeScrollTop({
        itemHeight: 40,
        itemTop: 0,
        padding: 8,
        scrollTop: 0,
        viewportHeight: 200,
      }),
    ).toBe(0);
  });

  it("returns the current offset when geometry is unavailable", () => {
    expect(computeScrollTop({ scrollTop: 42, viewportHeight: 0 })).toBe(42);
  });
});

describe("PlaylistView", () => {
  let ctx;

  beforeEach(() => {
    ctx = setupView({ display: "bottom" });
    renderRows(ctx.playlist, demoPlaylist);
  });

  it("renders track info and highlight from one snapshot", () => {
    ctx.store.commitIndex(1);

    expect(ctx.elements.title.textContent).toBe("Arcade bonus alert");
    expect(ctx.elements.artist.textContent).toBe("Mixkit");
    expect(ctx.elements.record.textContent).toBe("Mixkit Sound Effects Free License");
    expect(ctx.elements.poster.getAttribute("src")).toBe("poster-b.jpg");
    expect(highlighted(ctx.playlist)).toBe(1);
  });

  it("moves the highlight in lockstep with the track info", () => {
    ctx.store.commitIndex(3);

    expect(ctx.elements.title.textContent).toBe("Game reward sting");
    expect(highlighted(ctx.playlist)).toBe(3);
  });

  it("removes the previous highlight when the current track changes", () => {
    ctx.store.commitIndex(1);
    ctx.store.commitIndex(2);

    const rows = [...ctx.playlist.querySelectorAll("li")];
    expect(rows[1].classList.contains("jp-playlist-current")).toBe(false);
    expect(rows[2].classList.contains("jp-playlist-current")).toBe(true);
    // The class is mirrored onto the row's link (matching the jPlayer add-on),
    // so scope the uniqueness check to the rows themselves.
    expect(ctx.playlist.querySelectorAll("li.jp-playlist-current")).toHaveLength(1);
  });

  it("keeps the last good info and flags the failed row on error", () => {
    ctx.store.commitIndex(0);
    ctx.store.markPlayable();
    ctx.store.commitIndex(2);
    ctx.store.fail({ message: "Track failed to load", type: "e_url" });

    // The last good track stays on screen.
    expect(ctx.elements.title.textContent).toBe("T-Rex Roar");
    expect(highlighted(ctx.playlist)).toBe(0);
    expect(ctx.elements.notice.hidden).toBe(false);
    expect(ctx.elements.notice.textContent).toBe("Track failed to load");

    const rows = [...ctx.playlist.querySelectorAll("li")];
    expect(rows[2].classList.contains("jp-playlist-failed")).toBe(true);
  });

  it("never highlights a non-existent row", () => {
    ctx.store.commitIndex(99);
    expect(highlighted(ctx.playlist)).toBe(0);

    // Empty playlist: no highlight, no throw.
    ctx.playlist.querySelector("ul").innerHTML = "";
    ctx.store.commitIndex(1);
    expect(ctx.playlist.querySelector(".jp-playlist-current")).toBeNull();
  });

  it("keeps highlight and track info across a display-mode switch", () => {
    ctx.store.commitIndex(2);
    const beforeTitle = ctx.elements.title.textContent;
    const beforeHighlight = highlighted(ctx.playlist);

    for (const mode of ["hide", "bottom", "scroll", "side", "bottom"]) {
      ctx.view.setDisplayMode(mode);
      expect(ctx.view.getDisplayMode()).toBe(mode);
      expect(ctx.elements.player.classList.contains(`playlist-${mode}`)).toBe(true);
      expect(ctx.elements.title.textContent).toBe(beforeTitle);
      expect(highlighted(ctx.playlist)).toBe(beforeHighlight);
    }
  });

  it("only ever carries one display-mode class", () => {
    for (const mode of ["hide", "bottom", "scroll", "side"]) {
      ctx.view.setDisplayMode(mode);
    }

    const modes = ["hide", "bottom", "scroll", "side"].filter((mode) =>
      ctx.elements.player.classList.contains(`playlist-${mode}`),
    );
    expect(modes).toEqual(["side"]);
  });

  it("re-asserts the highlight after the playlist DOM is rebuilt", () => {
    ctx.store.commitIndex(2);
    expect(highlighted(ctx.playlist)).toBe(2);

    // The add-on rebuilds rows asynchronously and drops our classes.
    renderRows(ctx.playlist, demoPlaylist);
    expect(highlighted(ctx.playlist)).toBe(-1);

    ctx.view.reassert();
    expect(highlighted(ctx.playlist)).toBe(2);
  });

  it("re-renders an existing selection after the add-on rebuilds rows", () => {
    const manager = new (class {
      // Mirrors JPlayerManager.commit's "same selection -> reassert" path.
      constructor(store, view) {
        this.store = store;
        this.view = view;
      }

      commitSame() {
        const changed = this.store.commitIndex(this.store.currentIndex);
        if (!changed) {
          this.view.reassert();
        }
      }
    })(ctx.store, ctx.view);

    renderRows(ctx.playlist, demoPlaylist);
    expect(highlighted(ctx.playlist)).toBe(-1);
    manager.commitSame();
    expect(highlighted(ctx.playlist)).toBe(0);
  });
});
