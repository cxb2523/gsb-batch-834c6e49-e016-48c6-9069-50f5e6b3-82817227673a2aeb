import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemCollection } from "../../src/modules/ItemCollection";
import { CollectionLayerSource } from "../../src/modules/LayerDataSource";
import type { Bounds } from "../../src/types";

type Marker = { id: string; x: number; y: number; size?: number; width?: number; height?: number };

const marker = (id: string, x: number, y = 0, size = 1): Marker => ({ id, x, y, size });

function collection(items: Marker[] = []) {
    return new ItemCollection<Marker>(items, { keyOf: (item) => item.id });
}

/** A collection plus the source observing it, so tests can mutate through the typed handle. */
function fixture(items: Marker[] = [], boundsOf?: (item: Marker) => Bounds | null) {
    const source = collection(items);
    const layer = new CollectionLayerSource<Marker>(source, boundsOf ? { boundsOf } : undefined);
    created.push(layer);
    return { source, layer };
}

const created: CollectionLayerSource<Marker>[] = [];

const box = (minX: number, maxX: number, minY = -Infinity, maxY = Infinity): Bounds => ({
    minX,
    maxX,
    minY,
    maxY,
});

afterEach(() => {
    created.splice(0).forEach((layer) => layer.dispose());
    vi.restoreAllMocks();
});

