import type { StateCreator } from "zustand";
import type { MazeStore, ImageExportState, ImageExportActions, VectorByWallsSettings, VectorByCorridorsSettings, TeleportSettingsFields, PngExportSettings } from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { NODE_RADIUS, WALL_THICKNESS } from "../../pixi/renderConstants";
import { TILE_SIZE } from "../../pixi/constants";
import { splitSlotColor } from "../../pixi/colorUtils";

/** Shared by both `VectorByWallsSettings` and `VectorByCorridorsSettings` — GitHub issue #313
 * extracted this out so the two modes' Teleports section defaults never drift apart, mirroring
 * `TeleportSettingsFields` itself being shared at the type level. */
export const DEFAULT_TELEPORT_SETTINGS: TeleportSettingsFields = {
  teleportLineCornerStyle: "round",
  teleportLineShape: "diamond",
  teleportLineSize: 0.16,
  teleportEdgeColor: canvas.teleport.default,
  teleportEdgeBorderColor: canvas.teleport.default,
  teleportEdgeBorderWidth: 3,
  teleportEdgeGapWidth: 3,
  teleportConnectorColor: canvas.teleport.default,
  teleportConnectorWidth: 3,
  teleportConnectorStyle: "orthogonal",
  teleportAvoidFieldExit: false,
  teleportArrowMode: "periodic",
  teleportArrowPeriod: 5,
  teleportArrowSize: 10,
  teleportConnectorGapWidth: 3,
  teleportGroupCustomization: false,
  teleportGroupOverrides: {},
};

/** Shared with `projectExport/validate.ts`'s recovery defaults for old/malformed project files
 * (GitHub issue #295) — kept as a single exported const so the two never drift apart. */
