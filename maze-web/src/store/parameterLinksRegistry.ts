import type { ParamDescriptor, ParamType } from "./parameterLinks";
import { colorToHex } from "./colorMath";
import * as m from "~/paraglide/messages";

/** Every linkable param in this app is either a plain number/boolean, a packed-RGB color, or one of
 *  these small string enums — `equals` is `Object.is` in all cases (a color value is just a number,
 *  GitHub issue #647), so one shared descriptor factory covers every entry. `label`/`group` back the
 *  parameter-links dialog (GitHub issue #644) — see `ParamDescriptor`'s own doc comment for what
 *  `group` means. `cornerStyle`/`join` values ("round"/"miter") are formatted via the same labels the
 *  settings panel's own corner-style `SelectRow` uses, not the raw enum string; `markerShape`/
 *  `verticalArrowStyle` each get their own localized format function. `indexLabelStyle` and
 *  `labelFontWeight` need the caller to pick which of two label-key sets applies (see
 *  `formatElevatorBadgesLabelType`/`formatMarkerIndexLabelStyle` and
 *  `formatElevatorBadgesFontWeight`/`formatMarkerIndexFontWeight`), since the same values are
 *  labelled differently depending on which field they appear on; plain numbers/booleans fall back
 *  to `String(v)`; `color` formats as `#rrggbb` (`formatColor`). */
/** Integers render bare ("5"), non-integers always to 2 decimal places ("5.10"), never the raw
 *  float string a chain of modifier steps can produce (e.g. a `×0.1` step's floating-point
 *  remainder) — GitHub issue #645 follow-up, link-row "current value" display. */
function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** `"#rrggbb"`, same hex rendering the color picker's own hex field uses (`colorToHex`). */
function formatColor(value: unknown): string {
  return colorToHex(value as number);
}

/** Appends "(Abstract)"/"(Decorative)" to a field's label (GitHub issue #677 follow-up) — for
 *  fields that only exist in one `verticalStyle` mode and whose plain label text collides with the
 *  other mode's counterpart (e.g. both named "Arrow color"), so the two stay visually distinct in
 *  the parameter-links picker even outside their already-separate tree groups. Not applied to
 *  fields that render identically regardless of mode (`replaceTwoFloorElevatorsWithStairs`,
 *  `elevatorBadges.*`) since those have no counterpart to disambiguate from. */
function abstractLabel(label: string): string {
  return `${label} ${m["image_export.param_links.vertical_style_abstract_suffix"]()}`;
}
function decorativeLabel(label: string): string {
  return `${label} ${m["image_export.param_links.vertical_style_decorative_suffix"]()}`;
}

function descriptor(type: ParamType, label: string, group: string[], format?: (value: unknown) => string): ParamDescriptor {
  const defaultFormat =
    type === "cornerStyle"
      ? formatCornerStyle
      : type === "markerShape"
        ? formatMarkerShape
        : type === "verticalArrowStyle"
          ? formatVerticalArrowStyle
          : type === "labelFontWeight"
            ? formatElevatorBadgesFontWeight
            : type === "number"
              ? formatNumber
              : type === "color"
                ? formatColor
                : String;
  return { type, equals: Object.is, label, group, format: format ?? defaultFormat };
}

function formatCornerStyle(value: unknown): string {
  if (value === "round") return m["image_export.vector_by_walls.corner_style_round"]();
  if (value === "miter") return m["image_export.vector_by_walls.corner_style_sharp"]();
  return String(value);
}

function formatMarkerShape(value: unknown): string {
  switch (value) {
    case "circle":
      return m["image_export.vector_by_walls.marker_shape_circle"]();
    case "triangle":
      return m["image_export.vector_by_walls.marker_shape_triangle"]();
    case "square":
      return m["image_export.vector_by_walls.marker_shape_square"]();
    case "diamond":
      return m["image_export.vector_by_walls.marker_shape_diamond"]();
    case "pentagon":
      return m["image_export.vector_by_walls.marker_shape_pentagon"]();
    case "star":
      return m["image_export.vector_by_walls.marker_shape_star"]();
    case "hexagon":
      return m["image_export.vector_by_walls.marker_shape_hexagon"]();
    case "cross":
      return m["image_export.vector_by_walls.marker_shape_cross"]();
    default:
      return String(value);
  }
}

function formatVerticalArrowStyle(value: unknown): string {
  switch (value) {
    case "triangle":
      return m["image_export.vector_by_walls.one_way_pattern_triangle"]();
    case "chevron":
      return m["image_export.vector_by_walls.one_way_pattern_chevron"]();
    case "arrow":
      return m["image_export.vector_by_walls.one_way_pattern_arrow"]();
    case "sign":
      return m["image_export.vector_by_walls.vertical_arrow_style_sign"]();
    default:
      return String(value);
  }
}

/** `LabelFontWeight`/`IndexLabelStyle` are each reused by multiple fields, but the settings panel
 *  shows different label-text sets for the same underlying values depending on the field: elevator
 *  badges and teleport floor badges share one set, marker index uses its own. A single generic
 *  `format` can't pick the right set, so the default (elevator-badges wording) covers the more
 *  common case and `markerIndex.*` descriptors pass their own via `descriptor()`'s `format`
 *  override. */
