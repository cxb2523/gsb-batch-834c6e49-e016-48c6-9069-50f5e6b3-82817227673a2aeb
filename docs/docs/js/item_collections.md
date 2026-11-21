---
sidebar_position: 2.1
---

# Live Item Collections

Use `ItemCollection` when individual items move, change shape, arrive, or disappear frequently. Register the collection once, then update items by an application-defined key. The draw handle, layer position, and collection identity stay stable. Geometry caches and hit testing update synchronously when the mutation finishes, and the engine requests a repaint automatically.

Collections work with dynamic `drawRect`, `drawCircle`, `drawImage`, `drawText`, `drawLine`, and `drawPath` on Canvas2D, WebGL, Skia, and the server renderer. The corresponding React and React Native components accept the same source.

## Register Once, Update by Key

```ts
import { ItemCollection, type Rect } from "@canvas-tile-engine/core";

type Seat = Rect & { id: string };

const seats = new ItemCollection<Seat>(
    [
        { id: "A1", x: 0, y: 0, style: { fillStyle: "#22c55e" } },
        { id: "A2", x: 1, y: 0, style: { fillStyle: "#22c55e" } },
    ],
    { keyOf: (seat) => seat.id },
);

const handle = engine.drawRect(seats, 1, { id: "seats" });
engine.render(); // Initial registration still needs a first frame.

// No new draw call or manual render is needed for these changes.
seats.update("A1", { x: 4, width: 2 });
seats.insert({ id: "A3", x: 2, y: 0 });
seats.remove("A2");

// Group synchronous changes into one notification and one requested frame.
seats.batch(() => {
    seats.update("A1", (seat) => ({
        ...seat,
        style: { ...seat.style, fillStyle: "#f59e0b" },
    }));
    seats.update("A3", { x: 5 });
});

engine.removeDrawHandle(handle); // Detaches this registration's subscription.
```

An item key identifies an object inside the collection. `DrawOptions.id` identifies the entire draw registration. They have separate purposes and do not share a namespace.

## Collection API

| Member | Behavior |
| :-- | :-- |
| `new ItemCollection<T>(items, { keyOf })` | Copies the initial array and checks that every key is a unique string or number. |
| `get(key)` | Returns the current item, or `undefined`. |
| `items` | Read-only ordered view. Its array identity stays stable across mutations. |
| `size` | Current number of items. |
| `keyAt(index)` | Key at the current array position, or `undefined`. |
| `insert(item)` | Appends an item. Duplicate keys throw before insertion. |
| `update(key, patchOrUpdater)` | Replaces the item with a shallow copy, preserving its key and position; returns the replacement. Missing keys and key changes throw. |
| `remove(key)` | Removes and compacts the array; returns `false` if the key is absent. |
| `batch(callback)` | Groups synchronous mutations, including nested batches. Returns the callback result. |
| `subscribe(listener)` | Receives a read-only array of insert/update/remove deltas after changes; returns an unsubscribe function. It does not emit an initial snapshot. |

Update patches are shallow. Replace nested values such as `style`, `data`, path `commands`, or `points` immutably. Do not mutate objects returned by `get()` or `items`, and do not push into the exposed array. To change a key, remove the old item and insert a new one; the new item is appended.

`batch` groups synchronous work; it is not an async transaction and provides no rollback. If its callback throws, successful changes are still delivered before the error propagates. Subscriber errors do not prevent other subscribers from receiving the changes; the first error is rethrown after notification delivery. Reentrant mutations queue their notifications until the current listeners finish. Collection state changes immediately; all engine registrations are synchronized when the outermost mutation finishes. A subscriber added during a batch receives only changes made after it subscribed.

## Hit Testing and Paint Order

Collection hits include an optional `key` alongside the existing `item`, `kind`, `layer`, `handle`, and `index` fields:

```ts
engine.onClick = (coords) => {
    const hit = engine.hitTestFirst(coords.raw);
    if (hit?.key !== undefined) {
        console.log("Selected key", hit.key);
    }
};
```

`key` is stable across updates. `index` is the current dense array position and can change after a removal. Updates preserve item order; insertions draw last within the registration. Existing `clip`, `visibleOf`, `interactiveOf`, and `hitTest: false` rules still apply. Text remains excluded from hit testing.

An update refreshes hit geometry before the scheduled repaint, including for collections larger than 500 items. A point query or rectangle query immediately after `update()` therefore sees the new geometry. During a subscriber callback, other subscribers may not have received the current notification yet; query the engine after the mutation returns when current geometry is required.

## The Layer Data Source

