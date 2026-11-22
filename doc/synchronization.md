# Synchronization chain

How the room keeps every member (including late joiners) on the same source,
playback state and position.

## Source switching

When a member loads a new source (`video:file`, `video:url`, `video:youtube`):

1. The room **fully unbinds the old `Video`'s events first** (`Room.unloadVideo`):
   the old source can no longer broadcast `play`/`pause`/`seek`/`stop` to the room.
2. The new `Video` is assigned **before** anything is broadcast and gets a
   monotonically increasing `version`. Any join that happens while the
   broadcast is in flight therefore snapshots this same version.
3. Existing members receive `video:<source>` (with `{ url, name, available, version }`)
   followed by `control:stop`, which **resets their playback state and position**
   to paused at `0`.

On the client, the player component is keyed by the source URL: switching
source unmounts the old `<video>` element (its listeners are removed and the
element is detached in `componentWillUnmount`) before the new source is bound,
so stale events from the old element never reach the room.

## Late joiner snapshot

When a member joins, the server sends a private snapshot **to the newcomer
only**, in this exact order:

1. `video:<source>` — the source (with its replayable address and availability)
2. `control:play` / `control:pause` — the playback state (with the current time)
3. `control:seek` — the position

The join may pause the room (existing "wait for the newcomer" behaviour); that
pause is broadcast to existing members **once, before the newcomer is
registered**, so the snapshot never triggers duplicate broadcasts to the room.

## Local files

A local file only exists in the sender's browser. To make it replayable:

1. The uploader POSTs the file to `/{room}/file` (see `Api.uploadFile`).
   The server stores it (`MediaStore`) and answers with a replayable address
   `/media/{room}/{id}` (served with CORS and HTTP range support for seeking).
2. The client announces the source with that address
   (`video:file { name, url }`). Registering the address on the current source
   is **not** a source switch: no reset is broadcast.
3. Late joiners (and other members) load the file straight from the server.

If the address is missing (upload pending/failed) or expired (404), the source
is flagged `available: false` and clients show an explicit "unavailable"
placeholder instead of a blank player. Non-HTTP(S) addresses (e.g. `blob:`)
are never accepted as replayable addresses.

Uploaded files are kept in memory and dropped when the room is destroyed.

## Concurrency

Source switches and joins are processed atomically (Node is single-threaded
and each handler is synchronous), and every `video:*` payload carries the
source `version`. Replaying a client's message log always converges to the
room's current version — source and progress can never belong to different
versions. This is covered by `test/room.test.mjs` and `test/e2e.test.mjs`.

## Tests

Run everything locally with:

```sh
npm install
npm test
```

- `test/room.test.mjs` — the sync chain: old-source events after a switch,
  reset broadcast, snapshot order and privacy, file-source availability,
  concurrent switch/join convergence.
- `test/codec.test.mjs` — `VideoCodec` wire format round-trips.
- `test/server.test.mjs` — upload/download endpoints, range requests, 404,
  cleanup on room destruction, CORS.
- `test/player.test.mjs` — client store: state reset on source change,
  unavailable flag, uploaded address lifecycle.
- `test/e2e.test.mjs` — full chain over real websockets and HTTP: join,
  snapshot, switch, upload, late-joiner loading the same file.
