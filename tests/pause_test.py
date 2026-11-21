# Pause-system browser tests for Spike Sprint (index.html).
#
# Covers the four chains required of the pausable game clock:
#   1. Pause freezes everything (score, clock, speed multiplier, barrel chase,
#      player physics, HUD) and blocks jump input + new sfx.
#   2. Resume does not back-fill background wall-clock time (no frame jump).
#   3. Game over / restart clears pause state and resets the run to baseline
#      while the high score survives.
#   4. Page visibility change (tab to background) pauses; returning to the
#      tab does NOT auto-resume.
#
# Each chain runs on a freshly reloaded page and keeps its un-paused playing
# time short, because the test never jumps: the first spawned obstacle would
# otherwise kill the player after ~2.5s and break the scenario preconditions.
#
# Run locally:
#   pip install playwright
#   playwright install chromium
#   python tests/pause_test.py
#
# Exit code 0 = all scenarios passed, 1 = failure (details on stdout).

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

GAME_URL = (Path(__file__).resolve().parent.parent / "index.html").as_uri()

STATE_JS = "window.__spikeSprint.getState()"


def get_state(page):
    return page.evaluate(STATE_JS)


def set_visibility(page, state):
    """Force document.visibilityState and fire the event (self-made
    background/foreground scenario — a headless tab never really hides)."""
    page.evaluate(
        """(state) => {
            Object.defineProperty(document, 'visibilityState',
                {configurable: true, get: () => state});
            document.dispatchEvent(new Event('visibilitychange'));
        }""",
        state,
    )


def fresh_game(page):
    """Reload to a clean page and start a new run."""
    page.reload()
    page.wait_for_timeout(300)
    assert page.is_visible("#startScreen"), "start screen did not render"
    page.click("#startBtn")
    page.wait_for_timeout(150)
    assert get_state(page)["gameState"] == "playing", "game did not start"


def assert_frozen(before, after, keys, label):
    for k in keys:
        assert after[k] == before[k], (
            f"{label}: '{k}' moved while paused "
            f"({before[k]!r} -> {after[k]!r})"
        )


