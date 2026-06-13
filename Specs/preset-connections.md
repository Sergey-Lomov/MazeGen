# Preset Connections

Allows pre-configuring edge states (walls, passages, one-way links) and start/finish markers before generation. Active only after tessellation and field are confirmed.

## Edge state model

Each interior edge of the field can have one of four preset states:

| State | Meaning |
|---|---|
| `wall` | Guaranteed wall after generation |
| `passage` | Guaranteed open passage after generation |
| `one_way_forward` | One-way passage from A to B (A = canonically lesser cell) |
| `one_way_backward` | One-way passage from B to A |

**Undecided** = absence from the map. Never stored as a value.

## Canonical edge key

Each edge is identified by a string key derived from its two endpoint cells. Cells are ordered lexicographically (first by X, then by Y if X equal) so that A < B always:

```
key = `${a[0]},${a[1]}-${b[0]},${b[1]}`   where A < B lexicographically
```

The `canonicalize(p1, p2)` function returns `[A, B]` in canonical order.

## One-way direction

`one_way_forward` means passage in direction A → B (A = canonically lesser). `one_way_backward` means B → A.

Clicking a one-way tool on an undecided or non-one-way edge sets `one_way_forward`. Clicking again on `one_way_forward` sets `one_way_backward`. Clicking again on `one_way_backward` sets `one_way_forward`. No other states are toggled this way.

## Markers

`presetStart` and `presetFinish` store a single cell coordinate each (`[number, number] | null`). These are independent of the edge connection map. Both markers count toward the preset subtitle total and status logic.

## Validity

A preset connection is **invalid** if either of its endpoint cells is outside the current field. `computeInvalidKeys` iterates the preset map and checks membership in the cell set. Invalid presets:
- are drawn in yellow
- are excluded from `generate()` before sending to WASM
- can be bulk-removed via "Clear invalid"

`computeInvalidKeysFromCells` takes pre-resolved `[number, number][]` cells and skips `resolveCells`; used by the renderer which caches cells.

## Field cell resolution

`resolveCells(cfg, customPoints?)`:
- If `customPoints` is provided and non-empty → decode from encoded integer set
- Otherwise → `configAllCells(cfg)`

Used by `computeInvalidKeys`. Renderer and Controller skip this at render time by using `rebuildCellCache` / `getCachedCells` / `getCachedCellSet`.

## State fields (mazeStore)

| Field | Type | Description |
|---|---|---|
| `presetConnectionsOpen` | `boolean` | Whether the card is open |
| `presetConnections` | `Map<string, PresetConnectionEntry>` | Edge key → entry |
| `presetConnectionsTool` | `PresetConnectionTool` | Active tool |
| `presetStart` | `[number, number] \| null` | Start marker cell |
| `presetFinish` | `[number, number] \| null` | Finish marker cell |
| `highlightInvalidPresets` | `boolean` | Whether to draw the invalid highlight overlay |

`presetConnections` and markers reset when tessellation changes with a different kind (`confirmTessellation` with `clearMaze = true`).

`highlightInvalidPresets` resets to `false` whenever `setPresetConnectionsOpen(false)` is called, preventing stale highlight state after the card closes.

## Tools

| Tool | Action |
|---|---|
| `wall` | Sets edge to `wall` |
| `passage` | Sets edge to `passage` |
| `reset` | Removes edge from map (→ undecided) |
| `one_way` | Cycles one-way direction (see above) |
| `set_start` | Sets `presetStart` to clicked cell |
| `set_finish` | Sets `presetFinish` to clicked cell |

Right-click always resets (same as `reset` tool regardless of active tool).

## Card status

| Status | Condition (priority order) |
|---|---|
| `unavailable` | Field not ready (`fieldStatus` is not `set` or `set-default`) |
| `warning` | Field ready, `computeInvalidKeys(...).size > 0` |
| `set` | Field ready, no invalids, `presetConnections.size + markerCount > 0` |
| `set-default` | Field ready, no invalids, nothing set |

`markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0)`.

Subtitle: `"N preset(s)"` or `"N preset(s) · ⚠ M invalid"` where N includes both connections and markers.

## Rendering (`PresetConnectionsRenderer`)

Active when `presetConnectionsOpen = true`. Renders on top of grid; maze graph is hidden while open.

Layers (bottom to top):
1. **gridLayer** — tessellation grid
2. **floorLayer** — filled cell polygons (dark background)
3. **undecidedLayer** — interior edges with no preset (faint stroke)
4. **presetWallsLayer** — `wall` and `one_way` edges (solid stroke); one-way arrow triangles drawn inline here; invalid presets drawn in invalid style
5. **locksLayer** — lock icons on locked nodes
6. **markersLayer** — start/finish circles (`NODE_RADIUS * 1.5`)
7. **originLayer** — origin crosshair (when `showPresetOrigin = true`)
8. **isolatedHLLayer** — cell highlight for nodes locked both-in-and-out with no passage preset
9. **invalidHLLayer** — thick highlight when `highlightInvalidPresets = true`
10. **hoverLayer** — highlighted edge under cursor (blue)

**Exterior edges** (one endpoint outside field) are drawn as solid walls. **Interior edges** (both endpoints inside field) are drawn according to their preset state.

**Cell cache** (`cachedCells`, `cachedCellSet`) is built once on open and rebuilt only when `tessellationConfig`, `fieldPoints`, or `fieldEditMode` changes. All redraw calls use the cache. `getCachedCells()` and `getCachedCellSet()` expose the cache to the controller.

**`redrawInvalidHighlight`** is called separately when `highlightInvalidPresets` changes, without redrawing all other layers.

## Edge picking (`pickEdgeAtPosition`)

Hit-test for click/hover:
1. `screenToGrid` → cell under cursor
2. Check the cell and all its neighbors as candidates
3. For each candidate pair both in field, compute distance from pointer to the actual polygon edge segment (`getSharedEdgeSegment`)
4. Accept the closest edge within `threshold = TILE_SIZE * 0.4` (or `TRI_TILE_SIZE * 0.4` for triangles)

Accepts an optional pre-built `cellSet` to avoid rebuilding on every pointer event (passed from `PresetConnectionsRenderer.getCachedCellSet()`).

## WASM wire format

`generate()` sends only valid presets:

```ts
preset_connections: Array<{ from: [number,number], to: [number,number], state: PresetConnectionState }>
```

Filtered by `computeInvalidKeys` before building the payload. Invalid entries are silently dropped.

On the Rust side: `PresetConnectionDto` with `#[derive(Deserialize)]`; `PresetConnectionState` enum; stored in `GenerationConfig.preset_connections: Vec<PresetConnection>`. Default is `vec![]`.

## Lifecycle

| Event | Effect |
|---|---|
| Tessellation confirmed (kind changes) | `presetConnections` cleared, markers cleared |
| Field cells added/removed | Connections stay; invalidity recomputed from field |
| Card opens | Renderer subscribes, cell cache built |
| Card closes | Renderer clears graphics; `highlightInvalidPresets` reset to `false` |
| Generate | Invalid connections filtered out, valid ones sent to WASM |
