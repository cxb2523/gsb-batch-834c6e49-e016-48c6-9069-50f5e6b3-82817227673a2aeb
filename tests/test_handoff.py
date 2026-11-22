"""Offline tests for the stable cell-takeover path.

The whole handover state machine (``polyreel.handoff``), the scheduler's
fast handover decision and the tile's stop/reset behaviour are driven here
with an injected fake player -- no libmpv, no GUI event loop required.
"""

import pytest

from polyreel import layout as L
from polyreel.handoff import Handoff
from polyreel.playlist import Item
from polyreel.scheduler import handover, plan

W, H = 1600, 900


# --------------------------------------------------------------------------
# A fake player standing in for VideoTile: stop() is asynchronous until the
# test "reports" the stop, exactly like a busy libmpv player.
# --------------------------------------------------------------------------

class FakeTile:
    def __init__(self, num: int, stopped: bool = True):
        self.num = num
        self.item = None
        self._stopped = stopped
        self.stops = 0
        self.hide_calls = 0
        # Files loaded, in order, each as (item, start_position).
        self.loads: list[tuple] = []
        # Snapshot of the player state at the moment loadfile was sent.
        self.load_state: list[dict] = []
        self.state = {"duration": 0.0, "volume": 100, "muted": True,
                      "frame-drop-count": 0, "decoder-frame-drop-count": 0,
                      "container-fps": None, "time-pos": 0.0}
        self._pos = 0.0
        self.zoom = 1.0

    @property
    def is_stopped(self) -> bool:
        return self._stopped

    def stop(self, hide: bool = True) -> None:
        # Idempotent, like VideoTile.stop: once a stop has been requested the
        # tile holds no item, so further stop() calls are no-ops.
        if self.item is None:
            return
        self.item = None
        self._stopped = False
        self.stops += 1
        if hide:
            self.hide_calls += 1

    def report_stopped(self) -> None:
        """The player reports it carried out the stop (mpv event thread)."""
        self._stopped = True

    def load(self, item, start: float = 0.0, loop: bool = False, hwdec=None) -> None:
        if not self._stopped:
            raise RuntimeError(f"fake player #{self.num}: load before stopped")
        # Record what the previous file would otherwise have left behind.
        self.load_state.append(dict(self.state))
        self.item = item
        self.loads.append((item, start))
        self._pos = start
        self._stopped = False          # a file is now loaded: no longer stopped
        # A real tile clears every leftover value before loadfile.
        self.state = {"duration": 0.0, "volume": 100, "muted": True,
                      "frame-drop-count": 0, "decoder-frame-drop-count": 0,
                      "container-fps": None, "time-pos": 0.0}

    def position(self) -> float:
        return self._pos

    def set_zoom(self, zoom: float) -> None:
        self.zoom = zoom

    # -- helpers to simulate an old file's accumulated state ---------------
    def make_dirty(self, duration=120.0, volume=37, muted=False, drops=42,
                   fps=25.0, pos=55.0) -> None:
        self.state.update({"duration": duration, "volume": volume, "muted": muted,
                           "frame-drop-count": drops, "decoder-frame-drop-count": 5,
                           "container-fps": fps, "time-pos": pos})
        self._pos = pos


def _item(path: str, aspect=16 / 9, duration=100.0) -> Item:
    it = Item(path)
    it.aspect, it.duration, it.probed = aspect, duration, True
    return it


# --------------------------------------------------------------- coordinator
def _drain_jobs(h: Handoff):
    """Pop every currently loadable job and perform its loadfile, like the
    app's 50 ms load pump."""
    done = []
    while True:
        job = h.take_job()
        if job is None:
            return done
        job.tile.load(job.item, start=job.start)
        done.append(job)


def test_takeover_waits_for_stop_before_loadfile():
    h = Handoff()
    old, t = _item("/old.mp4"), FakeTile(1)
    t.item = old
    t.report_stopped()
    h.place(t, old, 0.0)
    assert _drain_jobs(h) and t.loads == [(old, 0.0)]

    new = _item("/new.mp4")
    # The old file ends: the cell is reserved and an asynchronous stop starts.
    h.release_cell(t, old)
    assert t in h.reserved and not t.is_stopped
    h.takeover(t, new, 0.0)
    h.check_invariants()

    # Until the player reports stopped, no loadfile may be handed out.
    assert h.take_job() is None
    assert t.loads == [(old, 0.0)]
    t.report_stopped()
    job = h.take_job()
    assert job is not None and job.tile is t and job.item is new
    t.load(job.item, start=job.start)
    assert t.loads[-1] == (new, 0.0)
    h.check_invariants()


