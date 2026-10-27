# MazeGen Highlighting

This document inventories all Pixi/canvas highlighting and the related UI-only highlight
states in `maze-web`. It distinguishes temporary highlighting (hover, issue, debug, or
selection feedback) from persistent content that may use the same drawing primitives.

## 1. Cell and boundary highlight styles

### 1.1. Full cell, no inset, no border

The complete tessellation cell is filled with a translucent color. The geometry uses
`inset: 0` and `borderWidth: 0`.

This is the cell-cursor style and must not be used for issue warnings, debug references,
debug values, or analytical regions.

Implementation: `CellFillRenderer` → `drawCellHighlight`.

Used by:

- the field editor cursor (`FieldEditorOverlay.updateHover`);
- the Preset Connections cell cursor (`PresetConnectionsRenderer.cellHover`);
- the Post-edit cell cursor (`PostEditRenderer.cellHover`);
- active-field and closed-cell fills, which are persistent content rather than hover
  highlights but use the same full-cell geometry.

### 1.2. Independent cell with inward inset

One cell is rendered independently. The shared inset is:

```text
inset = WALL_THICKNESS / 2 + 3
```

The fill is translucent and the default opaque border is `3 px`. Neighboring cells are
not merged: each target is passed as a singleton region group.

Implementation: `RegionHighlightRenderer` with `regionGroups: [[id], [id], ...]`, or
`CellFillRenderer` with a positive inset.

Used by:

- Analytics issue marker warnings: teleports, vertical passages, elevators, elevator
  stops, start/finish, and other point elements;
- Post-edit issue marker warnings;
- Analytics teleport warnings, which highlight both endpoint cells without a connector
  line;
- cross-floor Post-edit links, where only the endpoint on the active floor is available;
- single-cell debug `node` and `region` references;
- `frontier` and `reserve` debug values for the custom vertex-based generator;
- ordinary marker-cell export warnings;
- ordinary preset warning cells, except split-specific warnings.

### 1.3. Merged region with inward inset

Several cells are merged into one or more contours. Shared sides are removed and the
outer contour is built from exposed cell segments. The implementation supports L-shapes,
stepped shapes, holes, and square, hexagonal, and triangular tessellations.

Holes are represented by nested contours: outer contours are filled and inner contours
are cut out. The inset sign is reversed for holes so the wall gap remains consistent.

