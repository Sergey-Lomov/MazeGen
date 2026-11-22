import type { StoreApi } from "zustand";
import { computeAutoZones, getTessellationCellTypes } from "../wasm/mazeService";
import type { MazeStore } from "./storeTypes";
import { autoZonesFromWire, cellTypeIndexOfKey, buildAutoZonesRequest, sameAutoZones, withAutoZones } from "./autoZones";

/** How long the field must stay unchanged before the automatic zones are recomputed (GitHub issue #1033). */
export const AUTO_ZONES_DEBOUNCE_MS = 150;

/** The state the automatic zones are computed from. A floor's field is only the parts that give its cells: the rest of
 *  `floorFields` (the active tool, the operation, the edit mode, the dirty flag) changes with every tool switch and
 *  must not trigger a recomputation. */
const inputsOf = (s: MazeStore) => [
  s.floors, s.floorTopology, s.floorCreases, s.tessellationKind, s.tessellationParams, s.hexOrientation, s.triOrientation, s.smoothPrimitives,
  ...s.floors.flatMap((floor) => {
    const field = s.floorFields[floor.id];
    return [field?.fieldConfig, field?.isEditingField, field?.fieldPoints];
  }),
] as const;

const inputsChanged = (a: MazeStore, b: MazeStore): boolean => {
  // Most store changes (hover, pan, tool) leave every input alone: the cheap reference checks go first, so
  // those allocate nothing.
  if (a.floors === b.floors && a.floorFields === b.floorFields && a.floorTopology === b.floorTopology && a.floorCreases === b.floorCreases
    && a.tessellationKind === b.tessellationKind && a.tessellationParams === b.tessellationParams && a.hexOrientation === b.hexOrientation
    && a.triOrientation === b.triOrientation && a.smoothPrimitives === b.smoothPrimitives) return false;
  const [x, y] = [inputsOf(a), inputsOf(b)];
  return x.length !== y.length || x.some((value, i) => value !== y[i]);
};

/** Recomputes the automatic zones now and stores them when they differ. Nothing here fails in normal use: wasm is
 *  loaded before the store exists, and every change of the field, the tessellation and the floors lands in one store
 *  update, so core is never handed cells of another tessellation. A throw is a bug and is left to surface. */
export function refreshAutoZones(store: StoreApi<MazeStore>): void {
  const state = store.getState();
  const request = buildAutoZonesRequest(state);
  const wire = request ? computeAutoZones(request) : [];
  // The type keys are asked only when a cell type zone exists, i.e. on a tessellation of several types.
  const typeKeys = request && wire.some((zone) => cellTypeIndexOfKey(zone.key) !== null)
    ? getTessellationCellTypes({ tessellation: request.tessellation, points: [] }).keys
    : [];
  const zones = autoZonesFromWire(wire, typeKeys);
  if (sameAutoZones(state.zones, zones)) return;
  const ids = new Set(zones.map((zone) => zone.id));
  const known = new Set(state.zones.filter((zone) => zone.kind === "auto").map((zone) => zone.id));
  const gone = [...known].filter((id) => !ids.has(id));
  // A zone is drawn only once the user shows it: a newly appeared automatic zone starts hidden.
  const added = [...ids].filter((id) => !known.has(id));
  const hiddenZoneIds = [...state.hiddenZoneIds.filter((id) => !gone.includes(id)), ...added.filter((id) => !state.hiddenZoneIds.includes(id))];
  store.setState({
    zones: withAutoZones(state.zones, zones),
    hiddenZoneIds,
    ...(gone.length > 0
      ? {
          hoveredZoneId: state.hoveredZoneId !== null && gone.includes(state.hoveredZoneId) ? null : state.hoveredZoneId,
          hoveredZoneIds: state.hoveredZoneIds.filter((id) => !gone.includes(id)),
        }
      : {}),
  });
}

/** Keeps the automatic zones in step with the field: every change of what they are computed from schedules a
 *  recomputation, debounced so a drag or a stroke computes once (GitHub issue #1033). */
export function installAutoZoneSync(store: StoreApi<MazeStore>): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => refreshAutoZones(store), AUTO_ZONES_DEBOUNCE_MS);
  };
  store.subscribe((state, prev) => {
    if (inputsChanged(state, prev)) {
      schedule();
    }
  });
  // The initial field is no change, but it has zones too.
  schedule();
}
