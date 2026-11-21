import { afterEach, describe, expect, it } from "vitest";

import { PlayerStore } from "../src/assets/js/player-store.js";
import { PlaylistView } from "../src/assets/js/player-view.js";
import { createFixture, demoPlaylist } from "./helpers/fixture.js";

/**
 * Scroll behaviour with a controllable scroll container. jsdom has no layout
 * engine, so we give the view an explicit `measure` and back the container
 * with a plain object whose scrollTop is a real, writable number.
 */
const makeContainer = ({ scrollTop = 0, viewportHeight = 120 } = {}) => ({
  clientHeight: viewportHeight,
  scrollTop,
});

const setup = ({ display = "side" } = {}) => {
  const elements = createFixture({ display });

  // 4 rows of 40px, stacked from y=0.
  elements.playlist.querySelector("ul").innerHTML = demoPlaylist
    .map((track) => `<li><div><a class="jp-playlist-item">${track.title}</a></div></li>`)
    .join("");

  const store = new PlayerStore({ tracks: demoPlaylist });
  const view = new PlaylistView();
  const container = makeContainer();

  view.measure = (_container, item) => {
    const rows = [...elements.playlist.querySelectorAll("li")];
    const index = rows.indexOf(item);

    return {
      itemHeight: 40,
      itemTop: index * 40,
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
    };
  };

  view.init({ elements, initialDisplay: display, store });
  // `side` mode uses the playlist element as its pane; back it with ours.
  view.playlistEl = container;

  return { container, elements, store, view };
};

let ctx;

afterEach(() => {
  ctx = null;
});

describe("scroll keeps the current track visible", () => {
  it("scrolls down to reveal a track below the fold", () => {
    ctx = setup();
    // Row 3 spans 120..160; the viewport is 120px tall.
    ctx.store.commitIndex(3);

    expect(ctx.container.scrollTop).toBe(40);
  });

  it("scrolls up to reveal a track above the fold", () => {
    ctx = setup();
    ctx.store.commitIndex(3);
    expect(ctx.container.scrollTop).toBe(40);

    ctx.container.scrollTop = 120;
    ctx.store.commitIndex(0);

    expect(ctx.container.scrollTop).toBe(0);
  });

  it("leaves an already-visible track untouched", () => {
    ctx = setup();
    ctx.container.scrollTop = 40;
    // Row 1 spans 40..80, fully inside the 40..160 window.
    ctx.store.commitIndex(1);

    expect(ctx.container.scrollTop).toBe(40);
  });

  it("returns the current track into view after a display-mode switch", () => {
    ctx = setup({ display: "bottom" });
    ctx.store.commitIndex(3);

    // Force the scroll pane out of position, then switch to `side` (which
    // uses the playlist pane) and confirm it scrolls back.
    ctx.container.scrollTop = 0;
    ctx.view.setDisplayMode("side");

    expect(ctx.container.scrollTop).toBe(40);
  });

  it("does not scroll the page while the playlist is hidden", () => {
    ctx = setup({ display: "hide" });
    ctx.container.scrollTop = 0;
    ctx.store.commitIndex(3);

    // Hidden mode has no visible playlist pane, so nothing should move.
    expect(ctx.container.scrollTop).toBe(0);
  });

  it("keeps the golden path stable: many commits stay idempotent", () => {
    ctx = setup();
    ctx.store.commitIndex(3);
    const settled = ctx.container.scrollTop;

    // A duplicate commit re-asserts rather than moving the pane.
    ctx.store.commitIndex(3);
    ctx.view.reassert();
    expect(ctx.container.scrollTop).toBe(settled);

    // Row 2 spans 80..120, inside the visible 40..160 window.
    ctx.store.commitIndex(2);
    expect(ctx.container.scrollTop).toBe(settled);
  });
});
