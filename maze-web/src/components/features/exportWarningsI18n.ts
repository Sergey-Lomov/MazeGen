import * as m from "~/paraglide/messages";
import type { ExportWarningColorRole, ExportWarningId } from "../../pixi/selectors/exportWarnings";

/** Localized message/description per `ExportWarningId` (GitHub issue #298) — kept separate from
 *  `exportWarnings.ts` since that selector must stay renderer/i18n-agnostic (a future feature-card
 *  consumer may want the raw warning list without paraglide's message strings). Mirrors
 *  `qualityI18n.ts`'s label/description resolver shape. */
const WARNING_MESSAGES: Partial<Record<ExportWarningId, () => string>> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap"],
  waypoint_on_split: m["image_export.vector_by_walls.warning_waypoint_on_split"],
  teleport_on_special_split: m["image_export.vector_by_walls.warning_teleport_on_special_split"],
  vertical_on_special_split: m["image_export.vector_by_walls.warning_vertical_on_special_split"],
  elevator_badges_overlap: m["image_export.vector_by_walls.warning_elevator_badges_overlap"],
  elevator_badges_too_many: m["image_export.vector_by_walls.warning_elevator_badges_too_many"],
  marker_text_overflow: m["image_export.vector_by_walls.warning_marker_text_overflow"],
  elevator_badge_text_overflow: m["image_export.vector_by_walls.warning_elevator_badge_text_overflow"],
  teleport_badge_text_overflow: m["image_export.vector_by_walls.warning_teleport_badge_text_overflow"],
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow"],
  split_gap_may_shrink: m["image_export.vector_by_corridors.warning_split_gap_may_shrink"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable"],
  one_way_low_contrast_corridor: m["image_export.warning.one_way_low_contrast_corridor"],
  corridor_low_contrast_background: m["image_export.warning.corridor_low_contrast_background"],
  teleport_connector_low_contrast_corridor: m["image_export.warning.teleport_connector_low_contrast_corridor"],
  teleport_connector_low_contrast_background: m["image_export.warning.teleport_connector_low_contrast_background"],
  split_low_contrast_corridor: m["image_export.warning.split_low_contrast_corridor"],
  teleport_connector_low_contrast_floor: m["image_export.warning.teleport_connector_low_contrast_floor"],
  teleport_connector_low_contrast_wall: m["image_export.warning.teleport_connector_low_contrast_wall"],
  split_low_contrast_floor: m["image_export.warning.split_low_contrast_floor"],
  grid_low_contrast_background: m["image_export.warning.grid_low_contrast_background"],
  inner_grid_low_contrast_floor: m["image_export.warning.inner_grid_low_contrast_floor"],
  inner_grid_low_contrast_wall: m["image_export.warning.inner_grid_low_contrast_wall"],
  marker_fill_low_contrast: m["image_export.warning.marker_fill_low_contrast"],
  marker_border_low_contrast: m["image_export.warning.marker_border_low_contrast"],
  marker_fill_low_contrast_corridor: m["image_export.warning.marker_fill_low_contrast_corridor"],
  marker_fill_low_contrast_floor: m["image_export.warning.marker_fill_low_contrast_floor"],
  marker_border_low_contrast_corridor: m["image_export.warning.marker_border_low_contrast_corridor"],
  marker_border_low_contrast_floor: m["image_export.warning.marker_border_low_contrast_floor"],
  label_low_contrast: m["image_export.warning.label_low_contrast"],
  teleport_badge_text_low_contrast: m["image_export.warning.label_low_contrast"],
  vertical_arrow_low_contrast: m["image_export.warning.vertical_arrow_low_contrast"],
  vertical_one_way_arrow_low_contrast_fill: m["image_export.warning.vertical_one_way_arrow_low_contrast_fill"],
  elevator_arrow_low_contrast: m["image_export.warning.elevator_arrow_low_contrast"],
  elevator_badge_fill_low_contrast: m["image_export.warning.elevator_badge_fill_low_contrast"],
  elevator_badge_fill_low_contrast_corridor: m["image_export.warning.elevator_badge_fill_low_contrast_corridor"],
  elevator_badge_fill_low_contrast_floor: m["image_export.warning.elevator_badge_fill_low_contrast_floor"],
  teleport_badge_border_low_contrast: m["image_export.warning.teleport_badge_border_low_contrast"],
  teleport_badge_border_low_contrast_corridor: m["image_export.warning.teleport_badge_border_low_contrast_corridor"],
  teleport_badge_border_low_contrast_floor: m["image_export.warning.teleport_badge_border_low_contrast_floor"],
  teleport_badge_fill_low_contrast: m["image_export.warning.teleport_badge_fill_low_contrast"],
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
};

