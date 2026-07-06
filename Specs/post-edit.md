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
| `postEditDraftEdges` | `Record<string, PostEditEdge> \| null` | Current working Basic/one-way edges. `null` before first generation. Read by `PostEditRenderer`. |
| `postEditDraftTeleportEdges` | `EdgeDto[]` | Teleport edges carried through from generation, read-only (no post-edit tool edits them yet). Kept as a plain list, not folded into `postEditDraftEdges`'s `Record` — a Teleport and a Basic edge can coexist in the same direction between the same pair (see `Graph::add_edge`'s kind-aware dedup), which that `Record` (keyed by `from-to`, one slot per directed pair) cannot represent without one silently overwriting the other. Read by `PostEditRenderer`. |
| `postEditDraftMeta` | `PostEditMeta \| null` | Current working start/finish overrides. Read by `PostEditRenderer`. |
| `postEditEdges` | `Record<string, PostEditEdge> \| null` | Snapshot of `postEditDraftEdges` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditTeleportEdges` | `EdgeDto[]` | Snapshot of `postEditDraftTeleportEdges` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
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

`wall` is an explicit record (absence of record ≠ wall — wall is a deliberate user choice). `one_way_forward` and `one_way_backward` always store correct directed fields: `from→to` is the actual passage direction. There is no `"teleport"` kind here — teleport edges never enter `postEditDraftEdges`/`postEditEdges` at all (see `postEditDraftTeleportEdges` above).

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
3. Initializes `postEditDraftTeleportEdges` via `extractTeleportEdges(snapshot.edges)` — every `kind: "teleport"` entry, carried through unchanged.
4. Sets `postEditDraftMeta = { start: snapshot.start, finish: snapshot.finish }`.
5. Resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta = null`, `postEditAnalytics = null`.
6. Sets `_generatedStart`, `_generatedFinish`.
7. Resets `postEditTool` to `"wall"`.
8. Calls `confirmPostEdit()` immediately — populates `postEditEdges`, `postEditTeleportEdges`, `postEditMeta`, `postEditAnalytics`.

### On `resetPostEdit()`

