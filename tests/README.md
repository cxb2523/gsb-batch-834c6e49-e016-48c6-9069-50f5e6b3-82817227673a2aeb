# Engine lifecycle tests

Browser tests for the source-request lifecycle and the lookahead true-peak limiter. They run the
real `js/engine.js` and `js/limiter-worklet.js`; only the stretch worker is replaced by a
controllable fake so render timing can be injected.

## What they cover

`lifecycle.html` / `lifecycle.js`
- Rapid successive song changes against a slow worker: only the last pick is ever played.
- A render whose request was cancelled but that answers late anyway ("orphan" reply): the engine
  drops it on the request-id guard; it never becomes a buffer or a source.
- Clearing a layer cancels its request, disconnects its nodes and frees its buffers; reselecting
  afterwards renders and plays normally.
- A tempo change re-renders all three layers atomically — no half-new/half-old snapshot, the clock
  follows to the new tempo.
- A key change re-renders every layer and converges them on the one master tonic (the
  relative-minor merge rule is asserted unchanged).
- BS.1770 loudness alignment: each render carries a finite trim and a finite integrated LUFS.

`limiter.html` / `limiter.js` (offline `OfflineAudioContext`, fully deterministic)
- A near-0 dBFS transient inside the first lookahead window after a reset stays under -1 dBTP,
  including transients at every position across the first quantum and its 128-sample block boundary.
- A reset pre-fills the delay line, so it opens no long silence.
- A reset re-initializes the gain envelope to unity (no inherited reduction / pumping), verified by
  reading the worklet's own gain state over a ping message; the reset path never exceeds the ceiling.

## Running

```sh
npm test          # builds the synthetic fixtures, serves the repo, runs both suites headlessly
```

`npm test` runs `make-fixtures.mjs` (writes two short synthetic stems and a manifest into
`fixtures/`, which is gitignored) and then `run-all.mjs`, which starts `serve.mjs` and drives the
browser over the DevTools protocol with the zero-dependency `run-tests.mjs`.

The runner uses Microsoft Edge's classic headless mode by default (Chrome 157 on this host rejects
a custom `--user-data-dir` in headless). Set `CHROME_BIN` to another Chromium executable to
override. A server already running on another port can be targeted directly:

```sh
node tests/run-tests.mjs http://localhost:8137
```

## Seams

- `engine.setWorkerFactory(fn)` replaces the stretch `Worker` constructor; the app's default builds
  the genuine worker, so production behavior is unchanged.
- The limiter worklet accepts a test-only `processorOptions.resetAt` so an offline render can arm a
  reset at an exact time (a live context instead posts `{type:'reset', at}` through the node port),
  and answers a `ping` with its current gain state.
