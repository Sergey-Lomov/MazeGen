# Export-renderer warnings

This specification defines warnings that belong to the two image-export renderers:
`VectorByCorridorsRenderer` and `VectorByWallsRenderer`.

These are presentation warnings, not Quality Control issues. A maze may be valid and still
produce an export whose colors, labels, markers, or geometry are difficult to read. The warnings
are computed by the renderer-specific pure selectors in
`maze-web/src/pixi/selectors/exportWarnings.ts` and are displayed in the corresponding export
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
- `teleport_marker_invisible` — an exit-only teleport endpoint has no visible border and its
  floor-colored outline fill leaves no visible marker.
- `teleport_group_ambiguous` — multiple teleport groups resolve to the same visible appearance
  while connectors are disabled, so the groups cannot be told apart.
- `teleport_waypoint_overlap` — a teleport endpoint marker overlaps a start or finish marker.
- `waypoint_on_split` — a start or finish marker lands on a specially rendered split shape.
- `teleport_on_special_split` — a teleport endpoint lands on a specially rendered split shape.
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
  while connectors are disabled.
- `teleport_waypoint_overlap` — a teleport endpoint marker overlaps a start or finish marker.
- `waypoint_on_split` — a start or finish marker lands on a specially rendered split shape.
- `teleport_on_special_split` — a teleport endpoint lands on a specially rendered split shape.
- `vertical_on_special_split` — a vertical connection marker lands on a specially rendered split
  shape.
- `elevator_badges_overlap` — elevator floor-number badges overlap one another under the current
  placement and size settings.
- `elevator_badges_too_many` — a badge row exceeds its available per-side capacity.
- `marker_text_overflow` / `elevator_badge_text_overflow` / `teleport_badge_text_overflow` (GitHub
  issue #707) — a start/finish caption, elevator floor-number badge or cross-floor teleport badge
  label does not fit its plate. Shared by both renderers. "Fits" means every point of the label's glyph-ink outline (boundary pixels of the baked MSDF
  atlas, `pixi/textFit.ts`; the glyph bounding rectangle when the atlas pixels can't be read),
  centred as the label is drawn, lies inside the plate's **actual shape** (circle, star, cross, ...;
  the allowed size therefore depends on `shape`) of a plate 1 px smaller than `size` (safety margin).
  Only labels that are actually drawn count:
  captions honor `textEnabled`/non-empty `text` and need their endpoint on the floor, elevator
  badges need `elevatorBadges.enabled`, teleport badges need a visible connector. One warning per
  id; hover highlights the offending nodes (captions, elevator markers, with cross-floor targets)
  or cells (teleport badges).
- `elevator_indistinguishable` — marker indices and elevator floor badges are both disabled and
  two distinct elevator shafts share one drawn cell.

## Both renderers

For the following rules, the base surface is the mode's primary surface:

- corridor `color` in Vector by corridors;
- floor `floorColor` in Vector by walls.

### Color/distinguishability warnings

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

### Existing non-color warnings shared by both renderers

- `teleport_marker_invisible`;
- `teleport_group_ambiguous`;
- `teleport_waypoint_overlap`;
- `elevator_indistinguishable`.

`elevator_badges_overlap` and `elevator_badges_too_many` remain Vector-by-walls-only because the
corridor renderer does not use the corresponding elevator badge layout warning path today.

### Teleport floor-badge contrast

Cross-floor teleport badges use their configured border color for contrast warnings only when
their effective border width is greater than zero. When the border width is zero, the warning
checks the badge fill color against the active surface instead. Group customization uses the
group's secondary color for the visible badge fill/border in both cases.

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
