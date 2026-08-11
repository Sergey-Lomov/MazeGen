import type { StateCreator } from "zustand";
import type { MazeStore, FloorsState, FloorsActions, FloorState } from "../storeTypes";

export function newFloor(number: number): FloorState {
  return { id: `floor_${crypto.randomUUID()}`, title: `Floor ${number}` };
}

export const createFloorsSlice: StateCreator<MazeStore, [], [], FloorsState & FloorsActions> = (set, get) => {
  const initialFloor = newFloor(1);
  return {
  floors: [initialFloor],
  nextFloorNumber: 2,
  activeFloorId: initialFloor.id,

  addFloor: () => set((state) => ({
    floors: [...state.floors, newFloor(state.nextFloorNumber)],
    nextFloorNumber: state.nextFloorNumber + 1,
  })),

  removeFloor: (id) => {
    const { floors, activeFloorId } = get();
    if (floors.length <= 1) return;
    const next = floors.filter((f) => f.id !== id);
    set({
      floors: next,
      // The active floor may be the one just removed — fall back to the bottom floor rather than
      // leaving `activeFloorId` pointing at a floor that no longer exists.
      activeFloorId: activeFloorId === id ? next[0].id : activeFloorId,
    });
  },

  renameFloor: (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    set((state) => ({
      floors: state.floors.map((f) => f.id === id ? { ...f, title: trimmed } : f),
    }));
  },

  moveFloor: (id, direction) => {
    const { floors } = get();
    const index = floors.findIndex((f) => f.id === id);
    if (index < 0) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= floors.length) return;
    const next = [...floors];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    set({ floors: next });
  },

  setActiveFloorId: (id) => {
    const { floors } = get();
    if (!floors.some((f) => f.id === id)) return;
    set({ activeFloorId: id });
  },
  };
};
