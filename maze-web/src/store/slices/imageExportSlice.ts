import type { StateCreator } from "zustand";
import type {
  MazeStore,
  ImageExportState,
  ImageExportActions,
  VectorByWallsSharedStyleOverrides,
  VectorByCorridorsSharedStyleOverrides,
  SharedStyleField,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { splitSlotColor } from "../../pixi/colorUtils";
import {
  applyVectorByWallsSharedStyle,
  applyVectorByCorridorsSharedStyle,
  forceVectorByWallsSharedStyle,
  forceVectorByCorridorsSharedStyle,
  withOverride,
  withoutOverride,
} from "./imageExportSliceHelpers";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "./imageExportDefaults";

export {
  DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
  DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE,
  DEFAULT_TELEPORT_SETTINGS,
  DEFAULT_VERTICAL_SETTINGS,
  DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
  DEFAULT_MARKER_INDEX_SETTINGS,
  DEFAULT_ONE_WAY_SETTINGS,
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "./imageExportDefaults";

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
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        join,
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "join") },
      },
    })),
  setVectorByCorridorsRoundJunctions: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, roundJunctions: v } })),
  setVectorByCorridorsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, shape } } })),
  setVectorByCorridorsStartMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        startMarker: { ...s.vectorByCorridorsSettings.startMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "startMarker") },
      },
    })),
  setVectorByCorridorsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, fillColor: color } } })),
  setVectorByCorridorsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderColor: color } } })),
  setVectorByCorridorsStartMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        startMarker: { ...s.vectorByCorridorsSettings.startMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerBorderWidth", "startMarker") },
      },
    })),
  setVectorByCorridorsStartMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        startMarker: { ...s.vectorByCorridorsSettings.startMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "startMarker") },
      },
    })),
  setVectorByCorridorsStartMarkerSize: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        startMarker: { ...s.vectorByCorridorsSettings.startMarker, size: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerSize", "startMarker") },
      },
    })),
  setVectorByCorridorsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, shape } } })),
  setVectorByCorridorsFinishMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "finishMarker") },
      },
    })),
  setVectorByCorridorsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, fillColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderColor: color } } })),
  setVectorByCorridorsFinishMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerBorderWidth", "finishMarker") },
      },
    })),
  setVectorByCorridorsFinishMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "finishMarker") },
      },
    })),
  setVectorByCorridorsFinishMarkerSize: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        finishMarker: { ...s.vectorByCorridorsSettings.finishMarker, size: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerSize", "finishMarker") },
      },
    })),
  setVectorByCorridorsMarkerWidenPadding: (v) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenPadding: v } })),
  setVectorByCorridorsMarkerWidenShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, markerWidenShape: shape } })),
  patchVectorByCorridorsOneWaySettings: (patch) =>
    set((s) => {
      let overrides = s.vectorByCorridorsSettings.sharedStyle.overrides;
      if (patch.oneWayJoin !== undefined) overrides = withOverride(overrides, "cornerStyle", "oneWayJoin");
      return {
        vectorByCorridorsSettings: {
          ...s.vectorByCorridorsSettings,
          ...patch,
          sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides },
        },
      };
    }),
  patchVectorByCorridorsTeleportSettings: (patch) =>
    set((s) => {
      // A `Record<string, [group, field]>` lookup necessarily loses the compile-time link between
      // a `TeleportSettingsFields` key and its matching group/field pair — the values below are
      // still hand-verified against `VectorByCorridorsSharedStyleOverrides`'s own shape, so the
      // cast on `withOverride`'s call is safe, just outside what a dynamic key lookup can express.
      const overridable: Record<string, [keyof VectorByCorridorsSharedStyleOverrides, string]> = {
        teleportLineCornerStyle: ["cornerStyle", "teleportLine"],
        teleportLineSize: ["markerSize", "teleportLine"],
        teleportEdgeBorderWidth: ["markerBorderWidth", "teleportEdge"],
        teleportEdgeGapWidth: ["gapWidth", "teleportEdge"],
        teleportConnectorGapWidth: ["gapWidth", "teleportConnector"],
      };
      let overrides = s.vectorByCorridorsSettings.sharedStyle.overrides;
      for (const key of Object.keys(patch)) {
        const mapping = overridable[key];
        if (mapping) {
          overrides = withOverride(
            overrides,
            mapping[0],
            mapping[1] as SharedStyleField<VectorByCorridorsSharedStyleOverrides, typeof mapping[0]>,
          );
        }
      }
      return {
        vectorByCorridorsSettings: {
          ...s.vectorByCorridorsSettings,
          ...patch,
          sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides },
        },
      };
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
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        splitGapWidth: v,
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "split") },
      },
    })),
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
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        markerIndex: { ...s.vectorByCorridorsSettings.markerIndex, ...patch },
        ...(patch.gap !== undefined
          ? { sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "markerIndex") } }
          : {}),
      },
    })),
  setVectorByCorridorsElevatorBadgesCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorBadges: { ...s.vectorByCorridorsSettings.elevatorBadges, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "elevatorBadges") },
      },
    })),
  setVectorByCorridorsTwoWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, shape } } })),
  setVectorByCorridorsTwoWayPassageMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "twoWayPassage") },
      },
    })),
  setVectorByCorridorsTwoWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, fillColor: color } } })),
  setVectorByCorridorsTwoWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, borderColor: color } } })),
  setVectorByCorridorsTwoWayPassageMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerBorderWidth", "twoWayPassage") },
      },
    })),
  setVectorByCorridorsTwoWayPassageMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "twoWayPassage") },
      },
    })),
  setVectorByCorridorsTwoWayPassageMarkerSize: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        twoWayPassageMarker: { ...s.vectorByCorridorsSettings.twoWayPassageMarker, size: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerSize", "twoWayPassage") },
      },
    })),
  setVectorByCorridorsOneWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, shape } } })),
  setVectorByCorridorsOneWayPassageMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "oneWayPassage") },
      },
    })),
  setVectorByCorridorsOneWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, fillColor: color } } })),
  setVectorByCorridorsOneWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, borderColor: color } } })),
  setVectorByCorridorsOneWayPassageMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerBorderWidth", "oneWayPassage") },
      },
    })),
  setVectorByCorridorsOneWayPassageMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "oneWayPassage") },
      },
    })),
  setVectorByCorridorsOneWayPassageMarkerSize: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        oneWayPassageMarker: { ...s.vectorByCorridorsSettings.oneWayPassageMarker, size: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerSize", "oneWayPassage") },
      },
    })),
  setVectorByCorridorsElevatorMarkerShape: (shape) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, shape } } })),
  setVectorByCorridorsElevatorMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "cornerStyle", "elevator") },
      },
    })),
  setVectorByCorridorsElevatorMarkerFillColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, fillColor: color } } })),
  setVectorByCorridorsElevatorMarkerBorderColor: (color) =>
    set((s) => ({ vectorByCorridorsSettings: { ...s.vectorByCorridorsSettings, elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, borderColor: color } } })),
  setVectorByCorridorsElevatorMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerBorderWidth", "elevator") },
      },
    })),
  setVectorByCorridorsElevatorMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "gapWidth", "elevator") },
      },
    })),
  setVectorByCorridorsElevatorMarkerSize: (v) =>
    set((s) => ({
      vectorByCorridorsSettings: {
        ...s.vectorByCorridorsSettings,
        elevatorMarker: { ...s.vectorByCorridorsSettings.elevatorMarker, size: v },
        sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides: withOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, "markerSize", "elevator") },
      },
    })),
  setVectorByCorridorsSharedCornerStyle: (style) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, cornerStyle: style } };
      return { vectorByCorridorsSettings: applyVectorByCorridorsSharedStyle(settings, ["cornerStyle"]) };
    }),
  setVectorByCorridorsSharedMarkerSize: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, markerSize: v } };
      return { vectorByCorridorsSettings: applyVectorByCorridorsSharedStyle(settings, ["markerSize"]) };
    }),
  setVectorByCorridorsSharedMarkerBorderWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, markerBorderWidth: v } };
      return { vectorByCorridorsSettings: applyVectorByCorridorsSharedStyle(settings, ["markerBorderWidth"]) };
    }),
  setVectorByCorridorsSharedGapWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByCorridorsSettings, sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, gapWidth: v } };
      return { vectorByCorridorsSettings: applyVectorByCorridorsSharedStyle(settings, ["gapWidth"]) };
    }),
  resetVectorByCorridorsSharedStyleField: (group, field) =>
    set((s) => {
      const overrides = withoutOverride(s.vectorByCorridorsSettings.sharedStyle.overrides, group, field);
      const settings = { ...s.vectorByCorridorsSettings, sharedStyle: { ...s.vectorByCorridorsSettings.sharedStyle, overrides } };
      return { vectorByCorridorsSettings: applyVectorByCorridorsSharedStyle(settings, [group]) };
    }),
  forceVectorByCorridorsSharedStyle: () =>
    set((s) => ({ vectorByCorridorsSettings: forceVectorByCorridorsSharedStyle(s.vectorByCorridorsSettings) })),
  resetVectorByCorridorsSettings: () => set({ vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS }),
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
  setVectorByWallsRandomWallColorMode: (mode) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, randomWallColorMode: mode } })),
  setVectorByWallsWallJoin: (join) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        wallJoin: join,
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "wallJoin") },
      },
    })),
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
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        oneWayJoin: join,
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "oneWayJoin") },
      },
    })),
  setVectorByWallsStartMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, shape } } })),
  setVectorByWallsStartMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        startMarker: { ...s.vectorByWallsSettings.startMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "startMarker") },
      },
    })),
  setVectorByWallsStartMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, fillColor: color } } })),
  setVectorByWallsStartMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, startMarker: { ...s.vectorByWallsSettings.startMarker, borderColor: color } } })),
  setVectorByWallsStartMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        startMarker: { ...s.vectorByWallsSettings.startMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerBorderWidth", "startMarker") },
      },
    })),
  setVectorByWallsStartMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        startMarker: { ...s.vectorByWallsSettings.startMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "startMarker") },
      },
    })),
  setVectorByWallsStartMarkerSize: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        startMarker: { ...s.vectorByWallsSettings.startMarker, size: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerSize", "startMarker") },
      },
    })),
  setVectorByWallsFinishMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, shape } } })),
  setVectorByWallsFinishMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        finishMarker: { ...s.vectorByWallsSettings.finishMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "finishMarker") },
      },
    })),
  setVectorByWallsFinishMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, fillColor: color } } })),
  setVectorByWallsFinishMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderColor: color } } })),
  setVectorByWallsFinishMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        finishMarker: { ...s.vectorByWallsSettings.finishMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerBorderWidth", "finishMarker") },
      },
    })),
  setVectorByWallsFinishMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        finishMarker: { ...s.vectorByWallsSettings.finishMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "finishMarker") },
      },
    })),
  setVectorByWallsFinishMarkerSize: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        finishMarker: { ...s.vectorByWallsSettings.finishMarker, size: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerSize", "finishMarker") },
      },
    })),
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
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        markerIndex: { ...s.vectorByWallsSettings.markerIndex, ...patch },
        // `gap` is a "Shared style" `gapWidth`-group member — editing it directly detaches it
        // from the shared value (GitHub issue #471), same convention as the marker gap-ring setters.
        ...(patch.gap !== undefined
          ? { sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "markerIndex") } }
          : {}),
      },
    })),
  setVectorByWallsElevatorBadgesCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorBadges: { ...s.vectorByWallsSettings.elevatorBadges, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "elevatorBadges") },
      },
    })),
  setVectorByWallsTwoWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, shape } } })),
  setVectorByWallsTwoWayPassageMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "twoWayPassage") },
      },
    })),
  setVectorByWallsTwoWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, fillColor: color } } })),
  setVectorByWallsTwoWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, borderColor: color } } })),
  setVectorByWallsTwoWayPassageMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerBorderWidth", "twoWayPassage") },
      },
    })),
  setVectorByWallsTwoWayPassageMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "twoWayPassage") },
      },
    })),
  setVectorByWallsTwoWayPassageMarkerSize: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        twoWayPassageMarker: { ...s.vectorByWallsSettings.twoWayPassageMarker, size: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerSize", "twoWayPassage") },
      },
    })),
  setVectorByWallsOneWayPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, shape } } })),
  setVectorByWallsOneWayPassageMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "oneWayPassage") },
      },
    })),
  setVectorByWallsOneWayPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, fillColor: color } } })),
  setVectorByWallsOneWayPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, borderColor: color } } })),
  setVectorByWallsOneWayPassageMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerBorderWidth", "oneWayPassage") },
      },
    })),
  setVectorByWallsOneWayPassageMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "oneWayPassage") },
      },
    })),
  setVectorByWallsOneWayPassageMarkerSize: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        oneWayPassageMarker: { ...s.vectorByWallsSettings.oneWayPassageMarker, size: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerSize", "oneWayPassage") },
      },
    })),
  setVectorByWallsElevatorMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, shape } } })),
  setVectorByWallsElevatorMarkerCornerStyle: (style) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, cornerStyle: style },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "cornerStyle", "elevator") },
      },
    })),
  setVectorByWallsElevatorMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, fillColor: color } } })),
  setVectorByWallsElevatorMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderColor: color } } })),
  setVectorByWallsElevatorMarkerBorderWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerBorderWidth", "elevator") },
      },
    })),
  setVectorByWallsElevatorMarkerGapWidth: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, gapWidth: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "gapWidth", "elevator") },
      },
    })),
  setVectorByWallsElevatorMarkerSize: (v) =>
    set((s) => ({
      vectorByWallsSettings: {
        ...s.vectorByWallsSettings,
        elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, size: v },
        sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides: withOverride(s.vectorByWallsSettings.sharedStyle.overrides, "markerSize", "elevator") },
      },
    })),
  patchVectorByWallsTeleportSettings: (patch) =>
    set((s) => {
      // See `patchVectorByCorridorsTeleportSettings`'s own comment on this same pattern — the cast
      // is hand-verified against `VectorByWallsSharedStyleOverrides`'s own shape.
      const overridable: Record<string, [keyof VectorByWallsSharedStyleOverrides, string]> = {
        teleportLineCornerStyle: ["cornerStyle", "teleportLine"],
        teleportLineSize: ["markerSize", "teleportLine"],
        teleportEdgeBorderWidth: ["markerBorderWidth", "teleportEdge"],
        teleportEdgeGapWidth: ["gapWidth", "teleportEdge"],
        teleportConnectorGapWidth: ["gapWidth", "teleportConnector"],
      };
      let overrides = s.vectorByWallsSettings.sharedStyle.overrides;
      for (const key of Object.keys(patch)) {
        const mapping = overridable[key];
        if (mapping) {
          overrides = withOverride(
            overrides,
            mapping[0],
            mapping[1] as SharedStyleField<VectorByWallsSharedStyleOverrides, typeof mapping[0]>,
          );
        }
      }
      return {
        vectorByWallsSettings: {
          ...s.vectorByWallsSettings,
          ...patch,
          sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides },
        },
      };
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
      const settings = { ...s.vectorByWallsSettings, sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, cornerStyle: style } };
      return { vectorByWallsSettings: applyVectorByWallsSharedStyle(settings, ["cornerStyle"]) };
    }),
  setVectorByWallsSharedMarkerSize: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, markerSize: v } };
      return { vectorByWallsSettings: applyVectorByWallsSharedStyle(settings, ["markerSize"]) };
    }),
  setVectorByWallsSharedMarkerBorderWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, markerBorderWidth: v } };
      return { vectorByWallsSettings: applyVectorByWallsSharedStyle(settings, ["markerBorderWidth"]) };
    }),
  setVectorByWallsSharedGapWidth: (v) =>
    set((s) => {
      const settings = { ...s.vectorByWallsSettings, sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, gapWidth: v } };
      return { vectorByWallsSettings: applyVectorByWallsSharedStyle(settings, ["gapWidth"]) };
    }),
  resetVectorByWallsSharedStyleField: (group, field) =>
    set((s) => {
      const overrides = withoutOverride(s.vectorByWallsSettings.sharedStyle.overrides, group, field);
      const settings = { ...s.vectorByWallsSettings, sharedStyle: { ...s.vectorByWallsSettings.sharedStyle, overrides } };
      return { vectorByWallsSettings: applyVectorByWallsSharedStyle(settings, [group]) };
    }),
  forceVectorByWallsSharedStyle: () =>
    set((s) => ({ vectorByWallsSettings: forceVectorByWallsSharedStyle(s.vectorByWallsSettings) })),
  resetVectorByWallsSettings: () => set({ vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS }),
  setHoveredExportWarningKey: (key) => set({ hoveredExportWarningKey: key }),
});
