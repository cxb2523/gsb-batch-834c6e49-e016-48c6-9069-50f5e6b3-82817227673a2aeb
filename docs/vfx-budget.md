# Battle VFX budget and map-render cache

Two cross-cutting rendering concerns, one shared knob each.

## Per-frame draw budget (`G.fxBudget`, `src/art/vfx.js`)

The battle's effect list (`BattleScene.fx`) and the overworld's ambient particle pool (`src/art/ambient.js`) both
report into **one observable per-frame number**, `G.fxBudget.live`. Only one of them draws on a given frame (the
battle scene is opaque, so the field below it is not drawn), so whichever reports a frame owns the budget:

| field | meaning |
|---|---|
| `live` | live entries in the last reported frame (battle effects or field particles) |
| `battle`, `field` | which owner the last frame belonged to (the other reads 0) |
| `peak` | highest battle `live` since the last `resetBattle()` |
| `particles`, `essential`, `effects` | breakdown of the last battle frame |
| `dropped`, `droppedParticles`, `frames` | session diagnostics; deliberately **not** reset by `resetBattle()` |
| `cap` | max live battle effect entries per frame (default 96) |
| `fieldCap` | max live ambient particles per field frame (default 64) |

### Enforcement (battle)

`BattleScene.draw()` calls `G.vfx.frame(this)` before it walks the effect list. That pass:

1. retires particles that drifted off the 320×180 frame (their slot is spent either way);
2. while the list is over `cap`, drops the **oldest decorative** entries first.

Entries created by `G.vfx.particle()` are tagged `fxParticle`. `G.vfx.impact()` (the hit-feedback flash and its
sparks) and everything `G.vfx.status()` / `G.vfx.stat()` spawn are tagged `fxEssential`. The cap never removes an
essential entry, so hit feedback and status animations survive even a pathological pile of them. To force pressure
from a script or a test, set `G.fxBudget.cap = n` before the battle.

### Reset on battle teardown

`BattleScene.dispose()` runs `resetTransient()` (offsets 0, tint null, vis/clip/scale 1, screenFx null, flash 0) and
`G.vfx.endBattle()`, which zeroes the battle's `live`, `battle` and `peak`. `engine.pop()` calls `dispose()` on any
`isBattleScene` scene, and `runBattle()` calls it in a `finally`, so a cancelled battle (task killed, exception,
early `finish`) never leaves state or budget for the next one. `vfx.move` also resets the acting and target slot and
the screen-level fields in a `finally`, so a closed招式 coroutine cannot strand a displaced / tinted / scaled sprite.
`faint` / `withdraw` / `flee` / `substitute` / `transform` carry their own `finally` for the same reason: a battle that
ends or switches mid-transition leaves the sprites at rest.

## Map render cache (`src/game/maprender.js`)

`Overworld.load()` keeps only the map on screen and its connections (`mapRender.evict(keep)`). Eviction is a real
release, not just a `delete` of the table entry:

- `release(R)` empties `anim` / `interiorAnim`, `fires`, `lights`, drops the `wmask` / `wdist` masks and the `gcell`
  index, and nulls the two `Surface`s; `R.released` is set so a stale holder can see it.
- `evictOne(name)` does the same for one map (used by field moves that mutate a map's grid and rebuild it).
- Neighbour borders are sampled while a map is being built, so they are part of that map's surface; dropping a
  neighbour's cached render does not invalidate the map still on screen.
- A render evicted while still being built asynchronously is thrown away instead of written back into the slot.

Each render carries its own animation clock, `R.phase`. It starts at 0 on build and only advances while that render
is the one animating, so an evicted-and-rebuilt map starts its flowers / tall grass / water phase from zero.

## Checking it

```sh
node tools/fxbudgetcheck.js            # all checks, exit 1 on failure
node tools/fxbudgetcheck.js --verbose  # per-frame sampling detail
```

The script covers A (budget under blizzard load, peak ≤ cap, hit feedback on every impact frame), A2 (essential
preservation in one frame), B1 (move coroutine cancelled mid-animation), B2 (battle forced to end mid-animation,
then a fresh battle), B3 (a flee ending, then a new battle), B4 (faint / withdraw / flee / substitute cancelled
half-way), C (two-map eviction loop, released resources, phase restart).
