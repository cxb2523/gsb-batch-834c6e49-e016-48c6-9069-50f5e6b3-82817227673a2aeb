# -*- coding: utf-8 -*-
"""
Local, self-contained tests for tkVideoPlayer's load/seek/pause-resize/end
lifecycle.

The videos used here are generated on the fly with PyAV (no binary fixtures),
into a temp directory:

  video_a.mp4  6 s, 10 fps, 160x120, red
  video_b.mp4  2 s,  5 fps,  96x96,  blue   (different info -> video_info() must change)
  video_c.mp4  1 s, 10 fps, 128x96,  green  (short -> reaches <<Ended>> quickly)

Run from the repo root:

    python tests/test_tkvideoplayer.py        (or: python -m unittest tests.test_tkvideoplayer -v)

Observing the event sequence / video_info() changes
----------------------------------------------------
Every test installs an EventRecorder that logs each virtual event as
(time, event-name, video_info() snapshot, current_duration()).  On failure the
log is printed; you can also print it manually:

    for row in recorder.log:
        print(row)

or run examples/event_sequence_demo.py to watch the same log live.
"""

import os
import sys
import time
import tempfile
import threading
import types
import unittest
import tkinter as tk

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import av
from PIL import Image

from tkVideoPlayer import TkinterVideo

VIDEO_A = None  # paths filled in by setUpModule
VIDEO_B = None
VIDEO_C = None
_tmpdir = None


def make_video(path, duration_sec, fps, size, color):
    """ creates a tiny synthetic video with PyAV (mpeg4 in mp4) """
    container = av.open(path, mode="w")
    stream = container.add_stream("mpeg4", rate=fps)
    stream.width, stream.height = size
    stream.pix_fmt = "yuv420p"

    for _ in range(duration_sec * fps):
        frame = av.VideoFrame.from_image(Image.new("RGB", size, color))
        for packet in stream.encode(frame):
            container.mux(packet)

    for packet in stream.encode():  # flush
        container.mux(packet)

    container.close()


def setUpModule():
    global VIDEO_A, VIDEO_B, VIDEO_C, _tmpdir
    _tmpdir = tempfile.TemporaryDirectory(prefix="tkvp_test_")
    VIDEO_A = os.path.join(_tmpdir.name, "video_a.mp4")
    VIDEO_B = os.path.join(_tmpdir.name, "video_b.mp4")
    VIDEO_C = os.path.join(_tmpdir.name, "video_c.mp4")
    make_video(VIDEO_A, duration_sec=8, fps=10, size=(160, 120), color=(200, 30, 30))
    make_video(VIDEO_B, duration_sec=2, fps=5, size=(96, 96), color=(30, 30, 200))
    make_video(VIDEO_C, duration_sec=2, fps=10, size=(128, 96), color=(30, 180, 30))


def tearDownModule():
    if _tmpdir is not None:
        # on Windows the video files may still be held by a decoder thread or
        # a not-yet-collected av container for a short while
        import gc
        for _ in range(20):
            gc.collect()
            try:
                _tmpdir.cleanup()
                return
            except PermissionError:
                time.sleep(0.2)
        _tmpdir.cleanup()


class EventRecorder:
    """ binds to all TkinterVideo virtual events and keeps an ordered log """

    EVENTS = ("<<Loaded>>", "<<Duration>>", "<<SecondChanged>>", "<<Ended>>")

    def __init__(self, player):
        self.player = player
        self.log = []
        self.frames = []  # timestamps reported while <<FrameGenerated>> fires
        for name in self.EVENTS:
            player.bind(name, self._make_handler(name), add="+")
        player.bind("<<FrameGenerated>>", self._on_frame, add="+")

    def _make_handler(self, name):
        def handler(event):
            info = dict(self.player.video_info())
            self.log.append((name, info["duration"], info["framerate"],
                             info["framesize"], round(self.player.current_duration(), 3)))
        return handler

    def _on_frame(self, event):
        self.frames.append(self.player.current_duration())

    def count(self, name):
        return sum(1 for row in self.log if row[0] == name)


