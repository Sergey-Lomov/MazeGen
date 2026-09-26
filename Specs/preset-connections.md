# Preset Connections

Allows pre-configuring edge states (walls, passages, one-way links), node locks, and start/finish/gen-source markers before generation. Active only after tessellation and field are confirmed.

The preset management panel's **Show locks** toggle controls only the canvas visualization of manual and auto-generated lock/blocker markers. It does not change the stored locks, generated maze behavior, or lock markers' hit-testing. The setting is persisted with the project and defaults to enabled; split-node locks follow the same toggle. While any lock tool is selected (`Lock In`, `Lock Out`, or `Full Lock`), the toggle is disabled and lock markers are forced visible.

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
- `"default"` — injected automatically by the active `defaultEdgeState`

Applying the `reset` tool or RMB stores `{ state: "undefined", source: "user" }`. This explicit
assignment remains undecided regardless of `defaultEdgeState` and appears in the entity-delete
picker. Removing it restores the current default (or removes the map entry when that default is
`"undefined"`).

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

Both live in the single Tools section (GitHub issue #456 — see "## Tools" below), alongside `set_start`/`set_finish`. Selecting either teleport tool clears any in-progress placement (`presetTeleportPendingFrom` reset to `null`) — see `setPresetConnectionsTool`.

### Shared vertex editing mode

All four vertex tools (`set_start`, `set_finish`, `teleport_one_way`, `teleport_two_way`) share one editing mode: whichever vertex tool is active, drag-to-move and right-click-to-delete apply uniformly to the start marker, the finish marker, and every teleport endpoint — not just the element type matching the active tool.

- **Left press-drag starting on the start marker's cell**, while any vertex tool is active → moves the start marker. Live preview only (`presetDragOverride`'s `marker` variant, GitHub issue #613): the pointermove handler writes the drag's current cell to `presetDragOverride` instead of calling `setPresetStart` on every move — `PresetConnectionsRenderer` substitutes it in place of the committed `presetStart` while it's set. Nothing is written to `presetStart` until pointerup, and only if the cursor actually left the origin cell; a plain click that never moved stays a no-op.
- **Left press-drag starting on the finish marker's cell**, while any vertex tool is active → moves the finish marker the same way, via `presetDragOverride`/`setPresetFinish` on release.
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
- get a dedicated invalid-cell fill (`CellFillRenderer`, `canvas.preset.invalid`) when `highlightInvalidPresets` is on

A teleport is **invalid** if either endpoint is outside the current field (`computeInvalidTeleportIds`, same field-resolution logic as `computeInvalidKeys`). Invalid teleports:
- count toward the combined invalid total shown in the UI (`invalidKeys.size + invalidTeleportIds.size`)
- are excluded from `generate()`
- are removed by "Clear invalid" alongside invalid edge presets
- get a dedicated invalid-cell fill at each visible endpoint (`CellFillRenderer`, `canvas.preset.invalid`) when `highlightInvalidPresets` is on; point invalidity is never represented by a square or circle outline

`presetGenSource` and explicit `lockedNodes` use the same per-floor field-membership rule. They are included in the invalid total and removed by "Clear invalid" when outside the field. The canvas controller accepts new start, finish, generation-source, and lock placements only when the clicked cell belongs to the active floor's field; existing invalid values remain loadable so they can be highlighted or cleared.

### Rendering (`TeleportRenderer`)

Each teleport draws as a connecting line plus one marker per endpoint, in the marker shape from `DEFAULT_MAZE_RENDER_STYLE.teleport` (`diamond` by default, not literally a square):
- **Two-way**: both endpoints filled solid.
- **One-way**: origin (`from`, or `to` if `direction: "backward"`) filled solid; destination outlined only.
- **Half-filled marker**: when a cell is the landing point for markers from *different* teleport entries that disagree — i.e. at least one entry wants a filled square there and at least one wants an outline square there — that cell draws as a diagonally-split square instead of a plain filled/outline one. Computed by the pure `computeMixedCells(edges): Set<string>` (coordKey-encoded), unit-tested in `TeleportRenderer.test.ts` independently of the Pixi drawing code.
The connecting line stops at each endpoint marker's border rather than running to its center: the clip distance along the line's direction is the square's Chebyshev border distance (`half / max(|ux|, |uy|)`) plus half the line's stroke width, compensating for the round line cap extending past its geometric endpoint. Computed by the pure `clipDistance(ux, uy, half, strokeWidth)`, unit-tested in `TeleportRenderer.test.ts`.

Preview line/marker for an in-progress placement is drawn separately by `PresetConnectionsRenderer.updateTeleportPreview` via the shared `drawTeleportPreview` helper (`pixi/renderers/teleportPreviewGlyph.ts`, also used by `PostEditRenderer.updateTeleportPreview` — see `Specs/post-edit.md`), at 50% alpha. The preview marker uses the real `DEFAULT_MAZE_RENDER_STYLE.teleport` shape / size / corner style / border / gap ring (not a hardcoded square — that was the pre-#456 look in both renderers). The connector line clips to the marker's full outer footprint (`size*TILE_SIZE + borderWidth + edgeGapWidth`, the same radius `TeleportRenderer`'s own connector routing avoids), plus half the stroke width, via `clipDistance`. Unit-tested in `teleportPreviewGlyph.test.ts`.

**Cross-floor teleports** (a placement started on one floor and completed after switching to another, `presetTeleportPendingFrom`'s own floor differing from the second click's active floor at completion time) render exactly like a generation-time cross-floor teleport (`mazeSelectors.ts`'s own `buildTeleportEdges`): the on-floor endpoint draws as a real, ordinary marker; the other (off-floor) endpoint draws as a **floor-number badge** at the grid-snapped midpoint between the two cells' centers, connected to the real marker by an ordinary connector line — not two independent, connector-less markers (an earlier, abandoned approach, see below).

`buildPresetTeleportEdges` (`PresetConnectionsRenderer.ts`) checks `t.from`/`t.to` independently against the active floor. When both are on-floor, they map straight onto the `TeleportEdge`'s own `from`/`to` (matching click-order, or swapped when `direction === "backward"`, same as the same-floor case always worked) — no badge, ordinary two-marker rendering.

When exactly one of `t.from`/`t.to` is on-floor, the departure end always maps to the returned edge's `from` and the arrival end always maps to `to` (matching the arrow's `from`→`to` = departure→arrival convention `TeleportRenderer` already relies on) — whichever of `from`/`to` is the *off-floor* end gets its screen position replaced with the grid-snapped midpoint between the on-floor cell's center and the real off-floor cell's center (`getCellCenter` + `nearestCellCoord`, same snapping `mazeSelectors.ts`'s own cross-floor branch uses, so the midpoint never lands mid-wall). `TeleportEdge.toFloor` is set (to the off-floor level) when the badge lands on `to`; `TeleportEdge.fromFloor` is set instead when the badge lands on `from` (i.e. the on-floor endpoint is the *arrival* end, so it must occupy `to`, pushing the badge onto `from`) — `TeleportRenderer.computeFloorBadges` reads both fields, keyed purely by coordinate, so a badge at either position renders identically. At most one of `toFloor`/`fromFloor` is ever set on a given edge.

Two earlier, abandoned approaches (both replaced): (1) collapsing both `from`/`to` onto the single on-floor point (`{from: [x,y], to: [x,y]}`, no badge, no connector) — each floor showed only its own on-floor endpoint as an independent marker with nothing connecting it to the other, off-image end; visually wrong once compared side-by-side with how a generation-time cross-floor teleport already renders (a real marker *plus* a badge *plus* a connector). This needed a `TeleportEdge.forceFromFilled` field to state the departure/arrival fill reading directly (since `from`/`to` were identical coordinates, the ordinary "`from` = filled, `to` = outline" comparison couldn't distinguish them) — removed once the badge-based model made `from`/`to` distinct coordinates again, restoring the ordinary reading. (2) An even earlier attempt offset the point by a small epsilon to sidestep the same-coordinate "mixed" fill-state conflict — produced a spurious near-zero-length connector and a second, barely-offset drawable point instead of one clean marker.

**Badge collision relocation (GitHub issue #480)** is shared with the generation view: `redrawAll` builds `buildPresetTeleportBadgeBlockedCells(...)` (preset start/finish, split-point cells, vertical-passage/elevator/teleport endpoints, per floor) from the *maze-wide* preset lists once and passes it, plus the *unfiltered* `state.presetTeleports`, into `buildPresetTeleportEdges`' `spread` bag. `buildPresetTeleportEdges` turns every cross-floor `state.presetTeleports` entry into a `CrossFloorBadgePair` keyed by teleport `id` and calls the shared `resolveCrossFloorBadgeCells` (`mazeSelectors/teleport.ts`) — the identical relocation core `buildTeleportEdges` uses — then rewrites each cross-floor badge edge's off-floor end to the resolved cell. Floor-independent (the pair list and blocked map are both maze-wide), so a pair's two badges stay together across a floor switch. The preset editor always passes `allowOutOfField: true`. See `Specs/floors.md`'s "Badge collision relocation".

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

Semantically distinct from preset teleports: both endpoints of a planted vertical passage/elevator edge are added to `preset_connected`/`preset_edges` on the Rust side (a guaranteed structural connection), never to `preset_teleports` (optional extra-traversable shortcuts). The planted edge's own `EdgeId` also goes into `PresetState.preset_edge_ids` — the per-edge, kind-agnostic set `try_remove_edge_by_id` consults so repair cannot remove a preset `Teleport` / `VerticalPassage` / `Elevator`, not only a preset `Basic` (GitHub issue #376 follow-up). `preset_edges` stays pair-keyed for the generation algorithms and `is_preset_locked_node`.

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

Hit-testing, right-click-to-delete, and click-to-cycle-direction on an *existing* endpoint (`pickVerticalPassageEndpointAt`) mirror the teleport tool's own mechanics, filtered to the active floor's own endpoints (`(ep.level ?? 0) === activeLevel`) before hit-testing. A plain click (no drag) on an existing endpoint still cycles `forward ↔ backward` the same way a teleport endpoint's own click-to-cycle works. A plain click anywhere else in a cell with an existing vertical passage also targets that same cell/floor pair: one available pair cycles `forward ↔ backward`, while two existing adjacent-floor pairs are left unchanged rather than duplicated (GitHub issue #495; same behavior as post-edit issues #385/#491).

**Drag-to-move** (GitHub issue #566): dragging an existing vertical-passage endpoint moves BOTH ends to the dragged point's `(x, y)` — a vertical passage's two ends are the same column on different floors, so moving only the dragged end would desync them. The drag is a live preview only (`presetDragOverride`, set on pointerdown/pointermove, read by `PresetConnectionsRenderer` in place of the entry's committed endpoint); nothing is written to `presetVerticalPassages`/`presetElevators` until pointerup. On release, `moveVerticalPassageEndpoint` (`fieldValidity.ts`) validates that the OTHER end's own floor has a cell at the new `(x, y)` (`cellExistsAt`) — if not, the whole drag is reverted (no state change) and `presetDragFailureMessage` is set so `PresetConnectionsFeature` can show an `AlertModal` naming the rejecting floor/point. The dragged end's own floor is never rejected: the pointermove handler already gates candidate points to `getCachedCellSet()` (the active floor's own valid cells) before a drag override is even set.

### Elevator drag-to-move

Same override-preview + commit-on-release mechanics as vertical-passage drag (GitHub issue #566), extended to elevators: an elevator's floors all share one `(x, y)` column, so dragging any one floor's own marker moves EVERY other floor's own endpoint to the same new point. On release, `moveElevatorEndpoint` (`fieldValidity.ts`) validates the new point against every OTHER floor's own field (`cellExistsAt`); if any of them has no cell there, the whole drag is reverted and `presetDragFailureMessage` is set the same way as the vertical-passage case (message wording picks "stop" instead of "passage" via `entityKind: "elevator"`).

### Elevator placement

1. Clicking the `elevator` tool on an empty cell calls `startPresetElevatorPlacement(origin)`, seeding `presetElevatorPending: { origin, floors: Set([originLevel]) }` and opening `PresetElevatorFloorDialog`.
2. The dialog lists every floor as a row, **bottom floor first** (`floors[0]` = "Floor 1" = bottom — same order `FloorSwitcher`/`CopyFloorDialog` display, achieved by iterating `floors` reversed while keeping each row's own 0-based array index for status/toggle logic). Each row shows the floor's `"{n}: {title}"` label (`n` = 1-based), a status line, and a toggle:
   - **Current** — the origin floor's own row; switch on, disabled (can't be unchecked — `togglePresetElevatorFloor` no-ops for `floorIndex === originLevel`).
   - **Available** — that floor has a cell at the elevator's own `(x, y)` point (`cellExistsAt`); switch off by default, enabled.
   - **No cell** — that floor has no cell at that point; switch off, disabled (can't be selected — silently allowing it would create a client-invalid elevator, see "Validity" below).
3. Confirm (`confirmPresetElevatorPlacement`) is disabled until at least 2 floors are selected. On confirm, one `PresetElevatorEntry` is created with one `PresetEndpoint` per selected floor — **the same `(x, y)` point on every floor**, only `level` differs.
4. Cancel (ESC, or closing the dialog) calls `cancelPresetElevatorPlacement()`, discarding the pending placement without creating an entry.

Editing an existing elevator: right-click any of its floor endpoints removes the entire entry (`removePresetElevator`). Dragging a floor endpoint moves the whole elevator (see "Elevator drag-to-move" below); there is no other per-floor endpoint edit — floor membership itself is only set at creation time.

### Validity

A vertical passage is **invalid** if either endpoint's cell is outside its own floor's field (`computeInvalidVerticalPassageIds`, same per-floor `ResolveFieldAt` resolution as teleports). An elevator is **invalid** if any of its floor endpoints is outside its own floor's field, **or** fewer than 2 of its endpoints remain resolvable (`computeInvalidElevatorIds`) — mirrors the Rust side's own "fewer than two resolved endpoints connects nothing" fallback in `build_preset_state`, so a client-invalid elevator would have been a no-op edge-wise anyway. Both count toward the combined invalid total, are excluded from `generate()`, are cleared by "Clear invalid", and get a dedicated highlight when `highlightInvalidPresets` is on.

### Rendering

Drawn by a `VerticalConnectionRenderer` instance (`PresetConnectionsRenderer.verticals`, its own `verticalContainer`, added above `teleportContainer`) — the same marker primitive and `DEFAULT_MAZE_RENDER_STYLE.verticalConnections` section `GenerationRenderer` uses for resolved `VerticalPassage`/`Elevator` edges after generation (`DEFAULT_VERTICAL_STYLE` remains an alias for existing callers): circle marker for a vertical passage, diamond for an elevator, both in `canvas.vertical.default`. A preset therefore reads identically to the generated connection, not like a teleport. An earlier version reused `TeleportRenderer` (the same primitive preset teleports use) for this, which read as a plain teleport marker; that approach was replaced.

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
- The drag kind is locked by the branch selected at `pointerdown`: a clear/reset gesture that starts on a cell remains cell-targeted even if a later move hits an edge, and an edge gesture remains edge-targeted.
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
| `lockedNodes` | `Map<string, NodeLockKind>` | Manually locked nodes, keyed by `PresetEndpointKey`: `"x,y"` for the original node, `"x,y:slot"` for a split slot, with optional `@level` |
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
| `presetSplitTargetPrompt` | `{ point; level?; slotIds: number[]; action; queue?; picks? } \| null` | Deferred vertex-tool placement awaiting a split-node pick — see "Split-target prompt"; `queue`/`picks` only for the target-floor/drag actions (GitHub issue #594) |

`presetConnections`, markers, locks, and `defaultEdgeState` reset when tessellation changes with a different kind (`confirmTessellation` with `clearMaze = true`) or when `resetPresetConnections()` is called.

The "Reset all" action is confirmed with a compact alert whose title is "Reset all" and whose body is omitted. Its Cancel/OK footer has no divider, matching the post-edit reset confirmation layout.

`highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` whenever `setPresetConnectionsOpen(false)` is called.

## Tools

All tools live in one **Tools** section of the feature card, rendered as a wrapping row of square icon-only buttons (`ToolIconButton` + `ToolGlyph`, GitHub issue #456 — see "## Tool icon buttons" below). There is no longer an Edges / Vertex / Generation grouping. Section content (this row and every other section's body) is indented one `indent.tree` level under its label.

| Tool | Action |
|---|---|
| `wall` | Sets edge to `wall` |
| `passage` | Sets edge to `passage` |
| `reset` | Clears the edge's user override, re-materializing it as the current default (`{ state: "undefined" }`/deleted if `defaultEdgeState` is `"undefined"`) |
| `one_way` | Cycles one-way direction |
| `set_start` | Sets `presetStart` to clicked cell (when no vertex element is under the cursor). See "Shared vertex editing mode" above for drag/right-click, which apply to all vertex elements regardless of active vertex tool. |
| `set_finish` | Sets `presetFinish` to clicked cell (when no vertex element is under the cursor). See "Shared vertex editing mode" above for drag/right-click, which apply to all vertex elements regardless of active vertex tool. |
| `teleport_one_way` | Two-click placement of a one-way teleport — see "Preset teleports" |
| `teleport_two_way` | Two-click placement of a two-way teleport — see "Preset teleports" |
| `vertical_passage_one_way` | Two-click placement of a one-way vertical passage — see "Preset vertical passages and elevators" |
| `vertical_passage_two_way` | Two-click placement of a two-way vertical passage — see "Preset vertical passages and elevators" |
| `elevator` | Click a point, then pick reachable floors in a dialog — see "Preset vertical passages and elevators" |
| `lock_in` | Locks node to block incoming edges |
| `lock_out` | Locks node to block outgoing edges |
| `full_lock` | Locks node both in and out (`"both"`) |
| `gen_source` | On a plain (unsplit) cell: toggles `presetGenSource` on left-click (click the same cell to clear). On a declared split point: left-click opens `PresetSplitTargetDialog` (GitHub issue #494) — the picked node is assigned unconditionally (no toggle). Right-click clears `presetGenSource` whenever it sits on the clicked cell, on any cell (split or not). |
| `manage_split_nodes` | Left-click any in-field point to open "Manage split nodes" for it — see "Split nodes" above |
| `clear` | Removes any preset object in the clicked cell. Shown with a danger-hued selected border (`btn-tool-icon-selected-danger`) and a trash-can glyph; previously a text button in the Control section. |

The vertical-passage/elevator tool rows are only present when the project has more than one floor.

Hovered-cell highlight: `lock_in`/`lock_out`/`full_lock`/`gen_source` highlight the **cell** under the cursor, not an edge (`CELL_HOVER_TOOLS` in `PresetConnectionsController`, GitHub issue #456), same as `manage_split_nodes` and the vertex tools.

Right-click on an edge clears its user override and re-materializes it as the current default (same as the `reset` tool — see "Entry source" above), for any tool that falls through to edge picking (i.e. not `set_start`/`set_finish`/`gen_source`/lock/teleport/`manage_split_nodes` tools, each of which gives right-click its own tool-specific meaning — see their rows above). Dispatched via `applyPresetConnectionsToolAt("reset", edge.key, edge.from, edge.to)` — `edge.from`/`edge.to` (plain cell coords from `pickEdgeAtPosition`) are what `applyTool` actually keys off via `presetEdgeKey`/`activeFloorLevel`; the passed `edge.key` is a floor-0-only geometric hint, ignored by `applyTool` on any floor above the first (GitHub issue #433 — the pre-fix code passed only that bare key, so RMB reset silently no-opped on floor 1+).

## Tool icon buttons (GitHub issue #456)

Both the preset and post-edit (see `Specs/post-edit.md`) tool pickers render as square icon-only buttons.

- **`ToolIconButton`** (`components/ToolIconButton.tsx`) — a `<button>` sized to one tessellation cell (`TILE_SIZE + 4` square), its own button type (`btn-tool-icon` in `global.css`), not a toggle. Selection shows as an accent border + inset shadow, never a fill swap; the button face stays the canvas floor fill so the pictogram reads exactly as it does on the field. A `danger` prop (destructive tools — preset `clear`, post-edit `reset`/`delete`) swaps the accent border for the `base.error` hue (`btn-tool-icon-selected-danger`). `title` is the tool's own label (native tooltip), since the button carries no visible text.
- **`ToolGlyph`** (`components/features/ToolGlyph.tsx`) — blits the offscreen-rendered pictogram bitmap for a tool into a `<canvas>`.
- **`toolGlyphs.ts`** — renders every pictogram once, module-wide, through a single throwaway Pixi `Application` at device-pixel resolution (no `RenderTexture`/`extract` round-trip — that pixelated the result). Each glyph is drawn with the exact `DEFAULT_MAZE_RENDER_STYLE` primitives the canvas uses for that element (wall stroke, marker shape + gap ring, one-way indicator, lock icon, teleport diamond, gen-source cross, ...), so the icons track the render style. `GLYPHS` is a `Partial<Record<PresetConnectionTool | PostEditTool | "post_edit_reset", GlyphFn>>`; `toolGlyphs.test.ts` asserts every real tool resolves to an entry (post-edit `reset` maps to the synthetic `post_edit_reset` key — a counter-clockwise circular arrow, distinct from the preset `reset` grey undecided-edge stub). `getToolGlyphs()` caches the built bitmap map and drops a rejected build so a later call can retry.

## Node locking

`lockedNodes: Map<PresetEndpointKey, NodeLockKind>` stores explicitly locked nodes. `NodeLockKind` is `"in" | "out" | "both"`. Lock tools open the split-node picker on a split point, so the selected original node or slot is locked explicitly.

`autoLockedNodes: Set<"x,y">` is recomputed whenever `presetConnections` changes (if `autoLock` is enabled). A node is auto-locked when all its interior edges have a preset entry with `state !== "undefined"`. Edges with `state: "undefined"` are treated as undecided and prevent auto-lock. Auto-locked nodes always use `"both"` kind.

For a declared split point (see "Split nodes" below), auto-lock checks **every one of its nodes** (the original node plus each declared slot), not just the original's own edges — `computeAutoLockedNodes` takes an extra `presetSplitPoints` parameter for this. A split point auto-locks only once every one of its nodes has every interior face decided; then an exact key is emitted for each node, so generation locks all split nodes. One node with an undecided/missing face on any side keeps the whole split unlocked.

Both sets are merged when rendering (`buildLocks`) and when checking for isolated nodes (`buildIsolatedCellHighlights`).

**Isolated node**: a node locked `"both"` (manually or via auto-lock) with no non-wall preset on any of that exact node's edges. Split slots are checked by their full endpoint identity, not merely by the shared point coordinates. The UI uses this same exact-node check for both the Problems warning and the cell highlight, and highlights such cells.

## Card status

| Status | Condition (priority order) |
|---|---|
| `unavailable` | Field not ready |
| `warning` | Field ready, `computeInvalidKeys(...).size + computeInvalidTeleportIds(...).size + invalidMarkerCount + computeInvalidSplitPoints(...).size > 0` |
| `set` | Field ready, no invalids, `presetConnections.size + markerCount > 0` |
| `set-default` | Field ready, no invalids, nothing set |

`markerCount = (presetStart ? 1 : 0) + (presetFinish ? 1 : 0)`. `presetGenSource` is not counted here.

Subtitle: `"N preset(s)"` where `N = presetConnections.size + markerCount + presetTeleports.length + presetVerticalPassages.length + presetElevators.length`. Invalid presets are reported in the Problems subsection and remain reflected in the feature-card warning status; they are not repeated in the subtitle. "Clear invalid" removes all invalid edge presets, teleports, vertical passages/elevators, markers, locks, and split points together.

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
8. **markersLayer** — start/finish markers built by `buildPresetMarkers` from `DEFAULT_MAZE_RENDER_STYLE.startMarker`/`finishMarker`: circle, round corners, radius `0.16 * TILE_SIZE`, 3px matching-color border, and a 3px `canvas.floor.default` gap. Ordinary endpoints use their tile centers; endpoints on declared split slots use the same split-shape-aware anchor calculation as generated markers (GitHub issue #447).
9. **originLayer** — origin crosshair (when `showPresetOrigin = true`)
10. **genSourceLayer** — blue cross marker at `presetGenSource` cell
11. **isolatedHLLayer** — cell highlight for nodes locked both-in-and-out with no passage preset
12. **invalidHLLayer** — thick highlight when `highlightInvalidPresets = true`
13. **invalidPointHLLayer** — field-cell fill for invalid point entities (teleport/vertical/elevator endpoints, start/finish/gen-source, locks, and split points), when `highlightInvalidPresets = true`
14. **hoverLayer** — highlighted edge under cursor
15. **teleportPreviewLayer** — in-progress teleport placement preview (semi-transparent line + marker)

**Exterior edges** (one endpoint outside field) are drawn as solid walls. **Interior edges** (both endpoints inside field) are drawn according to their preset state.

**Cell cache** (`cachedCells`, `cachedCellSet`) is built once on open and rebuilt only when `tessellationConfig`, `fieldPoints`, or `fieldEditMode` changes. All redraw calls use the cache. `getCachedCells()` and `getCachedCellSet()` expose the cache to the controller.

**`redrawInvalidHL`** is called separately when `highlightInvalidPresets` changes, without redrawing all other layers. Same for `redrawOrigin` and `redrawGenSource` when their own state (`showPresetOrigin` / `presetGenSource`) changes — they no longer depend on viewport scale.

`PresetConnectionsRenderer` extends `BaseFieldRenderer` (shared with `PostEditRenderer`; see maze-web/CLAUDE.md's Feature-Renderer ownership rule — a shared base class, never a shared instance). `BaseFieldRenderer` owns the `useMazeStore.subscribe` skeleton, the cell-cache lifecycle (`rebuildCellCache`, `getCachedCells`/`getCachedCellSet`), and `destroy`. `PresetConnectionsRenderer` implements `isCardOpen` (`openCard === "preset_connections"`), `getActiveConfig` (`tessellationConfig`), `setRootVisible`, `redrawAll`, `clearAll`, `destroyChildren`, and `onStoreChange` — the latter holds all of this feature's point updates that don't need a full `redrawAll` (field-points rebuild, origin/genSource/invalidHL/isolatedHL toggles, teleport preview clear on tool change).

## Gen source marker

`GenSourceRenderer` draws a blue cross (`GEN_SOURCE_COLOR = 0x3399ff`) at the generation source. Identical geometry to `OriginRenderer` (only the color differs) — both call the shared `drawCrossMarker` (`pixi/renderers/crossMarker.ts`): grid-unit arm `CROSS_ARM = TILE_SIZE * 0.35`, line width `CROSS_WIDTH = 3`, rounded caps, fully opaque. Sizes are in grid units so the cross zooms with the field like any other drawn content — there is no `vpScale` compensation and no `ORIGIN_ALPHA` (both removed, GitHub issue #456 follow-up). The `gen_source` tool glyph mirrors this exact cross.

`presetGenSource` is a `PresetEndpoint` (GitHub issue #494), so on a split point it addresses one specific node. `GenSourceRenderer.render` takes an already-resolved screen position (not a grid cell): `PresetConnectionsRenderer.redrawGenSource` resolves the endpoint through `presetEndpointScreenPos` against the same `buildPresetNodePositions` map every start/finish marker uses (see "Single endpoint-position resolver" above) — on a full redraw it reuses the shared map, on a viewport-only redraw it builds one. The endpoint is level-filtered by the caller, then resolved level-less to match how `buildPresetNodePositions` keys split-point nodes. Result: the cross sits on the picked node's shape-aware anchor, not the tile center; an unsplit source resolves to the plain tile center as before.

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

`lockedNodes` (the `Map<string, NodeLockKind>` powering the lock tools) is keyed the same way every other preset collection now is (`"x,y"`, `"x,y:slot"`, with optional `@level`) — locks address the exact original node or slot selected in the split picker.

### Rotating a split point (`rotatePresetSplitPoint`, GitHub issue #580)

Mirrors post-edit's own `rotateSplitPointNodes` (see `Specs/post-edit.md`'s "Rotating a split point" section for the full algorithm) over `PresetConnectionEntry`/`PresetConnectionState` instead of `PostEditEdge`: each of the point's own declared nodes independently shifts its decided faces by one offset index; a new neighbor's owning node is resolved by the same existing-connection → geometry-evidence (`canCompleteOppositePair`) → active/original-fallback tiering (`resolvePresetFaceOwner`/`selectExistingPresetFaceOwner`).

**A missing `PresetConnectionEntry` reads as `"undefined"` (optional/undecided)** — this is the load-bearing difference from post-edit, where an absent edge always reads as `wall`. Because of this, an old neighbor node that loses its partner during rotation and isn't picked up as anyone's new owner **must** get an explicit `wall` entry written (not just have its stale entry deleted) whenever that old neighbor is itself split: leaving the map entry merely absent doesn't just "vanish" a wall the way it does in post-edit — it reads as a genuinely undecided face in the UI, and can silently turn one of the neighbor's *other*, unrelated decided faces into part of a broken bridge/diagonal shape. A plain (non-split) old neighbor keeps the simpler "just delete the entry" behavior, since it has no other face to protect. The wall rewrite is keyed by the exact `(ep, oldNeighborNode)` pair, not merely "is this neighbor node claimed by *some* move" — the same physical neighbor node can simultaneously lose one of the point's nodes as an old partner and gain a *different* one of the point's nodes as a new partner within a single rotation.

**Warning before a rotation breaks a neighbor's shape** (GitHub issue #588) — mirrors post-edit's own warning (see `Specs/post-edit.md`'s "Rotating a split point" section): `rotatePresetSplitPointBreaksNeighborShape` (`pixi/fieldEditUtils.ts`) dry-runs `rotatePresetSplitPoint` and compares every one of `point`'s geometric neighbors' `detectSplitSpecialShapeKind` result before/after via `presetSplitNodeFaceKinds`; simpler than the post-edit counterpart since `rotatePresetSplitPoint` already returns the full post-rotation `presetConnections` map rather than a per-node snapshot needing replay reconstruction. `PresetSplitNodesDialog` wires this into `SplitNodesDialogView`'s shared `wouldBreakNeighborShape` prop, which shows a `ConfirmModal` before committing a rotation that would break a neighbor's recognized shape.

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

Removing one slot of a split point (`removePresetSplitNode`, used by the "Manage split nodes" panel) is rejected if that slot is currently assigned as `presetStart`/`presetFinish`/`presetGenSource` (same "reassign first" guard post-edit's `removeSplitNode` uses for start/finish); otherwise it strips every `presetConnections`/`presetTeleports` entry referencing that node. `applyPresetSplitBlueprint` has the same `presetGenSource` guard.

Removing an *entire* split point at once (`removePresetSplitAll`, used by the entity-delete dialog's `split_node` row — see "Entity delete/reset dialog" below) never refuses, even if a slot is assigned as start/finish/gen-source or holds a teleport/vertical passage/elevator: every such entity **migrates** onto the point's original node instead of being deleted, and every edge internal to the split shape (including the original node's own faces, since a recognized bridge/diagonal shape draws across both) drops to the field's default state (`resetEdgeToDefault` — reverts to reading as `defaultEdgeState`, not to `"undefined"`) rather than being stripped outright. This is a deliberate behavioral difference from `removePresetSplitNode`: the dialog's job is "get rid of the split, keep everything it hosted," not "refuse and make the user reassign things first."

### Generation source on a split point (GitHub issue #494)

`presetGenSource` is a `PresetEndpoint`, so it addresses exactly one of a split point's nodes (`slotId: undefined` = the original node). The Rust side already handles every split configuration without special-casing: `PresetState::resolve_endpoint` resolves the endpoint to a single `NodeId` the same way `preset_start`/`preset_finish` are resolved (against the `(point, slotId) -> NodeId` map `build_preset_state` builds from `split_points` before any marker), and `run_generate`/`dispatch_generate`'s `start_id` seeds the generator's frontier from that node — including when it sits inside a preset cluster (`vertex_based.rs` inserts `start` into the frontier unconditionally, bypassing the "not visited upfront" rule preset-connected nodes otherwise follow). A `gen_source` addressing a slot that was never declared, or a point that no longer exists, is silently skipped exactly like an out-of-bounds `preset_start`, and generation falls back to the center-nearest node.

The wire payload already carries the slot: `buildGenerateConfig` sends `preset_gen_source: presetEndpointToDto(state.presetGenSource)` and `presetEndpointToDto` preserves `slot`/`level`. The only web-side gap this issue closed was the placement path never *setting* a slot — the `gen_source` tool resolved through `resolvePresetActiveEndpoint` (original node only) instead of the split-target picker.

The status-bar cell inspector already reports a `Gen source` line per node (`buildPresetNodeMarkerLines`, matched by exact `PresetEndpoint` equality), so a split point whose slot 1 carries the source shows `[Node 2: Gen source]` and its other nodes stay unmarked.

**Orphan slots are not auto-removed.** A declared slot with nothing referencing it is created anyway at generation time (see "Applying split points" below) and surfaces as a dedicated warning in the Preset Connections panel (`orphanSplitCount`, same `warningBubble` style as the isolated-nodes warning) — informational only, does not block generation.

The orphan check is based on whether the slot has any preset entity entry, not on whether that
entry currently requires a connection. An explicit `undefined` connection is still a reference:
if the user changes a split node's settings and then returns every face to `undefined`, the node is
considered intentionally configured and the orphan warning remains hidden. Only a split slot with
no connection, teleport, start/finish, or generation-source entry is reported as orphaned. This is
intentional behavior and must not be changed by treating `undefined` as equivalent to an absent
entry.

The Preset Connections panel always renders its Problems subsection header, even when there are no isolated nodes or orphan split points. The header uses the shared localized `common.problems` label and shows the current warning count (`Problems (N)` / `Проблемы (N)`), where `N = isolatedNodes.length + orphanSplitCount`. The subsection starts collapsed by default (`presetSectionsExpanded.problems: false`); when `N > 0`, its label immediately uses the UI warning color without animation, so the count can be noticed without causing a layout jump.

### Rendering

A declared split point's faces render as colored per-slot passages, the same visual `PostEditRenderer`/`GenerationRenderer`/`MazeOverlayRenderer` already use for resolved split nodes (GitHub issue #223) — `buildSplitPassages` (`pixi/selectors/mazeSelectors.ts`) was generalized into `buildSplitPassagesCore<Id>`, parameterized over an opaque comparable id instead of a `NodeDto`'s numeric `NodeId`, so the same geometric algorithm (dividing a shared face among connected nodes, straightening 2-face connectors, hub-point fan-out for other counts) doesn't need a second implementation. `buildPresetSplitPassages` (`pixi/selectors/presetSelectors.ts`) is the preset-stage instantiation: identity is `presetEndpointKey` (a string) instead of a `NodeId`; nodes are assembled from `presetSplitPoints` plus every in-field geometric neighbor of a declared split point (including that neighbor's own declared slots, if it's itself split) — registering every geometric neighbor, not just ones some `presetConnections` entry already references, is what lets an undeclared face read as optional instead of vanishing entirely. `PresetConnectionsRenderer` draws the result via the same `SplitJunctionRenderer` class, and `buildPresetWallGroups` excludes a declared split point's own faces from its ordinary wall/undecided reading (mirrors `buildMazeWalls`'s `splitPointKeys` exclusion) so the two renderings never overlap. A field-boundary face is never one of `buildPresetSplitPassages`'s connected faces (only in-field neighbors are registered), so `buildPresetWallGroups` draws a split-point cell's own boundary sides in a separate pass instead of skipping them along with its interior faces — otherwise a split point placed against the field edge would render with no boundary wall at all (GitHub issue #572), mirroring `buildMazeWalls`'s own boundary-walls-still-drawn-for-split-points pass.

Preset markers and edges use the same node-position geometry as generated and post-edited mazes (GitHub issue #447). An endpoint on an ordinary unsplit point stays at the tile center. An endpoint addressing a node of a recognized special split topology (bridge/diagonal and their supported hex variants) is placed at that node's dedicated shape-aware anchor, derived from the declared slots and non-wall preset connections; other split topologies fall back to the generic hub-circle position. This keeps the marker/edge end attached to the passage or half-tile represented by its exact `PresetEndpoint`, rather than placing every one at the tile center.

**Single endpoint-position resolver.** Post-edit has one `NodeId`-keyed node list, so every selector calls `buildNodePositions(allNodes, ...)` and split resolution is automatically uniform. Presets have no shared node list (generation hasn't run), so each selector would otherwise assemble its own pseudo-node list and could forget to resolve split anchors at all. Instead, `buildPresetNodePositions(cfg, presetSplitPoints, connections)` builds the anchor map once per redraw (in `PresetConnectionsRenderer`), and `presetEndpointScreenPos(endpoint, cfg, nodePositions)` is the **one** function every preset marker/edge selector resolves an endpoint through — `buildPresetMarkers` (start/finish), `buildPresetTeleportEdges` (teleport ends), `buildPresetVerticalMarkers` (vertical passage / elevator markers), and `PresetSplitPointPixiPreview`'s node dots. A new preset marker type must route through the same pair, not re-derive positions.

**Per-node face kind.** Every face of every one of a split point's nodes always has one of `"wall" | "passage" | "one_way_out" | "one_way_in" | "undefined"` — there is no separate "no decision yet" state; presets default an undecided face to `"undefined"` (optional/tentative), while post-edit defaults to `"wall"` (its dialog has no optional-connection concept). `"wall"` is explicit only when a `presetConnections` entry actually has `state: "wall"` for that specific node pair (tracked via a `wallPairs` set, since core's directed-pair model only encodes actual passages) — a plain undecided face with no entry at all reads as the stage's own default, not `"wall"`. `"undefined"` shares/connectors render desaturated (`disabledOf`/`disabledOfNumber`) instead of the node's normal color, both in the canvas (`SplitJunctionRenderer`) and the panel's tile diagram (`TileFaceEditor`).

**Resolving the real partner.** When the neighbor across a face is itself split, several of its nodes can each have an independent connection across that same face — `buildSplitPassagesCore` resolves each node's *specific* partner (checking every neighbor-point node for a matching entry, falling back to the neighbor's first node only if none matches) rather than assuming a single "the" neighbor node per face; the latter would check a node's decided state against the wrong neighbor whenever its real partner isn't that neighbor point's first node. A directed (`passage`/one-way) match always wins over a `wall` match regardless of which candidate is checked first (GitHub issue #243 follow-up): a blueprint apply explicitly walls off every neighbor candidate its resolved partner didn't pick, so the first candidate found with an explicit `wall` isn't necessarily the real connecting node — a later candidate might still hold the real passage. Only falls back to a `wall` match if no candidate has a directed entry at all. The same partner-resolution rule (with the same wall/passage priority) is used on the write side too, by `resolvePresetPartnerAt`/`resolvePostEditPartnerAt` in `applyPresetSplitBlueprint`/`applySplitBlueprint` (see `Specs/split-blueprints.md`) and by the "Manage split nodes" panel's own tile diagram (`PresetSplitNodesDialog`'s `facesOf`) — all three must resolve a split neighbor's real connecting node consistently, not just the renderer.

**All-nodes-wall.** A face where every one of a point's nodes explicitly has `"wall"` renders as one plain solid wall spanning the whole face (`SplitPassagesResult.wallFaces`, same color as an ordinary non-split wall) instead of per-node segments — it isn't attributable to any single node's color.

The shared geometric algorithm (face division among connected nodes, hub-point fan-out, the 2-passage straightening exception, active-node z-order, one-way arrow placement on the connector rather than the along-face segment) lives in `pixi/splitFaceLayout.ts`, used by both `buildSplitPassagesCore` (canvas) and `TileFaceEditor` (the "Manage split nodes" panel's tile diagram) so the two never drift apart.

**Panel link sections.** Each node's card in "Manage split nodes" groups its links into three sections: **Required** (a decided passage/one-way — the connection *will* exist), **Undefined** (preset's optional/undecided faces — *may* exist, not forced either way; always empty for post-edit, which has no such concept), **Forbidden** (`wall` — this node's face is explicitly closed here). An empty section shows a dash placeholder.

### Split-target prompt (GitHub issue #474)

The split-node panel's connection sections contain only basic connections and hide empty sections. One-way connections remain basic connections. Each node card also has an Elements section for start/finish points, teleports, vertical passages, elevators, and locks, using the deletion-dialog row format without IDs in preset mode.

Element rows omit the current node's own address: a directed element is rendered as its localized name, direction arrow, and target coordinate bubble. Target bubbles include `L{n}:` on another floor and hover the standard inward-inset cell highlight with an opaque border; elevator rows list every other floor bubble.
Vertical-passage target bubbles contain only `L{n}`; any target-floor bubble is clickable and switches the active floor.

`presetActiveSplitNode` decides which of a split point's nodes an *edge*-tool click targets (walls/passages/one-way — via the "Manage split nodes" panel's active-node affordance). It must **not** decide which node a *vertex*-tool placement attaches to: a start/finish marker, the generation source (`gen_source`, GitHub issue #494), a teleport endpoint, a vertical passage, or an elevator. That coupling is removed from placement entirely.

Instead, when a left click with a vertex tool lands on a declared split point (`presetSplitPoints["x,y[:level]"]` non-empty), `PresetConnectionsController` does not place anything — it sets `presetSplitTargetPrompt` (`point`, `level`, the point's declared `slotIds` ascending, and the deferred `action`) and returns *before* any marker/teleport/vertical-passage hit-test (those resolve through the active node and would otherwise silently drag/cycle/complete on it). A right click still falls through: for `set_start`/`set_finish`/`gen_source` it clears the marker when it sits on the clicked point (any of its nodes); for the other tools it removes the element under the cursor.

`gen_source` is not a `VERTEX_TOOLS` member (it hovers a whole cell, like the lock tools) so it has its own pointerdown branch, but it takes the same split-target detour: a left click on a declared split point opens the picker instead of toggling the source on the point's original node. Picking a node assigns it **unconditionally** (no toggle — same as `set_start`); the only way to clear a split-point source from the canvas is a right click on it. On a non-split cell `gen_source` keeps its original toggle behavior (click the same cell again to clear).

`PresetSplitTargetDialog` shows the point's nodes — the point's original node first, then one row per declared slot, each with its slot color. Rows carry no special "original node" label: every row is titled `Node {n}` with `n` 1-based in row order (the original node is `Node 1`), matching `ManageSplitNodesDialog` and the debug/cell-inspector numbering (GitHub issue #468). When the point's face configuration matches a recognized special-split topology, each row instead shows its semantic name (`splitNodeSemanticNamesFromKinds`, GitHub issue #487 — face kinds derived via the shared `presetSplitNodeFaceKinds`; see `Specs/split-blueprints.md`). Plus a small non-interactive Pixi preview (`PresetSplitPointPixiPreview`) rendering just this point's split geometry (via `buildPresetSplitPassages`), oriented as on the field with no neighbouring cells drawn; on a recognised special shape (bridge/diagonal) each node also gets a marker dot at its real anchor position (resolved via `buildPresetNodePositions` + `presetEndpointScreenPos`, the same pair the canvas uses), in the same color its picker row uses (`splitSlotColor`), so the nodes are distinguishable by position (on a plain split the line colors already disambiguate, so no dots). The dot radius/stroke are divided by the preview's `world.scale` so it renders at a constant ~7 px on-screen radius on every tessellation.

Picking a node calls `applyPresetSplitTargetPick(slotId)` (`undefined` = the original node), which clears the prompt and dispatches the deferred tool to `presetEndpoint(point, slotId, level)`: `set_start`/`set_finish` → `setPresetStartEndpoint`/`setPresetFinishEndpoint`; `gen_source` → `setPresetGenSourceEndpoint` (GitHub issue #494); vertical passage → `startPresetVerticalPassagePlacement`; elevator → `startPresetElevatorPlacement`; teleport → sets `presetTeleportPendingFrom` on the first pick, completes the link via `addPresetTeleport` on the second (a second split point shows its own prompt). `cancelPresetSplitTarget` (dialog Cancel, ESC key, tool switch) drops the prompt without placing anything; it is also reset by `resetPresetConnections`, a tessellation-kind change, an orientation flip, and project load. Post-edit additionally drops its own prompt on leaving the post-edit card (`PostEditFeature` effect); the preset feature has no equivalent card-close hook, relying on the tool-switch/ESC clears instead. Otherwise this mirrors post-edit's `postEditSplitTargetPrompt` (see `Specs/post-edit.md`).

This picker is for the **add/placement** flow only — "which node does a new marker/teleport/etc attach to." It plays no role in delete/reset: removing or resetting an entity on a split point goes entirely through the entity-delete dialog below (GitHub issue #540), which already knows which node each existing entity lives on and never needs to ask.

**Target-floor/drag split-tile parity with post-edit (GitHub issue #594).** Everything above only covers the *origin* point — the cell actually clicked. A vertical passage's/elevator's OTHER floor(s) — the target a fresh placement lands on, or the (x, y) a drag moves every end/floor to (GitHub issue #566) — can independently be declared split, and until this issue that was never checked: `commitPresetVerticalPassage`/`confirmPresetElevatorPlacement`/`moveVerticalPassageEndpoint`/`moveElevatorEndpoint` always built the target/other-floor endpoint as `presetEndpoint(point, undefined, level)`, silently attaching to the original node — mirrors the post-edit bug GitHub issue #567 fixed for drag/fresh placement there.

`resolvePresetSplitTargets` (`fieldEditUtils.ts`) is the shared resolver: given a list of `{ point, level }` targets and `presetSplitPoints`, it returns `picks` (one resolved `PresetEndpoint` per target, `undefined` for a target still awaiting a pick) and `queue` (the subset that needs one, each carrying its own `targetIndex` back into `picks`). A target with no declared slots resolves silently, same as before this issue.

- **Fresh vertical-passage placement** — `startPresetVerticalPassagePlacement`/`choosePresetVerticalPassageDirection` route their single-direction commit through `tryCommitPresetVerticalPassage`, which resolves the `to` floor's own point through `resolvePresetSplitTargets`. An unsplit `to` commits immediately via `commitPresetVerticalPassage` (now taking an optional `toOverride`). A split `to` opens `presetSplitTargetPrompt` with `action.tool: "place_vertical_passage_target"` instead.
- **Fresh elevator placement** — `confirmPresetElevatorPlacement` resolves every OTHER selected floor (excluding the origin's own level, see below) through `resolvePresetSplitTargets`; an unsplit set commits immediately via `dispatchPresetElevatorPlacement` (factored out of the old inline commit, mirrors post-edit's `dispatchPostEditElevatorPlacement`); any split floor(s) open the prompt with `action.tool: "place_elevator_target"`, `levels` ascending (origin's level included in `levels` for `picks` indexing, just never re-resolved against `presetSplitPoints`).
- **Vertical-passage drag** — `movePresetVerticalPassageEndpoint` resolves BOTH the dragged end's new point and the other end's own point (same (x, y), GitHub issue #566) before calling `moveVerticalPassageEndpoint` (now taking optional `ownEndpoint`/`otherEndpoint` overrides). Either being split opens the prompt with `action.tool: "move_vertical_passage_endpoint"`.
- **Elevator drag** — `movePresetElevatorEndpoint` resolves every floor (dragged floor first, then every other ascending) before calling `moveElevatorEndpoint` (now taking an optional `overridesByLevel` map). Any being split opens the prompt with `action.tool: "move_elevator_endpoint"`, `levels` in that same dragged-first order.

The origin's own floor is never re-resolved through `resolvePresetSplitTargets` in `confirmPresetElevatorPlacement` — `pending.origin` already carries its correct, possibly already-user-picked `PresetEndpoint` (the origin cell may itself have been split and resolved through this very dialog before the elevator placement even started). Re-checking it against `presetSplitPoints` would add a redundant queue entry nothing downstream ever fills, so the queue never drains and the elevator silently never gets created. `otherLevels`/`otherPicks` cover only the non-origin floors; `picks` is then assembled over the FULL `levels` array with `pending.origin` spliced back in at its own index, and `queue`'s `targetIndex` values (which point into `otherLevels`) are remapped onto that full-`levels` indexing before the prompt is built.

For these four `action.tool` variants, `presetSplitTargetPrompt` additionally carries `queue`/`picks` (mirrors post-edit's own queue shape byte-for-byte, just keyed by `slotIds` instead of `nodeIds` — presets have no confirmed node list to resolve against). `applyPresetSplitTargetPick` fills `picks[queue[0].targetIndex]`, shifts to the next queued point if any remain (dialog stays open, re-renders for the new point), and once the queue drains, dispatches the deferred move/placement with every resolved endpoint and clears the prompt (and `presetDragOverride`, for the drag variants). `PresetSplitTargetDialog`'s row click calls `applyPresetSplitTargetPick` only — never the dialog's own `onClose` — because `onClose` (`cancelPresetSplitTarget`) unconditionally nulls the prompt, which would immediately wipe out the next queued point's freshly-set prompt right after a mid-queue pick advances it; `onClose` still fires from the modal's own X/backdrop to cancel explicitly. The dialog's title includes the floor number (`floor {level}, x:{x}, y:{y}`) alongside the coordinates, matching post-edit's own `PostEditSplitTargetDialog` title format.

For the two drag actions, whether every OTHER floor even has a cell at the new point is checked up front, in `movePresetVerticalPassageEndpoint`/`movePresetElevatorEndpoint`, before any split-target dialog opens at all — `moveVerticalPassageEndpoint`/`moveElevatorEndpoint`'s own `cellExistsAt` failure path only runs once the split-target queue (if any) has fully drained, which previously meant the user could answer one or more "which node?" prompts only to be told afterwards that the whole drag failed because some other floor simply has no cell there. A failure from this upfront check is unaffected by which split node ends up picked, so it's caught before any dialog opens rather than after. The dragged end's own landing point is still gated to the active floor's own valid cells before a drag is even armed (`PresetConnectionsController`'s pointermove handler, unchanged) — only WHICH node at that point can now require a pick, and only the OTHER floor(s)' cell existence is what this upfront check adds.

Every preset marker/edge selector that resolves a `PresetEndpoint` through `buildPresetNodePositions`'s shared `nodePositions` map (`buildPresetVerticalMarkers`, `buildPresetTeleportEdges`) strips the endpoint's `.level` before the lookup (`withoutLevel`, `presetConnectionsGeometry.ts`) — that map is built once per active-floor redraw from already level-filtered `presetSplitPoints`/`presetConnections`, so its keys never carry a `@level` suffix, while a vertical-passage/elevator/teleport endpoint's own `PresetEndpoint` still does whenever it sits on a non-zero floor. Looking it up with the level suffix intact only ever matched by accident on floor 0 (no suffix either way); on any other floor it silently fell back to the plain cell center instead of the split node's real anchor. `redrawGenSource` (`PresetConnectionsRenderer.ts`) already followed this convention before GitHub issue #594's work.

### Target-floor split-node name resolution (GitHub issue #596)

`PresetSplitTargetDialog` scopes the selected floor's split points and connections before deriving
semantic node names. The face-kind inputs must therefore use level-free endpoints and an undefined
level, matching that scoped data; retaining a non-zero endpoint level makes the edge lookup miss and
falls back to generic `Node N` labels.

### Entity delete/reset dialog (GitHub issue #540)

Deleting the contents of a point used to be one unconditional action (`resetPresetPoint`, the `clear` tool's cell-drag/click) and RMB vertex-tools resolved to at most one hit via a hardcoded priority chain (`onStart` → `onFinish` → teleport → vertical passage → elevator) — so a click could silently remove the wrong one of several markers stacked on the same node. Both paths now go through a shared "which entity(s)?" flow instead of guessing.

**Descriptor model** (`pixi/pointEntities.ts`, store-neutral — no Zustand/Pixi imports). `PresetPointEntityDescriptor`: `kind` (`"start" | "finish" | "gen_source" | "edge" | "teleport" | "vertical_passage" | "elevator" | "lock" | "split_node"`), a stable `id` (kind-scoped: numeric id as string for teleport/VP/elevator, canonical `"x,y-x,y"` pair for an edge, `"lock"`/`"split_node"` for the singleton rows), the `endpoint` the row is anchored on (for node badge/color), `nodeIndex` (recomputed on every call from the point's current node order — never cached as identity), and a localized `title` reusing the same per-kind wording the status bar (`buildPresetCellInspection`) already uses. The delete dialog additionally renders the row's `bubbles` (one cell/endpoint per bubble), `showArrow`/`arrow` for directed or bidirectional connections, and an optional `entityId`, matching the post-edit delete/changes presentation instead of embedding connection targets in plain text. `presetVertexMarkerEntities(...)` is the shared core building the five marker-kind rows (start/finish/gen-source/teleport/vertical-passage/elevator) for one endpoint — reused by both `buildPresetPointEntities` and the status bar's `buildPresetNodeMarkerLines` (a thin `entities.map(e => e.title)` adapter over it). `buildPresetPointEntities(point, level, activeFloorLevel, scope, state-slices)` is the dialog's entry point.

One deliberate divergence between the two (GitHub issue #595's compact-display follow-up): `presetVertexMarkerEntities` takes an optional trailing `compactVerticalTarget` flag — `buildPresetNodeMarkerLines` (status bar) passes `true`, `buildPresetPointEntities` (delete dialog) leaves it `false`. A vertical-passage/elevator target's x/y is always identical to the departure point's own (only the floor ever differs), so the status bar's `title` for those two kinds renders just `L{floor}`, dropping the coordinate pair and split-node suffix; the delete dialog keeps the full `Lf x:y (splitLabel)` display, since removing an entity there benefits from the exact target shown. Teleport rows are unaffected either way — a teleport's x/y can genuinely differ, so both surfaces always show the full display. The flag threads down to the shared `formatTargetLabel` (`pixi/targetLabel.ts`) as its own `floorOnly` parameter — the post-generation status bar (`buildCellInspection`, `pixi/selectors/mazeSelectors/cellInspection.ts`) applies the same `floorOnly: true` for vertical-passage/elevator targets directly at its own `formatTarget` call sites, independent of this preset-stage descriptor model.

**Dialog presentation.** Start/finish rows intentionally have no coordinate bubble. Cross-floor teleport and vertical-passage rows prefix every endpoint bubble with its floor, and recognized split topologies use semantic node names instead of generic `N1`/`N2` labels. The dialog uses the same shrink-to-fit width policy as post-edit, with the shared minimum/maximum width cap; bubble groups retain the post-edit spacing where the first-bubble-to-arrow gap is smaller than the arrow-to-second-bubble gap.

**Scope.** `{ kind: "point_all" }` — the `clear` tool's cell click/drag: every entity on the point across every one of its nodes (edges, the five marker kinds, lock, and a `split_node` row). `{ kind: "vertex_markers"; endpoints: PresetEndpoint[] }` — RMB vertex-tools: restricted to the five marker kinds, anchored only to the given `endpoints` (the node(s) the RMB hit-tests actually landed on) — never edges/lock/split_node, so a vertex-tool RMB can never accidentally reach into a split point's edges.

**Edge rows.** Only appear under `point_all` scope, only for the point's original node, only when the point has no declared split slots at all (once it has slots, every edge of the point — the original node's own faces included, since a recognized bridge/diagonal shape spans both — is folded into the single `split_node` row instead of listed separately), and only for a `source: "user"` entry (a `source: "default"` entry is just `defaultEdgeState`'s field-wide fill-in, not something the user placed, so it gets no row). Deduplicated by canonical `(from, to)` pair. Row title: the edge-state name (`preset.wall`/`preset.passage`/`preset.one_way`) plus a direction arrow and the neighbor's coordinates, e.g. `"Wall -> (1,0)"`, `"One-way <- (0,1)"` — the arrow reflects the edge's actual direction relative to this row's anchor node for a one-way, and is a plain `"->"` separator for wall/passage (which have no direction).

**Split-node row.** Appears in `point_all` scope whenever the point has any declared slot, regardless of whether that slot currently hosts other entities — titled the same way as a `PresetSplitTargetDialog`/cell-inspector row (`"Node N"`, or the semantic shape name for a recognized special topology). Removing it calls `removePresetSplitAll` (see "Split nodes" above): the whole split point is removed at once, its hosted entities migrate onto the original node, its internal edges revert to default.

**Lock row.** Only a manually-set lock (`lockedNodes`) gets a row — an auto-computed one (`autoLockedNodes`) isn't user-removable. The row is attached to the exact original node or split slot it addresses.

**Count-based dispatch** (`requestPresetEntityDelete(point, level, scope, bulk)`). Builds the scoped descriptor list and: 0 entities → no-op; exactly 1 → removes it directly via `removePresetPointEntity` (no dialog — matches the pre-#540 single-entity UX); more than 1 → opens `presetEntityDeletePrompt: { point, level, scope }`. The same count check re-runs after every row removal inside an open dialog, closing it automatically once the scoped list empties. Passing `bulk: true` (shift-held at gesture start, captured once and not re-read mid-drag) skips straight to the old unconditional bulk removal instead of counting: `resetPresetPoint` for `point_all`, or a per-descriptor removal loop for `vertex_markers`.

`presetEntityDeletePrompt` stores only the point/level/scope address, never node indices or a snapshot of the entities — the open dialog rebuilds its list from live state on every render, so a mutation elsewhere (or a row it just removed) is reflected immediately, and if the scoped list goes empty the dialog closes itself.

**Removal.** `removePresetPointEntity(descriptor)` switches on `descriptor.kind` to the existing per-entity mutator (`setPresetStartEndpoint(null)`, `removePresetTeleport(id)`, `removePresetVerticalPassage(id)`, `removePresetElevator(id)`, `removeLockedNode`, `removePresetSplitAll`, or a single-edge revert-to-default). `resetPresetPoint` removes locks from every original/slot node at the point, as well as its other entities. `removeAllPresetPointEntities()` is the dialog's "Delete all": for `point_all` scope it delegates to the legacy `resetPresetPoint` (proven byte-identical to the old one-shot behavior); for `vertex_markers` scope it removes only the entities in that scope's live descriptor list, in a fixed kind-priority order, leaving edges/lock/split_node and any out-of-scope node untouched.

**Mutual exclusion.** Opening `presetEntityDeletePrompt` closes `presetSplitTargetPrompt` and vice versa — the two are never open together. ESC cancels whichever is open (`cancelPresetEntityDelete`/`cancelPresetSplitTarget` are idempotent no-ops on `null`, so one handler can safely call both).

**Controller wiring** (`PresetConnectionsController.ts`). An `isPresetModalOpen` guard blocks pointer input from continuing to drive canvas tools while either prompt (or a VP/elevator pending placement) is open — without it, a drag gesture that opened the dialog on its first cell kept re-targeting it to whatever cell the cursor moved to next. RMB vertex-tools collect every matching hit's endpoint into a list first (still one hit-test per kind, unchanged), then dispatch by count instead of an if/else priority chain.

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

Same output conventions as the post-generation inspector: bare `"x:N, y:N"` for an empty cell, `" | "`-joined marker lines for a plain node, `"[Node N: ...]"` blocks (`"; "`-joined lines inside) for a split point — `N` is 1-based, the point's original node first (`Node 1`) then declared slots by ascending `slotId` (`allNodesAt`'s own order, the preset-stage analogue of `NodeDto.i + 1`). The point's original node is not labelled specially — it is just `Node 1` (GitHub issue #468). When the point's face configuration matches a recognized special-split topology, the block title is the semantic node name (`"[Corridor: …]"`) instead of `"[Node N: …]"` (GitHub issue #487) — this needs the tessellation config, the in-field cell set and `presetConnections`, all threaded from `resolveCellInspection`; if any is omitted the plain `Node N` titling is kept.

### Per-card maze source (`resolveMazeSource` / `buildPostEditMazeSource`)

All marker descriptors and generic split labels (`Start`, `Finish`, `Gen source`, `Teleport`, `Vertical passage`, `Elevator`, `Lock`, lock kinds, `empty`, and `Node N`) are rendered through Paraglide messages (`status.cell_*`) and follow the active locale. Coordinates, arrows, and `L1`-style floor identifiers remain structural notation.

Each maze-bearing card's inspector reads the graph that card actually draws:

- **Generation** — `_generatedNodes`/`_generatedEdges` (its own frozen snapshot), or the live debug-replay view while a debug session is stepping.
- **Post-Edit** — the live *draft* graph rebuilt by `buildPostEditMazeSource` (the same unscoped derivation `PostEditRenderer.redrawAll` uses): draft basic/wall/teleport edges + draft vertical passages / elevators + generation-time vertical/elevator edges (minus `postEditSuppressed*Pairs`), with start/finish from `postEditDraftMeta` (falling back to the confirmed `state.start`/`state.finish` only when no draft meta exists yet). `state.nodes`/`state.edges` alone is just the last *confirmed* snapshot, and `state.start`/`state.finish` is never written back by post-edit — reading those directly made the status bar report generation-time markers for a cell the user had since edited (GitHub issue #488). Draft split slots added but not yet confirmed aren't in `state.nodes` and so don't resolve, same limitation the renderer has.
- **Analytics / image export** — the confirmed `state.nodes`/`state.edges` (these cards show the confirmed graph, not the draft), but start/finish resolved through `postEditMeta` via `resolveConfirmedEndpoints` (`postEditMeta`'s endpoints once post-edit has confirmed at least once, else `state.start`/`state.finish`) — `confirmPostEdit` never writes `state.start`/`state.finish` back, and both cards' renderers already draw start/finish this way (GitHub issue #303).

Marker lines shown per node (exact `PresetEndpoint` match via `presetEndpointsEqual`):
- `Start` / `Finish` / `Gen source` — `presetStart`/`presetFinish`/`presetGenSource`
- `Teleport <arrow> (target)` — from `presetTeleports`, direction arrow (`<->`/`->`/`<-`) same convention as post-generation; cross-floor target shows the floor label (`L{n}`), same-floor shows coordinates
- `Vertical passage <arrow> (L{n})` — from `presetVerticalPassages`, always floor-label target
- `Elevator (L{a}, L{b}, ...)` — from `presetElevators`, no arrow (always bidirectional), sorted/deduped floor list
- `Lock (in|out|both)` — from merged `lockedNodes`/`autoLockedNodes` (`"both"` for an auto-locked node), reported on the exact node addressed by the lock

These per-node marker lines are built by `buildPresetNodeMarkerLines`, itself a thin `entities.map(e => e.title)` adapter over `presetVertexMarkerEntities` (see "Entity delete/reset dialog" above) plus the lock line appended separately (locks aren't part of that shared marker-entity set) — the output is unchanged, only the implementation is now shared with the entity-delete dialog.

## Lifecycle

| Event | Effect |
|---|---|
| Tessellation confirmed (kind changes) | `presetConnections` cleared, markers cleared, `defaultEdgeState` reset, `presetSplitTargetPrompt`/`presetEntityDeletePrompt` dropped |
| `resetPresetConnections()` | Same as above, plus `presetTeleports`/`presetVerticalPassages`/`presetElevators` cleared and their id counters reset to `1` |
| Field cells added/removed | Connections stay; invalidity recomputed from field |
| Card opens | Renderer subscribes, cell cache built |
| Card closes | Renderer clears graphics; `highlightInvalidPresets` and `highlightIsolatedNodes` reset to `false` |
| Generate | Invalid connections filtered out, valid ones sent to WASM |
| `defaultEdgeState` changes | All `source:"default"` entries removed and repopulated; auto-lock recomputed |

When an existing teleport endpoint is dragged to another cell, its current floor is preserved;
moving to a different cell drops any split-node slot attached to the old cell.
