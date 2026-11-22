"""End-to-end takeover tests on the real MainWindow, with injected fake tiles.

libmpv is not required: the tile factory is replaced by a Qt-signal fake that
records the exact order of stop/loadfile calls and can delay its "stopped"
report, just like a busy real player.  These tests exercise the full path --
playlist -> scheduler handover -> Handoff -> load pump -- including rapid
skips, resizing, limit changes and the performance counters.
"""

import pytest

pytest.importorskip("PySide6")

from PySide6.QtCore import QObject, Signal, QTimer
from PySide6.QtWidgets import QApplication

from polyreel import app as appmod
from polyreel.app import MainWindow
from polyreel.perf import Sample
from polyreel.playlist import Item
from polyreel.tile import VideoTile


def _qapp():
    app = QApplication.instance() or QApplication([])
    return app


def _spin(ms=200):
    """Pump the Qt event loop (timers, queued signals) without a wall clock."""
    app = QApplication.instance()
    import time
    deadline = time.monotonic() + ms / 1000.0
    while time.monotonic() < deadline:
        app.processEvents()


def _wait_until(condition, timeout=3.0, interval=5):
    """Pump events until ``condition`` holds (or fail after ``timeout`` s)."""
    import time
    app = QApplication.instance()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app.processEvents()
        if condition():
            return True
        # Yield so the planner's background thread can make progress.
        time.sleep(interval / 1000.0)
    app.processEvents()
    assert condition(), "condition was not met before the timeout"
    return False


def _wait_settled(win):
    """Wait for any background plan to be applied and timers to drain."""
    _wait_until(lambda: not win._planning)
    _spin(80)


class FakeProber(QObject):
    probed = Signal(int, object, object, object)

    def __init__(self, parent=None):
        super().__init__(parent)

    def submit(self, *a, **k):
        pass

    def close(self):
        pass


class FakeTile(QObject):
    """A VideoTile stand-in with an asynchronous, test-driven stop."""
    double_clicked = Signal(object)
    right_clicked = Signal(object)
    finished = Signal(object)
    failed = Signal(object, str)
    shape_changed = Signal(object, float)
    ready = Signal(object)
    retired = Signal(object)
    stopped = Signal(object)

    _counter = 0

    def __init__(self, parent=None, hwdec="auto-safe"):
        super().__init__(parent)
        FakeTile._counter += 1
        self.num = FakeTile._counter
        self.item = None
        self.zoom = 1.0
        self.user_muted = False
        self.keep_sound = False
        self._muted = True
        self._paused = False
        self._stops_sent = 0
        self._stops_done = 0
        self._file_open = False
        self._pos = 0.0
        self._duration = 0.0
        self._volume = 100
        self._drops = 0
        self._fps = 30.0
        self._delay_stop = False
        self.loads: list[tuple] = []
        self.stops: list[object] = []
        from PySide6.QtCore import QRect
        self._geom = QRect(0, 0, 10, 10)
        self.visible = True
        # Emulate the real starter thread completing immediately.
        QTimer.singleShot(0, lambda: self.ready.emit(self))

    # -- lifecycle ----------------------------------------------------------
    @property
    def is_ready(self):
        return True

    @property
    def is_stopped(self):
        return self._stops_done >= self._stops_sent and not self._file_open

    @property
    def is_playing(self):
        return self._file_open

    @property
    def load_started(self):
        return 1.0 if self._file_open else 0.0

    @property
    def paused(self):
        return self._paused

    def stop(self, hide: bool = True):
        if self._stops_sent > self._stops_done or self.item is None and self.is_stopped:
            return
        self._file_open = False
        self.stops.append(self.item)
        self.item = None
        self._stops_sent += 1
        n = self._stops_sent
        self.visible = not hide
        if self._delay_stop:
            # The test reports completion explicitly via report_stopped().
            self._pending_stop = n
        else:
            QTimer.singleShot(0, lambda: self._complete(n))

    def _complete(self, n):
        self._stops_done = max(self._stops_done, n)
        if n == self._stops_sent:
            self.stopped.emit(self)

    def report_stopped(self):
        n = getattr(self, "_pending_stop", self._stops_sent)
        self._pending_stop = None
        self._complete(n)

    def load(self, item, start: float = 0.0, loop: bool = False, hwdec=None):
        if self._file_open or not self.is_stopped:
            raise RuntimeError(f"fake tile #{self.num}: load before stopped")
        # The reset contract: every leftover of the previous file is gone.
        self._file_open = True
        self.item = item
        self._pos = start
        self._duration = 0.0
        self._volume = 100
        self._muted = True
        self._drops = 0
        self._fps = 30.0
        self.user_muted = False
        self.keep_sound = False
        self.loads.append((item, start))
        self.visible = True

    # -- geometry / controls ------------------------------------------------
    def setGeometry(self, rect):
        self._geom = rect

    def geometry(self):
        return self._geom

    def move_to(self, rect, animate):
        self._geom = rect
        self.visible = True

    def show(self):
        self.visible = True

    def hide(self):
        self.visible = False

    def isVisible(self):
        return self.visible

    def raise_(self):
        pass

    def set_zoom(self, zoom):
        self.zoom = zoom

    def set_paused(self, paused):
        self._paused = paused

    def set_volume(self, volume):
        self._volume = max(0, min(100, volume))

    @property
    def volume(self):
        return self._volume

    def set_muted(self, muted):
        self._muted = muted

    def seek(self, seconds, exact=True):
        self._pos = seconds

    def position(self):
        return self._pos

    def duration(self):
        return self._duration

    def poll(self):
        pass

    def sample(self):
        if not self._file_open:
            return None
        return Sample(self._drops, self._fps, at=1.0, pos=self._pos)

    def make_dirty(self, drops=42, pos=55.0, duration=120.0, volume=37):
        self._drops = drops
        self._pos = pos
        self._duration = duration
        self._volume = volume

    def retire(self):
        pass

    def shutdown(self, wait=2.0):
        pass


