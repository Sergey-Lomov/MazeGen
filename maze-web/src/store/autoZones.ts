import type { AutoZoneFloorWire, AutoZoneWire, Zone } from "../wasm/mazeService";
import type { MazeState } from "./storeTypes";
import { activeFloorTessellationOf, floorTessellationOf } from "./storeHelpers";
import { fieldConfigToWasm } from "./slices/generateConfigBuilder";
import { configAllCells } from "../domain/tessellationCells";
import type { ZoneGroup } from "./zonesTypes";
import { autoGroupIdOf, autoZoneIdOf, autoZoneIndexOf, autoZoneKindOf, isAutoGroupId, type AutoGroupKind } from "../domain/autoZones";

/** The request for `computeAutoZones`, or `null` while there is nothing to send (no floor has a cell). */
export function buildAutoZonesRequest(state: MazeState): { tessellation: ReturnType<typeof fieldConfigToWasm>; floors: AutoZoneFloorWire[] } | null {
  const floors = state.floors.map((floor): AutoZoneFloorWire => ({
    cells: configAllCells(floorTessellationOf(state, floor.id), state.smoothPrimitives),
    creases: (state.floorCreases[floor.id] ?? []).map((crease) => [[crease.a[0], crease.a[1]], [crease.b[0], crease.b[1]]]),
    folded: (state.floorTopology[floor.id]?.folds.length ?? 0) > 0,
  }));
  if (floors.every((floor) => floor.cells.length === 0)) return null;
  return { tessellation: fieldConfigToWasm(activeFloorTessellationOf(state)), floors };
}

/** The cell type index a zone key names (`type:F:T`), or `null` for any other key. */
export function cellTypeIndexOfKey(key: string): number | null {
  const [kind, , index] = key.split(":");
  return kind === "type" ? Number(index) : null;
}

/** Core's automatic zones as store zones, with their stable ids. A key that gets no id is dropped. The zone keeps no
 *  name: it is built from the id when shown (`autoZoneName`), so it follows the language. The one exception is a cell
 *  type zone (`type:F:T`), whose id holds the type's index only: its `name` is the type's key, taken from `typeKeys` (the
 *  tessellation's `cell_types`, in order). */
export function autoZonesFromWire(wire: AutoZoneWire[], typeKeys: readonly string[] = []): Zone[] {
  return wire.flatMap((zone): Zone[] => {
    const id = autoZoneIdOf(zone.key);
    if (id === null) return [];
    const typeIndex = cellTypeIndexOfKey(zone.key);
    const name = typeIndex === null ? "" : typeKeys[typeIndex] ?? "";
    return [{ id, name, kind: "auto", cells: zone.cells }];
  });
}

const AUTO_GROUP_ORDER: readonly AutoGroupKind[] = ["floor", "edge", "region", "face", "type"];

/** The automatic groups of `zones` (GitHub issue #1037), in order: floors, field edges, regions, faces, then one per cell
 *  type. A group exists only while it has a zone to collect, so a tessellation of one cell type (no cell type zones)
 *  has no cell type groups. A cell type group takes the type's key (the `name` of its zones) as its `name`. */
export function autoGroupsOf(zones: Zone[]): ZoneGroup[] {
  const members = new Map<number, ZoneGroup>();
  const add = (kind: AutoGroupKind, zone: Zone, index = 0, name = "") => {
    const id = autoGroupIdOf(kind, index);
    const group = members.get(id);
    if (group) group.zoneIds.push(zone.id);
    else members.set(id, { id, name, zoneIds: [zone.id] });
  };
  for (const zone of zones) {
    const kind = autoZoneKindOf(zone.id);
    if (kind === null || kind === "maze") continue;
    add(kind, zone, kind === "type" ? autoZoneIndexOf(zone.id) : 0, kind === "type" ? zone.name : "");
  }
  // Ids already order kinds by `KIND_CODES` (floor, edge, face, region, type), so the wanted order is a rank by kind, then id.
  const rank = (group: ZoneGroup) => AUTO_GROUP_ORDER.indexOf(autoZoneKindOf(group.id) as AutoGroupKind);
  return [...members.values()].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/** The groups with the automatic ones replaced by `auto`: automatic groups first, manual ones in their order. */
export function withAutoGroups(groups: ZoneGroup[], auto: ZoneGroup[]): ZoneGroup[] {
  return [...auto, ...groups.filter((group) => !isAutoGroupId(group.id))];
}

/** Whether two group lists hold the same automatic groups (id, name and members). */
export function sameAutoGroups(a: ZoneGroup[], b: ZoneGroup[]): boolean {
  const autoA = a.filter((group) => isAutoGroupId(group.id));
  const autoB = b.filter((group) => isAutoGroupId(group.id));
  return autoA.length === autoB.length && autoA.every((group, i) => group.id === autoB[i].id && group.name === autoB[i].name
    && group.zoneIds.length === autoB[i].zoneIds.length && group.zoneIds.every((id, k) => id === autoB[i].zoneIds[k]));
}

/** The zones with the automatic ones replaced by `auto`: automatic zones first, manual ones in their order. */
export function withAutoZones(zones: Zone[], auto: Zone[]): Zone[] {
  return [...auto, ...zones.filter((zone) => zone.kind !== "auto")];
}

const sameCells = (a: Zone["cells"], b: Zone["cells"]): boolean => a === b || a.length === b.length && a.every((c, i) => c[0] === b[i][0] && c[1] === b[i][1] && c[2] === b[i][2]);

/** Whether two zone lists hold the same automatic zones (id, name and cells), so a recomputation that changed nothing
 *  writes nothing. */
export function sameAutoZones(a: Zone[], b: Zone[]): boolean {
  const autoA = a.filter((zone) => zone.kind === "auto");
  const autoB = b.filter((zone) => zone.kind === "auto");
  return autoA.length === autoB.length && autoA.every((zone, i) => zone.id === autoB[i].id && zone.name === autoB[i].name && sameCells(zone.cells, autoB[i].cells));
}
