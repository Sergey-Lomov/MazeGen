import type { StateCreator } from "zustand";
import type { MazeStore, ZonesState, ZonesActions } from "../storeTypes";

/** Zones are not saved in the project file yet, so loading a project resets them with the toggles. */
export const zonesTransientUi = {
  zones: [],
  showAutoZones: true,
  showManualZones: true,
} satisfies Partial<ZonesState>;

export const createZonesSlice: StateCreator<MazeStore, [], [], ZonesState & ZonesActions> = (set) => ({
  ...zonesTransientUi,

  setShowAutoZones: (v) => set({ showAutoZones: v }),
  setShowManualZones: (v) => set({ showManualZones: v }),
});