describe("CollectionLayerSource", () => {
    it("builds an ordered index and returns queries in collection order", () => {
        const { layer } = fixture([marker("a", 0), marker("b", 1), marker("c", 2)]);
        expect(layer.size).toBe(3);
        expect(layer.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(layer.query(box(0, 10)).map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(layer.queryPoint(1, 0).map((item) => item.id)).toEqual(["b"]);
        expect(layer.syncCount).toBe(1);
    });

    it("finds an item inserted after registration and keeps insertion order", () => {
        const { source, layer } = fixture([marker("a", 0), marker("b", 1)]);
        const changes = vi.fn();
        layer.subscribe(changes);

        source.insert(marker("c", 2));

        expect(layer.query(box(0, 10)).map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(layer.queryPoint(2, 0).map((item) => item.id)).toEqual(["c"]);
        expect(changes).toHaveBeenCalledTimes(1);
        expect(changes.mock.calls[0][0].map((change: { type: string }) => change.type)).toEqual(["insert"]);
        expect(layer.syncCount).toBe(2);
    });

    it("moves an updated item: old geometry is unreachable, new geometry answers", () => {
        const { source, layer } = fixture([marker("a", 0)]);

        source.update("a", { x: 50 });

        expect(layer.queryPoint(0, 0)).toEqual([]);
        expect(layer.queryPoint(50, 0).map((item) => item.id)).toEqual(["a"]);
        expect(layer.items[0].x).toBe(50);
        expect(layer.syncCount).toBe(2);
    });

    it("drops a removed item from every query and compacts order", () => {
        const { source, layer } = fixture([marker("a", 0), marker("b", 1), marker("c", 2)]);

        source.remove("b");

        expect(layer.items.map((item) => item.id)).toEqual(["a", "c"]);
        expect(layer.query(box(0, 10)).map((item) => item.id)).toEqual(["a", "c"]);
        expect(layer.queryPoint(1, 0)).toEqual([]);
        expect(layer.keyAt(1)).toBe("c");
        expect(layer.indexOf(layer.items[0])).toBe(0);
    });

    it("syncs a whole batch exactly once while ending at the collection's final state", () => {
        const { source, layer } = fixture([marker("a", 0), marker("b", 10), marker("c", 20)]);
        const changes = vi.fn();
        layer.subscribe(changes);
        const before = layer.syncCount;

        source.batch(() => {
            source.insert(marker("d", 30));
            source.update("a", { x: 40 });
            source.remove("b");
            source.update("c", { x: 5 });
        });

        expect(layer.syncCount - before).toBe(1);
        expect(changes).toHaveBeenCalledTimes(1);
        expect(layer.items.map((item) => item.id)).toEqual(["a", "c", "d"]);
        expect(layer.query(box(-100, 100)).map((item) => item.id)).toEqual(["a", "c", "d"]);
        expect(layer.queryPoint(10, 0)).toEqual([]);
        expect(layer.queryPoint(5, 0).map((item) => item.id)).toEqual(["c"]);
    });

    it("applies a single insert incrementally rather than rebuilding the index", () => {
        const items = Array.from({ length: 800 }, (_, i) => marker(String(i), i * 2));
        const { source, layer } = fixture(items);
        const index = (layer as unknown as { index: { load: (...args: unknown[]) => unknown } }).index;
        const load = vi.spyOn(index, "load");

        source.insert(marker("new", -100));

        expect(load).not.toHaveBeenCalled();
        expect(layer.queryPoint(-100, 0).map((item) => item.id)).toEqual(["new"]);
    });

    it("replaces the collection, detaching the old subscription entirely", () => {
        const oldCollection = collection([marker("old", 0)]);
        const layer = new CollectionLayerSource<Marker>(oldCollection);
        created.push(layer);
        const changes = vi.fn();
        layer.subscribe(changes);

        const newCollection = collection([marker("new", 5), marker("second", 6)]);
        layer.setCollection(newCollection);

        // Removal + insertion deltas fully describe the swap.
        expect(changes).toHaveBeenCalledTimes(1);
        expect(changes.mock.calls[0][0].map((change: { type: string }) => change.type)).toEqual([
            "remove",
            "insert",
            "insert",
        ]);
        expect(layer.items.map((item) => item.id)).toEqual(["new", "second"]);
        expect(layer.queryPoint(0, 0)).toEqual([]);
        expect(layer.queryPoint(5, 0).map((item) => item.id)).toEqual(["new"]);

        const before = layer.syncCount;
        // Mutating the detached collection must not touch the source.
        oldCollection.insert(marker("ghost", 5));
        oldCollection.update("old", { x: 7 });
        expect(layer.syncCount).toBe(before);
        expect(layer.queryPoint(5, 0).map((item) => item.id)).toEqual(["new"]);
        expect(layer.items.map((item) => item.id)).toEqual(["new", "second"]);

        // The new collection still drives the source.
        newCollection.insert(marker("third", 9));
        expect(layer.queryPoint(9, 0).map((item) => item.id)).toEqual(["third"]);
    });

    it("stops observing after dispose and rejects later replacement", () => {
        const source = collection([marker("a", 0)]);
        const layer = new CollectionLayerSource<Marker>(source);
        layer.dispose();

        source.insert(marker("b", 1));

        expect(layer.items).toEqual([]);
        expect(layer.query(box(-10, 10))).toEqual([]);
        expect(layer.size).toBe(0);
        expect(layer.collection).toBeNull();
        expect(layer.disposed).toBe(true);
        expect(() => layer.setCollection(collection([marker("c", 2)]))).toThrow("disposed");
        expect(layer.subscribe(() => {})).toBeTypeOf("function");
        // Idempotent.
        expect(() => layer.dispose()).not.toThrow();
    });

    it("keeps the collection, index, and order intact when a duplicate key is rejected", () => {
        const { source, layer } = fixture([marker("a", 0), marker("b", 1)]);
        const before = layer.syncCount;

        expect(() => source.insert(marker("a", 99))).toThrow("duplicate key");

        expect(layer.syncCount).toBe(before);
        expect(layer.items.map((item) => item.id)).toEqual(["a", "b"]);
        expect(layer.query(box(-1, 2)).map((item) => item.id)).toEqual(["a", "b"]);
        // The rejected duplicate's location is still empty.
        expect(layer.queryPoint(99, 0)).toEqual([]);
    });

    it("orders results by collection order, not by R-tree insertion order", () => {
        // Reverse spatial placement: later collection items sit left of earlier.
        const { source, layer } = fixture([marker("a", 30), marker("b", 20), marker("c", 10)]);
        expect(layer.query(box(0, 40)).map((item) => item.id)).toEqual(["a", "b", "c"]);

        source.insert(marker("d", 0));
        expect(layer.query(box(0, 40)).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("honors a custom bounds projection, including a null fallback", () => {
        type Wide = { id: string; x: number; y: number; label?: boolean };
        const items: Wide[] = [
            { id: "unbounded", x: 0, y: 0, label: true },
            { id: "box", x: 10, y: 0 },
        ];
        const source = new ItemCollection<Wide>(items, { keyOf: (item) => item.id });
        const layer = new CollectionLayerSource<Wide>(source, {
            boundsOf: (item) => (item.label ? null : { minX: item.x - 1, maxX: item.x + 1, minY: -1, maxY: 1 }),
        });
        created.push(layer as unknown as CollectionLayerSource<Marker>);

        expect(layer.items.map((item) => item.id)).toEqual(["unbounded", "box"]);
        // A null-bounds item stays in the ordered view but never matches a
        // finite query; the bounded item answers normally.
        expect(layer.query(box(9, 11)).map((item) => item.id)).toEqual(["unbounded", "box"]);
        expect(layer.query(box(100, 101)).map((item) => item.id)).toEqual(["unbounded"]);
    });

    it("tolerates removal of every item and reinserting them", () => {
        const { source, layer } = fixture([marker("a", 0), marker("b", 1)]);
        source.remove("a");
        source.remove("b");
        expect(layer.items).toEqual([]);
        expect(layer.query(box(-10, 10))).toEqual([]);

        source.insert(marker("c", 2));
        expect(layer.query(box(-10, 10)).map((item) => item.id)).toEqual(["c"]);
    });

    it("reports listener errors after every listener ran, like the collection", () => {
        const { source, layer } = fixture([marker("a", 0)]);
        const second = vi.fn(() => {
            throw new Error("listener boom");
        });
        const third = vi.fn();
        layer.subscribe(second);
        layer.subscribe(third);

        expect(() => source.insert(marker("b", 1))).toThrow("listener boom");
        expect(third).toHaveBeenCalledTimes(1);
        // The index still tracks the failed notification.
        expect(layer.queryPoint(1, 0).map((item) => item.id)).toEqual(["b"]);
    });
});
