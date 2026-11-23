import type { StateCreator } from "zustand";
import type { MazeStore, CoordinateWarningState, CoordinateWarningActions } from "../storeTypes";

/** Resting value of the coordinate warning hover; loading a project resets it. */
export const coordinateWarningTransientUi = {
  hoveredCoordinateWarning: null,
} satisfies Partial<CoordinateWarningState>;

export const createCoordinateWarningSlice: StateCreator<MazeStore, [], [], CoordinateWarningState & CoordinateWarningActions> = (set) => ({
  ...coordinateWarningTransientUi,
  setHoveredCoordinateWarning: (warning) => set({ hoveredCoordinateWarning: warning }),
});
