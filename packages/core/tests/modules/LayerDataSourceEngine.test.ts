import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasTileEngine } from "../../src/CanvasTileEngine";
import { ItemCollection } from "../../src/modules/ItemCollection";
import type { DrawHandle, IDrawAPI, IRenderer, Rect } from "../../src/types";

type Marker = Rect & { id: string; kind?: "village" | "resource" };

const engines: CanvasTileEngine<Record<string, never>, unknown>[] = [];
// Raw/corner space: item k is centered at k + 0.5.
const at = (x: number, y = 0) => ({ x: x + 0.5, y: y + 0.5 });

function createEngine() {
    const registered: { handle: DrawHandle; items: Marker[] }[] = [];
    const add = vi.fn((items: unknown, layer = 1) => {
        const handle = { id: Symbol(), layer };
        registered.push({ handle, items: items as Marker[] });
        return handle;
    });
    const applyDrawChanges = vi.fn();
    const removeDrawHandle = vi.fn();
    const draw = {
        drawRect: add,
        drawCircle: add,
        drawImage: add,
        drawText: add,
        drawPath: add,
        drawLine: (items: unknown, _style: unknown, layer = 1) => add(items, layer),
        removeDrawHandle,
        clearLayer: vi.fn(),
        clearAll: vi.fn(),
        clearStaticCache: vi.fn(),
        applyDrawChanges,
    } as unknown as IDrawAPI<unknown>;
    const render = vi.fn();
    const renderer = {
        init: vi.fn(),
        setupEvents: vi.fn(),
        render,
        resize: vi.fn(),
        resizeWithAnimation: vi.fn(),
        destroy: vi.fn(),
        getDrawAPI: () => draw,
        getImageLoader: vi.fn(),
    } as unknown as IRenderer<Record<string, never>, unknown>;
    const engine = new CanvasTileEngine({}, { scale: 10, size: { width: 200, height: 200 } }, renderer);
    engines.push(engine);
    return { engine, add, registered, render, applyDrawChanges, removeDrawHandle };
}

function markers(items: Array<[string, number, number?]>) {
    return new ItemCollection<Marker>(
        items.map(([id, x, y = 0]) => ({ id, x, y, size: 1 })),
        { keyOf: (item) => item.id },
    );
}

function frames() {
    const callbacks = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((callback: FrameRequestCallback) => {
            const id = ++next;
            callbacks.set(id, callback);
            return id;
        }),
    );
    vi.stubGlobal(
        "cancelAnimationFrame",
        vi.fn((id: number) => callbacks.delete(id)),
    );
    return {
        callbacks,
        flush() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((callback) => callback(0));
        },
    };
}