export const DEFAULT_VECTOR_BY_WALLS_SETTINGS: VectorByWallsSettings = {
  background: canvas.stage.background,
  showGrid: true,
  gridColor: canvas.grid.line,
  floorColor: canvas.floor.default,
  wallColor: canvas.wall.default,
  wallJoin: "round",
  wallThickness: WALL_THICKNESS,
  oneWayPattern: "triangle",
  oneWayColor: 0xffaa00,
  oneWayGapWidth: 3,
  oneWaySize: 0.3,
  oneWayThickness: 4,
  oneWayJoin: "round",
  startMarker: { shape: "circle", cornerStyle: "sharp", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: (NODE_RADIUS * 1.5) / TILE_SIZE },
  finishMarker: { shape: "circle", cornerStyle: "sharp", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: (NODE_RADIUS * 1.5) / TILE_SIZE },
  ...DEFAULT_TELEPORT_SETTINGS,
  splitNodeColors: [],
  splitSpecialShapes: true,
};

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. `thickness` defaults to half of the settings panel's own max
 * (`TILE_SIZE`, GitHub issue #310's follow-up) rather than the fixed `WALL_THICKNESS` "Vector by
 * walls" uses — a corridor's meaningful range scales with the cell size, so its default should too. */
export const DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS: VectorByCorridorsSettings = {
  color: canvas.wall.default,
  thickness: TILE_SIZE / 2,
  join: "round",
  startMarker: { shape: "circle", cornerStyle: "sharp", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: (NODE_RADIUS * 1.5) / TILE_SIZE },
  finishMarker: { shape: "circle", cornerStyle: "sharp", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: (NODE_RADIUS * 1.5) / TILE_SIZE },
  markerWidenPadding: 4,
  markerWidenShape: "match_marker",
  ...DEFAULT_TELEPORT_SETTINGS,
};

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. */
export const DEFAULT_PNG_EXPORT_SETTINGS: PngExportSettings = {
  outputMode: "digital",
  digital: { scale: 1, canvasMode: "edge_to_edge", marginValue: 20, fixedWidth: 1920, fixedHeight: 1080 },
  print: { density: "print_300", paperSize: "a4", customWidthMm: 210, customHeightMm: 297, orientation: "landscape", marginHMm: 5, marginVMm: 5, scale: 1, scaleAutoFit: true, anchor: "center", offsetXMm: 0, offsetYMm: 0 },
};

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => ({
  activeRenderMode: null,
  openRenderModeSettings: null,
  vectorByWallsSectionsExpanded: {},
  vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  vectorByCorridorsSectionsExpanded: {},
  vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  selectedTeleportGroupKey: null,
  hoveredExportWarningKey: null,
  openExportFormatSettings: null,
  pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,

  setActiveRenderMode: (mode) => set({ activeRenderMode: mode }),
  setOpenRenderModeSettings: (mode) => set({ openRenderModeSettings: mode }),
  setOpenExportFormatSettings: (format) => set({ openExportFormatSettings: format }),
  setPngOutputMode: (mode) => set((s) => ({ pngExportSettings: { ...s.pngExportSettings, outputMode: mode } })),
  setDigitalScale: (scale) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, digital: { ...s.pngExportSettings.digital, scale } } })),
  setDigitalCanvasMode: (mode) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, digital: { ...s.pngExportSettings.digital, canvasMode: mode } } })),
  setDigitalMarginValue: (v) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, digital: { ...s.pngExportSettings.digital, marginValue: v } } })),
  setDigitalFixedSize: (width, height) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, digital: { ...s.pngExportSettings.digital, fixedWidth: width, fixedHeight: height } } })),
  setPrintDensity: (density) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, density } } })),
  setPrintPaperSize: (size) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, paperSize: size } } })),
  setPrintCustomSize: (widthMm, heightMm) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, customWidthMm: widthMm, customHeightMm: heightMm } } })),
  setPrintOrientation: (orientation) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, orientation } } })),
  setPrintMargins: (marginHMm, marginVMm) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, marginHMm, marginVMm } } })),
  setPrintScale: (scale) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, scale } } })),
  setPrintScaleAutoFit: (autoFit) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, scaleAutoFit: autoFit } } })),
  setPrintAnchor: (anchor) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, anchor } } })),
  setPrintCustomPlacement: (scale, offsetXMm, offsetYMm) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, scale, offsetXMm, offsetYMm, anchor: "custom" } } })),
  setVectorByWallsSectionExpanded: (id, expanded) =>
    set((s) => ({ vectorByWallsSectionsExpanded: { ...s.vectorByWallsSectionsExpanded, [id]: expanded } })),
  setVectorByCorridorsSectionExpanded: (id, expanded) =>
    set((s) => ({ vectorByCorridorsSectionsExpanded: { ...s.vectorByCorridorsSectionsExpanded, [id]: expanded } })),
  setVectorByCorridorsColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, color } })),
  setVectorByCorridorsThickness: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, thickness: v } })),
  setVectorByCorridorsJoin: (join) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, join } })),
  setVectorByCorridorsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, shape } } })),
  setVectorByCorridorsStartMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, cornerStyle: style } } })),
  setVectorByCorridorsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, fillColor: color } } })),
  setVectorByCorridorsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderColor: color } } })),
  setVectorByCorridorsStartMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderWidth: v } } })),
  setVectorByCorridorsStartMarkerGapWidth: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, gapWidth: v } } })),
  setVectorByCorridorsStartMarkerSize: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, size: v } } })),
  setVectorByCorridorsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, shape } } })),
  setVectorByCorridorsFinishMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, cornerStyle: style } } })),
  setVectorByCorridorsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, fillColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderWidth: v } } })),
  setVectorByCorridorsFinishMarkerGapWidth: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, gapWidth: v } } })),
  setVectorByCorridorsFinishMarkerSize: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, size: v } } })),
  setVectorByCorridorsMarkerWidenPadding: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenPadding: v } })),
  setVectorByCorridorsMarkerWidenShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenShape: shape } })),
  patchVectorByCorridorsTeleportSettings: (patch) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, ...patch } })),
  setVectorByCorridorsTeleportGroupOverride: (groupKey, patch) =>
    set((s) => {
      const overrides = { ...s.vectorByCorridorsSettings.teleportGroupOverrides };
      if (patch === null) delete overrides[groupKey];
      else overrides[groupKey] = { ...overrides[groupKey], ...patch };
      return { vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, teleportGroupOverrides: overrides } };
    }),
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
  setVectorByWallsOneWayGapWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayGapWidth: v } })),
  setVectorByWallsOneWaySize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWaySize: v } })),
  setVectorByWallsOneWayThickness: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayThickness: v } })),
  setVectorByWallsOneWayJoin: (join) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayJoin: join } })),
  setVectorByWallsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, shape } } })),
  setVectorByWallsStartMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, cornerStyle: style } } })),
  setVectorByWallsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, fillColor: color } } })),
  setVectorByWallsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderColor: color } } })),
  setVectorByWallsStartMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderWidth: v } } })),
  setVectorByWallsStartMarkerGapWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, gapWidth: v } } })),
  setVectorByWallsStartMarkerSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, size: v } } })),
  setVectorByWallsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, shape } } })),
  setVectorByWallsFinishMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, cornerStyle: style } } })),
  setVectorByWallsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, fillColor: color } } })),
  setVectorByWallsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderColor: color } } })),
  setVectorByWallsFinishMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderWidth: v } } })),
  setVectorByWallsFinishMarkerGapWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, gapWidth: v } } })),
  setVectorByWallsFinishMarkerSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, size: v } } })),
  patchVectorByWallsTeleportSettings: (patch) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, ...patch } })),
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
  setHoveredExportWarningKey: (key) => set({ hoveredExportWarningKey: key }),
});
