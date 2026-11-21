---
"@canvas-tile-engine/core": minor
"@canvas-tile-engine/react": minor
"@canvas-tile-engine/react-native": minor
---

Add `CollectionLayerSource`, a collection-driven layer data source that keeps one
ordered item view and one RBush spatial index per live registration. Registering
an `ItemCollection` now syncs the layer index synchronously on insert, update,
remove, and batch notifications, so viewport culling, hit testing, and paint
order always read the same data in collection order. A batch produces a single
index sync pass; duplicate-key inserts the collection rejects never touch the
index. Replacing the collection or tearing down the registration detaches the
previous subscription.

Expose the source per registration through `engine.getLayerSource(handle)` and
swap collections without re-registering through
`engine.setLayerCollection(handle, collection)`. `CollectionLayerSource`,
`ReadonlyCollectionLayerSource`, and `LayerDataSourceOptions` are exported by
core, React, and React Native.