const WARNING_DESCRIPTIONS: Partial<Record<ExportWarningId, () => string>> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible_description"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous_description"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap_description"],
  waypoint_on_split: m["image_export.vector_by_walls.warning_waypoint_on_split_description"],
  teleport_on_special_split: m["image_export.vector_by_walls.warning_teleport_on_special_split_description"],
  vertical_on_special_split: m["image_export.vector_by_walls.warning_vertical_on_special_split_description"],
  elevator_badges_overlap: m["image_export.vector_by_walls.warning_elevator_badges_overlap_description"],
  elevator_badges_too_many: m["image_export.vector_by_walls.warning_elevator_badges_too_many_description"],
  marker_text_overflow: m["image_export.vector_by_walls.warning_marker_text_overflow_description"],
  elevator_badge_text_overflow: m["image_export.vector_by_walls.warning_elevator_badge_text_overflow_description"],
  teleport_badge_text_overflow: m["image_export.vector_by_walls.warning_teleport_badge_text_overflow_description"],
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow_description"],
  split_gap_may_shrink: m["image_export.vector_by_corridors.warning_split_gap_may_shrink_description"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable_description"],
  one_way_low_contrast_corridor: m["image_export.warning.one_way_low_contrast_corridor_description"],
  corridor_low_contrast_background: m["image_export.warning.corridor_low_contrast_background_description"],
  teleport_connector_low_contrast_corridor: m["image_export.warning.teleport_connector_low_contrast_corridor_description"],
  teleport_connector_low_contrast_background: m["image_export.warning.teleport_connector_low_contrast_background_description"],
  split_low_contrast_corridor: m["image_export.warning.split_low_contrast_corridor_description"],
  teleport_connector_low_contrast_floor: m["image_export.warning.teleport_connector_low_contrast_floor_description"],
  teleport_connector_low_contrast_wall: m["image_export.warning.teleport_connector_low_contrast_wall_description"],
  split_low_contrast_floor: m["image_export.warning.split_low_contrast_floor_description"],
  grid_low_contrast_background: m["image_export.warning.grid_low_contrast_background_description"],
  inner_grid_low_contrast_floor: m["image_export.warning.inner_grid_low_contrast_floor_description"],
  inner_grid_low_contrast_wall: m["image_export.warning.inner_grid_low_contrast_wall_description"],
  marker_fill_low_contrast: m["image_export.warning.marker_fill_low_contrast_description"],
  marker_border_low_contrast: m["image_export.warning.marker_border_low_contrast_description"],
  marker_fill_low_contrast_corridor: m["image_export.warning.marker_fill_low_contrast_corridor_description"],
  marker_fill_low_contrast_floor: m["image_export.warning.marker_fill_low_contrast_floor_description"],
  marker_border_low_contrast_corridor: m["image_export.warning.marker_border_low_contrast_corridor_description"],
  marker_border_low_contrast_floor: m["image_export.warning.marker_border_low_contrast_floor_description"],
  label_low_contrast: m["image_export.warning.label_low_contrast_description"],
  teleport_badge_text_low_contrast: m["image_export.warning.label_low_contrast_description"],
  vertical_arrow_low_contrast: m["image_export.warning.vertical_arrow_low_contrast_description"],
  vertical_one_way_arrow_low_contrast_fill: m["image_export.warning.vertical_one_way_arrow_low_contrast_fill_description"],
  elevator_arrow_low_contrast: m["image_export.warning.elevator_arrow_low_contrast_description"],
  elevator_badge_fill_low_contrast: m["image_export.warning.elevator_badge_fill_low_contrast_description"],
  elevator_badge_fill_low_contrast_corridor: m["image_export.warning.elevator_badge_fill_low_contrast_corridor_description"],
  elevator_badge_fill_low_contrast_floor: m["image_export.warning.elevator_badge_fill_low_contrast_floor_description"],
  teleport_badge_border_low_contrast: m["image_export.warning.teleport_badge_border_low_contrast_description"],
  teleport_badge_border_low_contrast_corridor: m["image_export.warning.teleport_badge_border_low_contrast_corridor_description"],
  teleport_badge_border_low_contrast_floor: m["image_export.warning.teleport_badge_border_low_contrast_floor_description"],
  teleport_badge_fill_low_contrast: m["image_export.warning.teleport_badge_fill_low_contrast_description"],
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
};

