import type { NodeDto } from "../../wasm/types";
import type { Zone, ZoneKind } from "../../wasm/mazeService";
import { glueColor } from "../renderers/SeamArrowRenderer";
import { brightColor, colorToRgb, rgbToColor } from "../../store/colorMath";
import { canvas } from "../colorTokens";
import { COMPONENT_MASK_ALPHA } from "../renderConstants";
import * as m from "~/paraglide/messages";

export interface ZoneRegions {
  /** One synthetic node per distinct cell of a drawn zone on the floor, so the zone is a region. */
  nodes: NodeDto[];
  /** One entry per drawn zone, coloured by the zone's position in the full zone list. */
  groups: { regionGroups: number[][]; color: number }[];
}

/** Colour of every zone, by position in the full zone list: the glues' scheme (`glueColor`), the
 *  hue spread evenly round the wheel from `AUTO_HUE_BASE_COLOR`. Everything that marks a zone on the
 *  canvas or beside it takes its colour from here, so the zone reads the same everywhere. */
export function zoneColors(zones: Zone[], overrides: Readonly<Record<number, number>> = {}): number[] {
  // The palette is fixed (`AUTO_COLOR_COUNT` colours), so a zone's colour depends on its position only: adding
  // a zone or giving another one its own colour never moves the rest.
  return zones.map((zone, index) => overrides[zone.id] ?? glueColor(index));
}

/** The zones as the canvas and the editor see them: the draft replaces its zone, or is appended when new. */
export function zonesWithDraft(zones: Zone[], draft: Zone | null): Zone[] {
  if (!draft) return zones;
  return zones.some((z) => z.id === draft.id) ? zones.map((z) => (z.id === draft.id ? draft : z)) : [...zones, draft];
}

/** The colour overrides with the draft's colour applied (`null`: automatic). */
export function overridesWithDraft(overrides: Record<number, number>, draft: Zone | null, draftColor: number | null): Record<number, number> {
  if (!draft) return overrides;
  const { [draft.id]: _dropped, ...rest } = overrides;
  return draftColor === null ? rest : { ...rest, [draft.id]: draftColor };
}

/** Whether the zones other than the edited one are left undrawn: a zone is being edited and "show other zones" is off. */
export function hidesOtherZones(state: { zoneEditDraft: Zone | null; showOtherZones: boolean }): boolean {
  return state.zoneEditDraft !== null && !state.showOtherZones;
}

export function isZoneKindShown(kind: ZoneKind, showAuto: boolean, showManual: boolean): boolean {
  return kind === "auto" ? showAuto : showManual;
}

/** Regions of the zones `include` accepts, restricted to one floor (an index in `floors`). Colours
 *  are taken from the whole zone list, so no filter ever recolours a zone. */
function collectZoneRegions(zones: Zone[], floorIndex: number, include: (zone: Zone) => boolean, colorOverrides: Readonly<Record<number, number>>): ZoneRegions {
  const palette = zoneColors(zones, colorOverrides);
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
  colorOverrides: Readonly<Record<number, number>> = {},
): ZoneRegions {
  const hidden = new Set(hiddenZoneIds);
  return collectZoneRegions(zones, floorIndex, (zone) => isZoneKindShown(zone.kind, showAuto, showManual) && !hidden.has(zone.id), colorOverrides);
}

/** Region of one zone on one floor, drawn regardless of the kind filters and the zone's visibility
 *  (the list hover). Coloured as `buildZoneRegions` colours it; `null` when the zone is not in the
 *  list or has no cell on the floor. */
export function buildZoneHoverRegion(zones: Zone[], zoneId: number, floorIndex: number, colorOverrides: Readonly<Record<number, number>> = {}): ZoneRegions | null {
  return buildZonesHoverRegion(zones, [zoneId], floorIndex, colorOverrides);
}

/** `buildZoneHoverRegion` for several zones at once (the hover of a zone group's card). */
export function buildZonesHoverRegion(zones: Zone[], zoneIds: readonly number[], floorIndex: number, colorOverrides: Readonly<Record<number, number>> = {}): ZoneRegions | null {
  const wanted = new Set(zoneIds);
  const regions = collectZoneRegions(zones, floorIndex, (zone) => wanted.has(zone.id), colorOverrides);
  return regions.groups.length === 0 ? null : regions;
}

/** Colours of a zone's chip beside the canvas: the border and text are the zone's region border colour,
 *  the background is the region fill (the zone colour at the regions' own alpha) over the floor. */
export function zoneChipColors(color: number): { bg: number; text: number } {
  const fill = colorToRgb(color);
  const floor = colorToRgb(canvas.floor.default);
  const mix = (f: number, b: number) => f * COMPONENT_MASK_ALPHA + b * (1 - COMPONENT_MASK_ALPHA);
  return { bg: rgbToColor({ r: mix(fill.r, floor.r), g: mix(fill.g, floor.g), b: mix(fill.b, floor.b) }), text: brightColor(color) };
}

/** Ascending floor indices the zone has cells on. */
export function zoneFloors(zone: Zone): number[] {
  return [...new Set(zone.cells.map(([floor]) => floor))].sort((a, b) => a - b);
}

/** Display name of a zone group: its name, or "Group #id" while unnamed. */
export function zoneGroupDisplayName(group: { id: number; name: string }): string {
  return group.name === "" ? m["zone_groups.default_name"]({ id: group.id }) : group.name;
}

/** Display name of a zone: its name, or "Zone #id" while unnamed. */
export function zoneDisplayName(zone: Zone): string {
  return zone.name === "" ? m["zones.default_name"]({ id: zone.id }) : zone.name;
}

/** The other zones that share a cell with `zone` on the floor. */
export function zoneIntersections(zones: Zone[], zone: Zone): { zone: Zone; floor: number }[] {
  const own = new Set<string>();
  for (const [floor, x, y] of zone.cells) own.add(`${floor},${x},${y}`);
  if (own.size === 0) return [];
  const result: { zone: Zone; floor: number }[] = [];
  for (const other of zones) {
    if (other.id === zone.id) continue;
    const shared = new Set<number>();
    for (const [floor, x, y] of other.cells) if (own.has(`${floor},${x},${y}`)) shared.add(floor);
    for (const floor of [...shared].sort((a, b) => a - b)) result.push({ zone: other, floor });
  }
  return result;
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
