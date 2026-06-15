# Preset Connections

Allows pre-configuring edge states (walls, passages, one-way links), node locks, and start/finish/gen-source markers before generation. Active only after tessellation and field are confirmed.

## Edge state model

Each `PresetConnectionEntry` carries a `state: PresetConnectionClientState` which extends the WASM wire type:

| State | Client-only | Meaning |
|---|---|---|
| `wall` | no | Guaranteed wall after generation |
| `passage` | no | Guaranteed open passage after generation |
| `one_way_forward` | no | One-way passage from A to B (A = canonically lesser cell) |
| `one_way_backward` | no | One-way passage from B to A |
| `undefined` | **yes** | Explicitly overrides default; rendered as undecided; never sent to WASM |

`"undefined"` state is a client-only concept stored in `PresetConnectionClientState`. The Rust/WASM side never sees it — entries with `state: "undefined"` are filtered out before building the generation config.

**Absence from the map** (`source:"default"` removed, no entry at all) is only possible when `defaultEdgeState` is `"undefined"` and no user action has been taken on this edge.

## Entry source

Each `PresetConnectionEntry` carries a `source: "user" | "default"` field:

- `"user"` — set explicitly by the user via a tool (including the `reset` / `undefined` tool)
- `"default"` — injected automatically by the active `defaultEdgeState`

When the user applies the `reset` tool or RMB to any edge (regardless of `defaultEdgeState`), the edge is always set to `{ state: "undefined", source: "user" }`. This pins it as explicitly undecided, overriding the current default.

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

`presetStart`, `presetFinish`, and `presetGenSource` each store a single cell coordinate (`[number, number] | null`). These are independent of the edge connection map. All three markers count toward the preset subtitle total and status logic.

`presetGenSource` takes priority over `presetStart` when building the WASM generation config (`preset_start` field).

## Default edge state

`defaultEdgeState: "undefined" | "wall" | "passage"` controls the implicit state of all edges not explicitly set by the user.

- `"undefined"` (default): no implicit state; unset edges are undecided.
- `"wall"` / `"passage"`: all interior edges without a user entry are populated with `source: "default"` entries of the chosen state.

When `defaultEdgeState` changes, `_applyDefaultEdgeState` is called:
1. All existing `source: "default"` entries are removed.
2. If new state is not `"undefined"`, default entries are added for all interior edges that have no `source: "user"` entry (including edges with `state: "undefined", source: "user"` — those are intentionally excluded from the default).

Applying the `reset` tool or RMB always sets `{ state: "undefined", source: "user" }` regardless of `defaultEdgeState`. This explicitly pins the edge as undecided and prevents the default from applying to it.

Changing `defaultEdgeState` also triggers `_recomputeAutoLock` if auto-lock is enabled.

## Drag mode

Tools `wall`, `passage`, and `reset` support drag with LMB held. While dragging:
- `dragActive` flag is set on `pointerdown`
- `dragVisited: Set<string>` deduplicates edges within one drag session
- Each newly-entered edge has the current tool applied immediately via `applyPresetConnectionsTool`
- `dragActive` and `dragVisited` clear on `pointerup` (LMB only)

One-way and lock/gen-source tools do not support drag.

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
| `defaultEdgeState` | `"undefined" \| "wall" \| "passage"` | Implicit state for unset edges |
| `presetStart` | `[number, number] \| null` | Start marker cell |
| `presetFinish` | `[number, number] \| null` | Finish marker cell |
| `presetGenSource` | `[number, number] \| null` | Generator start cell (overrides `presetStart` in WASM config) |
| `lockedNodes` | `Map<string, NodeLockKind>` | Manually locked nodes |
| `autoLock` | `boolean` | Whether auto-lock is enabled |
| `autoLockedNodes` | `Set<string>` | Nodes auto-locked because all their interior edges are preset |
| `highlightInvalidPresets` | `boolean` | Whether to draw the invalid highlight overlay |
| `highlightIsolatedNodes` | `boolean` | Whether to highlight nodes locked both-in-and-out with no passage |
| `showPresetOrigin` | `boolean` | Whether to show the coordinate origin crosshair |

`presetConnections`, markers, locks, and `defaultEdgeState` reset when tessellation changes with a different kind (`confirmTessellation` with `clearMaze = true`) or when `resetPresetConnections()` is called.

`highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` whenever `setPresetConnectionsOpen(false)` is called.

## Tools

| Tool | Section | Action |
|---|---|---|
| `wall` | Edges | Sets edge to `wall` |
| `passage` | Edges | Sets edge to `passage` |
| `reset` | Edges | Sets edge to `{ state: "undefined", source: "user" }` — explicitly undecided, overrides default |
| `one_way` | Edges | Cycles one-way direction |
| `set_start` | Vertex | Sets `presetStart` to clicked cell |
| `set_finish` | Vertex | Sets `presetFinish` to clicked cell |
| `lock_in` | Generation | Locks node to block incoming edges |
| `lock_out` | Generation | Locks node to block outgoing edges |
| `full_lock` | Generation | Locks node both in and out (`"both"`) |
| `gen_source` | Generation | Toggles `presetGenSource` on clicked cell (click same cell to clear) |

