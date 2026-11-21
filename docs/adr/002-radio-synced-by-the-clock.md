# ADR 002: Radio synced by a room command

| | |
|---|---|
| **Status** | Accepted (supersedes the first version of 2026-11-09) |
| **Date** | 2026-11-21 |
| **Deciders** | Yudi Ganeko |

## Context

Everyone in a room should hear the same second of the same song, and nobody controls it but the system (and an admin). The music comes from YouTube, which can't be streamed through our server.

The first version computed the position from a fixed date plus an admin `{ idx, at }` command, and each browser learned durations as videos loaded, counting unknown ones as one hour. That broke in three ways: a late joiner or a reconnecting client with no duration table walked the playlist with wrong lengths and started elsewhere; a cached local command could outlive (and override) the room's newest one after a reconnect; and a switch could leave the old track's cover and title over the new video. Restarting a single-track playlist was also a no-op ("it's already that video").

## Decision

The room's command is the whole state, and it is built to be enough on its own:

- **`{ v, idx, at, rev, playlist, durations, skipped }`.** `at` is the instant the track started, `rev` grows on every admin action, duration update and skip report so newer always beats older, `playlist` is the list the index refers to (the room's own), `durations` is the room's table of real track lengths learned from players, and `skipped` is the room's list of tracks it found unplayable (cleared by an admin action).
- **One resolver, shared by both ends.** `src/radio-model.js` is pure: given the command, the duration table and the current time it returns `{ idx, videoId, sec }`. The Worker and the browser import the same file, so "the same second" is one calculation, not two implementations that must agree.
- **Duration reports are hints.** A player sends the lengths it learned (`durations`); the server keeps only ids in its playlist, clamps the seconds, and the first report for an id wins. Late joiners then replay the same timeline instead of counting one hour per unknown track.
- **Every desync path converges.** `src/radio-core.js` funnels the admin switch, `ENDED`, a duration arriving late, an embed error and a reconnect through the same `sync()`; it only applies the difference (load another video, or seek the current one). The same video id at a different position is always a seek, which fixes restarts of a one-track playlist.
- **The server snapshot wins on reconnect.** On connect the Room sends its command with `snapshot: true`; the client applies it unconditionally, discarding any older local cache. A reconnect also holds incoming broadcasts until that snapshot has landed.
- **The HUD belongs to one track.** A switch clears the cover's timer, points the cover at the new thumbnail, clears the title and ignores iframe events from the video that is being replaced.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Host the audio and stream it** | Rights to the music, bandwidth, a media server. |
| **The server sends "play at X" events** | Late joiners and drift still need the clock; events alone add nothing. |
| **The client asks the server every second** | A round trip per second per player for something the clock already gives for free. |
| **One hour per unknown duration** | It is only a placeholder now; the difference is that it is no longer the only source, and it never overwrites a reported value. |
| **Let anyone pick from the list** | The point is a shared radio, not a jukebox fight. |

## Consequences

- Sync is within a few seconds, good enough for background music.
- The player must stay visible (YouTube terms), so it's a small TV in the HUD.
- **Videos that can't be embedded are skipped for the whole room.** The tab that hits the error reports it (`skip`), the room records it on the command, and every client counts that track as zero-length — so nobody is left on a different track because their tab happened to hit the error first.
- The command is self-contained, so the timeline can be replayed and verified offline: `npm test` covers normal switches, late joiners, late durations, error skips (per tab and room-wide), ENDED loops, single-track seeks and reconnect precedence with fake players and commands.
