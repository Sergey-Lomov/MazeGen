import type { StateCreator } from "zustand";
import type {
  MazeStore,
  ImageExportState,
  ImageExportActions,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { cellMeasureWorldUnits, DPI_BY_DENSITY, mmToPx } from "../../pixi/imageExport/printFit";
import { splitSlotColor } from "../../pixi/colorUtils";
import { setLinkEnabledByTarget, propagate, forceLinks, addLink, removeLink } from "./parameterLinksEngine";
import type { VectorByWallsParamPath, VectorByCorridorsParamPath } from "../parameterLinksRegistry";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "./imageExportDefaults";

export {
  DEFAULT_TELEPORT_SETTINGS,
  DEFAULT_VERTICAL_SETTINGS,
  DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
  DEFAULT_MARKER_INDEX_SETTINGS,
  DEFAULT_ONE_WAY_SETTINGS,
  DEFAULT_SHARED_STYLE_SOURCE,
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "./imageExportDefaults";

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => ({
  activeRenderMode: null,
  openRenderModeSettings: null,
  vectorByWallsSectionsExpanded: {},
  showColorWarnings: true,
  vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  vectorByCorridorsSectionsExpanded: {},
  vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  selectedTeleportGroupKey: null,
  hoveredExportWarningKey: null,
  openExportFormatSettings: null,
  exportFormatSettingsCovered: false,
  pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,

  setActiveRenderMode: (mode) => set({ activeRenderMode: mode }),
  setOpenRenderModeSettings: (mode) => set({ openRenderModeSettings: mode }),
  // A newly (re)opened panel is never covered on open — reset here rather than left stale from
  // whatever the previously open format's covered state happened to be.
  setOpenExportFormatSettings: (format) => set({ openExportFormatSettings: format, exportFormatSettingsCovered: false }),
  setExportFormatSettingsCovered: (covered) => set({ exportFormatSettingsCovered: covered }),
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
    set((s) => {
      const print = s.pngExportSettings.print;
      const oldDpi = DPI_BY_DENSITY[print.density];
      const newDpi = DPI_BY_DENSITY[density];
      // `scale` is a pixel-space value, while the user-facing print size is physical. Keep
      // the latter stable when a manually selected DPI changes (GitHub issue #620). Auto-fit
      // will recompute its own scale from the sheet/content ratio, which is DPI-independent.
      const scale = print.scaleAutoFit ? print.scale : print.scale * newDpi / oldDpi;
      return { pngExportSettings: { ...s.pngExportSettings, print: { ...print, density, scale } } };
    }),
  setPrintPaperSize: (size) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, paperSize: size } } })),
  setPrintCustomSize: (widthMm, heightMm) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, customWidthMm: widthMm, customHeightMm: heightMm } } })),
  setPrintOrientation: (orientation) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, orientation } } })),
  setPrintMargins: (marginHMm, marginVMm) =>
    set((s) => ({ pngExportSettings: { ...s.pngExportSettings, print: { ...s.pngExportSettings.print, marginHMm, marginVMm } } })),
  setPrintFieldSizing: (input, config) =>
    set((s) => {
      const print = s.pngExportSettings.print;
      const dpi = DPI_BY_DENSITY[print.density];
      const scale = mmToPx(input.cellSizeMm, dpi) / cellMeasureWorldUnits(config);
      return {
        pngExportSettings: {
          ...s.pngExportSettings,
          print: {
            ...print,
            paperSize: input.paperSize,
            customWidthMm: input.customWidthMm,
            customHeightMm: input.customHeightMm,
            orientation: input.orientation,
            marginHMm: input.marginHMm,
            marginVMm: input.marginVMm,
            scale,
            // A manually requested physical cell size must win over the panel's auto-fit effect.
            scaleAutoFit: false,
          },
        },
      };
    }),
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
  setShowColorWarnings: (show) => set({ showColorWarnings: show, hoveredExportWarningKey: null }),
  setVectorByCorridorsBackground: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, background: color } })),
  setVectorByCorridorsShowGrid: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, showGrid: v } })),
  setVectorByCorridorsGridColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, gridColor: color } })),
  setVectorByCorridorsColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, color } })),
  setVectorByCorridorsThickness: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, thickness: v } })),
  setVectorByCorridorsJoin: (join) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "join", false);
      const settings = { ...s.vectorByCorridorsSettings, join, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["join"]) };
    }),
  setVectorByCorridorsRenderStyle: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, renderStyle: v } })),
  setVectorByCorridorsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, shape } } })),
  setVectorByCorridorsStartMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "startMarker.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["startMarker.cornerStyle"]) };
    }),
  setVectorByCorridorsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, fillColor: color } } })),
  setVectorByCorridorsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderColor: color } } })),
  setVectorByCorridorsStartMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "startMarker.borderWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["startMarker.borderWidth"]) };
    }),
  setVectorByCorridorsStartMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "startMarker.gapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, gapWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["startMarker.gapWidth"]) };
    }),
  setVectorByCorridorsStartMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "startMarker.size", false);
      const settings = { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, size: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["startMarker.size"]) };
    }),
  setVectorByCorridorsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, shape } } })),
  setVectorByCorridorsFinishMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "finishMarker.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["finishMarker.cornerStyle"]) };
    }),
  setVectorByCorridorsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, fillColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "finishMarker.borderWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["finishMarker.borderWidth"]) };
    }),
  setVectorByCorridorsFinishMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "finishMarker.gapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, gapWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["finishMarker.gapWidth"]) };
    }),
  setVectorByCorridorsFinishMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "finishMarker.size", false);
      const settings = { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, size: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["finishMarker.size"]) };
    }),
  setVectorByCorridorsMarkerWidenPadding: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenPadding: v } })),
  setVectorByCorridorsMarkerWidenShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenShape: shape } })),
  patchVectorByCorridorsOneWaySettings: (patch) =>
    set((s) => {
      let links = s.vectorByCorridorsSettings.links;
      const detached: VectorByCorridorsParamPath[] = [];
      if (patch.oneWayJoin !== undefined) {
        links = setLinkEnabledByTarget(s.vectorByCorridorsSettings, links, "oneWayJoin", false).links;
        detached.push("oneWayJoin");
      }
      const settings = { ...s.vectorByCorridorsSettings, ...patch, links };
      return { vectorByCorridorsSettings: propagate(settings, links, detached) };
    }),
  patchVectorByCorridorsTeleportSettings: (patch) =>
    set((s) => {
      const overridable: VectorByCorridorsParamPath[] = [
        "teleportLineCornerStyle",
        "teleportLineSize",
        "teleportEdgeBorderWidth",
        "teleportEdgeGapWidth",
        "teleportConnectorGapWidth",
      ];
      let links = s.vectorByCorridorsSettings.links;
      const detached: VectorByCorridorsParamPath[] = [];
      for (const target of overridable) {
        if (patch[target as keyof typeof patch] !== undefined) {
          links = setLinkEnabledByTarget(s.vectorByCorridorsSettings, links, target, false).links;
          detached.push(target);
        }
      }
      const settings = { ...s.vectorByCorridorsSettings, ...patch, links };
      return { vectorByCorridorsSettings: propagate(settings, links, detached) };
    }),
  setVectorByCorridorsTeleportGroupOverride: (groupKey, patch) =>
    set((s) => {
      const overrides = { ...s.vectorByCorridorsSettings.teleportGroupOverrides };
      if (patch === null) delete overrides[groupKey];
      else overrides[groupKey] = { ...overrides[groupKey], ...patch };
      return { vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, teleportGroupOverrides: overrides } };
    }),
  setVectorByCorridorsSplitNodeColor: (index, color) =>
    set((s) => {
      const colors = [...s.vectorByCorridorsSettings.splitNodeColors];
      while (colors.length <= index) colors.push(splitSlotColor(colors.length, canvas.node.splitSlots));
      colors[index] = color;
      return { vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, splitNodeColors: colors } };
    }),
  setVectorByCorridorsSplitSpecialShapes: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, splitSpecialShapes: v } })),
  setVectorByCorridorsSplitGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "splitGapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, splitGapWidth: v, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["splitGapWidth"]) };
    }),
  setVectorByCorridorsSplitDiagonalBowAmount: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, splitDiagonalBowAmount: v } })),
  patchVectorByCorridorsVerticalSettings: (patch) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, ...patch } })),
  patchVectorByCorridorsElevatorBadges: (patch) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorBadges: { ...s.vectorByCorridorsSettings.elevatorBadges, ...patch },
      },
    })),
  patchVectorByCorridorsMarkerIndexSettings: (patch) =>
    set((s) => {
      let links = s.vectorByCorridorsSettings.links;
      if (patch.gap !== undefined) links = setLinkEnabledByTarget(s.vectorByCorridorsSettings, links, "markerIndex.gap", false).links;
      const settings = {
        ...s.vectorByCorridorsSettings,
        markerIndex: { ...s.vectorByCorridorsSettings.markerIndex, ...patch },
        links,
      };
      return { vectorByCorridorsSettings: patch.gap !== undefined ? propagate(settings, links, ["markerIndex.gap"]) : settings };
    }),
  setVectorByCorridorsElevatorBadgesCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "elevatorBadges.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, elevatorBadges: { ...s.vectorByCorridorsSettings.elevatorBadges, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["elevatorBadges.cornerStyle"]) };
    }),
  setVectorByCorridorsTwoWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, shape } } })),
  setVectorByCorridorsTwoWayPassageMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "twoWayPassageMarker.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["twoWayPassageMarker.cornerStyle"]) };
    }),
  setVectorByCorridorsTwoWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, fillColor: color } } })),
  setVectorByCorridorsTwoWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, borderColor: color } } })),
  setVectorByCorridorsTwoWayPassageMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "twoWayPassageMarker.borderWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, borderWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["twoWayPassageMarker.borderWidth"]) };
    }),
  setVectorByCorridorsTwoWayPassageMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "twoWayPassageMarker.gapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, gapWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["twoWayPassageMarker.gapWidth"]) };
    }),
  setVectorByCorridorsTwoWayPassageMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "twoWayPassageMarker.size", false);
      const settings = { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, size: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["twoWayPassageMarker.size"]) };
    }),
  setVectorByCorridorsOneWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, shape } } })),
  setVectorByCorridorsOneWayPassageMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "oneWayPassageMarker.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["oneWayPassageMarker.cornerStyle"]) };
    }),
  setVectorByCorridorsOneWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, fillColor: color } } })),
  setVectorByCorridorsOneWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, borderColor: color } } })),
  setVectorByCorridorsOneWayPassageMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "oneWayPassageMarker.borderWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, borderWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["oneWayPassageMarker.borderWidth"]) };
    }),
  setVectorByCorridorsOneWayPassageMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "oneWayPassageMarker.gapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, gapWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["oneWayPassageMarker.gapWidth"]) };
    }),
  setVectorByCorridorsOneWayPassageMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "oneWayPassageMarker.size", false);
      const settings = { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, size: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["oneWayPassageMarker.size"]) };
    }),
  setVectorByCorridorsElevatorMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, shape } } })),
  setVectorByCorridorsElevatorMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "elevatorMarker.cornerStyle", false);
      const settings = { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, cornerStyle: style }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["elevatorMarker.cornerStyle"]) };
    }),
  setVectorByCorridorsElevatorMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, fillColor: color } } })),
  setVectorByCorridorsElevatorMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, borderColor: color } } })),
  setVectorByCorridorsElevatorMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "elevatorMarker.borderWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, borderWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["elevatorMarker.borderWidth"]) };
    }),
  setVectorByCorridorsElevatorMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "elevatorMarker.gapWidth", false);
      const settings = { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, gapWidth: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["elevatorMarker.gapWidth"]) };
    }),
  setVectorByCorridorsElevatorMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, "elevatorMarker.size", false);
      const settings = { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, size: v }, links };
      return { vectorByCorridorsSettings: propagate(settings, links, ["elevatorMarker.size"]) };
    }),
  setVectorByCorridorsSharedCornerStyle: (style) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, cornerStyle: style };
      return { vectorByCorridorsSettings: propagate(settings, settings.links, ["cornerStyle"]) };
    }),
  setVectorByCorridorsSharedMarkerSize: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, markerSize: v };
      return { vectorByCorridorsSettings: propagate(settings, settings.links, ["markerSize"]) };
    }),
  setVectorByCorridorsSharedMarkerBorderWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, markerBorderWidth: v };
      return { vectorByCorridorsSettings: propagate(settings, settings.links, ["markerBorderWidth"]) };
    }),
  setVectorByCorridorsSharedGapWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, gapWidth: v };
      return { vectorByCorridorsSettings: propagate(settings, settings.links, ["gapWidth"]) };
    }),
  resetVectorByCorridorsSharedStyleField: (target) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target, true);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: { ...settings, links } };
    }),
  forceVectorByCorridorsSharedStyle: () =>
    set((s) => {
      const { settings, links } = forceLinks(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links);
      return { vectorByCorridorsSettings: { ...settings, links } };
    }),
  resetVectorByCorridorsSettings: () => set({ vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS }),
  setVectorByCorridorsLinkEnabled: (target, enabled) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target, enabled);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: { ...settings, links } };
    }),
  addVectorByCorridorsLink: (source, target, modifiers) =>
    set((s) => {
      const { settings, links } = addLink(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, source, target, modifiers);
      return { vectorByCorridorsSettings: { ...settings, links } };
    }),
  removeVectorByCorridorsLink: (target) =>
    set((s) => {
      const { settings, links } = removeLink(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: { ...settings, links } };
    }),
  setVectorByWallsBackground: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, background: color } })),
  setVectorByWallsShowGrid: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, showGrid: v } })),
  setVectorByWallsGridColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, gridColor: color } })),
  setVectorByWallsShowInnerGrid: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, showInnerGrid: v } })),
  setVectorByWallsInnerGridColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, innerGridColor: color } })),
  setVectorByWallsFloorColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, floorColor: color } })),
  setVectorByWallsWallColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, wallColor: color } })),
  setVectorByWallsRandomWallColorMode: (mode) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, randomWallColorMode: mode } })),
  setVectorByWallsWallJoin: (join) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "wallJoin", false);
      const settings = { ...s.vectorByWallsSettings, wallJoin: join, links };
      return { vectorByWallsSettings: propagate(settings, links, ["wallJoin"]) };
    }),
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
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "oneWayJoin", false);
      const settings = { ...s.vectorByWallsSettings, oneWayJoin: join, links };
      return { vectorByWallsSettings: propagate(settings, links, ["oneWayJoin"]) };
    }),
  setVectorByWallsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, shape } } })),
  setVectorByWallsStartMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "startMarker.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["startMarker.cornerStyle"]) };
    }),
  setVectorByWallsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, fillColor: color } } })),
  setVectorByWallsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderColor: color } } })),
  setVectorByWallsStartMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "startMarker.borderWidth", false);
      const settings = { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["startMarker.borderWidth"]) };
    }),
  setVectorByWallsStartMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "startMarker.gapWidth", false);
      const settings = { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, gapWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["startMarker.gapWidth"]) };
    }),
  setVectorByWallsStartMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "startMarker.size", false);
      const settings = { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, size: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["startMarker.size"]) };
    }),
  setVectorByWallsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, shape } } })),
  setVectorByWallsFinishMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "finishMarker.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["finishMarker.cornerStyle"]) };
    }),
  setVectorByWallsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, fillColor: color } } })),
  setVectorByWallsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderColor: color } } })),
  setVectorByWallsFinishMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "finishMarker.borderWidth", false);
      const settings = { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["finishMarker.borderWidth"]) };
    }),
  setVectorByWallsFinishMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "finishMarker.gapWidth", false);
      const settings = { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, gapWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["finishMarker.gapWidth"]) };
    }),
  setVectorByWallsFinishMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "finishMarker.size", false);
      const settings = { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, size: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["finishMarker.size"]) };
    }),
  patchVectorByWallsVerticalSettings: (patch) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, ...patch } })),
  patchVectorByWallsDecorativeLineStyle: (section, patch) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        [section]: { ...s.vectorByWallsSettings[section], ...patch },
      },
    })),
  patchVectorByWallsElevatorBadges: (patch) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorBadges: { ...s.vectorByWallsSettings.elevatorBadges, ...patch },
      },
    })),
  patchVectorByWallsMarkerIndexSettings: (patch) =>
    set((s) => {
      let links = s.vectorByWallsSettings.links;
      // `gap` is a "Shared style" `gapWidth`-group member — editing it directly detaches it from
      // the shared value (GitHub issue #471), same convention as the marker gap-ring setters.
      if (patch.gap !== undefined) links = setLinkEnabledByTarget(s.vectorByWallsSettings, links, "markerIndex.gap", false).links;
      const settings = {
        ...s.vectorByWallsSettings,
        markerIndex: { ...s.vectorByWallsSettings.markerIndex, ...patch },
        links,
      };
      return { vectorByWallsSettings: patch.gap !== undefined ? propagate(settings, links, ["markerIndex.gap"]) : settings };
    }),
  setVectorByWallsElevatorBadgesCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "elevatorBadges.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, elevatorBadges: { ...s.vectorByWallsSettings.elevatorBadges, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["elevatorBadges.cornerStyle"]) };
    }),
  setVectorByWallsTwoWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, shape } } })),
  setVectorByWallsTwoWayPassageMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "twoWayPassageMarker.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["twoWayPassageMarker.cornerStyle"]) };
    }),
  setVectorByWallsTwoWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, fillColor: color } } })),
  setVectorByWallsTwoWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, borderColor: color } } })),
  setVectorByWallsTwoWayPassageMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "twoWayPassageMarker.borderWidth", false);
      const settings = { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, borderWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["twoWayPassageMarker.borderWidth"]) };
    }),
  setVectorByWallsTwoWayPassageMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "twoWayPassageMarker.gapWidth", false);
      const settings = { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, gapWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["twoWayPassageMarker.gapWidth"]) };
    }),
  setVectorByWallsTwoWayPassageMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "twoWayPassageMarker.size", false);
      const settings = { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, size: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["twoWayPassageMarker.size"]) };
    }),
  setVectorByWallsOneWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, shape } } })),
  setVectorByWallsOneWayPassageMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "oneWayPassageMarker.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["oneWayPassageMarker.cornerStyle"]) };
    }),
  setVectorByWallsOneWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, fillColor: color } } })),
  setVectorByWallsOneWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, borderColor: color } } })),
  setVectorByWallsOneWayPassageMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "oneWayPassageMarker.borderWidth", false);
      const settings = { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, borderWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["oneWayPassageMarker.borderWidth"]) };
    }),
  setVectorByWallsOneWayPassageMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "oneWayPassageMarker.gapWidth", false);
      const settings = { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, gapWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["oneWayPassageMarker.gapWidth"]) };
    }),
  setVectorByWallsOneWayPassageMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "oneWayPassageMarker.size", false);
      const settings = { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, size: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["oneWayPassageMarker.size"]) };
    }),
  setVectorByWallsElevatorMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, shape } } })),
  setVectorByWallsElevatorMarkerCornerStyle: (style) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "elevatorMarker.cornerStyle", false);
      const settings = { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, cornerStyle: style }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["elevatorMarker.cornerStyle"]) };
    }),
  setVectorByWallsElevatorMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, fillColor: color } } })),
  setVectorByWallsElevatorMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderColor: color } } })),
  setVectorByWallsElevatorMarkerBorderWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "elevatorMarker.borderWidth", false);
      const settings = { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["elevatorMarker.borderWidth"]) };
    }),
  setVectorByWallsElevatorMarkerGapWidth: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "elevatorMarker.gapWidth", false);
      const settings = { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, gapWidth: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["elevatorMarker.gapWidth"]) };
    }),
  setVectorByWallsElevatorMarkerSize: (v) =>
    set((s) => {
      const { links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, "elevatorMarker.size", false);
      const settings = { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, size: v }, links };
      return { vectorByWallsSettings: propagate(settings, links, ["elevatorMarker.size"]) };
    }),
  patchVectorByWallsTeleportSettings: (patch) =>
    set((s) => {
      const overridable: VectorByWallsParamPath[] = [
        "teleportLineCornerStyle",
        "teleportLineSize",
        "teleportEdgeBorderWidth",
        "teleportEdgeGapWidth",
        "teleportConnectorGapWidth",
      ];
      let links = s.vectorByWallsSettings.links;
      const detached: VectorByWallsParamPath[] = [];
      for (const target of overridable) {
        if (patch[target as keyof typeof patch] !== undefined) {
          links = setLinkEnabledByTarget(s.vectorByWallsSettings, links, target, false).links;
          detached.push(target);
        }
      }
      const settings = { ...s.vectorByWallsSettings, ...patch, links };
      return { vectorByWallsSettings: propagate(settings, links, detached) };
    }),
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
  setVectorByWallsSharedCornerStyle: (style) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, cornerStyle: style };
      return { vectorByWallsSettings: propagate(settings, settings.links, ["cornerStyle"]) };
    }),
  setVectorByWallsSharedMarkerSize: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, markerSize: v };
      return { vectorByWallsSettings: propagate(settings, settings.links, ["markerSize"]) };
    }),
  setVectorByWallsSharedMarkerBorderWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, markerBorderWidth: v };
      return { vectorByWallsSettings: propagate(settings, settings.links, ["markerBorderWidth"]) };
    }),
  setVectorByWallsSharedGapWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, gapWidth: v };
      return { vectorByWallsSettings: propagate(settings, settings.links, ["gapWidth"]) };
    }),
  resetVectorByWallsSharedStyleField: (target) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target, true);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: { ...settings, links } };
    }),
  forceVectorByWallsSharedStyle: () =>
    set((s) => {
      const { settings, links } = forceLinks(s.vectorByWallsSettings, s.vectorByWallsSettings.links);
      return { vectorByWallsSettings: { ...settings, links } };
    }),
  resetVectorByWallsSettings: () => set({ vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS }),
  setVectorByWallsLinkEnabled: (target, enabled) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target, enabled);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: { ...settings, links } };
    }),
  addVectorByWallsLink: (source, target, modifiers) =>
    set((s) => {
      const { settings, links } = addLink(s.vectorByWallsSettings, s.vectorByWallsSettings.links, source, target, modifiers);
      return { vectorByWallsSettings: { ...settings, links } };
    }),
  removeVectorByWallsLink: (target) =>
    set((s) => {
      const { settings, links } = removeLink(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: { ...settings, links } };
    }),
  setHoveredExportWarningKey: (key) => set({ hoveredExportWarningKey: key }),
});
