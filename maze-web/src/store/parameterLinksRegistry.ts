import type { ParamDescriptor, ParamType } from "./parameterLinks";
import * as m from "~/paraglide/messages";

/** Every linkable param in this app is either a plain number/boolean or one of these small string
 *  enums — `equals` is `Object.is` in all cases, so one shared descriptor factory covers every
 *  entry. A future object-valued param type (#647 color-as-object) would need its own `equals`,
 *  added here when that type is introduced. `label`/`group` back the parameter-links dialog
 *  (GitHub issue #644) — see `ParamDescriptor`'s own doc comment for what `group` means.
 *  `cornerStyle`/`join` values ("round"/"miter") are formatted via the same labels the settings
 *  panel's own corner-style `SelectRow` uses, not the raw enum string; `markerShape`/
 *  `verticalArrowStyle` each get their own localized format function. `indexLabelStyle` and
 *  `labelFontWeight` need the caller to pick which of two label-key sets applies (see
 *  `formatElevatorBadgesLabelType`/`formatMarkerIndexLabelStyle` and
 *  `formatElevatorBadgesFontWeight`/`formatMarkerIndexFontWeight`), since the same values are
 *  labelled differently depending on which field they appear on; plain numbers/booleans fall back
 *  to `String(v)`. */
/** Integers render bare ("5"), non-integers always to 2 decimal places ("5.10"), never the raw
 *  float string a chain of modifier steps can produce (e.g. a `×0.1` step's floating-point
 *  remainder) — GitHub issue #645 follow-up, link-row "current value" display. */
