import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudioPlayerApp } from "../src/assets/js/app.js";
import { PlayerStore } from "../src/assets/js/player-store.js";
import { PlaylistView } from "../src/assets/js/player-view.js";
import { createFixture, demoPlaylist } from "./helpers/fixture.js";

let app;
let ctx;

const boot = () => {
  const elements = createFixture({ display: "hide" });
  elements.playlist.querySelector("ul").innerHTML = demoPlaylist
    .map((track) => `<li><div><a class="jp-playlist-item">${track.title}</a></div></li>`)
    .join("");

  const store = new PlayerStore({ tracks: demoPlaylist });
  const view = new PlaylistView();
  view.init({ elements, initialDisplay: "hide", store });

  app = new AudioPlayerApp({ view });
  app.init();

  ctx = { elements, store, view };
  return ctx;
};

const highlighted = (playlistEl) => {
  const row = playlistEl.querySelector("li.jp-playlist-current");
  return row ? [...playlistEl.querySelectorAll("li")].indexOf(row) : -1;
};

describe("display-mode toggles", () => {
  beforeEach(() => {
    boot();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("switches mode on click without touching the current track", () => {
    ctx.store.commitIndex(2);
    const title = ctx.elements.title.textContent;

    ctx.elements.toggles.find((b) => b.dataset.display === "side").click();

    expect(ctx.view.getDisplayMode()).toBe("side");
    expect(ctx.elements.player.classList.contains("playlist-side")).toBe(true);
    expect(ctx.elements.title.textContent).toBe(title);
    expect(highlighted(ctx.elements.playlist)).toBe(2);
  });

  it("marks exactly one toggle selected and keeps aria-pressed in sync", () => {
    ctx.elements.toggles.find((b) => b.dataset.display === "scroll").click();

    const selected = ctx.elements.toggles.filter((b) => b.classList.contains("selected"));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.display).toBe("scroll");
    expect(selected[0].getAttribute("aria-pressed")).toBe("true");
    expect(
      ctx.elements.toggles
        .filter((b) => b !== selected[0])
        .every((b) => b.getAttribute("aria-pressed") === "false"),
    ).toBe(true);
  });

  it("does not select the jp-next control class (a toggle is not a track skip)", () => {
    for (const toggle of ctx.elements.toggles) {
      expect(toggle.classList.contains("jp-next")).toBe(false);
    }
  });

  it("survives repeated toggling back and forth", () => {
    ctx.store.commitIndex(3);

    for (const mode of ["bottom", "side", "scroll", "hide", "side", "bottom"]) {
      ctx.elements.toggles.find((b) => b.dataset.display === mode).click();
      expect(ctx.view.getDisplayMode()).toBe(mode);
      expect(highlighted(ctx.elements.playlist)).toBe(3);
    }
  });
});
