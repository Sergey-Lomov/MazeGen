import type { MarkerShape, OneWayPattern, VerticalArrowStyle, TeleportGroupOverride, CornerStyle, TeleportConnectorStyle, TeleportArrowMode, RandomWallColorMode } from "../pixi/renderers/types";
import type { MarkerLayoutMode } from "../pixi/selectors/mazeSelectors/markerLayout";
import type { IndexLabelStyle, LabelFontWeight } from "../pixi/renderers/indexLabel";
import type { FieldConfig } from "../fieldConfig";
import type { ParamLink, ParamModifier, ColorModifier } from "./parameterLinks";
import type { VectorByWallsParamPath, VectorByCorridorsParamPath } from "./parameterLinksRegistry";

/** Registry id of a maze image-export rendering mode (see `Specs/image-export.md` and
 * `imageExportRegistry.ts`) — one entry per switcher item in the Image Export feature card. */
export type RenderModeId = "vector_by_walls" | "vector_by_corridors";

/** Visibility policy for the per-field `LinkStatusIcon` (GitHub issue #652 follow-up) — see
 * `ImageExportState.linkIconVisibility`'s own doc comment. */
export type LinkIconVisibility = "always" | "linked" | "never";

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

/** Physical field-sizing inputs shared by Field Setup's print calculator and the PNG Print
 * settings. `cellSizeMm` is the square side or regular-polygon circumcircle diameter, and is
 * converted to `PrintExportSettings.scale` using the current print DPI. */
export interface PrintFieldSizingInput {
  paperSize: PaperSize;
  customWidthMm: number;
  customHeightMm: number;
  orientation: PaperOrientation;
  cellSizeMm: number;
  marginHMm: number;
  marginVMm: number;
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
 *  settings transfer as-is). `teleportMarker`/`teleportConnector*` ("Edges"/
 *  "Connector" subsections) are always the base look; `teleportConnectorStyle: "none"` draws no
 *  connector line at all. `teleportGroupCustomization` (its own subsection, off by default) layers
 *  a per-group shape/fill-color/border-color override on top wherever an endpoint coordinate
 *  coincides (see `buildTeleportGroups`) — combined with `connectorStyle: "none"` this reproduces
 *  the old standalone `"grouped"` pattern's look. `teleportGroupOverrides` holds those overrides,
 *  keyed by `TeleportGroup.key` (stable across renders, not across a maze regenerate/reload —
 *  entries for groups no longer present are simply never looked up again, not pruned). */
/** Shared label-style half of every badge-like consumer (GitHub issue #701) — start/finish marker
 *  captions, elevator badges and teleport floor badges all configure their text the same way:
 *  color, font weight, an **absolute** font size in px and a margin (not a fraction of the badge/marker
 *  diameter). `MarkerSettings` carries these optionally (only start/finish expose them in the UI);
 *  the badge settings require them. */
export interface TextStyleFields {
  textColor: number;
  textFontWeight: LabelFontWeight;
  /** Font size in px. */
  textSize: number;
  /** Margin in px (`TEXT_MARGIN_RANGE`, default `DEFAULT_TEXT_MARGIN`): how far the glyph ink must
   *  stay from the plate edge. Used by the overflow warnings and auto-fit only. */
  textMargin: number;
}

/** One decorative-style vertical-connection pictogram's line appearance (GitHub issue #428) — a
 *  stroke-only icon (stairs zigzag or elevator shaft box), no fill/border/gap concept the way
 *  `MarkerSettings` has. `size` is in px (GitHub issue #681), same convention as
 *  `MarkerSettings.size`. */
export interface DecorativeLineStyle {
  lineColor: number;
  lineWidth: number;
  size: number;
}

/** Numbering style for `ElevatorBadgeSettings.labelType` (GitHub issue #430) — each badge shows the
 *  reached floor's 1-based display number (`floor index + 1`) formatted per this style. Alias of
 *  the neutral `IndexLabelStyle` (shared with GitHub issue #471's marker index labels). */
