# Verifying a skin locally

Everything below is produced by `tools/skincheck` from the files in `samples/`. No dependencies beyond Node 18+. Regenerate with `npm run report`; check with `npm test`.

```
npm test                 # every unit rule + every sample
npm run verify           # every sample at every relevant screen
node tools/skincheck/cli.js samples/psp-label/skin.json --screen vita --ascii
```

## 1. A PSP design rendered at Vita size

`samples/psp-label/skin.json` declares `"design": "psp"`. At 960 × 544 every pixel quantity is multiplied by two.

| | design (480 × 272) | Vita (960 × 544) |
|---|---|---|
| area 1 rect | `[91, 31, 263, 22]` | `[182, 62, 526, 44]` |
| area 2 rect | `[91, 58, 263, 16]` | `[182, 116, 526, 32]` |
| area 3 rect | `[400, 240, 70, 22]` | `[800, 480, 140, 44]` |
| text size | 11, 12, 12 | 22, 24, 24 |
| line gap | 2 | 4 |

Laid out at Vita size:

```text



               |----Power, Corruption & Lies: New Order---|

               |----------------Blue Monday---------------|













                                                                   |---------|
                                                                   |-------3/.

```

The reverse also holds — a Vita design on a PSP halves (`samples/vita-label`):

| rect (screen px) | text colour | lines |
|---|---|---|
| `[62, 18, 356, 22]` | #101010 | 1 |
| `[62, 44, 356, 20]` | #101010 | 1 |
| `[62, 68, 356, 30]` | #101010 | 2 |

## 2. A track with no artist tag

`samples/missing-artist/skin.json` prints `["album", ": ", "artist"]`, `["Side A · ", "title"]` and `["artist", " — ", "album"]`. The track is `samples`' "no-artist" track: album *Basement Tapes*, title *Untitled Demo*, no artist.

| text | x, y | size | shrink | truncated |
|---|---|---|---|---|
| `Basement Tapes` | 190, 21 | 13 | 0 | no |
| `Side A · Untitled Demo` | 161, 36 | 13 | 0 | no |
| `Basement Tapes` | 190, 51 | 13 | 0 | no |

The colon disappears because a separator survives only when both fields on either side have text. `"Side A · "` survives because it is followed by a title that exists; with no title, the whole line would be empty and be skipped.

## 3. A title too long for its area

The same title at three widths. Each line is offered at `size`, then 0.88×, 0.88²×, 0.88³× before it is cut with `...`.

| text | x, y | size | shrink | truncated |
|---|---|---|---|---|
| `The Rise and Fall of Ziggy Stardust and the Spiders from Mars (2012 Remas...` | 40, 45 | 9.54 | 3 | yes |
| `The Rise and Fall o...` | 40, 95 | 9.54 | 3 | yes |
| `The Rise and Fall of Ziggy Stardust and the Spiders from Mars (2012 Remas...` | 40, 147 | 9.54 | 3 | yes |
| `David Bowie — The Rise and Fall of Ziggy Stardust and the Spiders from Mars` | 40, 159 | 9.54 | 3 | no |
| `The Rise and Fall of Ziggy Stardust and the Spiders from Mars` | 40, 171 | 10.84 | 2 | no |

The 400 px area still ends in `...` after three shrinks because the title is much too long; the 120 px one is visibly shorter. A line only gets smaller if that makes it fit — a step that does not is not taken.

## 4. Background colour under track change, pause and scrub

### `samples/psp-label` — three colours, 6 s each, fade, while `playing`

#1B0B3A → #0B3A5C → #0B5C3A · 6s each · fade · while `playing`

| step | position | paused | colour |
|---|---|---|---|
| track starts | 0.00 | no | `#1B0B3A` |
| half way to colour 2 | 3.00 | no | `#13234B` |
| middle of colour 2 | 9.00 | no | `#0B4B4B` |
| scrub forward to 30s | 30.00 | no | `#0B5C3A` |
| scrub back to 3s | 3.00 | no | `#13234B` |
| paused (while=playing) | 3.00 | yes | `#1B0B3A` |
| scrub while paused to 2.5 colours | 15.00 | yes | `#1B0B3A` |
| resumed | 15.00 | no | `#13343A` |
| track changes (position 0) | 0.00 | no | `#1B0B3A` |

### `samples/step-background` — four colours, 10 s each, step, while `always`

#FF0000 → #00FF00 → #0000FF → #FFFF00 · 10s each · step · while `always`

| step | position | paused | colour |
|---|---|---|---|
| track starts | 0.00 | no | `#FF0000` |
| half way to colour 2 | 5.00 | no | `#FF0000` |
| middle of colour 2 | 15.00 | no | `#00FF00` |
| scrub forward to 30s | 30.00 | no | `#FFFF00` |
| scrub back to 3s | 3.00 | no | `#FF0000` |
| paused (while=always) | 3.00 | yes | `#FF0000` |
| scrub while paused to 2.5 colours | 25.00 | yes | `#0000FF` |
| resumed | 25.00 | no | `#0000FF` |
| track changes (position 0) | 0.00 | no | `#FF0000` |

With `while: "always"`, pausing *and then scrubbing* still moves the colour, because the colour follows the position, not the clock. With `while: "playing"` a pause shows the first colour whichever position it is paused at.

## 5. Degradation

`samples/broken-json/skin.json` has a trailing comma. Loaded at any size it yields no text and a `#000000` background, and no exception.

```
degraded: true
reason:   invalid-json: Unexpected token ']', ..."t"]] },
  ]
}
" is not valid JSON
areas:    0
background: #000000
```
