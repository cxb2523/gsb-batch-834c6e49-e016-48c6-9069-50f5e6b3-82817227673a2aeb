# Spectate lifecycle: eliminated → spectating → reconnect / replay

A 20-player free-for-all ends for 19 of its 20 players on elimination, and
each of them keeps watching. That transition used to be smeared across
three places that did not share a notion of "which match am I in any
more": the frame transform decided when to turn the camera on, `NetMatch`
decided when to stop predicting, and the replay viewer had no survival
notion at all. The symptoms were all the same class of bug — state from one
match generation leaking into the next:

- camera jumps when the spectator target was chosen from a stale roster;
- the "this is you" pointer and hit-shake attention staying on an
  eliminated fighter;
- a direction still held at the moment of a KO "resuming" after a
  reconnect with no new keystroke behind it;
- unacked inputs from before a reconnect replayed into the freshly
  rebuilt prediction sim (the `localTick` drift in
  `docs/`'s reconnect notes was one visible effect);
- two spectator key listeners alive at once after a re-entry, each
  advancing the follow target, which reads as the camera drifting or
  jumping two survivors per Tab;
- replay/spectate cycling offering the recording's **final** roster
  instead of whoever was alive at the tick being shown.

The fix is one explicit **session generation** shared by every piece of
lifecycle state, plus a spectator controller that owns its own
registration lifetime.

## The generation model

`packages/app/src/spectator/session.ts` — `SpectateSession`.

| Concept | Meaning |
|---|---|
| **generation** | Monotonic token. `startGeneration(slot)` begins a new one (fresh join, resumed reconnect, new match); `invalidate()` ends the current one (leave, teardown, lost seat). |
| **frozen seat** | This seat may never again collect, submit or predict input *for this generation*. Permanent even if the mode later revives the fighter (Stocks/Timed Brawl respawn). |
| **pending input** | Locally sampled inputs newer than the server's last ack. Cleared whenever the generation changes or the seat freezes. |

Every mutating method takes the caller's generation token and rejects a
stale one rather than applying it:

```ts
session.acceptsLocalInput(gen)   // false for stale gen, spectating, or frozen seat
session.recordInput(gen, t, f)   // buffered only if the above is true
session.takePendingInputs(gen, ackedTick) // [] for a stale gen (discard, not replay)
session.beginSpectating(gen)     // false for a stale gen
```

That is what makes "rebuild by generation" literal: a late `eliminated`
message, a snapshot from a superseded connection, or an input recorded
before a reconnect cannot act on the generation that replaced them.

## Where each rule is enforced

### 1. Elimination freezes the seat and hands back prediction

- **Local (`packages/app/src/match.ts`)**: `tick()` calls
  `freezeEliminatedLocalSeats()` immediately after `sim.advance()`. The
  first sim state that reports a local seat eliminated is the last state
  that seat may affect, so the freeze is tick-exact — even a catch-up burst
  of several ticks inside one animation frame cannot slip another input in.
  Freezing also calls `InputManager.releaseAll()`, so keys held at the KO
  do not "resume" later.
- **Local input assembly (`local-crowd-bots.ts`)**: `buildTickInputs` takes
  a frozen-seat set and forces a **neutral** frame for those slots, no
  matter what the poll returned on that tick. It is the last gate before
  `Sim.advance()`, so it holds even for an adversarial caller.
- **Online (`packages/app/src/net-match.ts`)**: the `eliminated` control
  message freezes the seat, clears the unacked window, and releases held
  input. `tick()` and the snapshot reconciliation both gate on
  `session.acceptsLocalInput(...)`, so from then on the local fighter
  contributes a neutral frame locally and **nothing** goes on the wire —
  `encodeInput` is inside the same gate.
- **Input sampling (`packages/input/src/index.ts`)**: `pollSlots(n)` samples
  only the slots still allowed to act (0 when no seat is live) and always
  clears the keyboard's per-poll tap set, so a tap made while frozen can
  never leak into a later tick. `releaseAll()` forgets held keys.

### 2. The spectator camera takes over, and cycles living fighters

`packages/app/src/spectator/controller.ts` — `SpectatorController`.

- `beginGeneration(token, initialView?)` drops the follow target, mode,
  scratch buffers and camera smoothing state, and makes the next frame
  **snap** to its target rather than glide in from the previous match.
  Generations only move forward.
- `activate(token)` is idempotent per generation; a stale token cannot
  turn the camera on. The follow target is chosen from
  `survivorIndices()` (live) / `survivorIndicesAt(tick)` (replay) and
  never from the local seat.
- On every frame the current target is re-validated against **that
  frame's** survival set, so a target that just died is replaced and a
  replay scrubbed backwards can legitimately make an old target
  selectable again.
- `cycleNext()` walks only living fighters and wraps.
- `attachKeys(source, { shouldIgnore })` registers the Tab/O shortcuts on
  the controller itself. Re-attaching **replaces** the previous
  registration instead of stacking, and `release()` removes it. The global
  keydown handler in `main.ts` no longer handles Tab/O — that duplication
  was the two-listeners-one-keypress bug.
- `release()` also drops the scratch buffers and the target, and is
  idempotent, so exit, reconnect and rematch teardown can all call it.

### 3. Reconnect rebuilds by generation and discards the old one

- `NetMatch.startMatch()` (which runs for a fresh join **and** a resumed
  reconnect) calls `session.startGeneration(slot)` and clears the input
  history in the same place it rebuilds both Sims. Prediction replay then
  reads only the new generation's window.
- `main.ts`'s online frame transform compares the controller's generation
  to `NetMatch.sessionGeneration()` and calls `beginGeneration` on a
  mismatch — the camera does not carry a target across the reconnect.
- `NetMatch.stop()` invalidates the session, clears history and releases
  input, so a `NetMatch` superseded by the next requeue cannot leave
  anything behind.
- Both `beginMatch()` and `beginOnlineMatch()` call `releaseSpectator()`
  before constructing a new match, so no listener or buffer survives a
  rematch.

### 4. Replay uses the survival set of the tick being shown

- `packages/app/src/spectator/replay-adapter.ts` — `ReplayMatchAdapter`
  answers `survivorIndicesAt(frameIndex)` from the captured roster of the
  frame the viewer is currently on.
- `packages/app/src/replay/replay-viewer.ts` points the adapter at the
  current frame **before** computing the camera each render, so cycling
  and auto-retargeting always see that frame's roster, and releases the
  spectator on `destroy()`.

`MatchAdapter` (in `spectator/types.ts`) keeps `survivorIndicesAt?` and
`liveArenaBoundsAt?` optional: live adapters (`SimMatchAdapter`,
`SnapshotMatchAdapter`) only ever move forward and omit them.

## Local verification

### Unit / regression tests

```sh
node scripts/run-tests.mjs packages/app/test/spectator-lifecycle.test.ts
node scripts/run-tests.mjs packages/app/test/spectate-freeze-input.test.ts
```

- `spectator-lifecycle.test.ts` — the session's generation rules, freeze
  permanence, stale-token rejection, controller activation/cycling/snap,
  single-registration key handling, release idempotency, and the replay
  adapter's per-frame survival answers.
- `spectate-freeze-input.test.ts` — a real 20-fighter `Sim`: a frozen seat
  contributes a neutral frame even when the poll returns a held key; other
  seats are byte-identical; no frozen-seat input reaches the sim even from
  an adversarial caller.

### Headless end-to-end harness

```sh
node scripts/spectate-lifecycle-harness.mjs           # seed 1234
node scripts/spectate-lifecycle-harness.mjs --seed=7 --seat=0 --ticks=4000
```

Runs a real 20-fighter crowd match with the same seed/characters/bots the
`?crowd20=1` harness uses, drives the same helpers `Match.tick()` drives,
and asserts the whole lifecycle in order: tick-exact freeze with a
held-right poll, camera follows a living fighter, cycling stays on
survivors and wraps, a reconnect discards the old generation's unacked
input and the stale token cannot write, replay cycles over the first
frame's survivors (not the final roster), and release removes the single
key registration. Exit code is 0 only if every check passes.

### In the browser (`?crowd20=1&seed=…`)

The local harness plays one seat among a 20-fighter bot field. Add
`seat=<n>` to put the controlled seat into the crowd so it can actually be
eliminated while the field plays on:

```
http://localhost:5173/?crowd20=1&seed=1234&arena=the-atoll&seat=7
```

What to look for, all locally reproducible without a server:

1. Play until your seat is eliminated (the HUD shows `OUT · <placement>`).
   The camera hands over on the same tick — it should snap to a living
   fighter, not glide in from your old position, and the "this is you"
   pointer should disappear rather than stay on your corpse.
2. `TAB` cycles only living fighters, one per press (no double-jumps).
   `O` toggles the arena overview. No key held before the KO should still
   be moving anything.
3. Escape to the start screen and start the same match again: the camera
   starts framed on the new match, not where the spectator left off, and
   `TAB` still advances exactly one fighter per press (one registration,
   not two).
4. `?crowd20=1` with the default two seats: after player 1 is out, player
   2's keyboard controls still work — freezing is per seat, not per
   harness.
5. Replays (start screen → Replays → the 20-fighter fixture): the camera
   follows a fighter and cycling works; scrub back to the start and cycle
   again — every fighter is selectable again because that tick's roster
   still had them alive.

Determinism is untouched: no `packages/sim` file changed. Everything here
is input assembly, presentation and lifecycle bookkeeping.

## Files changed

- `packages/app/src/spectator/session.ts` *(new)* — the generation token,
  freeze set and unacked-input window.
- `packages/app/src/spectator/controller.ts` — generation-scoped
  activate/beginGeneration/release, per-tick target validation, owned key
  registration, snap-on-generation-change.
- `packages/app/src/spectator/types.ts` — optional `survivorIndicesAt` /
  `liveArenaBoundsAt` for replay adapters.
- `packages/app/src/spectator/replay-adapter.ts` *(new)* — per-frame
  survival for replays.
- `packages/app/src/spectator/net-adapter.ts` *(new)* — `MatchAdapter` over
  live snapshot rosters (online spectating).
- `packages/app/src/replay/replay-viewer.ts` — spectator camera over the
  recorded frames; releases on destroy.
- `packages/app/src/match.ts` — `SpectateSession`, tick-exact local freeze,
  `localSeats`, local-slot-aware render frame and danger cue, teardown
  invalidation.
- `packages/app/src/local-crowd-bots.ts` — `buildTickInputs` frozen-seat
  argument.
- `packages/app/src/net-match.ts` — session-gated input/prediction,
  generation rebuild in `startMatch`, freeze at `eliminated`,
  `transformFrame` hook, spectator roster accessors, teardown invalidation.
- `packages/app/src/main.ts` — `releaseSpectator()`, `?seat=` narrowing,
  spectator wiring for local and online matches, Tab/O moved onto the
  controller.
- `packages/input/src/index.ts` — `pollSlots(n)` and `releaseAll()`.
- `packages/render/src/spectator-camera.ts` — no parameter property (so the
  lifecycle tests can import it under `node --test`).
- `packages/app/test/spectator-lifecycle.test.ts` *(new)*,
  `packages/app/test/spectate-freeze-input.test.ts` *(new)*,
  `packages/app/test/net-match-session-telemetry-wiring.test.ts` (updated
  for `pollSlots`).
- `scripts/spectate-lifecycle-harness.mjs` *(new)* — the runnable local
  verification above.
