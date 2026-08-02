import type { StateCreator } from "zustand";
import type { MazeStore, ImageExportState, ImageExportActions } from "../storeTypes";

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => ({
  activeRenderMode: null,
  openRenderModeSettings: null,

  setActiveRenderMode: (mode) => set({ activeRenderMode: mode }),
  setOpenRenderModeSettings: (mode) => set({ openRenderModeSettings: mode }),
});
