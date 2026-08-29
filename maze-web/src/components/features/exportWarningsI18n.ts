import * as m from "~/paraglide/messages";
import type { ExportWarningId } from "../../pixi/selectors/exportWarnings";

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
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable"],
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
  one_way_arrows_overflow_corridor: m["image_export.vector_by_corridors.warning_one_way_arrows_overflow_description"],
  elevator_indistinguishable: m["image_export.vector_by_walls.warning_elevator_indistinguishable_description"],
};

export function resolveExportWarningMessage(id: ExportWarningId): string {
  return WARNING_MESSAGES[id]?.() ?? "";
}

export function resolveExportWarningDescription(id: ExportWarningId): string {
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
