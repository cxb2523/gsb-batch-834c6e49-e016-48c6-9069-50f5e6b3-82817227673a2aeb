import gc
import av
import time
import threading
import logging
import tkinter as tk
from PIL import ImageTk, Image, ImageOps
from typing import Tuple, Dict

logging.getLogger('libav').setLevel(logging.ERROR)  # removes warning: deprecated pixel format used


class TkinterVideo(tk.Label):

    def __init__(self, master, scaled: bool = True, consistant_frame_rate: bool = True, keep_aspect: bool = False, *args, **kwargs):
        super(TkinterVideo, self).__init__(master, *args, **kwargs)

        self.path = ""
        self._load_thread = None
        # Incremented on every stop()/load(). A loader thread may only touch
        # shared state or emit events while its generation is still current,
        # so a stale thread from a previously loaded file can never post
        # <<FrameGenerated>>/<<SecondChanged>>/<<Loaded>> for the new file.
        self._load_generation = 0
        # serializes play()/stop() so the _load_thread check-and-set is atomic
        self._thread_lock = threading.Lock()

        self._paused = True
        self._stop = True

        self.consistant_frame_rate = consistant_frame_rate # tries to keep the frame rate consistant by skipping over a few frames

        self._container = None

        self._current_img = None
        self._current_imgtk = None
        self._frame_number = 0
        self._time_stamp = 0

        self._current_frame_size = (0, 0)

        # protects the pending seek request: a seek issued from the UI thread
        # while the loader is applying a previous one is never lost, and the
        # last seek always wins
        self._seek_lock = threading.Lock()
        self._seek = False
        self._seek_sec = 0

        self._video_info = {
            "duration": 0, # duration of the video
            "framerate": 0, # frame rate of the video
            "framesize": (0, 0) # tuple containing frame height and width of the video

        }

        self.set_scaled(scaled)
        self._keep_aspect_ratio = keep_aspect
        self._resampling_method: int = Image.NEAREST


        self.bind("<Destroy>", self._on_destroy)
        self.bind("<<FrameGenerated>>", self._display_frame)

    def _on_destroy(self, event):
        """ releases the container and the loader thread when the widget is destroyed """
        if event.widget is self:
            self.stop()

    def keep_aspect(self, keep_aspect: bool):
        """ keeps the aspect ratio when resizing the image """
        self._keep_aspect_ratio = keep_aspect

    def set_resampling_method(self, method: int):
        """ sets the resampling method when resizing """
        self._resampling_method = method

    def set_size(self, size: Tuple[int, int], keep_aspect: bool=False):
        """ sets the size of the video """
        self.set_scaled(False, self._keep_aspect_ratio)
        self._current_frame_size = size
        self._keep_aspect_ratio = keep_aspect

    def _resize_event(self, event):

        if event.width <= 1 or event.height <= 1:
            return # ignore degenerate sizes during widget tear-down

        self._current_frame_size = event.width, event.height

        if self._paused and self._current_img is not None and self.scaled:
            # repaint from the current PIL frame; never depends on a stale PhotoImage
            if self._keep_aspect_ratio:
                proxy_img = ImageOps.contain(self._current_img.copy(), self._current_frame_size)

            else:
                proxy_img = self._current_img.copy().resize(self._current_frame_size)

            self._current_imgtk = ImageTk.PhotoImage(proxy_img)
            self.config(image=self._current_imgtk)


    def set_scaled(self, scaled: bool, keep_aspect: bool = False):
        self.scaled = scaled
        self._keep_aspect_ratio = keep_aspect

        if scaled:
            self.bind("<Configure>", self._resize_event)

        else:
            self.unbind("<Configure>")
            self._current_frame_size = self.video_info()["framesize"]


    def _set_frame_size(self, event=None):
        """ sets frame size to avoid unexpected resizing """

        if self._container:
            self._video_info["framesize"] = (self._container.streams.video[0].width, self._container.streams.video[0].height)

        framesize = self._video_info["framesize"]
        if framesize[0] <= 0 or framesize[1] <= 0:
            return

        self._current_imgtk = ImageTk.PhotoImage(Image.new("RGBA", framesize, (255, 0, 0, 0)))
        self.config(width=150, height=100, image=self._current_imgtk)

    def _emit(self, event_name):
        """ generates a virtual event, ignoring a dead widget or a main thread
        that is (no longer) running the Tk event loop """
        try:
            self.event_generate(event_name)
        except (tk.TclError, RuntimeError):
            pass

    def _load(self, path, generation):
        """ load's file from a thread """

        current_thread = threading.current_thread()

        def is_current():
            # the loader may only touch shared state / emit events while it is
            # still the active loader for the file it opened
            return (self._load_thread is current_thread
                    and self._load_generation == generation
                    and not self._stop)

        container = None

        try:
            container = av.open(path)

            container.streams.video[0].thread_type = "AUTO"

            # self._container.fast_seek = True
            # self._container.discard_corrupt = True

            stream = container.streams.video[0]

            video_info = {
                "duration": 0,
                "framerate": 0,
                "framesize": (stream.width, stream.height)
            }

            try:
                # average_rate is a Fraction on older PyAV and an AVRational on
                # newer ones; float() handles both
                video_info["framerate"] = round(float(stream.average_rate))

            except TypeError:
                raise TypeError("Not a video file")

            duration_found = False
            try:
                video_info["duration"] = float(stream.duration * stream.time_base)
                duration_found = True

            except TypeError:  # the video duration cannot be found, this can happen for mkv files
                pass

            with self._thread_lock:
                # publish atomically w.r.t. stop(): a superseded thread can no
                # longer make video_info() describe the old file
                if not is_current():
                    return
                self._container = container
                self._video_info = video_info
                self._frame_number = 0
                self._time_stamp = 0

            self._set_frame_size()

            self.stream_base = stream.time_base

            if duration_found and is_current():
                self._emit("<<Duration>>")  # duration has been found

            if is_current():
                self._emit("<<Loaded>>") # generated when the video file is opened

            now = time.time_ns() // 1_000_000  # time in milliseconds
            then = now

            time_in_frame = (1/video_info["framerate"])*1000 # second it should play each frame

            # one persistent decode generator; recreated after every seek so
            # decoding resumes exactly at the seek position
            frames = container.decode(video=0)

            while is_current():
                # pick up the newest pending seek atomically; a seek issued
                # while one is being applied is handled on the next pass, so
                # consecutive seeks settle on the last requested position
                with self._seek_lock:
                    seek_pending = self._seek
                    seek_sec = self._seek_sec
                    self._seek = False

                if seek_pending: # seek to specific second
                    try:
                        container.seek(seek_sec*1000000, backward=True, any_frame=False) # the seek time is given in av.time_base, the multiplication is to correct the frame
                        frames = container.decode(video=0)
                        self._frame_number = video_info["framerate"] * seek_sec
                        then = time.time_ns() // 1_000_000

                    except (av.error.FFmpegError, ValueError, OverflowError):
                        pass

                if self._paused:
                    time.sleep(0.01) # to allow other threads to function better when its paused
                    continue

                now = time.time_ns() // 1_000_000  # time in milliseconds
                delta = now - then  # time difference between current frame and previous frame
                then = now

                # print("Frame: ", frame.time, frame.index, self._video_info["framerate"])
                try:
                    frame = next(frames)

                except (StopIteration, av.error.EOFError):
                    break

                self._time_stamp = float(frame.pts * stream.time_base)

                width = self._current_frame_size[0]
                height = self._current_frame_size[1]

                if width <= 0 or height <= 0:
                    width, height = frame.width, frame.height

                elif self._keep_aspect_ratio:
                    im_ratio = frame.width / frame.height
                    dest_ratio = width / height
                    if im_ratio != dest_ratio:
                        if im_ratio > dest_ratio:
                            new_height = round(frame.height / frame.width * width)
                            height = new_height
                        else:
                            new_width = round(frame.width / frame.height * height)
                            width = new_width

                img = frame.to_image(width=width, height=height, interpolation="FAST_BILINEAR")

                with self._thread_lock:
                    # publish the frame atomically w.r.t. stop(): a superseded
                    # thread drops the frame and posts no event for it
                    if not is_current():
                        break
                    self._current_img = img
                    self._frame_number += 1

                self._emit("<<FrameGenerated>>")

                if self._frame_number % video_info["framerate"] == 0:
                    self._emit("<<SecondChanged>>")

                if self.consistant_frame_rate:
                    time.sleep(max((time_in_frame - delta)/1000, 0))

                # time.sleep(abs((1 / self._video_info["framerate"]) - (delta / 1000)))

        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass

            with self._thread_lock:
                # only the still-current loader may reset shared state; a
                # superseded thread must leave the new file's state alone
                is_current_loader = (self._load_thread is current_thread
                                     and self._load_generation == generation)
                if is_current_loader:
                    self._load_thread = None
                    if self._container is container:
                        self._container = None
                    self._frame_number = 0
                    self._paused = True
                    self._stop = True

            if is_current_loader:
                self._emit("<<Ended>>")

            gc.collect()


    def load(self, path: str):
        """ loads the file from the given path """
        self.stop()

        # drop any seek aimed at the previous file and reset the info, so
        # video_info() never reports the old file while the new one loads
        with self._seek_lock:
            self._seek = False
            self._seek_sec = 0

        self._video_info = {
            "duration": 0,
            "framerate": 0,
            "framesize": (0, 0)
        }
        self._time_stamp = 0
        self._frame_number = 0

        self.path = path

    def stop(self):
        """ stops reading the file """
        self._paused = True
        self._stop = True

        with self._thread_lock:
            # invalidate the current loader; the thread notices it is no longer
            # current, exits its loop and closes its own container
            self._load_generation += 1
            self._load_thread = None
            self._container = None

        self._frame_number = 0
        self._emit("<<Ended>>")

    def pause(self):
        """ pauses the video file """
        self._paused = True

    def play(self):
        """ plays the video file """
        self._paused = False
        self._stop = False

        with self._thread_lock:
            if not self._load_thread and self.path:
                # print("loading new thread...")
                self._load_thread = threading.Thread(target=self._load, args=(self.path, self._load_generation), daemon=True)
                self._load_thread.start()

    def is_paused(self):
        """ returns if the video is paused """
        return self._paused

    def video_info(self) -> Dict:
        """ returns dict containing duration, frame_rate, file"""
        return self._video_info

    def metadata(self) -> Dict:
        """ returns metadata if available """
        if self._container:
            return self._container.metadata

        return {}

    def current_frame_number(self) -> int:
        """ return current frame number """
        return self._frame_number

    def current_duration(self) -> float:
        """ returns current playing duration in sec """
        return self._time_stamp

    def current_img(self) -> Image:
        """ returns current frame image """
        return self._current_img

    def _display_frame(self, event):
        """ displays the frame on the label """

        if self._current_img is None:
            return

        if (self._current_imgtk is not None
                and self._current_imgtk.width() == self._current_img.width
                and self._current_imgtk.height() == self._current_img.height):
            self._current_imgtk.paste(self._current_img)
        else:
            self._current_imgtk = ImageTk.PhotoImage(self._current_img)
        self.config(image=self._current_imgtk)

    def seek(self, sec: int):
        """ seeks to specific time"""

        with self._seek_lock:
            self._seek = True
            self._seek_sec = sec