Cells that touch only at a corner point (e.g. two triangles arranged diagonally with a
gap between them) are never merged, even if they end up in the same region group: they
are only tessellation neighbors if they share a full edge, so a corner-only touch is
traced as two independent contours instead of one self-intersecting shape (GitHub issue
#618). Contour tracing groups a region's cells into edge-adjacency connected components
first and traces each component separately.

Implementation: `RegionHighlightRenderer` with multiple node ids in one region group.

Used by:

- debug values of kind `Region`, except custom vertex-based `frontier` and `reserve`;
- custom vertex-based `visited`;
- non-singleton Kruskal DSU groups;
- persistent Analytics regions (`RegionsRenderer` and `RegionClassesRenderer`);
- Analytics region issue warnings (`region_needs_expansion` and
  `region_needs_shrink`);
- ordinary region-like issue payloads such as undersized or oversized regions;
- any other caller that deliberately passes neighboring node ids as one group.

### 1.4. Merged split highlight with outward inset

Split cells are expanded outward so the highlight sits over/around the split tile walls.
Neighboring split cells are merged into a shared contour. The outward inset uses the
same magnitude as the normal cell inset:

```text
effectiveInset = -abs(getCellHighlightInset())
```

Used for all split-specific highlighting:

- Analytics and Post-edit split issue warnings;
- split route/tile warnings;
- split warnings in export rendering;
- orphan split-node warnings in Preset Connections;
- split point/tile paths that use the shared region renderer.

Split cells must be passed as one or more region groups. Independent `CellFillRenderer`
calls cannot merge adjacent split cells.

### 1.5. Shared boundary between neighboring cells

This style renders the actual shared tessellation edge, not a cell and not a line between
cell centers. It consists of a translucent strip and an opaque rounded border.

The quad is also inset from the shared edge's two endpoints along the edge's own tangent (GitHub
issue #627), using the same magnitude as the cell/region inward inset
(`getCellHighlightInset()`); the perpendicular span is untouched. This keeps the highlight from
reaching the corners where the boundary meets its neighbors, matching how inward-inset cell/region
highlights already pull back from walls. `clampBoundaryInset` (`wallUtils.ts`) clamps this inset to
`[0, edgeLength / 2 - 1]`, so it never goes negative (no outward variant of this style) and never
crosses the edge's own midpoint on a short edge.

The transverse span is derived from the entity geometry:

- The wall-vs-region/cycle merge logic for every `IssuePayload`/`IssuePayloadDto` kind (loop,
  teleport, one-way, split tile/route, region, vertical passage, elevator, elevator stop, missing
  elevator stops, cross-element group) lives in one place, `resolveIssueHighlight` in
  `maze-web/src/components/issueHighlight.ts` (GitHub issue #623) -- generic over `Id`
  (`number`/`bigint`) so Analytics' `IssuesBlock.tsx` (number/snake_case DTO) and the debug tree's
  `algorithmRegistry.ts` (bigint/EventLog `IssuePayload`, via `IssueHighlightTarget`) each normalize
  their own wire shape into a shared input type and call the same resolver, instead of maintaining
  two independently-drifting `switch` statements (the root cause of the #619 highlighting bugs).
  Each side still owns its own preset-lock (`showFullyPresetLockedIssues`) filtering before
  normalizing, since that's a per-check, per-payload-kind granularity concern unrelated to
  merge/inset/wall-vs-region shape.
- Analytics/Post-edit one-way issues use `oneWayIndicatorSpan(...)`, based on the active
  one-way renderer settings;
- Post-edit walls and passages use `WALL_HIGHLIGHT_SPAN`, which is the wall thickness
  plus the shared padding on both sides;
- the shared padding is `BOUNDARY_HIGHLIGHT_PADDING = 5 px` per side.

Implementation: `drawCellBoundaryHighlight` in `renderers/wallUtils.ts`. The wall-vs-line
split for a list of `{from, to, asWall}` edges (draw wall-style for `asWall` edges,
fall back to a line when the two endpoints aren't tessellation-adjacent, pass every
other edge through unchanged) is the shared `splitWallAndLineEdges` helper in the same
file — used by both `IssueHighlightOverlay` (Analytics) and `DebugRefHighlightOverlay`
(debug-tree `issue` refs) so the two draw identical wall geometry/thickness for a
one-way issue instead of two independently-drifting copies (GitHub issue #619 follow-up).

Used for:

- horizontal one-way issue warnings in Analytics;
- horizontal one-way entities in Post-edit;
- walls and passages in Post-edit;
- boundary warnings in Vector by Walls export rendering;
- a debug `issue` token's own one-way (`cycle.asWall`) member.

Vector by Corridors does not use this style for its one-way export warnings; it uses
style 1.3 on the `from/to` endpoint cells instead. Plain debug walls, passages, and
one-way edge/cycle references (not wrapped in an `issue` token) do not use this boundary
style — they use style 1.7 instead. A debug `issue` token's own `cycle.asWall` flag
(GitHub issue #377/#619 follow-up) does use this boundary style, matching Analytics'
`IssueHighlightOverlay` exactly (shared via `splitWallAndLineEdges` in `wallUtils.ts`).

### 1.6. Graph line between points or nodes

This is not a cell-area style. It draws a straight line between screen-space points,
optionally with a direction arrow.

Implementations: `EdgeHighlightRenderer` and `BaseGraphRenderer.drawEdge`.

Used for:

- Analytics loop issues;
- split routes when the issue describes a route rather than split tiles;
- debug edge references;
- debug cycle references;
- debug issue references, including wall/passage/one-way targets;
- graph overlays when the highlighted object is a connection rather than an area.

Analytics teleport issue warnings no longer use this style: they highlight endpoint cells.

### 1.7. Graph line with endpoint circles

This is a node-to-node variant: a line plus a filled circular marker at each endpoint.

Implementation: `NodeEdgeHighlightRenderer`.

Used for:

- debug event-tree edge/cycle references;
- link bubbles in Manage Split Nodes;
- link bubbles in Preset Connections;
- ordinary same-floor link entities in Post-edit.

For a cross-floor Post-edit link, the line is replaced by independent endpoint-cell
highlights on the active floor.

### 1.8. Direction variants

Direction arrows are variants of line or boundary highlighting, not separate area styles:

- a graph issue edge gets a midpoint arrow when its reverse directed edge is absent;
- a cross-floor graph edge gets an arrow on its badge stub;
- `EdgeHighlightRenderer` draws an arrow when `bidirectional === false`;
- a one-way boundary uses the one-way indicator geometry.

## 2. Debug-specific visual types

Debug values are selected by `DebugValueKind` and are not all cell-region highlights.

### 2.1. Region debug value

`DebugValueHighlightOverlay` uses `RegionHighlightRenderer`:

- ordinary region values: one merged inward-inset region;
- a one-cell value: style 1.2;
- custom vertex-based `frontier` and `reserve`: one singleton group per id, no merge;
- `visited`: merged inward-inset region.

The debug-reference layer is above the persistent debug-value layer.

### 2.2. Sequence debug value

`SequenceHighlightRenderer` draws an open arrow chain between consecutive ids in sequence
order and filled circles at the sequence nodes. It does not close the chain from the last
node back to the first.

Example: `recursion_stack`.

### 2.3. Map debug value

`MapHighlightRenderer` draws one independent directed arrow per `key -> value` pair and
filled circles at all used nodes. Pairs are not merged into one chain.

Example: Wilson `current_walk`.

### 2.4. Vertex debug value

`VertexHighlightRenderer` draws one enlarged filled circle at the current node id.

Examples: Wilson `walk_start` and `walk_head`.

### 2.5. Kruskal DSU overlay

`KruskalDsuHighlightOverlay` groups current DSU nodes by root, skips singleton groups,
and renders each non-singleton group as a separate colored merged inward-inset region.
The color is stable for a root id.

## 3. Applications by feature

### 3.1. Field Setup

`FieldEditorOverlay` contains:

- `hoverContainer`: current cursor cell, style 1.1;
- `floorContainer`: active field cells, persistent full-cell fill without border;
- `gridContainer`: grid, not a highlight;
- `originContainer`: origin marker, not a highlight.

Field-editing tools do not use cell inset or border for cursor hover. Field-area fills
also do not receive a highlight perimeter.

### 3.2. Preset Connections

`PresetConnectionsRenderer` contains these highlight layers:

- `cellHover`: cell-tool cursor, style 1.1;
- `splitPanelTarget`: the cell currently edited by the Preset split nodes panel, using full-cell
  geometry with no inset, a transparent fill, and yellow frame; it follows `presetFocusedPoint`
  and clears when the panel closes (GitHub issue #606);
- `hover`: wall/edge cursor, edge or boundary highlight;
- `linkHover`: panel link bubble, style 1.7;
- `isolatedHL`: isolated locked cells, independent inward-inset cells;
- `invalidMarkerHL`: invalid endpoint/marker cells, independent inward-inset cells;
- `orphanHL`: orphan split cells, merged outward-inset split region;
- `invalidHL`: thick invalid preset-edge highlight;
- normal preset walls, teleports, vertical markers, locks, origin, and generation source
  are regular content, not highlight layers.

Cell tools (`lock_in`, `lock_out`, `full_lock`, `gen_source`, and point tools) highlight
the cell under the cursor. Edge tools highlight the edge.

While a start/finish marker, teleport endpoint, vertical-passage endpoint, or elevator endpoint is
being dragged (GitHub issue #612), the cell cursor highlight follows the cursor for the whole
gesture — it is set to the origin cell when the drag begins and updated on every pointer move,
rather than staying fixed on the origin cell or being cleared until the drag ends.

### 3.3. Post-edit

`PostEditRenderer` contains:

- `cellHover`: cell-tool cursor, style 1.1;
- `splitPanelTarget`: the cell currently edited by the Manage split nodes panel, using the same
  full-cell geometry with no inset, a transparent fill, and yellow frame; it follows `postEditFocusedPoint`
  and clears when the panel closes (GitHub issue #606);
- `hover`: cursor edge/wall highlight;
- `linkHover`: same-floor link bubble, style 1.7;
- `entityHighlight`: point/points bubbles, independent inward-inset cell groups;
  multiple node ids belonging to one split point remain grouped in that same cell;
- `boundaryHover`: one-way, wall, and passage link entities, style 1.5;
- `teleportPreview`: temporary line from the fixed teleport endpoint to the cursor;
  this is preview geometry, not an issue highlight;
- `issueHighlight`: issue-bubble highlighting shared with Analytics.

`cellHover` follows the cursor while a start/finish marker, teleport endpoint, vertical-passage
endpoint, or elevator endpoint is being dragged, the same behavior as Preset Connections (see
3.2, GitHub issue #612).

Post-edit issue bubbles use:

- teleport endpoints: singleton cells, no connector line;
- vertical/elevator endpoints: singleton cells;
- split: merged outward-inset region;
- one-way: boundary highlight;
- region: merged inward-inset region;
- loop: graph line.

### 3.4. Analytics

`AnalyticsRenderer` uses:

- loop issues: red graph lines, optional direction arrows and cross-floor badges;
- teleport issues: red singleton endpoint cells, no direct line;
- vertical/elevator/marker issues: red singleton endpoint cells;
- one-way issues: red boundary highlight;
- split issues: red merged outward-inset region;
- region issues: red merged inward-inset region;
- `RegionsRenderer`: persistent colored merged SCC regions;
- `RegionClassesRenderer`: persistent merged regions by class color;
- region cross-floor markers: floor badges/stubs, not cell highlights;
- `PureCyclesOverlay`: persistent graph cycle paths/nodes;
- `RouteOverlay`: persistent route path/nodes;
- `MazeGraphRenderer` and `NavGraphRenderer`: graph content, not hover highlighting.

The Analytics region issue warnings are specifically `region_needs_expansion` and
`region_needs_shrink`. `excessive_scc_count` does not highlight a particular region.

A region highlight's outward-vs-inward inset is set explicitly per group by the caller
(`isSplit`, GitHub issue #619), from the payload kind that produced the group, never
guessed from the group's own geometry — a duplicate-node/cell heuristic can't detect a
multi-cell split tile with no literal duplicate. `hoveredIssueLoopEdges` and
`hoveredIssueRegionGroups` are independent, not mutually exclusive: an
`invalid_cross_element_group` bubble mixing a one-way member (wall) with a split/region
member sets both at once, and `IssueHighlightOverlay` renders them independently in the
same pass. The debug-tree `issue` token mirrors this exactly (`IssueHighlightTarget`'s
`cycle`/`region` fields in `algorithmRegistry.ts`, rendered by
`DebugRefHighlightOverlay`) so an issue reads identically in both views.

### 3.5. Image Export warnings

`ExportWarningHighlight` is shared by `VectorByWallsRenderer` and
`VectorByCorridorsRenderer`, but their one-way warning styles differ.

- ordinary marker/teleport/badge warning cells: independent inward-inset cells;
- split warnings: merged outward-inset regions;
- `one_way_low_contrast_corridor`, `one_way_arrows_overflow_corridor` and `teleport_connector_covers_one_way`:
  - Vector by Walls: boundary highlight, band as wide as the live one-way indicator (`oneWayIndicatorSpan`);
  - Vector by Corridors: merged inward-inset region for each warning `from/to` endpoint
    pair;
- warning `cells` for targets without node ids, such as cross-floor teleport badge cells:
  independent cell highlights using the warning's inset/outset style, without region merge;
- elevator badge warnings point at the affected marker cell; floor-navigation badges are
  not themselves warning highlights;
- PNG/sheet overflow warnings have no maze-cell highlight because they carry no maze
  node/cell geometry.

## 4. Persistent content that may look like highlighting

These layers use similar primitives but are not hover/issue/debug highlights:

- active-field and closed-cell fills;
- Analytics regions and region classes;
- graph and navigation graph overlays;
- pure-cycle and route overlays;
- normal teleports, passages, elevators, waypoints, locks, start/finish, and split
  markers;
- cross-floor floor badges;
- origin and generation-source markers;
- split junction and wall renderers;
- pending teleport preview.

Their visibility is controlled by feature settings or persistent state rather than a
hovered entity, issue, or debug reference.

## 5. UI-only highlights outside the Pixi canvas

The application also has ordinary React/CSS highlight states:

- hovered/selected rows in Analytics issue lists;
- hovered/selected teleport-group rows in Image Export settings;
- highlighted debug event-tree row and current-match row;
- selected parameter, rule, and nested-strategy rows;
- selected tool buttons and destructive/reset state;
- issue-bubble hover tint and severity colors;
- floor badges inside issue/debug bubbles.

These do not change Pixi scene geometry and must not be described as cell, region, or
boundary highlighting.

## 6. Owners and source files

| Responsibility | File |
|---|---|
| Shared cell geometry | `maze-web/src/pixi/cellHighlightGeometry.ts` |
| Full/single cell fill | `maze-web/src/pixi/renderers/CellFillRenderer.ts` |
| Merged regions, holes, inset/outset, borders | `maze-web/src/pixi/renderers/RegionHighlightRenderer.ts` |
| Shared boundary geometry | `maze-web/src/pixi/renderers/wallUtils.ts` |
| Shared issue-payload highlight resolution | `maze-web/src/components/issueHighlight.ts` |
| Plain graph line | `maze-web/src/pixi/renderers/EdgeHighlightRenderer.ts` |
| Line plus endpoint circles | `maze-web/src/pixi/renderers/NodeEdgeHighlightRenderer.ts` |
| Debug values | `maze-web/src/pixi/DebugValueHighlightOverlay.ts` |
| Debug event references/issues | `maze-web/src/pixi/DebugRefHighlightOverlay.ts` |
| Kruskal DSU | `maze-web/src/pixi/KruskalDsuHighlightOverlay.ts` |
| Analytics issue highlight | `maze-web/src/pixi/IssueHighlightOverlay.ts` |
| Analytics issue classification | `maze-web/src/components/IssuesBlock.tsx` |
| Export warning highlight | `maze-web/src/pixi/imageExport/VectorByWallsRenderer.ts` |
| Field cursor | `maze-web/src/pixi/FieldEditorOverlay.ts` |
| Preset cursor/warnings | `maze-web/src/pixi/PresetConnectionsRenderer.ts` |
| Post-edit cursor/entity/issues | `maze-web/src/pixi/PostEditRenderer.ts` |
| Post-edit entity classification | `maze-web/src/pixi/selectors/mazeSelectors/postEdit.ts` |

## 7. Invariants for new highlights

1. A cell cursor always uses a full cell with no inset and no border.
2. A singleton marker highlight does not pass neighboring cells as one region group.
3. A region highlight passes neighboring cells as one group and supports holes. Cells that
   only touch at a corner, not a shared edge, must trace as separate contours, never one
   merged shape.
4. A split highlight always uses a merged outward-inset region.
5. A boundary highlight is reserved for entities that are actual shared cell boundaries.
6. An Analytics teleport issue must not draw a direct connector line.
7. Plain debug walls, passages, and one-way edge/cycle references (not wrapped in an
   `issue` token) must not use boundary highlighting. A debug `issue` token's own wall
   member (`cycle.asWall`) does use boundary highlighting, matching Analytics.
8. Renderer settings must determine marker/one-way highlight geometry whenever the
   highlight mirrors the normal renderer.
9. Each feature owns its Pixi renderer instance; only pure geometry/selectors/primitives
   may be shared.
