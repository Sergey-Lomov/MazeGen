import type { StateCreator } from "zustand";
import type { MazeStore, AnalyticsOverlayState, AnalyticsOverlayActions } from "../storeTypes";

export const createAnalyticsOverlaySlice: StateCreator<MazeStore, [], [], AnalyticsOverlayState & AnalyticsOverlayActions> = (set) => ({
  showMazeOverlay: true,
  showComponentsOverlay: false,
  showGraphOverlay: false,
  showNavGraphOverlay: false,
  showPureCyclesOverlay: false,
  showRouteOverlay: false,

  setShowMazeOverlay: (v) => set({ showMazeOverlay: v }),
  setShowComponentsOverlay: (v) => set({ showComponentsOverlay: v }),
  setShowGraphOverlay: (v) => set({ showGraphOverlay: v }),
  setShowNavGraphOverlay: (v) => set({ showNavGraphOverlay: v }),
  setShowPureCyclesOverlay: (v) => set({ showPureCyclesOverlay: v }),
  setShowRouteOverlay: (v) => set({ showRouteOverlay: v }),
});
