import { TriangleAlert } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { selectZoneProblems } from "../../store/zoneProblemsSelector";
import type { ZoneGroup } from "../../store/zonesTypes";
import type { Zone } from "../../wasm/mazeService";
import { notificationPalette } from "../EmbeddedNotification";
import { Tooltip } from "../Tooltip";
import * as m from "~/paraglide/messages";

/** The warning icon of a list card, its tooltip the problems. Nothing while there are none. */
function ProblemIcon({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <Tooltip content={<>{lines.map((line) => <div key={line}>{line}</div>)}</>}>
      <TriangleAlert size={14} color={notificationPalette("warning").text} aria-label={lines.join(". ")} data-testid="zone-problem-icon" />
    </Tooltip>
  );
}

/** Problem icon of a zone card (GitHub issue #1034): cells outside the field, a manual zone no feature uses. */
export function ZoneProblemIcon({ zone }: { zone: Zone }) {
  const { byZone } = useMazeStore(selectZoneProblems);
  const lines: string[] = [];
  const invalidCount = byZone.invalid.get(zone.id);
  if (invalidCount !== undefined) lines.push(m["zones.problem_invalid_cells"]({ count: invalidCount }));
  if (byZone.empty.has(zone.id)) lines.push(m["zones.problem_empty"]());
  if (byZone.unused.has(zone.id)) lines.push(m["zones.problem_unused"]());
  return <ProblemIcon lines={lines} />;
}

/** Problem icon of a group card: the group has no zones. Its zones' problems are theirs, not the group's. */
export function ZoneGroupProblemIcon({ group }: { group: ZoneGroup }) {
  const { emptyGroups } = useMazeStore(selectZoneProblems);
  return <ProblemIcon lines={emptyGroups.some((g) => g.id === group.id) ? [m["zone_groups.problem_empty"]()] : []} />;
}
