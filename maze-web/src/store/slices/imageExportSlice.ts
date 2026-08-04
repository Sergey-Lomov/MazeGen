import type { StateCreator } from "zustand";
import type { MazeStore, ImageExportState, ImageExportActions } from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { WALL_THICKNESS } from "../../pixi/renderConstants";
import { splitSlotColor } from "../../pixi/colorUtils";

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => ({
  activeRenderMode: null,
  openRenderModeSettings: null,
  vectorByWallsSectionsExpanded: {},
  vectorByWallsSettings: {
    background: canvas.stage.background,
    showGrid: true,
    gridColor: canvas.grid.line,
    floorColor: canvas.floor.default,
    wallColor: canvas.wall.default,
    wallJoin: "round",
    wallThickness: WALL_THICKNESS,
    oneWayPattern: "triangle",
    oneWayColor: 0xffaa00,
    oneWayBorderWidth: 3,
    oneWaySize: 0.3,
    oneWayThickness: 4,
    oneWayJoin: "round",
    startMarker: { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0 },
    finishMarker: { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0 },
    teleportLineCornerStyle: "round",
    teleportLineShape: "diamond",
    teleportLineSize: 0.16,
    teleportEdgeColor: canvas.teleport.default,
    teleportEdgeBorderColor: canvas.teleport.default,
    teleportEdgeBorderWidth: 3,
    teleportConnectorColor: canvas.teleport.default,
    teleportConnectorWidth: 3,
    teleportConnectorStyle: "orthogonal",
    teleportArrowMode: "periodic",
    teleportArrowPeriod: 5,
    teleportArrowSize: 10,
    teleportConnectorBorderWidth: 3,
    teleportGroupCustomization: false,
    teleportGroupOverrides: {},
    splitNodeColors: [],
    splitSpecialShapes: true,
  },
  selectedTeleportGroupKey: null,

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
  setVectorByWallsFloorColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, floorColor: color } })),
  setVectorByWallsWallColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, wallColor: color } })),
  setVectorByWallsWallJoin: (join) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, wallJoin: join } })),
  setVectorByWallsWallThickness: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, wallThickness: v } })),
  setVectorByWallsOneWayPattern: (pattern) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPattern: pattern } })),
  setVectorByWallsOneWayColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayColor: color } })),
  setVectorByWallsOneWayBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayBorderWidth: v } })),
  setVectorByWallsOneWaySize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWaySize: v } })),
  setVectorByWallsOneWayThickness: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayThickness: v } })),
  setVectorByWallsOneWayJoin: (join) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayJoin: join } })),
  setVectorByWallsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, shape } } })),
  setVectorByWallsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, fillColor: color } } })),
  setVectorByWallsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderColor: color } } })),
  setVectorByWallsStartMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderWidth: v } } })),
  setVectorByWallsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, shape } } })),
  setVectorByWallsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, fillColor: color } } })),
  setVectorByWallsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderColor: color } } })),
  setVectorByWallsFinishMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderWidth: v } } })),
  setVectorByWallsTeleportLineCornerStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportLineCornerStyle: style } })),
  setVectorByWallsTeleportLineShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportLineShape: shape } })),
  setVectorByWallsTeleportLineSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportLineSize: v } })),
  setVectorByWallsTeleportEdgeColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportEdgeColor: color } })),
  setVectorByWallsTeleportEdgeBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportEdgeBorderColor: color } })),
  setVectorByWallsTeleportEdgeBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportEdgeBorderWidth: v } })),
  setVectorByWallsTeleportConnectorColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportConnectorColor: color } })),
  setVectorByWallsTeleportConnectorWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportConnectorWidth: v } })),
  setVectorByWallsTeleportConnectorStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportConnectorStyle: style } })),
  setVectorByWallsTeleportArrowMode: (mode) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportArrowMode: mode } })),
  setVectorByWallsTeleportArrowPeriod: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportArrowPeriod: v } })),
  setVectorByWallsTeleportArrowSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportArrowSize: v } })),
  setVectorByWallsTeleportConnectorBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportConnectorBorderWidth: v } })),
  setVectorByWallsTeleportGroupCustomization: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportGroupCustomization: v } })),
  setVectorByWallsTeleportGroupOverride: (groupKey, patch) =>
    set((s) => {
      const overrides = { ...s.vectorByWallsSettings.teleportGroupOverrides };
      if (patch === null) delete overrides[groupKey];
      else overrides[groupKey] = { ...overrides[groupKey], ...patch };
      return { vectorByWallsSettings: { ...s.vectorByWallsSettings, teleportGroupOverrides: overrides } };
    }),
  setSelectedTeleportGroupKey: (key) => set({ selectedTeleportGroupKey: key }),
  setVectorByWallsSplitNodeColor: (index, color) =>
    set((s) => {
      const colors = [...s.vectorByWallsSettings.splitNodeColors];
      while (colors.length <= index) colors.push(splitSlotColor(colors.length, canvas.node.splitSlots));
      colors[index] = color;
      return { vectorByWallsSettings: { ...s.vectorByWallsSettings, splitNodeColors: colors } };
    }),
  setVectorByWallsSplitSpecialShapes: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, splitSpecialShapes: v } })),
});
