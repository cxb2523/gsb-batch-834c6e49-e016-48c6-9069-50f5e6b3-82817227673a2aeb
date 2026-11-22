import { describe, expect, it } from "vitest";
import { TextTrack, VTTParser } from "@react-av/vtt-core";
import { toVTT } from "../src/to-vtt";

function trackFromVtt(input: string) {
    const parser = new VTTParser(input);
    return parser.textTrack("subtitles");
}

describe("toVTT round-trip", () => {
    it("writes STYLE blocks back unchanged", () => {
        const css = "::cue { background: rgba(0,0,0,0.8); }\n.cool { color: lime; }";
        const input = `WEBVTT\n\nSTYLE\n${css}\n\n00:00:00.000 --> 00:00:01.000\n<c.cool>hi</c>`;
        const track = trackFromVtt(input);

        const output = toVTT(track);
        expect(output).toContain("STYLE");
        expect(output).toContain(css);

        const reparsed = new VTTParser(output);
        expect(reparsed.stylesheets).toHaveLength(1);
        expect(reparsed.stylesheets[0].cssText).toBe(css);
    });

    it("writes REGION definitions back", () => {
        const input = `WEBVTT

REGION
id:top width:40% lines:4 regionanchor:50%,0% viewportanchor:50%,0% scroll:up

00:00:00.000 --> 00:00:01.000 region:top
hi`;
        const output = toVTT(trackFromVtt(input));
        const reparsed = new VTTParser(output);

        expect(reparsed.regions).toHaveLength(1);
        const region = reparsed.regions[0];
        expect(region.id).toBe("top");
        expect(region.width).toBe(40);
        expect(region.lines).toBe(4);
        expect(region.regionAnchorX).toBe(50);
        expect(region.regionAnchorY).toBe(0);
        expect(region.viewportAnchorX).toBe(50);
        expect(region.viewportAnchorY).toBe(0);
        expect(region.scroll).toBe("up");

        expect(reparsed.cues[0].region?.id).toBe("top");
    });

    it("preserves region binding and cue settings across a full round-trip", () => {
        const input = `WEBVTT

STYLE
::cue { color: white; }

REGION
id:r1 width:30%

00:00:00.000 --> 00:00:02.000 region:r1
in region

00:00:03.000 --> 00:00:04.000 line:5 size:50%
out of region`;

        const output = toVTT(trackFromVtt(input));
        const reparsed = new VTTParser(output);

        expect(reparsed.stylesheets[0].cssText).toBe("::cue { color: white; }");

        const [bound, detached] = reparsed.cues;
        expect(bound.region?.id).toBe("r1");
        expect(detached.region).toBeNull();
        expect(detached.line).toBe(5);
        expect(detached.snapToLines).toBe(true);
        expect(detached.size).toBe(50);
    });

    it("retains cue id, timings and text across a round-trip", () => {
        const input = `WEBVTT

cue-1
00:01:02.500 --> 00:01:03.250 align:end
line one
line two`;
        const output = toVTT(trackFromVtt(input));
        const reparsed = new VTTParser(output);

        expect(reparsed.cues).toHaveLength(1);
        const cue = reparsed.cues[0];
        expect(cue.id).toBe("cue-1");
        expect(cue.startTime).toBeCloseTo(62.5);
        expect(cue.endTime).toBeCloseTo(63.25);
        expect(cue.align).toBe("end");
        expect(cue.text).toContain("line one");
        expect(cue.text).toContain("line two");
    });

    it("has identical behavior when no STYLE block is present", () => {
        const input = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nplain`;
        const track = trackFromVtt(input);

        const output = toVTT(track);
        expect(output).not.toContain("STYLE");
        expect(output.startsWith("WEBVTT\n\n00:00:00.000")).toBe(true);

        const reparsed = new VTTParser(output);
        expect(reparsed.stylesheets).toEqual([]);
        expect(reparsed.cues[0].text).toBe("plain");
    });

    it("serializes a cue that dropped out via vertical writing direction", () => {
        const input = `WEBVTT

REGION
id:r1

00:00:00.000 --> 00:00:01.000 region:r1 vertical:rl
vertical`;
        const output = toVTT(trackFromVtt(input));
        const reparsed = new VTTParser(output);

        expect(reparsed.cues[0].vertical).toBe("rl");
        expect(reparsed.cues[0].region).toBeNull();
        expect(output).toContain("vertical:rl");
    });

    it("does not reference a region that is not exported", () => {
        const track = new TextTrack("subtitles", "showing");
        const parser = new VTTParser(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi`);
        const cue = parser.cues[0];
        // Simulate a cue pointing at a region not present on this track.
        cue.region = {
            id: "ghost", width: 100, lines: 3,
            regionAnchorX: 0, regionAnchorY: 100, viewportAnchorX: 0, viewportAnchorY: 100,
            scroll: "",
        };
        track.addCue(cue);

        const output = toVTT(track);
        expect(output).not.toContain("region:ghost");
    });
});
