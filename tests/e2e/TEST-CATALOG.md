# E2E test catalog

## Super Blocks core journey

**File:** `specs/game.spec.ts`

| Journey | Acceptance |
| --- | --- |
| Game home | `/` directly shows the menu, modes, ranking, settings, and rules. |
| Classic scoring | A deterministic opening can complete a line and persist score 18. |
| Session restore | Refresh and returning to `/` resume an unfinished game. |
| Settled clear restore | Refreshing during the clear animation restores the settled board and score without replaying the animation, and the board stays playable. |
| Settings during clear | Leaving for settings mid-animation and returning keeps the settled state and releases the placement lock. |
| Consecutive clears | Two clears in a row each settle exactly once, and the level-2 combo sound plays together with the second clear sound. |
| Settled game over restore | Refreshing during a game-ending clear animation restores the finished game with its result dialog. |
| Muted playback | Disabled sound and music produce no audio playback at all. |
| Preferences | Language, music, sound, and reduced motion persist independently. |
| Best scores | The score page summarizes the overall, classic, and daily best scores stored on the device. |
| Assets and routing | Required audio is served and invalid modes redirect to `/`. |
