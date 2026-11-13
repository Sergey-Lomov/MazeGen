# Export-renderer warnings

This specification defines warnings that belong to the two image-export renderers:
`VectorByCorridorsRenderer` and `VectorByWallsRenderer`.

These are presentation warnings, not Quality Control issues. A maze may be valid and still
produce an export whose colors, labels, markers, or geometry are difficult to read. The warnings
are computed by the renderer-specific pure selectors in
`maze-web/src/pixi/selectors/exportWarnings.ts` (entry points, per-floor caching and merging; the warning groups in `exportWarningGroups.ts`; text fit in `exportTextFit.ts`,
contrast checks in `exportContrastWarnings.ts`, teleport/elevator checks in `exportTeleportWarnings.ts`, corridor-specific
checks in `exportCorridorWarnings.ts`) and are displayed in the corresponding export
settings panel.

## Common rules

- A warning is emitted only when the relevant element exists and is actually enabled/drawn in the
  current render mode.
- The warnings section is always visible in both export settings panels; its count is zero when no
  warnings are currently present.
- Warnings are computed across all floors. In a multi-floor project, warnings that affect several
  floors show floor badges; hovering a warning highlights only its affected elements on the
  currently active floor.
- A warning describes a visual problem; it does not modify settings automatically.
- The Problems section contains a persisted `showColorWarnings` switch, enabled by default. When
  disabled, all contrast/color warnings are hidden from the list; non-color warnings remain visible.
- Occurrences of one warning kind with the same actual color pair are collapsed into one warning
  entry. The entry carries all affected node ids and edge pairs for hover highlighting.
- If one warning kind is emitted for different actual color pairs, each pair gets its own warning
  entry, except for split colors compared with each other: all indistinguishable split-color pairs
  are one visual problem and are reported as one warning. The detailed description names one
  offending pair's semantic color roles and actual `#RRGGBB` values.
- A color warning means that the foreground and the surface directly beneath it are equal or too
  visually close according to the shared OKLab perceptual color distance. The current warning
  threshold is a distance below `0.04`, shared by all color warnings; it is not configured
  independently for each pair.
- A comparison involving a marker's gap/underlay color is made against the surface that the gap
  intentionally exposes. A gap that deliberately matches the underlying surface is not itself a
  warning.
- Warnings are mode-specific unless explicitly listed under **Both renderers**.

## Warning identity and ownership

Warning ids are stable string ids. They are export-warning ids, not QC check ids, and therefore do
not belong in the generated `qualityIds.ts` registry.

The implementation may group several visual roles under one warning id when they have the same
foreground/surface relationship. The description shown in the panel must still name the affected
roles precisely.

## Warning groups and recomputation (GitHub issue #928)

Every export warning belongs to exactly one **warning group** (`WarningGroup` in `exportWarningGroups.ts`; a mode's list is
`WALLS_WARNING_GROUPS` / `CORRIDORS_WARNING_GROUPS`). A group is a pure function of one floor's maze data (`WarningFloorEnv`) and of
the settings fields it reads, and declares the warning ids it may emit; no id appears in two groups of a mode, and a test checks both
that and that every emitted id is declared.