Each live registration is backed by a `CollectionLayerSource`: one ordered item view plus one RBush spatial index, kept in sync with the collection. Rendering culls from that same view and hit testing queries that same index, so what is drawn, what a viewport query returns, and what `hitTest`/`hitTestRect` answer are always the same ordered data.

```ts
const markers = new ItemCollection<Marker>([{ id: "village", x: 0, y: 0 }], { keyOf: (m) => m.id });
const handle = engine.drawRect(markers, 1);

const layer = engine.getLayerSource(handle)!;
layer.query({ minX: 0, maxX: 10, minY: 0, maxY: 10 }); // markers in collection order
layer.queryPoint(3, 4); // markers whose box contains the point

// Swap the observed collection without re-registering; the old one detaches.
engine.setLayerCollection(handle, reloadedMarkers);
```

| Member | Behavior |
| :-- | :-- |
| `getLayerSource(handle)` | The source backing a live registration, or `undefined` for ordinary item/array/static drawings and after removal. |
| `setLayerCollection(handle, collection)` | Replaces the observed collection. The previous subscription is detached first. Throws for a handle that is not a live collection registration. |
| `source.items` | The same live array the renderer culls from; its identity stays stable. |
| `source.query(region, padding?)` | Items whose indexed box overlaps the region, in collection order. `padding` is world units. |
| `source.queryPoint(x, y, padding?)` | Items whose indexed box contains the point, in collection order. |
| `source.syncCount` | Index sync passes so far: the initial build plus one per delivered notification (a batch counts once). |

Every `insert`, `update`, and `remove` reaches the index synchronously; a `batch` is a single notification and therefore a single sync pass, so a burst of mutations never rebuilds per change. Removed items leave the index immediately and cannot be found or hit. A duplicate-key insert throws before the collection records anything, leaving the collection, the index, and the order unchanged. Creating the source indexes items with `itemsBounds` (cell boxes for anchored kinds, endpoint/vertex boxes for lines and paths); pixel-sized extents and measured text are not part of that box.

## React and React Native

Keep the collection instance stable. Its updates repaint the canvas without a React render or draw re-registration:

```tsx
import { useState } from "react";
import { CanvasTileEngine, ItemCollection, type Rect } from "@canvas-tile-engine/react";

type Marker = Rect & { id: string };

function Markers() {
    const [markers] = useState(() => new ItemCollection<Marker>(
        [{ id: "cursor", x: 0, y: 0 }],
        { keyOf: (item) => item.id },
    ));

    // Run markers.update("cursor", { x, y }) from your event or data handler.
    return <CanvasTileEngine.Rect items={markers} layer={1} />;
}
```

Render this component inside an existing `<CanvasTileEngine>` provider. For native apps, import from `@canvas-tile-engine/react-native`; the same pattern applies. The bindings re-export the class and its public types. Unmounting a draw component detaches its subscription. A collection can be shared by multiple registrations or engines; removing one registration does not affect the others. React UI outside the canvas still needs its own state/subscription if it should reflect collection changes.

## Rendering, Lifecycle, and Limits

`engine.requestRender()` coalesces requests into one animation frame, or one microtask when `requestAnimationFrame` is unavailable. Collection updates call it automatically, and React child repaints use the same scheduler. `engine.render()` still paints synchronously and consumes a pending request. Destroying the engine cancels its pending frame and detaches its collection subscriptions. Replacing a registration id, removing a handle, clearing a layer, and clearing all drawings also detach the affected subscriptions, disposing the registration's layer data source so later mutations of that collection cannot reach its index. The collection remains reusable.

For large indexed collections, item changes update affected spatial entries instead of replacing the draw registration and rebuilding the entire index. Initial registration builds the layer source once; first index construction, zoom or font-metric invalidation can still rebuild renderer caches. Removing an item shifts the dense array and takes linear work. This is not a guarantee of constant-time mutation or incremental GPU-buffer uploads.

Single objects and ordinary arrays keep their existing API. Static draw helpers and Sprite accept their existing inputs; they do not observe collections. Use `styleOf` for selection or hover decorations that do not change geometry. If the underlying pixels of an existing WebGL image source change, the existing `invalidateTexture` rule still applies.

Custom renderers may keep their existing `IDrawAPI` implementation for single items and arrays. To accept collections, implement the optional `applyDrawChanges(handle, changes)` method: the engine updates the registration's stable item array first, then passes the ordered deltas so the renderer can refresh its caches. Release per-handle updater state when that handle is removed or its layer is cleared. A collection registration throws early if the renderer does not support this protocol.
