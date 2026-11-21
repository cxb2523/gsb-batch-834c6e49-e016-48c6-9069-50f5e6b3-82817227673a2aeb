#!/usr/bin/env python3
"""End-to-end smoke test: drives the real window with generated clips.

    .venv/bin/python tests/smoke.py

Needs ffmpeg and a display (a real session, or `xvfb-run -s "-screen 0 1920x1080x24"`). It uses a
throw-away settings folder and a silent audio output, so it never touches your own settings.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import warnings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = tempfile.mkdtemp(prefix="samovar-lite-smoke-")
os.environ["XDG_CONFIG_HOME"] = os.path.join(WORK, "config")
sys.path.insert(0, ROOT)
if os.environ.get("WAYLAND_DISPLAY") and not os.environ.get("QT_QPA_PLATFORM"):
    os.environ["QT_QPA_PLATFORM"] = "wayland;xcb"

from PySide6.QtCore import QEventLoop, QMimeData, QPoint, QPointF, Qt, QTimer, QUrl
from PySide6.QtGui import QDragEnterEvent, QDropEvent
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from samovar_lite import skin
from samovar_lite.app import Player
from samovar_lite.settings import Settings

warnings.simplefilter("ignore", DeprecationWarning)
FAILED = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ::  {detail}" if detail != "" and not condition else ""))
    if not condition:
        FAILED.append(name)


def wait(ms):
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def wait_until(condition, timeout=10.0):
    """Process events until `condition()` is true; returns whether it became true in time."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        wait(50)
    return bool(condition())


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True, stdin=subprocess.DEVNULL)


def make_media():
    one, two = os.path.join(WORK, "Show.S01E01.mp4"), os.path.join(WORK, "Show.S01E02.mp4")
    ffmpeg(
        *("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=30"),
        *("-f", "lavfi", "-i", "sine=frequency=440:duration=30"),
        *("-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"),
        *("-c:a", "aac", "-shortest", one),
    )
    ffmpeg(
        *("-f", "lavfi", "-i", "smptebars=size=960x540:rate=30:duration=8"),
        *("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", two),
    )
    with open(os.path.join(WORK, "Show.S01E01.srt"), "w", encoding="utf-8") as fh:
        fh.write("1\n00:00:00,200 --> 00:00:29,000\nسلام — hello\n")
    legacy = os.path.join(WORK, "legacy.srt")
    with open(legacy, "wb") as fh:
        fh.write("1\n00:00:00,200 --> 00:00:29,000\nسلام دنبا\n".encode("cp1256"))
    extras = os.path.join(WORK, "extras.srt")
    with open(extras, "w", encoding="utf-8") as fh:
        fh.write("1\n00:00:00,200 --> 00:00:29,000\nextras — second track\n")
    return one, two, legacy, extras


def stripes(player):
    """Counts abrupt light/dark row changes down the left edge of the frame (0-2 on a clean frame)."""
    image = player.video_area.video.grabFramebuffer()
    x = int(image.width() * 0.07)
    values = [image.pixelColor(x, y).lightness() for y in range(image.height())]
    return sum(1 for y in range(1, len(values)) if abs(values[y] - values[y - 1]) > 60)