@pytest.fixture
def window(monkeypatch):
    _qapp()
    monkeypatch.setattr(appmod, "Prober", FakeProber)
    made: list[FakeTile] = []

    def factory(window):
        t = FakeTile(window.stage)
        made.append(t)
        return t

    win = MainWindow([])
    win._tile_factory = lambda: factory(win)
    win.settings.benchmark_asked = True     # skip the first-run benchmark gate
    win._bench_pending = False
    win.resize(1600, 900)
    win.stage.resize(1600, 900)
    win.show()
    _spin(60)
    yield win, made
    win.close()
    _spin(40)


def _probed_item(path, aspect=16 / 9, duration=100.0):
    it = Item(path)
    it.aspect, it.duration, it.probed = aspect, duration, True
    return it


def _start_wall(window, n=4):
    win, made = window
    items = [_probed_item(f"/v{i}.mp4", 16 / 9) for i in range(n)]
    win.pl.queued.extend(items)
    win.schedule()
    _wait_until(lambda: len(win.tiles) == n and not win._planning)
    return items


def test_takeover_keeps_other_rects_and_waits_for_stop(window):
    win, made = window
    items = _start_wall(window)
    assert len(win.tiles) == 4
    before = {it.id: win.tiles[it.id].geometry() for it in items}
    old_tile = win.tiles[items[0].id]
    successor = _probed_item("/next.mp4", 16 / 9)
    win.pl.queued.append(successor)

    # End the first video; its tile keeps the cell while stopping.
    win._tile_finished(old_tile)
    assert old_tile in win.handoff.reserved
    # The successor now owns the same cell; its loadfile only went out once the
    # reused player reported stopped.
    _wait_until(lambda: (successor, 0.0) in old_tile.loads)
    new_tile = win.tiles.get(successor.id)
    assert new_tile is old_tile
    assert old_tile.stops and old_tile.stops[0] is items[0]
    # Every other tile kept its exact rectangle.
    for it in items[1:]:
        assert win.tiles[it.id].geometry() == before[it.id]
    win.handoff.check_invariants()


def test_no_loadfile_before_player_reports_stopped(window):
    win, made = window
    items = _start_wall(window)
    target = win.tiles[items[0].id]
    target._delay_stop = True
    successor = _probed_item("/slow.mp4")
    win.pl.queued.append(successor)
    win._tile_finished(target)
    _wait_until(lambda: target._stops_sent == 1 and target in win.handoff.reserved
                or win.handoff.tile_for(successor.id) is target)
    # The cell is reserved/handed over, but the player has not stopped:
    # no loadfile yet.
    assert target._stops_done == 0
    assert all(it is not successor for _it, it in target.loads)
    target.report_stopped()
    _wait_until(lambda: (successor, 0.0) in target.loads)
    win.handoff.check_invariants()


