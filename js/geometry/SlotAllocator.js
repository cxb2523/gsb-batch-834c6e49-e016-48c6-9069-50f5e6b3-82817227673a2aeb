export class SlotAllocator {
  constructor(capacity) {
    this.capacity = Math.max(0, capacity);
    this.usedCount = 0;
    this.freeBlocks = this.capacity > 0 ? [{ start: 0, count: this.capacity }] : [];
  }

  alloc(n) {
    if (n <= 0) return -1;
    for (let i = 0; i < this.freeBlocks.length; i++) {
      const block = this.freeBlocks[i];
      if (block.count >= n) {
        const start = block.start;
        block.start += n;
        block.count -= n;
        if (block.count === 0) this.freeBlocks.splice(i, 1);
        this.usedCount += n;
        return start;
      }
    }
    return -1;
  }

  // Whether `n` contiguous free slots are currently available.
  canAlloc(n) {
    if (n <= 0) return true;
    return this.freeBlocks.some(block => block.count >= n);
  }

  free(start, n) {
    if (n <= 0) return;
    this.usedCount -= n;
    this.freeBlocks.push({ start, count: n });
    this._mergeBlocks();
  }

  // Grow the allocator by appending a fresh free region at the end.
  // This is the single supported way to extend capacity; callers must not
  // mutate freeBlocks/capacity directly.
  grow(additionalSlots) {
    if (additionalSlots <= 0) return;
    this.capacity += additionalSlots;
    this.freeBlocks.push({ start: this.capacity - additionalSlots, count: additionalSlots });
    this._mergeBlocks();
  }

  _mergeBlocks() {
    this.freeBlocks.sort((a, b) => a.start - b.start);
    for (let i = 0; i < this.freeBlocks.length - 1;) {
      const a = this.freeBlocks[i], b = this.freeBlocks[i + 1];
      if (a.start + a.count === b.start) {
        a.count += b.count;
        this.freeBlocks.splice(i + 1, 1);
      } else i++;
    }
  }

  get utilization() { return this.capacity === 0 ? 0 : this.usedCount / this.capacity; }

  // True when the slot range [start, start + n) is currently allocated
  // (i.e. not covered by any free block). Used by consistency assertions.
  isAllocated(start, n = 1) {
    for (const block of this.freeBlocks) {
      const blockEnd = block.start + block.count;
      const rangeEnd = start + n;
      if (start < blockEnd && block.start < rangeEnd) return false;
    }
    return start >= 0 && start + n <= this.capacity;
  }

  // Internal invariant check used by tests and debug assertions:
  // free blocks must be disjoint, sorted, merged, and inside [0, capacity).
  checkInvariant() {
    let totalFree = 0;
    let prevEnd = -1;
    for (const block of this.freeBlocks) {
      if (block.count <= 0) return false;
      if (block.start < 0 || block.start + block.count > this.capacity) return false;
      if (block.start <= prevEnd) return false;
      prevEnd = block.start + block.count;
      totalFree += block.count;
    }
    if (this.usedCount !== this.capacity - totalFree) return false;
    if (this.usedCount < 0) return false;
    return true;
  }
}
