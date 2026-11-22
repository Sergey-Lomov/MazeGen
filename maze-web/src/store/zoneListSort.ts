import type { Zone } from "../wasm/mazeService";
import { autoZoneKindOf, floorName } from "../domain/autoZones";
import { zoneGroupDisplayName } from "../domain/selectors/zoneSelectors";
import type { FloorState } from "./floorsTypes";
import type { ZoneGroup } from "./zonesTypes";
import * as m from "~/paraglide/messages";

const TYPE_LABELS = {
  maze: () => m["zones.type_maze"](),
  type: () => m["zones.type_cell_type"](),
  floor: () => m["zones.type_floor"](),
  edge: () => m["zones.type_edge"](),
  face: () => m["zones.type_face"](),
  region: () => m["zones.type_region"](),
} as const;

/** The localized name of a zone's type, the key types are ordered by; manual zones are one type of their own. */
export function zoneTypeLabel(zone: Zone): string {
  const kind = autoZoneKindOf(zone.id);
  return kind === null ? m["zones.type_manual"]() : TYPE_LABELS[kind]();
}

/** The key of a group's section in the list grouped by groups. */
export const zoneGroupSectionKey = (groupId: number): string => `group:${groupId}`;

const minFloor = (zone: Zone): number => zone.cells.reduce((lowest, [floor]) => Math.min(lowest, floor), Infinity);

/** The zones in list order: ascending lowest floor, a zone with no cells last. The sort is stable, so zones that tie
 *  keep their given order. */
export function sortZones<T extends Zone>(zones: readonly T[]): T[] {
  return [...zones].sort((a, b) => minFloor(a) - minFloor(b) || 0);
}

/** How the zones list folds its cards into sections: none, one per floor, one per zone type, or one per zone group. */
export type ZonesGrouping = "none" | "floor" | "type" | "group";

export interface ZoneSection<T extends Zone> {
  /** Stable within one grouping; keys the section's expanded state. */
  key: string;
  label: string;
  zones: T[];
}

/** The zones split into sections, each keeping the given order of its zones. `floor`: one section per floor, ascending,
 *  and a zone sits in the section of every floor it has cells on; zones without cells share a last section.
 *  `type`: one section per type, alphabetical by the type names. `group`: one section per zone group that holds a given
 *  zone, in the groups' order (a zone sits in every group it is in), zones in no group share a last section. `none`: no sections. */
export function groupZones<T extends Zone>(
  zones: readonly T[],
  grouping: ZonesGrouping,
  floors: readonly Pick<FloorState, "title" | "titleCustomized">[],
  groups: readonly ZoneGroup[] = [],
): ZoneSection<T>[] {
  if (grouping === "none") return [];
  if (grouping === "group") {
    const sections = groups.map((g) => ({ key: zoneGroupSectionKey(g.id), label: zoneGroupDisplayName(g), zones: zones.filter((z) => g.zoneIds.includes(z.id)) }));
    const ungrouped = zones.filter((z) => !groups.some((g) => g.zoneIds.includes(z.id)));
    if (ungrouped.length > 0) sections.push({ key: "group:none", label: m["zones.no_groups"](), zones: ungrouped });
    return sections.filter((section) => section.zones.length > 0);
  }
  const sections = new Map<string, ZoneSection<T> & { rank: number }>();
  const put = (key: string, label: string, rank: number, zone: T) => {
    const section = sections.get(key) ?? { key, label, zones: [], rank };
    section.zones.push(zone);
    sections.set(key, section);
  };
  for (const zone of zones) {
    if (grouping === "type") {
      const label = zoneTypeLabel(zone);
      put(`type:${label}`, label, 0, zone);
    } else if (zone.cells.length === 0) {
      put("floor:none", m["zones.group_no_floor"](), Infinity, zone);
    } else {
      for (const floor of new Set(zone.cells.map(([f]) => f))) put(`floor:${floor}`, floorName(floors, floor), floor, zone);
    }
  }
  const ordered = [...sections.values()];
  if (grouping === "floor") ordered.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1));
  else ordered.sort((a, b) => a.label.localeCompare(b.label));
  return ordered.map(({ key, label, zones }) => ({ key, label, zones }));
}
