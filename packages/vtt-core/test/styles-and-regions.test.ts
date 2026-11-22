import { describe, expect, it } from "vitest";
import { TextTrack, VTTParser } from "../src";
import VTTStylesheet from "../src/VTTStylesheet";

const FILE_HEADER = "WEBVTT\n\n";

describe("VTTParser STYLE blocks", () => {
    it("retains STYLE block contents as read-only CSS text", () => {
        const css = "::cue {\n    background: red;\n}\n.cool {\n    color: lime;\n}";
        const parser = new VTTParser(`${FILE_HEADER}STYLE\n${css}\n\n00:00:00.000 --> 00:00:01.000\n<c.cool>hi</c>`);

        expect(parser.stylesheets).toHaveLength(1);
        const stylesheet = parser.stylesheets[0];
        expect(stylesheet).toBeInstanceOf(VTTStylesheet);
        expect(stylesheet.cssText).toBe(css);
    });

    it("exposes a frozen list of the individual CSS rules", () => {
        const parser = new VTTParser(
            `${FILE_HEADER}STYLE\n::cue { background: red; }\n.cool { color: lime; }\n\n00:00:00.000 --> 00:00:01.000\nhi`,
        );

        const rules = parser.stylesheets[0].cssRules;
        expect(rules).toHaveLength(2);
        expect(rules[0]).toContain("::cue");
        expect(rules[1]).toContain(".cool");
        expect(Object.isFrozen(rules)).toBe(true);
        expect(() => {
            // @ts-expect-error the rule list is read-only at runtime
            rules.push("body { color: black; }");
        }).toThrow();
    });

    it("strips CSS comments when extracting rules but keeps them in cssText", () => {
        const css = "/* comment */\n::cue { color: red; }\n/* multi\nline */";
        const parser = new VTTParser(`${FILE_HEADER}STYLE\n${css}\n\n00:00:00.000 --> 00:00:01.000\nhi`);

        expect(parser.stylesheets[0].cssText).toBe(css);
        expect(parser.stylesheets[0].cssRules).toEqual(["::cue { color: red; }"]);
    });

    it("collects multiple STYLE blocks in document order", () => {
        const parser = new VTTParser(
            `${FILE_HEADER}STYLE
::cue { color: red; }

STYLE
.cool { color: lime; }

00:00:00.000 --> 00:00:01.000
hi`,
        );

        expect(parser.stylesheets).toHaveLength(2);
        expect(parser.stylesheets[0].cssText).toContain("red");
        expect(parser.stylesheets[1].cssText).toContain("lime");
    });

    it("returns an empty list when the file has no STYLE blocks", () => {
        const parser = new VTTParser(`${FILE_HEADER}00:00:00.000 --> 00:00:01.000\nhi`);
        expect(parser.stylesheets).toEqual([]);
    });

    it("attaches stylesheets to the produced TextTrack", () => {
        const parser = new VTTParser(`${FILE_HEADER}STYLE\n::cue { color: red; }\n\n00:00:00.000 --> 00:00:01.000\nhi`);
        const track = parser.textTrack("subtitles");
        expect(track._stylesheets).toHaveLength(1);
        expect(track._stylesheets[0].cssText).toBe("::cue { color: red; }");
    });

    it("does not accumulate styles when the same file is parsed repeatedly", () => {
        const input = `${FILE_HEADER}STYLE
::cue { color: red; }

00:00:00.000 --> 00:00:01.000
hi`;
        const first = new VTTParser(input);
        const second = new VTTParser(input);
        expect(first.stylesheets).toHaveLength(1);
        expect(second.stylesheets).toHaveLength(1);
        expect(first.stylesheets[0]).not.toBe(second.stylesheets[0]);
    });
});

describe("VTTParser cue/region binding", () => {
    function parseCueSettings(settings: string) {
        const parser = new VTTParser(
            `${FILE_HEADER}REGION
id:r1
width:40%

00:00:00.000 --> 00:00:01.000 ${settings}
hi`,
        );
        return parser.cues[0];
    }

    it("binds a cue to the region reference", () => {
        const cue = parseCueSettings("region:r1");
        expect(cue.region).not.toBeNull();
        expect(cue.region?.id).toBe("r1");
    });

    it("keeps the region when only alignment/position are set", () => {
        const cue = parseCueSettings("region:r1 align:start position:50%");
        expect(cue.region?.id).toBe("r1");
    });

    it("drops out of the region when line is explicitly set", () => {
        const cue = parseCueSettings("region:r1 line:5");
        expect(cue.region).toBeNull();
    });

    it("drops out of the region when size is explicitly set below 100%", () => {
        const cue = parseCueSettings("region:r1 size:50%");
        expect(cue.region).toBeNull();
        expect(cue.size).toBe(50);
    });

    it("keeps the region for an explicit size of 100%", () => {
        const cue = parseCueSettings("region:r1 size:100%");
        expect(cue.region?.id).toBe("r1");
    });

    it("drops out of the region when vertical is set", () => {
        const cue = parseCueSettings("region:r1 vertical:lr");
        expect(cue.region).toBeNull();
        expect(cue.vertical).toBe("lr");
    });

    it("honors document order: a region after line re-binds the cue", () => {
        const cue = parseCueSettings("line:5 region:r1");
        expect(cue.region?.id).toBe("r1");
    });

    it("resolves a region id to the last matching definition", () => {
        const parser = new VTTParser(
            `${FILE_HEADER}REGION
id:dup
width:10%

REGION
id:dup
width:70%

00:00:00.000 --> 00:00:01.000 region:dup
hi`,
        );
        const cue = parser.cues[0];
        expect(cue.region?.width).toBe(70);
        expect(parser.regions.filter(region => region.id === "dup")).toHaveLength(2);
    });

    it("leaves region null for an unknown region id", () => {
        const cue = parseCueSettings("region:nope");
        expect(cue.region).toBeNull();
    });
});