afterEach(() => {
    engines.splice(0).forEach((engine) => engine.destroy());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("collection-driven layer data source", () => {
    it("exposes one source whose ordered items array is the renderer's own array", () => {
        frames();
        const { engine, registered } = createEngine();
        const source = markers([
            ["v", 0],
            ["r", 5],
        ]);
        const handle = engine.drawRect(source, 2);

        const layer = engine.getLayerSource(handle)!;
        expect(layer).toBeDefined();
        expect(layer.items).toBe(registered[0].items);
        expect(layer.size).toBe(2);
        expect(layer.collection).toBe(source);
        // Returns undefined for non-collection registrations.
        expect(engine.getLayerSource(engine.drawRect([{ x: 0, y: 0 }]))).toBeUndefined();
    });

    it("finds a newly inserted marker through layer and hit queries in collection order", () => {
        frames();
        const { engine } = createEngine();
        const source = markers([["a", 0]]);
        const handle = engine.drawRect(source, 2);
        const layer = engine.getLayerSource(handle)!;

        source.insert({ id: "b", x: 10, y: 0, size: 1 });
        source.insert({ id: "c", x: 20, y: 0, size: 1 });

        expect(layer.query({ minX: -1, maxX: 21, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["a", "b", "c"]);
        expect(engine.hitTest(at(10)).map((hit) => hit.key)).toEqual(["b"]);
        expect(engine.hitTest(at(20)).map((hit) => hit.key)).toEqual(["c"]);
        // Ordering matches the collection, even with reverse placement.
        source.update("a", { x: 15 });
        expect(layer.query({ minX: -1, maxX: 21, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["a", "b", "c"]);
    });

    it("moves an item's geometry: the old spot stops hitting, the new spot starts", () => {
        frames();
        const { engine } = createEngine();
        const source = markers([["v", 0]]);
        const handle = engine.drawRect(source, 1);
        const layer = engine.getLayerSource(handle)!;
        expect(engine.hitTest(at(0)).map((hit) => hit.key)).toEqual(["v"]);

        source.update("v", { x: 40, width: 4, height: 2 });

        expect(engine.hitTest(at(0))).toEqual([]);
        expect(engine.hitTest(at(40)).map((hit) => hit.key)).toEqual(["v"]);
        expect(engine.hitTest(at(41)).map((hit) => hit.key)).toEqual(["v"]);
        expect(layer.query({ minX: 38, maxX: 42, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["v"]);
        expect(layer.query({ minX: -1, maxX: 1, minY: -1, maxY: 1 })).toEqual([]);
    });

    it("removes an item so neither the layer query nor hit testing can reach it", () => {
        frames();
        const { engine } = createEngine();
        const source = markers([
            ["a", 0],
            ["b", 10],
            ["c", 20],
        ]);
        const handle = engine.drawRect(source, 1);
        const layer = engine.getLayerSource(handle)!;

        source.remove("b");

        expect(layer.query({ minX: -1, maxX: 21, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["a", "c"]);
        expect(engine.hitTest(at(10))).toEqual([]);
        expect(engine.hitTestRect({ minX: 9, maxX: 11, minY: -1, maxY: 1 })).toEqual([]);
        // Remaining keys stay correct after the dense array compacts.
        expect(engine.hitTest(at(20)).map((hit) => hit.key)).toEqual(["c"]);
        expect(engine.hitTest(at(0)).map((hit) => hit.index)).toEqual([0]);
    });

    it("collapses a batch's mutations into one index sync and one delta notification", () => {
        frames();
        const { engine, applyDrawChanges } = createEngine();
        const source = markers([
            ["a", 0],
            ["b", 10],
            ["c", 20],
        ]);
        const handle = engine.drawRect(source, 1);
        const layer = engine.getLayerSource(handle)!;
        const before = layer.syncCount;

        source.batch(() => {
            source.insert({ id: "d", x: 30, y: 0, size: 1 });
            source.update("a", { x: 40 });
            source.remove("b");
            source.update("c", { x: 5 });
        });

        expect(layer.syncCount - before).toBe(1);
        expect(applyDrawChanges).toHaveBeenCalledTimes(1);
        expect(layer.items.map((item) => item.id)).toEqual(["a", "c", "d"]);
        expect(layer.query({ minX: -1, maxX: 100, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["a", "c", "d"]);
        expect(engine.hitTest(at(10))).toEqual([]);
        expect(engine.hitTest(at(5)).map((hit) => hit.key)).toEqual(["c"]);
        expect(engine.hitTest(at(40)).map((hit) => hit.key)).toEqual(["a"]);
        expect(engine.hitTest(at(30)).map((hit) => hit.key)).toEqual(["d"]);
    });

    it("detaches the old collection when the layer's collection is replaced", () => {
        frames();
        const { engine } = createEngine();
        const oldSource = markers([["old", 0]]);
        const handle = engine.drawRect(oldSource, 1);
        const layer = engine.getLayerSource(handle)!;

        const newSource = markers([
            ["new", 5],
            ["other", 6],
        ]);
        engine.setLayerCollection(handle, newSource);

        expect(layer.collection).toBe(newSource);
        expect(layer.items.map((item) => item.id)).toEqual(["new", "other"]);
        expect(engine.hitTest(at(0))).toEqual([]);
        expect(engine.hitTest(at(5)).map((hit) => hit.key)).toEqual(["new"]);

        const before = layer.syncCount;
        // The detached collection no longer drives the index.
        oldSource.insert({ id: "ghost", x: 5, y: 0, size: 1 });
        oldSource.update("old", { x: 50 });
        expect(layer.syncCount).toBe(before);
        expect(engine.hitTest(at(5)).map((hit) => hit.key)).toEqual(["new"]);
        expect(engine.hitTest(at(50))).toEqual([]);

        // The replacement collection does.
        newSource.insert({ id: "later", x: 9, y: 0, size: 1 });
        expect(engine.hitTest(at(9)).map((hit) => hit.key)).toEqual(["later"]);
    });

    it.each(["handle", "layer", "all", "destroy"] as const)(
        "detaches on %s so later collection changes cannot touch the source or index",
        (cleanup) => {
            const clock = frames();
            const { engine, applyDrawChanges } = createEngine();
            const source = markers([["a", 0]]);
            const handle = engine.drawRect(source, 2);

            if (cleanup === "handle") {
                engine.removeDrawHandle(handle);
            } else if (cleanup === "layer") {
                engine.clearLayer(2);
            } else if (cleanup === "all") {
                engine.clearAll();
            } else {
                engine.destroy();
            }

            source.insert({ id: "b", x: 5, y: 0, size: 1 });
            source.update("a", { x: 10 });
            source.remove("a");

            expect(applyDrawChanges).not.toHaveBeenCalled();
            expect(clock.callbacks.size).toBe(0);
            expect(engine.getLayerSource(handle)).toBeUndefined();
            expect(engine.hitTest(at(5))).toEqual([]);
            expect(engine.hitTest(at(10))).toEqual([]);
        },
    );

    it("rejects a duplicate key while leaving the collection, index, and order unchanged", () => {
        frames();
        const { engine } = createEngine();
        const source = markers([
            ["a", 0],
            ["b", 10],
        ]);
        const handle = engine.drawRect(source, 1);
        const layer = engine.getLayerSource(handle)!;
        const before = layer.syncCount;

        expect(() => source.insert({ id: "a", x: 999, y: 0, size: 1 })).toThrow("duplicate key");

        expect(layer.syncCount).toBe(before);
        expect(layer.items.map((item) => item.id)).toEqual(["a", "b"]);
        expect(layer.query({ minX: -1, maxX: 1000, minY: -1, maxY: 1 }).map((item) => item.id)).toEqual(["a", "b"]);
        expect(engine.hitTest(at(999))).toEqual([]);
        expect(engine.hitTest(at(0)).map((hit) => hit.key)).toEqual(["a"]);
    });

    it("keeps the shared array identity stable across insert/update/remove", () => {
        frames();
        const { engine, registered } = createEngine();
        const source = markers([["a", 0]]);
        const handle = engine.drawRect(source, 1);
        const view = registered[0].items;

        source.insert({ id: "b", x: 5, y: 0, size: 1 });
        source.update("a", { y: 2 });
        source.remove("b");

        expect(registered[0].items).toBe(view);
        expect(engine.getLayerSource(handle)!.items).toBe(view);
        expect(view.map((item) => item.id)).toEqual(["a"]);
    });

    it("throws for setLayerCollection on a handle that is not a live collection", () => {
        frames();
        const { engine } = createEngine();
        const handle = engine.drawRect([{ x: 0, y: 0 }]);
        expect(() => engine.setLayerCollection(handle, markers([["a", 0]]))).toThrow("not a live collection");
    });

    it("routes a large collection's hits through the source's own index, without a second build", () => {
        frames();
        const { engine } = createEngine();
        const source = markers(Array.from({ length: 700 }, (_, i) => [String(i), i * 2] as [string, number]));
        const handle = engine.drawRect(source, 1);
        const layer = engine.getLayerSource(handle)!;
        expect(engine.hitTestFirst(at(400))?.key).toBe("200");

        source.update("200", { x: 1500 });
        expect(engine.hitTest(at(400))).toEqual([]);
        expect(engine.hitTestFirst(at(1500))?.key).toBe("200");
        expect(engine.hitTestRect({ minX: 1499, maxX: 1501, minY: -1, maxY: 1 })[0]?.key).toBe("200");
        expect(layer.syncCount).toBe(2);
    });
});