def test_rapid_skips_no_double_occupy_or_double_release(window):
    win, made = window
    items = _start_wall(window, n=4)
    successors = [_probed_item(f"/s{i}.mp4") for i in range(4)]
    win.pl.queued.extend(successors)
    tiles = [win.tiles[it.id] for it in items]
    # Skip all four back to back.
    for it in items:
        win._skip_id(it.id)
    # Every tile stops once and loads its successor exactly once.
    _wait_until(lambda: all(len(t.loads) == 2 for t in tiles))
    assert len(win.handoff.active) == 4
    assert len(win.handoff.owner) == 4
    for t in tiles:
        assert len(t.stops) == 1
    win.handoff.check_invariants()


def test_resize_during_handover_does_not_load_into_dead_cell(window):
    win, made = window
    items = _start_wall(window)
    target = win.tiles[items[0].id]
    target._delay_stop = True
    successor = _probed_item("/r.mp4")
    win.pl.queued.append(successor)
    win._tile_finished(target)
    _wait_until(lambda: target._stops_sent == 1)
    # A resize forces a full re-plan while the player is still stopping.
    win.stage.resize(800, 600)
    win.stage_resized()
    _wait_settled(win)
    target.report_stopped()
    _wait_settled(win)
    # No tile ever holds two cells and no job references a cell that vanished.
    owners = list(win.handoff.owner.values())
    assert len(owners) == len(set(owners))
    for job in win.handoff.jobs:
        assert win.handoff.owner.get(job.item.id) is job.tile
    win.handoff.check_invariants()


def test_lowered_concurrency_limit_demotes_and_resumes_at_position(window):
    win, made = window
    items = _start_wall(window)
    # The planner bumps the most recently started videos (the last two).
    marked = items[-1]
    tile = win.tiles[marked.id]
    tile._pos = 33.25
    win.settings.max_streams = 2
    win.schedule()
    _wait_until(lambda: any(it.resume_pos > 0 for it in win.pl.queued))
    demoted = [it for it in win.pl.queued if it.resume_pos > 0]
    assert marked in demoted and marked.resume_pos == pytest.approx(33.25)
    # Raise the limit again: the demoted video returns and resumes where it left.
    win.settings.max_streams = 4
    win.schedule()

    def resumed():
        back_tile = win.handoff.tile_for(marked.id)
        return (back_tile is not None
                and any(it is marked and start == pytest.approx(33.25)
                        for it, start in back_tile.loads))

    _wait_until(resumed)
    win.handoff.check_invariants()


def test_performance_stats_do_not_credit_old_file_drops(window):
    win, made = window
    items = _start_wall(window)
    tile = win.tiles[items[0].id]
    tile.make_dirty(drops=50, pos=80.0)
    successor = _probed_item("/clean.mp4")
    win.pl.queued.append(successor)
    win.perf.reset()
    win._tile_finished(tile)
    # The replacement starts from zero counters; wait until it has loaded.
    _wait_until(lambda: (successor, 0.0) in tile.loads)
    new_tile = win.tiles[successor.id]
    assert new_tile is tile
    s = new_tile.sample()
    assert s is not None and s.dropped == 0
    # Feed the monitor two clean samples: the ratio must stay at zero.
    win.perf.update({id(tile): Sample(0, 30.0, at=10.0, pos=0.0)}, 1.0)
    status = win.perf.update({id(tile): Sample(0, 30.0, at=11.0, pos=1.0)}, 1.0)
    assert win.perf.ratio == 0.0 and status != "red"


def test_tile_class_enforces_stop_before_load(monkeypatch):
    """The real VideoTile rejects a second loadfile before a stop completes."""
    _qapp()
    t = VideoTile(None)
    import time
    deadline = time.time() + 3
    while not t.is_ready and time.time() < deadline:
        QApplication.processEvents()
    a = _probed_item("/a.mp4")
    t.load(a)
    with pytest.raises(RuntimeError):
        t.load(a)                       # previous file never stopped
    t.stop()
    b = _probed_item("/b.mp4")
    t.load(b)                          # allowed once stopped
    assert t.item is b
    # Volume/mute/duration/drops are reset for the new file.
    assert t.volume == 100 and t.duration() == 0.0 and t.sample() is None
