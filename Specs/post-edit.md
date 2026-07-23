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
| `postEditDraftTeleports` | `PostEditTeleportEntry[]` | Current working teleport links, edited by node id. Kept as a plain list, not folded into `postEditDraftEdges`'s `Record` — a Teleport and a Basic edge can coexist in the same direction between the same pair (see `Graph::add_edge`'s kind-aware dedup), which that `Record` (keyed by `from-to`, one slot per directed pair) cannot represent without one silently overwriting the other. Converted to `EdgeDto[]` via `postEditTeleportsToDto` at the WASM-call/render boundary. Read by `PostEditRenderer`. |
| `postEditTeleportPendingFrom` | `number \| null` | Node id of the pending teleport's fixed origin during two-click placement, or `null`. |
| `_nextPostEditTeleportId` | `number` | Monotonic id source for `postEditDraftTeleports` entries. |
| `postEditDraftMeta` | `PostEditMeta \| null` | Current working start/finish overrides. Read by `PostEditRenderer`. |
| `postEditDraftSplitPoints` | `Record<string, number[]>` | slotIds of each split point's extra nodes, keyed by `"x,y"` — see "Split Points" below (GitHub issue #221). |
| `postEditActiveSplitNode` | `Record<string, PostEditEndpoint>` | Which of a split point's nodes edge-tool clicks currently target, keyed by `"x,y"`. No entry means the point's original node. |
| `postEditFocusedPoint` | `[number, number] \| null` | The point currently selected for the "Manage split nodes" dialog. |
| `postEditEdges` | `Record<string, PostEditEdge> \| null` | Snapshot of `postEditDraftEdges` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditTeleportEdges` | `EdgeDto[]` | Snapshot of `postEditDraftTeleports` (converted via `postEditTeleportsToDto`) at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditMeta` | `PostEditMeta \| null` | Snapshot of `postEditDraftMeta` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditAnalytics` | `PostEditAnalytics \| null` | Analytics over confirmed graph. `null` until first `confirmPostEdit` completes. |
| `postEditTool` | `PostEditTool` | Active tool. Reset to `"wall"` on generate and `resetPostEdit`. |
| `postEditAutoConfirm` | `boolean` | Default `true`. When true, `confirmPostEdit` fires 300ms after each edge edit. |
| `postEditOpen` | `boolean` | Drives canvas layer visibility. |
| `_postEditRequestId` | `number` | Versioning for stale async `confirmPostEdit` results. |
| `_generatedStart` | `number \| null` | Start as generated — restored on `resetPostEdit`. |
| `_generatedFinish` | `number \| null` | Finish as generated — restored on `resetPostEdit`. |

### PostEditEndpoint (GitHub issue #221)

```typescript
type PostEditEndpoint =
  | { kind: "node"; id: number }
  | { kind: "split"; point: [number, number]; slotId: number };
```

A tile's point can resolve to more than one graph node ("split point", see `Specs/space.md`/epic #218). `node` is a plain already-resolved `NodeId`; `split` addresses one of a split point's extra nodes by its stable per-point `slotId`, since the JS side never predicts a not-yet-confirmed split node's real `NodeId`.

**Why not a raw `NodeId`:** `compute_analytics` rebuilds the graph from scratch on every `confirmPostEdit` call, and `NodeId` is `IdGenerator`'s sequential counter — its value depends purely on how many nodes were created earlier in that specific call. A split node's absolute `NodeId` is therefore **not stable across confirms**: changing the set of split points (adding/removing a slot anywhere) can shift the `NodeId` of every node created after it in that call. This never showed up for ordinary nodes only because the tessellation's point set/order never changes between calls — split points are the first case where the "extra nodes beyond the base set" composition can actually change. The fix is not attempting to make split-node `NodeId`s stable (rejected: reserving id blocks/hash-based ids would make split nodes an architecture-level special case in `maze-core` for no real benefit) — it's that nothing holds onto a raw `NodeId` for a split node across confirms. Every place that needs to survive a confirm (`PostEditEdge`/`PostEditTeleportEntry`'s `from`/`to`, `PostEditMeta`'s `start`/`finish`) stores a `PostEditEndpoint` instead, resolved to a real id fresh on each use.

Provided by `pixi/postEditEndpoint.ts`: `nodeEndpoint`/`splitEndpoint` (constructors), `endpointsEqual` (structural equality, used regardless of confirm state), `endpointKey`/`edgeKey` (stable string keys — `"n42"` for a node, `"s3,5:7"` for a split, disjoint prefixes), `endpointIsNode`, `resolveEndpoint` (resolves to a real id via a caller-supplied `resolveSplit` lookup, `undefined` if not resolvable yet), `buildSplitNodeResolver` (builds that lookup from a confirmed node snapshot grouped by point, plus `postEditDraftSplitPoints`).

**Unresolved-endpoint contract:** a `split` endpoint doesn't resolve in the window between `addSplitNode` (which writes the slotId to the draft immediately) and the first successful `confirmPostEdit` after that. Canvas/renderer code (`postEditEdgesToDto`/`postEditTeleportsToDto`) silently drops any entry with an unresolved endpoint — nothing to draw yet, same as an ordinary id with no `nodeById` match. `confirmPostEdit`'s WASM call never needs to resolve edges/teleports' `split` endpoints on the JS side at all — `split_points` is sent alongside them in the same call, so WASM always resolves them itself, after creating the node. `start`/`finish` are the one place resolution happens client-side (see below).

### PostEditEdge

```typescript
interface PostEditEdge {
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  kind: "wall" | "basic" | "one_way_forward" | "one_way_backward";
}
```

`wall` is an explicit record (absence of record ≠ wall — wall is a deliberate user choice). `one_way_forward` and `one_way_backward` always store correct directed fields: `from→to` is the actual passage direction. There is no `"teleport"` kind here — teleport edges never enter `postEditDraftEdges`/`postEditEdges` at all (see `postEditDraftTeleports` above). Keyed in its `Record` by `edgeKey(from, to)`, not a hand-built `${from}-${to}` template literal.

### PostEditTeleportEntry

```typescript
type PostEditTeleportDirection = "forward" | "backward" | "two_way";

