import { type TextTrack, type VTTCue, toTimestampString, VTTRegion } from "@react-av/vtt-core";

function toSafeCuePayload(text: string) {
    return text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .filter(line => line.trim() !== "")
        .join("\n")
        .replace(/-->/g, "--&gt;");
}

function regionToLines(region: VTTRegion) {
    const settings: string[] = [];
    if (region.id !== "")
        settings.push(`id:${region.id}`);
    settings.push(`width:${region.width}%`);
    settings.push(`lines:${region.lines}`);
    if (region.regionAnchorX !== 0 || region.regionAnchorY !== 100)
        settings.push(`regionanchor:${region.regionAnchorX}%,${region.regionAnchorY}%`);
    if (region.viewportAnchorX !== 0 || region.viewportAnchorY !== 100)
        settings.push(`viewportanchor:${region.viewportAnchorX}%,${region.viewportAnchorY}%`);
    if (region.scroll !== "")
        settings.push(`scroll:${region.scroll}`);
    return settings.join(" ");
}

function cueSettingsToLine(cue: VTTCue, regionIds: Set<string>) {
    const settings: string[] = [];
    // Emit the region reference first when the cue is still bound to a region.
    // Cues that dropped out of their region (explicit line/size/vertical) have
    // `cue.region === null` and therefore serialize without one.
    if (cue.region && cue.region.id !== "" && regionIds.has(cue.region.id))
        settings.push(`region:${cue.region.id}`);
    if (cue.vertical !== "")
        settings.push(`vertical:${cue.vertical}`);
    if (cue.line !== "auto") {
        const line = `${cue.line}${cue.snapToLines ? "" : "%"}`;
        settings.push(cue.lineAlign !== "start" ? `line:${line},${cue.lineAlign}` : `line:${line}`);
    }
    if (cue.position !== "auto") {
        settings.push(cue.positionAlign !== "auto"
            ? `position:${cue.position}%,${cue.positionAlign}`
            : `position:${cue.position}%`);
    }
    if (cue.size !== 100)
        settings.push(`size:${cue.size}%`);
    if (cue.align !== "center")
        settings.push(`align:${cue.align}`);
    return settings.join(" ");
}

/**
 * Serialize a text track back to WebVTT.
 *
 * STYLE blocks and REGION definitions are emitted before the cues so that a
 * parse -> export -> parse round-trip preserves the stylesheet CSS text,
 * region definitions, region bindings and cue positioning settings.
 */
export function toVTT(track: TextTrack) {
    const blocks: string[] = ["WEBVTT"];

    for (const stylesheet of track._stylesheets) {
        blocks.push(`STYLE\n${stylesheet.cssText}`);
    }

    const regions = track._regions;
    const regionIds = new Set(regions.map(region => region.id).filter(id => id !== ""));
    for (const region of regions) {
        blocks.push(`REGION\n${regionToLines(region)}`);
    }

    const cues = [...(track.cues ?? [])].sort((a, b) => a.startTime - b.startTime) as VTTCue[];
    for (const cue of cues) {
        const settings = cueSettingsToLine(cue, regionIds);
        const timing = `${toTimestampString(cue.startTime)} --> ${toTimestampString(cue.endTime)}`;
        const payload = toSafeCuePayload(cue.text);
        const id = cue.id ? `${cue.id}\n` : "";
        blocks.push(`${id}${timing}${settings ? ` ${settings}` : ""}\n${payload}`);
    }

    return blocks.join("\n\n");
}
