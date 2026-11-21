# Track-menu 3D overview: interaction lifecycle — acceptance tests

The overview is the draggable, wheel-zoomable 3D track picture on the track-selection menu. Its interaction
state (heading, tilt, zoom, the drag in flight) is owned by `PreviewCtl` (`stunts/preview-ctl.js`), driven by
the page in `stunts/main.js` and rendered in `HiresView.renderPreview` (`stunts/hires-view.js`).

The interaction's lifecycle follows the picture's **real on-screen presence**, not the published frame flag:
each display frame `frame()` calls `view.setPreviewOnScreen(anyKey)` while a preview frame stands, where
`anyKey` means a see-through pixel of the overview is actually on screen. That one signal enters and exits the
interaction, so input can neither outlive the picture nor be refused while it is still there.

Automated coverage of the state machine (no game files or display needed):

```sh
node stunts/tools/test-preview-ctl.mjs    # lifecycle, drag, wheel, zoom geometry, self-turn, tilt, frame gating
node stunts/tools/smoke-preview-ctl.mjs   # the IIFE loads as index.html loads it, on a browser-like global
```

The manual steps below need a Stunts 1.1 copy (the site or the desktop app) and reach the track menu:
title screen → main menu → **Let's Drive** → drive/opponent choices → the track-selection menu with the 3D
overview. Coordinates use the 4:3 picture as x/y in 0..1; the overview band is roughly y = 0.10…0.82 (title
above, menu buttons below).

---

## A. Normal paths

### A1. Enter the menu at the default view, every time
1. From the main menu choose **Track** (or reach the track menu any way) and wait for the overview.
2. Note the framing: default heading, tilt and zoom, then the slow self-turn.
3. Drag horizontally to rotate ~90°, drag vertically to tilt, and wheel-zoom in several notches.
4. Press **Esc** / choose **Back** to leave for the main menu; do anything else there for a few seconds.
5. Re-enter the track menu.
   **Expect:** the overview is back at the exact default heading/tilt/zoom of step 2 — none of step 3's
   rotation or zoom is inherited — and self-turn starts again from the default heading.

### A2. Restarting a game does not carry the view over
1. On the track menu rotate and zoom the overview.
2. Start a race, then open the race menu (**Esc**) and choose to restart / quit back to the menus.
3. Return to the track menu.
   **Expect:** default framing again; the previous visit's drag and zoom are gone.

### A3. Drag rotates and tilts only while the pointer is on the visible picture
1. Press the mouse button down on the overview (y inside 0.10…0.82, on the track picture) and drag left/right:
   the track rotates; drag up/down: it tilts.
2. Keep the button held and drag over the title strip or the buttons strip (outside the band): rotation stops
   following; the drag is not treated as a click on those buttons.
3. Release over the picture. The view stays where left and the slow self-turn resumes from there.
   **Expect:** heading changes only while the held pointer is on the overview's band; releasing leaves a
   stable view; buttons are never activated by an overview drag that passes over them.

### A4. The wheel zooms the overview, with limits
1. With the pointer over the overview, scroll the wheel up (zoom in) repeatedly, ~20 notches.
   **Expect:** the view eases closer and stops at a near limit — the whole track is still visible and the
   camera never enters or passes through a piece of track.
2. Scroll down (zoom out) repeatedly.
   **Expect:** it eases back and stops at a far limit; the track never shrinks away or disappears.
3. While zooming, the page behind does not scroll (there is no page scroll, and no list moves).

### A5. Self-turn pauses while held and resumes after release
1. Let the overview sit: it turns slowly on its own.
2. Press and hold on it without moving: self-turn stops for as long as the button is held.
3. Release: self-turn resumes from the current heading.

---

## B. Boundary / edge paths

### B1. Releasing outside the picture ends the drag
1. Press on the overview and begin a drag.
2. Still holding the button, move the pointer outside the browser window / off the 4:3 picture, then release.
3. Move the pointer back over the overview (no button pressed) and move it around.
   **Expect:** after the release the view does not follow the pointer at all; coming back does not resume any
   drag. The game's mouse button reads up.

