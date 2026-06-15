# Post-Edit Feature — Web Client

Post-Edit sits between Generation and Analytics in `FeaturesPanel`. It lets users manually modify maze edges after generation before inspecting analytics. Analytics always reads the confirmed post-edited graph.

## Availability

- Card status `"unavailable"` when `nodes.length === 0`
- Card status `"set"` after generation (no warnings from `postEditAnalytics`)
- Card status `"warning"` when `postEditAnalytics.warnings.length > 0`

## Three-State Model

| State | Condition | Analytics source |
|---|---|---|
| Generated | After `generate()`, before any manual confirm | From `generate()` call — `postEditAnalytics` set immediately |
| Post-edit confirmed | After `confirmPostEdit()` (auto or manual) | From `confirmPostEdit()` result |
| Post-edit draft | `autoConfirm=false`, edges/meta changed since last confirm | Frozen at last confirm — canvas shows draft, analytics shows confirmed |

## Store Fields

| Field | Type | Description |
|---|---|---|
| `postEditDraftEdges` | `Record<string, PostEditEdge> \| null` | Current working edges. `null` before first generation. Read by `PostEditRenderer`. |
| `postEditDraftMeta` | `PostEditMeta \| null` | Current working start/finish overrides. Read by `PostEditRenderer`. |
| `postEditEdges` | `Record<string, PostEditEdge> \| null` | Snapshot of `postEditDraftEdges` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditMeta` | `PostEditMeta \| null` | Snapshot of `postEditDraftMeta` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditAnalytics` | `PostEditAnalytics \| null` | Analytics over confirmed graph. `null` until first `confirmPostEdit` completes. |
| `postEditTool` | `PostEditTool` | Active tool. Reset to `"wall"` on generate and `resetPostEdit`. |
| `postEditAutoConfirm` | `boolean` | Default `true`. When true, `confirmPostEdit` fires 300ms after each edge edit. |
| `postEditOpen` | `boolean` | Drives canvas layer visibility. |
| `_postEditRequestId` | `number` | Versioning for stale async `confirmPostEdit` results. |
| `_generatedStart` | `number \| null` | Start as generated — restored on `resetPostEdit`. |
| `_generatedFinish` | `number \| null` | Finish as generated — restored on `resetPostEdit`. |

### PostEditEdge

```typescript
interface PostEditEdge {
  from: number;
  to: number;
  kind: "wall" | "basic" | "one_way_forward" | "one_way_backward";
}
```

`wall` is an explicit record (absence of record ≠ wall — wall is a deliberate user choice). `one_way_forward` and `one_way_backward` always store correct directed fields: `from→to` is the actual passage direction.

### PostEditMeta

```typescript
interface PostEditMeta {
  start: number | null;
  finish: number | null;
}
```

Separate from `state.start/finish` so Generation renderer always shows the originally generated endpoints.

## Lifecycle

### On `generate()`

1. Runs WASM generation.
2. Initializes `postEditDraftEdges` via `buildPostEditDraftEdgesFromGenerated(snapshot.edges)` — detects one_way by absence of reverse edge.
3. Sets `postEditDraftMeta = { start: snapshot.start, finish: snapshot.finish }`.
4. Resets `postEditEdges = null`, `postEditMeta = null`, `postEditAnalytics = null`.
5. Sets `_generatedStart`, `_generatedFinish`.
6. Resets `postEditTool` to `"wall"`.
7. Calls `confirmPostEdit()` immediately — populates `postEditEdges`, `postEditMeta`, `postEditAnalytics`.

### On `resetPostEdit()`

1. Rebuilds `postEditDraftEdges` from `state.edges` via `buildPostEditDraftEdgesFromGenerated`.
2. Restores `postEditDraftMeta` from `_generatedStart`/`_generatedFinish`.
3. Resets `postEditEdges = null`, `postEditMeta = null`, `postEditAnalytics = null`.
4. Resets `postEditTool` to `"wall"`.
5. Calls `confirmPostEdit()`.

### On `confirmPostEdit()`

Async, versioned via `_postEditRequestId`:

1. Increments `_postEditRequestId`.
2. Snapshots `postEditDraftEdges` and `postEditDraftMeta` at call time.
3. Reads `effectiveStart`/`effectiveFinish` from snapshot (falls back to `state.start/finish` when null).
4. Serializes non-wall edges to `PostEditEdgeWasmDto[]`. `basic` → `"basic"` (bidirectional in WASM). `one_way_forward`/`one_way_backward` → `"one_way"` (WASM adds only one directed edge `from→to`).
5. Calls WASM `compute_analytics`.
6. If `_postEditRequestId` changed (stale) — discards result.
7. Writes to `postEditAnalytics`, `postEditEdges` (confirmed snapshot), `postEditMeta` (confirmed snapshot). Auto-resets `showRouteOverlay` to `false` when `route_info == null`.

## Tools