function formatElevatorBadgesFontWeight(value: unknown): string {
  if (value === "regular") return m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]();
  if (value === "bold") return m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]();
  return String(value);
}

function formatMarkerIndexFontWeight(value: unknown): string {
  if (value === "regular") return m["image_export.vector_by_walls.marker_index_font_weight_regular"]();
  if (value === "bold") return m["image_export.vector_by_walls.marker_index_font_weight_bold"]();
  return String(value);
}
function formatElevatorBadgesLabelType(value: unknown): string {
  if (value === "arabic") return m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]();
  if (value === "roman") return m["image_export.vector_by_walls.elevator_badges_label_type_roman"]();
  if (value === "letters") return m["image_export.vector_by_walls.elevator_badges_label_type_letters"]();
  return String(value);
}

function formatMarkerIndexLabelStyle(value: unknown): string {
  if (value === "arabic") return m["image_export.vector_by_walls.marker_index_label_style_arabic"]();
  if (value === "roman") return m["image_export.vector_by_walls.marker_index_label_style_roman"]();
  if (value === "letters") return m["image_export.vector_by_walls.marker_index_label_style_letters"]();
  return String(value);
}

function formatBoolean(value: unknown): string {
  return value ? m["image_export.param_links.boolean_on"]() : m["image_export.param_links.boolean_off"]();
}

// Group path segments (GitHub issue #644) — same section/subsection names the settings panel itself
// uses (`m["image_export.vector_by_walls.section_*"]`/`subsection_*"`), so the parameter-links
// dialog's own tree lines up with where a field actually lives in the panel.
const G = {
  sharedStyle: () => [m["image_export.vector_by_walls.section_shared_style"]()],
  markersStart: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_start"](), m["image_export.vector_by_walls.markers_marker_subsection"]()],
  markersFinish: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_finish"](), m["image_export.vector_by_walls.markers_marker_subsection"]()],
  markersStartSymbol: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_start"](), m["image_export.vector_by_walls.markers_text_subsection"]()],
  markersFinishSymbol: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_finish"](), m["image_export.vector_by_walls.markers_text_subsection"]()],
  teleportMarkers: () => [m["image_export.vector_by_walls.section_teleports"](), m["image_export.vector_by_walls.teleport_subsection_edges"]()],
  teleportConnector: () => [m["image_export.vector_by_walls.section_teleports"](), m["image_export.vector_by_walls.teleport_subsection_connector"]()],
  markerIndex: () => [m["image_export.vector_by_walls.section_marker_index"]()],

  verticalRoot: () => [m["image_export.vector_by_walls.section_vertical"]()],
  // `replaceTwoFloorElevatorsWithStairs`/`elevatorBadges.*` render identically regardless of
  // `verticalStyle` (same JSX block appears once inside the single "Elevator" subsection in
  // `VectorByWallsSettingsPanel`, GitHub issue #677) — one shared group.
  verticalElevator: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"]()],
  verticalElevatorBadges: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"](), m["image_export.vector_by_walls.elevator_badges"]()],

  // GitHub issue #677 — the settings panel has exactly one "Shared style"/"Two-way passage
  // marker"/"One-way passage marker"/"Elevator" subsection each, not two (one per `verticalStyle`
  // mode): only the mode toggle changes which fields render *inside* that one subsection. The
  // parameter-links tree mirrors that one-subsection-each structure (no separate Abstract/
  // Decorative top-level split), same groups "Vector by corridors" already uses for its own
  // (mode-less) marker/arrow fields below. Abstract-only vs. decorative-only fields that would
  // otherwise share one label (e.g. both named "Arrow color") are told apart by a "(Abstract)"/
  // "(Decorative)" label suffix instead (`abstractLabel`/`decorativeLabel`) — see each entry below.
  verticalSharedStyle: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.vertical_subsection_shared_style"]()],
  verticalTwoWayMarker: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.two_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_marker"]()],
  verticalTwoWayArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.two_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalOneWayArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.one_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalElevatorArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalOneWayMarker: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.one_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_marker"]()],
  verticalElevatorMarker: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"](), m["image_export.vector_by_walls.vertical_subsection_marker"]()],
  teleportRoot: () => [m["image_export.vector_by_walls.section_teleports"]()],
  teleportFloorBadges: () => [m["image_export.vector_by_walls.section_teleports"](), m["image_export.vector_by_walls.teleport_subsection_floor_badges"]()],
  markerIndexCoverage: () => [m["image_export.vector_by_walls.section_marker_index"](), m["image_export.vector_by_walls.marker_index_subsection_coverage"]()],
  markerIndexSettings: () => [m["image_export.vector_by_walls.section_marker_index"](), m["image_export.vector_by_walls.marker_index_subsection_settings"]()],
  tiles: () => [m["image_export.vector_by_walls.section_tiles"]()],
  oneWays: () => [m["image_export.vector_by_walls.section_one_ways"]()],
  splits: () => [m["image_export.vector_by_walls.section_splits"]()],
  background: () => [m["image_export.vector_by_walls.section_background"]()],
  cells: () => [m["image_export.vector_by_corridors.section_cells"]()],
};