Right-click always sets the edge to `{ state: "undefined", source: "user" }` regardless of active tool or `defaultEdgeState`.

## Node locking

`lockedNodes: Map<"x,y", NodeLockKind>` stores explicitly locked nodes. `NodeLockKind` is `"in" | "out" | "both"`.

`autoLockedNodes: Set<"x,y">` is recomputed whenever `presetConnections` changes (if `autoLock` is enabled). A node is auto-locked when all its interior edges have a preset entry with `state !== "undefined"`. Edges with `state: "undefined"` are treated as undecided and prevent auto-lock. Auto-locked nodes always use `"both"` kind.

Both sets are merged when rendering (`buildLocks`) and when checking for isolated nodes (`buildIsolatedCellHighlights`).

**Isolated node**: a node locked `"both"` (manually or via auto-lock) with no non-wall preset on any of its edges. The UI shows a warning and highlights such cells.

## Card status

| Status | Condition (priority order) |
|---|---|
| `unavailable` | Field not ready |
| `warning` | Field ready, `computeInvalidKeys(...).size > 0` |
| `set` | Field ready, no invalids, `presetConnections.size + markerCount > 0` |
| `set-default` | Field ready, no invalids, nothing set |

`markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0) + (presetGenSource ? 1 : 0)`.

Subtitle: `"N preset(s)"` or `"N preset(s) · ⚠ M invalid"` where N includes both connections and markers.

## Rendering (`PresetConnectionsRenderer`)

Active when `presetConnectionsOpen = true`. Renders on top of grid; maze graph is hidden while open.

Layers (bottom to top):
1. **gridLayer** — tessellation grid
2. **floorLayer** — filled cell polygons (dark background)
3. **undecidedLayer** — interior edges with no preset (faint stroke)
4. **presetWallsLayer** — `wall` and `one_way` edges (solid stroke); one-way arrow triangles drawn inline; invalid presets drawn in invalid style
5. **locksLayer** — lock icons for both `lockedNodes` and `autoLockedNodes` (merged)
6. **markersLayer** — start/finish circles (`NODE_RADIUS * 1.5`)
7. **originLayer** — origin crosshair (when `showPresetOrigin = true`)
8. **genSourceLayer** — blue cross marker at `presetGenSource` cell
9. **isolatedHLLayer** — cell highlight for nodes locked both-in-and-out with no passage preset
10. **invalidHLLayer** — thick highlight when `highlightInvalidPresets = true`
11. **hoverLayer** — highlighted edge under cursor

**Exterior edges** (one endpoint outside field) are drawn as solid walls. **Interior edges** (both endpoints inside field) are drawn according to their preset state.

**Cell cache** (`cachedCells`, `cachedCellSet`) is built once on open and rebuilt only when `tessellationConfig`, `fieldPoints`, or `fieldEditMode` changes. All redraw calls use the cache. `getCachedCells()` and `getCachedCellSet()` expose the cache to the controller.

**`redrawInvalidHL`** is called separately when `highlightInvalidPresets` changes, without redrawing all other layers. Same for `redrawOrigin` and `redrawGenSource` on viewport scale changes.

## Gen source marker

`GenSourceRenderer` draws a blue cross (`0x3399ff`) at the `presetGenSource` cell. Same geometry as `OriginRenderer` (arm = `TILE_SIZE * 0.35 / vpScale`, line width = `max(3/vpScale, 2)`), with rounded line caps.

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
preset_start?: [number, number]   // presetGenSource takes priority over presetStart
preset_finish?: [number, number]
locked_nodes: Array<{ point: [number,number], kind: NodeLockKind }>
```

Filtered by `computeInvalidKeys` before building the payload. Invalid entries are silently dropped. `lockedNodes` and `autoLockedNodes` are merged before sending.

On the Rust side: `PresetConnectionDto` with `#[derive(Deserialize)]`; `PresetConnectionState` enum; stored in `GenerationConfig.preset_connections: Vec<PresetConnection>`. Default is `vec![]`.

## Lifecycle

| Event | Effect |
|---|---|
| Tessellation confirmed (kind changes) | `presetConnections` cleared, markers cleared, `defaultEdgeState` reset |
| `resetPresetConnections()` | Same as above |
| Field cells added/removed | Connections stay; invalidity recomputed from field |
| Card opens | Renderer subscribes, cell cache built |
| Card closes | Renderer clears graphics; `highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` |
| Generate | Invalid connections filtered out, valid ones sent to WASM |
| `defaultEdgeState` changes | All `source:"default"` entries removed and repopulated; auto-lock recomputed |
