import { describe, expect, it } from "vitest";

import { PlayerStore } from "../src/assets/js/player-store.js";

const tracks = [
  { mp3: "a.mp3", title: "A" },
  { mp3: "b.mp3", title: "B" },
  { mp3: "c.mp3", title: "C" },
  { mp3: "d.mp3", title: "D" },
];

describe("PlayerStore", () => {
  it("starts at the first track", () => {
    const store = new PlayerStore({ tracks });
    const view = store.getView();

    expect(view.index).toBe(0);
    expect(view.highlightIndex).toBe(0);
    expect(view.track.title).toBe("A");
    expect(view.error).toBeNull();
  });

  it("commits an index and clears any prior error", () => {
    const store = new PlayerStore({ tracks });

    store.commitIndex(2, { source: "manual" });
    expect(store.getView().index).toBe(2);
    expect(store.getView().track.title).toBe("C");
  });

  it("ignores out-of-range commits so highlight always points at a real row", () => {
    const store = new PlayerStore({ tracks });
    store.commitIndex(2);

    expect(store.commitIndex(99)).toBe(false);
    expect(store.commitIndex(-1)).toBe(false);
    expect(store.commitIndex(1.5)).toBe(false);
    expect(store.getView().highlightIndex).toBe(2);
  });

  it("wraps next/previous when looping and clamps when not", () => {
    const looping = new PlayerStore({ loop: true, tracks });

    expect(looping.nextIndex()).toBe(1);
    looping.commitIndex(3);
    expect(looping.nextIndex()).toBe(0);
    expect(looping.previousIndex()).toBe(2);

    const clamped = new PlayerStore({ loop: false, tracks });
    clamped.commitIndex(3);
    expect(clamped.nextIndex()).toBeNull();
    clamped.commitIndex(0);
    expect(clamped.previousIndex()).toBeNull();
  });

  it("never throws when stepping an empty playlist", () => {
    const store = new PlayerStore({ tracks: [] });

    expect(store.nextIndex()).toBeNull();
    expect(store.previousIndex()).toBeNull();
    expect(store.getView()).toMatchObject({ error: null, highlightIndex: -1, track: null });
    expect(store.fail()).toBe(false);
    expect(store.commitIndex(0)).toBe(false);
  });

  it("keeps the last playable track's info after a load failure", () => {
    const store = new PlayerStore({ tracks });

    store.commitIndex(0);
    store.markPlayable();
    // The user jumps to C, which then fails to load.
    store.commitIndex(2);
    store.fail({ message: "failed", type: "e_url" });

    const view = store.getView();
    expect(view.currentIndex).toBe(2);
    // The last playable track's info survives the failure.
    expect(view.track.title).toBe("A");
    expect(view.highlightIndex).toBe(0);
    expect(view.isFallback).toBe(true);
    expect(view.error.index).toBe(2);
  });

  it("shows the failed track itself when nothing was playable yet", () => {
    const store = new PlayerStore({ tracks });

    store.fail({ message: "first load failed" });

    const view = store.getView();
    expect(view.track.title).toBe("A");
    expect(view.error).not.toBeNull();
    expect(view.highlightIndex).toBe(0);
  });

  it("clears the error and advances once a new track is committed", () => {
    const store = new PlayerStore({ tracks });

    store.markPlayable();
    store.commitIndex(1);
    store.fail({ message: "bad" });
    expect(store.getView().error).not.toBeNull();

    store.commitIndex(2);
    expect(store.getView().error).toBeNull();
    expect(store.getView().track.title).toBe("C");
  });

  it("notifies subscribers with the same snapshot it returns", () => {
    const store = new PlayerStore({ tracks });
    const seen = [];
    const unsubscribe = store.subscribe((view) => seen.push(view));

    store.commitIndex(1);
    store.fail({ message: "bad" });
    unsubscribe();
    store.commitIndex(2);

    expect(seen).toHaveLength(2);
    expect(seen[0].track.title).toBe("B");
    expect(seen[1].error).not.toBeNull();
  });

  it("reports a monotonic revision that changes on every state change", () => {
    const store = new PlayerStore({ tracks });
    const start = store.getView().revision;

    store.commitIndex(1);
    store.fail({ message: "x" });
    store.clearError();

    expect(store.getView().revision).toBeGreaterThan(start);
  });
});