1. Rebuilds `postEditDraftEdges` from `state.edges` via `buildPostEditDraftEdgesFromGenerated`.
2. Rebuilds `postEditDraftTeleportEdges` from `state.edges` via `extractTeleportEdges`.
3. Restores `postEditDraftMeta` from `_generatedStart`/`_generatedFinish`.
4. Resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta = null`, `postEditAnalytics = null`.
5. Resets `postEditTool` to `"wall"`.
6. Calls `confirmPostEdit()`.

### On `confirmPostEdit()`

Async, versioned via `_postEditRequestId`:

1. Increments `_postEditRequestId`.
2. Snapshots `postEditDraftEdges`, `postEditDraftTeleportEdges`, and `postEditDraftMeta` at call time.
3. Reads `effectiveStart`/`effectiveFinish` from snapshot (falls back to `state.start/finish` when null).
4. Serializes non-wall edges to `PostEditEdgeWasmDto[]`: `basic` → `"basic"` (bidirectional in WASM); `one_way_forward`/`one_way_backward` → `"one_way"` (WASM adds only one directed edge `from→to`); each `postEditDraftTeleportEdges` entry → `"teleport"` (WASM adds one directed `EdgeKind::Teleport` edge — a two-way teleport is sent as two separate `"teleport"` entries, one per direction, not auto-expanded like `"basic"`).
5. Calls WASM `compute_analytics` — QC-only (runs `checks`, no repair). Always sends an empty `check_rules`: rules exist to dispatch repair strategies, and `compute_analytics` discards the `RepairEngine` it builds internally, so a rule referencing a check the caller disabled would only ever produce a spurious "inactive check" validation error for no benefit.
6. If `_postEditRequestId` changed (stale) — discards result.
7. Writes to `postEditAnalytics`, `postEditEdges` (confirmed snapshot), `postEditTeleportEdges` (confirmed snapshot), `postEditMeta` (confirmed snapshot). Auto-resets `showRouteOverlay` to `false` when `route_info == null`.

## Tools

| Tool | Action |
|---|---|
| `wall` | Removes both directions of edge pair from `postEditDraftEdges`. |
| `passage` | Ensures both directions exist as `"basic"` in `postEditDraftEdges`. |
| `one_way` | Toggles direction: if `fwd` exists → replace with `bwd`; otherwise → replace with `fwd`. Wall/passage not affected. |
| `reset` | Restores edge pair to original generated state (basic or one_way_forward). |
| `set_start` | Click on empty node — sets `postEditDraftMeta.start`, calls `confirmPostEdit` if `autoConfirm`. |
| `set_finish` | Click on empty node — sets `postEditDraftMeta.finish`, calls `confirmPostEdit` if `autoConfirm`. |

`set_start` and `set_finish` together form the vertex tools section. While either is active, drag-to-move and right-click-to-delete apply uniformly to **both** the start and finish markers, regardless of which one is currently selected: right-click on the current start node clears it (`clearPostEditEndpoint`) even while `set_finish` is active, and press-and-drag from either marker's node moves it live to whichever node is under the cursor, even while the other tool is active. Only the plain-click "assign to this empty node" action stays tied to the active tool (`set_start` assigns start, `set_finish` assigns finish).

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

Reads from `postEditDraftEdges`, `postEditDraftTeleportEdges`, and `postEditDraftMeta` — always shows the current working state, regardless of `autoConfirm`.

Lives in `postEditContainer` — a synced layer in `MazeScene` (not a viewport child). `TessellationRenderer` hides itself when `postEditOpen` is true.

### Layer Stack (bottom to top)

| # | Container | Content |
|---|---|---|
| 1 | `gridContainer` | `GridRenderer` — always rendered when open |
| 2 | `floorContainer` | `CellFillRenderer` — all nodes in `FLOOR_COLOR` |
| 3 | `closedCellsContainer` | `CellFillRenderer` — isolated nodes (no edges) in `WALL_COLOR` |
| 4 | `wallsContainer` | `WallRenderer` — walls and one-way arrows |
| 5 | `teleportContainer` | `TeleportRenderer` — teleport markers/line, built from `postEditDraftEdges` concatenated with `postEditDraftTeleportEdges` (read-only pass-through, no post-edit tool edits these) |
| 6 | `markersContainer` | `WaypointsRenderer` — start/finish from `postEditDraftMeta` |
| 7 | `hoverContainer` | `EdgeHighlightRenderer` — hover highlight |

Cell cache (`cachedCells`, `cachedCellSet`) is built once on open and on `activeTessellationConfig` change. Used by `PostEditController` for edge picking.

`PostEditRenderer` extends `BaseFieldRenderer` (shared with `PresetConnectionsRenderer`; see maze-web/CLAUDE.md's Feature-Renderer ownership rule — a shared base class, never a shared instance). `BaseFieldRenderer` owns the `useMazeStore.subscribe` skeleton (open/close detection, cell-cache lifecycle, `getCachedCells`/`getCachedCellSet`, `destroy`). `PostEditRenderer` implements `isCardOpen` (`openCard === "post_edit"`), `getActiveConfig` (`activeTessellationConfig`), `setRootVisible`, `redrawAll`, `clearAll`, `onStoreChange` (the draft-edges/teleport-edges/nodes/meta comparison above), and `destroyChildren`.

## Controller — PostEditController

Extends `BaseController` (shared with `PresetConnectionsController`). `BaseController` owns pan logic (`tryStartPan`, `handlePanMove`, `toViewport`), edge-drag bookkeeping (`beginEdgeDrag`/`continueEdgeDrag`/`endEdgeDrag`/`isDragActive` — dedupe-only, the caller's `onNewEdge` callback owns the store action and any redraw), and marker-drag bookkeeping (`draggingMarker`, `armMarkerDrag`/`releaseMarkerDrag` — the latter called automatically from `onPointerUp`). `PostEditController` adds node-map caching, edge picking, tool dispatch, and confirm debounce.

Handles pointer events when `postEditOpen`. Node map (`Map<"x,y", nodeId>`) is cached per `nodes` reference — rebuilt only when `state.nodes` changes.

- **Left click + edge tool** → `applyPostEditTool`, schedule confirm if `autoConfirm`.
- **Left click + endpoint tool (`set_start`/`set_finish`), no start/finish marker under cursor** → `setPostEditEndpoint` for whichever endpoint the active tool targets (confirm called internally by store action when `autoConfirm`).
- **Left press-drag + endpoint tool, starting on start's or finish's own node** → arms drag for that marker regardless of which endpoint tool is active; each pointer move over a new node calls `setPostEditEndpoint` again to move it live. A press that never leaves the marker's node resolves as a plain click on release (no-op, node unchanged).
- **Right click + endpoint tool, on the start or finish marker's own node** → `clearPostEditEndpoint` for that marker, regardless of which endpoint tool is active. Right-click elsewhere is a no-op for endpoint tools.
- **Middle click** → pan viewport.

## `buildPostEditDraftEdgesFromGenerated`

Shared function used by `_generateWithSeed` and `resetPostEdit`. Ignores `kind: "teleport"` entries entirely (see `extractTeleportEdges` below). Detects one_way edges by absence of reverse: if `A→B` exists but `B→A` does not → `one_way_forward`. If both exist → `basic`.

## `extractTeleportEdges`

Shared function in `postEditUtils.ts`, used by `_generateWithSeed` and `resetPostEdit` alongside `buildPostEditDraftEdgesFromGenerated`. Filters generation's `EdgeDto[]` down to `kind: "teleport"` entries, unchanged — the resulting list feeds `postEditDraftTeleportEdges` directly, one entry per directed teleport edge (a two-way teleport is two entries). Not folded into `buildPostEditDraftEdgesFromGenerated`'s `Record` output because a Teleport and a Basic edge can coexist in the same direction between the same pair — that `Record` has only one slot per `from-to` key and would drop one of the two.

## `postEditEdgesToDto`

Shared selector in `mazeSelectors.ts`. Converts `Record<string, PostEditEdge> | null` to `EdgeDto[]`, filtering out `wall` entries and mapping every remaining entry's `kind` to `"basic"` (post-edit's tool-facing distinction between `basic`/`one_way_forward`/`one_way_backward` collapses here — direction is already encoded in each entry's own `from`/`to`, and downstream consumers like `buildMazeWalls` derive one-way vs bidirectional by checking for the reverse pair, not by reading `kind`). Never returns teleport entries — those live in `postEditDraftTeleportEdges`/`postEditTeleportEdges` and must be concatenated in by the caller. Used by both `PostEditRenderer` (passing `postEditDraftEdges`, concatenated with `postEditDraftTeleportEdges`) and `AnalyticsRenderer` (passing `postEditEdges`, concatenated with `postEditTeleportEdges`).

## `buildClosedCells`

Shared selector in `mazeSelectors.ts`. Finds nodes with no connected edges — rendered as `WALL_COLOR` in both `PostEditRenderer` and `GenerationRenderer`.
