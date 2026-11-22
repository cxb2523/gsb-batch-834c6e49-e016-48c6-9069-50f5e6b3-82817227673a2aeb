import { expect, test } from "vitest";
import {
    TextTrack,
    VTTCue,
    VTTParser,
    VTTRegion,
    WebVTTUpdateTextTracksDisplay,
    WebVTTClearTextTracksDisplay,
    ref,
    deref,
    addTrack,
    removeTrack,
    timeMarchesOn,
} from "@react-av/vtt-core";

function setupHarness() {
    const container = document.createElement("div");
    const video = document.createElement("video");
    container.appendChild(video);
    document.body.appendChild(container);
    return { container, video };
}

test("injects STYLE block rules into the rendering container and renders regions", () => {
    const { container, video } = setupHarness();
    const parser = new VTTParser(`WEBVTT

STYLE
::cue { color: rgb(1, 2, 3); }
.cool { color: rgb(4, 5, 6); }

REGION
id:r1 width:40% lines:5 scroll:up

00:00:00.000 --> 00:00:02.000 region:r1
<c.cool>hi</c>`);

    const track = parser.textTrack("subtitles");
    track.mode = "showing";

    // Drive the renderer directly, marking the cue active.
    const cue = parser.cues[0] as VTTCue;
    cue.startTime = 0;
    cue.endTime = 2;
    video.currentTime = 1;
    // Register the media element + track through the global state.
    // `ref` initializes the context; addTrack attaches the track.
    ref(video);
    addTrack(video, track);
    timeMarchesOn();

    WebVTTUpdateTextTracksDisplay(video);

    const ttc = container.querySelector("vtt-texttrackcontainer")!;
    expect(ttc).toBeTruthy();
    const shadow = ttc.shadowRoot!;
    const injected = shadow.querySelectorAll('style[data-vtt-stylesheet]');
    expect(injected.length).toBe(1);
    expect(injected[0].textContent).toContain("::cue");
    expect(injected[0].textContent).toContain(".cool");

    // Region DOM expresses width, lines and scroll:up.
    const regionBox = shadow.querySelector("vtt-region")!;
    expect(regionBox).toBeTruthy();
    expect(regionBox.getAttribute("region")).toBe("r1");
    expect(regionBox.getAttribute("scroll")).toBe("up");
    expect(regionBox.style.width).toBeTruthy();
    expect(regionBox.style.maxHeight).toBeTruthy();
});

test("re-rendering replaces rather than accumulates injected styles", () => {
    const { container, video } = setupHarness();
    ref(video);

    const track = new TextTrack("subtitles", "showing");
    const parser = new VTTParser(`WEBVTT

STYLE
::cue { color: red; }

00:00:00.000 --> 00:00:02.000
hi`);
    for (const stylesheet of parser.stylesheets) track._addStylesheet(stylesheet);
    addTrack(video, track);

    WebVTTUpdateTextTracksDisplay(video);
    WebVTTUpdateTextTracksDisplay(video);
    WebVTTUpdateTextTracksDisplay(video);

    const shadow = container.querySelector("vtt-texttrackcontainer")!.shadowRoot!;
    expect(shadow.querySelectorAll('style[data-vtt-stylesheet]').length).toBe(1);
});

test("cleanup removes injected style and region DOM leaving no residue", () => {
    const { container, video } = setupHarness();
    ref(video);

    const parser = new VTTParser(`WEBVTT

STYLE
::cue { color: red; }

REGION
id:r1

00:00:00.000 --> 00:00:02.000 region:r1
hi`);
    const track = parser.textTrack("subtitles");
    track.mode = "showing";
    addTrack(video, track);

    WebVTTUpdateTextTracksDisplay(video);
    const oldContainer = container.querySelector("vtt-texttrackcontainer");
    expect(oldContainer).toBeTruthy();
    expect(oldContainer!.shadowRoot!.querySelectorAll('style[data-vtt-stylesheet]').length).toBe(1);

    // Explicit teardown (unmount / subtitle source switch).
    WebVTTClearTextTracksDisplay(video);
    expect(container.querySelector("vtt-texttrackcontainer")).toBeNull();

    // Switching subtitle sources removes the old track before re-rendering.
    removeTrack(video, track);
    WebVTTUpdateTextTracksDisplay(video);

    // A brand-new container is created; the previous source leaves no style nodes.
    const newContainer = container.querySelector("vtt-texttrackcontainer")!;
    expect(newContainer).toBeTruthy();
    expect(newContainer).not.toBe(oldContainer);
    expect(newContainer.shadowRoot!.querySelectorAll('style[data-vtt-stylesheet]').length).toBe(0);
    expect(newContainer.shadowRoot!.querySelectorAll('vtt-region').length).toBe(0);
});

test("deref to zero refcount cleans up the container automatically", () => {
    const { container, video } = setupHarness();
    ref(video);
    WebVTTUpdateTextTracksDisplay(video);
    expect(container.querySelector("vtt-texttrackcontainer")).toBeTruthy();

    deref(video);
    expect(container.querySelector("vtt-texttrackcontainer")).toBeNull();
});

test("getCueAsHTML preserves class, voice and lang semantics", () => {
    const cue = new VTTCue(0, 1, '<c.cool>text</c> <v John>spoken</v> <lang es>hola</lang>');
    const fragment = cue.getCueAsHTML();
    const wrapper = document.createElement("div");
    wrapper.appendChild(fragment);

    const classed = wrapper.querySelector("span.cool")!;
    expect(classed).toBeTruthy();
    expect(classed.textContent).toBe("text");

    const voice = wrapper.querySelector("v")!;
    expect(voice).toBeTruthy();
    expect(voice.getAttribute("title")).toBe("John");
    expect(voice.textContent).toBe("spoken");

    const lang = wrapper.querySelector('[lang="es"]')!;
    expect(lang).toBeTruthy();
    expect(lang.textContent).toBe("hola");
});

test("a region with scroll up carries the attribute and region id through rendering", () => {
    const region = new VTTRegion();
    region.id = "bottom";
    region.scroll = "up";
    const cue = new VTTCue(0, 2, "region cue");
    cue.region = region;

    const { container, video } = setupHarness();
    ref(video);
    const track = new TextTrack("subtitles", "showing");
    track._addRegion(region);
    track.addCue(cue);
    addTrack(video, track);
    timeMarchesOn();

    WebVTTUpdateTextTracksDisplay(video);
    const regionBox = container.querySelector("vtt-texttrackcontainer")!.shadowRoot!.querySelector("vtt-region")!;
    expect(regionBox.getAttribute("region")).toBe("bottom");
    expect(regionBox.getAttribute("scroll")).toBe("up");
});
