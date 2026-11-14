import * as m from "~/paraglide/messages";
import type { ExportWarningId } from "../../pixi/selectors/exportWarnings";
import type { ColorFieldKey } from "../../pixi/colorFieldKeys";
import type { MarkerLookKind } from "../../pixi/selectors/exportMarkerLookAlike";
import { resolveColorField } from "../../pixi/selectors/projectColorsSelector";
import { MIN_COMFORTABLE_CELL_SIDE_MM } from "../../pixi/printCellSizes";

/** Localized message/description per `ExportWarningId` (GitHub issue #298) — kept separate from
 *  `exportWarnings.ts` since that selector must stay renderer/i18n-agnostic (a future feature-card
 *  consumer may want the raw warning list without paraglide's message strings). Mirrors
 *  `qualityI18n.ts`'s label/description resolver shape. */
const WARNING_MESSAGES: Partial<Record<ExportWarningId, () => string>> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous"],
  teleport_merged_without_connectors: m["image_export.vector_by_walls.warning_teleport_merged_without_connectors"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap"],
  teleport_connector_covers_one_way: m["image_export.warning.teleport_connector_covers_one_way"],
  teleport_connectors_overlap: m["image_export.warning.teleport_connectors_overlap"],
  teleport_connector_endpoint_detached: m["image_export.warning.teleport_connector_endpoint_detached"],
  teleport_connector_leaves_field: m["image_export.warning.teleport_connector_leaves_field"],
  teleport_connector_crosses_marker: m["image_export.warning.teleport_connector_crosses_marker"],
  teleport_connector_arrow_sticks_out: m["image_export.warning.teleport_connector_arrow_sticks_out"],
  teleport_connector_too_short_for_arrow: m["image_export.warning.teleport_connector_too_short_for_arrow"],
  teleport_connector_covers_arrow: m["image_export.warning.teleport_connector_covers_arrow"],
  teleport_connector_degenerate: m["image_export.warning.teleport_connector_degenerate"],
  elevator_badges_overlap: m["image_export.vector_by_walls.warning_elevator_badges_overlap"],
  elevator_badges_merged_end_gap_too_small: m["image_export.vector_by_walls.warning_elevator_badges_merged_end_gap_too_small"],
  elevator_badges_gap_falls_back_to_even_distribution: m["image_export.vector_by_walls.warning_elevator_badges_gap_falls_back_to_even_distribution"],
  elevator_badges_too_many: m["image_export.vector_by_walls.warning_elevator_badges_too_many"],
  marker_text_overflow: m["image_export.vector_by_walls.warning_marker_text_overflow"],
  elevator_badge_text_overflow: m["image_export.vector_by_walls.warning_elevator_badge_text_overflow"],
  teleport_badge_text_overflow: m["image_export.vector_by_walls.warning_teleport_badge_text_overflow"],
  marker_index_text_overflow: m["image_export.vector_by_walls.warning_marker_index_text_overflow"],
  marker_index_covers_stop_line: m["image_export.vector_by_walls.warning_marker_index_covers_stop_line"],
  floor_label_text_overflow: m["image_export.floors.warning_text_overflow"],
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow"],
  split_gap_may_shrink: m["image_export.vector_by_corridors.warning_split_gap_may_shrink"],
  marker_extension_hits_corridor: m["image_export.vector_by_corridors.warning_marker_extension_hits_corridor"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable"],
  markers_look_alike: m["image_export.warning.markers_look_alike"],
  start_invisible: m["image_export.warning.start_invisible"],
  finish_invisible: m["image_export.warning.finish_invisible"],
  start_opening_no_outer_wall: m["image_export.warning.start_opening_no_outer_wall"],
  finish_opening_no_outer_wall: m["image_export.warning.finish_opening_no_outer_wall"],
  edge_marker_looks_like_marker: m["image_export.warning.edge_marker_looks_like_marker"],
  one_way_low_contrast_corridor: m["image_export.warning.one_way_low_contrast_corridor"],
  corridor_low_contrast_background: m["image_export.warning.corridor_low_contrast_background"],
  teleport_connector_low_contrast_corridor: m["image_export.warning.teleport_connector_low_contrast_corridor"],
  teleport_connector_low_contrast_background: m["image_export.warning.teleport_connector_low_contrast_background"],
  split_low_contrast_corridor: m["image_export.warning.split_low_contrast_corridor"],
  teleport_connector_low_contrast_floor: m["image_export.warning.teleport_connector_low_contrast_floor"],
  teleport_connector_low_contrast_wall: m["image_export.warning.teleport_connector_low_contrast_wall"],
  split_low_contrast_floor: m["image_export.warning.split_low_contrast_floor"],
  grid_low_contrast_background: m["image_export.warning.grid_low_contrast_background"],
  glue_tab_outline_low_contrast_fill: m["image_export.warning.glue_tab_outline_low_contrast_fill"],
  glue_tab_fill_low_contrast_background: m["image_export.warning.glue_tab_fill_low_contrast_background"],
  glue_tabs_overlap: m["image_export.warning.glue_tabs_overlap"],
  glue_tab_too_thin: m["image_export.warning.glue_tab_too_thin"],
  glue_tab_missing: m["image_export.warning.glue_tab_missing"],
  edge_marker_colors_similar: m["image_export.warning.edge_marker_colors_similar"],
  edge_marker_low_contrast_background: m["image_export.warning.edge_marker_low_contrast_background"],
  seam_matching_ambiguous_without_markers: m["image_export.warning.seam_matching_ambiguous_without_markers"],
  inner_grid_low_contrast_floor: m["image_export.warning.inner_grid_low_contrast_floor"],
  inner_grid_low_contrast_wall: m["image_export.warning.inner_grid_low_contrast_wall"],
  marker_fill_low_contrast_corridor: m["image_export.warning.marker_fill_low_contrast_corridor"],
  marker_fill_low_contrast_floor: m["image_export.warning.marker_fill_low_contrast_floor"],
  marker_border_low_contrast_corridor: m["image_export.warning.marker_border_low_contrast_corridor"],
  marker_border_low_contrast_floor: m["image_export.warning.marker_border_low_contrast_floor"],
  label_low_contrast: m["image_export.warning.label_low_contrast"],
  teleport_badge_text_low_contrast: m["image_export.warning.label_low_contrast"],
  vertical_arrow_low_contrast: m["image_export.warning.vertical_arrow_low_contrast"],
  vertical_one_way_arrow_low_contrast_fill: m["image_export.warning.vertical_one_way_arrow_low_contrast_fill"],
  elevator_arrow_low_contrast: m["image_export.warning.elevator_arrow_low_contrast"],
  elevator_badge_fill_low_contrast_corridor: m["image_export.warning.elevator_badge_fill_low_contrast_corridor"],
  elevator_badge_fill_low_contrast_floor: m["image_export.warning.elevator_badge_fill_low_contrast_floor"],
  teleport_badge_border_low_contrast_corridor: m["image_export.warning.teleport_badge_border_low_contrast_corridor"],
  teleport_badge_border_low_contrast_floor: m["image_export.warning.teleport_badge_border_low_contrast_floor"],
  teleport_badge_fill_low_contrast_corridor: m["image_export.warning.teleport_badge_fill_low_contrast_corridor"],
  teleport_badge_fill_low_contrast_floor: m["image_export.warning.teleport_badge_fill_low_contrast_floor"],
  split_low_contrast_background: m["image_export.warning.split_low_contrast_background"],
  split_colors_low_contrast_each_other: m["image_export.warning.split_colors_low_contrast_each_other"],
  wall_low_contrast_floor: m["image_export.warning.wall_low_contrast_floor"],
  vertical_two_way_line_low_contrast_floor: m["image_export.warning.vertical_two_way_line_low_contrast_floor"],
  vertical_two_way_arrow_low_contrast_floor: m["image_export.warning.vertical_two_way_arrow_low_contrast_floor"],
  vertical_one_way_line_low_contrast_floor: m["image_export.warning.vertical_one_way_line_low_contrast_floor"],
  vertical_one_way_accent_low_contrast_floor: m["image_export.warning.vertical_one_way_accent_low_contrast_floor"],
  elevator_line_low_contrast_floor: m["image_export.warning.elevator_line_low_contrast_floor"],
  floor_label_fill_low_contrast_corridor: m["image_export.warning.floor_label_fill_low_contrast_corridor"],
  floor_label_fill_low_contrast_floor: m["image_export.warning.floor_label_fill_low_contrast_floor"],
  floor_label_border_low_contrast_corridor: m["image_export.warning.floor_label_border_low_contrast_corridor"],
  floor_label_border_low_contrast_floor: m["image_export.warning.floor_label_border_low_contrast_floor"],
  floor_label_text_low_contrast: m["image_export.warning.floor_label_text_low_contrast"],
};

const WARNING_DESCRIPTIONS: Partial<Record<ExportWarningId, () => string>> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible_description"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous_description"],
  teleport_merged_without_connectors: m["image_export.vector_by_walls.warning_teleport_merged_without_connectors_description"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap_description"],
  teleport_connector_covers_one_way: m["image_export.warning.teleport_connector_covers_one_way_description"],
  teleport_connectors_overlap: m["image_export.warning.teleport_connectors_overlap_description"],
  teleport_connector_endpoint_detached: m["image_export.warning.teleport_connector_endpoint_detached_description"],
  teleport_connector_leaves_field: m["image_export.warning.teleport_connector_leaves_field_description"],
  teleport_connector_crosses_marker: m["image_export.warning.teleport_connector_crosses_marker_description"],
  teleport_connector_arrow_sticks_out: m["image_export.warning.teleport_connector_arrow_sticks_out_description"],
  teleport_connector_too_short_for_arrow: m["image_export.warning.teleport_connector_too_short_for_arrow_description"],
  teleport_connector_covers_arrow: m["image_export.warning.teleport_connector_covers_arrow_description"],
  teleport_connector_degenerate: m["image_export.warning.teleport_connector_degenerate_description"],
  elevator_badges_overlap: m["image_export.vector_by_walls.warning_elevator_badges_overlap_description"],
  elevator_badges_merged_end_gap_too_small: m["image_export.vector_by_walls.warning_elevator_badges_merged_end_gap_too_small_description"],
  elevator_badges_gap_falls_back_to_even_distribution: m["image_export.vector_by_walls.warning_elevator_badges_gap_falls_back_to_even_distribution_description"],
  elevator_badges_too_many: m["image_export.vector_by_walls.warning_elevator_badges_too_many_description"],
  marker_text_overflow: m["image_export.vector_by_walls.warning_marker_text_overflow_description"],
  elevator_badge_text_overflow: m["image_export.vector_by_walls.warning_elevator_badge_text_overflow_description"],
  teleport_badge_text_overflow: m["image_export.vector_by_walls.warning_teleport_badge_text_overflow_description"],
  marker_index_text_overflow: m["image_export.vector_by_walls.warning_marker_index_text_overflow_description"],
  marker_index_covers_stop_line: m["image_export.vector_by_walls.warning_marker_index_covers_stop_line_description"],
  floor_label_text_overflow: m["image_export.floors.warning_text_overflow_description"],
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow_description"],
  split_gap_may_shrink: m["image_export.vector_by_corridors.warning_split_gap_may_shrink_description"],
  marker_extension_hits_corridor: m["image_export.vector_by_corridors.warning_marker_extension_hits_corridor_description"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable_description"],
  // Needs the alike pairs; `resolveExportWarningDescription` builds it from `markerPairs`.
  markers_look_alike: () => "",
  start_invisible: m["image_export.warning.start_invisible_description"],
  finish_invisible: m["image_export.warning.finish_invisible_description"],
  start_opening_no_outer_wall: m["image_export.warning.start_opening_no_outer_wall_description"],
  finish_opening_no_outer_wall: m["image_export.warning.finish_opening_no_outer_wall_description"],
  edge_marker_looks_like_marker: () => "",
  one_way_low_contrast_corridor: m["image_export.warning.one_way_low_contrast_corridor_description"],
  corridor_low_contrast_background: m["image_export.warning.corridor_low_contrast_background_description"],
  teleport_connector_low_contrast_corridor: m["image_export.warning.teleport_connector_low_contrast_corridor_description"],
  teleport_connector_low_contrast_background: m["image_export.warning.teleport_connector_low_contrast_background_description"],
  split_low_contrast_corridor: m["image_export.warning.split_low_contrast_corridor_description"],
  teleport_connector_low_contrast_floor: m["image_export.warning.teleport_connector_low_contrast_floor_description"],
  teleport_connector_low_contrast_wall: m["image_export.warning.teleport_connector_low_contrast_wall_description"],
  split_low_contrast_floor: m["image_export.warning.split_low_contrast_floor_description"],
  grid_low_contrast_background: m["image_export.warning.grid_low_contrast_background_description"],
  glue_tab_outline_low_contrast_fill: m["image_export.warning.glue_tab_outline_low_contrast_fill_description"],
  glue_tab_fill_low_contrast_background: m["image_export.warning.glue_tab_fill_low_contrast_background_description"],
  glue_tabs_overlap: m["image_export.warning.glue_tabs_overlap_description"],
  glue_tab_too_thin: m["image_export.warning.glue_tab_too_thin_description"],
  glue_tab_missing: m["image_export.warning.glue_tab_missing_description"],
  edge_marker_colors_similar: m["image_export.warning.edge_marker_colors_similar_description"],
  edge_marker_low_contrast_background: m["image_export.warning.edge_marker_low_contrast_background_description"],
  seam_matching_ambiguous_without_markers: m["image_export.warning.seam_matching_ambiguous_without_markers_description"],
  inner_grid_low_contrast_floor: m["image_export.warning.inner_grid_low_contrast_floor_description"],
  inner_grid_low_contrast_wall: m["image_export.warning.inner_grid_low_contrast_wall_description"],
  marker_fill_low_contrast_corridor: m["image_export.warning.marker_fill_low_contrast_corridor_description"],
  marker_fill_low_contrast_floor: m["image_export.warning.marker_fill_low_contrast_floor_description"],
  marker_border_low_contrast_corridor: m["image_export.warning.marker_border_low_contrast_corridor_description"],
  marker_border_low_contrast_floor: m["image_export.warning.marker_border_low_contrast_floor_description"],
  label_low_contrast: m["image_export.warning.label_low_contrast_description"],
  teleport_badge_text_low_contrast: m["image_export.warning.label_low_contrast_description"],
  vertical_arrow_low_contrast: m["image_export.warning.vertical_arrow_low_contrast_description"],
  vertical_one_way_arrow_low_contrast_fill: m["image_export.warning.vertical_one_way_arrow_low_contrast_fill_description"],
  elevator_arrow_low_contrast: m["image_export.warning.elevator_arrow_low_contrast_description"],
  elevator_badge_fill_low_contrast_corridor: m["image_export.warning.elevator_badge_fill_low_contrast_corridor_description"],
  elevator_badge_fill_low_contrast_floor: m["image_export.warning.elevator_badge_fill_low_contrast_floor_description"],
  teleport_badge_border_low_contrast_corridor: m["image_export.warning.teleport_badge_border_low_contrast_corridor_description"],
  teleport_badge_border_low_contrast_floor: m["image_export.warning.teleport_badge_border_low_contrast_floor_description"],
  teleport_badge_fill_low_contrast_corridor: m["image_export.warning.teleport_badge_fill_low_contrast_corridor_description"],
  teleport_badge_fill_low_contrast_floor: m["image_export.warning.teleport_badge_fill_low_contrast_floor_description"],
  split_low_contrast_background: m["image_export.warning.split_low_contrast_background_description"],
  split_colors_low_contrast_each_other: m["image_export.warning.split_colors_low_contrast_each_other_description"],
  wall_low_contrast_floor: m["image_export.warning.wall_low_contrast_floor_description"],
  vertical_two_way_line_low_contrast_floor: m["image_export.warning.vertical_two_way_line_low_contrast_floor_description"],
  vertical_two_way_arrow_low_contrast_floor: m["image_export.warning.vertical_two_way_arrow_low_contrast_floor_description"],
  vertical_one_way_line_low_contrast_floor: m["image_export.warning.vertical_one_way_line_low_contrast_floor_description"],
  vertical_one_way_accent_low_contrast_floor: m["image_export.warning.vertical_one_way_accent_low_contrast_floor_description"],
  elevator_line_low_contrast_floor: m["image_export.warning.elevator_line_low_contrast_floor_description"],
  floor_label_fill_low_contrast_corridor: m["image_export.warning.floor_label_fill_low_contrast_corridor_description"],
  floor_label_fill_low_contrast_floor: m["image_export.warning.floor_label_fill_low_contrast_floor_description"],
  floor_label_border_low_contrast_corridor: m["image_export.warning.floor_label_border_low_contrast_corridor_description"],
  floor_label_border_low_contrast_floor: m["image_export.warning.floor_label_border_low_contrast_floor_description"],
  floor_label_text_low_contrast: m["image_export.warning.floor_label_text_low_contrast_description"],
};

export function resolveExportWarningMessage(id: ExportWarningId): string {
  return WARNING_MESSAGES[id]?.() ?? "";
}

function formatHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

const MARKER_KIND_NAMES: Record<MarkerLookKind, () => string> = {
  edge_marker: m["image_export.warning.marker_kind_edge_marker"],
  start: m["image_export.warning.marker_kind_start"],
  finish: m["image_export.warning.marker_kind_finish"],
  teleport: m["image_export.warning.marker_kind_teleport"],
  two_way_passage: m["image_export.warning.marker_kind_two_way_passage"],
  one_way_passage: m["image_export.warning.marker_kind_one_way_passage"],
  elevator: m["image_export.warning.marker_kind_elevator"],
};

export function resolveExportWarningDescription(
  id: ExportWarningId,
  colorFields?: [ColorFieldKey, ColorFieldKey],
  colorValues?: [number, number],
  markerPairs?: [MarkerLookKind, MarkerLookKind][],
): string {
  if (id === "markers_look_alike" || id === "edge_marker_looks_like_marker") {
    const pairs = (markerPairs ?? [])
      .map(([first, second]) => m["image_export.warning.marker_pair"]({ first: MARKER_KIND_NAMES[first](), second: MARKER_KIND_NAMES[second]() }))
      .join("; ");
    return m["image_export.warning.markers_look_alike_description"]({ pairs });
  }
  // Color names come from the project-color field registry, so a warning always names the same
  // "Section: Role" label the color picker and settings panels use.
  const foreground = colorFields && resolveColorField(colorFields[0]);
  const background = colorFields && resolveColorField(colorFields[1]);
  if (foreground && background && colorValues) {
    return m["image_export.warning.color_contrast_description"]({
      foreground: foreground.name(),
      background: background.name(),
      foregroundHex: formatHex(colorValues[0]),
      backgroundHex: formatHex(colorValues[1]),
    });
  }
  return WARNING_DESCRIPTIONS[id]?.() ?? "";
}

/** PNG canvas-fit warnings — resolved separately, by the specific `png_*` id, for
 *  `PngOverflowWarningBubble`/`PngFitWarningBubble` (`PngExportSettingsPanel.tsx`), which build
 *  their `ExportWarning` on the fly rather than going through `computeVectorByWallsWarnings`.
 *  `png_content_overflows_canvas` (digital mode) carries a fill-percentage parameter; the print
 *  mode ids (`png_content_clips_sheet`/`png_content_in_margin_zone`) are plain yes/no facts about
 *  the current placement and carry no parameter. */
export type PngOverflowWarningId = "png_content_overflows_canvas";
export type PngFitWarningId = "png_content_clips_sheet" | "png_content_in_margin_zone" | "png_min_side_too_short";

export function resolvePngExportWarningMessage(id: PngOverflowWarningId, percent: number): string {
  const p = { percent: String(Math.round(percent)) };
  switch (id) {
    case "png_content_overflows_canvas": return m["image_export.format.png.warning_overflows_canvas"](p);
  }
}

export function resolvePngExportWarningDescription(id: PngOverflowWarningId, percent: number): string {
  const p = { percent: String(Math.round(percent)) };
  switch (id) {
    case "png_content_overflows_canvas": return m["image_export.format.png.warning_overflows_canvas_description"](p);
  }
}

export function resolvePngFitWarningMessage(id: PngFitWarningId): string {
  switch (id) {
    case "png_content_clips_sheet": return m["image_export.format.png.warning_clips_sheet"]();
    case "png_content_in_margin_zone": return m["image_export.format.png.warning_in_margin_zone"]();
    case "png_min_side_too_short": return m["image_export.format.png.warning_min_side_too_short"]({ min: String(MIN_COMFORTABLE_CELL_SIDE_MM) });
  }
}

export function resolvePngFitWarningDescription(id: PngFitWarningId): string {
  switch (id) {
    case "png_content_clips_sheet": return m["image_export.format.png.warning_clips_sheet_description"]();
    case "png_content_in_margin_zone": return m["image_export.format.png.warning_in_margin_zone_description"]();
    case "png_min_side_too_short": return m["image_export.format.png.warning_min_side_too_short_description"]({ min: String(MIN_COMFORTABLE_CELL_SIDE_MM) });
  }
}

export function resolveExportWarningsSectionTitle(count: number): string {
  return m["image_export.vector_by_walls.section_warnings"]({ count: String(count) });
}
