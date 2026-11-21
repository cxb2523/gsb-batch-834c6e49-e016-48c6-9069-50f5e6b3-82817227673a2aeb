# skincheck

A small, dependency-free reference for the TRAX cassette skin format. It reads
the same `skin.json` the app does, on either screen, and answers the questions
the format spec (`SKINS.html`) pins down:

- where each area lands on a PSP (480 × 272) and on a Vita (960 × 544);
- what each line reads, after fields drop out and separators go with them;
- how a line is shrunk and cut when it does not fit;
- what the background colour is at a given playing position, under `playing`
  or `always`, playing, paused or scrubbed;
- what switching skins releases, and that a late decode or draw from the old
  skin is refused.

Node 18 or later. No packages.

## Use it

```sh
# What does this skin look like on a Vita?
node tools/skincheck/cli.js samples/psp-label/skin.json --screen vita

# ...with a coarse picture of where the boxes land.
node tools/skincheck/cli.js samples/psp-label/skin.json --screen vita --ascii

# The background colour through track change / pause / scrub.
node tools/skincheck/cli.js samples/psp-label/skin.json --timeline

# Machine-readable.
node tools/skincheck/cli.js samples/psp-label/skin.json --screen vita --json

# The four worked examples in samples/REPORT.md, recomputed.
npm run report

# Every unit rule plus every sample.
npm test

# Every sample at every screen that matters.
npm run verify
```

`--track` picks one of the built-in tracks (`normal`, `no-artist`,
`long-title`, `cjk`, `empty`), so a sample can be seen with and without
tags.

## Where things live

| File | What it is |
|---|---|
| `lib/constants.js` | Every default and limit, transcribed from `SKINS.html`. |
| `lib/skin.js` | Parse, validate and convert `skin.json`. Degrades, never throws. |
| `lib/geometry.js` | Design → screen scaling, clipping, zero-size skipping. |
| `lib/text.js` | Field assembly and the missing-field separator rule. |
| `lib/metrics.js` | The fitting algorithm (three 12% steps, then `...`). |
| `lib/layout.js` | Area layout: centring, stacking, per-line clipping. |
| `lib/background.js` | Colour as a pure function of playing position. |
| `lib/playback.js` | The only state the background reads; no wall clock. |
| `lib/lifecycle.js` | Skin switching: release old picture and text, refuse stale work. |
| `cli.js` | The command above. |
| `verify.js`, `verify-all.js` | Expectations for the shipped samples. |
| `report.js` | Writes `samples/REPORT.md`. |
| `make-png.js` | Writes each sample's picture, at its declared size. |

## What it is not

The renderer. The font metrics here are a deterministic stand-in (`.`55 em`
for Latin, `1 em` for CJK) because the real numbers come from the console's
system font, which this cannot load. Everything else — the pixels, the caps,
the separator rule, the fitting steps, the colour at a position — is the rule,
not an approximation of it.

## The samples

Each folder under `samples/` is a complete skin: a picture named after the
folder and a `skin.json`. Copy one into `SKINS` on a machine and it works.

| Sample | Shows |
|---|---|
| `psp-label` | A PSP design: rects, sizes and the label across the top. |
| `vita-label` | A Vita design, which halves cleanly on a PSP. |
| `missing-artist` | The separator rule when a field has nothing. |
| `long-title` | Three widths, three shrinks, `...`. |
| `max-limits` | Nine areas, five lines, seven colours: the caps. |
| `edges` | Clipping on all four edges and zero-size skipping. |
| `broken-json` | A trailing comma: no text, black, no crash. |
| `oversize` | Past 32 KB: ignored whole, no text, black. |
| `step-background` | Four colours, `step`, `while: "always"`. |
| `no-text` | A skin with no areas at all. |

`npm run png` rewrites the pictures, sized from each skin's `design`.
