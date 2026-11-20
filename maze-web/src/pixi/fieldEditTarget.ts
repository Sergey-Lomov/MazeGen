import type { MazeState } from "../store/storeTypes";
import type { FloorFieldConfig } from "../store/tessellationTypes";
import { levelFieldsOf } from "../store/storeHelpers";
import type { Zone } from "../wasm/mazeService";
import { resolveCells } from "./fieldEditUtils";
import { encodePoint } from "./tessellationProjection";

/** What the shape tools of the field editor edit: the custom field of the active floor, or the cells
 *  of the zone being edited on it (GitHub issue #1031, `Specs/zones.md`). Every consumer of those
 *  tools asks this module instead of reading `floorFields[activeFloorId]` itself, so both editors run
 *  the same tool code. */

/** Index of the active floor in `floors`, the `floor` of a zone cell. */
export function activeFloorIndexOf(state: Pick<MazeState, "floors" | "activeFloorId">): number {
  return Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
}

/** The zone being edited (its draft), or `null` while no zone is. */
export function editedZoneOf(state: Pick<MazeState, "zoneEditDraft">): Zone | null {
  return state.zoneEditDraft;
}

/** Whether the zone editor owns the shape tools: the zones card is open on a zone draft. */
export function zoneEditActive(state: Pick<MazeState, "openCard" | "zoneEditDraft">): boolean {
  return state.openCard === "zones" && editedZoneOf(state) !== null;
}

/** The persistent smoothing switch the tools follow: the zone editor has its own (off by default), the
 *  field editor the field's. The hold-`S` inversion applies on top of either. */
export function smoothingOf(state: Pick<MazeState, "openCard" | "zoneEditDraft" | "zoneSmoothing" | "smoothPrimitives">): boolean {
  return zoneEditActive(state) ? state.zoneSmoothing : state.smoothPrimitives;
}

/** Whether the shape tools are live: the custom field editor or the zone editor. */
export function fieldToolsActive(state: Pick<MazeState, "openCard" | "zoneEditDraft" | "floorFields" | "activeFloorId">): boolean {
  if (state.openCard === "field_setup") return state.floorFields[state.activeFloorId].fieldEditMode === "custom";
  return zoneEditActive(state);
}

const zonePointsCache = new WeakMap<Zone["cells"], Map<number, Set<number>>>();

/** The zone's cells on one floor as encoded points; cached per `cells` array (the store replaces it
 *  on every edit), so a tool reading it on every pointer move does not rebuild it. */
export function zonePointsOnFloor(zone: Zone, floorIndex: number): Set<number> {
  let perFloor = zonePointsCache.get(zone.cells);
  if (!perFloor) {
    perFloor = new Map();
    zonePointsCache.set(zone.cells, perFloor);
  }
  let points = perFloor.get(floorIndex);
  if (!points) {
    points = new Set();
    for (const [floor, x, y] of zone.cells) if (floor === floorIndex) points.add(encodePoint(x, y));
    perFloor.set(floorIndex, points);
  }
  return points;
}

const editFieldCache = new WeakMap<FloorFieldConfig, { points: Set<number>; view: FloorFieldConfig }>();

/** The floor field the tools read: the field itself, or, in the zone editor, a view of it whose
 *  `fieldPoints` are the edited zone's cells on the active floor. `fieldConfig` stays the floor's own,
 *  so geometry and projection are the field's. */
export function editFieldOf(state: MazeState): FloorFieldConfig {
  const field = state.floorFields[state.activeFloorId];
  const zone = zoneEditActive(state) ? editedZoneOf(state) : null;
  if (!zone) return field;
  const points = zonePointsOnFloor(zone, activeFloorIndexOf(state));
  const cached = editFieldCache.get(field);
  if (cached && cached.points === points) return cached.view;
  const view: FloorFieldConfig = { ...field, fieldPoints: points, fieldEditMode: "custom" };
  editFieldCache.set(field, { points, view });
  return view;
}

const fieldCellsCache = new WeakMap<FloorFieldConfig, { smooth: boolean; keys: Set<number> }>();

/** Encoded cells of the active floor's field: the only cells a zone can hold. */
export function activeFieldCellKeys(state: MazeState): Set<number> {
  const field = state.floorFields[state.activeFloorId];
  const cached = fieldCellsCache.get(field);
  if (cached && cached.smooth === state.smoothPrimitives) return cached.keys;
  const source = levelFieldsOf(state)[activeFloorIndexOf(state)];
  const keys = new Set(resolveCells(source.cfg, source.customPoints, source.smooth).map(([x, y]) => encodePoint(x, y)));
  fieldCellsCache.set(field, { smooth: state.smoothPrimitives, keys });
  return keys;
}

/** Whether the zone editor's tool can act on the cell: Add only over the field's cells (a zone holds nothing
 *  outside it), Remove and Select over the zone's own cells, which can stick out of a field shrunk afterwards.
 *  Drives which cells the hover highlights. */
export function zoneToolReaches(state: MazeState, operation: "add" | "remove" | "select", x: number, y: number): boolean {
  const key = encodePoint(x, y);
  return operation === "add" ? activeFieldCellKeys(state).has(key) : editFieldOf(state).fieldPoints.has(key);
}

/** Drops the cells that are not part of the active floor's field. Zones can only hold field cells. */
export function cellsInActiveField(state: MazeState, cells: [number, number][]): [number, number][] {
  const keys = activeFieldCellKeys(state);
  return cells.filter(([x, y]) => keys.has(encodePoint(x, y)));
}