function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
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
  markersStart: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_start"]()],
  markersFinish: () => [m["image_export.vector_by_walls.section_markers"](), m["image_export.vector_by_walls.markers_finish"]()],
  teleportMarkers: () => [m["image_export.vector_by_walls.section_teleports"](), m["image_export.vector_by_walls.teleport_subsection_edges"]()],
  teleportConnector: () => [m["image_export.vector_by_walls.section_teleports"](), m["image_export.vector_by_walls.teleport_subsection_connector"]()],
  verticalTwoWay: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.two_way_passage_marker"]()],
  verticalOneWay: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.one_way_passage_marker"]()],
  verticalElevator: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"]()],
  verticalElevatorBadges: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"](), m["image_export.vector_by_walls.elevator_badges"]()],
  markerIndex: () => [m["image_export.vector_by_walls.section_marker_index"]()],

  verticalRoot: () => [m["image_export.vector_by_walls.section_vertical"]()],
  verticalTwoWayArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.two_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalOneWayArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.one_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalElevatorArrows: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.elevator_marker"](), m["image_export.vector_by_walls.vertical_subsection_arrows"]()],
  verticalTwoWayMarker: () => [m["image_export.vector_by_walls.section_vertical"](), m["image_export.vector_by_walls.two_way_passage_marker"](), m["image_export.vector_by_walls.vertical_subsection_marker"]()],
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
  cornerStyle: descriptor("cornerStyle", m["image_export.param_links.shared_corner_style"](), G.sharedStyle()),
  markerSize: descriptor("number", m["image_export.param_links.shared_marker_size"](), G.sharedStyle()),
  markerBorderWidth: descriptor("number", m["image_export.param_links.shared_marker_border_width"](), G.sharedStyle()),
  gapWidth: descriptor("number", m["image_export.param_links.shared_gap_width"](), G.sharedStyle()),

  wallJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.wall_join"](), [m["image_export.vector_by_walls.section_tiles"]()]),
  oneWayJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.one_way_join"](), [m["image_export.vector_by_walls.section_one_ways"]()]),
  "startMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersStart()),
  "startMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersStart()),
  "startMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersStart()),
  "startMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersStart()),
  "startMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersStart()),
  "finishMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersFinish()),
  "finishMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersFinish()),
  "finishMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersFinish()),
  "finishMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersFinish()),
  "finishMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersFinish()),
  teleportLineCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.teleport_corner_style"](), G.teleportMarkers()),
  teleportLineSize: descriptor("number", m["image_export.vector_by_walls.teleport_size"](), G.teleportMarkers()),
  teleportLineShape: descriptor("markerShape", m["image_export.vector_by_walls.teleport_shape"](), G.teleportMarkers()),
  teleportEdgeBorderWidth: descriptor("number", m["image_export.vector_by_walls.teleport_border_width"](), G.teleportMarkers()),
  teleportEdgeGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_edge_gap_width"](), G.teleportMarkers()),
  teleportConnectorGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_connector_gap_width"](), G.teleportConnector()),
  teleportAvoidFieldExit: descriptor("boolean", m["image_export.vector_by_walls.teleport_avoid_field_exit"](), G.teleportConnector(), formatBoolean),
  teleportGroupCustomization: descriptor("boolean", m["image_export.vector_by_walls.teleport_group_customization"](), G.teleportRoot(), formatBoolean),
  "teleportFloorBadge.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_floor_badge_shape"](), G.teleportFloorBadges()),
  "teleportFloorBadge.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.teleport_floor_badge_label_type"](), G.teleportFloorBadges(), formatElevatorBadgesLabelType),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalTwoWayMarker()),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalOneWayMarker()),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorMarker()),
  "elevatorMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalElevatorMarker()),
  "elevatorMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalElevatorMarker()),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorBadges()),
  "elevatorBadges.enabled": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_enabled"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.evenDistribution": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_even_distribution"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.size": descriptor("number", m["image_export.vector_by_walls.elevator_badges_size"](), G.verticalElevatorBadges()),
  "elevatorBadges.distance": descriptor("number", m["image_export.vector_by_walls.elevator_badges_distance"](), G.verticalElevatorBadges()),
  "elevatorBadges.gap": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap"](), G.verticalElevatorBadges()),
  "elevatorBadges.gapWidth": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.shape": descriptor("markerShape", m["image_export.vector_by_walls.elevator_badges_shape"](), G.verticalElevatorBadges()),
  "elevatorBadges.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.elevator_badges_label_type"](), G.verticalElevatorBadges(), formatElevatorBadgesLabelType),
  "elevatorBadges.fontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.elevator_badges_font_weight"](), G.verticalElevatorBadges(), formatElevatorBadgesFontWeight),
  "markerIndex.gap": descriptor("number", m["image_export.vector_by_walls.marker_index_gap"](), G.markerIndex()),
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
  "markerIndex.coverage.singleFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.crossFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.verticalPassage": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.elevator": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_elevator"](), G.markerIndexCoverage(), formatBoolean),

  wallThickness: descriptor("number", m["image_export.vector_by_walls.wall_thickness"](), G.tiles()),
  oneWayGapWidth: descriptor("number", m["image_export.vector_by_walls.one_way_gap_width"](), G.oneWays()),
  oneWaySize: descriptor("number", m["image_export.vector_by_walls.one_way_size"](), G.oneWays()),
  oneWayThickness: descriptor("number", m["image_export.vector_by_walls.one_way_thickness"](), G.oneWays()),
  showGrid: descriptor("boolean", m["image_export.vector_by_walls.show_grid"](), G.background(), formatBoolean),
  showInnerGrid: descriptor("boolean", m["image_export.vector_by_walls.show_inner_grid"](), G.background(), formatBoolean),
  replaceTwoFloorElevatorsWithStairs: descriptor("boolean", m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"](), G.verticalRoot(), formatBoolean),
  splitSpecialShapes: descriptor("boolean", m["image_export.vector_by_walls.split_special_shapes"](), G.splits(), formatBoolean),
  "decorativeStairsTwoWay.lineWidth": descriptor("number", m["image_export.vector_by_walls.decorative_line_width"](), G.verticalTwoWay()),
  "decorativeStairsTwoWay.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalTwoWay()),
  "decorativeStairsOneWay.lineWidth": descriptor("number", m["image_export.vector_by_walls.decorative_line_width"](), G.verticalOneWay()),
  "decorativeStairsOneWay.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalOneWay()),
  "decorativeElevator.lineWidth": descriptor("number", m["image_export.vector_by_walls.decorative_line_width"](), G.verticalElevator()),
  "decorativeElevator.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalElevator()),
  decorativeStairsArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalTwoWayArrows()),
  decorativeStairsOneWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalOneWayArrows()),
  twoWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalTwoWayArrows()),
  twoWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalTwoWayArrows()),
  twoWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalTwoWayArrows()),
  oneWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalOneWayArrows()),
  oneWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalOneWayArrows()),
  oneWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalOneWayArrows()),
  elevatorArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalElevatorArrows()),
  elevatorArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalElevatorArrows()),
  elevatorArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalElevatorArrows()),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByWallsParamPath = keyof typeof VECTOR_BY_WALLS_PARAM_REGISTRY;

