import type { Bounds } from "../types";
import { itemsBounds, type BoundedItem } from "../utils/itemBounds";
import type { ItemCollectionChange, ItemKey, ReadonlyItemCollection } from "./ItemCollection";
import { SpatialIndex, type SpatialIndexToken } from "./SpatialIndex";

/**
 * Projects one item onto the world-space box stored in the R-tree. Return
 * `null` for an item that occupies no space (it stays in the ordered view but
 * never matches a spatial query). Bounds with non-finite coordinates are
 * treated the same way and stay queryable through the unbounded fallback.
 */
export interface LayerDataSourceOptions<T> {
    boundsOf?: (item: T) => Bounds | null;
}

/** The R-tree node; the public item object stays untouched. */
interface IndexedItem<T> {
    x: number;
    y: number;
    width: number;
    height: number;
    item: T;
}

/**
 * Read-only view of a layer data source, as handed out by
 * `CanvasTileEngine.getLayerSource`. Query results are always in the
 * collection's current order — the same order drawing and hit testing use.
 */
export interface ReadonlyCollectionLayerSource<T extends object> {
    /** The observed collection, or null once detached/disposed. */
    readonly collection: ReadonlyItemCollection<T> | null;
    /** Ordered live view shared with the layer's draw registration. */
    readonly items: readonly T[];
    readonly size: number;
    /** Index sync passes so far: the initial build plus one per notification. */
    readonly syncCount: number;
    readonly disposed: boolean;
    get(key: ItemKey): T | undefined;
    keyAt(index: number): ItemKey | undefined;
    /** Dense position of an item object, or -1 when it is not in the source. */
    indexOf(item: T): number;
    query(region: Bounds, padding?: number): T[];
    queryPoint(x: number, y: number, padding?: number): T[];
    subscribe(listener: (changes: readonly ItemCollectionChange<T>[]) => void): () => void;
}

/**
 * One ordered, keyed collection bound to a spatial index — the data source a
 * layer (or hit tester) reads instead of keeping its own copy of the items.
 *
 * Every change the {@link ReadonlyItemCollection} commits is applied to the
 * index synchronously, before this source notifies its own subscribers. A
 * batch is one notification, so it produces one index sync pass no matter how
 * many mutations it grouped. Queries return items in the collection's current
 * order (insertions append, updates keep their slot, removals compact), which
 * is the same order drawing and hit testing see.
 *
 * Lifecycle: the source owns exactly one collection subscription.
 * {@link setCollection} unsubscribes the previous collection first, and
 * {@link dispose} detaches for good — later mutations of either collection
 * cannot reach the index. A rejected mutation (for example a duplicate-key
 * insert, which the collection refuses before recording a change) never
 * produces a notification, so the index and the ordered view stay untouched.
 */
export class CollectionLayerSource<T extends object> implements ReadonlyCollectionLayerSource<T> {
    private collectionRef: ReadonlyItemCollection<T> | null = null;
    private unsubscribeCollection: (() => void) | null = null;
    private readonly values: T[] = [];
    private readonly keys: ItemKey[] = [];
    private readonly tokens: (SpatialIndexToken<IndexedItem<T>> | null)[] = [];
    /** Parallel to `values`: false for items the index cannot place. */
    private readonly bounded: boolean[] = [];
    private positions = new Map<T, number>();
    private unboundedCount = 0;
    private index = new SpatialIndex<IndexedItem<T>>();
    private readonly boundsOf: (item: T) => Bounds | null;
    private readonly listeners = new Set<(changes: readonly ItemCollectionChange<T>[]) => void>();
    private syncs = 0;
    private disposedFlag = false;

    constructor(collection: ReadonlyItemCollection<T>, options?: LayerDataSourceOptions<T>) {
        this.boundsOf = options?.boundsOf ?? defaultBoundsOf;
        this.adopt(collection);
        this.syncs = 1;
    }

    /** The observed collection, or null when detached/disposed. */
    get collection(): ReadonlyItemCollection<T> | null {
        return this.collectionRef;
    }

    /** Ordered live view — same order as the collection and the index. */
    get items(): readonly T[] {
        return this.values;
    }

    get size(): number {
        return this.values.length;
    }

    /**
     * Number of index sync passes performed: one initial build plus one per
     * delivered collection notification. A batch increments this once.
     */
    get syncCount(): number {
        return this.syncs;
    }

    get disposed(): boolean {
        return this.disposedFlag;
    }

    get(key: ItemKey): T | undefined {
        return this.disposedFlag ? undefined : this.collectionRef?.get(key);
    }

    keyAt(index: number): ItemKey | undefined {
        return index >= 0 && index < this.keys.length ? this.keys[index] : undefined;
    }

