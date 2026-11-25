import type { Zone } from "../wasm/mazeService";
import type { ZoneGroup } from "../store/zonesTypes";
import type { QcZoneScopeTarget } from "../store/qcRuleTypes";
import { overrideZoneIds, type ZoneTargets } from "./zoneOverrides";
import { zoneCellsOutsideField } from "./fieldValidity";
import { presetEndpoint, type PresetEndpoint } from "./presetEndpoint";
import { coordinateWarningLevels, type CoordinateWarning } from "./coordinateWarning";
import type { ResolveFieldAt } from "./fieldEditUtils";
import { isAutoGroupId } from "./autoZones";

/** A manual zone with cells that are no longer cells of the field (GitHub issue #1034). */
export interface InvalidZone {
  zone: Zone;
  /** The cells outside the field, on every floor. */
  cells: Zone["cells"];
}

/** The manual zones holding cells outside the field, in zone order. Manual zones are never updated when the field
 *  changes, so the cells stay until the user returns them to the field or removes them. Automatic zones follow the
 *  field and never have such cells. */
export function invalidManualZones(zones: readonly Zone[], resolveFieldAt: ResolveFieldAt): InvalidZone[] {
  const manual = zones.filter((zone) => zone.kind === "manual");
  const outside = zoneCellsOutsideField(manual, resolveFieldAt);
  return manual.flatMap((zone) => {
    const cells = outside.get(zone.id);
    return cells ? [{ zone, cells }] : [];
  });
}

/** Coordinate targets of the invalid cells, one per distinct cell. A zone cell's floor is the target's `level`. */
export function invalidCellTargets(invalid: readonly InvalidZone[]): PresetEndpoint[] {
  const seen = new Set<string>();
  const targets: PresetEndpoint[] = [];
  for (const { cells } of invalid) {
    for (const [floor, x, y] of cells) {
      const key = `${floor},${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(presetEndpoint([x, y], undefined, floor));
    }
  }
  return targets;
}

/** The warning that lights the invalid cells of the zones: all of them merged into contours, so neighbouring cells read as
 *  one region rather than a scatter of cells. */
export function invalidCellsWarning(invalid: readonly InvalidZone[]): CoordinateWarning {
  const targets = invalidCellTargets(invalid);
  return { severity: "warning", targets, groups: [{ targets, outset: false }] };
}

/** Ascending floors that hold invalid cells of the zones. */
export function invalidCellFloors(invalid: readonly InvalidZone[]): number[] {
  return coordinateWarningLevels(invalidCellTargets(invalid));
}

/** The zones with the given cells removed (by zone id); every other zone is returned as it is. */
export function withoutCells(zones: readonly Zone[], cellsByZone: ReadonlyMap<number, Zone["cells"]>): Zone[] {
  return zones.map((zone) => {
    const cells = cellsByZone.get(zone.id);
    if (!cells) return zone;
    const drop = new Set(cells.map((cell) => cell.join(",")));
    return { ...zone, cells: zone.cells.filter((cell) => !drop.has(cell.join(","))) };
  });
}

/** The manual zones no feature uses: no generation override, export override or QC rule scope reaches them, directly
 *  or through a group. Membership in a group counts only while that group is used itself. */
export function unusedManualZones(
  zones: readonly Zone[],
  groups: readonly ZoneGroup[],
  overrides: readonly ZoneTargets[],
  rules: readonly { zoneScope?: QcZoneScopeTarget }[],
): Zone[] {
  const used = new Set<number>();
  for (const override of overrides) for (const id of overrideZoneIds(override, zones, groups)) used.add(id);
  for (const { zoneScope } of rules) {
    if (!zoneScope) continue;
    if (zoneScope.kind === "zone") used.add(zoneScope.id);
    else for (const id of groups.find((g) => g.id === zoneScope.id)?.zoneIds ?? []) used.add(id);
  }
  return zones.filter((zone) => zone.kind === "manual" && !used.has(zone.id));
}

/** The manual zones with no cell on any floor. */
export function emptyManualZones(zones: readonly Zone[]): Zone[] {
  return zones.filter((zone) => zone.kind === "manual" && zone.cells.length === 0);
}

/** The manual groups holding no zone: a group is created with one, but deleting its zones can leave it empty. Automatic
 *  groups exist only while they have a zone to collect. */
export function emptyManualGroups(groups: readonly ZoneGroup[]): ZoneGroup[] {
  return groups.filter((group) => !isAutoGroupId(group.id) && group.zoneIds.length === 0);
}

/** Zones with problems, by zone id, for the cards of the lists: `invalid` the number of cells outside the field. */
export interface ZoneProblems {
  invalid: Map<number, number>;
  unused: Set<number>;
  empty: Set<number>;
}

export function zoneProblemsOf(invalid: readonly InvalidZone[], unused: readonly Zone[], empty: readonly Zone[]): ZoneProblems {
  return {
    invalid: new Map(invalid.map(({ zone, cells }) => [zone.id, cells.length])),
    unused: new Set(unused.map((zone) => zone.id)),
    empty: new Set(empty.map((zone) => zone.id)),
  };
}