interface PostEditTeleportEntry {
  id: number;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditTeleportDirection;
}
```

Edits teleport links by node/split endpoint (unlike `PresetTeleportEntry`, which edits by cell coordinate on the pre-generation field). `id` is assigned by `_nextPostEditTeleportId`, monotonically increasing, never reused within a session. `from`/`to` are the two click points in placement order; for `"backward"`, the actual passage direction runs `to→from` (mirrors `PresetConnectionState::TeleportBackward`). `"two_way"` expands to both directions. Converted to `EdgeDto[]` via `postEditTeleportsToDto`.

### PostEditMeta

```typescript
interface PostEditMeta {
  start: PostEditEndpoint | null;
  finish: PostEditEndpoint | null;
}
```

Separate from `state.start/finish` so Generation renderer always shows the originally generated endpoints. `start`/`finish` are `PostEditEndpoint`, not a bare `number` (revised for GitHub issue #221 — see the `PostEditEndpoint` section above for why). On the WASM boundary, `ComputeAnalyticsConfig.start`/`.finish` stay a plain `number | null` (`Maze::meta.start`/`.finish` in `maze-core` are always `Option<NodeId>`, unrelated to the endpoint concept) — `confirmPostEdit` resolves `postEditDraftMeta.start`/`.finish` to a plain id (or `null` if unresolved) client-side before building the WASM request, using the same `resolveEndpoint`/node-map lookup the controller uses for clicks.

## Split Points (GitHub issue #221)

Lets the user manually add extra nodes to a tile's point and wire up edges to them explicitly — e.g. two independent passages (N↔S and E↔W) through what the generator produced as a single 4-way junction. There is no "routing group" concept: the feature only lets the user create additional nodes at a point and connect edges to them like any other manual edge edit; which of a point's nodes ends up connected to what is entirely up to the user, one edge at a time.

- **`postEditDraftSplitPoints`** stores the list of slotIds per point (not a count, not a positional index — see the `PostEditEndpoint` section for why a positional scheme doesn't work). Each slotId is unique only **within its own point** — `PostEditEndpoint`'s `split` variant already addresses point+slotId together, so no global counter is needed. `addSplitNode` mints the next slotId as `max(existing slotIds for this point) + 1` (or `0` if the point has none yet).
- **The point's original node can never be removed** — only slotIds added via `addSplitNode` can be.
- **Deleting a split node** (`removeSplitNode(point, slotId)`) first checks (via `endpointsEqual`, not a resolved id — works the same whether or not the node has been confirmed yet) whether `postEditDraftMeta.start`/`.finish` structurally equals the target; if so the removal is rejected outright with an error, no silent reassignment. Otherwise it removes every `postEditDraftEdges`/`postEditDraftTeleports` entry referencing that endpoint (`endpointsEqual`, a plain filter — no reindexing of any sibling slot), removes the slotId from the list, and resets `postEditActiveSplitNode` for that point if the removed slot was the active one.
- **`cycleActiveSplitNode(point)`** cycles `postEditActiveSplitNode[key]` through original → slot 0 → slot 1 → … → back to original (no entry). No-op for a point with no split nodes.
- **`setActiveSplitNode(point, endpoint)`** sets it directly (used by the dialog's per-row "Set active" button); a `node`-kind endpoint clears the entry (meaning the original node).

### WASM boundary

`ComputeAnalyticsConfig.split_points: [[number, number], number][]` — a flat list of `(point, slotId)` pairs, built by `confirmPostEdit` from all of `postEditDraftSplitPoints`'s entries (no sort on the JS side — the Rust side sorts internally). `apply_split_points` (in `maze-wasm/src/analytics.rs`) applies them via `Maze::add_node_at`, one call per entry, in a deterministic `(point, slotId)`-sorted order, before edges are resolved — some edges may reference a split node. Returns a `(point, slotId) -> NodeId` map used to resolve `PostEditEndpointDto::Split` in `PostEditEdgeDto.from`/`.to`.

`nodes: Vec<NodeDto>` in the snapshot is built from `Field::all_points()`/`nodes_at()` (deterministic: a point's original node first, then each extra node in creation order), not `Graph::nodes()`'s insertion order — this makes "which node of a split point is the original one" a real, documented contract, not an incidental observation of `Graph`'s internals. The web-side node map (grouped by point) relies on this order.

### Controller/UI

- **A dedicated `manage_split_nodes` tool** (toolbar button next to the vertex tools) puts left-clicks in "focus a point" mode: clicking any point sets `postEditFocusedPoint` to that point (or clears it if the click misses), opening the "Manage split nodes" dialog. This does **not** touch right-click behavior for the other tools — right-click with an edge tool still applies the edge tool exactly like a left-click (unchanged, no `button` check), and right-click with `set_start`/`set_finish`/a teleport tool still clears/removes as before. Works on any point, split or not — it's the only way to create a point's *first* extra node.
- **"Manage split nodes" dialog** (`ManageSplitNodesDialog.tsx`) is the single UI surface for managing a point's extra nodes — no separate always-visible toolbar toggle. One row per node (original node first, then each slot in order): a coordinate-style bubble (visual style borrowed from `DebugRefBubble`, not its hover/click behavior), a link count, a "Set active" button (disabled if already active), and (for slots only) a "Remove" button behind a `ConfirmModal`. A footer "+ Add node" button calls `addSplitNode`. Renders whenever `postEditFocusedPoint !== null`, independent of the active tool — switching tools does not close it. Closes on explicit close (✕/Escape, clearing `postEditFocusedPoint`) or on leaving the post-edit card.
- **`buildNodeMap`** in `PostEditController` returns `Map<string, number[]>` (every real node at a point, in snapshot order), not one id per cell. **`resolveActiveEndpointAt(point, nodeMap, activeMap)`** resolves which endpoint edge-tool clicks on that point currently target: `activeMap[key]` if set, else the point's original node (`nodeMap`'s first entry); `null` if the point isn't in the field.
- **Vertex tools (`set_start`/`set_finish`) on a split point's active node that isn't confirmed yet** are a no-op (not an error) — the same click works once that node is confirmed by a `confirmPostEdit`. This is a direct consequence of `PostEditEndpoint`'s unresolved-endpoint contract, not special-cased split logic: `resolveActiveEndpointAt` can return a `split` endpoint that doesn't resolve to a real id yet, and there is nothing wrong with assigning `postEditDraftMeta.start`/`.finish` to it (the endpoint itself is always valid) — it just can't be sent to WASM as a plain id until it resolves.

### Persistence

`ProjectFilePostEdit.splitPoints: Record<string, number[]>` mirrors `postEditDraftSplitPoints` — without it, saving/reloading a project would silently lose every manually created split point. `postEditActiveSplitNode` is not persisted (ephemeral UI selection, reset to `{}` on load). Project-file validation (`validatePostEditEndpoint` in `projectExport/validate.ts`) checks only the **format** of a `PostEditEndpoint`/`splitPoints` entry — it has no `Field` to check a `split` endpoint's point against at load time. Whether a loaded point still exists in the current tessellation is checked by `apply_split_points` on the WASM side, surfacing as an ordinary `confirmPostEdit` error on first confirm after load, not a load-time failure.

### Rendering (GitHub issue #223)

`PostEditRenderer` draws every node of a split point at once, not just the currently active one — `postEditActiveSplitNode` still governs which endpoint edge-tool clicks/edits target, but no longer filters what's drawn.

A split point (a point with more than one `NodeDto`) is excluded entirely from `buildMazeWalls`'s ordinary wall/passage reading — every geometric edge touching one is skipped there (both interior walls and boundary walls), and rendered instead by `buildSplitPassages` + `SplitJunctionRenderer`:

- For each geometric face a node connects across (`kind !== "teleport"`, matched by node id, not just cell coordinate — a "face" means a neighboring tile, not a specific node of that neighbor), that node draws its own share of the wall on that face (`SplitPassage.wallSegments`, in its own color). When several of the point's nodes connect across the same face, the face's edge is divided evenly among them in slot order, each getting one contiguous sub-segment, so two independent passages sharing a face read as visually distinct rather than overlapping.
- Those shares are linked into `connectors`: a node with **exactly 2** connected faces draws one straight line directly between its two shares' centers — no hub point, since a pure through-passage reads more naturally as one continuous corridor than a bent one via a hub. Any other count (1, or 3+) draws one line per share from the node's own point on a small circle around the tile center (radius = 1/2 of the cell's own radius, i.e. `TILE_SIZE / 4`, evenly distributed among the point's node count — 3 nodes → 0°/120°/240°, etc. — rotated by a per-tessellation starting angle, `getSplitCircleRotationDeg` in `tessellationGeometry.ts` — 45° for square, 0° for hex/tri pending visual tuning) out to that share's center. The circle itself is never drawn. A node with zero connections draws nothing at all.
- **Straightening exception:** the 2-face straight-line case above is skipped (hub point kept instead) for a node passed in `buildSplitPassages`'s `specialNodeIds` — `PostEditRenderer` populates this from `start`/`finish` (resolved node ids) and every teleport edge's endpoints, so a marker/teleport line landing on that node always has a single unambiguous hub point to sit on, instead of an arbitrary spot along a straightened line.
- **Marker/teleport anchoring:** `getSplitAwareNodePosition` (`mazeSelectors.ts`) is the single source of truth for where a node-anchored entity draws — the plain cell center for an unsplit node, or that same node's hub point (identical radius/rotation/slot formula to `buildSplitPassages`) for a split one. `buildMazeMarkers` (start/finish) and `buildTeleportEdges` (teleport endpoints) both resolve through it instead of `getCellCenter` directly, so a marker or teleport line on a split point visibly lands on one specific node, not the tile as a whole. Both functions still take a `Map<number, NodeDto>` (unchanged signature) — the point's other nodes needed for the slot index come from the map's own value set, which is always the full node list in every caller (unsplit callers like `GenerationRenderer` simply never have more than one node per point, so this is a no-op for them).
- Each node's color comes from `splitSlotColor` (`colorUtils.ts`) — the point's node list order (original first, then each `add_node_at` slot in creation order) indexes into `canvas.node.splitSlots` (3 explicit colors) for slots 0-2, falling back to `buildPalette` (the same rotating hue-wheel palette `RegionsRenderer` uses for components) for slot 3+.
- A one-way wall segment gets a direction-arrow marker at its own center (`drawOneWayTriangle`, colored to match), same visual language as an ordinary one-way wall passage.

Also wired into `GenerationRenderer` (own instance, `maze-web/CLAUDE.md`'s renderer-ownership rule) and `AnalyticsRenderer` (via `MazeOverlayRenderer`, the shared maze-overlay wrapper) — see `maze-web/Specs/renderer.md`'s `SplitJunctionRenderer` section. Not wired into `PresetConnectionsRenderer`: preset connections operate before generation on raw field cells with no `NodeId` concept, so there's no split-point data to draw from yet.

### Node-list duplication fix (GitHub issue #223)

`Field::all_points()` (`maze-core/src/space/mod.rs`) yields one entry per `NodeId`, not per unique point — for a split point with N nodes it repeats that point N times. `build_analytics_snapshot`'s `nodes` list (`maze-wasm/src/analytics.rs`) used to `flat_map` `nodes_at(p)` over that iterator directly, so a split point's node list appeared once per its own node count (a 2-node split point listed 4 entries instead of 2). Fixed by deduping points (first occurrence, preserving `all_points()`'s NodeId-sorted order) before the `flat_map`. The same `all_points().flat_map(nodes_at)` pattern exists in several `maze-core` repair strategies (node-pool builders) with a milder symptom (skewed random-selection probability, not visible duplication) — tracked separately, out of scope for this fix.

### Out of scope

Generator auto-split (GitHub issue #222), broader serialization work (#224) beyond this feature's own new fields, and a stateful WASM/`Maze` model for post-edit generally (a separate, much larger future conversation — `compute_analytics` stays a pure, from-scratch-rebuild function for this issue).

## Lifecycle

### On `generate()`

1. Runs WASM generation.
2. Initializes `postEditDraftEdges` via `buildPostEditDraftEdgesFromGenerated(snapshot.edges)` — detects one_way by absence of reverse edge.
3. Initializes `postEditDraftTeleports` via `extractPostEditTeleports(snapshot.edges)` — a forward+backward pair between the same two nodes collapses into one `"two_way"` entry, a lone direction becomes a `"forward"` entry; also resets `_nextPostEditTeleportId` to the value returned alongside.
4. Sets `postEditDraftMeta = { start: nodeEndpoint(snapshot.start), finish: nodeEndpoint(snapshot.finish) }` (or `null` per field when the snapshot's own is `null`) — freshly generated, so every id is real and there are no split points yet, hence plain `node` endpoints. Sets `postEditTeleportPendingFrom = null`.
5. Resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta = null`, `postEditAnalytics = null`.
6. Sets `_generatedStart`, `_generatedFinish`.
7. Resets `postEditTool` to `"wall"`.
8. Calls `confirmPostEdit()` immediately — populates `postEditEdges`, `postEditTeleportEdges`, `postEditMeta`, `postEditAnalytics`.

