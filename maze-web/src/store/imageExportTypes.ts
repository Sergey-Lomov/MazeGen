import type { MarkerShape, OneWayPattern, TeleportGroupOverride, TeleportCornerStyle, TeleportConnectorStyle, TeleportArrowMode, ElevatorBadgeFontWeight } from "../pixi/renderers/types";

/** Registry id of a maze image-export rendering mode (see `Specs/image-export.md` and
 * `imageExportRegistry.ts`) — one entry per switcher item in the Image Export feature card. */
export type RenderModeId = "vector_by_walls" | "vector_by_corridors";

/** Registry id of a maze image-export output format (see `exportFormatRegistry.ts`) — one entry
 * per row in the Image Export feature card's format list, below the render-mode switcher. */
export type ExportFormatId = "png";

export type PngExportOutputMode = "digital" | "print";
export type PngCanvasMode = "edge_to_edge" | "margin_px" | "margin_cells" | "fixed_size";
export type PrintDensity = "screen_96" | "draft_150" | "print_300" | "high_600";
export type PaperSize = "a4" | "a3" | "a5" | "a2" | "a1" | "a0" | "letter" | "legal" | "tabloid" | "custom";
export type PaperOrientation = "portrait" | "landscape";
export type PrintAnchor = "top_left" | "top_center" | "top_right"
  | "center_left" | "center" | "center_right"
  | "bottom_left" | "bottom_center" | "bottom_right"
  | "custom";

export interface DigitalExportSettings {
  /** Multiplier of `TILE_SIZE` — same world-space unit as `PrintExportSettings.scale`. Kept as a
   * separate field (not shared) because the two output modes' scale are independent: switching
   * modes must not silently carry one over into the other. */
  scale: number;
  canvasMode: PngCanvasMode;
  /** Px (canvasMode=margin_px) or cells (canvasMode=margin_cells) — same field reused for both,
   * since only one of the two modes is ever active at a time. */
  marginValue: number;
  fixedWidth: number;
  fixedHeight: number;
}

export interface PrintExportSettings {
  density: PrintDensity;
  paperSize: PaperSize;
  /** Used only when paperSize === "custom" — otherwise the standard size overrides it. */
  customWidthMm: number;
  customHeightMm: number;
  orientation: PaperOrientation;
  marginHMm: number;
  marginVMm: number;
  /** Same world-space unit as `DigitalExportSettings.scale` — see its doc-comment. Ignored (kept
   * up to date but not user-editable) while `scaleAutoFit` is on. */
  scale: number;
  /** While on, `scale` is recomputed automatically (`computeAutoFitPrintScale`) on every change
   * that could affect the fit — sheet size/orientation/DPI, margins, or the maze itself — instead
   * of the user setting it by hand. The scale input is disabled in this state. */
  scaleAutoFit: boolean;
  anchor: PrintAnchor;
  /** Content offset in mm from the margin-inset area's top-left corner — only meaningful (and only
   * ever written) when `anchor === "custom"`, set automatically when the user pans/zooms the maze
   * under the on-canvas print frame (see `ExportFrameOverlay`) instead of picking one of the 9
   * fixed anchor positions. Ignored by `computePrintExportFit` for every other anchor value. */
  offsetXMm: number;
  offsetYMm: number;
}

/** PNG export settings — two independent output-mode branches (`digital`/`print`), only one
 * active at a time per `outputMode`, but both persisted so switching modes doesn't lose the
 * other's configuration. */
export interface PngExportSettings {
  outputMode: PngExportOutputMode;
  digital: DigitalExportSettings;
  print: PrintExportSettings;
}

/** Teleports section settings (GitHub issue #293, restructured in a follow-up that removed the
 *  standalone `"line"`/`"grouped"` pattern switch; GitHub issue #313 extracted this interface out
 *  of `VectorByWallsSettings` so `VectorByCorridorsSettings` can `extends` the exact same field set
 *  instead of duplicating it — teleports aren't tied to the corridor-vs-wall visual model, so the
 *  settings transfer as-is). `teleportLine*`/`teleportConnector*`/`teleportEdge*` ("Edges"/
 *  "Connector" subsections) are always the base look; `teleportConnectorStyle: "none"` draws no
 *  connector line at all. `teleportGroupCustomization` (its own subsection, off by default) layers
 *  a per-group shape/fill-color/border-color override on top wherever an endpoint coordinate
 *  coincides (see `buildTeleportGroups`) — combined with `connectorStyle: "none"` this reproduces
 *  the old standalone `"grouped"` pattern's look. `teleportGroupOverrides` holds those overrides,
 *  keyed by `TeleportGroup.key` (stable across renders, not across a maze regenerate/reload —
 *  entries for groups no longer present are simply never looked up again, not pruned). */
/** One decorative-style vertical-connection pictogram's line appearance (GitHub issue #428) — a
 *  stroke-only icon (stairs zigzag or elevator shaft box), no fill/border/gap concept the way
 *  `MarkerSettings` has. `size` is a fraction of the tile size (0-1), same convention as
 *  `MarkerSettings.size`. */
export interface DecorativeLineStyle {
  lineColor: number;
  lineWidth: number;
  size: number;
}

/** Numbering style for `ElevatorBadgeSettings.labelType` (GitHub issue #430) — each badge shows the
 *  reached floor's 1-based display number (`floor index + 1`) formatted per this style. */
export type ElevatorBadgeLabelType = "arabic" | "roman" | "letters";

/** Placement pattern for the badge ring around an elevator marker (GitHub issue #430). `"left_right"`/
 *  `"right_left"` both lay out **two** single rows, one to the left of the marker and one to the
 *  right (`"top_bottom"`/`"bottom_top"`: one column above, one below); the name's first half is the
 *  *leading* side — the one that fills first (see `ElevatorBadgeSettings.evenDistribution`) and
 *  gets the extra badge on an odd `evenDistribution` split. Each side's own row/column is capped at
 *  `slotsPerRow` badges (`elevatorBadgeLayout.ts`, accounting for `gap` between badges) — there is
 *  no second, farther sub-row: a side whose own floor count exceeds that capacity instead trips the
 *  `elevator_badges_too_many` export warning below (`elevatorBadgesTooMany`), same "flag it instead
 *  of drawing badges that visually break the layout" treatment `elevator_badges_overlap` already
 *  gives real geometric overlap. `"full_circle"` spreads badges around the marker's own circle at
 *  radius `distance` — see `ElevatorBadgeSettings.evenDistribution` for the two ring layouts. */