def test_load_clears_every_trace_of_the_previous_file():
    t = FakeTile(1)
    old = _item("/old.mp4")
    t.item = old
    t.make_dirty()
    t.stop()
    t.report_stopped()

    # Mimic VideoTile.load's reset contract on the fake's state dict.
    new = _item("/new.mp4")
    leftover_before = dict(t.state)
    t.state.update({"duration": 0.0, "volume": 100, "muted": True,
                    "frame-drop-count": 0, "decoder-frame-drop-count": 0,
                    "container-fps": None, "time-pos": 0.0})
    t.load(new, start=0.0)
    assert leftover_before["duration"] == 120.0      # the old file had values...
    assert t.state["duration"] == 0.0                # ...the new one starts clean
    assert t.state["frame-drop-count"] == 0
    assert t.state["decoder-frame-drop-count"] == 0
    assert t.state["volume"] == 100 and t.state["muted"] is True
    assert t.state["container-fps"] is None


def test_reused_player_cannot_be_acquired_while_stopping():
    h = Handoff()
    t = FakeTile(1)
    a = _item("/a.mp4")
    h.place(t, a, 0.0)
    _drain_jobs(h)
    h.settle(t)                                  # back to the pool, stopping
    created = []
    fresh = h.acquire(lambda: created.append(FakeTile(2)) or created[0])
    t.report_stopped()
    assert fresh is not t and fresh.num == 2     # a fresh player, not the busy one
    h.promote_pool()
    assert t in h.pool
    # Now the stopped player is reused for the next cell.
    b = _item("/b.mp4")
    got = h.acquire(lambda: FakeTile(3))
    assert got is t
    h.place(got, b, 0.0)
    h.check_invariants()


def test_release_is_idempotent_and_never_double_pools():
    h = Handoff()
    t = FakeTile(1)
    a = _item("/a.mp4")
    h.place(t, a, 0.0)
    _drain_jobs(h)
    h.settle(t)
    h.settle(t)                                 # second release: no second stop
    h.settle(t)
    assert t.stops == 1
    t.report_stopped()
    h.promote_pool()
    assert h.pool.count(t) == 1
    h.check_invariants()


def test_repeated_finish_reports_are_ignored():
    h = Handoff()
    t = FakeTile(1)
    a = _item("/a.mp4")
    h.place(t, a, 0.0)
    _drain_jobs(h)
    h.release_cell(t, a)
    h.release_cell(t, a)                        # duplicate eof/skip report
    assert t.stops == 1 and len(h.reserved) == 1
    h.check_invariants()


def test_rapid_skips_never_double_occupy_or_double_load():
    h = Handoff()
    tiles = [FakeTile(i) for i in range(1, 5)]
    items = [_item(f"/v{i}.mp4") for i in range(4)]
    for t, it in zip(tiles, items):
        t.item = it
        h.place(t, it, 0.0)
        assert _drain_jobs(h)
    successors = [_item(f"/s{i}.mp4") for i in range(4)]

    # End all four at once, then hand their cells over before any player has
    # reported stopped.
    for t, it in zip(tiles, items):
        h.begin_plan()
        h.release_cell(t, it)
        h.takeover(t, successors[items.index(it)], 0.0)
        h.finish_plan(h.active)
    h.check_invariants()
    # Each cell has exactly one owner; no successor got a loadfile yet.
    assert len(h.active) == 4 and len(h.owner) == 4
    assert all(t.loads == [(it, 0.0)] for t, it in zip(tiles, items))

    # Players report stopping one by one; each gets exactly one successor load.
    for t in tiles:
        t.report_stopped()
        jobs = _drain_jobs(h)
        assert len(jobs) == 1 and jobs[0].tile is t
        assert h.take_job() is None             # one job per tile, no duplicates
    assert {t.item for t in tiles} == set(successors)
    h.check_invariants()


def test_demoted_video_keeps_resume_position_and_resumes_from_it():
    h = Handoff()
    t = FakeTile(1)
    a = _item("/a.mp4")
    h.place(t, a, 0.0)
    _drain_jobs(h)
    t._pos = 34.5                               # the user watched this far
    # A lowered concurrency limit bumps it back to the queue.
    h.begin_plan()
    h.cancel_item(a)
    h.finish_plan(h.active)
    assert t in h.settling
    t.report_stopped()
    h.promote_pool()

    # It returns to the wall later and resumes from the saved position.
    a.resume_pos = 34.5
    again = h.acquire(lambda: FakeTile(2))
    h.begin_plan()
    h.place(again, a, a.resume_pos)
    h.finish_plan(h.active)
    job = h.take_job()
    assert job.start == pytest.approx(34.5)
    again.load(job.item, start=job.start)
    assert again.loads[-1] == (a, pytest.approx(34.5))
    h.check_invariants()


def test_replan_invalidates_jobs_for_lost_cells():
    h = Handoff()
    t1, t2 = FakeTile(1), FakeTile(2)
    a, b = _item("/a.mp4"), _item("/b.mp4")
    h.place(t1, a, 0.0)
    h.place(t2, b, 0.0)
    _drain_jobs(h)
    c = _item("/c.mp4")
    t3 = FakeTile(3)
    h.begin_plan()
    h.place(t3, c, 0.0)                         # a different cell entirely
    # The new plan assigns only t3: the two old cells are swept away.
    h.finish_plan([t3])
    # The old jobs are gone: nothing loads into the dead cells.
    assert all(job.tile is t3 for job in h.jobs)
    assert t1 in h.settling and t2 in h.settling and not h.pool
    t1.report_stopped()
    t2.report_stopped()                          # their stop completes...
    h.promote_pool()
    assert t1 in h.pool and t2 in h.pool         # ...then they join the pool
    h.check_invariants()


