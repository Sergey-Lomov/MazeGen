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

Each edge is identified by a string key derived from its two endpoints. Endpoints are ordered lexicographically by point (first by X, then by Y if X equal, then by slot — see "Split nodes" below) so that A < B always:

```
key = `${a.point[0]},${a.point[1]}${aSlotSuffix}-${b.point[0]},${b.point[1]}${bSlotSuffix}`   where A < B lexicographically
```

`canonicalize(p1, p2)` (cell-coordinate ordering, used by hit-testing/rendering) returns `[A, B]` in canonical order; `presetEdgeKey(a, b)` (`PresetEndpoint`-aware, used for the `presetConnections` map key) additionally folds in each endpoint's slot, so a slot-addressed preset on a face never collides with that face's plain (original-node) preset — see "Split nodes" below. For two endpoints with no slot on either side, `presetEdgeKey` produces the exact same string `edgeKey`/`canonicalize` always did — every pre-#231 entry's key is unchanged.

## One-way direction

`one_way_forward` means passage in direction A → B (A = canonically lesser). `one_way_backward` means B → A.

Clicking a one-way tool on an undecided or non-one-way edge sets `one_way_forward`. Clicking again on `one_way_forward` sets `one_way_backward`. Clicking again on `one_way_backward` sets `one_way_forward`. No other states are toggled this way.

## Markers

