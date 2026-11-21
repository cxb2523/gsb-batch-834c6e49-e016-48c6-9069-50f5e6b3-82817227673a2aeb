# Changelog

## Unreleased

### Added
- **Day and night**: a button in the top card (and the N key) switches the town to daytime and back, with a short fade. Only for you, and remembered.
- **Mute** button next to "now playing" (and the M key): only for you, remembered, and the radio keeps playing in sync underneath.
- Chat **send** button (on phones it keeps the keyboard open).
- Play on phones: drag anywhere to walk (floating joystick, push to the edge to run), compact HUD, chat as a sheet behind a button with an unread dot, pause button, lighter shadows on touch devices.
- Name and trainer live together: a name field on the enter/pause screen, and "you: <name> ✎" moved from the chat header to the top card.
- Anti-flood per IP: at most 3 connections, chat budget shared across tabs, admin locked for 15 min after 5 wrong passwords (counted per IP, survives reconnects).
- Browser icon: the town's lamp post (`public/favicon.svg`).
- Progressive mute for chat spam (rate exceeded, or the same text 4+ times in a row): warning, then 15 s, 1 min, 5 min, 30 min.
- `npm test` (Node's built-in runner): local checks for the radio timeline and the player state machine, with made-up durations and commands — normal switches, late joiners, late durations, error skips, ended videos, single-track seeks and reconnect precedence.

### Changed
- Room limit raised from 40 to 100 players.
- A single room, `lobby`: `?room=` is gone and the server refuses other room names, so nobody can open extra rooms to run up the bill.

### Fixed
- **Radio stays in sync across a switch, a late join and a reconnect.** The room command now carries the playlist, the real track durations and the room's unplayable list, so every client computes the same track and second instead of counting an hour per unknown track; the server's snapshot replaces a stale local command on reconnect, so the room always wins.
- **Restarting a one-track playlist seeks** instead of being mistaken for "already playing that song".
- **Switching tracks clears the old cover and title** (and their timers), so the previous cover can't sit on top of the new video and the title can't label it.
- **Every recovery path converges:** admin switch, video ended, a duration arriving late and an embed error all resolve through the same function, so everyone lands on the same track and second. A track one tab can't play is reported and skipped for the whole room.
- Chat history scrolls to older messages; new messages only pull you down if you were already at the bottom.
- Long words without spaces now wrap in the chat bubble and history.

### Restored
- The original Twinleaf FBX town, its textures and the male/female trainer sheets are versioned and included in production again ([ADR 005](docs/adr/005-version-and-deploy-game-assets.md)).
- README artwork now uses a real gameplay screenshot and the architecture docs describe the bundled assets.

## v1 (2026-11-09)

Built in one evening, from a Paper mockup to a live multiplayer lobby. Decisions in [ADR 001](docs/adr/001-one-durable-object-per-room.md) to [ADR 004](docs/adr/004-original-art-in-the-repo-local-assets-ignored.md); design in [spec v1](docs/spec/v1.md).

### Added
- **2.5D town at night** in three.js: lamp posts that light the scene and cast dynamic shadows, animated water, collision with houses, fences, mailboxes and the pond.
- **Sprites that take the depth of their feet**, so objects in front cover the whole trainer and nothing behind cuts the head ([ADR 003](docs/adr/003-sprites-take-the-depth-of-the-feet.md)).
- **Original town and trainers** (male and female) generated in code; switch trainer any time with G.
- **Multiplayer**: one Durable Object per room with hibernating WebSockets ([ADR 001](docs/adr/001-one-durable-object-per-room.md)); name tags over every trainer.
- **Chat** with a bubble over the speaker; change your name in the game.
- **Synced radio**: everyone hears the same second of the same YouTube video; admin can restart or skip for the whole room ([ADR 002](docs/adr/002-radio-synced-by-the-clock.md)).
- **Security**: rate and size limits, origin check, player cap, constant-time admin password with few tries, cleaned input ([SECURITY.md](SECURITY.md)).
