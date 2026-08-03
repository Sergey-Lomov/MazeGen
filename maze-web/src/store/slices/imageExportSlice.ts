import type { StateCreator } from "zustand";
import type { MazeStore, ImageExportState, ImageExportActions } from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => ({
  activeRenderMode: null,
  openRenderModeSettings: null,
  vectorByWallsSectionsExpanded: {},
  vectorByWallsSettings: {
    background: canvas.stage.background,
    showGrid: true,
    gridColor: canvas.grid.line,
  },

  setActiveRenderMode: (mode) => set({ activeRenderMode: mode }),
  setOpenRenderModeSettings: (mode) => set({ openRenderModeSettings: mode }),
  setVectorByWallsSectionExpanded: (id, expanded) =>
    set((s) => ({ vectorByWallsSectionsExpanded: { ...s.vectorByWallsSectionsExpanded, [id]: expanded } })),
  setVectorByWallsBackground: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, background: color } })),
  setVectorByWallsShowGrid: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, showGrid: v } })),
  setVectorByWallsGridColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, gridColor: color } })),
});
