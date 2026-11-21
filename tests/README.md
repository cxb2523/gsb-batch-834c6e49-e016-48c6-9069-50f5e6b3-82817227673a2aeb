# Playback-session lifecycle tests

Automated reproduction of the playback-session races (Bluetooth headset
unplug, system suspend/resume, episode switching from the drawer). The suite
loads the **real** `server/js/core/player.js` and `server/js/screen/video.js`
into a `vm` sandbox with a fake DOM, fake `<video>` elements (with
`setSinkId`/`currentTime` spies), and stubbed `dashjs` / `session` / `fetch`,
so no Electron, network or Crunchyroll account is needed.

Run:

```sh
npm test          # node --test "tests/**/*.test.js"
```

The suite takes ~12s because the 450ms/1500ms rebind timers and the
450ms+1600ms watchdog stages run on real timers.

## What is covered and how it is triggered

| Scenario | Trigger simulated in test | Expected |
|---|---|---|
| Stale rebind after episode switch | `devicechange` under ep1 (schedules 450/1500ms timers) + an in-flight `rebindAudioOutput()` blocked in `enumerateDevices`, then `play()` for ep2, then timers expire / promise resolves | Old `<video>` gets **no** `setSinkId` and no micro-seek; new element untouched |
| Single in-flight rebind | Two `rebindAudioOutput()` calls back-to-back | Same promise returned, `enumerateDevices` called once; after settle a new rebind may start |
| Recovery rate limit per session | 2 recoveries under ep1 (3rd rejected), replay same episode, then switch to ep2 | Same-episode replay stays limited; ep2's **first** recovery is allowed |
| Watchdog stage guards | Start watchdog, then remove `#video-screen` (or bump `_playSeq`) before the 450ms/1600ms stages fire | No rebind, no recovery |
| Watchdog positive control | Stalled audio (`currentTime` advances, `webkitAudioDecodedByteCount` frozen) in an intact session | Pass 1 rebinds (`setSinkId` cycle), pass 2 triggers stream recovery |
| DRM ordering + DELETE 500 | `video.play()` with a pending old-session token; `fetch` DELETE answers HTTP 500 | DELETE of old token settles **before** the new stream request; failure is logged, `drmLock` released, new episode reaches `BUFFERING` then `PLAYING`; its own token is released on playback start |
| DELETE network failure | `fetch` rejects | `drmLock` released, error callback invoked, warning logged |
| Late `session.refresh` callbacks | Two `play()` calls, then fire the first call's refresh callback late | Stale success/error dropped by seq (no `attachSource`, no recovery); `RequestModifier` uses the **live** `session.storage.access_token` |

## Source invariants under test

- `player._playSeq` increments on every `player.play()`; it is the playback
  session id. Rebind steps, watchdog stages and refresh callbacks capture it
  and no-op when it moved on.
- `video._playReqId` increments on every `video.play()`; the stream request
  for a superseded reqId is never issued.
- `video.releasePendingSession()` returns a never-rejecting promise (2.5s
  safety cap) that settles when the old token's DELETE settles; `video.play()`
  awaits it before calling `service.video_v2`.
- `player.deleteSession()` always releases `player.drmLock` and always calls
  a terminal callback, even on HTTP 4xx/5xx or network errors.
- The recovery rate limit (`_recoveryTimestamps`, 2 per 30s) resets when the
  episode id changes, not when the same episode is replayed by a recovery.
