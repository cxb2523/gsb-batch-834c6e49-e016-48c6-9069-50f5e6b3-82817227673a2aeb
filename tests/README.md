# Regression tests

```sh
npm ci
npx playwright install chromium
npm run test:security
```

The tests launch a local Vite server and run in one Chromium worker. All browser
requests to other origins are blocked. No media uploads or external services are
used. A local installed Chrome can be used instead with
`PLAYWRIGHT_CHANNEL=chrome npm run test:security`.

## `tests/security` — document security

The suite covers the sanitizer's HTML-only policy, preservation of ordinary DOCX
formatting, and the full `parseDOCX` boundary with a synthetic OOXML file containing
an unsafe hyperlink. The CI workflow also runs the production TypeScript/Vite build.

## `tests/webgl` — WebGL comparison state consistency

The suite verifies that the "effective media + mode" is the single source of truth
for the WebGL diff view:

- `comparisonState` helpers: playhead-based segment selection, A/B flip texture-slot
  mapping, and metrics context keys that invalidate on mode/flip/segment/threshold/ROI
  changes.
- `WebGLComparisonRenderer`: texture slots are invalidated and released when the
  active segment changes, so stale frames are never rendered as the new clip.
- Full-app flow (controlled generated images): metrics overlay waits for a fresh
  computation after A/B flip and segment jumps, the color picker's A/B semantics
  follow the picture across flips, and exported screenshots are annotated with the
  mode in effect at export time.