`presetStart`, `presetFinish`, and `presetGenSource` each store a single `PresetEndpoint | null` (point + optional slot — see "Split nodes" below; a plain marker with no slot addresses the point's original node). These are independent of the edge connection map. All three markers count toward the preset subtitle total and status logic.

`presetGenSource` sets where the generation algorithm starts (`preset_gen_source` field). `presetStart` sets the maze start endpoint shown after generation (`preset_start` field). The two are independent: if both are set, generation seeds from `presetGenSource` and the start marker is placed at `presetStart`. If neither is set, generation seeds from the center-nearest node and the start endpoint is assigned by the repair strategy.

## Preset teleports

Independent from the edge/marker model above. Stored as `presetTeleports: PresetTeleportEntry[]` in the store, not in the `presetConnections` map — a teleport's two endpoints aren't required to be geometrically adjacent.

```ts
interface PresetTeleportEntry {
  id: number;                 // stable identity, assigned on creation from _nextPresetTeleportId
  from: PresetEndpoint;
  to: PresetEndpoint;
  direction: "forward" | "backward" | "two_way";
}
```

`from`/`to` are the two click points in placement order, as `PresetEndpoint` (point + optional slot — see "Split nodes" below). For `"backward"`, the actual passage direction runs `to → from` (mirrors `PresetConnectionState::Teleport(TeleportDirection::Backward)` on the Rust side) — `from`/`to` themselves are never swapped after creation; only interpretation of direction changes. Dragging an endpoint to a different cell (`movePresetTeleportEndpoint`) drops any slot it previously addressed — the slot belonged to the old point, not the new one.

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

1. First LMB click on a cell (with no existing endpoint under the cursor) sets `presetTeleportPendingFrom` to that cell's `PresetEndpoint`, stamped with the *active floor at click time* (GitHub issue #357 follow-up fix — an earlier version stored only a bare `[number, number]` cell with no floor of its own, so switching floors between the two clicks silently re-stamped `from` with whichever floor was active on the *second* click, collapsing what should have been a cross-floor teleport onto one floor entirely). The renderer shows a semi-transparent marker there plus a line following the cursor (`updateTeleportPreview`).
2. Second LMB click on a different cell (on any floor, including a different one from the first click — cross-floor teleports are a deliberate multi-floor preset capability, see "Multi-floor presets" below) completes the link: `addPresetTeleport(pendingFrom, to, direction)` is called with both endpoints as `PresetEndpoint`s, each carrying its own click-time floor (`direction` is `"two_way"` for the two-way tool, `"forward"` for the one-way tool), a new entry is appended with a freshly incremented id, and `presetTeleportPendingFrom` resets to `null`.
3. Clicking the same cell *and* the same floor as the pending origin is a no-op (does not complete or cancel) — the same `(x, y)` on a *different* floor is a legitimate second endpoint, not a same-point click.
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

**Cross-floor teleports** (a placement started on one floor and completed after switching to another, `presetTeleportPendingFrom`'s own floor differing from the second click's active floor at completion time) render exactly like a generation-time cross-floor teleport (`mazeSelectors.ts`'s own `buildTeleportEdges`): the on-floor endpoint draws as a real, ordinary marker; the other (off-floor) endpoint draws as a **floor-number badge** at the grid-snapped midpoint between the two cells' centers, connected to the real marker by an ordinary connector line — not two independent, connector-less markers (an earlier, abandoned approach, see below).

`buildPresetTeleportEdges` (`PresetConnectionsRenderer.ts`) checks `t.from`/`t.to` independently against the active floor. When both are on-floor, they map straight onto the `TeleportEdge`'s own `from`/`to` (matching click-order, or swapped when `direction === "backward"`, same as the same-floor case always worked) — no badge, ordinary two-marker rendering.

When exactly one of `t.from`/`t.to` is on-floor, the departure end always maps to the returned edge's `from` and the arrival end always maps to `to` (matching the arrow's `from`→`to` = departure→arrival convention `TeleportRenderer` already relies on) — whichever of `from`/`to` is the *off-floor* end gets its screen position replaced with the grid-snapped midpoint between the on-floor cell's center and the real off-floor cell's center (`getCellCenter` + `nearestCellCoord`, same snapping `mazeSelectors.ts`'s own cross-floor branch uses, so the midpoint never lands mid-wall). `TeleportEdge.toFloor` is set (to the off-floor level) when the badge lands on `to`; `TeleportEdge.fromFloor` is set instead when the badge lands on `from` (i.e. the on-floor endpoint is the *arrival* end, so it must occupy `to`, pushing the badge onto `from`) — `TeleportRenderer.computeFloorBadges` reads both fields, keyed purely by coordinate, so a badge at either position renders identically. At most one of `toFloor`/`fromFloor` is ever set on a given edge.

Two earlier, abandoned approaches (both replaced): (1) collapsing both `from`/`to` onto the single on-floor point (`{from: [x,y], to: [x,y]}`, no badge, no connector) — each floor showed only its own on-floor endpoint as an independent marker with nothing connecting it to the other, off-image end; visually wrong once compared side-by-side with how a generation-time cross-floor teleport already renders (a real marker *plus* a badge *plus* a connector). This needed a `TeleportEdge.forceFromFilled` field to state the departure/arrival fill reading directly (since `from`/`to` were identical coordinates, the ordinary "`from` = filled, `to` = outline" comparison couldn't distinguish them) — removed once the badge-based model made `from`/`to` distinct coordinates again, restoring the ordinary reading. (2) An even earlier attempt offset the point by a small epsilon to sidestep the same-coordinate "mixed" fill-state conflict — produced a spurious near-zero-length connector and a second, barely-offset drawable point instead of one clean marker.

`redrawAll`'s own `presetTeleports` filter checks **both** `t.from.level` and `t.to.level` against the active floor (`(t.from.level ?? 0) === active || (t.to.level ?? 0) === active`), not just `t.from` — a cross-floor teleport is meant to be visible from *either* of its two floors (its own real endpoint on that floor, the other end as a badge), not only from the floor its first click happened to land on. `redrawInvalidTeleportHL`'s own invalid-teleport highlight loop follows the same "only highlight the endpoint actually on this floor" rule per-endpoint (checking each of `t.from`/`t.to` against the active level individually before drawing), for the same reason `buildPresetTeleportEdges` can't draw an off-floor endpoint's raw coordinate.

### WASM wire format

Sent as additional entries appended to `preset_connections` (not a separate field): `presetTeleportEntryToState` maps `direction` to `PresetConnectionStateDto::TeleportForward | TeleportBackward | TeleportTwoWay`. On the Rust side these become `PresetConnectionState::Teleport(TeleportDirection::{Forward,Backward,TwoWay})`, which `build_preset_state` turns into one (`Forward`/`Backward`) or two (`TwoWay`) directed `EdgeKind::Teleport` graph edges. Teleport endpoints are **not** added to `preset_connected` (unlike adjacent-cell presets) — a teleport pair isn't geometrically adjacent, so both endpoints must still go through normal generation for their regular connectivity.

### Persistence

`presetTeleports` is saved/restored in the project file (`presets.teleports`), same as connections/markers. On load, `_nextPresetTeleportId` is recomputed as `max(existing ids) + 1` (or `1` if empty) so newly created entries can't collide with restored ones. `_nextPresetTeleportId` also resets to `1` on `resetPresetConnections()`, consistent with the rest of preset state being fully cleared there.

`presetVerticalPassages`/`presetElevators` are saved/restored the same way (`presets.verticalPassages`/`presets.elevators`), with `_nextPresetVerticalPassageId`/`_nextPresetElevatorId` recomputed identically on load and reset to `1` on `resetPresetConnections()`. Both fields default to `[]` when absent from an older project file (GitHub issue #357 predates them).

## Preset vertical passages and elevators (GitHub issue #357)

Cross-floor structural connections, planted directly into the graph as `EdgeKind::VerticalPassage`/`EdgeKind::Elevator` — not a "may exist" shortcut like teleports. Stored as `presetVerticalPassages: PresetVerticalPassageEntry[]` and `presetElevators: PresetElevatorEntry[]`, flat maze-wide collections outside the `presetConnections` map, same pattern as `presetTeleports`.

```ts
interface PresetVerticalPassageEntry {
  id: number;
  from: PresetEndpoint;
  to: PresetEndpoint;
  direction: "forward" | "backward" | "two_way";
}

interface PresetElevatorEntry {
  id: number;
  floors: PresetEndpoint[];  // one endpoint per reachable floor, same (x, y), different level
}
```

Semantically distinct from preset teleports: both endpoints of a planted vertical passage/elevator edge are added to `preset_connected`/`preset_edges` on the Rust side (a guaranteed structural connection), never to `preset_teleports` (optional extra-traversable shortcuts).

### Tools

| Tool | Section | Action |
|---|---|---|
| `vertical_passage_one_way` | Vertex | Two-click placement of a one-way vertical passage (`forward`) |
| `vertical_passage_two_way` | Vertex | Two-click placement of a two-way vertical passage |
| `elevator` | Vertex | Single click sets the point, then opens the floor-picker dialog to choose which floors it reaches |

All three only appear when the maze has more than one floor (`floors.length > 1`).

### Vertical passage placement

Single click, not a two-click gesture like teleports (GitHub issue #357 follow-up — the original two-click-with-floor-switch flow visually and behaviorally read as a plain teleport, which confused what was actually a structural floor connection). Clicking a cell with `vertical_passage_one_way`/`vertical_passage_two_way` active calls `startPresetVerticalPassagePlacement(origin, tool)`:

1. Resolves which directions are actually reachable from the clicked cell — `"up"` if `(origin.level + 1)`'s own field has a cell at the same `(x, y)`, `"down"` likewise for `(origin.level - 1)` (`cellExistsAt`, `pixi/fieldEditUtils.ts`).
2. **Exactly one direction available** (the common case — e.g. the top or bottom floor) → the entry is created immediately, no dialog. `vertical_passage_two_way` creates `direction: "two_way"`; `vertical_passage_one_way` creates `direction: "forward"` (the clicked cell is always the departure end, `from`).
3. **Both directions available** → `presetVerticalPassagePending: { origin, tool, availableDirections: ["up","down"] }` is set and `PresetVerticalDirectionDialog` opens — a small `Modal` with two plain buttons, "Up"/"Down", no separate Confirm/Cancel footer; picking one commits the entry via `choosePresetVerticalPassageDirection` and closes the dialog in the same click. ESC or closing the dialog calls `cancelPresetVerticalPassagePlacement()`, discarding the pending placement.
4. **Neither direction available** (no floor above or below has a cell at that point) → no-op; the tools are hidden entirely below 2 floors, so this only guards a same-point edge case on a taller maze.

Hit-testing, drag-to-move, right-click-to-delete, and click-to-cycle-direction on an *existing* endpoint (`pickVerticalPassageEndpointAt`) are unchanged — mirror the teleport tool's own mechanics, filtered to the active floor's own endpoints (`(ep.level ?? 0) === activeLevel`) before hit-testing. A plain click (no drag) on an existing endpoint still cycles `forward ↔ backward` the same way a teleport endpoint's own click-to-cycle works.

### Elevator placement

1. Clicking the `elevator` tool on an empty cell calls `startPresetElevatorPlacement(origin)`, seeding `presetElevatorPending: { origin, floors: Set([originLevel]) }` and opening `PresetElevatorFloorDialog`.
2. The dialog lists every floor as a row, **bottom floor first** (`floors[0]` = "Floor 1" = bottom — same order `FloorSwitcher`/`CopyFloorDialog` display, achieved by iterating `floors` reversed while keeping each row's own 0-based array index for status/toggle logic). Each row shows the floor's `"{n}: {title}"` label (`n` = 1-based), a status line, and a toggle:
   - **Current** — the origin floor's own row; switch on, disabled (can't be unchecked — `togglePresetElevatorFloor` no-ops for `floorIndex === originLevel`).
   - **Available** — that floor has a cell at the elevator's own `(x, y)` point (`cellExistsAt`); switch off by default, enabled.
   - **No cell** — that floor has no cell at that point; switch off, disabled (can't be selected — silently allowing it would create a client-invalid elevator, see "Validity" below).
3. Confirm (`confirmPresetElevatorPlacement`) is disabled until at least 2 floors are selected. On confirm, one `PresetElevatorEntry` is created with one `PresetEndpoint` per selected floor — **the same `(x, y)` point on every floor**, only `level` differs.
4. Cancel (ESC, or closing the dialog) calls `cancelPresetElevatorPlacement()`, discarding the pending placement without creating an entry.

Editing an existing elevator: right-click any of its floor endpoints removes the entire entry (`removePresetElevator`). There is no drag-to-move or per-floor endpoint edit — an elevator's shape is only set at creation time.

### Validity

A vertical passage is **invalid** if either endpoint's cell is outside its own floor's field (`computeInvalidVerticalPassageIds`, same per-floor `ResolveFieldAt` resolution as teleports). An elevator is **invalid** if any of its floor endpoints is outside its own floor's field, **or** fewer than 2 of its endpoints remain resolvable (`computeInvalidElevatorIds`) — mirrors the Rust side's own "fewer than two resolved endpoints connects nothing" fallback in `build_preset_state`, so a client-invalid elevator would have been a no-op edge-wise anyway. Both count toward the combined invalid total, are excluded from `generate()`, are cleared by "Clear invalid", and get a dedicated highlight when `highlightInvalidPresets` is on.

### Rendering

Drawn by a `VerticalConnectionRenderer` instance (`PresetConnectionsRenderer.verticals`, its own `verticalContainer`, added above `teleportContainer`) — the same marker primitive `GenerationRenderer` uses for resolved `VerticalPassage`/`Elevator` edges after generation (circle marker for a vertical passage, diamond for an elevator, both in `canvas.vertical.default`, `DEFAULT_VERTICAL_STYLE`), so a preset reads identically to how the same connection looks once generated — not like a teleport. An earlier version reused `TeleportRenderer` (the same primitive preset teleports use) for this, which read as a plain teleport marker; that approach was replaced.

`buildPresetVerticalMarkers` (`PresetConnectionsRenderer.ts`) converts both collections, filtered to the active floor, into `VerticalConnectionMarker[]`: for a vertical passage, whichever endpoint is on the active floor draws its own marker, pointing `"up"`/`"down"` toward the other endpoint's floor — a **two-way** passage's marker is always filled (both ends look identical); a **one-way** passage's marker is always empty at *both* ends (`filled: false`) — only the arrow tells them apart: solid on the departure end, outline on the arrival end (mirrors `mazeSelectors.ts`'s own `buildVerticalConnectionMarkers` for the resolved post-generation graph). For an elevator, the active floor's own endpoint draws one marker, filled, with the arrow direction aggregated across every other floor in the entry (`"both"` if it reaches floors on both sides of the active one).

### WASM wire format

Sent as two separate `GenerationConfig` fields, not folded into `preset_connections`:

```ts
preset_vertical_passages: Array<{ from: PresetEndpointDto, to: PresetEndpointDto, one_way?: "forward" | "backward" }>
preset_elevators: Array<{ floors: PresetEndpointDto[] }>
```

`direction: "two_way"` maps to `one_way: undefined`; `"forward"`/`"backward"` pass through as-is (`presetVerticalPassageDirectionToDto`).

On the Rust side: `PresetVerticalPassage { from: PresetEndpoint, to: PresetEndpoint, one_way: Option<VerticalPassageDirection> }` and `PresetElevator { floors: Vec<PresetEndpoint> }`, stored in `GenerationConfig.preset_vertical_passages`/`.preset_elevators` (default `vec![]`). `build_preset_state` resolves and plants them **before** the `locked_nodes` loop, after `preset_connections`:

- Vertical passage, `one_way: None` (two-way) → both directions planted as `EdgeKind::VerticalPassage`, `PresetSetupEvent::VerticalPassageEstablished { from, to, two_way: true }` emitted.
- Vertical passage, `one_way: Some(Forward)` → only `from → to` planted, `two_way: false`.
- Vertical passage, `one_way: Some(Backward)` → only `to → from` planted (from/to swapped in the emitted event), `two_way: false`.
- An endpoint that fails to resolve silently skips the whole entry (same convention as `preset_connections`).
- Elevator → every pair among its resolvable floor endpoints gets a bidirectional `EdgeKind::Elevator` edge; fewer than 2 resolvable endpoints plants nothing. One `PresetSetupEvent::ElevatorEstablished { nodes }` is emitted per elevator, listing every resolved node.

Every node touched by either loop is added to `preset_connected`/`preset_edges` — **not** `preset_teleports`.

## Default edge state

`defaultEdgeState: "undefined" | "wall" | "passage"` controls the implicit state of all edges not explicitly set by the user. It is one maze-wide toggle, not per-floor — toggling it while any floor is active applies to every floor's edges (GitHub issue #434).

- `"undefined"` (default): no implicit state; unset edges are undecided.
- `"wall"` / `"passage"`: all interior edges without a user entry, on every floor, are populated with `source: "default"` entries of the chosen state.

When `defaultEdgeState` changes, `applyDefaultEdgeState` is called:
1. All existing `source: "default"` entries are removed, across all floors.
2. If new state is not `"undefined"`, default entries are added for all interior edges on every floor that have no `source: "user"` entry (including edges with `state: "undefined", source: "user"` — those are intentionally excluded from the default), using each floor's own field shape (`levelFieldsOf`).

Applying the `reset` tool or RMB clears the edge's user override and re-materializes it as the current default (see "Entry source" above) — it does not pin the edge as explicitly undecided.

Changing `defaultEdgeState` also triggers `_recomputeAutoLock` if auto-lock is enabled.

## Drag mode

Tools `wall`, `passage`, and `reset` support drag with LMB held. While dragging:
- `beginEdgeDrag(edgeKey)` (on `BaseController`, shared with `PostEditController`) sets `dragActive` and seeds `dragVisited` on `pointerdown`
- `continueEdgeDrag(edge, onNewEdge)` deduplicates edges within one drag session via `dragVisited: Set<string>` and invokes `onNewEdge` for each newly-entered edge; the callback applies the current tool via `applyPresetConnectionsTool` (`wall`/`passage`) or `applyPresetConnectionsToolAt("reset", ...)` (the `reset`/Clear-tool drag path, GitHub issue #433 — needs `from`/`to` to rebuild the level-aware key itself, not just the bare edge key) — the helper itself never touches the store
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
| `presetStart` | `PresetEndpoint \| null` | Start marker point (+ optional slot) |
| `presetFinish` | `PresetEndpoint \| null` | Finish marker point (+ optional slot) |
| `presetGenSource` | `PresetEndpoint \| null` | Generator start point (+ optional slot; overrides `presetStart` in WASM config) |
| `lockedNodes` | `Map<string, NodeLockKind>` | Manually locked nodes, keyed `"x,y"`/`"x,y@level"` (always the original node — see "Multi-floor presets") |
| `autoLock` | `boolean` | Whether auto-lock is enabled |
| `autoLockedNodes` | `Set<string>` | Nodes auto-locked because all their interior edges are preset |
| `highlightInvalidPresets` | `boolean` | Whether to draw the invalid highlight overlay |
| `highlightIsolatedNodes` | `boolean` | Whether to highlight nodes locked both-in-and-out with no passage |
| `showPresetOrigin` | `boolean` | Whether to show the coordinate origin crosshair |
| `presetTeleports` | `PresetTeleportEntry[]` | Preset teleport links — see "Preset teleports" |
| `presetTeleportPendingFrom` | `PresetEndpoint \| null` | First-click origin of an in-progress teleport placement, own floor included |
| `_nextPresetTeleportId` | `number` | Next id to assign to a newly created teleport entry |
| `presetVerticalPassages` | `PresetVerticalPassageEntry[]` | Preset vertical passage links — see "Preset vertical passages and elevators" |
| `presetVerticalPassagePending` | `{ origin: PresetEndpoint; tool; availableDirections: ("up"\|"down")[] } \| null` | In-progress vertical-passage placement awaiting direction-dialog confirmation (only set when both directions are available) |
| `_nextPresetVerticalPassageId` | `number` | Next id to assign to a newly created vertical passage entry |
| `presetElevators` | `PresetElevatorEntry[]` | Preset elevator links — see "Preset vertical passages and elevators" |
| `presetElevatorPending` | `{ origin: PresetEndpoint; floors: Set<number> } \| null` | In-progress elevator placement awaiting floor-picker confirmation |
| `_nextPresetElevatorId` | `number` | Next id to assign to a newly created elevator entry |
| `presetSplitPoints` | `Record<string, number[]>` | Declared split-node slotIds per point — see "Split nodes" |
| `presetActiveSplitNode` | `Record<string, PresetEndpoint>` | Which node of a point new preset entries currently target — see "Split nodes" |
| `presetFocusedPoint` | `[number, number] \| null` | Point currently selected for "Manage split nodes" |

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
| `vertical_passage_one_way` | Vertex | Two-click placement of a one-way vertical passage — see "Preset vertical passages and elevators" |
| `vertical_passage_two_way` | Vertex | Two-click placement of a two-way vertical passage — see "Preset vertical passages and elevators" |
| `elevator` | Vertex | Click a point, then pick reachable floors in a dialog — see "Preset vertical passages and elevators" |
| `lock_in` | Generation | Locks node to block incoming edges |
| `lock_out` | Generation | Locks node to block outgoing edges |
| `full_lock` | Generation | Locks node both in and out (`"both"`) |
| `gen_source` | Generation | Toggles `presetGenSource` on clicked cell (click same cell to clear) |
| `manage_split_nodes` | Vertex | Left-click any in-field point to open "Manage split nodes" for it — see "Split nodes" above |

Right-click on an edge clears its user override and re-materializes it as the current default (same as the `reset` tool — see "Entry source" above), for any tool that falls through to edge picking (i.e. not `set_start`/`set_finish`/`gen_source`/lock/teleport/`manage_split_nodes` tools, each of which gives right-click its own tool-specific meaning — see their rows above). Dispatched via `applyPresetConnectionsToolAt("reset", edge.key, edge.from, edge.to)` — `edge.from`/`edge.to` (plain cell coords from `pickEdgeAtPosition`) are what `applyTool` actually keys off via `presetEdgeKey`/`activeFloorLevel`; the passed `edge.key` is a floor-0-only geometric hint, ignored by `applyTool` on any floor above the first (GitHub issue #433 — the pre-fix code passed only that bare key, so RMB reset silently no-opped on floor 1+).

## Node locking

`lockedNodes: Map<"x,y", NodeLockKind>` stores explicitly locked nodes. `NodeLockKind` is `"in" | "out" | "both"`.

`autoLockedNodes: Set<"x,y">` is recomputed whenever `presetConnections` changes (if `autoLock` is enabled). A node is auto-locked when all its interior edges have a preset entry with `state !== "undefined"`. Edges with `state: "undefined"` are treated as undecided and prevent auto-lock. Auto-locked nodes always use `"both"` kind.

For a declared split point (see "Split nodes" below), auto-lock checks **every one of its nodes** (the original node plus each declared slot), not just the original's own edges — `computeAutoLockedNodes` takes an extra `presetSplitPoints` parameter for this. A point auto-locks only once every one of its nodes has every interior face decided; one node with an undecided/missing face on any side keeps the whole point unlocked, even if another of its nodes already has all its own faces decided.

Both sets are merged when rendering (`buildLocks`) and when checking for isolated nodes (`buildIsolatedCellHighlights`).

**Isolated node**: a node locked `"both"` (manually or via auto-lock) with no non-wall preset on any of its edges. The UI shows a warning and highlights such cells.

## Card status

| Status | Condition (priority order) |
|---|---|
| `unavailable` | Field not ready |
| `warning` | Field ready, `computeInvalidKeys(...).size + computeInvalidTeleportIds(...).size + invalidMarkerCount + computeInvalidSplitPoints(...).size > 0` |
| `set` | Field ready, no invalids, `presetConnections.size + markerCount > 0` |
| `set-default` | Field ready, no invalids, nothing set |

`markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0)`. `presetGenSource` is not counted here.

Subtitle: `"N preset(s)"` or `"N preset(s) · ⚠ M invalid"` where `N = presetConnections.size + markerCount + presetTeleports.length + presetVerticalPassages.length + presetElevators.length`. The invalid count `M` combines invalid edge presets, invalid teleports, invalid vertical passages/elevators, and invalid start/finish markers (`computeInvalidKeys(...).size + computeInvalidTeleportIds(...).size + computeInvalidVerticalPassageIds(...).size + computeInvalidElevatorIds(...).size + invalidMarkerCount`); "Clear invalid" removes all these kinds together.

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
5. Accept the closest remaining edge within `threshold = TILE_SIZE * 0.4` (squares/hexes) or `TRI_TILE_SIZE * 0.12` (triangles — kept well under the incenter-to-side distance `≈ 0.29 * side`, so a triangle cell's own centroid never falls inside the edge-hit zone; a wider ratio tuned for squares made every dead-center triangle click misread as an edge click, GitHub issue #340 follow-up)

`deadZone` defaults to `false` and is passed `true` only from `onPointerMove` (hover + drag-continuation) in both `PresetConnectionsController` and `PostEditController`; `onPointerDown` (plain click) calls omit it, so a single click can still hit an edge whose nearest point is close to a vertex.

Accepts an optional pre-built `cellSet` to avoid rebuilding on every pointer event (passed from `PresetConnectionsRenderer.getCachedCellSet()`).

## Split nodes (GitHub issue #231)

A tessellation point can resolve to more than one graph node ("split point" — see `Specs/space.md`/epic #218). Preset connections, teleports, locks, and markers can address a specific one of a split point's extra nodes, not just its original node — the same `{point, slotId}` addressing post-edit's split-node feature already uses (see `Specs/post-edit.md`), adapted for the pre-generation stage.

### `PresetEndpoint`

```ts
interface PresetEndpoint {
  point: [number, number];
  slotId?: number;   // absent = the point's original node
  level?: number;    // absent = floor 0 — see "Multi-floor presets" below
}
```

Used everywhere a preset previously stored a bare cell tuple: `PresetConnectionEntry.from`/`.to`, `PresetTeleportEntry.from`/`.to`, `presetStart`/`presetFinish`/`presetGenSource`. **No slot means the original node only** — this is a deliberate narrowing from the pre-#231 behavior, where a preset with no split-node concept applied to *every* node at a point (see `maze-core`'s `build_preset_state`, GitHub issue #219/#220). A preset explicitly addressing a declared slot now resolves to exactly that node.

`lockedNodes` (the `Map<string, NodeLockKind>` powering the lock tools) is keyed the same way every other preset collection now is (`"x,y"` or `"x,y@level"`, see "Multi-floor presets" below) — locks always address the original node only; there is no lock-tool UI for addressing a specific slot.

## Multi-floor presets (GitHub issue #340)

Every preset tool (walls/passages/one-way, teleports, start/finish/gen-source markers, locks, split points) works on any floor. There is **no per-floor preset storage** — `presetConnections`, `presetTeleports`, `lockedNodes`, `presetSplitPoints`, `presetActiveSplitNode` each remain one flat, maze-wide collection, exactly as before this issue. A preset's floor lives entirely inside its own `PresetEndpoint.level` (or, for the string-keyed collections below, an `"@level"` key suffix) — not in which per-floor bucket it's filed under.

This is a deliberate choice over a per-floor bucket model: folding floor identity into the endpoint's own coordinate `(x, y, level)` means a single entry can in principle span two floors (a future vertical-passage/elevator edge) without an ownership question about which floor's bucket it would belong to.

**`level` convention** — 0-based index into `floors`/`level_fields`/`levels_ordered()`, `undefined` meaning floor 0. This is the same "undefined = default" pattern `slotId` already uses. A pre-#340 single-floor project has every `level` absent, so its serialized shape and every derived key are byte-identical to before this issue.

**Key suffix convention** for the string-keyed collections (`lockedNodes`, `presetSplitPoints`, `presetActiveSplitNode`): `"x,y"` for floor 0, `"x,y@level"` otherwise — built by `presetEndpointKey`/`pointKey` (`pixi/splitPointsCore.ts`) and parsed back by `computeInvalidSplitPoints`/`generateConfigBuilder.ts`. `presetEdgeKey(a, b)` (the `presetConnections` map key) sorts its canonical pair by `level` first, then by point — a same-floor pair (the overwhelming majority) produces the exact same key it always did.

**Stamping on write** — every store action that creates a new `PresetEndpoint` (edge tools, teleport placement, lock tools, gen-source, split-node declaration) stamps `activeFloorLevel(state)` onto it — the array index of `state.activeFloorId` within `state.floors` (`storeHelpers.ts`), `undefined` for floor 0. A user editing floor 2 only ever creates/targets entries whose `level` resolves to floor 2.

**Renderer/controller scoping** — `PresetConnectionsRenderer`/`PresetConnectionsController` filter the flat, maze-wide collections down to the active floor's own entries at the render/hit-test boundary (`presetConnectionsOnLevel`, `recordOnLevel`, `mapOnLevel`, `setOnLevel`, `teleportsOnLevel` in `fieldEditUtils.ts`/`PresetConnectionsController.ts`), stripping the `@level` key suffix before handing off to the underlying rendering functions (`presetSelectors.ts`), which remain level-agnostic and operate on single-floor-shaped data exactly as before.

**"Manage split nodes" dialog** (`PresetSplitNodesDialog.tsx`) reads `activeFloorLevel(state)` once and stamps it onto every `PresetEndpoint`/split-point key it builds or resolves (the point key, `originalEndpoint`, each slot row's endpoint, and every `resolvePresetActiveEndpoint` call for a neighbor face) — opening the dialog on floor 2 only ever reads/writes floor 2's own split-point declarations, never floor 0's.

**Validity checking** — every invalidity check (`computeInvalidKeys`, `computeInvalidTeleportIds`, `computeInvalidMarkers`, `computeInvalidSplitPoints`) resolves an entry's own field against its own floor, not the active floor, via `ResolveFieldAt = (level) => { cfg, customPoints? } | undefined` (each floor has an independent field shape per GitHub issue #338). `computeAutoLockedNodes` similarly takes `LevelField[]` (one `{ level, cfg, customPoints? }` per floor) and walks every floor's own edges when deciding which nodes auto-lock.

**Generation** — `buildValidPresetConnections`/`buildGenerateConfig` (`generateConfigBuilder.ts`) send every floor's presets, level tags intact — the Rust side resolves each `PresetEndpoint.level` against the matching `levels_ordered()` entry (see "WASM wire format" below). **Post-edit is floor-aware as of GitHub issue #358** (see `Specs/floors.md`'s "Post-edit multi-floor awareness") — `buildValidPresetConnections(state, false)` sends every floor's presets for that call site too, and `preset_split_points` carries each entry's own `level` (parsed from its `"@level"`-suffixed key) in the wire payload. `compute_analytics` itself (the WASM call `confirmPostEdit` drives) is genuinely multi-level as of GitHub issue #359 (see `Specs/floors.md`'s "`compute_analytics` multi-level awareness") — a preset whose endpoint shares an (x, y) with another floor's own point now resolves against its own floor's node, not the wrong one.

**Floor reorder/removal** (`floorsSlice.ts`) — `level` is a *positional* index into `floors`, not a stable id, so both mutating actions remap every preset's `level` to keep it pointing at the same floor:
- `moveFloor` swaps two floors' array positions; `remapPresetLevelsOnFloorSwap` (`storeHelpers.ts`) rewrites every preset's `level` through that swap (floor 0 round-trips through `undefined`↔`0` correctly when it's one of the two swapped).
- `removeFloor` deletes one floor and shifts every floor above it down by one index; `dropPresetLevelOnFloorRemove` (`storeHelpers.ts`) drops every preset entry that named the removed floor (it has nowhere to go) and shifts every remaining entry's `level` down by one to track its floor's new position — mirrors how `removeFloor` already deletes the removed floor id's own `FloorFieldConfig` entry.

Both remaps rebuild `presetConnections`' map keys (via `presetEdgeKey`) and every `"@level"`-suffixed string key, then recompute `autoLockedNodes` against the mutated state — a stale key or a `level` still pointing at a since-shifted floor would otherwise silently misattribute a preset to the wrong floor without any invalidity signal (the entry would just look valid on the wrong floor, not invalid).

### Declaring split points

`presetSplitPoints: Record<string, number[]>` (keyed `"x,y"`, values are that point's declared slotIds) mirrors post-edit's `postEditDraftSplitPoints` exactly — same slot-minting rule (`max(existing)+1`, or `0` if none yet), same per-point-only uniqueness. `presetActiveSplitNode: Record<string, PresetEndpoint>` mirrors `postEditActiveSplitNode` — which node of a point new preset entries on that point's faces currently target; absence means the original node.

The shared, endpoint-type-agnostic slot-list bookkeeping (`addSlot`/`removeSlot`/`cycleActive`/`setActive`) lives in `pixi/splitPointsCore.ts`, used by both this feature and post-edit's own split-node actions — see that module's doc comment and `Specs/post-edit.md`.

**`manage_split_nodes` tool** (`PresetConnectionTool`): left-click on any in-field point opens the "Manage split nodes" panel for that point (`presetFocusedPoint`), reusing the same `SidePanel`-docked shape as post-edit's — see `Specs/post-edit.md`'s "Split Points" section for the UI description (add/remove/set-active affordances, one card per node, fixed footer, diagnostics warnings strip). The preset-stage adapter (`PresetSplitNodesDialog`) has no `NodeId`/confirmed-snapshot concept to resolve against (presets run before generation) — a card's "links" are built directly from `presetConnections`/`presetTeleports`, comparing endpoints structurally (`presetEndpointsEqual`), not resolved ids.

Hovering a link bubble sets `presetHoveredLink: { from: PresetEndpoint; to: PresetEndpoint } | null`, highlighting that specific connection on the canvas via `PresetConnectionsRenderer`'s `linkHover` layer (`buildLinkHoverHighlight`, `pixi/selectors/presetSelectors.ts`) — same `NodeEdgeHighlightRenderer` primitive post-edit's own `postEditHoveredLink` uses (GitHub issue #237). Unlike post-edit's variant (which resolves through `NodeDto`/`NodeId` to each node's real hub point when the point is split), the preset variant deliberately draws from each endpoint's plain cell center regardless of `slotId` — presets have no confirmed-snapshot node list to resolve a hub position against, and the highlight only needs to say "these two cells", not distinguish which of a split point's several nodes.

Removing a split node (`removePresetSplitNode`) is rejected if it's currently assigned as `presetStart`/`presetFinish`/`presetGenSource` (same "reassign first" guard post-edit's `removeSplitNode` uses for start/finish); otherwise it strips every `presetConnections`/`presetTeleports` entry referencing that node.

**Orphan slots are not auto-removed.** A declared slot with nothing referencing it is created anyway at generation time (see "Applying split points" below) and surfaces as a dedicated warning in the Preset Connections panel (`orphanSplitCount`, same `warningBubble` style as the isolated-nodes warning) — informational only, does not block generation.

### Rendering

A declared split point's faces render as colored per-slot passages, the same visual `PostEditRenderer`/`GenerationRenderer`/`MazeOverlayRenderer` already use for resolved split nodes (GitHub issue #223) — `buildSplitPassages` (`pixi/selectors/mazeSelectors.ts`) was generalized into `buildSplitPassagesCore<Id>`, parameterized over an opaque comparable id instead of a `NodeDto`'s numeric `NodeId`, so the same geometric algorithm (dividing a shared face among connected nodes, straightening 2-face connectors, hub-point fan-out for other counts) doesn't need a second implementation. `buildPresetSplitPassages` (`pixi/selectors/presetSelectors.ts`) is the preset-stage instantiation: identity is `presetEndpointKey` (a string) instead of a `NodeId`; nodes are assembled from `presetSplitPoints` plus every in-field geometric neighbor of a declared split point (including that neighbor's own declared slots, if it's itself split) — registering every geometric neighbor, not just ones some `presetConnections` entry already references, is what lets an undeclared face read as optional instead of vanishing entirely. `PresetConnectionsRenderer` draws the result via the same `SplitJunctionRenderer` class, and `buildPresetWallGroups` excludes a declared split point's own faces from its ordinary wall/undecided reading (mirrors `buildMazeWalls`'s `splitPointKeys` exclusion) so the two renderings never overlap.

**Per-node face kind.** Every face of every one of a split point's nodes always has one of `"wall" | "passage" | "one_way_out" | "one_way_in" | "undefined"` — there is no separate "no decision yet" state; presets default an undecided face to `"undefined"` (optional/tentative), while post-edit defaults to `"wall"` (its dialog has no optional-connection concept). `"wall"` is explicit only when a `presetConnections` entry actually has `state: "wall"` for that specific node pair (tracked via a `wallPairs` set, since core's directed-pair model only encodes actual passages) — a plain undecided face with no entry at all reads as the stage's own default, not `"wall"`. `"undefined"` shares/connectors render desaturated (`disabledOf`/`disabledOfNumber`) instead of the node's normal color, both in the canvas (`SplitJunctionRenderer`) and the panel's tile diagram (`TileFaceEditor`).

**Resolving the real partner.** When the neighbor across a face is itself split, several of its nodes can each have an independent connection across that same face — `buildSplitPassagesCore` resolves each node's *specific* partner (checking every neighbor-point node for a matching entry, falling back to the neighbor's first node only if none matches) rather than assuming a single "the" neighbor node per face; the latter would check a node's decided state against the wrong neighbor whenever its real partner isn't that neighbor point's first node. A directed (`passage`/one-way) match always wins over a `wall` match regardless of which candidate is checked first (GitHub issue #243 follow-up): a blueprint apply explicitly walls off every neighbor candidate its resolved partner didn't pick, so the first candidate found with an explicit `wall` isn't necessarily the real connecting node — a later candidate might still hold the real passage. Only falls back to a `wall` match if no candidate has a directed entry at all. The same partner-resolution rule (with the same wall/passage priority) is used on the write side too, by `resolvePresetPartnerAt`/`resolvePostEditPartnerAt` in `applyPresetSplitBlueprint`/`applySplitBlueprint` (see `Specs/split-blueprints.md`) and by the "Manage split nodes" panel's own tile diagram (`PresetSplitNodesDialog`'s `facesOf`) — all three must resolve a split neighbor's real connecting node consistently, not just the renderer.

**All-nodes-wall.** A face where every one of a point's nodes explicitly has `"wall"` renders as one plain solid wall spanning the whole face (`SplitPassagesResult.wallFaces`, same color as an ordinary non-split wall) instead of per-node segments — it isn't attributable to any single node's color.

The shared geometric algorithm (face division among connected nodes, hub-point fan-out, the 2-passage straightening exception, active-node z-order, one-way arrow placement on the connector rather than the along-face segment) lives in `pixi/splitFaceLayout.ts`, used by both `buildSplitPassagesCore` (canvas) and `TileFaceEditor` (the "Manage split nodes" panel's tile diagram) so the two never drift apart.

**Panel link sections.** Each node's card in "Manage split nodes" groups its links into three sections: **Required** (a decided passage/one-way — the connection *will* exist), **Undefined** (preset's optional/undecided faces — *may* exist, not forced either way; always empty for post-edit, which has no such concept), **Forbidden** (`wall` — this node's face is explicitly closed here). An empty section shows a dash placeholder.

### Invalidity

A fourth invalidity check, `computeInvalidSplitPoints`, applies the same "point outside the current field" criterion `computeInvalidKeys`/`computeInvalidTeleportIds`/`computeInvalidMarkers` already use, to `presetSplitPoints`'s keys. Needed separately because an orphan slot has no referencing preset/teleport/marker to be caught invalid through. Folded into "Clear invalid" and the combined invalid count alongside the other three categories. `generateConfigBuilder.ts` filters `split_points` through it before building the wire payload — the Rust side is guaranteed never to see a `split_points` entry for a point outside the field (see "Applying split points" below for what would happen if it did).

### Applying split points (Rust side)

`GenerationConfig.split_points: Vec<((i32,i32), u32)>` carries every declared `(point, slotId)` pair. `build_preset_state` (`maze-core/src/generation/preset_state.rs`) applies all of them via `Field::add_node_at`, in `(point, slotId)`-sorted order, in one pass **before** resolving any preset connection/lock/marker — mirrors `apply_split_points` (`maze-wasm/src/analytics.rs`), which does the same for post-edit's split nodes. The resulting `(point, slotId) -> NodeId` map is kept on `PresetState` (`resolve_endpoint`) so `preset_start`/`preset_finish`/`preset_gen_source` can be resolved against the exact same split nodes after the fact, without re-deriving the resolution logic.

Every `PresetEndpoint` resolves to exactly one `NodeId`: `slotId: None` → the point's original node (`Field::nodes_at(point)[0]`); `slotId: Some(s)` → the node `add_node_at` created for `s` (index `1 + s's position in that point's sorted declared-slot list`). An endpoint that can't resolve (unknown point, or a slot never declared) is silently skipped, same as the pre-#231 "point out of bounds" skip — `build_preset_state` returns `Err` only for a `split_points` entry itself referencing an unknown point (guarded against by client-side filtering via `computeInvalidSplitPoints`, but not assumed — `Field::add_node_at` panics on an unknown point, so this is checked explicitly rather than relying on the caller).

## WASM wire format

`generate()` sends only valid presets:

```ts
preset_connections: Array<{ from: PresetEndpointDto, to: PresetEndpointDto, state: PresetConnectionState }>
preset_start?: PresetEndpointDto       // explicit start endpoint (presetStart)
preset_finish?: PresetEndpointDto
preset_gen_source?: PresetEndpointDto  // generation algorithm seed (presetGenSource)
locked_nodes: Array<{ point: PresetEndpointDto, kind: NodeLockKind }>
split_points: Array<[[number, number], number, number]>  // declared (point, slotId, level) triples — see "Split nodes" above and "Multi-floor presets"
preset_vertical_passages: Array<{ from: PresetEndpointDto, to: PresetEndpointDto, one_way?: "forward" | "backward" }>  // GitHub issue #357 — see "Preset vertical passages and elevators"
preset_elevators: Array<{ floors: PresetEndpointDto[] }>  // GitHub issue #357

interface PresetEndpointDto {
  point: [number, number];
  slot?: number;
  level?: number;  // GitHub issue #340 — 0-based levels_ordered() index, absent = floor 0
}
```

Filtered by `computeInvalidKeys`/`computeInvalidTeleportIds`/`computeInvalidMarkers`/`computeInvalidSplitPoints` before building the payload. Invalid entries are silently dropped. `lockedNodes` and `autoLockedNodes` are merged before sending.

On the Rust side: `PresetConnectionDto`/`PresetEndpointDto` with `#[derive(Deserialize)]`; `PresetConnectionState` enum; stored in `GenerationConfig.preset_connections: Vec<PresetConnection>` (each endpoint a `PresetEndpoint { point: (i32,i32), slot: Option<u32>, level: Option<u32> }`). Default is `vec![]`. `PresetState::resolve_endpoint` (`maze-core/src/generation/preset_state.rs`) resolves `endpoint.level.unwrap_or(0)` against `MultiLevelField::levels_ordered()` to find the real `LevelId` before resolving the point/slot within that level — an unknown level index fails `apply_split_points`/`build_preset_state` with an error rather than silently resolving against the wrong floor.

**Breaking wire-format change (GitHub issue #231):** `PresetConnection.from`/`.to`, `LockedNode.point`, and `preset_start`/`preset_finish`/`preset_gen_source` changed from a bare `(i32,i32)`/`[i32;2]` to the `{point, slot}` object above — an intentional, non-backward-compatible change, not a migration. Project files and `maze-runner` fixtures predating this issue that use the old flat-tuple shape in these fields no longer parse.

## Cell inspector (GitHub issue #353)

The hover status bar shared by every maze-bearing card (`HoverInfoPanel`) also works on this card, via a separate preset-stage selector (`buildPresetCellInspection`, `pixi/selectors/presetCellInspection.ts`) — Preset Connections has no `NodeDto`/`EdgeDto` graph yet, so it cannot go through the generic post-generation inspector (`buildCellInspection`, `pixi/selectors/mazeSelectors/cellInspection.ts`); `cellInspectionResolver.ts`'s `resolveCellInspection` branches on `openCard === "preset_connections"` before falling through to the generic path.

Same output conventions as the post-generation inspector: bare `"x:N, y:N"` for an empty cell, `" | "`-joined marker lines for a plain node, `"[Node N: ...]"` blocks (`"; "`-joined lines inside) for a split point — `N` is 1-based, original node first then declared slots by ascending `slotId` (`allNodesAt`'s own order, the preset-stage analogue of `NodeDto.i + 1`).

Marker lines shown per node (exact `PresetEndpoint` match via `presetEndpointsEqual`):
- `Start` / `Finish` / `Gen source` — `presetStart`/`presetFinish`/`presetGenSource`
- `Teleport <arrow> (target)` — from `presetTeleports`, direction arrow (`<->`/`->`/`<-`) same convention as post-generation; cross-floor target shows the floor label (`L{n}`), same-floor shows coordinates
- `Vertical passage <arrow> (L{n})` — from `presetVerticalPassages`, always floor-label target
- `Elevator (L{a}, L{b}, ...)` — from `presetElevators`, no arrow (always bidirectional), sorted/deduped floor list
- `Lock (in|out|both)` — from merged `lockedNodes`/`autoLockedNodes` (`"both"` for an auto-locked node), reported **only on the point's original node** (`slotId === undefined`) even for a split point, since locks always address the original node only

## Lifecycle

| Event | Effect |
|---|---|
| Tessellation confirmed (kind changes) | `presetConnections` cleared, markers cleared, `defaultEdgeState` reset |
| `resetPresetConnections()` | Same as above, plus `presetTeleports`/`presetVerticalPassages`/`presetElevators` cleared and their id counters reset to `1` |
| Field cells added/removed | Connections stay; invalidity recomputed from field |
| Card opens | Renderer subscribes, cell cache built |
| Card closes | Renderer clears graphics; `highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` |
| Generate | Invalid connections filtered out, valid ones sent to WASM |
| `defaultEdgeState` changes | All `source:"default"` entries removed and repopulated; auto-lock recomputed |
