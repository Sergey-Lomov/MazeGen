import type { StateCreator } from "zustand";
import type {
  MazeStore,
  ImageExportState,
  ImageExportActions,
  VectorByWallsSettings,
  VectorByCorridorsSettings,
  VectorByWallsSharedStyle,
  VectorByCorridorsSharedStyle,
  VectorByWallsSharedStyleOverrides,
  VectorByCorridorsSharedStyleOverrides,
  SharedStyleField,
  TeleportSettingsFields,
  OneWaySettingsFields,
  VerticalSettingsFields,
  PngExportSettings,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { WALL_THICKNESS } from "../../pixi/renderConstants";
import { TILE_SIZE } from "../../pixi/constants";
import { splitSlotColor } from "../../pixi/colorUtils";
import {
  applyVectorByWallsSharedStyle,
  applyVectorByCorridorsSharedStyle,
  forceVectorByWallsSharedStyle,
  forceVectorByCorridorsSharedStyle,
  withOverride,
  withoutOverride,
} from "./imageExportSliceHelpers";

/** Shared defaults for the centralized "Shared style" section (GitHub issue #322) — the single
 * source of truth every dependent field's own default is derived from below (`applyVectorBy*
 * SharedStyle`), rather than each field separately hardcoding the same number. Changing a value
 * here changes every dependent field's default in lockstep. */
export const DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE: VectorByWallsSharedStyle = {
  cornerStyle: "round",
  markerSize: 0.16,
  markerBorderWidth: 3,
  gapWidth: 3,
  overrides: {},
};

export const DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE: VectorByCorridorsSharedStyle = {
  cornerStyle: "round",
  markerSize: 0.16,
  markerBorderWidth: 3,
  gapWidth: 3,
  overrides: {},
};

/** Shared by both `VectorByWallsSettings` and `VectorByCorridorsSettings` — GitHub issue #313
 * extracted this out so the two modes' Teleports section defaults never drift apart, mirroring
 * `TeleportSettingsFields` itself being shared at the type level. The four fields driven by
 * "Shared style" (GitHub issue #322: `teleportLineCornerStyle`, `teleportLineSize`,
 * `teleportEdgeBorderWidth`, `teleportEdgeGapWidth`/`teleportConnectorGapWidth`) hold placeholder
 * values here — `applyVectorBy*SharedStyle` overwrites them from `DEFAULT_VECTOR_BY_*_SHARED_STYLE`
 * once assembled into a full settings object below, so this const is never used directly as a
 * finished default on its own. */
export const DEFAULT_TELEPORT_SETTINGS: TeleportSettingsFields = {
  teleportLineCornerStyle: "round",
  teleportLineShape: "diamond",
  teleportLineSize: 0,
  teleportEdgeColor: canvas.teleport.default,
  teleportEdgeBorderColor: canvas.teleport.default,
  teleportEdgeBorderWidth: 0,
  teleportEdgeGapWidth: 0,
  teleportConnectorColor: canvas.teleport.default,
  teleportConnectorWidth: 3,
  teleportConnectorStyle: "orthogonal",
  teleportAvoidFieldExit: false,
  teleportArrowMode: "periodic",
  teleportArrowPeriod: 5,
  teleportArrowSize: 10,
  teleportConnectorGapWidth: 0,
  teleportGroupCustomization: false,
  teleportGroupOverrides: {},
};

/** Shared by `VectorByWallsSettings` and `projectExport/validate.ts`'s recovery defaults, same
 * extraction rationale as `DEFAULT_TELEPORT_SETTINGS`/`DEFAULT_ONE_WAY_SETTINGS` (GitHub issue
 * #347). `verticalPassageMarker`/`elevatorMarker` get distinct default shape/color so the two edge
 * kinds read apart on the map with no configuration needed — square/blue for `VerticalPassage`,
 * hexagon/purple for `Elevator` (an elevator's own fully-connected multi-floor fan reads as "more
 * connected" than a single adjacent-floor passage, loosely mirroring a hexagon's extra sides).
 * `verticalPassageDisplayStyle` defaults to `"marker"` (not `"decorative"`) — a plain opening
 * marker is the one style that's also correct for a physical single-sheet two-floor build, per the
 * issue's own rationale; `"decorative"` is an opt-in choice for a purely visual/print export. */
export const DEFAULT_VERTICAL_SETTINGS: VerticalSettingsFields = {
  verticalPassageDisplayStyle: "marker",
  verticalPassageMarker: { shape: "square", cornerStyle: "round", fillColor: 0x33bbff, borderColor: 0x33bbff, borderWidth: 0, gapWidth: 3, size: 0.2 },
  elevatorMarker: { shape: "hexagon", cornerStyle: "round", fillColor: 0x9955ff, borderColor: 0x9955ff, borderWidth: 0, gapWidth: 3, size: 0.2 },
  oneWayArrowColor: canvas.stage.background,
};

/** Shared with `projectExport/validate.ts`'s recovery defaults for old/malformed project files
 * (GitHub issue #295) — kept as a single exported const so the two never drift apart.
 * `startMarker`/`finishMarker`/`wallJoin`/`oneWayJoin`/every `teleportLine*`/`teleportEdge*`/
 * `teleportConnectorGapWidth` field driven by "Shared style" (GitHub issue #322) holds a
 * placeholder value below, overwritten by `applyVectorByWallsSharedStyle` right after — see that
 * function's own doc comment for exactly which fields it touches. */
export const DEFAULT_VECTOR_BY_WALLS_SETTINGS: VectorByWallsSettings = applyVectorByWallsSharedStyle(
  {
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
    startMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0 },
    finishMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0 },
    ...DEFAULT_TELEPORT_SETTINGS,
    ...DEFAULT_VERTICAL_SETTINGS,
    splitNodeColors: [],
    splitSpecialShapes: true,
    sharedStyle: DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
  },
  ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"],
);