def main():
    if not shutil.which("ffmpeg"):
        print("ffmpeg is required to generate the test clips")
        return 2
    one, two, legacy, extras = make_media()
    app = QApplication(sys.argv[:1])
    app.setStyle("Fusion")
    app.setPalette(skin.dark_palette())
    app.setStyleSheet(skin.APP_QSS)
    p = Player(Settings(), silent=True)
    p.show()
    wait_until(lambda: p._gl_ready, 15)
    e = p.engine
    print(f"platform: {app.platformName()}, mpv: {e.get('mpv-version')}, renderer: {e.gl_renderer}")
    check("idle: logo shown, nothing loaded", p.video_area.logo.isVisible() and not p.has_file())

    mime = QMimeData()
    mime.setUrls([QUrl.fromLocalFile(one)])
    centre = QPointF(p.width() / 2, p.height() / 2)
    enter = QDragEnterEvent(centre.toPoint(), Qt.CopyAction, mime, Qt.LeftButton, Qt.NoModifier)
    QApplication.sendEvent(p, enter)
    hint = p.video_area.osd.center_text
    check("drag over the window is accepted with a hint", enter.isAccepted() and hint == "Drop to play", hint)
    QApplication.sendEvent(p, QDropEvent(centre, Qt.CopyAction, mime, Qt.LeftButton, Qt.NoModifier))
    started = wait_until(lambda: p._file_ready and p._last_pos > 1.0, 20)
    check("dropping a video plays it", started and p.current_path == one, (p.current_path, p._last_pos))
    if not started:
        print("engine messages:", list(e.log_lines)[-10:])
        p.close()
        print("\nFAILED: playback did not start, stopping here")
        return 1
    check("the next episode is queued", p.playlist.count() == 2, p.playlist.paths())
    fitted = wait_until(lambda: (p.video_area.width(), p.video_area.height()) == (1280, 720), 5)
    check("window resized to the video", fitted, (p.video_area.width(), p.video_area.height()))
    utf8 = wait_until(lambda: e.get("sub-text") == "سلام — hello", 5)
    check("subtitle next to the video loaded as UTF-8", utf8, e.get("sub-text"))

    QTest.keyClick(p, Qt.Key_Space)
    check("Space pauses", wait_until(lambda: e.get("pause") is True, 3))
    QTest.keyClick(p, Qt.Key_Space)
    wait_until(lambda: e.get("pause") is False, 3)
    before = p._last_pos
    QTest.keyClick(p, Qt.Key_Right)
    check("Right seeks 5 s", wait_until(lambda: 4 < p._last_pos - before < 9, 5), (before, p._last_pos))
    QTest.keyClick(p, Qt.Key_Down)
    check("Down lowers the volume", wait_until(lambda: e.get("volume") == 95, 3), e.get("volume"))
    QTest.keyClick(p, Qt.Key_Period)
    delayed = wait_until(lambda: abs(e.get("sub-delay") - 0.5) < 0.01, 3)
    check(". delays subtitles by 0.5 s", delayed, e.get("sub-delay"))
    QTest.keyClick(p, Qt.Key_Slash)

    p.open_paths([legacy])
    decoded = wait_until(lambda: (e.get("sub-text") or "").startswith("سلام د"), 5)
    check("Windows-1256 subtitle decoded as Persian", decoded, repr(e.get("sub-text")))
    written_back = wait_until(lambda: e.get("sub-codepage") == "cp1256", 3)
    check("fallback codepage is written back to the engine", written_back, e.get("sub-codepage"))

    # -- subtitle slots, encoding probe and idempotency ------------------------------------------
    utf8_sub = os.path.join(WORK, "Show.S01E01.srt")

    def sub_tracks(path):
        return [
            t
            for t in p.tracks()
            if t.get("type") == "sub"
            and t.get("external")
            and os.path.basename(str(t.get("external-filename") or "")) == os.path.basename(path)
        ]

    p.add_subtitles([extras], slot="secondary")
    got_secondary = wait_until(lambda: e.get("secondary-sid") not in (None, False, "no"), 5)
    check("secondary subtitle loads into its own slot", got_secondary, e.get("secondary-sid"))
    sec_id = e.get("secondary-sid")
    utf8_probed = wait_until(lambda: e.get("sub-codepage") == "utf-8", 3)
    check("UTF-8 probe result is written back to the engine", utf8_probed, e.get("sub-codepage"))

    p.add_subtitles([utf8_sub])  # switch the main subtitle to the auto-discovered one
    kept = wait_until(lambda: e.get("secondary-sid") == sec_id, 3)
    check("switching the main subtitle keeps the secondary", kept, (sec_id, e.get("secondary-sid")))
    check("auto-discovered subtitle is not duplicated", len(sub_tracks(utf8_sub)) == 1, len(sub_tracks(utf8_sub)))

    main_id = e.get("sid")
    legacy_id = sub_tracks(legacy)[0].get("id")
    p.set_secondary_sub(legacy_id)
    wait_until(lambda: e.get("secondary-sid") == legacy_id, 3)
    check("switching the secondary subtitle keeps the main one", e.get("sid") == main_id, (main_id, e.get("sid")))

    p.sub_delay(0.5)
    p.audio_delay(0.2)
    p.add_subtitles([legacy])  # switch the main subtitle again
    delays_kept = wait_until(lambda: abs(e.get("sub-delay") - 0.5) < 0.01 and abs(e.get("audio-delay") - 0.2) < 0.01, 3)
    check("subtitle switch keeps the user's delays", delays_kept, (e.get("sub-delay"), e.get("audio-delay")))

    QTest.keyClick(p, Qt.Key_H, Qt.AltModifier)  # hide subtitles
    wait_until(lambda: e.get("sub-visibility") is False, 3)
    p.add_subtitles([utf8_sub])
    wait(300)
    check("subtitle switch keeps subtitles hidden", e.get("sub-visibility") is False, e.get("sub-visibility"))
    QTest.keyClick(p, Qt.Key_H, Qt.AltModifier)  # show them again
    wait_until(lambda: e.get("sub-visibility") is True, 3)

    p.add_subtitles([legacy])
    p.add_subtitles([legacy])
    wait(400)
    check("loading the same subtitle twice adds no track", len(sub_tracks(legacy)) == 1, len(sub_tracks(legacy)))

    QTest.keyClick(p, Qt.Key_Return)
    check("Enter goes full screen without chrome", wait_until(lambda: p.isFullScreen() and not p.ctrl.isVisible(), 5))
    wait(400)  # nobody leaves full screen in the same instant they entered it
    p._fs_mouse(QPoint(p.width() // 2, p.height() - 2))
    shown = wait_until(lambda: p.ctrl.isVisible() and p.seek.isVisible(), 3)
    check("pointer at the bottom edge shows the controls", shown)
    QTest.keyClick(p, Qt.Key_Escape)
    check("Esc leaves full screen", wait_until(lambda: not p.isFullScreen() and p.ctrl.isVisible(), 5))

    QTest.keyClick(p, Qt.Key_PageDown)
    switched = wait_until(lambda: p.current_path == two and p._file_ready and p._last_pos > 0.5, 20)
    check("PgDn plays the next file", switched, (p.current_path, p._last_pos))
    check(
        "subtitle slots are cleared on file change",
        p._sub_slots == {"main": None, "secondary": None} and not p._pending_subs and not p._pending_slot_selects,
        (p._sub_slots, p._pending_subs, p._pending_slot_selects),
    )
    no_old_subs = wait_until(lambda: not any(t.get("type") == "sub" and t.get("external") for t in p.tracks()), 5)
    check("no subtitle from the previous file remains", no_old_subs, p.tracks())
    sec_cleared = e.get("secondary-sid") in (None, False, "no")
    check("secondary slot is reset on file change", sec_cleared, e.get("secondary-sid"))
    delays_reset = wait_until(lambda: e.get("sub-delay") == 0 and e.get("audio-delay") == 0, 5)
    check("subtitle and audio delays reset on file change", delays_reset, (e.get("sub-delay"), e.get("audio-delay")))
    codepage_restored = wait_until(lambda: e.get("sub-codepage") == "cp1256", 3)
    check("codepage falls back to the setting for the next file", codepage_restored, e.get("sub-codepage"))
    wait(500)
    check("picture is clean after switching resolution", stripes(p) <= 4, stripes(p))
    refit = wait_until(lambda: (p.video_area.width(), p.video_area.height()) == (960, 540), 5)
    check("window follows the new video size right after leaving full screen", refit, p.video_area.size())
    e.cmd("seek", 7.5, "absolute")
    stopped = wait_until(lambda: not p.has_file() and p.video_area.logo.isVisible(), 15)
    check("end of the playlist stops and shows the logo", stopped)

    p.play_row(0)
    wait_until(lambda: p._file_ready, 20)
    e.cmd("seek", 12, "absolute")
    wait_until(lambda: p._last_pos >= 12, 10)
    p.add_subtitles([legacy])
    p.add_subtitles([extras], slot="secondary")
    wait_until(lambda: e.get("secondary-sid") not in (None, False, "no"), 5)
    QTest.keyClick(p, Qt.Key_F4)
    wait_until(lambda: not p.has_file(), 5)
    check(
        "closing playback clears both subtitle slots",
        p._sub_slots == {"main": None, "secondary": None} and not p._pending_slot_selects,
        (p._sub_slots, p._pending_slot_selects),
    )
    p.add_subtitles([legacy])  # nothing is playing: must be ignored
    check("no subtitle commands are queued after closing playback", not p._pending_slot_selects)
    QTest.keyClick(p, Qt.Key_Space)
    resumed = wait_until(lambda: p._file_ready and p._last_pos > 11, 20)
    check("playback position is remembered", resumed and p._last_pos < 20, p._last_pos)

    p.close()
    wait(300)
    check("settings were written", os.path.exists(os.path.join(WORK, "config", "samovar-lite", "settings.json")))
    crashed = False
    try:
        p.add_subtitles([legacy])  # the engine is gone: drop the request, submit nothing
        p._clear_sub_slots()
    except Exception:
        crashed = True
    check("no subtitle commands reach the destroyed engine", not crashed)
    shutil.rmtree(WORK, ignore_errors=True)
    print("\n" + ("ALL PASSED" if not FAILED else "FAILED: " + ", ".join(FAILED)))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
