import type { StateCreator } from "zustand";
import type { MazeStore, MazeState, ZonesState, ZonesActions } from "../storeTypes";
import type { Zone, ZoneCellWire } from "../../wasm/mazeService";
import { translateFieldCells } from "../../wasm/mazeService";
import { activeFieldCellKeys, activeFloorIndexOf, editedZoneOf, zonePointsOnFloor } from "../../pixi/fieldEditTarget";
import { isFieldOpError } from "../../pixi/fieldOps";
import { encodePoint } from "../../pixi/tessellationProjection";

/** Zones are not saved in the project file yet, so loading a project resets them with the toggles. */
export const zonesTransientUi = {
  zones: [],
  nextZoneId: 1,
  showAutoZones: true,
  showManualZones: true,
  hiddenZoneIds: [],
  zonesPanelOpen: false,
  zonesListMode: "auto",
  hoveredZoneId: null,
  zoneEditId: null,
  zoneEditIsNew: false,
  showOtherZones: true,
  zoneColorOverrides: {},
  zoneSmoothing: false,
} satisfies Partial<ZonesState>;

/** The zone with the edited zone's cells replaced, or `{}` when nothing changed. Cells of other
 *  floors are kept as they are; the cells of the active floor are rebuilt by `edit` from a set. */
export function withEditedZoneCells(state: MazeState, edit: (onFloor: Map<number, [number, number]>) => boolean): Partial<MazeState> {
  const zone = editedZoneOf(state);
  if (!zone) return {};
  const floor = activeFloorIndexOf(state);
  const onFloor = new Map<number, [number, number]>();
  for (const [f, x, y] of zone.cells) if (f === floor) onFloor.set(encodePoint(x, y), [x, y]);
  if (!edit(onFloor)) return {};
  const cells: ZoneCellWire[] = [
    ...zone.cells.filter(([f]) => f !== floor),
    ...[...onFloor.values()].map(([x, y]): ZoneCellWire => [floor, x, y]),
  ];
  return { zones: state.zones.map((z): Zone => (z.id === zone.id ? { ...z, cells } : z)) };
}

/** The patch that deletes a zone with everything that refers to it. */
function withoutZone(s: MazeState, id: number): Partial<MazeState> {
  return {
    zones: s.zones.filter((zone) => zone.id !== id),
    hiddenZoneIds: s.hiddenZoneIds.filter((hidden) => hidden !== id),
    hoveredZoneId: s.hoveredZoneId === id ? null : s.hoveredZoneId,
    zoneEditId: s.zoneEditId === id ? null : s.zoneEditId,
    zoneEditIsNew: s.zoneEditId === id ? false : s.zoneEditIsNew,
    zoneColorOverrides: withoutKey(s.zoneColorOverrides, id),
  };
}

/** The patch that drops the zone being edited when it was added in this editing session and is not
 *  confirmed: leaving the editor any way but "Done" discards it, as the close cross does. */
function discardingNewZone(s: MazeState): Partial<MazeState> {
  return s.zoneEditIsNew && s.zoneEditId !== null ? withoutZone(s, s.zoneEditId) : {};
}

export const createZonesSlice: StateCreator<MazeStore, [], [], ZonesState & ZonesActions> = (set, get) => ({
  ...zonesTransientUi,

  setShowAutoZones: (v) => set({ showAutoZones: v }),
  setShowManualZones: (v) => set({ showManualZones: v }),
  setZonesPanelOpen: (open) => set((s) => (open
    ? { zonesPanelOpen: true }
    : { ...discardingNewZone(s), zonesPanelOpen: false, hoveredZoneId: null, zoneEditId: null, zoneEditIsNew: false })),
  setZonesListMode: (mode) => set({ zonesListMode: mode, hoveredZoneId: null }),
  setHoveredZone: (id) => set({ hoveredZoneId: id }),
  toggleZoneVisibility: (id) => set((s) => ({
    hiddenZoneIds: s.hiddenZoneIds.includes(id) ? s.hiddenZoneIds.filter((hidden) => hidden !== id) : [...s.hiddenZoneIds, id],
  })),
  // An unnamed zone shows as "Zone #id" (`zoneDisplayName`).
  addManualZone: () => set((s) => {
    const discarded = discardingNewZone(s);
    return {
      ...discarded,
      zones: [...(discarded.zones ?? s.zones), { id: s.nextZoneId, name: "", kind: "manual", cells: [] }],
      nextZoneId: s.nextZoneId + 1,
      zoneEditId: s.nextZoneId,
      zoneEditIsNew: true,
      hoveredZoneId: null,
    };
  }),
  removeZone: (id) => set((s) => withoutZone(s, id)),
  // `null` is "Done": the zone stays. Moving to another zone drops an unconfirmed new one.
  setZoneEditId: (id) => set((s) => ({
    ...(id !== null && id !== s.zoneEditId ? discardingNewZone(s) : {}),
    zoneEditId: id,
    zoneEditIsNew: false,
    hoveredZoneId: null,
  })),
  cancelZoneEdit: () => {
    const { zoneEditId, zoneEditIsNew, removeZone, setZoneEditId } = get();
    if (zoneEditId !== null && zoneEditIsNew) removeZone(zoneEditId);
    else setZoneEditId(null);
  },
  setShowOtherZones: (v) => set({ showOtherZones: v }),
  setZoneSmoothing: (v) => set({ zoneSmoothing: v }),
  setZoneName: (id, name) => set((s) => ({ zones: s.zones.map((z) => (z.id === id ? { ...z, name } : z)) })),
  setZoneColor: (id, color) => set((s) => ({
    zoneColorOverrides: color === null ? withoutKey(s.zoneColorOverrides, id) : { ...s.zoneColorOverrides, [id]: color },
  })),

  addZoneCells: (cells) => set((s) => withEditedZoneCells(s, (onFloor) => {
    let changed = false;
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (!onFloor.has(key)) { onFloor.set(key, [x, y]); changed = true; }
    }
    return changed;
  })),

  removeZoneCells: (cells) => set((s) => withEditedZoneCells(s, (onFloor) => {
    let changed = false;
    for (const [x, y] of cells) if (onFloor.delete(encodePoint(x, y))) changed = true;
    return changed;
  })),

  moveZoneCells: (cells, vector) => {
    const before = get();
    if (vector[0] === 0 && vector[1] === 0) return false;
    const zone = editedZoneOf(before);
    if (!zone) return false;
    const held = zonePointsOnFloor(zone, activeFloorIndexOf(before));
    const selected = cells.filter(([x, y]) => held.has(encodePoint(x, y)));
    if (selected.length === 0) return false;
    let moved: [number, number][];
    try {
      moved = translateFieldCells(before.floorFields[before.activeFloorId].fieldConfig.tessellation, selected, vector);
    } catch (error) {
      // A refused move leaves the zone unchanged, as it does the field.
      if (!isFieldOpError(error)) throw error;
      return false;
    }
    const fieldCells = activeFieldCellKeys(before);
    if (moved.some(([x, y]) => !fieldCells.has(encodePoint(x, y)))) return false;
    set((s) => withEditedZoneCells(s, (onFloor) => {
      for (const [x, y] of selected) onFloor.delete(encodePoint(x, y));
      for (const [x, y] of moved) onFloor.set(encodePoint(x, y), [x, y]);
      return true;
    }));
    return true;
  },
});

function withoutKey(record: Record<number, number>, id: number): Record<number, number> {
  const { [id]: _removed, ...rest } = record;
  return rest;
}