export type ElevatorBadgePlacement = "full_circle" | "left_right" | "right_left" | "top_bottom" | "bottom_top";

/** "Floor-number badges" (GitHub issue #430) — an independent decorative layer drawn on top of an
 *  `Elevator` marker, regardless of `verticalStyle` (abstract/decorative/realistic): one small
 *  badge per floor the elevator's fan actually reaches (`VerticalConnectionMarker.
 *  targetFloorIndices`), each showing that floor's 1-based display number. Applies to every
 *  `Elevator` marker uniformly — there is no per-elevator override, mirroring `elevatorMarker`
 *  itself. `size` is a fraction of the elevator marker's own radius (0-1), not the tile size —
 *  badges are always small relative to the marker they surround; font size scales proportionally
 *  with it (no fixed floor under the font size). `distance` is the badge center's own offset from
 *  the marker center, in px, on top of the marker's own radius (so `distance: 0` sits the badge's
 *  inner edge right at the marker's outer edge, not overlapping it). `gap` is the px space left
 *  between two adjacent badges' own edges (default `1`, never `0` — badges never touch by default)
 *  — used both for spacing along a row/column and, computed *before* any badge position (slot count
 *  first, then positions), for `slotsPerRow`'s own fit calculation, so a badge's own gap is never
 *  encroached on by a wrap/overflow decision made without accounting for it; also spaces badges
 *  along `"full_circle"`'s own ring when `evenDistribution` is off (see below) — otherwise unused
 *  for `"full_circle"`. `gapWidth` is a floor-colored ring drawn around each badge's own border
 *  (same convention as `MarkerSettings.gapWidth`, `0` the default drawing no gap) — purely a visual
 *  separation from whatever the badge sits over (the elevator marker, a wall, another decorative
 *  element), never counted toward `gap`'s own inter-badge spacing, so two adjacent badges' gap rings
 *  can still touch/overlap each other even while each is visually separated from its surroundings
 *  (GitHub issue #430 second follow-up: badges must never cut into *each other* with their own gap,
 *  only into the environment around the pair). `shape` is the badge's own outline (`MarkerShape`,
 *  same shapes `MarkerSettings` offers) — purely visual, no border of its own (badges never draw
 *  one). `cornerStyle` (`TeleportCornerStyle`) drives a polygon shape's corner rounding — seeded
 *  from `elevatorMarker.cornerStyle` when badges are first enabled, but its own independent field
 *  from then on (no live link back to the marker's setting, unlike `VectorByWallsSharedStyle`'s
 *  tracked-override mechanism — this is a one-time seed, not an ongoing follow). `evenDistribution`
 *  (default `true`, GitHub issue #430 follow-up) picks how badges pack: on, a two-sided placement
 *  splits the count in half between its two sides (leading side gets the extra badge on an odd
 *  split) and `"full_circle"` spreads badges evenly around the whole ring; off, a two-sided
 *  placement fills the *leading* side (the name's first half) up to `slotsPerRow` capacity before
 *  spilling any remainder onto the other side (ascending floor order preserved throughout, so it
 *  never round-robins) — unless that still leaves both sides over capacity, in which case it falls
 *  back to the even split (see `splitBadgeCount`'s own doc comment); `"full_circle"` instead lays
 *  badges out one after another `gap` apart (chord distance, like every other placement's `gap`)
 *  centered on the 12-o'clock mark — an odd count centers its middle badge there, an even count
 *  centers the gap between its two middle badges there — unless that contiguous arc would wrap past
 *  a full circle, in which case it too falls back to the even ring. */
export interface ElevatorBadgeSettings {
  enabled: boolean;
  labelType: ElevatorBadgeLabelType;
  size: number;
  placement: ElevatorBadgePlacement;
  distance: number;
  gap: number;
  gapWidth: number;
  cornerStyle: TeleportCornerStyle;
  evenDistribution: boolean;
  shape: MarkerShape;
  fillColor: number;
  textColor: number;
  fontWeight: ElevatorBadgeFontWeight;
}

/** "Vertical connections" section fields (GitHub issue #347) — `VerticalPassage`/`Elevator` edges
 *  (`Specs/generation.md`'s "Vertical Connections", GitHub issue #337) both draw as a single
 *  point-anchored marker on the edge's `from` node's own cell (never a connector line to another
 *  drawn point — the `to` node lives on a different floor, off this image entirely, see
 *  `selectFloorScopedMaze`). Two independent marker styles, `MarkerSettings`-shaped (same
 *  shape/cornerStyle/fillColor/borderColor/borderWidth/gapWidth/size fields the start/finish
 *  markers use) since both are always drawn as a plain marker shape here, never a connector. Three
 *  independent panel sections/marker settings (GitHub issue #347 follow-up), split by how the
 *  marker actually reads on the map, not just by `EdgeDto.kind`: `twoWayPassageMarker` for a
 *  two-way `VerticalPassage` (`direction` set but `filled: true` — no departure/arrival
 *  distinction), `oneWayPassageMarker` for a one-way `VerticalPassage` (`filled: false` — reads as
 *  a dark-accented variant of the ordinary marker at both ends, GitHub issue #347 fourth/fifth
 *  follow-up redesign: the arrival end draws the ordinary ("primary") fill with a `oneWayAccentColor`
 *  ("secondary") border, the departure end draws its entire fill in that same accent), and
 *  `elevatorMarker` for every `Elevator` (always two-way by construction, but visually distinct from
 *  a two-way `VerticalPassage` — its own shape/color, own section). Each has distinct defaults
 *  (shape/color) so all three read apart on the map without the user configuring anything;
 *  `cornerStyle`/`size`/`borderWidth`/`gapWidth` on all three follow "Shared style" (GitHub issue
 *  #322 follow-up) the same way `startMarker`/`finishMarker` do. `verticalStyle` picks one of three
 *  drawing treatments: `"abstract"` (the plain marker shape above — same look every other
 *  live-canvas renderer uses via its own fixed `VerticalConnectionStyle`, matching the issue's own
 *  "cut an opening here" build-marker rationale for a physical two-floor build), `"decorative"` (a
 *  small stairs illustration instead of the plain marker shape for `VerticalPassage`, meaningful
 *  only when the maze is printed as a set of separate per-floor images the viewer mentally
 *  connects), or `"realistic"` (reserved — no drawing implemented yet, falls back to `"abstract"`
 *  wherever a caller must actually render something). `Elevator` has no decorative treatment of its
 *  own (no natural "decorative elevator" illustration) and always renders as `elevatorMarker`,
 *  regardless of `verticalStyle`. Every marker draws a direction arrow on top of its own
 *  shape/stairs — `direction` is set for two-way markers too (GitHub issue #337/#347 design
 *  follow-up: a two-way connection still has a real "which floor(s)" to point at), drawn in the
 *  marker's own gap color so it reads as a cutout against the solid `filled: true` circle; a one-way
 *  `VerticalPassage`'s arrow now draws solid on both ends (GitHub issue #347 fourth follow-up —
 *  the old outline-only arrival arrow is redundant with `oneWayAccentColor`'s own border/fill
 *  distinction). Each
 *  section's own `*ArrowColor`/`*ArrowSize` (the latter a fraction of the marker's own radius, 0-1)
 *  colors/scales that section's own arrow independently.
 *
 *  `"decorative"` (GitHub issue #428) draws a line-based pictogram instead of the plain marker
 *  shape above, for `VerticalPassage` (a stairs zigzag, open polyline — no marker `shape`/fill/gap
 *  concept applies) and `Elevator` (a shaft box with a center doors-split line and two cable
 *  strokes above it) alike — unlike `"decorative"`'s effect on `VerticalConnectionRenderer`'s
 *  *older* single-shared-style draw (`drawStairsIcon`, pre-#428), `Elevator` now gets its own
 *  decorative look too since a line icon reads fine without a literal illustration the way a filled
 *  shape didn't (see the older no-decorative-elevator rationale above, which only ever applied to
 *  the filled-shape treatment). `decorative*` fields are a separate, line-oriented settings surface
 *  (`lineColor`/`lineWidth`/`size`) — deliberately not reusing `MarkerSettings`' fill/border/gap/
 *  shape fields, which have no meaning for an open stroke. Only the stairs pictogram draws a
 *  direction arrow (a dedicated "line parallel to the stairs" primitive, not `OneWayPattern` — an
 *  arrowhead pattern reads as a point indicator, not a direction-of-travel-along-a-line one): a
 *  two-way `VerticalPassage` draws it in `decorativeStairsArrowColor`; a one-way `VerticalPassage`
 *  draws it in `decorativeStairsAccentColor` at both ends, crossed-out at the arrival (`to`) end
 *  (mirrors `oneWayAccentColor`'s own from/to distinction, but as one shared color instead of a
 *  fill/border split — there's no fill to split here). The elevator pictogram never draws an arrow
 *  of its own, decorative or not. */