### B2. Moving out of the picture while held ends the drag (not merely pauses it)
1. Press on the overview and drag to start rotating.
2. Keep the button held and move the pointer outside the picture's rectangle.
3. Still holding, move back inside and continue moving.
   **Expect:** rotation stops the moment the pointer leaves (step 2) and does **not** resume on re-entry
   (step 3). A fresh press is required to drag again.

### B3. Pointer cancellation and window focus loss release everything
1. Press on the overview and hold a drag.
2. Switch to another application (Alt-Tab / click another window), or on a touch device interrupt the gesture
   so the browser fires `pointercancel`.
3. Return to the game window and move the pointer over the overview without pressing.
   **Expect:** no rotation follows the pointer; `pointer.drag` is released and the game's mouse button is up.
   Starting a new drag works normally.

### B4. A dialog over the overview: the hidden picture takes no input
1. Open the game's track picker (the dialog that lists tracks) over the overview.
2. With the dialog covering the picture, press-drag where the overview was and move the pointer around.
   **Expect:** the 3D view behind the dialog does not rotate or tilt; all presses belong to the dialog.
3. Close the dialog. The overview is visible again.
   **Expect:** it accepts drags again immediately — no refusal while the picture is on screen — and starts
   from the default view (the covered interval was a lifecycle exit; reopening is a fresh enter).

### B5. Wheel over a dialog list scrolls the list, never zooms
1. Open the track picker so its list is shown over the overview.
2. Hover over the list area and scroll the wheel several notches.
   **Expect:** the list scrolls one line per notch (same as the Up/Down arrows); the 3D overview's zoom does
   not change.
3. Hover over the overview itself (visible around/outside the dialog) and scroll.
   **Expect:** the overview zooms and the list does not scroll. The two never respond to the same notch.
4. Hover over the title or the menu buttons (neither overview nor list) and scroll.
   **Expect:** nothing happens — no zoom, no scroll, and the default wheel action is not prevented elsewhere.

### B6. Import/Export dialog owns the wheel and the keys
1. On the track menu open the page's **Import/Export** dialog (`#trkio`).
2. Scroll inside its text box and type.
   **Expect:** the text box scrolls/edits normally; the overview neither zooms nor rotates; no key reaches
   the game. Close it; overview input works again.

### B7. Visibility transitions cannot leave the interaction stuck
1. With a drag held, open any dialog that covers the overview (or trigger a screen change) without releasing.
2. Close it and release the button.
3. Re-enter the track menu from the main menu.
   **Expect:** no carried-over drag on the fresh menu; default framing; first press behaves as a new drag.

### B8. Tilt is bounded however hard the drag pulls
1. Press on the overview and drag straight upward repeatedly, far past the top of the picture.
   **Expect:** tilt stops at the upper bound (never edge-on/overhead). Drag downward repeatedly: it stops at
   the lower bound (never below the horizon band). The view remains usable at both ends.

### B9. Rapid enter/exit and wheel/drag interleaving
1. Quickly alternate opening the track picker and closing it several times, scrolling the wheel and dragging
   between each.
   **Expect:** every open freezes input and every close restores it with a default view; at no point does a
   wheel notch both scroll and zoom, and no exception appears in the console.

---

## What proves each requirement

| Requirement | Automated | Manual |
| --- | --- | --- |
| Enter at default; leave releases; re-entry inherits nothing | test 1, test 5 | A1, A2, B7 |
| Drag only while visible and pointer is on the picture | test 2 | A3, B4 |
| Pointer leaving / release / cancel / blur ends the drag | test 2 (`release`, exit drops in-flight drag) | B1, B2, B3 |
| Wheel zooms on overview; list scrolls over dialog; never both | test 3 (inactive ignores wheel) | B5, B6, B9 |
| Zoom has near/far limits and never enters the track | test 3, test 4 | A4 |
| Tilt bounded | test 6 | B8 |
| Visibility judgment matches the picture on screen | test 7 (`frame()` null off-screen) + `setPreviewOnScreen(anyKey)` | B4, B7, B9 |
