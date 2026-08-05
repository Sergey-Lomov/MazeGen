import * as m from "~/paraglide/messages";
import type { ExportWarningId } from "../../pixi/selectors/exportWarnings";

/** Localized message/description per `ExportWarningId` (GitHub issue #298) — kept separate from
 *  `exportWarnings.ts` since that selector must stay renderer/i18n-agnostic (a future feature-card
 *  consumer may want the raw warning list without paraglide's message strings). Mirrors
 *  `qualityI18n.ts`'s label/description resolver shape. */
const WARNING_MESSAGES: Record<ExportWarningId, () => string> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap"],
  waypoint_on_split: m["image_export.vector_by_walls.warning_waypoint_on_split"],
  teleport_on_special_split: m["image_export.vector_by_walls.warning_teleport_on_special_split"],
};

const WARNING_DESCRIPTIONS: Record<ExportWarningId, () => string> = {
  teleport_marker_invisible: m["image_export.vector_by_walls.warning_teleport_marker_invisible_description"],
  teleport_group_ambiguous: m["image_export.vector_by_walls.warning_teleport_group_ambiguous_description"],
  teleport_waypoint_overlap: m["image_export.vector_by_walls.warning_teleport_waypoint_overlap_description"],
  waypoint_on_split: m["image_export.vector_by_walls.warning_waypoint_on_split_description"],
  teleport_on_special_split: m["image_export.vector_by_walls.warning_teleport_on_special_split_description"],
};

export function resolveExportWarningMessage(id: ExportWarningId): string {
  return WARNING_MESSAGES[id]();
}

export function resolveExportWarningDescription(id: ExportWarningId): string {
  return WARNING_DESCRIPTIONS[id]();
}

export function resolveExportWarningsSectionTitle(count: number): string {
  return m["image_export.vector_by_walls.section_warnings"]({ count: String(count) });
}
