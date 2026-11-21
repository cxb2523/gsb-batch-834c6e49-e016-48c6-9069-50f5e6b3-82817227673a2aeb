# -*- coding: utf-8 -*-
"""
Live demo: watch the event sequence and video_info() of a TkinterVideo player
while it switches files, seeks, pauses/resizes and replays after the end.

Two short videos are generated on the fly with PyAV (no fixtures needed):

  demo_a.mp4  8 s, 10 fps, red
  demo_b.mp4  2 s,  5 fps, blue

Run from the repo root:

    python examples/event_sequence_demo.py

What you should see (timestamps approximate):

  [load A]   <<Ended>> (from the stop() inside load), <<Duration>>, <<Loaded>>
             video_info() switches from zeros to A's info only once A is ready
  [play A]   <<FrameGenerated>> / <<SecondChanged>> with rising timestamps
  [seek]     three rapid seeks (1, 3, 6) - playback continues near 6 s,
             never bouncing back to 1 or 3
  [load B]   video_info() resets to zeros, then <<Duration>>/<<Loaded>> for B;
             no more frames with A's timestamps; video_info() shows B's info
  [end]      <<Ended>> once; _load_thread/_container are released
  [replay]   play() starts a fresh thread and frames flow again
"""

import os
import sys
import tempfile
import time
import tkinter as tk

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import av
from PIL import Image

from tkVideoPlayer import TkinterVideo

_tmpdir = tempfile.TemporaryDirectory(prefix="tkvp_demo_")
VIDEO_A = os.path.join(_tmpdir.name, "demo_a.mp4")
VIDEO_B = os.path.join(_tmpdir.name, "demo_b.mp4")


def make_video(path, duration_sec, fps, size, color):
    container = av.open(path, mode="w")
    stream = container.add_stream("mpeg4", rate=fps)
    stream.width, stream.height = size
    stream.pix_fmt = "yuv420p"
    for _ in range(duration_sec * fps):
        frame = av.VideoFrame.from_image(Image.new("RGB", size, color))
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def info_str(player):
    info = player.video_info()
    return ("video_info(duration=%.2f, framerate=%s, framesize=%s) "
            "current=%.2fs thread=%s"
            % (info["duration"], info["framerate"], info["framesize"],
               player.current_duration(),
               "alive" if player._load_thread else "none"))


def main():
    make_video(VIDEO_A, duration_sec=8, fps=10, size=(160, 120), color=(200, 30, 30))
    make_video(VIDEO_B, duration_sec=2, fps=5, size=(96, 96), color=(30, 30, 200))

    root = tk.Tk()
    root.geometry("320x240")
    root.title("TkinterVideo event sequence demo")

    player = TkinterVideo(master=root, scaled=True)
    player.pack(expand=True, fill="both")

    t0 = time.monotonic()

    def log(msg):
        print("[%5.1fs] %-16s %s" % (time.monotonic() - t0, msg, info_str(player)),
              flush=True)

    for name in ("<<Loaded>>", "<<Duration>>", "<<SecondChanged>>", "<<Ended>>"):
        player.bind(name, lambda e, n=name: log(n), add="+")

    def step(at, what, action):
        def run():
            log(">> " + what)
            action()
        root.after(int(at * 1000), run)

    step(0.1, "load A", lambda: player.load(VIDEO_A))
    step(0.2, "play A", player.play)
    step(1.5, "seek 1,3,6", lambda: (player.seek(1), player.seek(3), player.seek(6)))
    step(3.0, "pause+resize", lambda: (player.pause(), root.geometry("480x200")))
    step(4.0, "load B", lambda: player.load(VIDEO_B))
    step(4.1, "play B", player.play)
    # B is 2 s long: <<Ended>> around 6.5 s
    step(7.5, "replay B", player.play)
    step(10.5, "quit", root.destroy)

    root.mainloop()
    _tmpdir.cleanup()


if __name__ == "__main__":
    main()
