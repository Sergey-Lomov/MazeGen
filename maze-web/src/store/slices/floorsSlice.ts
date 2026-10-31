import type { StateCreator } from "zustand";
import type { MazeStore, FloorsState, FloorsActions, FloorState, FloorFieldConfig } from "../storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "../storeTypes";
import { defaultFloorFieldConfig, defaultTessellationOf, remapPresetLevelsOnFloorSwap, dropPresetLevelOnFloorRemove, recomputeAutoLock, buildResetDownstreamState } from "../storeHelpers";

export function newFloor(number: number): FloorState {
  return { id: `floor_${crypto.randomUUID()}`, title: `Floor ${number}` };
}

export const createFloorsSlice: StateCreator<MazeStore, [], [], FloorsState & FloorsActions> = (set, get) => {
  const initialFloor = newFloor(1);
  return {
  floors: [initialFloor],
  nextFloorNumber: 2,
  activeFloorId: initialFloor.id,
  floorTopology: {},
  // Seeded directly (not via get(), unavailable this early) — mirrors tessellationSlice's own
  // initial kind/orientation defaults (square, DEFAULT_HEX_ORI/DEFAULT_TRI_ORI).
  floorFields: { [initialFloor.id]: defaultFloorFieldConfig(defaultTessellationOf("square"), DEFAULT_HEX_ORI, DEFAULT_TRI_ORI) },

  addFloor: () => set((state) => {
    const floor = newFloor(state.nextFloorNumber);
    // New floor starts as a copy of the floor it's stacked on top of — the current topmost floor
    // (GitHub issue #338), not the kind's bare default shape, so a maze mid-way through
    // customizing floor shapes doesn't regress the new floor to something unrelated to what the
    // user's been drawing.
    const belowFloor = state.floors[state.floors.length - 1];
    const belowField = state.floorFields[belowFloor.id];
    return {
      ...buildResetDownstreamState(),
      floors: [...state.floors, floor],
      nextFloorNumber: state.nextFloorNumber + 1,
      floorFields: { ...state.floorFields, [floor.id]: { ...belowField } },
    };
  }),

  removeFloor: (id) => {
    const state = get();
    const { floors, activeFloorId, floorFields } = state;
    if (floors.length <= 1) return;
    const removedLevel = floors.findIndex((f) => f.id === id);
    if (removedLevel < 0) return;
    const next = floors.filter((f) => f.id !== id);
    const nextFloorFields: Record<string, FloorFieldConfig> = { ...floorFields };
    delete nextFloorFields[id];
    const { [id]: _removedTopology, ...nextFloorTopology } = state.floorTopology;
    // Presets on the removed floor are dropped entirely; presets on every floor above it shift
    // their `level` down by one to keep tracking the same floor's new array position (GitHub
    // issue #340) — mirrors `nextFloorFields` deleting the removed id's own entry above.
    const dropped = dropPresetLevelOnFloorRemove(state, removedLevel);
    set({
      ...buildResetDownstreamState(),
      floors: next,
      floorFields: nextFloorFields,
      floorTopology: nextFloorTopology,
      mirrorAxisPoints: [],
      mirrorPolygon: [],
      mirrorPolygonFinished: false,
      // The active floor may be the one just removed — fall back to the bottom floor rather than
      // leaving `activeFloorId` pointing at a floor that no longer exists.
      activeFloorId: activeFloorId === id ? next[0].id : activeFloorId,
      ...dropped,
      autoLockedNodes: recomputeAutoLock({ ...state, floors: next, floorFields: nextFloorFields, ...dropped }),
    });
  },

  renameFloor: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) => ({
      // An unchanged commit (rename opened and confirmed as-is) must not mark the title custom.
      floors: state.floors.map((f) => f.id === id && f.title !== trimmed ? { ...f, title: trimmed, titleCustomized: true } : f),
    }));
  },

  moveFloor: (id, direction) => {
    const state = get();
    const { floors } = state;
    const index = floors.findIndex((f) => f.id === id);
    if (index < 0) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= floors.length) return;
    const next = [...floors];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    // Preset `level`s are positional indices into `floors` — remap them so each preset keeps
    // pointing at the same floor it did before the swap, not whichever floor now sits at its old
    // array slot (GitHub issue #340).
    const remapped = remapPresetLevelsOnFloorSwap(state, [index, targetIndex]);
    set({
      ...buildResetDownstreamState(),
      floors: next,
      ...remapped,
      autoLockedNodes: recomputeAutoLock({ ...state, ...remapped }),
    });
  },

  setActiveFloorId: (id) => {
    const { floors } = get();
    if (!floors.some((f) => f.id === id)) return;
    set({ activeFloorId: id, mirrorAxisPoints: [], mirrorPolygon: [], mirrorPolygonFinished: false });
  },
  };
};