export function resolveExportWarningMessage(id: ExportWarningId): string {
  return WARNING_MESSAGES[id]?.() ?? "";
}

const COLOR_ROLE_LABELS: Record<ExportWarningColorRole, () => string> = {
  background: m["image_export.color_role.background"], grid: m["image_export.color_role.grid"], inner_grid: m["image_export.color_role.inner_grid"], corridor: m["image_export.color_role.corridor"],
  floor: m["image_export.color_role.floor"], wall: m["image_export.color_role.wall"], one_way: m["image_export.color_role.one_way"],
  split: m["image_export.color_role.split"], marker_fill: m["image_export.color_role.marker_fill"], marker_border: m["image_export.color_role.marker_border"],
  label_text: m["image_export.color_role.label_text"], label_background: m["image_export.color_role.label_background"],
  teleport_connector: m["image_export.color_role.teleport_connector"], teleport_badge_border: m["image_export.color_role.teleport_badge_border"],
  teleport_badge_fill: m["image_export.color_role.teleport_badge_fill"], teleport_badge_text: m["image_export.color_role.teleport_badge_text"],
  vertical_two_way_fill: m["image_export.color_role.vertical_two_way_fill"], vertical_two_way_border: m["image_export.color_role.vertical_two_way_border"],
  vertical_two_way_arrow: m["image_export.color_role.vertical_two_way_arrow"], vertical_one_way_fill: m["image_export.color_role.vertical_one_way_fill"],
  vertical_two_way_line: m["image_export.color_role.vertical_two_way_line"], vertical_one_way_line: m["image_export.color_role.vertical_one_way_line"],
  vertical_one_way_border: m["image_export.color_role.vertical_one_way_border"], vertical_one_way_arrow: m["image_export.color_role.vertical_one_way_arrow"],
  vertical_one_way_decorative_arrow: m["image_export.color_role.vertical_one_way_decorative_arrow"],
  elevator_fill: m["image_export.color_role.elevator_fill"], elevator_border: m["image_export.color_role.elevator_border"],
  elevator_arrow: m["image_export.color_role.elevator_arrow"], elevator_line: m["image_export.color_role.elevator_line"], elevator_badge_fill: m["image_export.color_role.elevator_badge_fill"],
};

function formatHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

export function resolveExportWarningDescription(
  id: ExportWarningId,
  colorRoles?: [ExportWarningColorRole, ExportWarningColorRole],
  colorValues?: [number, number],
): string {
  if (colorRoles && colorValues) {
    return m["image_export.warning.color_contrast_description"]({
      foreground: COLOR_ROLE_LABELS[colorRoles[0]](),
      background: COLOR_ROLE_LABELS[colorRoles[1]](),
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
export type PngFitWarningId = "png_content_clips_sheet" | "png_content_in_margin_zone";

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
  }
}

export function resolvePngFitWarningDescription(id: PngFitWarningId): string {
  switch (id) {
    case "png_content_clips_sheet": return m["image_export.format.png.warning_clips_sheet_description"]();
    case "png_content_in_margin_zone": return m["image_export.format.png.warning_in_margin_zone_description"]();
  }
}

export function resolveExportWarningsSectionTitle(count: number): string {
  return m["image_export.vector_by_walls.section_warnings"]({ count: String(count) });
}