/** Shared by `VectorByCorridorsSettings` and `projectExport/validate.ts`'s recovery defaults, same
 * extraction rationale as `DEFAULT_TELEPORT_SETTINGS` (GitHub issue #312). `oneWayColor` defaults
 * to the canvas background per the issue's own spec (a break in the corridor stroke, not an
 * indicator drawn on top of it). `oneWayThickness` defaults to half of the settings panel's own
 * max (`TILE_SIZE / 4`), same "half of the panel's own cap" convention
 * `DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness` uses for the corridor stroke itself. */
export const DEFAULT_ONE_WAY_SETTINGS: OneWaySettingsFields = {
  oneWayColor: canvas.stage.background,
  oneWayCount: 2,
  oneWayThickness: TILE_SIZE / 8,
  oneWayGap: 2,
  oneWayWidth: 0.5,
  oneWayLength: 0.3,
  oneWayJoin: "round",
};

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. `thickness` defaults to half of the settings panel's own max
 * (`TILE_SIZE`, GitHub issue #310's follow-up) rather than the fixed `WALL_THICKNESS` "Vector by
 * walls" uses — a corridor's meaningful range scales with the cell size, so its default should too.
 * Same "Shared style" placeholder-then-overwrite convention as `DEFAULT_VECTOR_BY_WALLS_SETTINGS`
 * (`join`/`oneWayJoin`/markers/teleport fields/`splitGapWidth` — see
 * `applyVectorByCorridorsSharedStyle`). */
export const DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS: VectorByCorridorsSettings = applyVectorByCorridorsSharedStyle(
  {
    background: canvas.stage.background,
    showGrid: true,
    gridColor: canvas.grid.line,
    color: canvas.wall.default,
    thickness: TILE_SIZE / 2,
    join: "round",
    startMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0 },
    finishMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0 },
    markerWidenPadding: 4,
    markerWidenShape: "match_marker",
    ...DEFAULT_ONE_WAY_SETTINGS,
    ...DEFAULT_TELEPORT_SETTINGS,
    splitNodeColors: [],
    splitSpecialShapes: true,
    splitGapWidth: 0,
    splitDiagonalBowAmount: 0.15,
    sharedStyle: DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE,
  },
  ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"],
);

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
  setVectorByWallsVerticalPassageMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, shape } } })),
  setVectorByWallsVerticalPassageMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, cornerStyle: style } } })),
  setVectorByWallsVerticalPassageMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, fillColor: color } } })),
  setVectorByWallsVerticalPassageMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, borderColor: color } } })),
  setVectorByWallsVerticalPassageMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, borderWidth: v } } })),
  setVectorByWallsVerticalPassageMarkerGapWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, gapWidth: v } } })),
  setVectorByWallsVerticalPassageMarkerSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, verticalPassageMarker: { ...s.vectorByWallsSettings.verticalPassageMarker, size: v } } })),
  setVectorByWallsElevatorMarkerShape: (shape) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, shape } } })),
  setVectorByWallsElevatorMarkerCornerStyle: (style) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, cornerStyle: style } } })),
  setVectorByWallsElevatorMarkerFillColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, fillColor: color } } })),
  setVectorByWallsElevatorMarkerBorderColor: (color) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderColor: color } } })),
  setVectorByWallsElevatorMarkerBorderWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, borderWidth: v } } })),
  setVectorByWallsElevatorMarkerGapWidth: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, gapWidth: v } } })),
  setVectorByWallsElevatorMarkerSize: (v) =>
    set((s) => ({ vectorByWallsSettings: { ...s.vectorByWallsSettings, elevatorMarker: { ...s.vectorByWallsSettings.elevatorMarker, size: v } } })),
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