### On `resetPostEdit()`

1. Rebuilds `postEditDraftEdges` from `state.edges` via `buildPostEditDraftEdgesFromGenerated`.
2. Rebuilds `postEditDraftTeleports` from `state.edges` via `extractPostEditTeleports`, resetting `_nextPostEditTeleportId` and `postEditTeleportPendingFrom = null`.
3. Restores `postEditDraftMeta` from `_generatedStart`/`_generatedFinish`.
4. Resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta = null`, `postEditAnalytics = null`.
5. Resets `postEditTool` to `"wall"`.
6. Calls `confirmPostEdit()`.

### On `confirmPostEdit()`

Async, versioned via `_postEditRequestId`:

1. Increments `_postEditRequestId`.
2. Snapshots `postEditDraftEdges`, `postEditDraftTeleports` (converted to `EdgeDto[]` via `postEditTeleportsToDto`, resolving `split` endpoints through a resolver built from the *previous* confirmed node snapshot), and `postEditDraftMeta` at call time.
3. Reads `effectiveStart`/`effectiveFinish` from snapshot (falls back to `state.start/finish`, wrapped as `nodeEndpoint(...)`, when null), then resolves each to a plain id via `resolveEndpoint` — `undefined` (unresolved split endpoint) becomes `null` on the wire, not an error; the same call's `split_points` will make it resolvable on a later confirm.
4. Serializes non-wall edges to `PostEditEdgeWasmDto[]`: `basic` → `"basic"` (bidirectional in WASM); `one_way_forward`/`one_way_backward` → `"one_way"` (WASM adds only one directed edge `from→to`); each converted teleport `EdgeDto` → `"teleport"` (WASM adds one directed `EdgeKind::Teleport` edge — a two-way teleport is sent as two separate `"teleport"` entries, one per direction, not auto-expanded like `"basic"`). Each edge's `from`/`to` is sent as `PostEditEndpointWasmDto` (`toWasmEndpoint`, a trivial passthrough) — WASM resolves any `split` endpoint itself via `split_points` (see "Split Points" below).
4b. Builds `split_points: [[number, number], number][]` — a flat list of `(point, slotId)` pairs from all of `postEditDraftSplitPoints`, no sort on the JS side (Rust sorts internally).
5. Calls WASM `compute_analytics` — QC-only (runs `checks`, no repair). Always sends an empty `check_rules`: rules exist to dispatch repair strategies, and `compute_analytics` discards the `RepairEngine` it builds internally, so a rule referencing a check the caller disabled would only ever produce a spurious "inactive check" validation error for no benefit.
6. If `_postEditRequestId` changed (stale) — discards result.
7. Writes to `postEditAnalytics`, `postEditEdges` (confirmed snapshot), `postEditTeleportEdges` (confirmed snapshot, converted teleport `EdgeDto[]`), `postEditMeta` (confirmed snapshot). Auto-resets `showRouteOverlay` to `false` when `route_info == null`.

Teleport-editing actions (`addPostEditTeleport`, `cyclePostEditTeleportDirection`, `removePostEditTeleport`, `movePostEditTeleportEndpoint`) call `confirmPostEdit()` directly when `postEditAutoConfirm` is true, same as endpoint tools — the controller does not schedule an additional debounced call for these.

## Tools

| Tool | Action |
|---|---|
| `wall` | Removes both directions of edge pair from `postEditDraftEdges`. |
| `passage` | Ensures both directions exist as `"basic"` in `postEditDraftEdges`. |
| `one_way` | Toggles direction: if `fwd` exists → replace with `bwd`; otherwise → replace with `fwd`. Wall/passage not affected. |
| `reset` | Restores edge pair to original generated state (basic or one_way_forward). |
| `set_start` | Click on empty node — sets `postEditDraftMeta.start`, calls `confirmPostEdit` if `autoConfirm`. |
| `set_finish` | Click on empty node — sets `postEditDraftMeta.finish`, calls `confirmPostEdit` if `autoConfirm`. |
| `teleport_one_way` | Two-click placement of a one-way (`"forward"`) teleport link. |
| `teleport_two_way` | Two-click placement of a two-way teleport link. |

`set_start` and `set_finish` together form the vertex tools section. While either is active, drag-to-move and right-click-to-delete apply uniformly to **both** the start and finish markers, regardless of which one is currently selected: right-click on the current start node clears it (`clearPostEditEndpoint`) even while `set_finish` is active, and press-and-drag from either marker's node moves it live to whichever node is under the cursor, even while the other tool is active. Only the plain-click "assign to this empty node" action stays tied to the active tool (`set_start` assigns start, `set_finish` assigns finish).

### Teleport Tools Detail

`teleport_one_way` and `teleport_two_way` share one two-click placement state machine (mirrors `PresetConnectionsController`'s teleport handling, adapted from cell coordinates to node ids):

- **First click on an empty node, no placement pending** → `setPostEditTeleportPendingFrom(nodeId)`. A preview line follows the cursor from that node to the pointer (`PostEditRenderer.updateTeleportPreview`).
- **Second click on a different node, placement pending** → `addPostEditTeleport(pendingFrom, nodeId, direction)` where `direction` is `"two_way"` for the `teleport_two_way` tool, `"forward"` otherwise. Clears the pending state.
- **Click on the pending origin node again** → no-op (does not complete a zero-length link).
- **Escape key, or right-click with a placement pending and no marker/endpoint under the cursor** → cancels the pending placement (`setPostEditTeleportPendingFrom(null)`), clears the preview.
- **Left press-drag starting on an existing teleport endpoint's node** → arms a drag candidate (`draggingTeleportEndpoint`). Each pointer move to a different node calls `movePostEditTeleportEndpoint`; landing back on the link's other endpoint is rejected (would collapse the link to zero length) but still counts as "moved" so release doesn't misread it as a click.
- **Release without ever moving to a different node** → resolves as a plain click: if a placement is already pending, completes it at that endpoint's node; otherwise cycles that entry's direction (`cyclePostEditTeleportDirection` — `"forward"` ↔ `"backward"`; `"two_way"` entries are unaffected, they have no direction to cycle).
- **Right click on an existing teleport endpoint's node (no placement pending)** → `removePostEditTeleport(id)`.

Endpoint hit-testing is done by `pickPostEditTeleportEndpointAt` (in `postEditUtils.ts`), which resolves node id → screen position via `nodeById` before comparing to the cursor — unlike `PresetConnectionsController`'s `pickTeleportEndpointAt`, which works directly in cell coordinates since preset connections predate node ids.

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

When `postEditAutoConfirm = true`, `PostEditController` schedules `confirmPostEdit` with 300ms debounce after each edge tool click. For endpoint tools (`set_start`/`set_finish`) and teleport-editing actions (`addPostEditTeleport`, `cyclePostEditTeleportDirection`, `removePostEditTeleport`, `movePostEditTeleportEndpoint`), `confirmPostEdit` is called directly by the store action (only when `autoConfirm = true`) — controller does not schedule an additional call.

When `postEditAutoConfirm = false`:
- Edge tool clicks update `postEditDraftEdges` but do not trigger `confirmPostEdit`.
- Endpoint tool clicks update `postEditDraftMeta` but do not trigger `confirmPostEdit`.
- Teleport-editing actions update `postEditDraftTeleports` but do not trigger `confirmPostEdit`.
- `postEditEdges`, `postEditMeta`, `postEditAnalytics` remain frozen at last confirm.
- Manual Confirm button calls `confirmPostEdit()` explicitly.

Reconfirm on rule change is independent of `postEditAutoConfirm` — see "Reconfirm on QC rule changes" below; that flag only gates edge/endpoint/teleport edits.

## Reconfirm on QC rule changes

See GitHub issue #111. Editing checks/strategies/stages in the Quality panel (`Specs/quality-feature.md`) changes what `confirmPostEdit`'s own `checks` derivation (`postEditSlice.ts`, filtered from `state.rules`/`state.stages` — see "On `confirmPostEdit()`" above) would produce, but by itself does not touch `postEditDraftEdges`/`postEditDraftMeta`, so nothing triggers a recompute. `postEditAnalytics`/`issues` are left stale — still reflecting whichever ruleset was active at the last confirm — until something else calls `confirmPostEdit()`.

`MazeScene.subscribeToQualityRulesReconfirm` (`maze-web/src/pixi/MazeScene.ts`) closes this gap with two triggers, independent of `postEditAutoConfirm`:

- **Debounced reconfirm while the Quality panel is open** — any `state.rules`/`state.stages` reference change (every rule/stage-mutating store action replaces these arrays, so a reference change is a reliable "something changed" signal) while `openCard === "quality"` (re)schedules a `confirmPostEdit()` call 300ms out, same interval `PostEditController.scheduleConfirm` uses for edge edits — batches rapid edits (e.g. dragging a param slider) into one recompute instead of one per keystroke.
- **Immediate flush on leaving the Quality panel** — the moment `openCard` transitions away from `"quality"`, any pending debounce timer is cancelled and `confirmPostEdit()` is called immediately, so the report is never left stale by a pending-but-not-yet-fired debounce once the panel that could have caused the staleness closes.

Both triggers call the same `confirmPostEdit()` used everywhere else — no separate recompute path. `confirmPostEdit` is already a no-op before the first generation (`postEditDraftEdges === null`), so no extra guard against an unstarted maze is needed here.

## Canvas Renderer — PostEditRenderer

Reads from `postEditDraftEdges`, `postEditDraftTeleports`, and `postEditDraftMeta` — always shows the current working state, regardless of `autoConfirm`.

Lives in `postEditContainer` — a synced layer in `MazeScene` (not a viewport child). `TessellationRenderer` hides itself when `postEditOpen` is true.

### Layer Stack (bottom to top)

| # | Container | Content |
|---|---|---|
| 1 | `gridContainer` | `GridRenderer` — always rendered when open |
| 2 | `floorContainer` | `CellFillRenderer` — all nodes in `FLOOR_COLOR` |
| 3 | `closedCellsContainer` | `CellFillRenderer` — isolated nodes (no edges) in `WALL_COLOR` |
| 4 | `wallsContainer` | `WallRenderer` — walls and one-way arrows |
| 5 | `teleportContainer` | `TeleportRenderer` — teleport markers/line, built from `postEditDraftEdges` concatenated with `postEditDraftTeleports` (converted via `postEditTeleportsToDto`) |
| 6 | `markersContainer` | `WaypointsRenderer` — start/finish from `postEditDraftMeta` |
| 7 | `hoverContainer` | `EdgeHighlightRenderer` — hover highlight |
| 8 | `teleportPreviewContainer` | `Graphics` — pending teleport placement preview (origin marker + line to cursor), mirrors `PresetConnectionsRenderer`'s teleport preview |

Cell cache (`cachedCells`, `cachedCellSet`) is built once on open and on `activeTessellationConfig` change. Used by `PostEditController` for edge picking.

`updateTeleportPreview(pendingFrom, cursorViewportX, cursorViewportY)` takes `pendingFrom` already resolved to viewport coordinates (the controller resolves node id → screen via `nodeById` before calling in, since the renderer has no node lookup of its own) — unlike `PresetConnectionsRenderer`'s version, which takes a cell coordinate and projects it internally.

`PostEditRenderer` extends `BaseFieldRenderer` (shared with `PresetConnectionsRenderer`; see maze-web/CLAUDE.md's Feature-Renderer ownership rule — a shared base class, never a shared instance). `BaseFieldRenderer` owns the `useMazeStore.subscribe` skeleton (open/close detection, cell-cache lifecycle, `getCachedCells`/`getCachedCellSet`, `destroy`). `PostEditRenderer` implements `isCardOpen` (`openCard === "post_edit"`), `getActiveConfig` (`activeTessellationConfig`), `setRootVisible`, `redrawAll`, `clearAll`, `onStoreChange` (the draft-edges/teleports/nodes/meta comparison above, plus clearing the teleport preview when `postEditTool`/`postEditTeleportPendingFrom` changes and no placement is pending), and `destroyChildren`.

## Controller — PostEditController

Extends `BaseController` (shared with `PresetConnectionsController`). `BaseController` owns pan logic (`tryStartPan`, `handlePanMove`, `toViewport`), edge-drag bookkeeping (`beginEdgeDrag`/`continueEdgeDrag`/`endEdgeDrag`/`isDragActive` — dedupe-only, the caller's `onNewEdge` callback owns the store action and any redraw), and marker-drag bookkeeping (`draggingMarker`, `armMarkerDrag`/`releaseMarkerDrag` — the latter called automatically from `onPointerUp`). `PostEditController` adds node-map caching, edge picking, tool dispatch, confirm debounce, and teleport pending-placement/drag/cancel state (`draggingTeleportEndpoint`, `teleportDragMoved`, an ESC key listener wired in the constructor and torn down in `destroy()` — mirrors `PresetConnectionsController`).

Handles pointer events when `postEditOpen`. Node map (`Map<"x,y", NodeId[]>` — every real node at a point, GitHub issue #221) is cached per `nodes` reference — rebuilt only when `state.nodes` changes.

- **Left click + edge tool** → resolves both cells' active endpoint (`resolveActiveEndpointAt`) and calls `applyPostEditTool`, schedule confirm if `autoConfirm`.
- **Right click + edge tool** → focuses the clicked point for the "Manage split nodes" dialog (`setPostEditFocusedPoint`) instead of applying the tool — see "Split Points" above.
- **Left click + endpoint tool (`set_start`/`set_finish`), no start/finish marker under cursor** → `setPostEditEndpoint` with the point's currently active endpoint (confirm called internally by store action when `autoConfirm`); no-op if that endpoint is an unconfirmed split node.
- **Left press-drag + endpoint tool, starting on start's or finish's own node** → arms drag for that marker regardless of which endpoint tool is active; each pointer move over a new node calls `setPostEditEndpoint` again (with that cell's active endpoint) to move it live. A press that never leaves the marker's node resolves as a plain click on release (no-op, node unchanged).
- **Right click + endpoint tool, on the start or finish marker's own node** → `clearPostEditEndpoint` for that marker, regardless of which endpoint tool is active. Right-click elsewhere is a no-op for endpoint tools.
- **Teleport tools (`teleport_one_way`/`teleport_two_way`)** → see Teleport Tools Detail above.
- **Middle click** → pan viewport.

`set_start`/`set_finish`/`teleport_one_way`/`teleport_two_way` are all members of the controller's `VERTEX_TOOLS` set — they share the same node-picking pointerdown branch, dispatching to endpoint vs. teleport handling based on which tool is active and what's under the cursor (marker, teleport endpoint, or empty node).

## `buildPostEditDraftEdgesFromGenerated`

Shared function used by `_generateWithSeed` and `resetPostEdit`. Ignores `kind: "teleport"` entries entirely (see `extractPostEditTeleports` below). Detects one_way edges by absence of reverse: if `A→B` exists but `B→A` does not → `one_way_forward`. If both exist → `basic`.

## `extractPostEditTeleports`

Shared function in `postEditUtils.ts`, used by `_generateWithSeed` and `resetPostEdit` alongside `buildPostEditDraftEdgesFromGenerated`. Filters generation's `EdgeDto[]` down to `kind: "teleport"` entries and rebuilds them as `PostEditTeleportEntry[]`: a forward+backward pair between the same two nodes collapses into one `"two_way"` entry, a lone direction becomes a `"forward"` entry. Returns `{ teleports, nextId }` — `nextId` seeds `_nextPostEditTeleportId` so ids assigned afterward by `addPostEditTeleport` don't collide. Not folded into `buildPostEditDraftEdgesFromGenerated`'s `Record` output because a Teleport and a Basic edge can coexist in the same direction between the same pair — that `Record` has only one slot per `from-to` key and would drop one of the two.

## `postEditTeleportsToDto`

Shared function in `postEditUtils.ts`: `(teleports: PostEditTeleportEntry[], resolveSplit) => EdgeDto[]`. Converts `PostEditTeleportEntry[]` to `EdgeDto[]` at the WASM-call/render boundary: `"forward"` → one edge `from→to`; `"backward"` → one edge `to→from` (actual passage direction, mirrors `PresetConnectionState::TeleportBackward`); `"two_way"` → both directions. Each endpoint is resolved via `resolveEndpoint`/`resolveSplit` first — an entry with an endpoint that doesn't resolve yet (unconfirmed split node) is silently dropped. Used by `confirmPostEdit` (building the confirmed `postEditTeleportEdges` snapshot and the WASM request) and `PostEditRenderer` (building the edges fed to `TeleportRenderer`/`buildTeleportEdges`).

## `pickPostEditTeleportEndpointAt`

Shared function in `postEditUtils.ts`: `(viewportX, viewportY, cfg, teleports, nodeById, resolveSplit) => PostEditTeleportEndpointHit | null`. Hit-tests a viewport position against `PostEditTeleportEntry[]` endpoints, resolving each entry's `from`/`to` endpoint to a real node id (via `resolveEndpoint`/`resolveSplit`) then to a screen position via a `nodeById` map before comparing distance to the cursor — an endpoint that doesn't resolve yet is skipped. Mirrors `pickTeleportEndpointAt` in `fieldEditUtils.ts`, adapted for node-id space (preset connections hit-test directly in cell coordinates).

## `postEditEdgesToDto`

Shared selector in `mazeSelectors.ts`: `(postEditEdges: Record<string, PostEditEdge> | null, resolveSplit) => EdgeDto[]`. Converts to `EdgeDto[]`, filtering out `wall` entries, resolving each remaining entry's `from`/`to` endpoint (dropping the entry if either doesn't resolve yet), and mapping every remaining entry's `kind` to `"basic"` (post-edit's tool-facing distinction between `basic`/`one_way_forward`/`one_way_backward` collapses here — direction is already encoded in each entry's own `from`/`to`, and downstream consumers like `buildMazeWalls` derive one-way vs bidirectional by checking for the reverse pair, not by reading `kind`). Never returns teleport entries — those live in `postEditDraftTeleports`/`postEditTeleportEdges` and must be concatenated in by the caller (converting `postEditDraftTeleports` via `postEditTeleportsToDto` first). Used by both `PostEditRenderer` (passing `postEditDraftEdges`, concatenated with `postEditTeleportsToDto(postEditDraftTeleports, resolveSplit)`) and `AnalyticsRenderer` (passing `postEditEdges`, concatenated with `postEditTeleportEdges`, which is already `EdgeDto[]`). Both renderers build their `resolveSplit` from the confirmed node snapshot via `buildSplitNodeResolver`.

## `buildClosedCells`

Shared selector in `mazeSelectors.ts`. Finds nodes with no connected edges — rendered as `WALL_COLOR` in both `PostEditRenderer` and `GenerationRenderer`.