- **Dependency tracking.** `computeVector*WarningsAcrossFloors` runs each (mode, group, floor) under `trackedMemo`
  (`selectors/trackedMemo.ts`): the group reads the settings through a read-recording view, and its cached result is reused while every
  recorded read (leaf value, key set, `in` check) still holds in the new settings. A group never lists its own settings dependencies, and
  an edit to a field it does not read cannot recompute it — e.g. dragging a teleport connector control point
  (`manualTeleportConnectorPaths`) recomputes only the `teleportConnectors` group. Settings are immutable (replaced, never mutated, like the store's state); a
  group must keep no settings sub-object in its result (the tracker throws) and must not call `trackedMemo` itself (`inputMemo` is allowed).
- **Other inputs.** The cache key of every group is the maze (`nodes`, `edges`, `cfg`, effective `start`/`finish`), the floor ids in order
  (titles excluded), `hasGlues` and the group's own `hiddenInputs`: the text-overflow group adds the floor title and the loaded
  bitmap-font state (`textMetricsKey()`), the split color groups add whether a cut line separates seam mirrors on the floor. A group that
  reads any other state outside the settings must list it in `hiddenInputs`. Color checks read through `buildColorVisibility`, which is
  lazy (a reader of one color field subscribes to that field and the flags gating it, not to the whole settings).
- **Order.** The merged list is ordered group by group (the group list order), floors in order within a group; a group's own order is the
  order its warnings are emitted in. The uncached single-floor entry points (`computeVectorByWallsWarnings`,
  `computeVectorByCorridorsWarnings`) run the same groups in the same order; they are the uncached reference the tests compare the cache against,
  and nothing in the app calls them.
- **Merged list.** The per-floor lists are merged into one list per mode (`inputMemo` slot `merge:<mode>`, keyed on the maze nodes and the
  identity of every group's list): while every group hits, the same list object comes back, so a settings edit that touches no group costs
  no merge and gives the panel no new list to re-render on. The topology list is kept the same way. A returned list is shared: callers
  must not mutate it. The tracker keeps at most 4096 slots, least recently used first, and drops an evicted slot's counters with it.
- **Single-group entries.** `computeTeleportConnectorWarningsAcrossFloors` (the `teleportConnectors` group) and
  `computeTextOverflowWarningsAcrossFloors` (GitHub issue #971, the `textOverflow` group of either mode, used by the font picker) run
  one group through the same per-group slots as the full pass, so a consumer that needs one family of warnings computes no other group.
- **Adding a warning.** Put its id in exactly one group (a new group when no existing one reads the same settings fields), keep the group's
  `ids` list complete, and read settings only through the group's `settings` argument. Tests: `exportWarningCache.test.ts` (partition,
  warm-vs-cold equality under paranoid mode, recomputation).
- **Panel and hover share the cache.** The settings panel (`useExportPanelModel`) and both renderers' hover highlight (`ExportWarningHighlight`, which only draws the warnings it is given) call the same
  `*AcrossFloors` functions with the same `hasGlues` (`hasAnyGlue(floorTopology)`). `computeTextFitItemsAcrossFloors` is cached the same way.
- **Topology warnings.** The glue tab and edge mark warnings (`topologyWarnings.ts`) use the same mechanism through
  `TOPOLOGY_WARNING_GROUPS` (`glueTabs`, `edgeMarkers`, `seamAmbiguity`; slots `topology:<group>`). They concern the active floor's net, so
  a group's cache key is the store state it reads (`activeFloorId`, `activeFieldConfig`, `floorTopology`, `floorCreases`,
  `pngExportSettings`, `nodes`, `edges`, `floors`) instead of the maze data, and the settings are tracked the same way. The panel passes
  the whole mode settings and lists no settings fields; `TopologyWarningHighlight` calls the same function and shares the cache.

## Vector by corridors only

The corridor surface is `VectorByCorridorsSettings.color`; the canvas surface is
`VectorByCorridorsSettings.background`.

### Color/distinguishability warnings

| Warning | Foreground | Surface | Condition |
|---|---|---|---|
| One-way indicator vs corridor | `oneWayColor` | corridor `color` | At least one drawable one-way corridor segment exists. |
| Corridor vs background | corridor `color` | `background` | At least one corridor segment is drawn. |
| Teleport connector vs corridor | `teleportConnectorColor` (or the effective group connector color) | corridor `color` | At least one teleport connector is drawn and its connector gap is non-zero or the connector is otherwise directly visible on the corridor. |
| Teleport connector vs background | `teleportConnectorColor` (or the effective group connector color) | `background` | At least one connector end/segment is drawn on a floor, `teleportConnectorGapWidth === 0`, and the connector can run over the background. Cross-floor teleports are checked on both endpoint floors. |
| Split colors vs corridor | every effective `splitNodeColors[i]` used by a drawn split connector | corridor `color` | At least one corresponding split connector is drawn. One warning kind covers all affected split slots/connectors. |
| Split colors vs background | every effective split color | `background` | At least one corresponding split connector is drawn. |
| Split colors vs each other | every pair of effective split colors | another effective split color | At least one pair of split colors is too close. |

The teleport connector comparison is against the effective color after group overrides have been
resolved. A connector gap is not treated as a separate warning surface in corridor mode: the
connector gap uses the corridor color and is part of the deliberate separation from the corridor
network.

### Existing non-color warnings

- `one_way_arrows_overflow_corridor` — the configured one-way chevron row exceeds one cell along
  the corridor or exceeds the corridor width; only drawable one-way segments are included.
- `split_gap_may_shrink` — corridor thickness plus both sides of the split gap exceeds the safe
  split width, so the split gap may be reduced by the renderer.
- `marker_extension_hits_corridor` — a corridor-colored extension beneath a start or finish marker
  overlaps a rendered corridor that is not incident to that marker's node. The warning highlights
  only the marker cell.
- `teleport_marker_invisible` — an exit-only teleport endpoint has no visible border and its
  floor-colored outline fill leaves no visible marker.
- `teleport_group_ambiguous` — multiple teleport groups resolve to the same visible appearance
- `teleport_merged_without_connectors` — `teleportMergeMode` is on, teleports really share a cell, and `teleportConnectorStyle` is `none`; the merged marker shows no real links
  while connectors are disabled, so the groups cannot be told apart.
- `teleport_waypoint_overlap` — a teleport endpoint marker overlaps a start or finish marker.
- `teleport_connector_covers_one_way` — see **Both renderers**.
- `elevator_indistinguishable` — marker indices and elevator floor badges are both disabled and
  two distinct elevator shafts share one drawn cell.

## Vector by walls only

The floor surface is `VectorByWallsSettings.floorColor`; the wall surface is
`VectorByWallsSettings.wallColor`.

### Color/distinguishability warnings

| Warning | Foreground | Surface | Condition |
|---|---|---|---|
| Teleport connector vs floor | `teleportConnectorColor` (or the effective group connector color) | `floorColor` | At least one teleport connector is drawn over the floor. |
| Teleport connector vs wall | `teleportConnectorColor` (or the effective group connector color) | `wallColor` | At least one connector is drawn over wall geometry and `teleportConnectorGapWidth === 0`. |
| Split colors vs floor | every effective split-node color used by a drawn split connector/face | `floorColor` | At least one corresponding split element is drawn. One warning kind covers all affected split slots/elements. |
| Split colors vs each other | every pair of effective split colors | another effective split color | At least one pair of split colors is too close. |

### Additional decorative-style checks

Only when `verticalStyle === "decorative"`, compare each of the following with
`VectorByWallsSettings.floorColor`; each row is a separate warning kind:

- `decorativeStairsTwoWay.lineColor` — two-way vertical passage line;
- `decorativeStairsArrowColor` — two-way vertical passage arrow;
- `decorativeStairsOneWay.lineColor` — one-way vertical passage line;
- `decorativeStairsOneWayArrowColor` — one-way vertical passage arrow color;
- `decorativeElevator.lineColor` — elevator line.

In every Vector by walls style, compare `wallColor` with `floorColor` and emit a separate wall-vs-
floor warning when the colors are too close.

The teleport connector-vs-wall rule is intentionally gated by
`teleportConnectorGapWidth === 0`: with a non-zero floor-colored gap, the connector is separated
from the wall by design. The same wall-contact condition applies to the connector's effective group
color after group overrides.

The connector-vs-floor warning is not gated by connector gap width because the connector is normally
drawn over the floor and the floor remains the relevant base surface even when a gap exists.

### Existing non-color warnings

- `teleport_marker_invisible` — an exit-only teleport endpoint has no visible border and its
  floor-colored outline fill leaves no visible marker.
- `teleport_group_ambiguous` — multiple teleport groups resolve to the same visible appearance
- `teleport_merged_without_connectors` — `teleportMergeMode` is on, teleports really share a cell, and `teleportConnectorStyle` is `none`; the merged marker shows no real links
  while connectors are disabled.
- `teleport_waypoint_overlap` — a teleport endpoint marker overlaps a start or finish marker.
- `elevator_badges_overlap` — elevator floor-number badges overlap one another under the current
  placement and size settings.
- `elevator_badges_too_many` — a badge row exceeds its available per-side capacity. Slots under a marker-index
  plate are unavailable (GitHub issue #964), so a plate lowers the capacity of the side it sits on.
- `marker_text_overflow` / `elevator_badge_text_overflow` / `teleport_badge_text_overflow` (GitHub
  issue #707) — a start/finish caption, elevator floor-number badge or cross-floor teleport badge
  label does not fit its plate. Shared by both renderers. "Fits" means every point of the label's glyph-ink outline (boundary pixels of the baked MSDF
  atlas, `pixi/textFit.ts`; the glyph bounding rectangle when the atlas pixels can't be read),
  centred as the label is drawn, lies inside the plate's **actual shape** (circle, star, cross, ...;
  the allowed size therefore depends on `shape`) shrunk by the label's text margin (`textMargin`, px per side,
  0–10 in 0.5 steps, default 1; one field of `TextStyleFields` on every text, also in Shared style as `markerTextMargin`).
  Only labels that are actually drawn count:
  captions honor `markerEnabled`/`textEnabled`/non-empty `text` and need their endpoint on the floor, elevator
  badges need `elevatorBadges.enabled`, teleport badges need a visible connector. One warning per
  id; hover highlights the offending nodes (captions, elevator markers, with cross-floor targets)
  or cells (teleport badges).
- `marker_index_text_overflow` (GitHub issue #725) — a marker-index label does not fit its fixed
  `width` x `height` plate (same ink-outline rule and `textMargin` as the other text overflow
  warnings, against the rectangle). Only when `markerIndex.enabled`; hover highlights the plate cells.
- `floor_label_text_overflow` — a floor label does not fit its backplate (same ink-outline rule and
  `textMargin`). The label has no node or cell to highlight, so the warning carries the affected floors
  in `ExportWarning.floors` (merged across floors) and its bubble shows a floor badge per floor; there
  is no hover highlight.
- `marker_index_covers_stop_line` (GitHub issue #744) — a marker-index plate, border included,
  overlaps the stop line (wall tick) of a one-way vertical passage marker on the same floor. The
  plate body draws above the markers, so the overlap hides part of the line and that end of the
  passage becomes hard to tell apart from a two-way one. Checked against every plate on the floor,
  not only the passage's own. The plate's floor-colored gap ring is excluded (it draws under the
  markers). Abstract style: the tick's filled rounded rect; decorative stairs: the tick stroke with
  its round caps; no stop line exists for the `"sign"` arrow style. Rounded plate corners count
  exactly; shapes that only touch do not overlap. Geometry is shared with the renderers
  (`oneWayStopLineShape` in `renderers/verticalConnectionGeometry.ts`, `markerIndexPlateBox` in
  `selectors/mazeSelectors/markerIndex.ts`). Only when `markerIndex.enabled`; hover highlights the
  affected passage markers.
- `elevator_indistinguishable` — marker indices and elevator floor badges are both disabled and
  two distinct elevator shafts share one drawn cell.

## Both renderers

For the following rules, the base surface is the mode's primary surface:

- corridor `color` in Vector by corridors;
- floor `floorColor` in Vector by walls.

### Color/distinguishability warnings

#### Teleport connector covering a one-way indicator

`teleport_connector_covers_one_way` (GitHub issue #862): a drawn teleport connector, line plus its
floor-colored gap, passes over a one-way indicator. One-way indicators draw below the teleport layer,
so the covered passage reads as two-way. Not emitted when `teleportConnectorStyle === "none"`.

- The connector path is the one the renderer draws: the check rebuilds the renderer's marker layout,
  marker scaler and avoidance waypoints and routes with the same `routeTeleportConnectors`. It
  therefore also fires where routing cannot help (both teleport ends on the line through the
  indicator), and stays silent when routing already steered around it.
- An indicator counts as covered when its bounding circle is closer to the connector polyline than
  `connectorWidth / 2 + connectorGapWidth`. Walls: the circle is the indicator's own extent
  (`oneWayIndicatorSpan` without highlight padding). Corridors: the chevron row's length or width,
  whichever is larger.
- Hover highlights only the covered one-way passages (`nodes` and `edges` of each passage), not the
  teleport, using the same boundary highlight as the one-way corridor warnings.
- Teleport edges are taken without cross-floor badge spreading, like the other teleport warnings.
- A manually authored connector path (`manualTeleportConnectorPaths`, see `teleport_connectors.md`) is the path that is checked, so
  the warning disappears once the user routes the connector around the indicator by hand.

#### Teleport connector geometry (GitHub issue #945)

Warnings about how the drawn connectors look. They share one warning group with `teleport_connector_covers_one_way`
(`teleportConnectors`; one layout and one routing per floor, `buildTeleportConnectorContext`), are computed by
`computeTeleportConnectorWarnings` (`teleportConnectorWarnings.ts`) on the path the renderer draws (manual paths included), and
are not emitted when `teleportConnectorStyle === "none"`. Each id is one entry; hover highlights only the offending parts of the
connectors as `floorPolygons` (display space, one floor each, drawn by the mode renderer's `ExportWarningHighlight` for the floor it
shows), and carries no nodes, edges or cells. The highlight is a translucent fill plus an outline, a closed contour with softened
corners (quadratic curves, cut-in capped at half of each neighbouring edge, `POLYGON_HIGHLIGHT_RADIUS`). Because the group reads `manualTeleportConnectorPaths`, editing a manual path recomputes it.

- `teleport_connectors_overlap` — two connectors run along each other: a stretch of one at least 6 reaches long stays within the
  reach (half the connector width plus the gap) of the other's centerline, so the line drawn later hides the one below. Crossings
  at a large angle are not reported. The highlighted stretch is always measured along the connector drawn on top (draw order of
  `TeleportRenderer.renderGroups`).
- `teleport_connector_endpoint_detached` — the end of a **manual** connector lies farther from its marker center than the marker's
  drawn radius (fill, border and edge gap ring; a floor badge uses the badge's own). Automatic connectors always start on their
  marker. Highlights the end and the marker. Editing is not restricted; the warning is the only feedback.
- `teleport_connector_leaves_field` — `teleportAvoidFieldExit` is on and the drawn stroke (centerline offset by half the
  connector width plus gap, like the router's own check) leaves the union of the floor's cell polygons; applies to manual and
  automatic connectors of every style. A connector through a seam is checked on the centerline only. Highlights the part outside:
  one polygon per outside run (a lone inside sample between two outside ones does not split it), the outline of the stroke
  buffered by the same half-width plus gap, so both sides run parallel to the line; the inner side of a bend is mitered, the outer
  side is a round join.
- `teleport_connector_crosses_marker` — the line runs over a marker automatic routing avoids: a start/finish marker, a vertical
  passage marker or another connector's endpoint marker/floor badge (radius as drawn, including border and gap ring). The
  connector's own end markers are ignored. One-way indicators are covered by `teleport_connector_covers_one_way`; split junction
  hubs are not checked. Highlights the marker and the crossing segments.
- `teleport_connector_arrow_sticks_out` — a direction arrow (one-way connectors with arrows on) whose tip or tail center is off the
  line by more than half the connector width, e.g. a curved connector bending under the arrow or a line shorter than the arrow.
  Highlights the arrow.
- `teleport_connector_too_short_for_arrow` — a one-way connector with arrows on whose length minus the two end markers' drawn radii
  is under 1.5 × the arrow size (the arrow's tip-to-tail length). Highlights the connector's middle.
- `teleport_connector_covers_arrow` — the arrow of a one-way connector (arrows on) lies **under** another connector: that connector
  is drawn after it (group order, then connector order, as `TeleportRenderer.renderGroups` draws) and its line plus floor-colored
  gap (half the width plus the gap) reaches the arrow triangle. An arrow drawn above the other connector is fine and not
  reported; a connector's own arrows (a seam connector's two pieces included) are never checked against itself. Highlights the arrow.
- `teleport_connector_degenerate` — a connector shorter than its own width (both ends in one point). Highlights the point.

#### Grid vs background

Compare `gridColor` with `background` only when `showGrid === true` and the grid is actually
rendered. The warning is not emitted when the grid is disabled.

#### Marker fills and their base surface

For every enabled/drawn marker kind, compare its fill color with the mode's primary surface when
the marker has no border (`borderWidth === 0`). This covers:

- start marker;
- finish marker;
- teleport endpoint marker;
- vertical two-way passage marker;
- vertical one-way passage marker;
- elevator marker.

Teleport group overrides use their effective fill color. A one-way vertical passage's marker fill
is checked the same way as the two-way passage's — both ends draw the ordinary marker fill, with no
accent treatment of their own (GitHub issue #693).

#### Marker borders and their base surface

For every enabled/drawn marker kind, compare its border color with the mode's primary surface when
the marker has a non-zero border (`borderWidth > 0`). This covers the same marker kinds as the fill
rule, including effective teleport group border overrides and the one-way vertical passage's own
`borderColor` (same field and check as the two-way passage's).

The fill and border rules are mutually exclusive for each marker instance: zero-width borders use
the fill-vs-base check; non-zero borders use the border-vs-base check. The warning text names
`corridor color` in Vector by corridors and `floor color` in Vector by walls. Each warning carries only
the affected marker nodes, including multiple affected markers, so hover highlighting is local.

#### Text vs the surface directly beneath it

Every rendered text label is checked against the color directly behind its glyphs. This includes:

- teleport floor-badge text vs effective badge fill;
- elevator floor-badge text vs elevator badge fill;
- marker-index text vs marker-index plate fill.

If a label is rendered over another text/graphic layer, the comparison uses the final immediate
underlay defined by the renderer's draw order, not the canvas background. A text warning is emitted
only when the corresponding label is enabled and at least one label is drawn.

#### Vertical arrows vs vertical-marker fill

When `verticalStyle === "abstract"`, compare each vertical connection's arrow color with that
marker's fill color:

- two-way passage arrow vs two-way passage fill;
- one-way passage arrow vs one-way passage fill;
- elevator arrow vs elevator fill (with a dedicated elevator warning label).

One-way arrow-vs-fill is a separate warning from the two-way passage warning.

Decorative vertical styles are excluded from this rule because they use line pictograms rather than
the abstract marker-plus-arrow composition.

#### Elevator floor badge fill vs base surface

When `elevatorBadges.enabled === true` and at least one elevator badge is drawn, compare the
effective elevator badge fill with the mode's primary surface. Badge border and badge text are
covered by their own border/text rules; this rule concerns only the badge body.

Teleport floor-badge text is compared with the badge fill, and the effective teleport badge border
(including a customized group's border color) is compared with the mode's primary surface. These
warnings highlight the badge cell itself on each endpoint floor, not the teleport endpoint edges.
Elevator badge text warnings highlight only
the affected elevators; marker-index text warnings highlight only connections where an index is
actually rendered.

#### Different markers that look the same (GitHub issue #959)

`markers_look_alike` (group `markersLookAlike`, `exportMarkerLookAlike.ts`): markers of different kinds whose rendered look
matches, so a reader of the exported image cannot tell which is which. Kinds: start, finish, teleport, two-way vertical passage,
one-way vertical passage, elevator. Markers of **every floor** are compared with one another (a start on one floor and a finish on
another can still pass for each other), so the warning is computed once, by the first floor's pass (`projectMarkerLooks`). Only kinds
drawn somewhere take part (start/finish when set, teleport when a teleport exists, a vertical kind when such a marker exists).

- Two markers look alike when all hold: same `shape`; same `sizeAdaptation` and `size` within 15% of the bigger one (edge marks have the edge marker `size` and no adaptation); a border of the fill's own color (`hasLowContrast`) is invisible, so it is dropped and adds its width twice to the size (size 18 with border 1 is a borderless 20); fill colors closer than the shared color threshold (`hasLowContrast`); both
  have no border, or both have one and the border colors are close too; same inner elements. Inner elements are the start/finish
  caption (text and color, only when enabled and non-empty) and, for abstract vertical markers, the direction arrow (style, corner
  style, color). A one-way passage always has a stop line no other marker has. Gap and corner style of the marker itself do
  not count.
- A teleport group takes its override fill/border/shape into account. The two ends of a one-way teleport are separate looks: the entry is
  filled, the exit-only end is an outline (fill of the floor/corridor color) and takes part only with a border. Only the ends whose look
  matches are highlighted. Teleport groups are never compared with each other here
  (that is `teleport_group_ambiguous`); each is compared with the other kinds.
- Decorative vertical style is skipped (line pictograms differ by construction). Edge alignment marks are not part of this list: they are
  compared with these markers by `edge_marker_looks_like_marker` (see **Edge alignment markers**), and with each other by
  `edge_marker_colors_similar`.
- One entry per mode; `markerPairs` lists the alike kind pairs (merged across floors) and the description names them. Hover highlights
  the nodes of every marker in those pairs.

#### Invisible start / finish (GitHub issue #963)

While a start/finish marker is off (`markerEnabled === false`) its `startFill`/`startBorder` (`finishFill`/`finishBorder`) colour fields are hidden — their visibility is the schema's `active` rule of the matching panel row (`startMarker.fillColor` etc., GitHub issue #965), which `colorFieldRegistry.ts` evaluates — so no contrast warning reads them (`visibleColor` gives `null`); its caption is checked by `label_low_contrast` against the surface instead of the hidden fill.

`start_invisible` / `finish_invisible` (group `waypointInvisible`, both modes): the start (finish) of the floor draws nothing — no marker (`markerEnabled === false`, or size and border both `0`) and no caption (`textEnabled === false` or empty/blank `text`). One warning per endpoint, only when it is set on the floor; highlights its node. Checked by `isWaypointVisible` (`mazeSelectors/markers.ts`). In "Vector by walls" an endpoint whose external passage is on (any mode but `none`) and drawn (the cell has an outer side, GitHub issue #330) is visible even with no marker and no caption.

#### External passage without an outer wall (GitHub issue #330)

`start_opening_no_outer_wall` / `finish_opening_no_outer_wall` (group `waypointOpeningNoOuterWall`, "Vector by walls" only): the start (finish) external passage is on (`startOpening.mode` / `finishOpening.mode` is not `none`) but the endpoint's cell has no outer side (`listOuterFaces` is empty), so nothing is opened and no pointer is drawn. Titles: "No outer wall near the start/finish for the external passage". One warning per endpoint, only when it is set on the floor; highlights its node. See `Specs/image-export.md` ("Waypoint external passages").

### Existing non-color warnings shared by both renderers

- `teleport_marker_invisible`;
- `markers_look_alike`;
- `start_invisible`, `finish_invisible`;
- `start_opening_no_outer_wall`, `finish_opening_no_outer_wall` (walls only);
- `teleport_group_ambiguous`;
- `teleport_waypoint_overlap`;
- `teleport_connector_covers_one_way`;
- the teleport connector geometry warnings (`teleport_connectors_overlap`, `teleport_connector_endpoint_detached`,
  `teleport_connector_leaves_field`, `teleport_connector_crosses_marker`, `teleport_connector_arrow_sticks_out`,
  `teleport_connector_too_short_for_arrow`, `teleport_connector_covers_arrow`, `teleport_connector_degenerate`);
- `elevator_indistinguishable`;
- `marker_index_covers_stop_line`.

`elevator_badges_overlap` and `elevator_badges_too_many` remain Vector-by-walls-only because the
corridor renderer does not use the corresponding elevator badge layout warning path today.

### Teleport floor-badge contrast

Cross-floor teleport badges use their configured border color for contrast warnings only when
their effective border width is greater than zero. When the border width is zero, the warning
checks the badge fill color against the active surface instead. Group customization uses the
group's secondary color for the visible badge fill/border in both cases.

### Glue tab contrast (GitHub issue #901)

Both checks apply only while the glue tabs show (`glueTabs.showTabs`; the floor's glues are not checked):

- `glue_tab_outline_low_contrast_fill` — outline colour vs fill colour, only when the outline thickness is above zero;
- `glue_tab_fill_low_contrast_background` — fill colour vs background colour, only when the outline thickness is zero
  (with an outline, the outline sets the tab apart).

Fields: `glueTabFill`, `glueTabLine` (the latter hidden without an outline).

### Glue tab geometry (GitHub issue #913)

The checks look at the glue tabs of the active floor (`selectExportGlueTabs`) and apply only while the tabs show. They are
computed by `computeGlueTabWarnings` (`glueTabWarnings.ts`), outside the per-mode `compute*Warnings` (which have no tab
geometry), and, together with the edge mark warnings, appended to the mode's list by the panel (`useExportPanelModel`) through `computeTopologyWarnings` (`topologyWarnings.ts`).
None carries nodes, edges or cells; the first two carry `polygons` (the offending tabs, display space), the third `bands`.

- `glue_tabs_overlap` — two tabs overlap by more than a negligible depth (convex separating-axis test; touching edges or
  corners do not count). Highlights every tab that overlaps another.
- `glue_tab_too_thin` — the base of a tab (the part of the edge between the insets) is shorter than 10 display units (pixels at
  scale 1, `MIN_TAB_BASE`), independent of the output mode. An inset that leaves no tab at all has nothing to highlight and is not
  reported there (see `glue_tab_missing`). Highlights the thin tabs.
- `glue_tab_missing` — the inset leaves nothing of a glued stretch, so it gets no tab (`glueTabOn` is `null`; stretches
  that get none because a face is curved are not reported). Highlights the whole stretch the tab should have been on as
  `bands`: the faces of the side the tab would be drawn on (`selectExportGlueTabLayout`'s `missingEnds`, side B for the
  alternated ones), merged into one polyline per touching run by `mergedFacePolylines`, the glue editor's merging; for a
  glue with a cut line, the swallowed line span itself (`missingLines`).

### Edge alignment markers (GitHub issue #902)

Both checks look at the markers of the active floor (`selectExportEdgeMarkers`), with colours resolved through the parameter links for that floor (`edgeMarkerStyleOf`) and apply only while they show (`edgeMarkers.mode` is not `"hidden"`). They are computed by `computeEdgeMarkerWarnings` (`edgeMarkerWarnings.ts`), outside the per-mode `compute*Warnings`, and appended to the mode's list by `useExportPanelModel`. Neither carries nodes or edges; both carry `polygons` (the square around each offending marker, display space).

When alignment markers are hidden, `seam_matching_ambiguous_without_markers` (GitHub issue #920) is emitted when edge runs from different glues have the same visible wall/passage pattern (in either run direction) and lie in separate physical-net components. The components use only ordinary cell adjacency: maze walls, passages and the glues themselves do not connect them. Runs on the same connected piece of the net cannot be assembled with one another incorrectly and are ignored. It carries the ambiguous runs as display-space `bands`, and disappears as soon as alignment markers are shown, including in the `ambiguous` mode that marks exactly those runs.

### Highlight of the topology warnings

The hover highlight of the glue tab and edge mark warnings (`polygons`, `bands`) is not drawn by the mode renderers but by `TopologyWarningHighlight` (`pixi/imageExport/`, mounted by `MazeScene` in the layer above the cut sheet, after the crease overlay): these warnings concern the net itself, so the highlight is drawn in display space and never clipped to the cut region. It follows the cut transfer, though: the shape is drawn once per cut-plan offset whose shifted copy has its centre inside the plan's region (the copies the markers and tabs themselves are drawn in), so a half mark moved onto its twin line is highlighted there, not on the empty spot it came from. Without a cut plan the shape is drawn as is. It redraws from `computeTopologyWarnings` for the active mode when the hovered warning, the floor's geometry or the settings change. The mode renderers keep the maze highlights (nodes, cells, boundaries).

- `edge_marker_colors_similar` — two markers with different keys have the same shape and colours that are too close (`hasLowContrast`); a different shape alone avoids it. The cards of the markers show the same check. The two halves of a glue's marker share a key, so they are never compared. Highlights every indistinguishable marker with a rounded square (half side = marker radius + 4); a half marker gets only the half of it on its face's side of the edge.
- `edge_marker_looks_like_marker` (GitHub issue #959) — a mark is a plain filled shape (no border, no inner elements), so it passes for another kind of marker (start, finish, teleport, two-way/one-way passage, elevator; the kinds and the look of each are those of `markers_look_alike`, collected for the whole project by `stateMarkerLooks`, with start and finish at the effective endpoints that `computeTopologyWarnings` takes as an argument and keys its cache on) of the same shape whose fill is close to the mark's colour and which has no border and no inner element (caption, arrow). Each mark is compared on its own, so two marks of different colours can each match a different marker. The topology group reads the whole render mode's settings for this. Highlights the marks that look like another marker (same rounded square) and the markers they look like (by node: the topology highlight draws the marks, the mode renderers' cell highlight draws the nodes, which they find by key among their own warnings plus `computeTopologyWarnings`; nodes of other floors are skipped); the description names the pairs (`markerPairs`: alignment mark and the kind).
- `edge_marker_low_contrast_background` — a marker's colour is too close to the mode's background colour. Highlights those markers with the same rounded square.

## Explicitly out of scope

The following are not part of this warning set:

- grid-vs-anything checks other than grid vs background;
- comparisons between start and finish markers;
- comparisons between two teleport groups;
- comparisons between neighboring split colors (split colors are compared pairwise by the explicit
  split-color warning);
- automatic color correction or automatic setting changes;
- QC issue ids, generated quality registries, or WASM-side checks;
- decorative vertical pictograms, except for future warnings explicitly added to this spec.
