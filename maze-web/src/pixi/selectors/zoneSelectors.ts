import type { NodeDto } from "../../wasm/types";
import type { Zone, ZoneKind } from "../../wasm/mazeService";
import { buildPalette } from "../colorUtils";

export interface ZoneRegions {
  /** One synthetic node per distinct cell of a drawn zone on the floor, so the zone is a region. */
  nodes: NodeDto[];
  /** One entry per drawn zone, coloured by the zone's position in the full zone list. */
  groups: { regionGroups: number[][]; color: number }[];
}

export function isZoneKindShown(kind: ZoneKind, showAuto: boolean, showManual: boolean): boolean {
  return kind === "auto" ? showAuto : showManual;
}

/** Regions of the zones that pass the kind filters, restricted to one floor (an index in `floors`).
 *  Colours are taken from the whole zone list, so toggling a filter never recolours a zone. */
export function buildZoneRegions(zones: Zone[], floorIndex: number, showAuto: boolean, showManual: boolean): ZoneRegions {
  const palette = buildPalette(zones.length);
  const nodes: NodeDto[] = [];
  const groups: ZoneRegions["groups"] = [];
  zones.forEach((zone, index) => {
    if (!isZoneKindShown(zone.kind, showAuto, showManual)) return;
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
  return zones.filter((zone) => zone.kind === "manual").length;
}

/** Cell inspector text of the zones card: coordinates, then the names of the zones holding the cell. */
export function buildZonesCellInspection(zones: Zone[], floorIndex: number, x: number, y: number): string {
  const coordLabel = `x:${x}, y:${y}`;
  const names = zonesOfCell(zones, floorIndex, x, y).map((zone) => (zone.name === "" ? `#${zone.id}` : zone.name));
  return names.length === 0 ? coordLabel : `${coordLabel} | ${names.join(", ")}`;
}