| Tool | Action |
|---|---|
| `wall` | Removes both directions of edge pair from `postEditDraftEdges`. |
| `passage` | Ensures both directions exist as `"basic"` in `postEditDraftEdges`. |
| `one_way` | Toggles direction: if `fwd` exists → replace with `bwd`; otherwise → replace with `fwd`. Wall/passage not affected. |
| `reset` | Restores edge pair to original generated state (basic or one_way_forward). |
| `set_start` | Click on node — sets `postEditDraftMeta.start`, calls `confirmPostEdit` if `autoConfirm`. |
| `set_finish` | Click on node — sets `postEditDraftMeta.finish`, calls `confirmPostEdit` if `autoConfirm`. |

### `one_way` Tool Detail

Operates on an edge pair `(from_, to_)`:

- `fwd` record exists (`from_→to_`) → delete fwd, create `bwd` (`to_→from_`, kind `one_way_backward`)
- `fwd` does not exist → delete `bwd` (if any), create `fwd` (`from_→to_`, kind `one_way_forward`)

Result: pure direction toggle. Conversion to/from wall and passage requires `wall` and `passage` tools.

### `reset` Tool Detail

Looks up `(from_, to_)` pair in original `state.edges`:

- Both directions exist → restores both as `"basic"`.
- Only `from_→to_` exists → restores as `"one_way_forward"`, removes `bwd`.
- Only `to_→from_` exists → restores as `"one_way_forward"` (on the `to_→from_` record), removes `fwd`.
- Neither exists → removes both.

## Auto-Confirm

When `postEditAutoConfirm = true`, `PostEditController` schedules `confirmPostEdit` with 300ms debounce after each edge tool click. For endpoint tools (`set_start`/`set_finish`), `confirmPostEdit` is called directly by the store action (only when `autoConfirm = true`) — controller does not schedule an additional call.

When `postEditAutoConfirm = false`:
- Edge tool clicks update `postEditDraftEdges` but do not trigger `confirmPostEdit`.
- Endpoint tool clicks update `postEditDraftMeta` but do not trigger `confirmPostEdit`.
- `postEditEdges`, `postEditMeta`, `postEditAnalytics` remain frozen at last confirm.
- Manual Confirm button calls `confirmPostEdit()` explicitly.

## Canvas Renderer — PostEditRenderer

Reads from `postEditDraftEdges` and `postEditDraftMeta` — always shows the current working state, regardless of `autoConfirm`.

Lives in `postEditContainer` — a synced layer in `MazeScene` (not a viewport child). `TessellationRenderer` hides itself when `postEditOpen` is true.

### Layer Stack (bottom to top)

| # | Container | Content |
|---|---|---|
| 1 | `gridContainer` | `GridRenderer` — always rendered when open |
| 2 | `floorContainer` | `CellFillRenderer` — all nodes in `FLOOR_COLOR` |
| 3 | `closedCellsContainer` | `CellFillRenderer` — isolated nodes (no edges) in `WALL_COLOR` |
| 4 | `wallsContainer` | `WallRenderer` — walls and one-way arrows |
| 5 | `markersContainer` | `WaypointsRenderer` — start/finish from `postEditDraftMeta` |
| 6 | `hoverContainer` | `EdgeHighlightRenderer` — hover highlight |

Cell cache (`cachedCells`, `cachedCellSet`) is built once on open and on `activeTessellationConfig` change. Used by `PostEditController` for edge picking.

## Controller — PostEditController

Extends `BaseController` (shared with `PresetConnectionsController`). `BaseController` owns pan logic: `tryStartPan`, `handlePanMove`, `onPointerUp`, `toViewport`. `PostEditController` adds node-map caching, edge picking, tool dispatch, and confirm debounce.

Handles pointer events when `postEditOpen`. Node map (`Map<"x,y", nodeId>`) is cached per `nodes` reference — rebuilt only when `state.nodes` changes.

- **Left click + edge tool** → `applyPostEditTool`, schedule confirm if `autoConfirm`.
- **Left click + endpoint tool** → `setPostEditEndpoint` (confirm called internally by store action when `autoConfirm`).
- **Middle click** → pan viewport.

## `buildPostEditDraftEdgesFromGenerated`

Shared function used by `_generateWithSeed` and `resetPostEdit`. Detects one_way edges by absence of reverse: if `A→B` exists but `B→A` does not → `one_way_forward`. If both exist → `basic`.

## `postEditEdgesToDto`

Shared selector in `mazeSelectors.ts`. Converts `Record<string, PostEditEdge> | null` to `EdgeDto[]`, filtering out `wall` entries. Used by both `PostEditRenderer` (passing `postEditDraftEdges`) and `AnalyticsRenderer` (passing `postEditEdges`).

## `buildClosedCells`

Shared selector in `mazeSelectors.ts`. Finds nodes with no connected edges — rendered as `WALL_COLOR` in both `PostEditRenderer` and `GenerationRenderer`.
