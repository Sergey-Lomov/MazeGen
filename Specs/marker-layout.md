# Marker layout (GitHub issue #735)

Positioning layer for several markers hosted by the same cell or the same split-tile node. Lives in
`maze-web/src/pixi/selectors/mazeSelectors/markerLayout.ts`; both vector export renderers run it.

## Scope

A **host** is one node position (`hostKey`, from `buildNodePositions`, so a split-tile node's hub point
is its own host). Markers sharing a host get distinct **slots**, in this order:

1. start / finish markers (`buildMazeMarkers`),
2. the teleport point (all teleport edges touching that node share ONE slot and move together; with `teleportMergeMode` off, `mergeTeleports: false`, every teleport end gets its own slot),
3. vertical-connection markers (`vertical_passage` / `elevator`).

A host with a single marker is untouched. Cross-floor teleport **badge** ends are never laid out — they
already carry their own collision relocation (issue #480).

## Settings

A flat field on both `VectorByWallsSettings` and `VectorByCorridorsSettings` (`MarkerLayoutSettingsFields`),
shown in each panel's "Shared style" section, sub-section "Marker overlap" (`MarkerLayoutRows`):

- `markerLayout`: `"auto" | "row" | "grid" | "radial" | "overlap"` (default `"radial"`; `"overlap"` skips the layer entirely — markers stack as before, no scaling). Plain enum, not link-registered.
- `markerScale`: number in 0..1 (default `0.6`, link-registered in `parameterLinksRegistry`; `markerLayout` is in `WALLS_PLAIN_PATHS`/`CORRIDORS_PLAIN_PATHS`). Shrink factor for every marker in a host with 2+
  markers; lone markers are untouched. All components scale together: fill, border, gap, caption text
  (baked into `MarkerData`), vertical-marker arrows/badges/hit area (`VerticalConnectionMarker.scale`, drawn
  inside a holder `Container` scaled about the marker position), teleport point border/gap
  (`TeleportEdge.fromScale`/`toScale`). Scaled radii feed the layout slots, the corridor widen patches and the
  `teleport_waypoint_overlap` warning. Marker index plates shrink with their marker too (`MarkerIndexLabel.scale`: plate size, offset, border, gap, corner radius and text).
The gap between neighboring markers is fixed (`MARKER_LAYOUT_SPACING` = 2 px) — not a setting.

## Arrangements (`computeLayoutOffsets`)

Pitch = `2 * maxFootprintRadius + MARKER_LAYOUT_SPACING`. `auto`: 2 → row, 3–4 → radial, 5+ → grid.

- **row** — horizontal, centered.
- **grid** — `ceil(sqrt(n))` columns, rows centered (a short last row is centered on its own).
- **radial** — on a circle, neighbors one pitch apart, first marker on top, clockwise.

The group is bounded: its outer edge must stay within `HOST_EXTENT_CELL` (half a tile) of the host, or
`HOST_EXTENT_SPLIT_NODE` (0.35 tile) for a split-tile node. Over-large groups have their offsets
scaled toward the center (markers may then overlap slightly, never leave the host).

## Renderer integration

`layoutExportMarkers` (`exportStyleBuilders.ts`) builds slot radii from the live styles (`verticalMarkerFootprint` lives in `VerticalConnectionRenderer.ts`) (start/finish
footprint, `teleportMarker`, per-kind vertical style incl. decorative) and returns laid-out copies; the
renderer then draws **only** from those copies (markers, teleports, vertical markers, avoidance
waypoints, group-override resolution, marker index endpoints). The geometry caches stay layout-free.
Marker index labels follow their marker (`shiftMarkerIndexLabels`).

### Vector by corridors

Per-marker widen patches follow the laid-out positions. `buildGroupBridgeMarkers` adds a circular
patch at the midpoint of every neighboring pair so the widened corridor is one continuous band through
the group.

## Fitting a host

A host bounds its group: `HOST_EXTENT_CELL` = 0.5 · tile, `HOST_EXTENT_SPLIT_NODE` = 0.35 · tile (measured from the
host center to the outer edge of the farthest marker). A group that does not fit first shrinks its markers further
(×0.9 steps, down to 0.3 of the requested scale), and only then are the centers squeezed together.

An explicitly configured `markerScale` of `1` is an exception: it preserves the markers' full size and squeezes only
their centers, so scale `1` matches the unscaled representation.

## Editor canvases

`GenerationRenderer`, `PostEditRenderer` and `MazeOverlayRenderer` run the same layer through
`layoutEditorMarkers`; `PresetConnectionsRenderer` (no `NodeDto` graph) uses `layoutEditorMarkersOnHosts` with split-node host keys from `buildPresetSplitHostKeys` (`presetSelectors.ts`) (`pixi/editorMarkerLayout.ts`) with fixed defaults (`DEFAULT_MARKER_LAYOUT_MODE` =
`"radial"`, `DEFAULT_MARKER_SCALE` = 0.6) — no settings there. Slot sizes come from the fixed editor teleport and
vertical styles; the laid-out copies feed the renderers and the teleport-connector avoidance waypoints.

## Export warnings

`teleport_waypoint_overlap` measures overlap on the laid-out positions, so a start/finish stacked on a
teleport point only warns when the layout could not separate them. Vertical markers are not inputs of
that warning and take no slot there.

## Size adaptation (#819)

Layout runs first, on base sizes. The `MarkerScaler` is then fitted on the laid-out copies (`footprintsOfMarkers` / `footprintsOfVertical` / `footprintsOfTeleports`), and the final radius is `adaptation factor * layout scale`.
Limits: slot radii in the layout ignore the adaptation factor, and corridor bridge patches use the layout radius without it.
`markerIndexPlateBox` applies `MarkerIndexLabel.scale`; `verticalMarkerFootprint` is exported from `VerticalConnectionRenderer.ts`.

## Known limits

Teleport connector routing keeps its clearance around a shrunken point at the full marker radius (no visible effect). In
`"overlap"` mode the `teleport_waypoint_overlap` warning still fires for stacked markers (nothing separates them).
Index labels anchor on the node's position from `buildNodePositions` (hub point on split tiles, GitHub issue #896), then take the layout shift. Index labels are paired with laid-out markers by `shiftKey(kind, nodeId)` (`MarkerIndexLabel.nodeId`; vertical markers use `fromNode`, teleport ends `fromNode`/`toNode`), not by position or order. With merged teleports every end node on the host shares the slot's shift; unmerged teleport ends are additionally keyed by the partner node (`MarkerIndexLabel.partnerId`) so several teleports on one node keep separate labels; a label without a partner match falls back to the bare node key (first end wins). The `teleport_waypoint_overlap` warning lays out only start/finish and teleport points (no vertical markers, and start/finish slots omit their gap), so it can differ slightly from the drawn layout.