export interface VerticalSettingsFields {
  verticalStyle: "abstract" | "decorative" | "realistic";
  twoWayPassageMarker: MarkerSettings;
  oneWayPassageMarker: MarkerSettings;
  elevatorMarker: MarkerSettings;
  decorativeStairsTwoWay: DecorativeLineStyle;
  decorativeStairsOneWay: DecorativeLineStyle;
  decorativeElevator: DecorativeLineStyle;
  decorativeStairsArrowColor: number;
  decorativeStairsArrowSize: number;
  /** One-way stairs arrow color, both ends (GitHub issue #428) — mirrors `oneWayAccentColor`'s own
   *  from/to distinction but as one shared color, not a fill/border split (there's no fill on a
   *  line icon to split). */
  decorativeStairsAccentColor: number;
  twoWayArrowColor: number;
  twoWayArrowSize: number;
  /** Direction-arrow shape (GitHub issue #347 third follow-up) — same three patterns as the
   *  wall one-way indicator (`oneWayPattern`): `"arrow"` (line + arrowhead), `"triangle"`
   *  (filled), `"chevron"` (open `>` stroke). Reuses `drawOneWayArrow`/`drawOneWayTriangle`/
   *  `drawOneWayChevron` (`wallUtils.ts`) directly — the arrival end's outline look (previously a
   *  bespoke stroked-triangle draw) is now achieved the same way for all three patterns: the same
   *  shape drawn twice, a larger pass in the arrow color underneath, a smaller pass in the gap/
   *  floor color on top, reading as a colored outline without any real stroke-only draw path. */
  twoWayArrowStyle: OneWayPattern;
  /** Corner style for `twoWayArrowStyle` — `"round"`/`"miter"`, same convention as `oneWayJoin`:
   *  drives the filled triangle's own corner rounding, or the chevron/arrow's stroke join. */
  twoWayArrowCornerStyle: "round" | "miter";
  oneWayArrowColor: number;
  oneWayArrowSize: number;
  oneWayArrowStyle: OneWayPattern;
  oneWayArrowCornerStyle: "round" | "miter";
  /** One-way passage's "secondary" accent color (GitHub issue #347 fifth follow-up, simplified from
   *  the fourth follow-up's separate `oneWayEntryColor`/`oneWayExitColor`, which always meant the
   *  same accent anyway): the arrival end draws the ordinary ("primary") fill with its border
   *  recolored to this accent; the departure end draws its entire fill in this same accent, no
   *  separate border color. The "primary" color is just `oneWayPassageMarker.fillColor` itself. */
  oneWayAccentColor: number;
  elevatorArrowColor: number;
  elevatorArrowSize: number;
  elevatorArrowStyle: OneWayPattern;
  elevatorArrowCornerStyle: "round" | "miter";
  /** "Floor-number badges" (GitHub issue #430) — see `ElevatorBadgeSettings`'s own doc comment.
   *  Independent of `verticalStyle`: draws on top of `elevatorMarker`/`decorativeElevator` alike. */
  elevatorBadges: ElevatorBadgeSettings;
}