    /** Current dense position of an item object, or -1 when it is not indexed. */
    indexOf(item: T): number {
        return this.positions.get(item) ?? -1;
    }

    /**
     * Items whose indexed box overlaps `region` (inclusive), in collection
     * order. `padding` grows the query rectangle in world units; negative
     * values are treated as 0.
     */
    query(region: Bounds, padding = 0): T[] {
        if (this.disposedFlag) {
            return [];
        }
        const pad = padding > 0 ? padding : 0;
        const minX = Math.min(region.minX, region.maxX) - pad;
        const maxX = Math.max(region.minX, region.maxX) + pad;
        const minY = Math.min(region.minY, region.maxY) - pad;
        const maxY = Math.max(region.minY, region.maxY) + pad;

        const hits = this.index.query(minX, minY, maxX, maxY);
        if (this.unboundedCount === 0) {
            return hits.map((entry) => entry.item);
        }
        // Items without finite bounds must still answer queries; fall back to
        // the ordered list so their relative order stays exact.
        const matched = new Set(hits.map((entry) => entry.item));
        const results: T[] = [];
        for (let i = 0; i < this.values.length; i++) {
            if (!this.bounded[i] || matched.has(this.values[i])) {
                results.push(this.values[i]);
            }
        }
        return results;
    }

    /** Every item whose indexed box contains `(x, y)`, in collection order. */
    queryPoint(x: number, y: number, padding = 0): T[] {
        return this.query({ minX: x, minY: y, maxX: x, maxY: y }, padding);
    }

