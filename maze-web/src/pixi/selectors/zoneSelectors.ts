import type { NodeDto } from "../../wasm/types";
import type { Zone, ZoneKind } from "../../wasm/mazeService";
import { distributeHueGroups } from "../../store/colorMath";
import { AUTO_HUE_BASE_COLOR } from "../renderConstants";

export interface ZoneRegions {
  /** One synthetic node per distinct cell of a drawn zone on the floor, so the zone is a region. */
  nodes: NodeDto[];
  /** One entry per drawn zone, coloured by the zone's position in the full zone list. */
  groups: { regionGroups: number[][]; color: number }[];
}

/** Colour of every zone, by position in the full zone list: the glues' scheme (`glueColor`), the
 *  hue spread evenly round the wheel from `AUTO_HUE_BASE_COLOR`. Everything that marks a zone on the
 *  canvas or beside it takes its colour from here, so the zone reads the same everywhere. */
export function zoneColors(zones: Zone[]): number[] {
  return distributeHueGroups(AUTO_HUE_BASE_COLOR, zones.length);
}

export function isZoneKindShown(kind: ZoneKind, showAuto: boolean, showManual: boolean): boolean {
  return kind === "auto" ? showAuto : showManual;
}

/** Regions of the zones `include` accepts, restricted to one floor (an index in `floors`). Colours
 *  are taken from the whole zone list, so no filter ever recolours a zone. */
function collectZoneRegions(zones: Zone[], floorIndex: number, include: (zone: Zone) => boolean): ZoneRegions {
  const palette = zoneColors(zones);
  const nodes: NodeDto[] = [];
  const groups: ZoneRegions["groups"] = [];
  zones.forEach((zone, index) => {
    if (!include(zone)) return;
    const ids: number[] = [];
    for (const [floor, x, y] of zone.cells) {
      if (floor !== floorIndex) continue;
      const id = nodes.length;
      nodes.push({ id, x, y, i: id });
      ids.push(id);
    }
    if (ids.length > 0) groups.push({ regionGroups: [ids], color: palette[index] });
  });
  return { nodes, groups };
}

/** Regions of the zones that pass the kind filters and are not hidden, restricted to one floor (an
 *  index in `floors`). Colours are taken from the whole zone list, so toggling a filter or a zone
 *  never recolours a zone. */
export function buildZoneRegions(
  zones: Zone[],
  floorIndex: number,
  showAuto: boolean,
  showManual: boolean,
  hiddenZoneIds: readonly number[] = [],
): ZoneRegions {
  const hidden = new Set(hiddenZoneIds);
  return collectZoneRegions(zones, floorIndex, (zone) => isZoneKindShown(zone.kind, showAuto, showManual) && !hidden.has(zone.id));
}

/** Region of one zone on one floor, drawn regardless of the kind filters and the zone's visibility
 *  (the list hover). Coloured as `buildZoneRegions` colours it; `null` when the zone is not in the
 *  list or has no cell on the floor. */
export function buildZoneHoverRegion(zones: Zone[], zoneId: number, floorIndex: number): ZoneRegions | null {
  const regions = collectZoneRegions(zones, floorIndex, (zone) => zone.id === zoneId);
  return regions.groups.length === 0 ? null : regions;
}

/** Ascending floor indices the zone has cells on. */
export function zoneFloors(zone: Zone): number[] {
  return [...new Set(zone.cells.map(([floor]) => floor))].sort((a, b) => a - b);
}

/** Display name of a zone: its name, or `#id` while unnamed. */
export function zoneDisplayName(zone: Zone): string {
  return zone.name === "" ? `#${zone.id}` : zone.name;
}

export function countZonesOfKind(zones: Zone[], kind: ZoneKind): number {
  return zones.filter((zone) => zone.kind === kind).length;
}

const cellIndexCache = new WeakMap<Zone[], Map<string, Zone[]>>();

/** Cell-to-zones lookup built once per `zones` array (the store replaces it on every change), so a
 *  hover query is a map hit instead of a scan over every zone cell. Zones stay in zone order. */
function cellIndexOf(zones: Zone[]): Map<string, Zone[]> {
  let index = cellIndexCache.get(zones);
  if (index) return index;
  index = new Map();
  for (const zone of zones) {
    const seen = new Set<string>();
    for (const [floor, x, y] of zone.cells) {
      const key = `${floor},${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = index.get(key);
      if (list) list.push(zone); else index.set(key, [zone]);
    }
  }
  cellIndexCache.set(zones, index);
  return index;
}

/** Every zone containing the cell, in zone order, regardless of the kind filters. */
export function zonesOfCell(zones: Zone[], floorIndex: number, x: number, y: number): Zone[] {
  return cellIndexOf(zones).get(`${floorIndex},${x},${y}`) ?? [];
}

export function countManualZones(zones: Zone[]): number {
  return countZonesOfKind(zones, "manual");
}

/** Cell inspector text of the zones card: coordinates, then the names of the zones holding the cell. */
export function buildZonesCellInspection(zones: Zone[], floorIndex: number, x: number, y: number): string {
  const coordLabel = `x:${x}, y:${y}`;
  const names = zonesOfCell(zones, floorIndex, x, y).map(zoneDisplayName);
  return names.length === 0 ? coordLabel : `${coordLabel} | ${names.join(", ")}`;
}
