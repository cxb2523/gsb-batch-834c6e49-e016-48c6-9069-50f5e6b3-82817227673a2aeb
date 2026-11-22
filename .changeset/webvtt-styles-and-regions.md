---
"@react-av/vtt-core": minor
---

Parse, render and clean up WebVTT STYLE blocks and REGION definitions end to end.

- STYLE blocks are now retained as read-only CSS rules (`VTTParser.stylesheets`, `VTTStylesheet.cssText`/`cssRules`, `TextTrack._stylesheets`) instead of being dropped, and injected into the rendering container's shadow DOM. Re-rendering replaces rather than accumulates style nodes.
- Cue/region binding follows the spec: a cue only drops out of its region when it explicitly sets `line`, `vertical`, or a non-default `size`; the previous `line` branch no longer clears the region unconditionally. `region` references still resolve to the last matching id.
- `getCueAsHTML` and the renderer preserve class, voice (`v`) and `lang` inline semantics; voice nodes are now correctly attached during cue text parsing.
- Region boxes expose their id and `scroll:up` setting in the DOM, expressing width, lines and anchors.
- Injected style and region DOM are torn down on `deinit` and via the new `WebVTTClearTextTracksDisplay`, so switching subtitle sources or unmounting leaves no residue.