def test_one_tile_never_holds_two_cells():
    h = Handoff()
    t = FakeTile(1)
    a, b = _item("/a.mp4"), _item("/b.mp4")
    h.place(t, a, 0.0)
    _drain_jobs(h)
    # Trying to assign a second item to the same tile while it is still active
    # must move the first out first (as the app does via settle/release).
    h.settle(t)
    t.report_stopped()
    h.promote_pool()
    same = h.acquire(lambda: FakeTile(2))
    assert same is t
    h.place(same, b, 0.0)
    assert h.owner == {b.id: t} and list(h.active) == [t]
    h.check_invariants()


# --------------------------------------------------------------- scheduler
def _layout_for(items):
    return L.solve([(it.id, it.aspect) for it in items], W, H, seed=1, budget=None)


def test_handover_reuses_the_previous_cell_without_moving_others():
    playing = [_item(f"/p{i}.mp4", a) for i, a in enumerate(
        [16 / 9, 16 / 9, 9 / 16, 4 / 3])]
    prev = _layout_for(playing)
    ended = [playing[0]]
    successor = _item("/new.mp4", 16 / 9)
    hp = handover(playing, [successor], ended, W, H,
                  max_streams=4, min_area=0.01, prev=prev, lookahead=1)
    assert hp is not None
    (old, new), = hp.takeovers
    assert old is ended[0] and new is successor
    # Every surviving tile keeps its exact rectangle (within 1 px).
    for it in playing[1:]:
        a, b = prev.rects[it.id], hp.layout.rects[it.id]
        assert abs(a.x - b.x) <= 1 and abs(a.y - b.y) <= 1
        assert abs(a.w - b.w) <= 1 and abs(a.h - b.h) <= 1
    # The newcomer inherits the ended cell's footprint.
    assert abs(hp.layout.rects[successor.id].area - prev.rects[ended[0].id].area) <= 1


def test_handover_picks_closest_shape_for_the_cell():
    playing = [_item("/land.mp4", 16 / 9), _item("/port.mp4", 9 / 16),
               _item("/sq.mp4", 1.0)]
    prev = _layout_for(playing)
    portrait_cell_item = playing[1]
    landscape, portrait = _item("/wide.mp4", 21 / 9), _item("/tall.mp4", 9 / 16)
    hp = handover(playing, [landscape, portrait], [portrait_cell_item], W, H,
                  max_streams=4, min_area=0.01, prev=prev, lookahead=2)
    assert hp is not None
    (_old, new), = hp.takeovers
    assert new is portrait                     # same shape wins the portrait cell


def test_handover_falls_back_when_queue_is_empty():
    playing = [_item(f"/p{i}.mp4") for i in range(3)]
    prev = _layout_for(playing)
    assert handover(playing, [], [playing[0]], W, H, 4, 0.01, prev) is None


def test_handover_falls_back_when_concurrency_cap_drops_below_count():
    playing = [_item(f"/p{i}.mp4") for i in range(4)]
    prev = _layout_for(playing)
    nxt = _item("/n.mp4")
    # Cap of 2 with 3 survivors means the ended cell must not be refilled.
    assert handover(playing, [nxt], [playing[3]], W, H, 2, 0.01, prev) is None


def test_handover_falls_back_when_min_area_violated():
    playing = [_item(f"/p{i}.mp4") for i in range(4)]
    prev = _layout_for(playing)
    nxt = _item("/n.mp4", 9 / 16)
    # An extreme smallest-size requirement cannot be met in place.
    assert handover(playing, [nxt], [playing[0]], W, H, 4, 0.9, prev) is None


def test_full_plan_still_demotes_and_refills_after_failed_handover():
    playing = [_item(f"/p{i}.mp4") for i in range(4)]
    queued = [_item(f"/q{i}.mp4") for i in range(3)]
    p = plan(playing, queued, W, H, max_streams=3, min_area=0.01)
    assert p.demote                                 # something was bumped
    assert len(p.layout.rects) <= 3 and p.layout.valid


def test_demoted_item_resumes_via_the_real_playlist_flow():
    from polyreel.playlist import Playlists
    pl = Playlists()
    a, b = pl.add(["/a.mp4", "/b.mp4"])
    for it in (a, b):
        it.aspect, it.probed = 16 / 9, True
    pl.start(a)
    pl.start(b)
    pl.demote(a, 21.0)
    assert a.resume_pos == 21.0 and pl.queued[0] is a
    pl.start(a)
    assert a in pl.playing
    # The handover job would carry resume_pos straight into tile.load.
    assert a.resume_pos == 21.0