export interface TeleportSettingsFields {
  teleportLineCornerStyle: TeleportCornerStyle;
  teleportLineShape: MarkerShape;
  /** Marker radius, as a fraction of the tile size (0-1, GitHub issue #293 follow-up — matches
   *  `OneWayStyleOverride.size`'s convention, not a fixed pixel radius). */
  teleportLineSize: number;
  teleportEdgeColor: number;
  teleportEdgeBorderColor: number;
  teleportEdgeBorderWidth: number;
  /** Floor-colored gap ring drawn around the edge marker's border (GitHub issue #302), same
   *  convention as the waypoint marker's own `MarkerSettings.gapWidth` — `0` (the default) draws no
   *  gap. Color always mirrors `floorColor`, not independently settable. See
   *  `TeleportLineStyle.edgeGapWidth`'s own doc comment (`pixi/renderers/types.ts`) for the per-group
   *  draw-order rule this relies on. */
  teleportEdgeGapWidth: number;
  /** The connector line's own color/width — GitHub issue #293 follow-up renamed from
   *  `teleportConnection*` ("connector" is the settings panel's own term for it). */
  teleportConnectorColor: number;
  teleportConnectorWidth: number;
  /** `"none"` (no connector), `"straight"` (direct center-to-center) or `"orthogonal"`
   *  (single-bend, axis-aligned, with a local collision offset — see `teleportConnectorRouting.ts`). */
  teleportConnectorStyle: TeleportConnectorStyle;
  /** "Avoid field exit" toggle (GitHub issue #300, `"orthogonal"` connectors only) — off by default.
   *  When on, a candidate leaving the maze field's own cell footprint gets a top-priority penalty
   *  outranking every other routing weight (see `FIELD_EXIT_WEIGHT` in `teleportConnectorRouter.ts`),
   *  so a connector prefers any in-field detour over stepping outside the field. */
  teleportAvoidFieldExit: boolean;
  /** How a one-way connector draws its direction arrow(s) — see `TeleportArrowMode`. */
  teleportArrowMode: TeleportArrowMode;
  /** Tile-width period between arrows in `"periodic"` mode — unused (and hidden in the settings
   *  panel) otherwise. */
  teleportArrowPeriod: number;
  teleportArrowSize: number;
  /** Floor-colored gap drawn around the whole connector line (GitHub issue #302 follow-up rename
   *  from `teleportConnectorBorderWidth` — not a border around the connector's own fill, it's a
   *  visual separation gap from anything the connector crosses). `0` (the default) draws no gap,
   *  replacing a separate on/off toggle (GitHub issue #293 follow-up: "if it's not needed, just set
   *  it to zero"). */
  teleportConnectorGapWidth: number;
  /** Off by default — see this interface's own doc comment above. */
  teleportGroupCustomization: boolean;
  teleportGroupOverrides: Record<string, TeleportGroupOverride>;
}

/** One start/finish marker's appearance (GitHub issue #296) — `borderWidth: 0` (the default) draws
 *  no border, so there is no separate show-border toggle. */