class TkinterVideoTestCase(unittest.TestCase):
    # a single, mapped root window for the whole suite: Tk delivers virtual
    # events reliably only for a mapped application window, and creating
    # several Tk() instances in one process is flaky
    root = None

    @classmethod
    def setUpClass(cls):
        cls.root = tk.Tk()
        cls.root.geometry("320x240")

    @classmethod
    def tearDownClass(cls):
        cls.root.destroy()

    def setUp(self):
        self.player = TkinterVideo(master=self.root, scaled=True)
        self.player.pack(expand=True, fill="both")
        self.recorder = EventRecorder(self.player)
        self.root.update()

    def tearDown(self):
        thread = self.player._load_thread
        try:
            self.player.stop()
            self.player.destroy()
        except tk.TclError:
            pass
        self.pump(0.2)  # give the loader thread a moment to notice and exit
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)

    def pump(self, seconds):
        """ runs the Tk main loop for the given wall-clock time """
        self.root.after(int(seconds * 1000), self.root.quit)
        self.root.mainloop()

    def pump_until(self, condition, timeout, message=""):
        """ runs the main loop until condition() is true; fails on timeout """
        deadline = time.monotonic() + timeout

        def check():
            if condition() or time.monotonic() >= deadline:
                self.root.quit()
            else:
                self.root.after(10, check)

        self.root.after(10, check)
        self.root.mainloop()
        if not condition():
            self.fail("timed out waiting for: %s\nevent log: %s" % (message, self.recorder.log))

    # ------------------------------------------------------------------
    # 1. switching files while playing
    # ------------------------------------------------------------------
    def test_load_switch_stops_old_thread_and_updates_info(self):
        self.player.load(VIDEO_A)
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) >= 5, 10,
                        "frames of video A")
        old_thread = self.player._load_thread
        self.assertIsNotNone(old_thread)

        loaded_before = self.recorder.count("<<Loaded>>")
        self.assertEqual(loaded_before, 1)

        # switch files mid-playback
        self.player.load(VIDEO_B)
        # while B is loading, video_info() must not describe A anymore
        self.assertEqual(self.player.video_info(),
                         {"duration": 0, "framerate": 0, "framesize": (0, 0)})
        self.player.play()

        self.pump_until(lambda: self.recorder.count("<<Loaded>>") > loaded_before,
                        10, "<<Loaded>> for video B")

        # video_info() now describes B, not A
        info = self.player.video_info()
        self.assertEqual(info["framerate"], 5)
        self.assertAlmostEqual(info["duration"], 2.0, delta=0.5)
        self.assertEqual(info["framesize"], (96, 96))

        # exactly one <<Loaded>> and one <<Duration>> per successfully loaded file
        self.assertEqual(self.recorder.count("<<Loaded>>"), loaded_before + 1)

        # the old decode thread is finished and can no longer post events
        old_thread.join(timeout=5)
        self.assertFalse(old_thread.is_alive(), "old decode thread still running")
        self.assertIsNot(self.player._load_thread, old_thread)

        # frames generated from now on belong to B (timestamps stay below B's duration)
        self.recorder.frames.clear()
        self.pump(1.0)
        self.assertTrue(self.recorder.frames, "no frames after switching files")
        self.assertLess(max(self.recorder.frames), 2.5,
                        "frames after switch look like they come from the old file")

    # ------------------------------------------------------------------
    # 2. rapid consecutive seeks: last one wins, no bounce-back
    # ------------------------------------------------------------------
    def test_rapid_seeks_settle_on_last_position(self):
        self.player.load(VIDEO_A)  # 6 s
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) >= 3, 10,
                        "initial frames")

        # three seeks fired back to back; the last one (5 s) must win
        self.player.seek(1)
        self.player.seek(3)
        self.player.seek(5)

        # wait until playback is near the 5 s mark
        self.pump_until(lambda: self.player.current_duration() >= 4.0, 10,
                        "playback reaching the last seek position")

        # after settling there must be no bounce-back to an earlier seek target
        self.recorder.frames.clear()
        self.pump(0.8)
        self.assertTrue(self.recorder.frames)
        self.assertGreaterEqual(min(self.recorder.frames), 3.5,
                                "playback bounced back to an older seek position: %s"
                                % (self.recorder.frames,))

    def test_seek_applies_to_current_file_only(self):
        self.player.load(VIDEO_A)
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) >= 3, 10, "frames of A")

        # a seek queued right before switching files must not hit the new file
        self.player.seek(5)
        self.player.load(VIDEO_B)
        self.recorder.frames.clear()
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) > 0, 10, "frames of B")

        # B is 2 s long; a stale seek(5) landing on B would error or jump past EOF
        self.assertLess(max(self.recorder.frames), 2.5)

    # ------------------------------------------------------------------
    # 3. resizing while paused repaints the current frame
    # ------------------------------------------------------------------
    def test_paused_resize_repaints_current_frame(self):
        self.player.load(VIDEO_A)  # frames are 160x120
        self.player.play()
        self.pump_until(lambda: self.player._current_img is not None, 10,
                        "first decoded frame")
        self.player.pause()
        self.pump(0.2)

        current = self.player._current_img
        self.assertIsNotNone(current)

        # non-aspect resize: image follows the requested size exactly
        event = types.SimpleNamespace(width=200, height=100, widget=self.player)
        self.player._resize_event(event)
        self.root.update()
        imgtk = self.player._current_imgtk
        self.assertIsNotNone(imgtk, "paused resize did not repaint")
        self.assertEqual((imgtk.width(), imgtk.height()), (200, 100))

        # keep_aspect: fits inside the box and keeps the frame's aspect ratio
        self.player.keep_aspect(True)
        event = types.SimpleNamespace(width=200, height=100, widget=self.player)
        self.player._resize_event(event)
        self.root.update()
        imgtk = self.player._current_imgtk
        fw, fh = current.width, current.height
        self.assertLessEqual(imgtk.width(), 200)
        self.assertLessEqual(imgtk.height(), 100)
        self.assertAlmostEqual(imgtk.width() / imgtk.height(), fw / fh, delta=0.05)

        # degenerate sizes (widget tear-down) must not raise
        self.player._resize_event(types.SimpleNamespace(width=1, height=1,
                                                        widget=self.player))

    # ------------------------------------------------------------------
    # 4. end of stream -> clean state -> play() restarts from scratch
    # ------------------------------------------------------------------
    def test_replay_after_end(self):
        self.player.load(VIDEO_C)  # 2 s video
        # load() itself stops the previous session, which emits one <<Ended>>;
        # wait for the next one, emitted when the stream actually ends
        ended_before = self.recorder.count("<<Ended>>")
        self.player.play()
        self.pump_until(lambda: self.recorder.count("<<Ended>>") > ended_before, 20,
                        "<<Ended>> after natural end of stream")

        # after the end the container and the thread reference are released
        self.assertIsNone(self.player._load_thread)
        self.assertIsNone(self.player._container)
        self.assertTrue(self.player.is_paused())

        # playing again must start a fresh thread and produce new frames
        self.recorder.frames.clear()
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) >= 3, 10,
                        "frames after replay")
        self.assertIsNotNone(self.player._load_thread)

    # ------------------------------------------------------------------
    # 5. destroying the widget stops the thread without errors
    # ------------------------------------------------------------------
    def test_destroy_releases_thread(self):
        self.player.load(VIDEO_A)
        self.player.play()
        self.pump_until(lambda: len(self.recorder.frames) >= 3, 10, "frames")
        thread = self.player._load_thread

        self.player.destroy()
        self.pump(0.3)

        self.assertIsNone(self.player._load_thread)
        self.assertIsNone(self.player._container)
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive(), "decode thread survived widget destroy")

        # late events from the dying thread must not raise
        self.pump(0.3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
