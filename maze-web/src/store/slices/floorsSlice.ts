import type { StateCreator } from "zustand";
import type { MazeStore, FloorsState, FloorsActions, FloorState } from "../storeTypes";

export function newFloor(number: number): FloorState {
  return { id: `floor_${crypto.randomUUID()}`, title: `Floor ${number}` };
}

export const createFloorsSlice: StateCreator<MazeStore, [], [], FloorsState & FloorsActions> = (set, get) => ({
  floors: [newFloor(1)],
  nextFloorNumber: 2,

  addFloor: () => set((state) => ({
    floors: [...state.floors, newFloor(state.nextFloorNumber)],
    nextFloorNumber: state.nextFloorNumber + 1,
  })),

  removeFloor: (id) => {
    const { floors } = get();
    if (floors.length <= 1) return;
    set({ floors: floors.filter((f) => f.id !== id) });
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
});
