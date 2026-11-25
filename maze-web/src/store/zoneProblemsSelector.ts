import type { Zone } from "../wasm/mazeService";
import type { MazeStore } from "./storeTypes";
import type { ZoneGroup } from "./zonesTypes";
import { resolveFieldAtOf } from "./storeHelpers";
import { emptyManualGroups, emptyManualZones, invalidManualZones, unusedManualZones, zoneProblemsOf, type InvalidZone, type ZoneProblems } from "../domain/zoneProblems";

/** The problems of the manual zones (GitHub issue #1034), for the zones card, its warnings and the list cards. */
export interface ZoneProblemsSummary {
  invalid: InvalidZone[];
  unused: Zone[];
  emptyZones: Zone[];
  emptyGroups: ZoneGroup[];
  byZone: ZoneProblems;
}

/** The number of warnings the zones card shows (its status and its Warnings section): one each for the zones beyond the
 *  field, the unused zones and the empty zones and groups. */
export function zoneWarningCount(p: Pick<ZoneProblemsSummary, "invalid" | "unused" | "emptyZones" | "emptyGroups">): number {
  return [p.invalid.length, p.unused.length, p.emptyZones.length + p.emptyGroups.length].filter((n) => n > 0).length;
}

let last: { inputs: readonly unknown[]; summary: ZoneProblemsSummary } | null = null;

/** Zone problems of the store. The selector runs on every store change but the result is kept while its inputs are the
 *  same objects, so a subscriber re-renders only when a problem can actually have changed. */
export function selectZoneProblems(s: MazeStore): ZoneProblemsSummary {
  const inputs = [
    s.zones, s.zoneGroups, s.zoneOverrides, s.exportZoneOverrides, s.rules,
    s.floors, s.floorFields, s.tessellationKind, s.tessellationParams, s.hexOrientation, s.triOrientation, s.smoothPrimitives,
  ];
  if (last && last.inputs.every((input, i) => input === inputs[i])) return last.summary;
  // The field is only resolved when some manual zone has a cell to check (and every floor has its field, which a
  // store caught between two updates of the floors may not).
  const checked = s.zones.some((zone) => zone.kind === "manual" && zone.cells.length > 0) && s.floors.every((floor) => s.floorFields[floor.id]);
  const invalid = checked ? invalidManualZones(s.zones, resolveFieldAtOf(s)) : [];
  const unused = unusedManualZones(s.zones, s.zoneGroups, [...s.zoneOverrides, ...s.exportZoneOverrides], s.rules);
  const emptyZones = emptyManualZones(s.zones);
  const summary = { invalid, unused, emptyZones, emptyGroups: emptyManualGroups(s.zoneGroups), byZone: zoneProblemsOf(invalid, unused, emptyZones) };
  last = { inputs, summary };
  return summary;
}
