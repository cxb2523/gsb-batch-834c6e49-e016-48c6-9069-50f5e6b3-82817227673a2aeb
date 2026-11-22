"""Stable handover of a video cell from one file to the next.

When a video ends (or is skipped) its player keeps the cell while it stops,
and the next video takes over that same cell, zoom and position instead of
returning the player to an idle pool and re-solving the whole wall.

This module has no Qt dependency so the takeover state machine can be driven
offline with injected fake players (see ``tests/test_handoff.py``).  It owns
the lifecycle of every player ("tile") handed to it:

    active   : assigned to a cell and playing (or loading) a file
    reserved : its file ended; it keeps its cell while the player stops, and
               the successor's load job is attached to the same tile
    settling : no longer attached to a cell; stopping, then joining the pool
    pool     : stopped and reusable
    jobs     : (tile, item) loads waiting until the tile reports stopped

The rules enforced here are the ones a burst of skips, a window resize or a
changed concurrency limit would otherwise break:

  * a cell is owned by exactly one tile at a time (``owner``);
  * a tile is released into the pool at most once (buckets never overlap);
  * ``loadfile`` is only handed out once the reused player has reported that
    it has stopped (``take_job`` checks ``is_stopped``);
  * every job carries a generation; a re-plan invalidates jobs whose cell was
    taken away, so a file is never loaded into a dead cell;
  * a player that is still stopping never blocks another cell: ``acquire``
    only returns stopped players and otherwise makes a fresh one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class Job:
    """A file waiting to be loaded into a specific tile."""
    tile: Any
    item: Any
    start: float          # position to resume at (seconds)
    gen: int              # plan generation the job belongs to


class Handoff:
    def __init__(self) -> None:
        self.gen = 0
        self.active: dict[Any, Any] = {}     # tile -> item shown in its cell
        self.owner: dict[int, Any] = {}      # item id -> tile owning that cell
        self.reserved: dict[Any, Any] = {}   # tile -> item that ended in that cell
        self.settling: list[Any] = []        # tiles stopping, with no cell anymore
        self.pool: list[Any] = []            # stopped tiles ready for reuse
        self.jobs: list[Job] = []

    # ------------------------------------------------------------------ state
    def _buckets(self) -> list[Any]:
        return list(self.reserved) + self.settling + self.pool + list(self.active)

    def check_invariants(self) -> None:
        """Assert the lifecycle rules (used by the tests)."""
        buckets = self._buckets()
        assert len(buckets) == len(set(buckets)), "a tile is in two lifecycle buckets"
        assert all(tile.is_stopped for tile in self.pool), "the pool holds a player still stopping"
        tiles_with_jobs = [job.tile for job in self.jobs]
        assert len(tiles_with_jobs) == len(set(tiles_with_jobs)), "a tile has two load jobs"
        for job in self.jobs:
            assert self.active.get(job.tile) is job.item, "job's tile no longer owns its cell"
            assert self.owner.get(job.item.id) is job.tile, "job's cell changed owner"
        for tile, item in self.active.items():
            assert self.owner.get(item.id) is tile

    def tile_for(self, item_id: int) -> Any | None:
        """The tile owning item ``item_id``'s cell, if any (reserved included)."""
        return self.owner.get(item_id)

    def item_for(self, tile: Any):
        """The item whose cell ``tile`` currently holds (reserved included)."""
        item = self.active.get(tile)
        return item if item is not None else self.reserved.get(tile)

    # ------------------------------------------------------------- transitions
    def release_cell(self, tile: Any, item: Any) -> None:
        """The file in ``tile`` has ended (or was skipped): the tile keeps its
        cell while its player stops, so a successor can take it over."""
        if self.active.get(tile) is not item:
            return                       # a second finished/skip report: ignore
        del self.active[tile]
        self.owner.pop(item.id, None)
        if tile in self.reserved or tile in self.settling or tile in self.pool:
            return
        self.reserved[tile] = item
        tile.stop(hide=False)            # keep the last frame visible in the cell

    def takeover(self, tile: Any, item: Any, start: float) -> None:
        """Attach the successor ``item`` to a tile whose previous file ended.
        The load waits in ``jobs`` until the player reports stopped."""
        self.reserved.pop(tile, None)
        self._assign(tile, item)
        self.jobs.append(Job(tile, item, start, self.gen))

    def place(self, tile: Any, item: Any, start: float) -> None:
        """Assign a stopped pool (or fresh) tile to a new cell."""
        if tile in self.pool:
            self.pool.remove(tile)
        self._assign(tile, item)
        self.jobs.append(Job(tile, item, start, self.gen))

    def _assign(self, tile: Any, item: Any) -> None:
        self.active[tile] = item
        self.owner[item.id] = tile

    def settle(self, tile: Any, hide: bool = True) -> None:
        """Detach a tile from its cell and release it once it has stopped.
        Idempotent: releasing the same tile twice does nothing.  Tiles owned
        outside the wall (benchmark players) simply join the stopping queue."""
        if tile in self.pool:
            return
        self.reserved.pop(tile, None)
        item = self.active.pop(tile, None)
        if item is not None and self.owner.get(item.id) is tile:
            self.owner.pop(item.id, None)
        self.jobs = [job for job in self.jobs if job.tile is not tile]
        if tile not in self.settling:
            self.settling.append(tile)
            tile.stop(hide=hide)

    def cancel_item(self, item: Any) -> None:
        """Take a planned/playing item's cell away (demotion, removal)."""
        tile = self.owner.get(item.id)
        if tile is not None:
            self.settle(tile)

    def take_reserved(self, item_id: int) -> Any | None:
        """The tile in which item ``item_id`` ended, if it is still reserved."""
        for tile, old in self.reserved.items():
            if old.id == item_id:
                return tile
        return None

    # ------------------------------------------------------------------- pool
    def acquire(self, factory: Callable[[], Any]) -> Any:
        """Return a reusable, fully stopped player; make one if none is free.

        A player that is still stopping is never handed out, so a new file can
        never be loaded into a player that has not stopped its old file yet."""
        self.promote_pool()
        if self.pool:
            return self.pool.pop()
        return factory()

    def promote_pool(self) -> None:
        """Move tiles whose players have now stopped into the reusable pool."""
        for tile in [t for t in self.settling if t.is_stopped]:
            self.settling.remove(tile)
            if tile not in self.pool:
                self.pool.append(tile)

    # ------------------------------------------------------------- plan generations
    def begin_plan(self) -> int:
        """Open a structural change (takeover batch or full re-plan)."""
        self.gen += 1
        return self.gen

    def finish_plan(self, assigned) -> None:
        """Sweep tiles the new plan no longer uses and keep surviving jobs.

        Tiles absent from ``assigned`` lose their cell; jobs whose tile and
        item are still assigned are refreshed to the new generation so their
        pending load survives the re-plan instead of being duplicated."""
        assigned = set(assigned)
        for tile in list(self.reserved):
            if tile not in assigned:
                self.settle(tile)
        for tile in list(self.active):
            if tile not in assigned:
                self.settle(tile)
        kept: list[Job] = []
        for job in self.jobs:
            # Cells that survived the re-plan keep their pending load, refreshed
            # to the new generation so it is not duplicated; the rest are dead.
            if job.tile in assigned and self.owner.get(job.item.id) is job.tile:
                job.gen = self.gen
                kept.append(job)
        self.jobs = kept
        self.promote_pool()

    # ------------------------------------------------------------------- loads
    def take_job(self) -> Job | None:
        """The next file that may be loaded right now: its player has reported
        stopped and its cell still belongs to it.  Jobs whose player is still
        stopping stay queued, in order; jobs from a superseded plan (or whose
        cell vanished) are dropped."""
        self.promote_pool()
        live: list[Job] = []
        due: Job | None = None
        for job in self.jobs:
            if job.gen != self.gen or self.owner.get(job.item.id) is not job.tile:
                continue                       # superseded: never load it
            live.append(job)
            if due is None and job.tile.is_stopped:
                due = job
        self.jobs = [j for j in live if j is not due]
        return due