export type ElevatorBadgeLabelType = IndexLabelStyle;

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
 *  `Elevator` marker, regardless of `verticalStyle` (abstract/decorative): one small
 *  badge per floor the elevator's fan actually reaches (`VerticalConnectionMarker.
 *  targetFloorIndices`), each showing that floor's 1-based display number. Applies to every
 *  `Elevator` marker uniformly — there is no per-elevator override, mirroring `elevatorMarker`
 *  itself. `size` is the badge fill's diameter in px (GitHub issue #701; the outer edge adds
 *  `borderWidth`); the font size is the independent absolute `textSize`. `distance` is the badge center's own offset from
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
 *  one). `cornerStyle` (`CornerStyle`) drives a polygon shape's corner rounding — seeded
 *  from `elevatorMarker.cornerStyle` when badges are first enabled, but its own independent field
 *  from then on (no live link back to the marker's setting, unlike the "Shared style" `ParamLink`
 *  mechanism's tracked-override — this is a one-time seed, not an ongoing follow). `evenDistribution`
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
export interface ElevatorBadgeSettings extends BadgeSettings {
  enabled: boolean;
  placement: ElevatorBadgePlacement;
  distance: number;
  gap: number;
  evenDistribution: boolean;
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
 *  distinction), `oneWayPassageMarker` for a one-way `VerticalPassage` (`filled: false` — draws the
 *  same ordinary fill/border as the two-way marker at both ends; GitHub issue #693 replaced the
 *  earlier accent-tinted fill/border redesign with a wall-tick indicator on the direction arrow
 *  itself, see `VerticalConnectionRenderer`), and `elevatorMarker` for every `Elevator` (always
 *  two-way by construction, but visually distinct from
 *  a two-way `VerticalPassage` — its own shape/color, own section). Each has distinct defaults
 *  (shape/color) so all three read apart on the map without the user configuring anything;
 *  `cornerStyle`/`size`/`borderWidth`/`gapWidth` on all three follow "Shared style" (GitHub issue
 *  #322 follow-up) the same way `startMarker`/`finishMarker` do. `verticalStyle` picks one of two
 *  drawing treatments: `"abstract"` (the plain marker shape above — same look every other
 *  live-canvas renderer uses via its own fixed `VerticalConnectionStyle`, matching the issue's own
 *  "cut an opening here" build-marker rationale for a physical two-floor build), or `"decorative"` (a
 *  small stairs illustration instead of the plain marker shape for `VerticalPassage`, meaningful
 *  only when the maze is printed as a set of separate per-floor images the viewer mentally
 *  connects). `Elevator` has no decorative treatment of its
 *  own (no natural "decorative elevator" illustration) and always renders as `elevatorMarker`,
 *  regardless of `verticalStyle`. Every marker draws a direction arrow on top of its own
 *  shape/stairs — `direction` is set for two-way markers too (GitHub issue #337/#347 design
 *  follow-up: a two-way connection still has a real "which floor(s)" to point at), drawn in the
 *  marker's own gap color so it reads as a cutout against the solid `filled: true` circle; a one-way
 *  `VerticalPassage`'s arrow draws solid on both ends and carries its own wall-tick indicator
 *  (GitHub issue #693, see `VerticalConnectionRenderer`). Each
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
 *  two-way `VerticalPassage` draws it in `decorativeStairsArrowColor`/`decorativeStairsArrowSize`;
 *  a one-way `VerticalPassage` draws it in `decorativeStairsOneWayArrowColor`/
 *  `decorativeStairsOneWayArrowSize` at both ends, crossed-out at the arrival (`to`) end — a
 *  line-icon analogue of the abstract marker's own wall-tick indicator (GitHub issue #693). The
 *  elevator pictogram never draws an arrow of its own, decorative or not. */
export interface VerticalSettingsFields {
  /** Render elevators spanning exactly two floors with the stairs settings instead. */
  replaceTwoFloorElevatorsWithStairs: boolean;
  twoWayPassageMarker: MarkerSettings;
  oneWayPassageMarker: MarkerSettings;
  elevatorMarker: MarkerSettings;
  twoWayArrowColor: number;
  twoWayArrowSize: number;
  /** Direction-arrow shape (GitHub issue #347 third follow-up) — same three patterns as the
   *  wall one-way indicator (`oneWayPattern`): `"arrow"` (line + arrowhead), `"triangle"`
   *  (filled), `"chevron"` (open `>` stroke). Reuses `drawOneWayArrow`/`drawOneWayTriangle`/
   *  `drawOneWayChevron` (`wallUtils.ts`) directly, plus `"sign"` for compact `+`/`-` markers — the
   *  arrival end's outline look (previously a
   *  bespoke stroked-triangle draw) is now achieved the same way for all three glyph patterns: the same
   *  shape drawn twice, a larger pass in the arrow color underneath, a smaller pass in the gap/
   *  floor color on top, reading as a colored outline without any real stroke-only draw path. */
  twoWayArrowStyle: VerticalArrowStyle;
  /** Corner style for `twoWayArrowStyle` — `"round"`/`"miter"`, same convention as `oneWayJoin`:
   *  drives the filled triangle's own corner rounding, or the chevron/arrow's stroke join. */
  twoWayArrowCornerStyle: CornerStyle;
  oneWayArrowColor: number;
  oneWayArrowSize: number;
  oneWayArrowStyle: VerticalArrowStyle;
  oneWayArrowCornerStyle: CornerStyle;
  elevatorArrowColor: number;
  elevatorArrowSize: number;
  elevatorArrowStyle: VerticalArrowStyle;
  elevatorArrowCornerStyle: CornerStyle;
  /** "Floor-number badges" (GitHub issue #430) — see `ElevatorBadgeSettings`'s own doc comment.
   *  Independent of `verticalStyle` on modes that have one — draws on top of `elevatorMarker`/
   *  `decorativeElevator` alike. */
  elevatorBadges: ElevatorBadgeSettings;
}

/** "Vector by walls"-only extension of `VerticalSettingsFields` (GitHub issue #428) — the
 *  "decorative" pictogram treatment (`verticalStyle: "decorative"`, a stairs zigzag/elevator shaft
 *  icon instead of the plain marker shape). "Vector by corridors" has no decorative treatment of its
 *  own (GitHub issue #348) — every vertical marker there always draws as the plain `MarkerSettings`
 *  shape, so `VectorByCorridorsSettings` extends `VerticalSettingsFields` alone, not this. */
export interface VerticalDecorativeFields {
  verticalStyle: "abstract" | "decorative";
  decorativeStairsTwoWay: DecorativeLineStyle;
  decorativeStairsOneWay: DecorativeLineStyle;
  decorativeElevator: DecorativeLineStyle;
  decorativeStairsArrowColor: number;
  decorativeStairsArrowSize: number;
  /** One-way stairs arrow color, both ends (GitHub issue #428, renamed from `decorativeStairsAccentColor`
   *  in issue #583 to match its actual role — it only ever draws the arrow, not a marker accent)
   *  — one shared color for both ends, no fill/border to split (there's no fill on a line icon to
   *  split, unlike the abstract marker's own former accent field). */
  decorativeStairsOneWayArrowColor: number;
  /** One-way stairs arrow size (GitHub issue #583), independent of `decorativeStairsArrowSize` —
   *  brings the one-way passage in line with the two-way passage's own dedicated Arrow subsection. */
  decorativeStairsOneWayArrowSize: number;
}

/** Cross-floor teleport floor-number badge appearance (GitHub issue #485) — a badge stands in for
 *  a teleport endpoint that lands on another floor (`drawFloorBadge`, see `Specs/floors.md`'s
 *  "Cross-floor teleport badges"). `shape`, `labelType`, `size`, `fillColor`, `borderColor`,
 *  `textColor`, `textFontWeight` and `textSize` (px) are all configurable (GitHub issue #503
 *  follow-up made the fill/border independent — they previously always followed the connector
 *  color; GitHub issue #701 unified the text style with the other badges). */
export type TeleportFloorBadgeSettings = BadgeSettings;

export interface TeleportSettingsFields {
  /** Teleport edge marker appearance (GitHub issue #701) — the same shape as the start/finish
   *  markers instead of the former flat `teleportLine*`/`teleportEdge*` fields. `gapWidth` is the
   *  floor-colored gap ring around the border (GitHub issue #302), same convention as the waypoint
   *  marker's gap — `0` draws no gap. See `TeleportLineStyle.edgeGapWidth`'s own doc comment
   *  (`pixi/renderers/types.ts`) for the per-group draw-order rule this relies on. Text fields are
   *  never set here yet (no caption UI for the teleport edge marker). */
  teleportMarker: MarkerSettings;
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
  /** Cross-floor teleport floor-number badge appearance (GitHub issue #485) — see
   *  `TeleportFloorBadgeSettings`. The settings subsection is hidden entirely when the project has
   *  no cross-floor teleport. */
  teleportFloorBadge: TeleportFloorBadgeSettings;
  /** Off by default — see this interface's own doc comment above. */
  teleportGroupCustomization: boolean;
  teleportGroupOverrides: Record<string, TeleportGroupOverride>;
}

/** The shared marker look (GitHub issue #701) — shape, corner style, fill/border colors, border and
 *  gap widths and size. Reused by every marker-like consumer: start/finish markers
 *  (`MarkerSettings`), the vertical-connection markers, the teleport edge marker and — through
 *  `BadgeSettings` — the elevator and teleport floor-number badges. */
export interface MarkerAppearance {
  shape: MarkerShape;
  /** Sharp vs. round corners (GitHub issue #302 follow-up) — only affects the four
   *  regular-polygon `MarkerShape`s. */
  cornerStyle: CornerStyle;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Floor-colored gap drawn around the border (GitHub issue #302 follow-up) — `0` (the default)
   *  draws no gap, same convention as `teleportConnectorGapWidth`. Color always mirrors
   *  `VectorByWallsSettings.floorColor`, not independently settable. */
  gapWidth: number;
  /** Marker diameter in px (GitHub issue #681 — previously a fraction of the tile size). */
  size: number;
}

/** One start/finish marker's appearance (GitHub issue #296) — the shared `MarkerAppearance` plus an
 *  optional free-text caption. `borderWidth: 0` (the default) draws no border, so there is no
 *  separate show-border toggle. */
export interface MarkerSettings extends MarkerAppearance, Partial<TextStyleFields> {
  /** Custom badge label (GitHub issue #697), e.g. a start/finish marker's "S"/"F". Empty/omitted
   *  draws no label. Currently restricted to a single glyph — UI input truncates to the first
   *  one and restricts to the baked MSDF charset (`tools/msdf/generate.mjs`), uppercased — but the
   *  field itself is not conceptually limited to one glyph. Optional since only
   *  `VectorByWallsSettings`/`VectorByCorridorsSettings`'s own `startMarker`/`finishMarker` offer
   *  this in the UI so far — the other `MarkerSettings` users simply never set it. */
  text?: string;
  /** "Show text" toggle (GitHub issue #697 follow-up) — lets `text` survive being hidden instead of
   *  clearing it, so re-enabling restores the same text. `undefined`/`true` draws the badge
   *  (matches pre-toggle behavior); `false` suppresses it. */
  textEnabled?: boolean;
  // `textColor`/`textFontWeight`/`textSize` come from `TextStyleFields` (all optional here).
  // Unset: `textColor` falls back to `gapColor`, weight to `"bold"`, size to
  // `DEFAULT_MARKER_TEXT_SIZE`.
}

/** A marker with a computed index label instead of a free-text caption (GitHub issue #701) — the
 *  shared base of the elevator floor-number badges and the cross-floor teleport floor badges: the
 *  `MarkerAppearance` look plus the required `TextStyleFields` and a `labelType` numbering style
 *  (the badge displays the target floor's 1-based number, formatted per `labelType`). */
export interface BadgeSettings extends MarkerAppearance, TextStyleFields {
  labelType: IndexLabelStyle;
}

/** Groups the four "Shared style" source values (GitHub issue #322, generalized by #643) — each is
 *  an ordinary linkable parameter in `VECTOR_BY_WALLS_PARAM_REGISTRY`/`VECTOR_BY_CORRIDORS_PARAM_
 *  REGISTRY` with no incoming link, driving whichever dependent fields `links` currently routes to
 *  it. Nothing structurally marks these four as "sources" — see `parameterLinks.ts`'s own doc
 *  comment. */
export interface SharedStyleSourceFields {
  /** GitHub issue #701: the "Markers" sub-section of "Shared style" carries every property all
   *  markers share — shape, corner style, size, fill/border color, border width, gap width. The
   *  shape and color sources only drive their (disabled-by-default) links. */
  markerShape: MarkerShape;
  cornerStyle: CornerStyle;
  markerSize: number;
  markerFillColor: number;
  markerBorderColor: number;
  markerBorderWidth: number;
  gapWidth: number;
  /** Shared label font size (px) and weight (GitHub issue #707) — drive every caption/badge text
   *  style through disabled-by-default links; the "Auto-fit" button picks the size. */
  markerTextSize: number;
  markerTextMargin: number;
  markerTextFontWeight: LabelFontWeight;
}

/** "Shared style" source values for the "Vertical connections" section (GitHub issue #668) — same
 *  no-incoming-link source convention as `SharedStyleSourceFields`, scoped to the three vertical-
 *  connection marker groups (`twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`) instead
 *  of the whole panel, since those three groups' own fields overlap far more with each other than
 *  with `startMarker`/`finishMarker`/teleport fields. Every link to these sources starts disabled
 *  (`parameterLinksDefaults.ts`), same as the panel-level "Shared style" links into this section's
 *  own fields — the three markers' defaults are pinned to `GenerationRenderer`'s fixed look, not
 *  this group. `borderColor` is deliberately excluded — a future follow-up could fold it in now
 *  that all three marker groups share the same ordinary fill/border semantics (GitHub issue #693
 *  removed the one-way marker's former accent-color distinction). */
export interface VerticalSharedStyleFields {
  verticalCornerStyle: CornerStyle;
  verticalShape: MarkerShape;
  verticalSize: number;
  verticalBorderWidth: number;
  verticalGapWidth: number;
  verticalFillColor: number;
  verticalArrowColor: number;
  verticalArrowSize: number;
  verticalArrowStyle: VerticalArrowStyle;
  verticalArrowCornerStyle: CornerStyle;
}

/** "Marker indices" settings (GitHub issue #471) — an independent decorative layer, drawn only in
 *  the two vector export modes, that links the two endpoints of every cross-floor connection
 *  (stairs / elevator / teleport) with a shared numeric index so the player can match entrance and
 *  exit across per-floor images. The index is drawn on a rectangular framed plate placed flush
 *  under the connection's own marker. Separate mechanism from the elevator floor-number badges
 *  (#430/#478) and the cross-floor teleport badges (#480), and not wired to "Shared style".
 *
 *  A connection's identity is direction-independent: a teleport / vertical passage is identified by
 *  its unordered endpoint node pair, an elevator by its connected component of `elevator` edges (an
 *  elevator fan spanning 3+ floors gets one index for the whole elevator). The `coverage` field
 *  filters which connection kinds are numbered at all — a disabled kind takes no index and the
 *  numbering closes up over what remains. The surviving connections are numbered `1..N` by a
 *  canonical order (endpoint `node.level`, then `nodeId`), stable under any input reordering.
 *
 *  `width` / `height` / `offset` / `cornerRadius` / `textSize` are all in px (GitHub issue #681 —
 *  previously a fraction of `TILE_SIZE`), same as `borderWidth` and `gap`. The plate is a fixed
 *  `width` x `height` rectangle that does not depend on the text (GitHub issue #725); a label that
 *  does not fit raises the `marker_index_text_overflow` export warning, and the font size has an
 *  "Auto-fit" button like every other text. */
export interface MarkerIndexSettings extends TextStyleFields {
  /** Off by default. */
  enabled: boolean;
  /** Arabic numerals / Roman numerals / letters — same three styles as `ElevatorBadgeLabelType`.
   *  Roman tends to stay legible at small font sizes. */
  labelStyle: IndexLabelStyle;
  /** Plate height in px, `MARKER_INDEX_MIN_HEIGHT` and up. */
  height: number;
  /** Distance the plate's *center* sits below the marker's own outer edge. `0` places the plate
   *  center exactly on the marker's bottom edge; the plate's own gap ring is drawn under the
   *  marker (draw order: plate gap, marker, plate body) so it never occludes the marker. */
  offset: number;
  /** Plate corner rounding radius (`0` = sharp corners). */
  cornerRadius: number;
  /** Fixed plate width in px (`MARKER_INDEX_WIDTH_RANGE`), independent of the label text. */
  width: number;
  /** Floor-colored gap ring drawn around the plate, in whole pixels (`0` = none) — same convention
   *  and unit as every other marker's gap ring, and a member of "Shared style"'s `gapWidth` group.
   *  Drawn *below* the connection marker so the plate never eats into it. */
  gap: number;
  fillColor: number;
  /** Plate border color. Ignored when `borderColorFromMarker` is on. */
  borderColor: number;
  /** When on (the default), the plate border takes its color from the connection marker it hangs
   *  off: that marker's own border color if the marker has a border (`borderWidth > 0`), else the
   *  marker's fill color. Disables the `borderColor` setting in the panel. */
  borderColorFromMarker: boolean;
  /** When on, the plate border thickness follows the connection marker and the own thickness
   *  setting is disabled in the panel. */
  borderWidthFromMarker: boolean;
  /** Whole pixels. `0` draws no border when `borderWidthFromMarker` is off. */
  borderWidth: number;
  /** "Coverage" sub-section — which connection kinds get an index plate. A `teleport` link counts
   *  as `singleFloorTeleport` when both endpoints share a `node.level`, `crossFloorTeleport`
   *  otherwise. Defaults: `singleFloorTeleport` off, the other three on (an index is chiefly
   *  useful when entrance and exit land on different floors). */
  coverage: MarkerIndexCoverage;
}

/** See `MarkerIndexSettings.coverage`. */
export interface MarkerIndexCoverage {
  singleFloorTeleport: boolean;
  crossFloorTeleport: boolean;
  verticalPassage: boolean;
  elevator: boolean;
}

/** "Vector by walls" mode's own settings (GitHub issue #289, floor color added in #290) —
 * background appearance and floor appearance ("general settings" and "floor" sections of #288's
 * panel). Defaults match the editor's normal grid/floor appearance (`canvas.stage.background`,
 * `canvas.grid.line`, `canvas.floor.default`) so the exported image looks identical to the editor
 * view until the user changes something. Kept as its own type (not folded into a shared per-mode
 * settings shape) since each render mode's settings are expected to differ entirely — a future
 * mode adds its own sibling `xxxSettings` field, not a new case of this type. */
/** Marker positioning layer (GitHub issue #735) shared by both vector renderers — arranges several
 *  markers (start/finish, teleport points, vertical-connection markers) hosted by one cell or one
 *  split-tile node. `markerLayout`: `"auto"` picks by count (2 row, 3-4 radial, 5+ grid), `"overlap"` skips the layer (markers stack, no
 *  shrink), the others force that arrangement; the gap between markers is fixed (`MARKER_LAYOUT_SPACING`). A host with a single marker is unaffected. See `Specs/marker-layout.md`. */
export interface MarkerLayoutSettingsFields {
  markerLayout: MarkerLayoutMode;
  /** Shrink factor in (0, 1] for every marker in a host with 2+ markers; all marker components
   *  (shape, border, gap, arrows, text) scale together. `1` = no shrink. */
  markerScale: number;
}

export interface VectorByWallsSettings extends MarkerLayoutSettingsFields, TeleportSettingsFields, VerticalSettingsFields, VerticalDecorativeFields, SharedStyleSourceFields, VerticalSharedStyleFields {
  /** "Vertical connections" shared-style source for the "decorative" style's line color/width
   *  (`decorativeStairsTwoWay`/`decorativeStairsOneWay`/`decorativeElevator.lineColor`/`lineWidth`) —
   *  "Vector by corridors" has no decorative treatment (see `VerticalDecorativeFields`), so these
   *  live directly here rather than in `VerticalSharedStyleFields`. Same reasoning for
   *  `verticalDecorativeSize`/`verticalDecorativeArrowSize`, decorative-only counterparts of
   *  `VerticalSharedStyleFields.verticalSize`/`verticalArrowSize`: the decorative style's "size" is
   *  the stairs line's length and its "arrow size" is the arrow drawn along that line, visually
   *  unrelated to the abstract marker's own radius/internal arrow (GitHub issue #677 follow-up) —
   *  sharing one field across both meanings is what produced the duplicate-looking fields the issue
   *  reported in the first place. */
  verticalDecorativeLineColor: number;
  verticalDecorativeLineWidth: number;
  verticalDecorativeSize: number;
  verticalDecorativeArrowSize: number;
  background: number;
  /** Original viewport grid, drawn behind the maze. */
  showGrid: boolean;
  gridColor: number;
  /** Optional grid overlay drawn over the active floor's maze cells. */
  showInnerGrid: boolean;
  innerGridColor: number;
  floorColor: number;
  /** Applied to every "wall"-colored stroke (solid walls, split-junction wall faces, closed-cells
   *  fill) via `WallStyleOverride` — never the `faint`/`background` `WallStyle` variants or a split
   *  passage's own node-identity color. See GitHub issue #291. */
  wallColor: number;
  /** Optional diagnostic palette for solid wall strokes; omitted by old project files and treated as
   *  `"off"`. Colors are deterministic and contrast-controlled against floor/background. */
  randomWallColorMode: RandomWallColorMode;
  /** Drives both the pixi stroke `join` and the derived `cap` together (`round`->`round` cap,
   *  `miter`->`square` cap) when built into a `WallStyleOverride` in `VectorByWallsRenderer`. */
  wallJoin: CornerStyle;
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
  /** Indicator size, in px (GitHub issue #681 — previously a fraction of the tile size). */
  oneWaySize: number;
  /** Chevron/arrow's own line thickness — independent of `oneWaySize` (geometric scale). No
   *  effect on the `triangle` pattern. */
  oneWayThickness: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together, same convention as
   *  `wallJoin`/`wallCap` — applied to the indicator's own strokes (chevron/arrow lines, or a
   *  filled triangle's border stroke), independent of the Tiles section's wall join/cap. */
  oneWayJoin: CornerStyle;
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
  /** Generic parameter-link graph (GitHub issue #643, generalizing #322's fixed "Shared style"
   *  groups) — `source`/`target` reference `VectorByWallsParamPath`s, `enabled: false` meaning
   *  `target` currently holds a manually-set value instead of following `source` (the old
   *  "override" state). Seeded from `DEFAULT_VECTOR_BY_WALLS_LINKS`; persisted verbatim only when
   *  it deviates from that default (GitHub issue #651) — see `parameterLinksEngine.ts`'s
   *  `linksMatchDefaults` and `projectExport/types.ts`'s `vectorByWallsLinks`. */
  links: ParamLink<VectorByWallsParamPath>[];
  /** "Marker indices" (GitHub issue #471) — see `MarkerIndexSettings`'s own doc comment.
   *  Independent layer, not part of "Shared style". */
  markerIndex: MarkerIndexSettings;
}

/** One-way passage indicator settings (GitHub issue #312) — a row of chevrons ("`>`" shapes with
 *  no base) drawn as a break in the corridor curve, replacing the plain stroke there. `count`
 *  chevrons in a row, each `thickness` (stroke width) and `width` (extent across the corridor, as
 *  a fraction of `VectorByCorridorsSettings.thickness` — `1` spans the full corridor width;
 *  deliberately kept relative to the corridor's own thickness rather than converted to px, unlike
 *  `MarkerSettings.size`/`TeleportSettingsFields.teleportMarker.size` — GitHub issue #681), separated
 *  by `gap` (visible pixel gap between two adjacent chevrons' own stroked edges, along the
 *  corridor). `color` defaults to the canvas background (GitHub issue #312's own spec —
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
  oneWayJoin: CornerStyle;
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
export interface VectorByCorridorsSettings extends MarkerLayoutSettingsFields, TeleportSettingsFields, OneWaySettingsFields, VerticalSettingsFields, SharedStyleSourceFields, VerticalSharedStyleFields {
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
  join: CornerStyle;
  /** Which corridor-drawing algorithm renders this mode's corridor network (GitHub issue #510),
   *  independent of `join` (each style applies its own round/miter behavior). `"contour"` (the
   *  default) draws each tile as one filled shape (`buildCorridorContour`/`vectorByCorridorsContour.ts`,
   *  GitHub issue #493 rework) — more decorative (rounds every corner, junctions included), but has
   *  shown stability issues. `"legacy_line"` restores the pre-#493 renderer — a stroked polyline per
   *  chained corridor path with patched caps/miter wedges at junctions (the
   *  `renderStyle === "legacy_line"` branch + `drawSplitPassagesLegacy` in
   *  `VectorByCorridorsRenderer.ts`) — more stable, but junctions/turns
   *  have sharp corners under `join: "miter"` (round corners are still smooth under `join: "round"`,
   *  just via per-path circle-cap patches instead of a contour fill). The two corridor-drawing
   *  algorithms and the two special-shape drawing blocks are fully independent — the only code they
   *  share is `setupSplitPassageDraw` (per-call clip-scratch reset + `drawConnectorLine` helper +
   *  the plain-connector pass, boilerplate with no special-shape geometry) — so a `"contour"`-only
   *  bug can't leak into `"legacy_line"` mode. */
  renderStyle: "contour" | "legacy_line";
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
   *  their own two shares, as a fraction (0..1) of each long edge's own ray-intersection distance —
   *  not a tile-size fraction (kept relative on purpose, GitHub issue #681: it scales with face
   *  geometry, not `TILE_SIZE`) — only meaningful while `splitSpecialShapes` is on. `0` draws a
   *  plain straight connector (the two nodes' lines would coincide at the tile center, same as the
   *  generic non-special reading). */
  splitDiagonalBowAmount: number;
  /** Same role as `VectorByWallsSettings.links` (GitHub issue #643), over `VectorByCorridorsParamPath`. */
  links: ParamLink<VectorByCorridorsParamPath>[];
  /** "Marker indices" (GitHub issue #471) — see `MarkerIndexSettings`'s own doc comment.
   *  Independent layer, not part of "Shared style". */
  markerIndex: MarkerIndexSettings;
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
  /** Whether color-contrast warnings are included in the export problems list. */
  showColorWarnings: boolean;
  /** Visibility policy for the per-field `LinkStatusIcon` (GitHub issue #652 follow-up) — a single
   *  switch shared by both render modes' "Shared style" section, not a per-mode setting, since the
   *  icon's own meaning is identical everywhere it appears. `"always"` shows it on every linkable
   *  field, `"linked"` only on a field that currently has an incoming and/or outgoing link,
   *  `"never"` hides it everywhere (the old reset-only behavior is gone — hiding the icon just
   *  removes the entry point, it does not disable the underlying link mechanism). */
  linkIconVisibility: LinkIconVisibility;
  vectorByWallsSettings: VectorByWallsSettings;
  /** Expanded/collapsed state per "Vector by corridors" settings section, keyed by section id —
   * mirrors `vectorByWallsSectionsExpanded`. */
  vectorByCorridorsSectionsExpanded: Record<string, boolean>;
  vectorByCorridorsSettings: VectorByCorridorsSettings;
  /** Node ids of the teleport-group cell(s) currently hovered in the Teleports section's group list
   *  — drives the export canvas's cell highlight (same overlay as a hovered export warning). `null`
   *  when nothing is hovered. */
  hoveredTeleportNodeIds: number[] | null;
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
  /** True while `openExportFormatSettings`'s `SidePanel` is covered by another `SidePanel` stacked
   * on top of it (GitHub issue #629 follow-up) — the format settings panel is still logically open
   * (`openExportFormatSettings` unchanged), just not the visible panel. Driven by
   * `ImageExportFeature`'s `SidePanel.onTopChange`. `ExportFrameOverlay`'s on-canvas print-frame
   * overlay reads this alongside `openExportFormatSettings === "png"` — it would otherwise keep
   * drawing the frame/dimming for a panel the user can no longer see or act on. */
  exportFormatSettingsCovered: boolean;
  pngExportSettings: PngExportSettings;
}

export interface ImageExportActions {
  setActiveRenderMode: (mode: RenderModeId) => void;
  setOpenRenderModeSettings: (mode: RenderModeId | null) => void;
  setOpenExportFormatSettings: (format: ExportFormatId | null) => void;
  setExportFormatSettingsCovered: (covered: boolean) => void;
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
  setPrintFieldSizing: (input: PrintFieldSizingInput, config: Pick<FieldConfig, "type">) => void;
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
  setShowColorWarnings: (show: boolean) => void;
  setLinkIconVisibility: (v: LinkIconVisibility) => void;
  setVectorByCorridorsBackground: (color: number) => void;
  setVectorByCorridorsShowGrid: (v: boolean) => void;
  setVectorByCorridorsGridColor: (color: number) => void;
  setVectorByCorridorsColor: (color: number) => void;
  setVectorByCorridorsThickness: (v: number) => void;
  setVectorByCorridorsJoin: (join: CornerStyle) => void;
  setVectorByCorridorsRenderStyle: (v: "contour" | "legacy_line") => void;
  setVectorByCorridorsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsStartMarkerText: (text: string) => void;
  setVectorByCorridorsStartMarkerTextEnabled: (enabled: boolean) => void;
  setVectorByCorridorsStartMarkerTextFontWeight: (weight: LabelFontWeight) => void;
  setVectorByCorridorsStartMarkerTextSize: (v: number) => void;
  setVectorByCorridorsStartMarkerTextMargin: (v: number) => void;
  setVectorByCorridorsStartMarkerTextColor: (color: number) => void;
  setVectorByCorridorsStartMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByCorridorsStartMarkerFillColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerSize: (v: number) => void;
  setVectorByCorridorsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsFinishMarkerText: (text: string) => void;
  setVectorByCorridorsFinishMarkerTextEnabled: (enabled: boolean) => void;
  setVectorByCorridorsFinishMarkerTextFontWeight: (weight: LabelFontWeight) => void;
  setVectorByCorridorsFinishMarkerTextSize: (v: number) => void;
  setVectorByCorridorsFinishMarkerTextMargin: (v: number) => void;
  setVectorByCorridorsFinishMarkerTextColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByCorridorsFinishMarkerFillColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerSize: (v: number) => void;
  setVectorByCorridorsMarkerWidenPadding: (v: number) => void;
  setVectorByCorridorsMarkerWidenShape: (shape: MarkerWidenShape) => void;
  setVectorByCorridorsMarkerLayout: (mode: MarkerLayoutMode) => void;
  setVectorByCorridorsMarkerScale: (v: number) => void;
  patchVectorByCorridorsOneWaySettings: (patch: Partial<OneWaySettingsFields>) => void;
  patchVectorByCorridorsTeleportSettings: (patch: Partial<TeleportSettingsFields>) => void;
  setVectorByCorridorsTeleportGroupOverride: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  /** Bulk form of `setVectorByCorridorsTeleportGroupOverride` — merges every group's patch in one store update (GitHub issue #728). */
  patchVectorByCorridorsTeleportGroupOverrides: (patches: Record<string, TeleportGroupOverride>) => void;
  setVectorByCorridorsSplitNodeColor: (index: number, color: number) => void;
  setVectorByCorridorsSplitSpecialShapes: (v: boolean) => void;
  setVectorByCorridorsSplitGapWidth: (v: number) => void;
  setVectorByCorridorsSplitDiagonalBowAmount: (v: number) => void;
  /** `oneWayArrowColor` etc. — see `patchVectorByWallsVerticalSettings`'s own doc comment (GitHub
   *  issue #348, "Vector by corridors" parity follow-up to #347). "Vector by corridors" has no
   *  `verticalStyle`/decorative fields — it always draws the plain marker shape (GitHub issue #348). */
  patchVectorByCorridorsVerticalSettings: (
    patch: Partial<
      Pick<
        VerticalSettingsFields,
        | "replaceTwoFloorElevatorsWithStairs"
        | "twoWayArrowColor"
        | "twoWayArrowSize"
        | "twoWayArrowStyle"
        | "twoWayArrowCornerStyle"
        | "oneWayArrowColor"
        | "oneWayArrowSize"
        | "oneWayArrowStyle"
        | "oneWayArrowCornerStyle"
        | "elevatorArrowColor"
        | "elevatorArrowSize"
        | "elevatorArrowStyle"
        | "elevatorArrowCornerStyle"
      >
    >,
  ) => void;
  /** See `patchVectorByWallsElevatorBadges`'s own doc comment. */
  patchVectorByCorridorsElevatorBadges: (patch: Partial<ElevatorBadgeSettings>) => void;
  /** See `setVectorByWallsElevatorBadgesCornerStyle`'s own doc comment. */
  setVectorByCorridorsElevatorBadgesCornerStyle: (style: CornerStyle) => void;
  /** Patches "Marker indices" settings (GitHub issue #471) — single-patch-call convention, no
   *  "Shared style" override to track. */
  patchVectorByCorridorsMarkerIndexSettings: (patch: Partial<MarkerIndexSettings>) => void;
  setVectorByCorridorsTwoWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsTwoWayPassageMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByCorridorsTwoWayPassageMarkerFillColor: (color: number) => void;
  setVectorByCorridorsTwoWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsTwoWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsTwoWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsTwoWayPassageMarkerSize: (v: number) => void;
  setVectorByCorridorsOneWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsOneWayPassageMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByCorridorsOneWayPassageMarkerFillColor: (color: number) => void;
  setVectorByCorridorsOneWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsOneWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsOneWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsOneWayPassageMarkerSize: (v: number) => void;
  setVectorByCorridorsElevatorMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsElevatorMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByCorridorsElevatorMarkerFillColor: (color: number) => void;
  setVectorByCorridorsElevatorMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsElevatorMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsElevatorMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsElevatorMarkerSize: (v: number) => void;
  /** Sets the shared corner style and re-applies it to every non-overridden dependent field
   *  (`join`, `oneWayJoin`, `startMarker`/`finishMarker.cornerStyle`, `teleportMarker.cornerStyle`). */
  /** Patches the "Shared style" > "Markers" source fields (`SharedStyleSourceFields`) and
   *  re-applies each changed field to its enabled dependents via the link graph. */
  patchVectorByCorridorsSharedStyle: (patch: Partial<SharedStyleSourceFields>) => void;
  /** Patches the "Vertical connections" section's own "Shared style" source fields
   *  (`VerticalSharedStyleFields`, GitHub issue #668) and re-applies each changed field to its
   *  non-overridden dependents (`twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker` plus
   *  each group's own arrow fields) via the link graph, same propagate-on-change convention as
   *  `setVectorByCorridorsSharedCornerStyle` et al. */
  patchVectorByCorridorsVerticalSharedStyle: (patch: Partial<VerticalSharedStyleFields>) => void;
  /** Re-enables the link (if any) targeting `target`, re-applying that link's current source value
   *  to it (GitHub issue #643, generalizing #322's per-field reset button). No-op if the field isn't
   *  linkable. */
  resetVectorByCorridorsSharedStyleField: (target: VectorByCorridorsParamPath) => void;
  /** "Synchronize" — clears every override across every group, re-applying all four shared values
   *  to every dependent field. */
  forceVectorByCorridorsSharedStyle: () => void;
  /** "Reset all settings" — restores the whole `vectorByCorridorsSettings` object (shared style
   *  included, overrides cleared) to its defaults. */
  resetVectorByCorridorsSettings: () => void;
  /** Enables/disables the link (if any) targeting `target`, without touching the field's own value
   *  (GitHub issue #644's parameter-links dialog toggle). Re-enabling re-propagates `source`'s
   *  value, same as `resetVectorByCorridorsSharedStyleField`; disabling just flips the flag. */
  setVectorByCorridorsLinkEnabled: (target: VectorByCorridorsParamPath, enabled: boolean) => void;
  /** Creates (or replaces) the link `source -> target` and propagates `source`'s current value into
   *  `target` (GitHub issue #644). Both paths must share the same `ParamType` — the dialog only ever
   *  offers same-type pairs. `modifiers` (GitHub issue #645) is only passed for `"number"`-type pairs. */
  addVectorByCorridorsLink: (source: VectorByCorridorsParamPath, target: VectorByCorridorsParamPath, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  /** Removes whichever link targets `target` entirely (GitHub issue #644) — the field's own value is
   *  left untouched but it stops following any source until a new link is created for it. */
  removeVectorByCorridorsLink: (target: VectorByCorridorsParamPath) => void;
  setVectorByWallsBackground: (color: number) => void;
  setVectorByWallsShowGrid: (v: boolean) => void;
  setVectorByWallsGridColor: (color: number) => void;
  setVectorByWallsShowInnerGrid: (v: boolean) => void;
  setVectorByWallsInnerGridColor: (color: number) => void;
  setVectorByWallsFloorColor: (color: number) => void;
  setVectorByWallsWallColor: (color: number) => void;
  setVectorByWallsRandomWallColorMode: (mode: RandomWallColorMode) => void;
  setVectorByWallsMarkerLayout: (mode: MarkerLayoutMode) => void;
  setVectorByWallsMarkerScale: (v: number) => void;
  setVectorByWallsWallJoin: (join: CornerStyle) => void;
  setVectorByWallsWallThickness: (v: number) => void;
  setVectorByWallsOneWayPattern: (pattern: OneWayPattern) => void;
  setVectorByWallsOneWayColor: (color: number) => void;
  setVectorByWallsOneWayGapWidth: (v: number) => void;
  setVectorByWallsOneWaySize: (v: number) => void;
  setVectorByWallsOneWayThickness: (v: number) => void;
  setVectorByWallsOneWayJoin: (join: CornerStyle) => void;
  setVectorByWallsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsStartMarkerText: (text: string) => void;
  setVectorByWallsStartMarkerTextEnabled: (enabled: boolean) => void;
  setVectorByWallsStartMarkerTextFontWeight: (weight: LabelFontWeight) => void;
  setVectorByWallsStartMarkerTextSize: (v: number) => void;
  setVectorByWallsStartMarkerTextMargin: (v: number) => void;
  setVectorByWallsStartMarkerTextColor: (color: number) => void;
  setVectorByWallsStartMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByWallsStartMarkerFillColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderWidth: (v: number) => void;
  setVectorByWallsStartMarkerGapWidth: (v: number) => void;
  setVectorByWallsStartMarkerSize: (v: number) => void;
  setVectorByWallsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsFinishMarkerText: (text: string) => void;
  setVectorByWallsFinishMarkerTextEnabled: (enabled: boolean) => void;
  setVectorByWallsFinishMarkerTextFontWeight: (weight: LabelFontWeight) => void;
  setVectorByWallsFinishMarkerTextSize: (v: number) => void;
  setVectorByWallsFinishMarkerTextMargin: (v: number) => void;
  setVectorByWallsFinishMarkerTextColor: (color: number) => void;
  setVectorByWallsFinishMarkerCornerStyle: (style: CornerStyle) => void;
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
        | "replaceTwoFloorElevatorsWithStairs"
        | "twoWayArrowColor"
        | "twoWayArrowSize"
        | "twoWayArrowStyle"
        | "twoWayArrowCornerStyle"
        | "oneWayArrowColor"
        | "oneWayArrowSize"
        | "oneWayArrowStyle"
        | "oneWayArrowCornerStyle"
        | "elevatorArrowColor"
        | "elevatorArrowSize"
        | "elevatorArrowStyle"
        | "elevatorArrowCornerStyle"
      > &
        Pick<VerticalDecorativeFields, "verticalStyle" | "decorativeStairsArrowColor" | "decorativeStairsArrowSize" | "decorativeStairsOneWayArrowColor" | "decorativeStairsOneWayArrowSize">
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
  setVectorByWallsElevatorBadgesCornerStyle: (style: CornerStyle) => void;
  /** Patches "Marker indices" settings (GitHub issue #471) — single-patch-call convention, no
   *  "Shared style" override to track. */
  patchVectorByWallsMarkerIndexSettings: (patch: Partial<MarkerIndexSettings>) => void;
  setVectorByWallsTwoWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsTwoWayPassageMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByWallsTwoWayPassageMarkerFillColor: (color: number) => void;
  setVectorByWallsTwoWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByWallsTwoWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByWallsTwoWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByWallsTwoWayPassageMarkerSize: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsOneWayPassageMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByWallsOneWayPassageMarkerFillColor: (color: number) => void;
  setVectorByWallsOneWayPassageMarkerBorderColor: (color: number) => void;
  setVectorByWallsOneWayPassageMarkerBorderWidth: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerGapWidth: (v: number) => void;
  setVectorByWallsOneWayPassageMarkerSize: (v: number) => void;
  setVectorByWallsElevatorMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsElevatorMarkerCornerStyle: (style: CornerStyle) => void;
  setVectorByWallsElevatorMarkerFillColor: (color: number) => void;
  setVectorByWallsElevatorMarkerBorderColor: (color: number) => void;
  setVectorByWallsElevatorMarkerBorderWidth: (v: number) => void;
  setVectorByWallsElevatorMarkerGapWidth: (v: number) => void;
  setVectorByWallsElevatorMarkerSize: (v: number) => void;
  patchVectorByWallsTeleportSettings: (patch: Partial<TeleportSettingsFields>) => void;
  setVectorByWallsTeleportGroupOverride: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  /** Bulk form of `setVectorByWallsTeleportGroupOverride` — merges every group's patch in one store update (GitHub issue #728). */
  patchVectorByWallsTeleportGroupOverrides: (patches: Record<string, TeleportGroupOverride>) => void;
  setHoveredTeleportNodeIds: (ids: number[] | null) => void;
  /** Sets slot `index`'s color, growing `splitNodeColors` (filling any new intermediate slots with
   *  `splitSlotColor`'s own default) if `index` is past the array's current end — see GitHub issue
   *  #294. */
  setVectorByWallsSplitNodeColor: (index: number, color: number) => void;
  setVectorByWallsSplitSpecialShapes: (v: boolean) => void;
  /** Sets the shared corner style and re-applies it to every non-overridden dependent field
   *  (`wallJoin`, `oneWayJoin`, `startMarker`/`finishMarker.cornerStyle`, `teleportMarker.cornerStyle`). */
  /** Same role as `patchVectorByCorridorsSharedStyle`, over `VectorByWallsSettings`. */
  patchVectorByWallsSharedStyle: (patch: Partial<SharedStyleSourceFields>) => void;
  /** Same role as `patchVectorByCorridorsVerticalSharedStyle`, over `VectorByWallsSettings` — also
   *  covers `verticalDecorativeLineColor` (Walls-only, GitHub issue #668). */
  patchVectorByWallsVerticalSharedStyle: (patch: Partial<VerticalSharedStyleFields & Pick<VectorByWallsSettings, "verticalDecorativeLineColor" | "verticalDecorativeLineWidth" | "verticalDecorativeSize" | "verticalDecorativeArrowSize">>) => void;
  /** Same role as `resetVectorByCorridorsSharedStyleField`, over `VectorByWallsParamPath`. */
  resetVectorByWallsSharedStyleField: (target: VectorByWallsParamPath) => void;
  /** "Synchronize" — clears every override across every group, re-applying all four shared values
   *  to every dependent field. */
  forceVectorByWallsSharedStyle: () => void;
  /** "Reset all settings" — restores the whole `vectorByWallsSettings` object (shared style
   *  included, overrides cleared) to its defaults. */
  resetVectorByWallsSettings: () => void;
  /** Same role as `setVectorByCorridorsLinkEnabled`, over `VectorByWallsParamPath`. */
  setVectorByWallsLinkEnabled: (target: VectorByWallsParamPath, enabled: boolean) => void;
  /** Same role as `addVectorByCorridorsLink`, over `VectorByWallsParamPath`. */
  addVectorByWallsLink: (source: VectorByWallsParamPath, target: VectorByWallsParamPath, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  /** Same role as `removeVectorByCorridorsLink`, over `VectorByWallsParamPath`. */
  removeVectorByWallsLink: (target: VectorByWallsParamPath) => void;
  setHoveredExportWarningKey: (key: string | null) => void;
}