/** Same role as `VECTOR_BY_WALLS_PARAM_REGISTRY`, for "Vector by corridors" — its dependent field
 *  set differs (no `wallJoin`, has `join` instead; `gapWidth` also reaches `splitGapWidth`). */
export const VECTOR_BY_CORRIDORS_PARAM_REGISTRY = {
  cornerStyle: descriptor("cornerStyle", m["image_export.param_links.shared_corner_style"](), G.sharedStyle()),
  markerSize: descriptor("number", m["image_export.param_links.shared_marker_size"](), G.sharedStyle()),
  markerBorderWidth: descriptor("number", m["image_export.param_links.shared_marker_border_width"](), G.sharedStyle()),
  gapWidth: descriptor("number", m["image_export.param_links.shared_gap_width"](), G.sharedStyle()),

  join: descriptor("cornerStyle", m["image_export.vector_by_corridors.join"](), [m["image_export.vector_by_corridors.section_cells"]()]),
  oneWayJoin: descriptor("cornerStyle", m["image_export.vector_by_walls.one_way_join"](), [m["image_export.vector_by_walls.section_one_ways"]()]),
  "startMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersStart()),
  "startMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersStart()),
  "startMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersStart()),
  "startMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersStart()),
  "startMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersStart()),
  "finishMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.markersFinish()),
  "finishMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.markersFinish()),
  "finishMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.markersFinish()),
  "finishMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.markersFinish()),
  "finishMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.markersFinish()),
  teleportLineCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.teleport_corner_style"](), G.teleportMarkers()),
  teleportLineSize: descriptor("number", m["image_export.vector_by_walls.teleport_size"](), G.teleportMarkers()),
  teleportLineShape: descriptor("markerShape", m["image_export.vector_by_walls.teleport_shape"](), G.teleportMarkers()),
  teleportEdgeBorderWidth: descriptor("number", m["image_export.vector_by_walls.teleport_border_width"](), G.teleportMarkers()),
  teleportEdgeGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_edge_gap_width"](), G.teleportMarkers()),
  teleportConnectorGapWidth: descriptor("number", m["image_export.vector_by_walls.teleport_connector_gap_width"](), G.teleportConnector()),
  teleportAvoidFieldExit: descriptor("boolean", m["image_export.vector_by_walls.teleport_avoid_field_exit"](), G.teleportConnector(), formatBoolean),
  teleportGroupCustomization: descriptor("boolean", m["image_export.vector_by_walls.teleport_group_customization"](), G.teleportRoot(), formatBoolean),
  "teleportFloorBadge.shape": descriptor("markerShape", m["image_export.vector_by_walls.teleport_floor_badge_shape"](), G.teleportFloorBadges()),
  "teleportFloorBadge.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.teleport_floor_badge_label_type"](), G.teleportFloorBadges(), formatElevatorBadgesLabelType),
  splitGapWidth: descriptor("number", m["image_export.vector_by_corridors.split_gap_width"](), [m["image_export.vector_by_walls.section_splits"]()]),
  splitSpecialShapes: descriptor("boolean", m["image_export.vector_by_walls.split_special_shapes"](), G.splits(), formatBoolean),
  splitDiagonalBowAmount: descriptor("number", m["image_export.vector_by_corridors.split_diagonal_bow_amount"](), G.splits()),
  "twoWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalTwoWayMarker()),
  "twoWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalTwoWayMarker()),
  "oneWayPassageMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalOneWayMarker()),
  "oneWayPassageMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalOneWayMarker()),
  "elevatorMarker.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorMarker()),
  "elevatorMarker.size": descriptor("number", m["image_export.vector_by_walls.marker_size"](), G.verticalElevatorMarker()),
  "elevatorMarker.borderWidth": descriptor("number", m["image_export.vector_by_walls.marker_border_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.gapWidth": descriptor("number", m["image_export.vector_by_walls.marker_gap_width"](), G.verticalElevatorMarker()),
  "elevatorMarker.shape": descriptor("markerShape", m["image_export.vector_by_walls.marker_shape"](), G.verticalElevatorMarker()),
  "elevatorBadges.cornerStyle": descriptor("cornerStyle", m["image_export.vector_by_walls.marker_corner_style"](), G.verticalElevatorBadges()),
  "elevatorBadges.enabled": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_enabled"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.evenDistribution": descriptor("boolean", m["image_export.vector_by_walls.elevator_badges_even_distribution"](), G.verticalElevatorBadges(), formatBoolean),
  "elevatorBadges.size": descriptor("number", m["image_export.vector_by_walls.elevator_badges_size"](), G.verticalElevatorBadges()),
  "elevatorBadges.distance": descriptor("number", m["image_export.vector_by_walls.elevator_badges_distance"](), G.verticalElevatorBadges()),
  "elevatorBadges.gap": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap"](), G.verticalElevatorBadges()),
  "elevatorBadges.gapWidth": descriptor("number", m["image_export.vector_by_walls.elevator_badges_gap_width"](), G.verticalElevatorBadges()),
  "elevatorBadges.shape": descriptor("markerShape", m["image_export.vector_by_walls.elevator_badges_shape"](), G.verticalElevatorBadges()),
  "elevatorBadges.labelType": descriptor("indexLabelStyle", m["image_export.vector_by_walls.elevator_badges_label_type"](), G.verticalElevatorBadges(), formatElevatorBadgesLabelType),
  "elevatorBadges.fontWeight": descriptor("labelFontWeight", m["image_export.vector_by_walls.elevator_badges_font_weight"](), G.verticalElevatorBadges(), formatElevatorBadgesFontWeight),
  "markerIndex.gap": descriptor("number", m["image_export.vector_by_walls.marker_index_gap"](), G.markerIndex()),
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
  "markerIndex.coverage.singleFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.crossFloorTeleport": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.verticalPassage": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"](), G.markerIndexCoverage(), formatBoolean),
  "markerIndex.coverage.elevator": descriptor("boolean", m["image_export.vector_by_walls.marker_index_coverage_elevator"](), G.markerIndexCoverage(), formatBoolean),

  thickness: descriptor("number", m["image_export.vector_by_corridors.thickness"](), G.cells()),
  markerWidenPadding: descriptor("number", m["image_export.vector_by_corridors.marker_widen_padding"](), G.cells()),
  oneWayCount: descriptor("number", m["image_export.vector_by_corridors.one_way_count"](), G.oneWays()),
  oneWayThickness: descriptor("number", m["image_export.vector_by_corridors.one_way_thickness"](), G.oneWays()),
  oneWayGap: descriptor("number", m["image_export.vector_by_corridors.one_way_gap"](), G.oneWays()),
  oneWayWidth: descriptor("number", m["image_export.vector_by_corridors.one_way_width"](), G.oneWays()),
  oneWayLength: descriptor("number", m["image_export.vector_by_corridors.one_way_length"](), G.oneWays()),
  showGrid: descriptor("boolean", m["image_export.vector_by_walls.show_grid"](), G.background(), formatBoolean),
  replaceTwoFloorElevatorsWithStairs: descriptor("boolean", m["image_export.vector_by_walls.replace_two_floor_elevators_with_stairs"](), G.verticalRoot(), formatBoolean),
  twoWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalTwoWayArrows()),
  twoWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalTwoWayArrows()),
  twoWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalTwoWayArrows()),
  oneWayArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalOneWayArrows()),
  oneWayArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalOneWayArrows()),
  oneWayArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalOneWayArrows()),
  elevatorArrowSize: descriptor("number", m["image_export.vector_by_walls.vertical_arrow_size"](), G.verticalElevatorArrows()),
  elevatorArrowStyle: descriptor("verticalArrowStyle", m["image_export.vector_by_walls.vertical_arrow_style"](), G.verticalElevatorArrows()),
  elevatorArrowCornerStyle: descriptor("cornerStyle", m["image_export.vector_by_walls.vertical_arrow_corner_style"](), G.verticalElevatorArrows()),
} as const satisfies Record<string, ParamDescriptor>;

export type VectorByCorridorsParamPath = keyof typeof VECTOR_BY_CORRIDORS_PARAM_REGISTRY;