export interface MarkerSettings {
  shape: MarkerShape;
  /** Sharp vs. round corners (GitHub issue #302 follow-up) — only affects the four
   *  regular-polygon `MarkerShape`s, same convention as `teleportLineCornerStyle`. */
  cornerStyle: TeleportCornerStyle;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Floor-colored gap drawn around the border (GitHub issue #302 follow-up) — `0` (the default)
   *  draws no gap, same convention as `teleportConnectorGapWidth`. Color always mirrors
   *  `VectorByWallsSettings.floorColor`, not independently settable. */
  gapWidth: number;
  /** Marker radius, as a fraction of the tile size (0-1) — same convention as
   *  `VectorByWallsSettings.teleportLineSize`. */
  size: number;
}

/** Which dependent fields of "Vector by walls" mode's `SharedStyle` currently hold a
 *  user-set value instead of following the shared setting (GitHub issue #322) — `true` marks an
 *  overridden field, absent/`undefined` means "still follows the shared value". Mirrors
 *  `TeleportGroupOverride`'s own sparse-optional-field convention, but keyed by dependent-field
 *  identity rather than by teleport group. */
export interface VectorByWallsSharedStyleOverrides {
  cornerStyle?: { wallJoin?: true; oneWayJoin?: true; startMarker?: true; finishMarker?: true; teleportLine?: true; twoWayPassage?: true; oneWayPassage?: true; elevator?: true; elevatorBadges?: true };
  markerSize?: { startMarker?: true; finishMarker?: true; teleportLine?: true; twoWayPassage?: true; oneWayPassage?: true; elevator?: true };
  markerBorderWidth?: { startMarker?: true; finishMarker?: true; teleportEdge?: true; twoWayPassage?: true; oneWayPassage?: true; elevator?: true };
  gapWidth?: { startMarker?: true; finishMarker?: true; teleportEdge?: true; teleportConnector?: true; twoWayPassage?: true; oneWayPassage?: true; elevator?: true };
}

/** "Vector by walls" mode's centralized marker/corner-style settings (GitHub issue #322) — one
 *  shared value per group of conceptually-related fields (cell/marker corner style, marker size,
 *  marker border width, gap width) that every dependent field in that group follows by default.
 *  Changing a dependent field directly (its own per-mode setter) marks it overridden in
 *  `overrides`, detaching it from the shared value until reset (the settings panel's own
 *  per-field reset button, mirroring `TeleportGroupRow`'s reset convention) or until "Force shared
 *  style" clears every override at once. `cornerStyle` drives two different underlying enums —
 *  `"sharp"` maps to `wallJoin`/`oneWayJoin`'s `"miter"` and to the marker/teleport-line
 *  `TeleportCornerStyle`'s own `"sharp"`; `"round"` maps to both enums' `"round"` — since the two
 *  enums mean the same visual intent (sharp vs. rounded corners) despite different value spellings. */
export interface VectorByWallsSharedStyle {
  cornerStyle: TeleportCornerStyle;
  markerSize: number;
  markerBorderWidth: number;
  gapWidth: number;
  overrides: VectorByWallsSharedStyleOverrides;
}

/** Same role as `VectorByWallsSharedStyleOverrides`, for "Vector by corridors" — its dependent
 *  field set differs (no `wallJoin`, has `join`/`oneWayJoin` instead; `gapWidth` also reaches
 *  `splitGapWidth`). */
export interface VectorByCorridorsSharedStyleOverrides {
  cornerStyle?: { join?: true; oneWayJoin?: true; startMarker?: true; finishMarker?: true; teleportLine?: true };
  markerSize?: { startMarker?: true; finishMarker?: true; teleportLine?: true };
  markerBorderWidth?: { startMarker?: true; finishMarker?: true; teleportEdge?: true };
  gapWidth?: { startMarker?: true; finishMarker?: true; teleportEdge?: true; teleportConnector?: true; split?: true };
}

/** Same role as `VectorByWallsSharedStyle`, for "Vector by corridors" (GitHub issue #322) — see
 *  that type's own doc comment for the shared-value/override/reset mechanics. */
export interface VectorByCorridorsSharedStyle {
  cornerStyle: TeleportCornerStyle;
  markerSize: number;
  markerBorderWidth: number;
  gapWidth: number;
  overrides: VectorByCorridorsSharedStyleOverrides;
}

/** The set of valid field names for one group `G` of one mode's `overrides` record `O` — e.g. for
 *  `VectorByWallsSharedStyleOverrides["cornerStyle"]` that's `"wallJoin" | "oneWayJoin" |
 *  "startMarker" | "finishMarker" | "teleportLine"`. Constrains `withOverride`/`withoutOverride`/
 *  `resetVectorBy*SharedStyleField`'s `field` parameter so a typo (e.g. `"wallJoinn"`) is a compile
 *  error instead of a silently-inert reset button (GitHub issue #322 follow-up — `field` was
 *  previously a bare `string`). */
export type SharedStyleField<O extends VectorByWallsSharedStyleOverrides | VectorByCorridorsSharedStyleOverrides, G extends keyof O> =
  keyof NonNullable<O[G]> & string;

/** "Vector by walls" mode's own settings (GitHub issue #289, floor color added in #290) —
 * background appearance and floor appearance ("general settings" and "floor" sections of #288's
 * panel). Defaults match the editor's normal grid/floor appearance (`canvas.stage.background`,
 * `canvas.grid.line`, `canvas.floor.default`) so the exported image looks identical to the editor
 * view until the user changes something. Kept as its own type (not folded into a shared per-mode
 * settings shape) since each render mode's settings are expected to differ entirely — a future
 * mode adds its own sibling `xxxSettings` field, not a new case of this type. */
export interface VectorByWallsSettings extends TeleportSettingsFields, VerticalSettingsFields {
  background: number;
  showGrid: boolean;
  gridColor: number;
  floorColor: number;
  /** Applied to every "wall"-colored stroke (solid walls, split-junction wall faces, closed-cells
   *  fill) via `WallStyleOverride` — never the `faint`/`background` `WallStyle` variants or a split
   *  passage's own node-identity color. See GitHub issue #291. */
  wallColor: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together (`round`->`round` cap,
   *  `miter`->`square` cap) when built into a `WallStyleOverride` in `VectorByWallsRenderer`. */
  wallJoin: "round" | "miter";
  wallThickness: number;
  /** One-way indicator drawn on a directed passage's wall segment — shape/color/gap/size/
   *  join/cap, applied via `OneWayStyleOverride` (`pixi/renderers/types.ts`) to `WallRenderer`'s
   *  plain wall one-ways only, never a split passage's connector arrow. Always has its own color
   *  (no fallback to `wallColor` — GitHub issue #292). */
  oneWayPattern: OneWayPattern;
  oneWayColor: number;
  /** Floor-colored gap around the indicator (GitHub issue #302 follow-up renamed from
   *  `oneWayBorderWidth` — not a real border, same convention as the marker/connector gap) —
   *  color always mirrors `floorColor`, not independently settable. */
  oneWayGapWidth: number;
  oneWaySize: number;
  /** Chevron/arrow's own line thickness — independent of `oneWaySize` (geometric scale). No
   *  effect on the `triangle` pattern. */
  oneWayThickness: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together, same convention as
   *  `wallJoin`/`wallCap` — applied to the indicator's own strokes (chevron/arrow lines, or a
   *  filled triangle's border stroke), independent of the Tiles section's wall join/cap. */
  oneWayJoin: "round" | "miter";
  startMarker: MarkerSettings;
  finishMarker: MarkerSettings;
  /** Splits section (GitHub issue #294) — per-split-node-slot identity colors, indexed by slot
   *  (0 = original node, 1 = first extra node, ...), overriding `splitSlotColor`'s default palette
   *  one-to-one; a point with more nodes than this array's length falls back to the default
   *  palette for the overflow slots. The settings panel sizes this array to the maximum split-node
   *  count actually present in the current maze (0 nodes when there's no maze/no split points),
   *  defaulting each slot's initial value to `splitSlotColor`'s own default so the exported image
   *  matches the editor's look until changed. */
  splitNodeColors: number[];
  /** On by default (mirrors `SplitJunctionRenderer.render`'s own default for every other
   *  split-drawing feature). When on, recognized degree-4 split topologies ("bridge": two nodes
   *  each a straight-through opposite-face pair; "diagonal divider": two nodes each an
   *  adjacent-face pair) draw as a dedicated shape (see `SplitSpecialShapeKind`) instead of the
   *  generic per-node segment/connector reading. */
  splitSpecialShapes: boolean;
  /** Centralized corner-style/marker-size/marker-border/gap settings (GitHub issue #322) — see
   *  `VectorByWallsSharedStyle`'s own doc comment. */
  sharedStyle: VectorByWallsSharedStyle;
}

/** One-way passage indicator settings (GitHub issue #312) — a row of chevrons ("`>`" shapes with
 *  no base) drawn as a break in the corridor curve, replacing the plain stroke there. `count`
 *  chevrons in a row, each `thickness` (stroke width) and `width` (extent across the corridor, as
 *  a fraction of `VectorByCorridorsSettings.thickness` — `1` spans the full corridor width, same
 *  0-1-fraction-of-a-size convention `MarkerSettings.size`/`TeleportSettingsFields.teleportLineSize`
 *  use), separated by `gap` (visible pixel gap between two adjacent chevrons' own stroked edges,
 *  along the corridor). `color` defaults to the canvas background (GitHub issue #312's own spec —
 *  reads as a gap cut into the corridor stroke, not an indicator drawn on top of it, unlike
 *  `VectorByWallsSettings.oneWayColor`'s always-own-color convention). */
export interface OneWaySettingsFields {
  oneWayColor: number;
  oneWayCount: number;
  oneWayThickness: number;
  oneWayGap: number;
  /** Fraction of the corridor's own `thickness` (0.01-1) — `1` (the default) spans the full
   *  corridor width. */
  oneWayWidth: number;
  /** Extent along the corridor's own direction, as a multiplier of the chevron's own full opening
   *  width (`oneWayWidth * VectorByCorridorsSettings.thickness`, GitHub issue #312 follow-up) —
   *  not an absolute pixel size, so the chevron's opening angle stays constant as `oneWayWidth`/
   *  `thickness` change instead of visibly flattening/sharpening on its own. `1` makes the chevron's
   *  length along the corridor equal to its own full opening width. */
  oneWayLength: number;
  /** Chevron corner/end style — round vs. sharp (miter) tip and ends, same convention as
   *  `VectorByWallsSettings.oneWayJoin`, independent of `VectorByCorridorsSettings.join` (the
   *  corridor stroke's own corner style). */
  oneWayJoin: "round" | "miter";
}

/** "Vector by corridors" mode's own settings (GitHub issue #310) — the corridor stroke's color,
 * width and corner/end style. Kept as its own type (not folded into `VectorByWallsSettings`), same
 * per-mode-settings convention as every other `RenderModeId`. Every basic passage draws as a
 * stroked line between the two cells' centers, with a one-way passage's own chevron-row indicator
 * (`OneWaySettingsFields`, GitHub issue #312) breaking that line; split points are skipped entirely
 * for now (their own follow-up sub-issue), same "empty until its own sub-issue" convention
 * `splitSpecialShapes` etc. followed in `VectorByWallsSettings`. Teleport edges (GitHub issue #313)
 * `extends TeleportSettingsFields` — teleports aren't tied to the corridor-vs-wall visual model, so
 * the settings and `TeleportRenderer` transfer as-is, same reuse convention as `startMarker`/
 * `finishMarker` (GitHub issue #311). */
export interface VectorByCorridorsSettings extends TeleportSettingsFields, OneWaySettingsFields {
  /** Background/grid section (GitHub issue #309) — same fields/defaults/behavior as
   *  `VectorByWallsSettings.background`/`showGrid`/`gridColor`, kept as its own copy rather than a
   *  shared sub-type since `VectorByWallsSettings` itself isn't factored that way either. */
  background: number;
  showGrid: boolean;
  gridColor: number;
  color: number;
  thickness: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together, same convention as
   *  `VectorByWallsSettings.wallJoin`/`wallCap`. */
  join: "round" | "miter";
  /** Start/finish marker appearance (GitHub issue #311) — same `MarkerSettings` shape and
   *  "Waypoints" section convention `VectorByWallsSettings` uses, reusing its settings-panel
   *  sub-component rather than duplicating it. */
  startMarker: MarkerSettings;
  finishMarker: MarkerSettings;
  /** Extra radius (px, world-space) added on top of a marker's own visible footprint when widening
   *  the corridor stroke under it (GitHub issue #311's `drawMarkerWidenPatches`) — without this, a
   *  marker with no border/gap has a widen patch exactly the same radius as its own fill, so the
   *  marker completely covers the patch and no widened corridor is visible around it. `0` draws no
   *  extra padding (patch radius = footprint exactly, marker still fully covers it). Lives in the
   *  "Cells" section, not "Waypoints" (GitHub issue #313 follow-up) — it also widens the corridor
   *  under teleport markers (see `buildTeleportWidenMarkers`), so it's a corridor-line concern, not
   *  a waypoint-only one. One shared setting for every marker kind on this canvas. */
  markerWidenPadding: number;
  /** Widen patch's own drawn shape (GitHub issue #313 follow-up), independent of `markerWidenPadding`
   *  — `"match_marker"` (the default, and the only behavior before this setting existed) draws each
   *  patch in that marker's own shape (`MarkerSettings.shape`/`MarkerShape`, per group override for a
   *  teleport point — see `buildTeleportWidenMarkers`). `"circle"`/`"square"` instead draw every
   *  patch (waypoint and teleport alike) in that one fixed shape regardless of the marker's own —
   *  `"square"`'s corners follow `join` (`round"`->rounded, `"miter"`->sharp), the same corner
   *  convention the corridor stroke's own join/cap already uses, rather than a separate corner-style
   *  setting just for this. */
  markerWidenShape: MarkerWidenShape;
  /** Splits section (GitHub issue #314) — per-split-node-slot identity colors, same convention as
   *  `VectorByWallsSettings.splitNodeColors` (indexed by slot, overriding `splitSlotColor`'s
   *  default palette one-to-one; a point with more nodes than this array's length falls back to the
   *  default palette for the overflow slots). Drawn as connector lines only (this mode has no wall
   *  segments to divide a face into shares) — see `VectorByCorridorsRenderer.drawSplitPassages`. */
  splitNodeColors: number[];
  /** On by default, same convention as `VectorByWallsSettings.splitSpecialShapes`. When on, a
   *  recognized degree-4 "bridge" split point draws its through corridor with a background-colored
   *  gap where the cross corridor passes over it (`splitGapWidth`), and a "diagonal" split
   *  point draws each node's connector as an outward-bowed arc (`splitDiagonalBowAmount`) instead
   *  of a straight line, so the two nodes' lines don't visually cross at the tile center. Off draws
   *  every split point via the generic per-node connector reading, same as any other split point. */
  splitSpecialShapes: boolean;
  /** Background-colored gap width (px) cut into a bridge point's through corridor where the cross
   *  corridor passes over it — only meaningful (and only shown in the settings panel) while
   *  `splitSpecialShapes` is on. `0` draws no gap (the two lines simply overlap with no visual
   *  break). Shared name/convention for any future split-drawing gap this render mode needs, not
   *  specific to the bridge shape by name. */
  splitGapWidth: number;
  /** How far a diagonal split point's two connector arcs bow away from the straight line between
   *  their own two shares, as a fraction of the tile size (0-1, same 0-1-fraction convention
   *  `MarkerSettings.size`/`teleportLineSize` use) — only meaningful while `splitSpecialShapes` is
   *  on. `0` draws a plain straight connector (the two nodes' lines would coincide at the tile
   *  center, same as the generic non-special reading). */
  splitDiagonalBowAmount: number;
  /** Centralized corner-style/marker-size/marker-border/gap settings (GitHub issue #322) — see
   *  `VectorByCorridorsSharedStyle`'s own doc comment. */
  sharedStyle: VectorByCorridorsSharedStyle;
}

/** See `VectorByCorridorsSettings.markerWidenShape`'s own doc comment. */
export type MarkerWidenShape = "circle" | "square" | "match_marker";

export interface ImageExportState {
  /** Currently active rendering mode in the Image Export feature card's switcher, or `null` if
   * the user hasn't picked one yet — a radio group with no default selection, not independent
   * toggles. */
  activeRenderMode: RenderModeId | null;
  /** Which mode's settings panel is open as a `SidePanel` beside the canvas, or `null` if none —
   * set by clicking the active switcher item (clicking an inactive item switches the active mode
   * instead, per the issue's interaction spec). Independent of `openCard`: closing the Image
   * Export card does not by itself clear this, but the panel only renders while the card is open
   * (see `ImageExportFeature.tsx`). */
  openRenderModeSettings: RenderModeId | null;
  /** Expanded/collapsed state per "Vector by walls" settings section, keyed by section id —
   * mirrors `AnalyticsOverlayState.analyticsSectionsExpanded`. */
  vectorByWallsSectionsExpanded: Record<string, boolean>;
  vectorByWallsSettings: VectorByWallsSettings;
  /** Expanded/collapsed state per "Vector by corridors" settings section, keyed by section id —
   * mirrors `vectorByWallsSectionsExpanded`. */
  vectorByCorridorsSectionsExpanded: Record<string, boolean>;
  vectorByCorridorsSettings: VectorByCorridorsSettings;
  /** Currently *selected* (clicked, not hovered — GitHub issue #293 follow-up) teleport connection
   *  group, by `TeleportGroup.key` — set either by clicking a row in the Teleports section's group
   *  list or by clicking that group's own marker(s) on the canvas (two-way selection sync). `Escape`
   *  or clicking empty canvas clears it. `null` when nothing is selected, meaning every group draws
   *  normally. */
  selectedTeleportGroupKey: string | null;
  /** Currently hovered export-warning list entry, by `ExportWarning.key` (GitHub issue #298) — set
   *  by hovering a warning row in the settings panel, drives `VectorByWallsRenderer`'s own warning
   *  highlight overlay. `null` when nothing is hovered. Mirrors `hoveredIssueLoopEdges`'s role for
   *  the Analytics feature's issue list, but keyed by warning identity rather than carrying raw
   *  edges/nodes directly, since the highlighted geometry is recomputed from
   *  `computeVectorByWallsWarnings`'s own result rather than duplicated into the store. */
  hoveredExportWarningKey: string | null;
  /** Which export format's settings panel is open as a `SidePanel`, or `null` if none — mirrors
   * `openRenderModeSettings`'s role for the render-mode switcher, but for the format list below
   * it. Independent state: opening one closes the other, since both share the same `SidePanel`
   * portal slot (`ImageExportFeature.tsx`). */
  openExportFormatSettings: ExportFormatId | null;
  pngExportSettings: PngExportSettings;
}

export interface ImageExportActions {
  setActiveRenderMode: (mode: RenderModeId) => void;
  setOpenRenderModeSettings: (mode: RenderModeId | null) => void;
  setOpenExportFormatSettings: (format: ExportFormatId | null) => void;
  setPngOutputMode: (mode: PngExportOutputMode) => void;
  setDigitalScale: (scale: number) => void;
  setDigitalCanvasMode: (mode: PngCanvasMode) => void;
  setDigitalMarginValue: (v: number) => void;
  setDigitalFixedSize: (width: number, height: number) => void;
  setPrintDensity: (density: PrintDensity) => void;
  setPrintPaperSize: (size: PaperSize) => void;
  setPrintCustomSize: (widthMm: number, heightMm: number) => void;
  setPrintOrientation: (orientation: PaperOrientation) => void;
  setPrintMargins: (marginHMm: number, marginVMm: number) => void;
  setPrintScale: (scale: number) => void;
  setPrintScaleAutoFit: (autoFit: boolean) => void;
  setPrintAnchor: (anchor: PrintAnchor) => void;
  /** Sets scale + offset together and switches `anchor` to `"custom"` in one update — used when
   * the user pans/zooms the maze under the on-canvas print frame (`ExportFrameOverlay`), where all
   * three values change together on every viewport move and must land in a single render, not
   * three separate ones. */
  setPrintCustomPlacement: (scale: number, offsetXMm: number, offsetYMm: number) => void;
  setVectorByWallsSectionExpanded: (id: string, expanded: boolean) => void;
  setVectorByCorridorsSectionExpanded: (id: string, expanded: boolean) => void;
  setVectorByCorridorsBackground: (color: number) => void;
  setVectorByCorridorsShowGrid: (v: boolean) => void;
  setVectorByCorridorsGridColor: (color: number) => void;
  setVectorByCorridorsColor: (color: number) => void;
  setVectorByCorridorsThickness: (v: number) => void;
  setVectorByCorridorsJoin: (join: "round" | "miter") => void;
  setVectorByCorridorsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsStartMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByCorridorsStartMarkerFillColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerSize: (v: number) => void;
  setVectorByCorridorsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsFinishMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByCorridorsFinishMarkerFillColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerSize: (v: number) => void;
  setVectorByCorridorsMarkerWidenPadding: (v: number) => void;
  setVectorByCorridorsMarkerWidenShape: (shape: MarkerWidenShape) => void;
  patchVectorByCorridorsOneWaySettings: (patch: Partial<OneWaySettingsFields>) => void;
  patchVectorByCorridorsTeleportSettings: (patch: Partial<TeleportSettingsFields>) => void;
  setVectorByCorridorsTeleportGroupOverride: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  setVectorByCorridorsSplitNodeColor: (index: number, color: number) => void;
  setVectorByCorridorsSplitSpecialShapes: (v: boolean) => void;
  setVectorByCorridorsSplitGapWidth: (v: number) => void;
  setVectorByCorridorsSplitDiagonalBowAmount: (v: number) => void;
  /** Sets the shared corner style and re-applies it to every non-overridden dependent field
   *  (`join`, `oneWayJoin`, `startMarker`/`finishMarker.cornerStyle`, `teleportLineCornerStyle`).
   *  See `VectorByCorridorsSharedStyle`'s own doc comment for the `"sharp"`/`"round"` -> `"miter"`/
   *  `"round"` mapping. */
  setVectorByCorridorsSharedCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByCorridorsSharedMarkerSize: (v: number) => void;
  setVectorByCorridorsSharedMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsSharedGapWidth: (v: number) => void;
  /** Clears the override flag for one dependent field of one shared-style group, re-applying that
   *  group's current shared value to it — the settings panel's own per-field reset button. `field`
   *  is constrained to that group's own valid field names (see `SharedStyleField`), so a typo is a
   *  compile error rather than a silently-inert reset button. */
  resetVectorByCorridorsSharedStyleField: <G extends keyof VectorByCorridorsSharedStyleOverrides>(
    group: G,
    field: SharedStyleField<VectorByCorridorsSharedStyleOverrides, G>,
  ) => void;
  /** "Synchronize" — clears every override across every group, re-applying all four shared values
   *  to every dependent field. */
  forceVectorByCorridorsSharedStyle: () => void;
  /** "Reset all settings" — restores the whole `vectorByCorridorsSettings` object (shared style
   *  included, overrides cleared) to its defaults. */
  resetVectorByCorridorsSettings: () => void;
  setVectorByWallsBackground: (color: number) => void;
  setVectorByWallsShowGrid: (v: boolean) => void;
  setVectorByWallsGridColor: (color: number) => void;
  setVectorByWallsFloorColor: (color: number) => void;
  setVectorByWallsWallColor: (color: number) => void;
  setVectorByWallsWallJoin: (join: "round" | "miter") => void;
  setVectorByWallsWallThickness: (v: number) => void;
  setVectorByWallsOneWayPattern: (pattern: OneWayPattern) => void;
  setVectorByWallsOneWayColor: (color: number) => void;
  setVectorByWallsOneWayGapWidth: (v: number) => void;
  setVectorByWallsOneWaySize: (v: number) => void;
  setVectorByWallsOneWayThickness: (v: number) => void;
  setVectorByWallsOneWayJoin: (join: "round" | "miter") => void;
  setVectorByWallsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsStartMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsStartMarkerFillColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderWidth: (v: number) => void;
  setVectorByWallsStartMarkerGapWidth: (v: number) => void;
  setVectorByWallsStartMarkerSize: (v: number) => void;
  setVectorByWallsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsFinishMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsFinishMarkerFillColor: (color: number) => void;
  setVectorByWallsFinishMarkerBorderColor: (color: number) => void;
  setVectorByWallsFinishMarkerBorderWidth: (v: number) => void;
  setVectorByWallsFinishMarkerGapWidth: (v: number) => void;
  setVectorByWallsFinishMarkerSize: (v: number) => void;
  /** `verticalStyle`/`oneWayArrowColor` — see `VerticalSettingsFields`'s own doc comment (GitHub
   *  issue #347). */
  patchVectorByWallsVerticalSettings: (
    patch: Partial<
      Pick<
        VerticalSettingsFields,
        | "verticalStyle"
        | "twoWayArrowColor"
        | "twoWayArrowSize"
        | "twoWayArrowStyle"
        | "twoWayArrowCornerStyle"
        | "oneWayArrowColor"
        | "oneWayArrowSize"
        | "oneWayArrowStyle"
        | "oneWayArrowCornerStyle"
        | "oneWayAccentColor"
        | "elevatorArrowColor"
        | "elevatorArrowSize"
        | "elevatorArrowStyle"
        | "elevatorArrowCornerStyle"
        | "decorativeStairsArrowColor"
        | "decorativeStairsArrowSize"
        | "decorativeStairsAccentColor"
      >
    >,
  ) => void;
  /** Patches one `DecorativeLineStyle` sub-object (`decorativeStairsTwoWay`/`decorativeStairsOneWay`/
   *  `decorativeElevator`) — GitHub issue #428, same "one setter per patchable sub-object" convention
   *  as the marker setters below, but a single patch call instead of one setter per field since a
   *  line style has no per-field "Shared style" override to track. */
  patchVectorByWallsDecorativeLineStyle: (
    section: "decorativeStairsTwoWay" | "decorativeStairsOneWay" | "decorativeElevator",
    patch: Partial<DecorativeLineStyle>,
  ) => void;
  /** Patches `elevatorBadges` fields other than `cornerStyle` (GitHub issue #430) — same
   *  single-patch-call convention as `patchVectorByWallsDecorativeLineStyle`, no per-field
   *  "Shared style" override to track. `cornerStyle` has its own setter below since it IS tracked
   *  (GitHub issue #430 follow-up — linked to "Shared style" like every other corner-style field). */
  patchVectorByWallsElevatorBadges: (patch: Partial<ElevatorBadgeSettings>) => void;
  /** Same "Shared style"-tracked convention as `setVectorByWallsElevatorMarkerCornerStyle` — marks
   *  the `cornerStyle` group's `elevatorBadges` field overridden before writing the value. */
  setVectorByWallsElevatorBadgesCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsTwoWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsTwoWayPassageMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsTwoWayPassageMarkerFillColor: (color: number) => void;
  setVectorByWallsTwoWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByWallsTwoWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByWallsTwoWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByWallsTwoWayPassageMarkerSize: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsOneWayPassageMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsOneWayPassageMarkerFillColor: (color: number) => void;
  setVectorByWallsOneWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByWallsOneWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerSize: (v: number) => void;
  setVectorByWallsElevatorMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsElevatorMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsElevatorMarkerFillColor: (color: number) => void;
  setVectorByWallsElevatorMarkerBorderColor: (color: number) => void;
  setVectorByWallsElevatorMarkerBorderWidth: (v: number) => void;
  setVectorByWallsElevatorMarkerGapWidth: (v: number) => void;
  setVectorByWallsElevatorMarkerSize: (v: number) => void;
  patchVectorByWallsTeleportSettings: (patch: Partial<TeleportSettingsFields>) => void;
  setVectorByWallsTeleportGroupOverride: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  setSelectedTeleportGroupKey: (key: string | null) => void;
  /** Sets slot `index`'s color, growing `splitNodeColors` (filling any new intermediate slots with
   *  `splitSlotColor`'s own default) if `index` is past the array's current end — see GitHub issue
   *  #294. */
  setVectorByWallsSplitNodeColor: (index: number, color: number) => void;
  setVectorByWallsSplitSpecialShapes: (v: boolean) => void;
  /** Sets the shared corner style and re-applies it to every non-overridden dependent field
   *  (`wallJoin`, `oneWayJoin`, `startMarker`/`finishMarker.cornerStyle`, `teleportLineCornerStyle`).
   *  See `VectorByWallsSharedStyle`'s own doc comment for the `"sharp"`/`"round"` -> `"miter"`/
   *  `"round"` mapping. */
  setVectorByWallsSharedCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsSharedMarkerSize: (v: number) => void;
  setVectorByWallsSharedMarkerBorderWidth: (v: number) => void;
  setVectorByWallsSharedGapWidth: (v: number) => void;
  /** Clears the override flag for one dependent field of one shared-style group, re-applying that
   *  group's current shared value to it — the settings panel's own per-field reset button. `field`
   *  is constrained to that group's own valid field names (see `SharedStyleField`), so a typo is a
   *  compile error rather than a silently-inert reset button. */
  resetVectorByWallsSharedStyleField: <G extends keyof VectorByWallsSharedStyleOverrides>(
    group: G,
    field: SharedStyleField<VectorByWallsSharedStyleOverrides, G>,
  ) => void;
  /** "Synchronize" — clears every override across every group, re-applying all four shared values
   *  to every dependent field. */
  forceVectorByWallsSharedStyle: () => void;
  /** "Reset all settings" — restores the whole `vectorByWallsSettings` object (shared style
   *  included, overrides cleared) to its defaults. */
  resetVectorByWallsSettings: () => void;
  setHoveredExportWarningKey: (key: string | null) => void;
}
