import type { FloorState } from "../store/floorsTypes";
import { cellTypeLabel } from "../i18n/cellTypeLabel";
import * as m from "~/paraglide/messages";

/** Ids of automatic zones start here, far above the counter manual zone ids come from, so the two never meet. */
export const AUTO_ZONE_ID_BASE = 2 ** 30;

const KIND_CODES = { maze: 0, floor: 1, edge: 2, face: 3, region: 4, type: 5 } as const;
const FLOOR_BITS = 8;
const INDEX_BITS = 14;

export type AutoZoneKind = keyof typeof KIND_CODES;
type FloorTitles = readonly Pick<FloorState, "title" | "titleCustomized">[];

export const isAutoZoneId = (id: number): boolean => id >= AUTO_ZONE_ID_BASE;

/** The kind of an automatic zone (`maze`, `floor`, `type`, `edge`, `face` or `region`), read back from its id; `null` for
 *  an id that is not an automatic zone's. */
export function autoZoneKindOf(id: number): AutoZoneKind | null {
  if (!isAutoZoneId(id)) return null;
  const code = Math.floor((id - AUTO_ZONE_ID_BASE) / 2 ** (FLOOR_BITS + INDEX_BITS));
  return (Object.keys(KIND_CODES) as AutoZoneKind[]).find((kind) => KIND_CODES[kind] === code) ?? null;
}

/** The stable id of an automatic zone, built from its key alone: the same key always gets the same id, so groups,
 *  colours and visibility that name the zone survive a recomputation and a save. `null` for a key that is not core's. */
export function autoZoneIdOf(key: string): number | null {
  const [kind, floorPart, indexPart] = key.split(":");
  if (!(kind in KIND_CODES)) return null;
  const floor = Number(floorPart ?? 0);
  const index = Number(indexPart ?? 0);
  if (!Number.isInteger(floor) || !Number.isInteger(index) || floor >= 2 ** FLOOR_BITS || index >= 2 ** INDEX_BITS) return null;
  return AUTO_ZONE_ID_BASE + KIND_CODES[kind as AutoZoneKind] * 2 ** (FLOOR_BITS + INDEX_BITS) + floor * 2 ** INDEX_BITS + index;
}

/** The index part of an automatic zone's id (the face, region or cell type number), `0` for an id that is not one. */
export function autoZoneIndexOf(id: number): number {
  return isAutoZoneId(id) ? (id - AUTO_ZONE_ID_BASE) % 2 ** INDEX_BITS : 0;
}

/** Kinds of zone an automatic group collects (the whole maze zone is alone, so it has no group). */
export type AutoGroupKind = Exclude<AutoZoneKind, "maze">;

/** Whether `id` is an automatic zone group's. Group ids live in the same range as automatic zone ids, apart from the
 *  counter manual groups come from. */
export const isAutoGroupId = isAutoZoneId;

/** The stable id of an automatic group: a kind's only group, or the one of a cell type (`index` is the type's position
 *  in `cell_types`). The same group always gets the same id, so it survives a recomputation. */
export function autoGroupIdOf(kind: AutoGroupKind, index = 0): number {
  return AUTO_ZONE_ID_BASE + KIND_CODES[kind] * 2 ** (FLOOR_BITS + INDEX_BITS) + index;
}

/** The localized name of an automatic group, built from its id when it is shown. A cell type group keeps the type's
 *  key as its `name` (the id holds only the index), which is what names it. `null` for a group that is not automatic. */
export function autoGroupName({ id, name }: { id: number; name: string }): string | null {
  switch (autoZoneKindOf(id)) {
    case "floor": return m["zone_groups.auto_floor"]();
    case "edge": return m["zone_groups.auto_edge"]();
    case "face": return m["zone_groups.auto_face"]();
    case "region": return m["zone_groups.auto_region"]();
    case "type": return cellTypeLabel(name);
    default: return null;
  }
}

/** A floor's name in a zone name: the title the user gave it, else the localized "Floor N" (the stored default title
 *  is English, so it is not shown as is). */
export function floorName(floors: FloorTitles, index: number): string {
  const floor = floors[index];
  if (!floor) return "";
  return floor.titleCustomized ? floor.title : m["zones.auto_floor"]({ number: String(index + 1) });
}

/** The localized name of an automatic zone, built from its id (which is its key) when it is shown, so it follows the
 *  language and the floor titles. A cell type zone keeps the type's key as its `name` (the id holds only the type's
 *  index), which is what names it. `null` for a zone that is not an automatic zone. */
export function autoZoneName({ id, name }: { id: number; name: string }, floors: FloorTitles): string | null {
  const kind = autoZoneKindOf(id);
  if (kind === null) return null;
  const rest = id - AUTO_ZONE_ID_BASE - KIND_CODES[kind] * 2 ** (FLOOR_BITS + INDEX_BITS);
  const floor = floorName(floors, Math.floor(rest / 2 ** INDEX_BITS));
  const index = String((rest % 2 ** INDEX_BITS) + 1);
  const several = floors.length > 1;
  switch (kind) {
    case "maze": return m["zones.auto_maze"]();
    case "type": return several ? m["zones.auto_type_floor"]({ type: cellTypeLabel(name), floor }) : cellTypeLabel(name);
    case "floor": return floor;
    case "edge": return several ? m["zones.auto_edge_floor"]({ floor }) : m["zones.auto_edge"]();
    case "face": return several ? m["zones.auto_face_floor"]({ index, floor }) : m["zones.auto_face"]({ index });
    case "region": return several ? m["zones.auto_region_floor"]({ index, floor }) : m["zones.auto_region"]({ index });
  }
}