def run_tests():
    errors = []
    failures = []

    def check(fn, name):
        try:
            fn()
            print(f"PASS: {name}")
        except AssertionError as exc:
            failures.append(f"{name}: {exc}")
            print(f"FAIL: {name}: {exc}")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        page.goto(GAME_URL)
        page.wait_for_timeout(300)
        assert page.is_visible("#startScreen"), "start screen did not render"

        # ── Chain 1: pause freezes everything ────────────────────────────────
        def chain1_freeze():
            fresh_game(page)
            # Engage the barrel chase immediately so we can prove it freezes.
            page.evaluate("window.__spikeSprint.debug.setStuck(true)")
            page.wait_for_timeout(350)
            pre = get_state(page)
            assert pre["barrelCatchUp"] > 0, "barrel chase did not engage"

            page.keyboard.press("p")
            page.wait_for_timeout(150)
            paused = get_state(page)
            assert paused["gameState"] == "paused", f"not paused: {paused['gameState']}"
            assert page.is_visible("#pauseScreen"), "pause overlay not shown"
            hud_at_pause = page.text_content("#hud")
            speed_at_pause = page.text_content("#speedTag")

            page.wait_for_timeout(700)  # real time passes; game time must not
            still = get_state(page)
            assert_frozen(
                paused, still,
                ["score", "elapsed", "speedMult", "barrelCatchUp",
                 "playerY", "playerVy"],
                "pause freeze",
            )
            assert page.text_content("#hud") == hud_at_pause, "HUD score moved while paused"
            assert page.text_content("#speedTag") == speed_at_pause, "HUD speed moved while paused"

            # Audio must be silenced by the pause (context suspended by us).
            assert still["audioSuspendedByPause"] is True, "pause did not suspend audio"
            assert still["audioState"] == "suspended", (
                f"audio context not suspended while paused: {still['audioState']}"
            )

            # Jump inputs must be dead while paused (space AND canvas click).
            page.keyboard.down("Space")
            page.wait_for_timeout(120)
            page.keyboard.up("Space")
            page.mouse.click(640, 360)
            page.wait_for_timeout(200)
            after_input = get_state(page)
            assert after_input["gameState"] == "paused", "input while paused changed state"
            assert after_input["playerVy"] == 0 and after_input["playerY"] == still["playerY"], (
                "player jumped while paused"
            )
            assert after_input["barrelCatchUp"] == still["barrelCatchUp"], (
                "barrel advanced from input while paused"
            )

        check(chain1_freeze, "chain1: pause freezes world/score/barrel/HUD/audio, blocks input")

        # ── Chain 2: resume does not back-fill background time ───────────────
        def chain2_resume_no_jump():
            fresh_game(page)
            page.wait_for_timeout(400)
            page.keyboard.press("p")
            page.wait_for_timeout(100)
            st = get_state(page)
            assert st["gameState"] == "paused", "precondition: must be paused"
            elapsed_at_pause = st["elapsed"]

            page.wait_for_timeout(1200)  # wall-clock time spent paused
            page.keyboard.press("p")     # resume via keyboard
            page.wait_for_timeout(80)
            resumed = get_state(page)
            assert resumed["gameState"] == "playing", f"did not resume: {resumed['gameState']}"
            assert not page.is_visible("#pauseScreen"), "pause overlay still visible"

            # The 1.2s spent paused must NOT appear in the game clock.
            assert resumed["elapsed"] - elapsed_at_pause < 0.5, (
                f"resume back-filled time: {elapsed_at_pause:.3f} -> {resumed['elapsed']:.3f}"
            )

            # Clock/score run again afterwards, at normal frame pace.
            page.wait_for_timeout(400)
            later = get_state(page)
            assert 0.1 < later["elapsed"] - resumed["elapsed"] < 0.9, (
                "game clock did not resume at normal pace"
            )
            assert later["score"] > resumed["score"], "score did not resume growing"
            assert later["audioState"] == "running", "audio did not resume with the game"

            # Mute toggle stays independent of pause: muting must not pause,
            # and the pause system must not flip the mute flag.
            page.click("#soundToggle")
            page.wait_for_timeout(50)
            muted = get_state(page)
            assert muted["soundEnabled"] is False and muted["gameState"] == "playing", (
                "mute toggle interfered with pause state"
            )
            page.click("#soundToggle")  # restore

        check(chain2_resume_no_jump, "chain2: resume re-aligns clock, no frame jump, mute independent")

        # ── Chain 3: restart resets to baseline, keeps high score ────────────
        def chain3_restart_reset():
            fresh_game(page)
            page.wait_for_timeout(800)  # accumulate score + high score
            # Pause first, then end the game out of the paused state — the
            # game-over transition must clear pause state on its own.
            page.keyboard.press("Escape")
            page.wait_for_timeout(100)
            assert get_state(page)["gameState"] == "paused", "precondition: not paused"
            page.evaluate("window.__spikeSprint.endGame()")
            page.wait_for_timeout(100)
            over = get_state(page)
            assert over["gameState"] == "over", f"not over: {over['gameState']}"
            assert not page.is_visible("#pauseScreen"), "pause overlay survived game over"
            assert over["audioSuspendedByPause"] is False, "pause audio state survived game over"
            high = over["highScore"]
            assert high > 0, "no high score accumulated before restart"

            page.click("#restartBtn")
            page.wait_for_timeout(120)
            fresh = get_state(page)
            assert fresh["gameState"] == "playing", "restart did not enter playing"
            assert fresh["elapsed"] < 0.5, f"clock not reset: {fresh['elapsed']}"
            assert fresh["score"] < 5, f"score not reset: {fresh['score']}"
            assert 1 <= fresh["speedMult"] < 1.01, (
                f"speed multiplier not at baseline: {fresh['speedMult']}"
            )
            assert fresh["barrelCatchUp"] == 0, "barrel chase not reset"
            assert fresh["highScore"] == high, "high score lost on restart"
            assert not page.is_visible("#pauseScreen"), "pause overlay visible after restart"

        check(chain3_restart_reset, "chain3: game over + restart clears pause, resets baseline, keeps high score")

        # ── Chain 4: visibility change pauses; no auto-resume ────────────────
        def chain4_visibility():
            fresh_game(page)
            page.wait_for_timeout(400)
            before = get_state(page)
            assert before["gameState"] == "playing", "precondition: not playing"

            set_visibility(page, "hidden")  # tab goes to background
            page.wait_for_timeout(150)
            hidden = get_state(page)
            assert hidden["gameState"] == "paused", "backgrounding the tab did not pause"
            assert page.is_visible("#pauseScreen"), "pause overlay not shown after backgrounding"

            page.wait_for_timeout(400)
            still = get_state(page)
            assert still["elapsed"] == hidden["elapsed"] and still["score"] == hidden["score"], (
                "game clock advanced while tab was 'hidden'"
            )

            set_visibility(page, "visible")  # tab returns — must stay paused
            page.wait_for_timeout(300)
            back = get_state(page)
            assert back["gameState"] == "paused", "returning to tab auto-resumed the game"
            assert back["elapsed"] == hidden["elapsed"], "clock jumped on tab return"

            page.keyboard.press("Escape")  # explicit resume still works
            page.wait_for_timeout(100)
            assert get_state(page)["gameState"] == "playing", "Esc did not resume after background pause"

        check(chain4_visibility, "chain4: visibility change pauses, return does not auto-resume")

        browser.close()

    if errors:
        failures.append("console/page errors: " + "; ".join(errors))
    print()
    if failures:
        print("FAILURES:")
        for f in failures:
            print(" -", f)
        return 1
    print("All pause-system chains passed; no console/page errors.")
    return 0


if __name__ == "__main__":
    sys.exit(run_tests())
