import { useMazeStore } from "../../store/mazeStore";
import { zoneDisplayName, zoneGroupDisplayName } from "../../domain/selectors/zoneSelectors";
import * as m from "~/paraglide/messages";
import type { ExportZoneOverride } from "../../store/zonesTypes";
import type { ExportWarning } from "../../pixi/selectors/exportWarnings";
import { ExportWarningBubble } from "./ExportWarningBubble";
import { ZoneTargetBadges } from "./ZoneTargetBadges";

/** An export problem that only shows with one zone override's values (GitHub issue #1040): the usual warning bubble with the
 *  zones and groups of that override on its bottom left. */
export function ExportZoneProblemBubble({ override, warning }: { override: ExportZoneOverride; warning: ExportWarning }) {
  return <ExportWarningBubble warning={{ ...warning, key: `zone${override.id}:${warning.key}` }} footer={<ZoneTargetBadges target={override} />} details={<ZoneContextText override={override} />} />;
}

/** The override's zones and groups as plain text for the warning's details: "Context: Zone 1, Group A (group)". */
function ZoneContextText({ override }: { override: ExportZoneOverride }) {
  const zones = useMazeStore((s) => s.zones);
  const groups = useMazeStore((s) => s.zoneGroups);
  const floors = useMazeStore((s) => s.floors);
  const names = [
    ...groups.filter((g) => override.groupIds.includes(g.id)).map((g) => `${zoneGroupDisplayName(g)} ${m["image_export.zone_overrides.context_group_suffix"]()}`),
    ...zones.filter((z) => override.zoneIds.includes(z.id)).map((z) => zoneDisplayName(z, floors)),
  ];
  return <>{m["image_export.zone_overrides.context_label"]()} {names.join(", ")}</>;
}
