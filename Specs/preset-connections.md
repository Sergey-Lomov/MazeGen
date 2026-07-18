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

Teleports are a separate concept — see "Preset teleports" below — not part of the edge state model above (they connect two cells that aren't necessarily geometrically adjacent).

`"undefined"` state is a client-only concept stored in `PresetConnectionClientState`. The Rust/WASM side never sees it — entries with `state: "undefined"` are filtered out before building the generation config.

**Absence from the map** (`source:"default"` removed, no entry at all) is only possible when `defaultEdgeState` is `"undefined"` and no user action has been taken on this edge.

## Entry source

Each `PresetConnectionEntry` carries a `source: "user" | "default"` field:

- `"user"` — set explicitly by the user via a tool
- `"default"` — injected automatically by the active `defaultEdgeState`, including by the `reset` tool/RMB (see below)

Applying the `reset` tool or RMB clears the edge's explicit user override so it goes back to tracking the current default, instead of pinning it to `"undefined"`:
- If `defaultEdgeState` is `"undefined"`, the entry is removed from the map entirely.
- Otherwise, the entry is set to `{ state: defaultEdgeState, source: "default" }` — same as if no user override had ever been set. Because `source` is now `"default"`, a later `defaultEdgeState` change will recompute this entry along with every other default entry (see "Default edge state" below), so the edge keeps following the default going forward.

There is no way to explicitly pin an edge to `"undefined"` when `defaultEdgeState` is not `"undefined"` — `reset` always means "go back to default," not "force undecided."

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

`presetGenSource` sets where the generation algorithm starts (`preset_gen_source` field). `presetStart` sets the maze start endpoint shown after generation (`preset_start` field). The two are independent: if both are set, generation seeds from `presetGenSource` and the start marker is placed at `presetStart`. If neither is set, generation seeds from the center-nearest node and the start endpoint is assigned by the repair strategy.

## Preset teleports

Independent from the edge/marker model above. Stored as `presetTeleports: PresetTeleportEntry[]` in the store, not in the `presetConnections` map — a teleport's two endpoints aren't required to be geometrically adjacent.

```ts
interface PresetTeleportEntry {
  id: number;                 // stable identity, assigned on creation from _nextPresetTeleportId
  from: [number, number];
  to: [number, number];
  direction: "forward" | "backward" | "two_way";
}
```

`from`/`to` are the two click points in placement order. For `"backward"`, the actual passage direction runs `to → from` (mirrors `PresetConnectionState::Teleport(TeleportDirection::Backward)` on the Rust side) — `from`/`to` themselves are never swapped after creation; only interpretation of direction changes.

### Tools

| Tool | Action |
|---|---|
| `teleport_one_way` | Two-click placement of a one-way teleport (`forward`) |
| `teleport_two_way` | Two-click placement of a two-way teleport |

Both are in the Vertex tools section, alongside `set_start`/`set_finish`. Selecting either teleport tool clears any in-progress placement (`presetTeleportPendingFrom` reset to `null`) — see `setPresetConnectionsTool`.

### Shared vertex editing mode

All four vertex tools (`set_start`, `set_finish`, `teleport_one_way`, `teleport_two_way`) share one editing mode: whichever vertex tool is active, drag-to-move and right-click-to-delete apply uniformly to the start marker, the finish marker, and every teleport endpoint — not just the element type matching the active tool.

- **Left press-drag starting on the start marker's cell**, while any vertex tool is active → moves the start marker live.
- **Left press-drag starting on the finish marker's cell**, while any vertex tool is active → moves the finish marker live.
- **Left press-drag starting on an existing teleport endpoint**, while any vertex tool is active → moves that endpoint live (see "Editing existing teleports" below).
- **Right-click on the start marker's cell**, while any vertex tool is active → clears the start marker (`setPresetStart(null)`).
- **Right-click on the finish marker's cell**, while any vertex tool is active → clears the finish marker (`setPresetFinish(null)`).
- **Right-click on an existing teleport endpoint**, while any vertex tool is active → removes that teleport entry (`removePresetTeleport`).

Hit-testing checks the start marker, then the finish marker, then teleport endpoints, regardless of which vertex tool is active — so drag/delete on overlapping elements at the same cell resolves in that priority order.

Only when nothing is hit does the tool-specific "create new" action apply — left click assigns the marker for `set_start`/`set_finish`, or drives the two-click placement gesture for the two teleport tools (still tool-specific: the placement gesture and preview line only run while a teleport tool is active). A plain click (no drag) on an existing teleport endpoint's own cell, with no placement pending, still cycles that entry's direction only when a teleport tool is active (see below).

### Placement gesture

1. First LMB click on a cell (with no existing endpoint under the cursor) sets `presetTeleportPendingFrom` to that cell. The renderer shows a semi-transparent marker there plus a line following the cursor (`updateTeleportPreview`).
2. Second LMB click on a different cell completes the link: `addPresetTeleport(pendingFrom, cell, direction)` is called (`direction` is `"two_way"` for the two-way tool, `"forward"` for the one-way tool), a new entry is appended with a freshly incremented id, and `presetTeleportPendingFrom` resets to `null`.
3. Clicking the same cell as the pending origin is a no-op (does not complete or cancel).
4. **Cancelling a pending placement**: ESC key, or RMB with no existing endpoint under the cursor, clears `presetTeleportPendingFrom` and the preview line — no entry is created.

### Editing existing teleports

Hit-testing an existing endpoint (`pickTeleportEndpointAt`, radius `TILE_SIZE * 0.3`, closest endpoint across all teleports wins) while a teleport tool is active:

- **RMB on an existing endpoint** — removes that entire teleport entry (`removePresetTeleport`).
- **LMB press-drag on an existing endpoint** — moves that one endpoint (`from` or `to`) to the cell under the cursor (`movePresetTeleportEndpoint`), live-updating on every cell change during the drag. Dragging an endpoint onto its own link's other endpoint is a no-op (prevents collapsing a teleport to a single cell).
- **LMB click (no drag) on an existing endpoint**, when no placement is pending — cycles that entry's direction: `forward ↔ backward`; `two_way` is unaffected (`cyclePresetTeleportDirection`). This is how a one-way teleport's direction is flipped after creation; there's no other UI path to reach `"backward"`.
- **LMB click (no drag) on an existing endpoint's cell**, while a placement *is* pending — completes the pending placement at that cell (starts a new link) rather than cycling the existing entry's direction.

A press that doesn't move to a different cell is resolved as a click on `pointerup`, not a drag, via the controller's `draggingTeleportEndpoint`/`teleportDragMoved` flags.

### Validity

`presetStart`/`presetFinish` are **invalid** if their cell is outside the current field (`computeInvalidMarkers`, same field-resolution logic as `computeInvalidKeys`). Invalid markers:
- count toward the combined invalid total shown in the UI (`invalidKeys.size + invalidTeleportIds.size + invalidMarkerCount`)
- are excluded from `generate()` (`preset_start`/`preset_finish` omitted from the payload)
- are cleared (set to `null`) by "Clear invalid" alongside invalid edge presets and teleports
- get a dedicated highlight (circle outline matching the marker's own shape, `canvas.preset.invalid`) when `highlightInvalidPresets` is on, drawn on the same layer as invalid teleport endpoints

A teleport is **invalid** if either endpoint is outside the current field (`computeInvalidTeleportIds`, same field-resolution logic as `computeInvalidKeys`). Invalid teleports:
- count toward the combined invalid total shown in the UI (`invalidKeys.size + invalidTeleportIds.size`)
- are excluded from `generate()`
- are removed by "Clear invalid" alongside invalid edge presets
- get a dedicated highlight (rounded-square outline at each endpoint, `canvas.preset.invalid`) when `highlightInvalidPresets` is on, drawn separately from the edge highlight layer

### Rendering (`TeleportRenderer`)

Each teleport draws as a connecting line plus one marker square per endpoint:
- **Two-way**: both endpoints filled solid.
- **One-way**: origin (`from`, or `to` if `direction: "backward"`) filled solid; destination outlined only.
- **Half-filled marker**: when a cell is the landing point for markers from *different* teleport entries that disagree — i.e. at least one entry wants a filled square there and at least one wants an outline square there — that cell draws as a diagonally-split square instead of a plain filled/outline one. Computed by the pure `computeMixedCells(edges): Set<string>` (coordKey-encoded), unit-tested in `TeleportRenderer.test.ts` independently of the Pixi drawing code.

The connecting line stops at each endpoint marker's border rather than running to its center: the clip distance along the line's direction is the square's Chebyshev border distance (`half / max(|ux|, |uy|)`) plus half the line's stroke width, compensating for the round line cap extending past its geometric endpoint. Computed by the pure `clipDistance(ux, uy, half, strokeWidth)`, unit-tested in `TeleportRenderer.test.ts`.

Preview line/marker for an in-progress placement is drawn separately by `PresetConnectionsRenderer.updateTeleportPreview`, at 50% alpha; it clips to the origin marker's border the same way.

### WASM wire format

Sent as additional entries appended to `preset_connections` (not a separate field): `presetTeleportEntryToState` maps `direction` to `PresetConnectionStateDto::TeleportForward | TeleportBackward | TeleportTwoWay`. On the Rust side these become `PresetConnectionState::Teleport(TeleportDirection::{Forward,Backward,TwoWay})`, which `build_preset_state` turns into one (`Forward`/`Backward`) or two (`TwoWay`) directed `EdgeKind::Teleport` graph edges. Teleport endpoints are **not** added to `preset_connected` (unlike adjacent-cell presets) — a teleport pair isn't geometrically adjacent, so both endpoints must still go through normal generation for their regular connectivity.

### Persistence

`presetTeleports` is saved/restored in the project file (`presets.teleports`), same as connections/markers. On load, `_nextPresetTeleportId` is recomputed as `max(existing ids) + 1` (or `1` if empty) so newly created entries can't collide with restored ones. `_nextPresetTeleportId` also resets to `1` on `resetPresetConnections()`, consistent with the rest of preset state being fully cleared there.

## Default edge state

`defaultEdgeState: "undefined" | "wall" | "passage"` controls the implicit state of all edges not explicitly set by the user.

- `"undefined"` (default): no implicit state; unset edges are undecided.
- `"wall"` / `"passage"`: all interior edges without a user entry are populated with `source: "default"` entries of the chosen state.

When `defaultEdgeState` changes, `_applyDefaultEdgeState` is called:
1. All existing `source: "default"` entries are removed.
2. If new state is not `"undefined"`, default entries are added for all interior edges that have no `source: "user"` entry (including edges with `state: "undefined", source: "user"` — those are intentionally excluded from the default).

Applying the `reset` tool or RMB clears the edge's user override and re-materializes it as the current default (see "Entry source" above) — it does not pin the edge as explicitly undecided.

Changing `defaultEdgeState` also triggers `_recomputeAutoLock` if auto-lock is enabled.

## Drag mode

Tools `wall`, `passage`, and `reset` support drag with LMB held. While dragging:
- `beginEdgeDrag(edgeKey)` (on `BaseController`, shared with `PostEditController`) sets `dragActive` and seeds `dragVisited` on `pointerdown`
- `continueEdgeDrag(edge, onNewEdge)` deduplicates edges within one drag session via `dragVisited: Set<string>` and invokes `onNewEdge` for each newly-entered edge; the callback applies the current tool via `applyPresetConnectionsTool` — the helper itself never touches the store
- `endEdgeDrag()` clears `dragActive`/`dragVisited` on `pointerup` (LMB only)

One-way and lock/gen-source tools do not support drag.

## Validity

A preset connection is **invalid** if either of its endpoint cells is outside the current field. `computeInvalidKeys` iterates the preset map and checks membership in the cell set. Invalid presets:
- are drawn at full color/brightness, same as valid presets — the dark stage background outside the field (no floor fill there) already gives them lower visual weight, no separate dimming is applied
- are excluded from `generate()` before sending to WASM
- can be bulk-removed via "Clear invalid"

Since the cell-iteration loop in `buildPresetWallGroups` only visits cells inside the field, invalid presets with an endpoint entirely outside the field (never reached by that loop) are rendered in a second pass directly from the connection map, so they remain visible instead of silently disappearing. Invalid `wall`/`one_way` presets from this pass go into the same `preset` list as normal walls. Invalid `passage` presets go into a separate `invalidPassages` list, rendered on `invalidPassagesLayer` (see Rendering section).

The separate `highlightInvalidPresets` overlay (yellow, `INVALID_COLOR`) is the only explicit visual marker for invalid presets — it's an opt-in highlight layer, not the base rendering of the preset itself.

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
| `presetTeleports` | `PresetTeleportEntry[]` | Preset teleport links — see "Preset teleports" |
| `presetTeleportPendingFrom` | `[number, number] \| null` | First-click origin of an in-progress teleport placement |
| `_nextPresetTeleportId` | `number` | Next id to assign to a newly created teleport entry |

`presetConnections`, markers, locks, and `defaultEdgeState` reset when tessellation changes with a different kind (`confirmTessellation` with `clearMaze = true`) or when `resetPresetConnections()` is called.

`highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` whenever `setPresetConnectionsOpen(false)` is called.

## Tools

| Tool | Section | Action |
|---|---|---|
| `wall` | Edges | Sets edge to `wall` |
| `passage` | Edges | Sets edge to `passage` |
| `reset` | Edges | Clears the edge's user override, re-materializing it as the current default (`{ state: "undefined" }`/deleted if `defaultEdgeState` is `"undefined"`) |
| `one_way` | Edges | Cycles one-way direction |
| `set_start` | Vertex | Sets `presetStart` to clicked cell (when no vertex element is under the cursor). See "Shared vertex editing mode" above for drag/right-click, which apply to all vertex elements regardless of active vertex tool. |
| `set_finish` | Vertex | Sets `presetFinish` to clicked cell (when no vertex element is under the cursor). See "Shared vertex editing mode" above for drag/right-click, which apply to all vertex elements regardless of active vertex tool. |
| `teleport_one_way` | Vertex | Two-click placement of a one-way teleport — see "Preset teleports" |
| `teleport_two_way` | Vertex | Two-click placement of a two-way teleport — see "Preset teleports" |
| `lock_in` | Generation | Locks node to block incoming edges |
| `lock_out` | Generation | Locks node to block outgoing edges |
| `full_lock` | Generation | Locks node both in and out (`"both"`) |
| `gen_source` | Generation | Toggles `presetGenSource` on clicked cell (click same cell to clear) |

Right-click on an edge clears its user override and re-materializes it as the current default (same as the `reset` tool — see "Entry source" above), for any tool that falls through to edge picking (i.e. not `set_start`/`set_finish`/`gen_source`/lock/teleport tools, each of which gives right-click its own tool-specific meaning — see their rows above).

## Node locking

`lockedNodes: Map<"x,y", NodeLockKind>` stores explicitly locked nodes. `NodeLockKind` is `"in" | "out" | "both"`.

`autoLockedNodes: Set<"x,y">` is recomputed whenever `presetConnections` changes (if `autoLock` is enabled). A node is auto-locked when all its interior edges have a preset entry with `state !== "undefined"`. Edges with `state: "undefined"` are treated as undecided and prevent auto-lock. Auto-locked nodes always use `"both"` kind.

Both sets are merged when rendering (`buildLocks`) and when checking for isolated nodes (`buildIsolatedCellHighlights`).

**Isolated node**: a node locked `"both"` (manually or via auto-lock) with no non-wall preset on any of its edges. The UI shows a warning and highlights such cells.

## Card status

| Status | Condition (priority order) |
|---|---|
| `unavailable` | Field not ready |
| `warning` | Field ready, `computeInvalidKeys(...).size + computeInvalidTeleportIds(...).size + invalidMarkerCount > 0` |
| `set` | Field ready, no invalids, `presetConnections.size + markerCount > 0` |
| `set-default` | Field ready, no invalids, nothing set |

`markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0)`. `presetGenSource` is not counted here.

Subtitle: `"N preset(s)"` or `"N preset(s) · ⚠ M invalid"` where `N = presetConnections.size + markerCount + presetTeleports.length`. The invalid count `M` combines invalid edge presets, invalid teleports, and invalid start/finish markers (`computeInvalidKeys(...).size + computeInvalidTeleportIds(...).size + invalidMarkerCount`); "Clear invalid" removes all three kinds together.

## Rendering (`PresetConnectionsRenderer`)

Active when `presetConnectionsOpen = true`. Renders on top of grid; maze graph is hidden while open.

Layers (bottom to top):
1. **gridLayer** — tessellation grid
2. **floorLayer** — filled cell polygons (dark background)
3. **invalidPassagesLayer** — invalid (out-of-field) `passage` presets, drawn with `WallStyle: "background"` (`STAGE_BACKGROUND_COLOR`) that paints over the grid line, so the open passage reads as a gap in the grid (not a brightened/thickened line); sits below the wall layers so wall strokes are never broken by it
4. **undecidedLayer** — interior edges with no preset (faint stroke)
5. **presetWallsLayer** — `wall` and `one_way` edges (solid stroke), including invalid ones; one-way arrow triangles drawn inline
6. **teleportLayer** — teleport links (`TeleportRenderer`) — see "Preset teleports"
7. **locksLayer** — lock icons for both `lockedNodes` and `autoLockedNodes` (merged)
8. **markersLayer** — start/finish circles (`NODE_RADIUS * 1.5`)
9. **originLayer** — origin crosshair (when `showPresetOrigin = true`)
10. **genSourceLayer** — blue cross marker at `presetGenSource` cell
11. **isolatedHLLayer** — cell highlight for nodes locked both-in-and-out with no passage preset
12. **invalidHLLayer** — thick highlight when `highlightInvalidPresets = true`
13. **invalidTeleportHLLayer** — rounded-square outline at each endpoint of an invalid teleport, when `highlightInvalidPresets = true`
14. **hoverLayer** — highlighted edge under cursor
15. **teleportPreviewLayer** — in-progress teleport placement preview (semi-transparent line + marker)

**Exterior edges** (one endpoint outside field) are drawn as solid walls. **Interior edges** (both endpoints inside field) are drawn according to their preset state.

**Cell cache** (`cachedCells`, `cachedCellSet`) is built once on open and rebuilt only when `tessellationConfig`, `fieldPoints`, or `fieldEditMode` changes. All redraw calls use the cache. `getCachedCells()` and `getCachedCellSet()` expose the cache to the controller.

**`redrawInvalidHL`** is called separately when `highlightInvalidPresets` changes, without redrawing all other layers. Same for `redrawOrigin` and `redrawGenSource` on viewport scale changes.

`PresetConnectionsRenderer` extends `BaseFieldRenderer` (shared with `PostEditRenderer`; see maze-web/CLAUDE.md's Feature-Renderer ownership rule — a shared base class, never a shared instance). `BaseFieldRenderer` owns the `useMazeStore.subscribe` skeleton, the cell-cache lifecycle (`rebuildCellCache`, `getCachedCells`/`getCachedCellSet`), and `destroy`. `PresetConnectionsRenderer` implements `isCardOpen` (`openCard === "preset_connections"`), `getActiveConfig` (`tessellationConfig`), `setRootVisible`, `redrawAll`, `clearAll`, `destroyChildren`, and `onStoreChange` — the latter holds all of this feature's point updates that don't need a full `redrawAll` (field-points rebuild, origin/genSource/invalidHL/isolatedHL toggles, teleport preview clear on tool change).

## Gen source marker

`GenSourceRenderer` draws a blue cross (`0x3399ff`) at the `presetGenSource` cell. Same geometry as `OriginRenderer` (arm = `TILE_SIZE * 0.35 / vpScale`, line width = `max(3/vpScale, 2)`), with rounded line caps.

## Edge picking (`pickEdgeAtPosition`)

Hit-test for click/hover:
1. `screenToGrid` → cell under cursor
2. Check the cell and all its neighbors as candidates
3. For each candidate pair both in field, compute distance from pointer to the actual polygon edge segment (`getSharedEdgeSegment`)
4. If `deadZone` is passed and the closest point on a segment falls within `EDGE_ENDPOINT_DEAD_ZONE_FRACTION` (0.2) of either endpoint, skip that segment — this stops the cursor from hair-triggering a perpendicular edge while it passes near a shared grid vertex during a drag (#188)
5. Accept the closest remaining edge within `threshold = TILE_SIZE * 0.4` (or `TRI_TILE_SIZE * 0.4` for triangles)

`deadZone` defaults to `false` and is passed `true` only from `onPointerMove` (hover + drag-continuation) in both `PresetConnectionsController` and `PostEditController`; `onPointerDown` (plain click) calls omit it, so a single click can still hit an edge whose nearest point is close to a vertex.

Accepts an optional pre-built `cellSet` to avoid rebuilding on every pointer event (passed from `PresetConnectionsRenderer.getCachedCellSet()`).

## WASM wire format

`generate()` sends only valid presets:

```ts
preset_connections: Array<{ from: [number,number], to: [number,number], state: PresetConnectionState }>
preset_start?: [number, number]      // explicit start endpoint (presetStart)
preset_finish?: [number, number]
preset_gen_source?: [number, number] // generation algorithm seed (presetGenSource)
locked_nodes: Array<{ point: [number,number], kind: NodeLockKind }>
```

Filtered by `computeInvalidKeys` before building the payload. Invalid entries are silently dropped. `lockedNodes` and `autoLockedNodes` are merged before sending.

On the Rust side: `PresetConnectionDto` with `#[derive(Deserialize)]`; `PresetConnectionState` enum; stored in `GenerationConfig.preset_connections: Vec<PresetConnection>`. Default is `vec![]`.

## Lifecycle

| Event | Effect |
|---|---|
| Tessellation confirmed (kind changes) | `presetConnections` cleared, markers cleared, `defaultEdgeState` reset |
| `resetPresetConnections()` | Same as above, plus `presetTeleports` cleared and `_nextPresetTeleportId` reset to `1` |
| Field cells added/removed | Connections stay; invalidity recomputed from field |
| Card opens | Renderer subscribes, cell cache built |
| Card closes | Renderer clears graphics; `highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` |
| Generate | Invalid connections filtered out, valid ones sent to WASM |
| `defaultEdgeState` changes | All `source:"default"` entries removed and repopulated; auto-lock recomputed |