/** "Vector by walls" mode's linkable parameter registry (GitHub issue #643) — one entry per field
 *  any "Shared style" group can drive or be driven from. Path spelling mirrors
 *  `VectorByWallsSettings`'s own field/sub-object structure (dot-path for a `MarkerSettings` sub-
 *  object field) so `getParamValue`/`setParamValue` (`parameterLinksEngine.ts`) can address it
 *  directly. The four group source values (`cornerStyle`/`markerSize`/`markerBorderWidth`/
 *  `gapWidth`) are themselves ordinary entries here — nothing marks them as "sources" structurally,
 *  only that `DEFAULT_VECTOR_BY_WALLS_LINKS` has no link whose `target` is one of them; their own
 *  `group` is `G.sharedStyle()` since they live in the "Shared style" section itself. */
export const VECTOR_BY_WALLS_PARAM_REGISTRY = {
  markerShape: descriptor("markerShape", m["image_export.param_links.shared_marker_shape"](), G.sharedStyle()),
  markerFillColor: descriptor("color", m["image_export.param_links.shared_marker_fill_color"](), G.sharedStyle()),
  markerBorderColor: descriptor("color", m["image_export.param_links.shared_marker_border_color"](), G.sharedStyle()),
  cornerStyle: descriptor("cornerStyle", m["image_export.param_links.shared_corner_style"](), G.sharedStyle()),
  markerSize: descriptor("number", m["image_export.param_links.shared_marker_size"](), G.sharedStyle()),
  markerBorderWidth: descriptor("number", m["image_export.param_links.shared_marker_border_width"](), G.sharedStyle()),
  gapWidth: descriptor("number", m["image_export.param_links.shared_gap_width"](), G.sharedStyle()),
  // `verticalSize`/`verticalArrowSize` are abstract-only (GitHub issue #677 follow-up) — the
  // decorative style has its own dedicated `verticalDecorativeSize`/`verticalDecorativeArrowSize`
  // pair below, since a decorative "size" (the stairs line's length) and "arrow size" (the arrow
  // drawn along that line) are visually unrelated to the abstract marker's own radius/internal
  // arrow. Both pairs share `G.verticalSharedStyle()` (the settings panel has one "Shared style"
  // subsection, not a separate one per mode) and are told apart by the "(Abstract)"/"(Decorative)"
  // label suffix instead (`abstractLabel`/`decorativeLabel`).
  verticalSize: descriptor("number", abstractLabel(m["image_export.param_links.vertical_shared_size"]()), G.verticalSharedStyle()),
  verticalArrowSize: descriptor("number", abstractLabel(m["image_export.param_links.vertical_shared_arrow_size"]()), G.verticalSharedStyle()),
  verticalCornerStyle: descriptor("cornerStyle", abstractLabel(m["image_export.param_links.vertical_shared_corner_style"]()), G.verticalSharedStyle()),
  verticalShape: descriptor("markerShape", abstractLabel(m["image_export.param_links.vertical_shared_shape"]()), G.verticalSharedStyle()),
  verticalBorderWidth: descriptor("number", abstractLabel(m["image_export.param_links.vertical_shared_border_width"]()), G.verticalSharedStyle()),
  verticalGapWidth: descriptor("number", abstractLabel(m["image_export.param_links.vertical_shared_gap_width"]()), G.verticalSharedStyle()),
  verticalFillColor: descriptor("color", abstractLabel(m["image_export.param_links.vertical_shared_fill_color"]()), G.verticalSharedStyle()),
  verticalArrowColor: descriptor("color", abstractLabel(m["image_export.param_links.vertical_shared_arrow_color"]()), G.verticalSharedStyle()),
  verticalArrowStyle: descriptor("verticalArrowStyle", abstractLabel(m["image_export.param_links.vertical_shared_arrow_style"]()), G.verticalSharedStyle()),
  verticalArrowCornerStyle: descriptor("cornerStyle", abstractLabel(m["image_export.param_links.vertical_shared_arrow_corner_style"]()), G.verticalSharedStyle()),
  verticalDecorativeLineColor: descriptor("color", decorativeLabel(m["image_export.param_links.vertical_shared_decorative_line_color"]()), G.verticalSharedStyle()),
  verticalDecorativeLineWidth: descriptor("number", decorativeLabel(m["image_export.param_links.vertical_shared_decorative_line_width"]()), G.verticalSharedStyle()),
  verticalDecorativeSize: descriptor("number", decorativeLabel(m["image_export.param_links.vertical_shared_decorative_size"]()), G.verticalSharedStyle()),
  verticalDecorativeArrowSize: descriptor("number", decorativeLabel(m["image_export.param_links.vertical_shared_decorative_arrow_size"]()), G.verticalSharedStyle()),

  wallJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.wall_join"](), [m["image_export.vector_by_walls.section_tiles"]()]),
  oneWayJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.one_way_join"](), [m["image_export.vector_by_walls.section_one_ways"]()]),
  "startMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersStart()),
  "startMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersStart()),
  "startMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersStart()),
  "startMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersStart()),
  "startMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersStart()),
  "startMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.markersStart()),
  "startMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.markersStart()),
  "startMarker.textEnabled": descriptor("boolean", m["image_export.vector_by_walls.marker_text_show"](), G.markersStartSymbol(), formatBoolean),
  "startMarker.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.markersStartSymbol(), formatElevatorBadgesFontWeight),
  "startMarker.textSize": descriptor("number", m["image_export.vector_by_walls.marker_text_size"](), G.markersStartSymbol()),
  "startMarker.textColor": descriptor("color", m["image_export.vector_by_walls.marker_text_color"](), G.markersStartSymbol()),
  "finishMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersFinish()),
  "finishMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersFinish()),
  "finishMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersFinish()),
  "finishMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersFinish()),
  "finishMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersFinish()),
  "finishMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.markersFinish()),
  "finishMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.markersFinish()),
  "finishMarker.textEnabled": descriptor("boolean", m["image_export.vector_by_walls.marker_text_show"](), G.markersFinishSymbol(), formatBoolean),
  "finishMarker.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.markersFinishSymbol(), formatElevatorBadgesFontWeight),
  "finishMarker.textSize": descriptor("number", m["image_export.vector_by_walls.marker_text_size"](), G.markersFinishSymbol()),
  "finishMarker.textColor": descriptor("color", m["image_export.vector_by_walls.marker_text_color"](), G.markersFinishSymbol()),
  "teleportMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.teleport_corner_style"](), G.teleportMarkers()),
  "teleportMarker.size": descriptor("number", m["image_export.vector_by_walls.teleport_size"](), G.teleportMarkers()),
  "teleportMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_shape"](), G.teleportMarkers()),
  "teleportMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.teleport_border_width"](), G.teleportMarkers()),
  "teleportMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.teleport_edge_gap_width"](), G.teleportMarkers()),
  "teleportMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.teleport_edge_color"](), G.teleportMarkers()),
  "teleportMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.teleport_edge_border_color"](), G.teleportMarkers()),
  teleportConnectorGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_connector_gap_width"](), G.teleportConnector()),
  teleportConnectorColor: descriptor("color", m["image_export.vector_by_walls.teleport_connector_color"](), G.teleportConnector()),
  teleportAvoidFieldExit: descriptor("boolean", m["image_export.vector_by_walls.teleport_avoid_field_exit"](), G.teleportConnector(), formatBoolean),
  teleportGroupCustomization: descriptor("boolean", m["image_export.vector_by_walls.teleport_group_customization"](), G.teleportRoot(), formatBoolean),
  "teleportFloorBadge.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_floor_badge_shape"](), G.teleportFloorBadges()),
  "teleportFloorBadge.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.teleport_floor_badge_label_type"](), G.teleportFloorBadges(), formatElevatorBadgesLabelType),
  "teleportFloorBadge.fillColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_fill_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.teleportFloorBadges()),
  "teleportFloorBadge.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.teleportFloorBadges()),
  "teleportFloorBadge.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.teleportFloorBadges()),
  "teleportFloorBadge.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.teleportFloorBadges()),
  "teleportFloorBadge.borderColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_border_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.textColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_text_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.teleportFloorBadges(), formatElevatorBadgesFontWeight),
  "teleportFloorBadge.textSize": descriptor("number", m["image_export.vector_by_walls.teleport_floor_badge_text_size"](), G.teleportFloorBadges()),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.marker_corner_style"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.size": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_border_width"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.gapWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_gap_width"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.shape": descriptor("markerShape", abstractLabel(m["image_export.vector_by_walls.marker_shape"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.fillColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_fill_color"]()), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_border_color"]()), G.verticalTwoWayMarker()),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.marker_corner_style"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.size": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_border_width"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.gapWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_gap_width"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.shape": descriptor("markerShape", abstractLabel(m["image_export.vector_by_walls.marker_shape"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.fillColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_fill_color"]()), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_border_color"]()), G.verticalOneWayMarker()),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.marker_corner_style"]()), G.verticalElevatorMarker()),
  "elevatorMarker.size": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalElevatorMarker()),
  "elevatorMarker.borderWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_border_width"]()), G.verticalElevatorMarker()),
  "elevatorMarker.gapWidth": descriptor("number", abstractLabel(m["image_export.vector_by_walls.marker_gap_width"]()), G.verticalElevatorMarker()),
  "elevatorMarker.shape": descriptor("markerShape", abstractLabel(m["image_export.vector_by_walls.marker_shape"]()), G.verticalElevatorMarker()),
  "elevatorMarker.fillColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_fill_color"]()), G.verticalElevatorMarker()),
  "elevatorMarker.borderColor": descriptor("color", abstractLabel(m["image_export.vector_by_walls.marker_border_color"]()), G.verticalElevatorMarker()),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorBadges()),
  "elevatorBadges.enabled": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_enabled"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.evenDistribution": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_even_distribution"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.size": descriptor("number", m["image_export.vector_by_walls.elevator_badges_size"](), G.verticalElevatorBadges()),
  "elevatorBadges.distance": descriptor("number", m["image_export.vector_by_walls.elevator_badges_distance"](), G.verticalElevatorBadges()),
  "elevatorBadges.gap": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap"](), G.verticalElevatorBadges()),
  "elevatorBadges.gapWidth": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.shape": descriptor("markerShape", m["image_export.vector_by_walls.elevator_badges_shape"](), G.verticalElevatorBadges()),
  "elevatorBadges.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.elevator_badges_label_type"](), G.verticalElevatorBadges(), formatElevatorBadgesLabelType),
  "elevatorBadges.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.elevator_badges_font_weight"](), G.verticalElevatorBadges(), formatElevatorBadgesFontWeight),
  "elevatorBadges.fillColor": descriptor("color", m["image_export.vector_by_walls.elevator_badges_fill_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.textColor": descriptor("color", m["image_export.vector_by_walls.elevator_badges_text_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.textSize": descriptor("number", m["image_export.vector_by_walls.elevator_badges_text_size"](), G.verticalElevatorBadges()),
  "markerIndex.gap": descriptor("number", m["image_export.vector_by_walls.marker_index_gap"](), G.markerIndexSettings()),
  "markerIndex.enabled": descriptor("boolean", m["image_export.vector_by_walls.marker_index_enabled"](), G.markerIndex(), formatBoolean),
  "markerIndex.paddingX": descriptor("number", m["image_export.vector_by_walls.marker_index_padding_x"](), G.markerIndexSettings()),
  "markerIndex.height": descriptor("number", m["image_export.vector_by_walls.marker_index_height"](), G.markerIndexSettings()),
  "markerIndex.offset": descriptor("number", m["image_export.vector_by_walls.marker_index_offset"](), G.markerIndexSettings()),
  "markerIndex.cornerRadius": descriptor("number", m["image_export.vector_by_walls.marker_index_corner_radius"](), G.markerIndexSettings()),
  "markerIndex.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_index_border_width"](), G.markerIndexSettings()),
  "markerIndex.borderWidthFromMarker": descriptor("boolean", m["image_export.vector_by_walls.marker_index_border_width_from_marker"](), G.markerIndexSettings(), formatBoolean),
  "markerIndex.borderColorFromMarker": descriptor("boolean", m["image_export.vector_by_walls.marker_index_border_color_from_marker"](), G.markerIndexSettings(), formatBoolean),
  "markerIndex.labelStyle": descriptor("indexLabelStyle", m["image_export.vector_by_walls.marker_index_label_style"](), G.markerIndexSettings(), formatMarkerIndexLabelStyle),
  "markerIndex.fontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_index_font_weight"](), G.markerIndexSettings(), formatMarkerIndexFontWeight),
  "markerIndex.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_index_fill_color"](), G.markerIndexSettings()),
  "markerIndex.textColor": descriptor("color", m["image_export.vector_by_walls.marker_index_text_color"](), G.markerIndexSettings()),
  "markerIndex.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_index_border_color"](), G.markerIndexSettings()),
  "markerIndex.coverage.singleFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.crossFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.verticalPassage": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.elevator": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_elevator"](), G.markerIndexCoverage(), formatBoolean),

  background: descriptor("color", m["image_export.vector_by_walls.background_color"](), G.background()),
  gridColor: descriptor("color", m["image_export.vector_by_walls.grid_color"](), G.background()),
  innerGridColor: descriptor("color", m["image_export.vector_by_walls.inner_grid_color"](), G.background()),
  floorColor: descriptor("color", m["image_export.vector_by_walls.floor_color"](), G.tiles()),
  wallColor: descriptor("color", m["image_export.vector_by_walls.wall_color"](), G.tiles()),
  wallThickness: descriptor("number", m["image_export.vector_by_walls.wall_thickness"](), G.tiles()),
  oneWayColor: descriptor("color", m["image_export.vector_by_walls.one_way_color"](), G.oneWays()),
  oneWayGapWidth: descriptor("number", m["image_export.vector_by_walls.one_way_gap_width"](), G.oneWays()),
  oneWaySize: descriptor("number", m["image_export.vector_by_walls.one_way_size"](), G.oneWays()),
  oneWayThickness: descriptor("number", m["image_export.vector_by_walls.one_way_thickness"](), G.oneWays()),
  showGrid: descriptor("boolean", m["image_export.vector_by_walls.show_grid"](), G.background(), formatBoolean),
  showInnerGrid: descriptor("boolean", m["image_export.vector_by_walls.show_inner_grid"](), G.background(), formatBoolean),
  // Lives inside the "Elevator" subsection itself (GitHub issue #677) — "Vector by corridors"
  // instead places it directly under "Vertical connections", before any subsection (see that
  // registry's own entry below), so the two modes intentionally use different groups.
  replaceTwoFloorElevatorsWithStairs: descriptor("boolean", m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"](), G.verticalElevator(), formatBoolean),
  splitSpecialShapes: descriptor("boolean", m["image_export.vector_by_walls.split_special_shapes"](), G.splits(), formatBoolean),
  "decorativeStairsTwoWay.lineWidth": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.decorative_line_width"]()), G.verticalTwoWayMarker()),
  "decorativeStairsTwoWay.size": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalTwoWayMarker()),
  "decorativeStairsTwoWay.lineColor": descriptor("color", decorativeLabel(m["image_export.vector_by_walls.decorative_line_color"]()), G.verticalTwoWayMarker()),
  "decorativeStairsOneWay.lineWidth": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.decorative_line_width"]()), G.verticalOneWayMarker()),
  "decorativeStairsOneWay.size": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalOneWayMarker()),
  "decorativeStairsOneWay.lineColor": descriptor("color", decorativeLabel(m["image_export.vector_by_walls.decorative_line_color"]()), G.verticalOneWayMarker()),
  "decorativeElevator.lineWidth": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.decorative_line_width"]()), G.verticalElevatorMarker()),
  "decorativeElevator.size": descriptor("number", decorativeLabel(m["image_export.vector_by_walls.marker_size"]()), G.verticalElevatorMarker()),
  "decorativeElevator.lineColor": descriptor("color", decorativeLabel(m["image_export.vector_by_walls.decorative_line_color"]()), G.verticalElevatorMarker()),
  decorativeStairsArrowSize: descriptor("number", decorativeLabel(m["image_export.vector_by_walls.vertical_arrow_size"]()), G.verticalTwoWayArrows()),
  decorativeStairsArrowColor: descriptor("color", decorativeLabel(m["image_export.vector_by_walls.vertical_arrow_color"]()), G.verticalTwoWayArrows()),
  decorativeStairsOneWayArrowSize: descriptor("number", decorativeLabel(m["image_export.vector_by_walls.vertical_arrow_size"]()), G.verticalOneWayArrows()),
  decorativeStairsOneWayArrowColor: descriptor("color", decorativeLabel(m["image_export.vector_by_walls.vertical_arrow_color"]()), G.verticalOneWayArrows()),
  twoWayArrowSize: descriptor("number", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_size"]()), G.verticalTwoWayArrows()),
  twoWayArrowStyle: descriptor("verticalArrowStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_style"]()), G.verticalTwoWayArrows()),
  twoWayArrowCornerStyle: descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_corner_style"]()), G.verticalTwoWayArrows()),
  twoWayArrowColor: descriptor("color", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_color"]()), G.verticalTwoWayArrows()),
  oneWayArrowSize: descriptor("number", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_size"]()), G.verticalOneWayArrows()),
  oneWayArrowStyle: descriptor("verticalArrowStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_style"]()), G.verticalOneWayArrows()),
  oneWayArrowCornerStyle: descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_corner_style"]()), G.verticalOneWayArrows()),
  oneWayArrowColor: descriptor("color", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_color"]()), G.verticalOneWayArrows()),
  elevatorArrowSize: descriptor("number", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_size"]()), G.verticalElevatorArrows()),
  elevatorArrowStyle: descriptor("verticalArrowStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_style"]()), G.verticalElevatorArrows()),
  elevatorArrowCornerStyle: descriptor("cornerStyle", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_corner_style"]()), G.verticalElevatorArrows()),
  elevatorArrowColor: descriptor("color", abstractLabel(m["image_export.vector_by_walls.vertical_arrow_color"]()), G.verticalElevatorArrows()),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByWallsParamPath = keyof typeof VECTOR_BY_WALLS_PARAM_REGISTRY;

/** Same role as `VECTOR_BY_WALLS_PARAM_REGISTRY`, for "Vector by corridors" — its dependent field
 *  set differs (no `wallJoin`, has `join` instead; `gapWidth` also reaches `splitGapWidth`). */
export const VECTOR_BY_CORRIDORS_PARAM_REGISTRY = {
  markerShape: descriptor("markerShape", m["image_export.param_links.shared_marker_shape"](), G.sharedStyle()),
  markerFillColor: descriptor("color", m["image_export.param_links.shared_marker_fill_color"](), G.sharedStyle()),
  markerBorderColor: descriptor("color", m["image_export.param_links.shared_marker_border_color"](), G.sharedStyle()),
  cornerStyle: descriptor("cornerStyle", m["image_export.param_links.shared_corner_style"](), G.sharedStyle()),
  markerSize: descriptor("number", m["image_export.param_links.shared_marker_size"](), G.sharedStyle()),
  markerBorderWidth: descriptor("number", m["image_export.param_links.shared_marker_border_width"](), G.sharedStyle()),
  gapWidth: descriptor("number", m["image_export.param_links.shared_gap_width"](), G.sharedStyle()),
  verticalCornerStyle: descriptor("cornerStyle", m["image_export.param_links.vertical_shared_corner_style"](), G.verticalSharedStyle()),
  verticalShape: descriptor("markerShape", m["image_export.param_links.vertical_shared_shape"](), G.verticalSharedStyle()),
  verticalSize: descriptor("number", m["image_export.param_links.vertical_shared_size"](), G.verticalSharedStyle()),
  verticalBorderWidth: descriptor("number", m["image_export.param_links.vertical_shared_border_width"](), G.verticalSharedStyle()),
  verticalGapWidth: descriptor("number", m["image_export.param_links.vertical_shared_gap_width"](), G.verticalSharedStyle()),
  verticalFillColor: descriptor("color", m["image_export.param_links.vertical_shared_fill_color"](), G.verticalSharedStyle()),
  verticalArrowColor: descriptor("color", m["image_export.param_links.vertical_shared_arrow_color"](), G.verticalSharedStyle()),
  verticalArrowSize: descriptor("number", m["image_export.param_links.vertical_shared_arrow_size"](), G.verticalSharedStyle()),
  verticalArrowStyle: descriptor("verticalArrowStyle", m["image_export.param_links.vertical_shared_arrow_style"](), G.verticalSharedStyle()),
  verticalArrowCornerStyle: descriptor("cornerStyle", m["image_export.param_links.vertical_shared_arrow_corner_style"](), G.verticalSharedStyle()),

  join: descriptor("cornerStyle", m["image_export.vector_by_corridors.join"](), [m["image_export.vector_by_corridors.section_cells"]()]),
  oneWayJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.one_way_join"](), [m["image_export.vector_by_walls.section_one_ways"]()]),
  "startMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersStart()),
  "startMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersStart()),
  "startMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersStart()),
  "startMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersStart()),
  "startMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersStart()),
  "startMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.markersStart()),
  "startMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.markersStart()),
  "startMarker.textEnabled": descriptor("boolean", m["image_export.vector_by_walls.marker_text_show"](), G.markersStartSymbol(), formatBoolean),
  "startMarker.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.markersStartSymbol(), formatElevatorBadgesFontWeight),
  "startMarker.textSize": descriptor("number", m["image_export.vector_by_walls.marker_text_size"](), G.markersStartSymbol()),
  "startMarker.textColor": descriptor("color", m["image_export.vector_by_walls.marker_text_color"](), G.markersStartSymbol()),
  "finishMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersFinish()),
  "finishMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersFinish()),
  "finishMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersFinish()),
  "finishMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersFinish()),
  "finishMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersFinish()),
  "finishMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.markersFinish()),
  "finishMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.markersFinish()),
  "finishMarker.textEnabled": descriptor("boolean", m["image_export.vector_by_walls.marker_text_show"](), G.markersFinishSymbol(), formatBoolean),
  "finishMarker.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.markersFinishSymbol(), formatElevatorBadgesFontWeight),
  "finishMarker.textSize": descriptor("number", m["image_export.vector_by_walls.marker_text_size"](), G.markersFinishSymbol()),
  "finishMarker.textColor": descriptor("color", m["image_export.vector_by_walls.marker_text_color"](), G.markersFinishSymbol()),
  "teleportMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.teleport_corner_style"](), G.teleportMarkers()),
  "teleportMarker.size": descriptor("number", m["image_export.vector_by_walls.teleport_size"](), G.teleportMarkers()),
  "teleportMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_shape"](), G.teleportMarkers()),
  "teleportMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.teleport_border_width"](), G.teleportMarkers()),
  "teleportMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.teleport_edge_gap_width"](), G.teleportMarkers()),
  "teleportMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.teleport_edge_color"](), G.teleportMarkers()),
  "teleportMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.teleport_edge_border_color"](), G.teleportMarkers()),
  teleportConnectorGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_connector_gap_width"](), G.teleportConnector()),
  teleportConnectorColor: descriptor("color", m["image_export.vector_by_walls.teleport_connector_color"](), G.teleportConnector()),
  teleportAvoidFieldExit: descriptor("boolean", m["image_export.vector_by_walls.teleport_avoid_field_exit"](), G.teleportConnector(), formatBoolean),
  teleportGroupCustomization: descriptor("boolean", m["image_export.vector_by_walls.teleport_group_customization"](), G.teleportRoot(), formatBoolean),
  "teleportFloorBadge.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_floor_badge_shape"](), G.teleportFloorBadges()),
  "teleportFloorBadge.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.teleport_floor_badge_label_type"](), G.teleportFloorBadges(), formatElevatorBadgesLabelType),
  "teleportFloorBadge.fillColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_fill_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.teleportFloorBadges()),
  "teleportFloorBadge.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.teleportFloorBadges()),
  "teleportFloorBadge.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.teleportFloorBadges()),
  "teleportFloorBadge.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.teleportFloorBadges()),
  "teleportFloorBadge.borderColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_border_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.textColor": descriptor("color", m["image_export.vector_by_walls.teleport_floor_badge_text_color"](), G.teleportFloorBadges()),
  "teleportFloorBadge.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_text_font_weight"](), G.teleportFloorBadges(), formatElevatorBadgesFontWeight),
  "teleportFloorBadge.textSize": descriptor("number", m["image_export.vector_by_walls.teleport_floor_badge_text_size"](), G.teleportFloorBadges()),
  splitGapWidth: descriptor("number", m["image_export.vector_by_corridors.split_gap_width"](), [m["image_export.vector_by_walls.section_splits"]()]),
  splitSpecialShapes: descriptor("boolean", m["image_export.vector_by_walls.split_special_shapes"](), G.splits(), formatBoolean),
  splitDiagonalBowAmount: descriptor("number", m["image_export.vector_by_corridors.split_diagonal_bow_amount"](), G.splits()),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.verticalTwoWayMarker()),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.verticalOneWayMarker()),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorMarker()),
  "elevatorMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalElevatorMarker()),
  "elevatorMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalElevatorMarker()),
  "elevatorMarker.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_fill_color"](), G.verticalElevatorMarker()),
  "elevatorMarker.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.verticalElevatorMarker()),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorBadges()),
  "elevatorBadges.enabled": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_enabled"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.evenDistribution": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_even_distribution"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.size": descriptor("number", m["image_export.vector_by_walls.elevator_badges_size"](), G.verticalElevatorBadges()),
  "elevatorBadges.distance": descriptor("number", m["image_export.vector_by_walls.elevator_badges_distance"](), G.verticalElevatorBadges()),
  "elevatorBadges.gap": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap"](), G.verticalElevatorBadges()),
  "elevatorBadges.gapWidth": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.shape": descriptor("markerShape", m["image_export.vector_by_walls.elevator_badges_shape"](), G.verticalElevatorBadges()),
  "elevatorBadges.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.elevator_badges_label_type"](), G.verticalElevatorBadges(), formatElevatorBadgesLabelType),
  "elevatorBadges.textFontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.elevator_badges_font_weight"](), G.verticalElevatorBadges(), formatElevatorBadgesFontWeight),
  "elevatorBadges.fillColor": descriptor("color", m["image_export.vector_by_walls.elevator_badges_fill_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_border_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.textColor": descriptor("color", m["image_export.vector_by_walls.elevator_badges_text_color"](), G.verticalElevatorBadges()),
  "elevatorBadges.textSize": descriptor("number", m["image_export.vector_by_walls.elevator_badges_text_size"](), G.verticalElevatorBadges()),
  "markerIndex.gap": descriptor("number", m["image_export.vector_by_walls.marker_index_gap"](), G.markerIndexSettings()),
  "markerIndex.enabled": descriptor("boolean", m["image_export.vector_by_walls.marker_index_enabled"](), G.markerIndex(), formatBoolean),
  "markerIndex.paddingX": descriptor("number", m["image_export.vector_by_walls.marker_index_padding_x"](), G.markerIndexSettings()),
  "markerIndex.height": descriptor("number", m["image_export.vector_by_walls.marker_index_height"](), G.markerIndexSettings()),
  "markerIndex.offset": descriptor("number", m["image_export.vector_by_walls.marker_index_offset"](), G.markerIndexSettings()),
  "markerIndex.cornerRadius": descriptor("number", m["image_export.vector_by_walls.marker_index_corner_radius"](), G.markerIndexSettings()),
  "markerIndex.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_index_border_width"](), G.markerIndexSettings()),
  "markerIndex.borderWidthFromMarker": descriptor("boolean", m["image_export.vector_by_walls.marker_index_border_width_from_marker"](), G.markerIndexSettings(), formatBoolean),
  "markerIndex.borderColorFromMarker": descriptor("boolean", m["image_export.vector_by_walls.marker_index_border_color_from_marker"](), G.markerIndexSettings(), formatBoolean),
  "markerIndex.labelStyle": descriptor("indexLabelStyle", m["image_export.vector_by_walls.marker_index_label_style"](), G.markerIndexSettings(), formatMarkerIndexLabelStyle),
  "markerIndex.fontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.marker_index_font_weight"](), G.markerIndexSettings(), formatMarkerIndexFontWeight),
  "markerIndex.fillColor": descriptor("color", m["image_export.vector_by_walls.marker_index_fill_color"](), G.markerIndexSettings()),
  "markerIndex.textColor": descriptor("color", m["image_export.vector_by_walls.marker_index_text_color"](), G.markerIndexSettings()),
  "markerIndex.borderColor": descriptor("color", m["image_export.vector_by_walls.marker_index_border_color"](), G.markerIndexSettings()),
  "markerIndex.coverage.singleFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.crossFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.verticalPassage": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.elevator": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_elevator"](), G.markerIndexCoverage(), formatBoolean),

  background: descriptor("color", m["image_export.vector_by_walls.background_color"](), G.background()),
  gridColor: descriptor("color", m["image_export.vector_by_walls.grid_color"](), G.background()),
  color: descriptor("color", m["image_export.vector_by_corridors.color"](), G.cells()),
  thickness: descriptor("number", m["image_export.vector_by_corridors.thickness"](), G.cells()),
  markerWidenPadding: descriptor("number", m["image_export.vector_by_corridors.marker_widen_padding"](), G.cells()),
  oneWayCount: descriptor("number", m["image_export.vector_by_corridors.one_way_count"](), G.oneWays()),
  oneWayThickness: descriptor("number", m["image_export.vector_by_corridors.one_way_thickness"](), G.oneWays()),
  oneWayGap: descriptor("number", m["image_export.vector_by_corridors.one_way_gap"](), G.oneWays()),
  oneWayWidth: descriptor("number", m["image_export.vector_by_corridors.one_way_width"](), G.oneWays()),
  oneWayLength: descriptor("number", m["image_export.vector_by_corridors.one_way_length"](), G.oneWays()),
  oneWayColor: descriptor("color", m["image_export.vector_by_corridors.one_way_color"](), G.oneWays()),
  showGrid: descriptor("boolean", m["image_export.vector_by_walls.show_grid"](), G.background(), formatBoolean),
  replaceTwoFloorElevatorsWithStairs: descriptor("boolean", m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"](), G.verticalRoot(), formatBoolean),
  twoWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalTwoWayArrows()),
  twoWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalTwoWayArrows()),
  twoWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalTwoWayArrows()),
  twoWayArrowColor: descriptor("color", m["image_export.vector_by_walls.vertical_arrow_color"](), G.verticalTwoWayArrows()),
  oneWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalOneWayArrows()),
  oneWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalOneWayArrows()),
  oneWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalOneWayArrows()),
  oneWayArrowColor: descriptor("color", m["image_export.vector_by_walls.vertical_arrow_color"](), G.verticalOneWayArrows()),
  elevatorArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalElevatorArrows()),
  elevatorArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalElevatorArrows()),
  elevatorArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalElevatorArrows()),
  elevatorArrowColor: descriptor("color", m["image_export.vector_by_walls.vertical_arrow_color"](), G.verticalElevatorArrows()),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByCorridorsParamPath = keyof typeof VECTOR_BY_CORRIDORS_PARAM_REGISTRY;
