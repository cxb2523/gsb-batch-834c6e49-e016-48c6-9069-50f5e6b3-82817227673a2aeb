---
"@react-av/editor": minor
---

`toVTT` now re-emits STYLE blocks, REGION definitions, cue ids and cue positioning/region settings, so exporting a track and re-parsing the result round-trips styles, regions and region bindings instead of dropping them.