    /**
     * Observe committed collection changes. Listeners run after the index is
     * current and receive the same ordered deltas the collection emitted;
     * errors are collected and the first one is rethrown after every listener
     * has run. Returns an unsubscribe function (a no-op once disposed).
     */
    subscribe(listener: (changes: readonly ItemCollectionChange<T>[]) => void): () => void {
        if (this.disposedFlag) {
            return () => {};
        }
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Observe a different collection, dropping the previous subscription and
     * rebuilding the index from the new collection's current order. Listeners
     * receive the transition as ordinary deltas — every previous item removed
     * (highest index first) and every new item appended — so renderers that
     * mirror the source reuse their incremental update path instead of
     * rebuilding from scratch. Changes made to the old collection afterwards
     * never reach this source.
     */
    setCollection(collection: ReadonlyItemCollection<T> | null): void {
        if (this.disposedFlag) {
            throw new Error("CollectionLayerSource: cannot replace the collection of a disposed source");
        }
        if (collection === this.collectionRef) {
            return;
        }
        const previous: { key: ItemKey; item: T }[] = [];
        for (let i = this.values.length - 1; i >= 0; i--) {
            previous.push({ key: this.keys[i], item: this.values[i] });
        }
        this.adopt(collection);
        this.syncs++;
        if (previous.length === 0 && this.values.length === 0) {
            this.emitRebuild();
            return;
        }
        const changes: ItemCollectionChange<T>[] = [];
        // Replay the swap as ordinary sequential deltas: remove from the end so
        // each splice stays valid, then append the new items in order. Renderers
        // that mirror the source reuse their incremental update path.
        for (let i = 0; i < previous.length; i++) {
            const index = previous.length - 1 - i;
            changes.push(Object.freeze({ type: "remove", key: previous[i].key, item: previous[i].item, index }));
        }
        for (let i = 0; i < this.values.length; i++) {
            changes.push(Object.freeze({ type: "insert", key: this.keys[i], item: this.values[i], index: i }));
        }
        this.emit(Object.freeze(changes));
    }

    /** Detach the subscription and release the index. Safe to call twice. */
    dispose(): void {
        if (this.disposedFlag) {
            return;
        }
        this.disposedFlag = true;
        this.unsubscribeCollection?.();
        this.unsubscribeCollection = null;
        this.collectionRef = null;
        this.listeners.clear();
        this.reset();
    }

    private adopt(collection: ReadonlyItemCollection<T> | null): void {
        this.unsubscribeCollection?.();
        this.collectionRef = collection;
        this.build();
        this.unsubscribeCollection = collection ? collection.subscribe((changes) => this.apply(changes)) : null;
    }

    private reset(): void {
        this.values.length = 0;
        this.keys.length = 0;
        this.tokens.length = 0;
        this.bounded.length = 0;
        this.positions.clear();
        this.unboundedCount = 0;
        this.index.clear();
    }

    /** Rebuild from the collection's current order — the only O(n) sync. */
    private build(): void {
        this.reset();
        const collection = this.collectionRef;
        if (!collection) {
            return;
        }
        const indexed: IndexedItem<T>[] = [];
        const slots: number[] = [];
        for (let i = 0; i < collection.items.length; i++) {
            const item = collection.items[i];
            this.values.push(item);
            this.keys.push(collection.keyAt(i)!);
            this.tokens.push(null);
            this.positions.set(item, i);
            const box = this.boxOf(item);
            this.bounded.push(box !== null);
            if (box) {
                indexed.push({ ...box, item });
                slots.push(i);
            } else {
                this.unboundedCount++;
            }
        }
        const tokens = this.index.load(indexed);
        for (let k = 0; k < tokens.length; k++) {
            this.tokens[slots[k]] = tokens[k];
        }
    }

    private apply(changes: readonly ItemCollectionChange<T>[]): void {
        if (this.disposedFlag || !this.collectionRef) {
            return;
        }
        let removed = false;
        for (const change of changes) {
            // The collection commits before notifying, so a mismatch here means
            // this source missed a delta; the collection is still the truth.
            if (!this.matches(change)) {
                this.build();
                this.syncs++;
                this.emit(changes);
                return;
            }
            if (change.type === "insert") {
                this.applyInsert(change);
            } else if (change.type === "update") {
                this.applyUpdate(change);
            } else {
                this.applyRemove(change);
                removed = true;
            }
        }
        if (removed) {
            // Dense positions shift after a removal; the R-tree's stable paint
            // order does not. Rebuild the lookup once per notification.
            this.positions = new Map(this.values.map((item, index) => [item, index]));
        }
        this.syncs++;
        this.emit(changes);
    }

    private matches(change: ItemCollectionChange<T>): boolean {
        if (change.type === "insert") {
            return change.index === this.values.length;
        }
        return change.index >= 0 && change.index < this.values.length && this.keys[change.index] === change.key;
    }

    private applyInsert(change: Extract<ItemCollectionChange<T>, { type: "insert" }>): void {
        const box = this.boxOf(change.item);
        this.values.push(change.item);
        this.keys.push(change.key);
        this.bounded.push(box !== null);
        if (box) {
            this.tokens.push(this.index.insert({ ...box, item: change.item }));
        } else {
            this.tokens.push(null);
            this.unboundedCount++;
        }
        this.positions.set(change.item, this.values.length - 1);
    }

    private applyUpdate(change: Extract<ItemCollectionChange<T>, { type: "update" }>): void {
        const slot = change.index;
        const token = this.tokens[slot];
        const box = this.boxOf(change.item);
        this.values[slot] = change.item;
        this.positions.delete(change.previous);
        this.positions.set(change.item, slot);

        if (box && token) {
            if (!this.index.update(token, { ...box, item: change.item })) {
                this.tokens[slot] = this.index.insert({ ...box, item: change.item });
            }
        } else if (box) {
            this.tokens[slot] = this.index.insert({ ...box, item: change.item });
        } else if (token) {
            this.index.remove(token);
            this.tokens[slot] = null;
        }
        if (this.bounded[slot] !== (box !== null)) {
            this.unboundedCount += box ? -1 : 1;
            this.bounded[slot] = box !== null;
        }
    }

    private applyRemove(change: Extract<ItemCollectionChange<T>, { type: "remove" }>): void {
        const slot = change.index;
        const token = this.tokens[slot];
        if (token) {
            this.index.remove(token);
        } else {
            this.unboundedCount--;
        }
        this.values.splice(slot, 1);
        this.keys.splice(slot, 1);
        this.tokens.splice(slot, 1);
        this.bounded.splice(slot, 1);
        this.positions.delete(change.item);
    }

    private emit(changes: readonly ItemCollectionChange<T>[]): void {
        let firstError: unknown;
        let listenerThrew = false;
        for (const listener of [...this.listeners]) {
            try {
                listener(changes);
            } catch (error) {
                if (!listenerThrew) {
                    firstError = error;
                    listenerThrew = true;
                }
            }
        }
        if (listenerThrew) {
            throw firstError;
        }
    }

    /** Empty transition notification for a rebuild that changed no items. */
    private emitRebuild(): void {
        this.emit(Object.freeze([]));
    }

    private boxOf(item: T): Omit<IndexedItem<T>, "item"> | null {
        const bounds = this.boundsOf(item);
        if (!bounds) {
            return null;
        }
        const { minX, minY, maxX, maxY } = bounds;
        if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
            return null;
        }
        return {
            x: (minX + maxX) / 2,
            y: (minY + maxY) / 2,
            width: Math.abs(maxX - minX),
            height: Math.abs(maxY - minY),
        };
    }
}

/**
 * Default projection: every item kind the draw API accepts, measured in world
 * units. Anchored items use their cell box, lines their endpoint box, paths
 * their vertex/control hull. Camera-dependent extents (`sizePx`, measured
 * text) are not part of this box; callers that index them should pass their
 * own `boundsOf`.
 */
function defaultBoundsOf(item: object): Bounds | null {
    return itemsBounds([item as BoundedItem]);
}
