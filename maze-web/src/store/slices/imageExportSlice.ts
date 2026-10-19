import type { StateCreator } from "zustand";
import type {
  MazeStore,
  ImageExportState,
  ImageExportActions,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { cellMeasureWorldUnits, DPI_BY_DENSITY, mmToPx } from "../../pixi/imageExport/printFit";
import { splitSlotColor } from "../../pixi/colorUtils";
import { setLinkEnabledByTarget, forceLinks, addLink, removeLink, writeLinkedParam, applyLinkedPatch, markLinked, setParamValue, propagateLinkedSources, type Linked } from "./parameterLinksEngine";
import type { VectorByWallsParamPath, VectorByCorridorsParamPath } from "../parameterLinksRegistry";
import { mergeGroupOverridePatch } from "../teleportGroupLinks";
import { chooseFloorLabelModeOnce } from "../floorLabelModeChoice";
import {
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
  defaultFloorLabelMode,
  withFloorLabelMode,
} from "./imageExportDefaults";

export {
  DEFAULT_TELEPORT_SETTINGS,
  DEFAULT_VERTICAL_SETTINGS,
  DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
  DEFAULT_MARKER_INDEX_SETTINGS,
  DEFAULT_FLOOR_LABEL_SETTINGS,
  DEFAULT_ONE_WAY_SETTINGS,
  DEFAULT_SHARED_STYLE_SOURCE,
  DEFAULT_VERTICAL_SHARED_STYLE,
  DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  DEFAULT_PNG_EXPORT_SETTINGS,
} from "./imageExportDefaults";

/** State updaters for a registry field written by hand — every linkable field's setter goes
 *  through these (GitHub issue #704), see `writeLinkedParam`. */
const wallsParam = (path: VectorByWallsParamPath, value: unknown) => (s: MazeStore) => ({
  vectorByWallsSettings: writeLinkedParam(s.vectorByWallsSettings, path, value),
});
const corridorsParam = (path: VectorByCorridorsParamPath, value: unknown) => (s: MazeStore) => ({
  vectorByCorridorsSettings: writeLinkedParam(s.vectorByCorridorsSettings, path, value),
});

type VectorByWallsSettings = MazeStore["vectorByWallsSettings"];
type VectorByCorridorsSettings = MazeStore["vectorByCorridorsSettings"];

/** `preset` with `current`'s maze-bound fields — see `ImageExportActions.loadVisualPreset`. */
function withMazeBound<S extends VectorByWallsSettings | VectorByCorridorsSettings>(preset: S, current: S): S {
  return {
    ...preset,
    teleportGroupOverrides: current.teleportGroupOverrides,
    floorLabel: { ...preset.floorLabel, positionsByFloorId: current.floorLabel.positionsByFloorId },
  };
}

/** `set` as the slice sees it (GitHub issue #704): `vectorBy*Settings` may only be assigned a
 *  `Linked` value, so every write to them goes through a link-aware helper (`wallsParam`,
 *  `wallsPatch`, `wallsPlain`, `markLinked`) — a hand-rolled `{ ...s.vectorByWallsSettings, x }`
 *  no longer compiles. */
type GuardedUpdate = Omit<Partial<MazeStore>, "vectorByWallsSettings" | "vectorByCorridorsSettings"> & {
  vectorByWallsSettings?: Linked<VectorByWallsSettings>;
  vectorByCorridorsSettings?: Linked<VectorByCorridorsSettings>;
};
type GuardedSet = (partial: GuardedUpdate | ((s: MazeStore) => GuardedUpdate)) => void;

/** Settings paths that are deliberately NOT linkable (not in the param registry) and so need no
 *  detach/propagate on write. Listing a registry path here is a compile error (`wallsPlain`/
 *  `corridorsPlain` constrain `path` to these) and a test failure (`imageExportLinkedSetters`). */
export const WALLS_PLAIN_PATHS = ["randomWallColorMode", "oneWayPattern", "startMarker.text", "finishMarker.text", "teleportGroupOverrides", "splitNodeColors"] as const;
export const CORRIDORS_PLAIN_PATHS = ["renderStyle", "markerWidenShape", "startMarker.text", "finishMarker.text", "teleportGroupOverrides", "splitNodeColors"] as const;

const wallsPlain = (path: (typeof WALLS_PLAIN_PATHS)[number], value: unknown) => (s: MazeStore) => ({
  vectorByWallsSettings: markLinked(setParamValue(s.vectorByWallsSettings, path, value)),
});
const corridorsPlain = (path: (typeof CORRIDORS_PLAIN_PATHS)[number], value: unknown) => (s: MazeStore) => ({
  vectorByCorridorsSettings: markLinked(setParamValue(s.vectorByCorridorsSettings, path, value)),
});

const wallsPatch =
  (rootPatch: object, overridable: readonly VectorByWallsParamPath[], build: (cur: MazeStore["vectorByWallsSettings"]) => MazeStore["vectorByWallsSettings"]) =>
  (s: MazeStore) => ({
    vectorByWallsSettings: applyLinkedPatch(s.vectorByWallsSettings, build(s.vectorByWallsSettings), rootPatch, overridable),
  });
const corridorsPatch =
  (rootPatch: object, overridable: readonly VectorByCorridorsParamPath[], build: (cur: MazeStore["vectorByCorridorsSettings"]) => MazeStore["vectorByCorridorsSettings"]) =>
  (s: MazeStore) => ({
    vectorByCorridorsSettings: applyLinkedPatch(s.vectorByCorridorsSettings, build(s.vectorByCorridorsSettings), rootPatch, overridable),
  });

/** Reduces a (possibly nested, whole-object) patch to the leaves that actually differ from `cur`, so
 *  `applyLinkedPatch` detaches only the links of fields the user really changed — a UI handler
 *  passing `{ teleportMarker: { ...marker, shape } }` must not detach the size/color links too. */
function pruneUnchanged(cur: unknown, patch: object): object {
  const out: Record<string, unknown> = {};
  const curRec = (cur ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const before = curRec[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && before !== null && typeof before === "object") {
      const nested = pruneUnchanged(before, value);
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else if (!Object.is(value, before)) {
      out[key] = value;
    }
  }
  return out;
}

const TELEPORT_OVERRIDABLE = [
  "teleportMarker.shape",
  "teleportMarker.cornerStyle",
  "teleportMarker.size",
  "teleportMarker.fillColor",
  "teleportMarker.borderColor",
  "teleportMarker.borderWidth",
  "teleportMarker.gapWidth",
  "teleportConnectorColor",
  "teleportConnectorGapWidth",
  "teleportFloorBadge.shape",
  "teleportFloorBadge.fillColor",
  "teleportFloorBadge.borderColor",
  "teleportFloorBadge.cornerStyle",
  "teleportFloorBadge.size",
  "teleportFloorBadge.borderWidth",
  "teleportFloorBadge.gapWidth",
  "teleportFloorBadge.textColor",
  "teleportFloorBadge.textSize",
  "teleportFloorBadge.textMargin",
  "teleportFloorBadge.textFontWeight",
] as const;
const ELEVATOR_BADGES_OVERRIDABLE = ["elevatorBadges.shape", "elevatorBadges.fillColor", "elevatorBadges.borderColor", "elevatorBadges.borderWidth", "elevatorBadges.textColor", "elevatorBadges.textSize", "elevatorBadges.textMargin", "elevatorBadges.textFontWeight"] as const;
const MARKER_INDEX_OVERRIDABLE = ["markerIndex.gap", "markerIndex.fillColor", "markerIndex.textColor", "markerIndex.borderColor"] as const;
const FLOOR_LABEL_OVERRIDABLE = [
  "floorLabel.enabled", "floorLabel.labelType", "floorLabel.textFontWeight", "floorLabel.textSize",
  "floorLabel.textMargin", "floorLabel.width", "floorLabel.height", "floorLabel.cornerRadius",
  "floorLabel.gap", "floorLabel.borderWidth", "floorLabel.fillColor", "floorLabel.borderColor", "floorLabel.textColor",
] as const;

const buildImageExportSlice = (set: GuardedSet): ImageExportState & ImageExportActions => ({
  activeRenderMode: null,
  floorLabelDrag: null,
  openRenderModeSettings: null,
  vectorByWallsSectionsExpanded: {},
  showColorWarnings: true,
  linkIconVisibility: "linked",
  vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
  floorLabelModeChosen: false,
  vectorByCorridorsSectionsExpanded: {},
  vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
  hoveredTeleportNodeIds: null,
  hoveredExportWarningKey: null,
  openExportFormatSettings: null,
  exportFormatSettingsCovered: false,
  pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,

  setActiveRenderMode: (mode) => set({ activeRenderMode: mode, floorLabelDrag: null }),
  loadVisualPreset: (preset) => set((s) => {
    const p = preset.imageExport;
    const update = {
      // A style saved before any mode was picked keeps this project's current choice.
      activeRenderMode: p.activeRenderMode ?? s.activeRenderMode,
      floorLabelDrag: null,
      hoveredExportWarningKey: null,
      showColorWarnings: p.showColorWarnings,
      linkIconVisibility: p.linkIconVisibility,
      pngExportSettings: p.pngExportSettings,
      floorLabelModeChosen: p.floorLabelModeChosen,
      vectorByWallsSettings: markLinked(withMazeBound(p.vectorByWallsSettings, s.vectorByWallsSettings)),
      vectorByCorridorsSettings: markLinked(withMazeBound(p.vectorByCorridorsSettings, s.vectorByCorridorsSettings)),
    };
    // A preset saved before its floor-label mode was chosen gets one picked for this project's
    // floors, same as a first open of the Image Export card.
    return { ...update, ...chooseFloorLabelModeOnce({ ...s, ...update }) } as GuardedUpdate;
  }),
  startFloorLabelDrag: (renderMode) => set((s) => {
    const floorLabel = renderMode === "vector_by_walls"
      ? s.vectorByWallsSettings.floorLabel
      : s.vectorByCorridorsSettings.floorLabel;
    const position = floorLabel.positionsByFloorId[s.activeFloorId];
    if (!position || position.mode === "anchored") return {};
    return {
      floorLabelDrag: {
        renderMode,
        floorId: s.activeFloorId,
        initialPosition: position.mode === "cell"
          ? { ...position, cell: [...position.cell] as [number, number] }
          : { ...position },
      },
    };
  }),
  updateFloorLabelDragPosition: (position) => set((s) => {
    const drag = s.floorLabelDrag;
    if (!drag || drag.initialPosition.mode !== position.mode) return {};
    if (drag.renderMode === "vector_by_walls") {
      const floorLabel = s.vectorByWallsSettings.floorLabel;
      return { vectorByWallsSettings: markLinked({
        ...s.vectorByWallsSettings,
        floorLabel: { ...floorLabel, positionsByFloorId: { ...floorLabel.positionsByFloorId, [drag.floorId]: position } },
      }) };
    }
    const floorLabel = s.vectorByCorridorsSettings.floorLabel;
    return { vectorByCorridorsSettings: markLinked({
      ...s.vectorByCorridorsSettings,
      floorLabel: { ...floorLabel, positionsByFloorId: { ...floorLabel.positionsByFloorId, [drag.floorId]: position } },
    }) };
  }),
  finishFloorLabelDrag: () => set({ floorLabelDrag: null }),
  cancelFloorLabelDrag: () => set((s) => {
    const drag = s.floorLabelDrag;
    if (!drag) return {};
    if (drag.renderMode === "vector_by_walls") {
      const floorLabel = s.vectorByWallsSettings.floorLabel;
      return {
        floorLabelDrag: null,
        vectorByWallsSettings: markLinked({
          ...s.vectorByWallsSettings,
          floorLabel: { ...floorLabel, positionsByFloorId: { ...floorLabel.positionsByFloorId, [drag.floorId]: drag.initialPosition } },
        }),
      };
    }
    const floorLabel = s.vectorByCorridorsSettings.floorLabel;
    return {
      floorLabelDrag: null,
      vectorByCorridorsSettings: markLinked({
        ...s.vectorByCorridorsSettings,
        floorLabel: { ...floorLabel, positionsByFloorId: { ...floorLabel.positionsByFloorId, [drag.floorId]: drag.initialPosition } },
      }),
    };
  }),
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
  setLinkIconVisibility: (v) => set({ linkIconVisibility: v }),
  setVectorByCorridorsBackground: (color) => set(corridorsParam("background", color)),
  setVectorByCorridorsShowGrid: (v) => set(corridorsParam("showGrid", v)),
  setVectorByCorridorsGridColor: (color) => set(corridorsParam("gridColor", color)),
  setVectorByCorridorsColor: (color) => set(corridorsParam("color", color)),
  setVectorByCorridorsThickness: (v) => set(corridorsParam("thickness", v)),
  setVectorByCorridorsJunctionRadius: (v) => set(corridorsParam("junctionRadius", v)),
  setVectorByCorridorsJoin: (join) => set(corridorsParam("join", join)),
  setVectorByCorridorsRenderStyle: (v) =>
    set(corridorsPlain("renderStyle", v)),
  setVectorByCorridorsStartMarkerShape: (shape) => set(corridorsParam("startMarker.shape", shape)),
  setVectorByCorridorsStartMarkerText: (text) =>
    set(corridorsPlain("startMarker.text", text)),
  setVectorByCorridorsStartMarkerTextEnabled: (textEnabled) => set(corridorsParam("startMarker.textEnabled", textEnabled)),
  setVectorByCorridorsStartMarkerTextFontWeight: (textFontWeight) => set(corridorsParam("startMarker.textFontWeight", textFontWeight)),
  setVectorByCorridorsStartMarkerTextSize: (textSize) => set(corridorsParam("startMarker.textSize", textSize)),
  setVectorByCorridorsStartMarkerTextMargin: (textMargin) => set(corridorsParam("startMarker.textMargin", textMargin)),
  setVectorByCorridorsStartMarkerTextColor: (textColor) => set(corridorsParam("startMarker.textColor", textColor)),
  setVectorByCorridorsStartMarkerCornerStyle: (style) => set(corridorsParam("startMarker.cornerStyle", style)),
  setVectorByCorridorsStartMarkerFillColor: (color) => set(corridorsParam("startMarker.fillColor", color)),
  setVectorByCorridorsStartMarkerBorderColor: (color) => set(corridorsParam("startMarker.borderColor", color)),
  setVectorByCorridorsStartMarkerBorderWidth: (v) => set(corridorsParam("startMarker.borderWidth", v)),
  setVectorByCorridorsStartMarkerGapWidth: (v) => set(corridorsParam("startMarker.gapWidth", v)),
  setVectorByCorridorsStartMarkerSize: (v) => set(corridorsParam("startMarker.size", v)),
  setVectorByCorridorsFinishMarkerShape: (shape) => set(corridorsParam("finishMarker.shape", shape)),
  setVectorByCorridorsFinishMarkerText: (text) =>
    set(corridorsPlain("finishMarker.text", text)),
  setVectorByCorridorsFinishMarkerTextEnabled: (textEnabled) => set(corridorsParam("finishMarker.textEnabled", textEnabled)),
  setVectorByCorridorsFinishMarkerTextFontWeight: (textFontWeight) => set(corridorsParam("finishMarker.textFontWeight", textFontWeight)),
  setVectorByCorridorsFinishMarkerTextSize: (textSize) => set(corridorsParam("finishMarker.textSize", textSize)),
  setVectorByCorridorsFinishMarkerTextMargin: (textMargin) => set(corridorsParam("finishMarker.textMargin", textMargin)),
  setVectorByCorridorsFinishMarkerTextColor: (textColor) => set(corridorsParam("finishMarker.textColor", textColor)),
  setVectorByCorridorsFinishMarkerCornerStyle: (style) => set(corridorsParam("finishMarker.cornerStyle", style)),
  setVectorByCorridorsFinishMarkerFillColor: (color) => set(corridorsParam("finishMarker.fillColor", color)),
  setVectorByCorridorsFinishMarkerBorderColor: (color) => set(corridorsParam("finishMarker.borderColor", color)),
  setVectorByCorridorsFinishMarkerBorderWidth: (v) => set(corridorsParam("finishMarker.borderWidth", v)),
  setVectorByCorridorsFinishMarkerGapWidth: (v) => set(corridorsParam("finishMarker.gapWidth", v)),
  setVectorByCorridorsFinishMarkerSize: (v) => set(corridorsParam("finishMarker.size", v)),
  setVectorByCorridorsMarkerWidenPadding: (v) => set(corridorsParam("markerWidenPadding", v)),
  setVectorByCorridorsMarkerWidenShape: (shape) =>
    set(corridorsPlain("markerWidenShape", shape)),
  patchVectorByCorridorsOneWaySettings: (patch) =>
    set(corridorsPatch(patch, ["oneWayJoin"], (c) => ({ ...c, ...patch }))),
  patchVectorByCorridorsTeleportSettings: (patch) =>
    set((s) => corridorsPatch(pruneUnchanged(s.vectorByCorridorsSettings, patch), TELEPORT_OVERRIDABLE, (c) => ({ ...c, ...patch }))(s)),
  setVectorByCorridorsTeleportGroupOverride: (groupKey, patch) =>
    set((s) => {
      const overrides = { ...s.vectorByCorridorsSettings.teleportGroupOverrides };
      const merged = patch === null ? null : mergeGroupOverridePatch(overrides[groupKey], patch);
      if (merged === null) delete overrides[groupKey];
      else overrides[groupKey] = merged;
      return corridorsPlain("teleportGroupOverrides", overrides)(s);
    }),
  patchVectorByCorridorsTeleportGroupOverrides: (patches) =>
    set((s) => {
      const overrides = { ...s.vectorByCorridorsSettings.teleportGroupOverrides };
      for (const [key, patch] of Object.entries(patches)) {
        const merged = mergeGroupOverridePatch(overrides[key], patch);
        if (merged === null) delete overrides[key];
        else overrides[key] = merged;
      }
      return corridorsPlain("teleportGroupOverrides", overrides)(s);
    }),
  setVectorByCorridorsSplitNodeColor: (index, color) =>
    set((s) => {
      const colors = [...s.vectorByCorridorsSettings.splitNodeColors];
      while (colors.length <= index) colors.push(splitSlotColor(colors.length, canvas.node.splitSlots));
      colors[index] = color;
      return corridorsPlain("splitNodeColors", colors)(s);
    }),
  setVectorByCorridorsSplitSpecialShapes: (v) => set(corridorsParam("splitSpecialShapes", v)),
  setVectorByCorridorsSplitGapWidth: (v) => set(corridorsParam("splitGapWidth", v)),
  setVectorByCorridorsSplitDiagonalBowAmount: (v) => set(corridorsParam("splitDiagonalBowAmount", v)),
  patchVectorByCorridorsVerticalSettings: (patch) =>
    set(corridorsPatch(patch, ["twoWayArrowColor", "oneWayArrowColor", "elevatorArrowColor"], (c) => ({ ...c, ...patch }))),
  patchVectorByCorridorsElevatorBadges: (patch) =>
    set(corridorsPatch({ elevatorBadges: patch }, ELEVATOR_BADGES_OVERRIDABLE, (c) => ({ ...c, elevatorBadges: { ...c.elevatorBadges, ...patch } }))),
  patchVectorByCorridorsMarkerIndexSettings: (patch) =>
    set(corridorsPatch({ markerIndex: patch }, MARKER_INDEX_OVERRIDABLE, (c) => ({ ...c, markerIndex: { ...c.markerIndex, ...patch } }))),
  patchVectorByCorridorsFloorLabelSettings: (patch) =>
    set(corridorsPatch({ floorLabel: patch }, FLOOR_LABEL_OVERRIDABLE, (c) => ({ ...c, floorLabel: { ...c.floorLabel, ...patch } }))),
  setVectorByCorridorsElevatorBadgesCornerStyle: (style) => set(corridorsParam("elevatorBadges.cornerStyle", style)),
  setVectorByCorridorsTwoWayPassageMarkerShape: (shape) => set(corridorsParam("twoWayPassageMarker.shape", shape)),
  setVectorByCorridorsTwoWayPassageMarkerCornerStyle: (style) => set(corridorsParam("twoWayPassageMarker.cornerStyle", style)),
  setVectorByCorridorsTwoWayPassageMarkerFillColor: (color) => set(corridorsParam("twoWayPassageMarker.fillColor", color)),
  setVectorByCorridorsTwoWayPassageMarkerBorderColor: (color) => set(corridorsParam("twoWayPassageMarker.borderColor", color)),
  setVectorByCorridorsTwoWayPassageMarkerBorderWidth: (v) => set(corridorsParam("twoWayPassageMarker.borderWidth", v)),
  setVectorByCorridorsTwoWayPassageMarkerGapWidth: (v) => set(corridorsParam("twoWayPassageMarker.gapWidth", v)),
  setVectorByCorridorsTwoWayPassageMarkerSize: (v) => set(corridorsParam("twoWayPassageMarker.size", v)),
  setVectorByCorridorsOneWayPassageMarkerShape: (shape) => set(corridorsParam("oneWayPassageMarker.shape", shape)),
  setVectorByCorridorsOneWayPassageMarkerCornerStyle: (style) => set(corridorsParam("oneWayPassageMarker.cornerStyle", style)),
  setVectorByCorridorsOneWayPassageMarkerFillColor: (color) => set(corridorsParam("oneWayPassageMarker.fillColor", color)),
  setVectorByCorridorsOneWayPassageMarkerBorderColor: (color) => set(corridorsParam("oneWayPassageMarker.borderColor", color)),
  setVectorByCorridorsOneWayPassageMarkerBorderWidth: (v) => set(corridorsParam("oneWayPassageMarker.borderWidth", v)),
  setVectorByCorridorsOneWayPassageMarkerGapWidth: (v) => set(corridorsParam("oneWayPassageMarker.gapWidth", v)),
  setVectorByCorridorsOneWayPassageMarkerSize: (v) => set(corridorsParam("oneWayPassageMarker.size", v)),
  setVectorByCorridorsElevatorMarkerShape: (shape) => set(corridorsParam("elevatorMarker.shape", shape)),
  setVectorByCorridorsElevatorMarkerCornerStyle: (style) => set(corridorsParam("elevatorMarker.cornerStyle", style)),
  setVectorByCorridorsElevatorMarkerFillColor: (color) => set(corridorsParam("elevatorMarker.fillColor", color)),
  setVectorByCorridorsElevatorMarkerBorderColor: (color) => set(corridorsParam("elevatorMarker.borderColor", color)),
  setVectorByCorridorsElevatorMarkerBorderWidth: (v) => set(corridorsParam("elevatorMarker.borderWidth", v)),
  setVectorByCorridorsElevatorMarkerGapWidth: (v) => set(corridorsParam("elevatorMarker.gapWidth", v)),
  setVectorByCorridorsElevatorMarkerSize: (v) => set(corridorsParam("elevatorMarker.size", v)),
  patchVectorByCorridorsSharedStyle: (patch) =>
    set((s) => ({ vectorByCorridorsSettings: propagateLinkedSources({ ...s.vectorByCorridorsSettings, ...patch }, Object.keys(patch) as VectorByCorridorsParamPath[]) })),
  patchVectorByCorridorsVerticalSharedStyle: (patch) =>
    set((s) => ({ vectorByCorridorsSettings: propagateLinkedSources({ ...s.vectorByCorridorsSettings, ...patch }, Object.keys(patch) as VectorByCorridorsParamPath[]) })),
  resetVectorByCorridorsSharedStyleField: (target) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target, true);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: markLinked({ ...settings, links }) };
    }),
  forceVectorByCorridorsSharedStyle: () =>
    set((s) => {
      const { settings, links } = forceLinks(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links);
      return { vectorByCorridorsSettings: markLinked({ ...settings, links }) };
    }),
  resetVectorByCorridorsSettings: () => set((s) => ({
    vectorByCorridorsSettings: markLinked(withFloorLabelMode(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, defaultFloorLabelMode(s.floors))),
  })),
  setVectorByCorridorsLinkEnabled: (target, enabled) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target, enabled);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: markLinked({ ...settings, links }) };
    }),
  addVectorByCorridorsLink: (source, target, modifiers, colorModifiers) =>
    set((s) => {
      const { settings, links } = addLink(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, source, target, modifiers, colorModifiers);
      return { vectorByCorridorsSettings: markLinked({ ...settings, links }) };
    }),
  removeVectorByCorridorsLink: (target) =>
    set((s) => {
      const { settings, links } = removeLink(s.vectorByCorridorsSettings, s.vectorByCorridorsSettings.links, target);
      if (links === s.vectorByCorridorsSettings.links) return {};
      return { vectorByCorridorsSettings: markLinked({ ...settings, links }) };
    }),
  setVectorByWallsBackground: (color) => set(wallsParam("background", color)),
  setVectorByWallsShowGrid: (v) => set(wallsParam("showGrid", v)),
  setVectorByWallsGridColor: (color) => set(wallsParam("gridColor", color)),
  setVectorByWallsShowInnerGrid: (v) => set(wallsParam("showInnerGrid", v)),
  setVectorByWallsInnerGridColor: (color) => set(wallsParam("innerGridColor", color)),
  setVectorByWallsFloorColor: (color) => set(wallsParam("floorColor", color)),
  setVectorByWallsWallColor: (color) => set(wallsParam("wallColor", color)),
  setVectorByWallsRandomWallColorMode: (mode) =>
    set(wallsPlain("randomWallColorMode", mode)),
  setVectorByWallsWallJoin: (join) => set(wallsParam("wallJoin", join)),
  setVectorByWallsWallThickness: (v) => set(wallsParam("wallThickness", v)),
  setVectorByWallsOneWayPattern: (pattern) =>
    set(wallsPlain("oneWayPattern", pattern)),
  setVectorByWallsOneWayColor: (color) => set(wallsParam("oneWayColor", color)),
  setVectorByWallsOneWayGapWidth: (v) => set(wallsParam("oneWayGapWidth", v)),
  setVectorByWallsOneWaySize: (v) => set(wallsParam("oneWaySize", v)),
  setVectorByWallsOneWayThickness: (v) => set(wallsParam("oneWayThickness", v)),
  setVectorByWallsOneWayJoin: (join) => set(wallsParam("oneWayJoin", join)),
  setVectorByWallsStartMarkerShape: (shape) => set(wallsParam("startMarker.shape", shape)),
  setVectorByWallsStartMarkerText: (text) =>
    set(wallsPlain("startMarker.text", text)),
  setVectorByWallsStartMarkerTextEnabled: (textEnabled) => set(wallsParam("startMarker.textEnabled", textEnabled)),
  setVectorByWallsStartMarkerTextFontWeight: (textFontWeight) => set(wallsParam("startMarker.textFontWeight", textFontWeight)),
  setVectorByWallsStartMarkerTextSize: (textSize) => set(wallsParam("startMarker.textSize", textSize)),
  setVectorByWallsStartMarkerTextMargin: (textMargin) => set(wallsParam("startMarker.textMargin", textMargin)),
  setVectorByWallsStartMarkerTextColor: (textColor) => set(wallsParam("startMarker.textColor", textColor)),
  setVectorByWallsStartMarkerCornerStyle: (style) => set(wallsParam("startMarker.cornerStyle", style)),
  setVectorByWallsStartMarkerFillColor: (color) => set(wallsParam("startMarker.fillColor", color)),
  setVectorByWallsStartMarkerBorderColor: (color) => set(wallsParam("startMarker.borderColor", color)),
  setVectorByWallsStartMarkerBorderWidth: (v) => set(wallsParam("startMarker.borderWidth", v)),
  setVectorByWallsStartMarkerGapWidth: (v) => set(wallsParam("startMarker.gapWidth", v)),
  setVectorByWallsStartMarkerSize: (v) => set(wallsParam("startMarker.size", v)),
  setVectorByWallsFinishMarkerShape: (shape) => set(wallsParam("finishMarker.shape", shape)),
  setVectorByWallsFinishMarkerText: (text) =>
    set(wallsPlain("finishMarker.text", text)),
  setVectorByWallsFinishMarkerTextEnabled: (textEnabled) => set(wallsParam("finishMarker.textEnabled", textEnabled)),
  setVectorByWallsFinishMarkerTextFontWeight: (textFontWeight) => set(wallsParam("finishMarker.textFontWeight", textFontWeight)),
  setVectorByWallsFinishMarkerTextSize: (textSize) => set(wallsParam("finishMarker.textSize", textSize)),
  setVectorByWallsFinishMarkerTextMargin: (textMargin) => set(wallsParam("finishMarker.textMargin", textMargin)),
  setVectorByWallsFinishMarkerTextColor: (textColor) => set(wallsParam("finishMarker.textColor", textColor)),
  setVectorByWallsFinishMarkerCornerStyle: (style) => set(wallsParam("finishMarker.cornerStyle", style)),
  setVectorByWallsFinishMarkerFillColor: (color) => set(wallsParam("finishMarker.fillColor", color)),
  setVectorByWallsFinishMarkerBorderColor: (color) => set(wallsParam("finishMarker.borderColor", color)),
  setVectorByWallsFinishMarkerBorderWidth: (v) => set(wallsParam("finishMarker.borderWidth", v)),
  setVectorByWallsFinishMarkerGapWidth: (v) => set(wallsParam("finishMarker.gapWidth", v)),
  setVectorByWallsFinishMarkerSize: (v) => set(wallsParam("finishMarker.size", v)),
  patchVectorByWallsVerticalSettings: (patch) =>
    set(wallsPatch(patch, ["twoWayArrowColor", "oneWayArrowColor", "elevatorArrowColor", "decorativeStairsArrowColor", "decorativeStairsOneWayArrowColor"], (c) => ({ ...c, ...patch }))),
  patchVectorByWallsDecorativeLineStyle: (section, patch) =>
    set(wallsPatch({ [section]: patch }, [`${section}.lineColor` as VectorByWallsParamPath], (c) => ({ ...c, [section]: { ...c[section], ...patch } }))),
  patchVectorByWallsElevatorBadges: (patch) =>
    set(wallsPatch({ elevatorBadges: patch }, ELEVATOR_BADGES_OVERRIDABLE, (c) => ({ ...c, elevatorBadges: { ...c.elevatorBadges, ...patch } }))),
  patchVectorByWallsMarkerIndexSettings: (patch) =>
    set(wallsPatch({ markerIndex: patch }, MARKER_INDEX_OVERRIDABLE, (c) => ({ ...c, markerIndex: { ...c.markerIndex, ...patch } }))),
  patchVectorByWallsFloorLabelSettings: (patch) =>
    set(wallsPatch({ floorLabel: patch }, FLOOR_LABEL_OVERRIDABLE, (c) => ({ ...c, floorLabel: { ...c.floorLabel, ...patch } }))),
  setVectorByWallsElevatorBadgesCornerStyle: (style) => set(wallsParam("elevatorBadges.cornerStyle", style)),
  setVectorByWallsTwoWayPassageMarkerShape: (shape) => set(wallsParam("twoWayPassageMarker.shape", shape)),
  setVectorByWallsTwoWayPassageMarkerCornerStyle: (style) => set(wallsParam("twoWayPassageMarker.cornerStyle", style)),
  setVectorByWallsTwoWayPassageMarkerFillColor: (color) => set(wallsParam("twoWayPassageMarker.fillColor", color)),
  setVectorByWallsTwoWayPassageMarkerBorderColor: (color) => set(wallsParam("twoWayPassageMarker.borderColor", color)),
  setVectorByWallsTwoWayPassageMarkerBorderWidth: (v) => set(wallsParam("twoWayPassageMarker.borderWidth", v)),
  setVectorByWallsTwoWayPassageMarkerGapWidth: (v) => set(wallsParam("twoWayPassageMarker.gapWidth", v)),
  setVectorByWallsTwoWayPassageMarkerSize: (v) => set(wallsParam("twoWayPassageMarker.size", v)),
  setVectorByWallsOneWayPassageMarkerShape: (shape) => set(wallsParam("oneWayPassageMarker.shape", shape)),
  setVectorByWallsOneWayPassageMarkerCornerStyle: (style) => set(wallsParam("oneWayPassageMarker.cornerStyle", style)),
  setVectorByWallsOneWayPassageMarkerFillColor: (color) => set(wallsParam("oneWayPassageMarker.fillColor", color)),
  setVectorByWallsOneWayPassageMarkerBorderColor: (color) => set(wallsParam("oneWayPassageMarker.borderColor", color)),
  setVectorByWallsOneWayPassageMarkerBorderWidth: (v) => set(wallsParam("oneWayPassageMarker.borderWidth", v)),
  setVectorByWallsOneWayPassageMarkerGapWidth: (v) => set(wallsParam("oneWayPassageMarker.gapWidth", v)),
  setVectorByWallsOneWayPassageMarkerSize: (v) => set(wallsParam("oneWayPassageMarker.size", v)),
  setVectorByWallsElevatorMarkerShape: (shape) => set(wallsParam("elevatorMarker.shape", shape)),
  setVectorByWallsElevatorMarkerCornerStyle: (style) => set(wallsParam("elevatorMarker.cornerStyle", style)),
  setVectorByWallsElevatorMarkerFillColor: (color) => set(wallsParam("elevatorMarker.fillColor", color)),
  setVectorByWallsElevatorMarkerBorderColor: (color) => set(wallsParam("elevatorMarker.borderColor", color)),
  setVectorByWallsElevatorMarkerBorderWidth: (v) => set(wallsParam("elevatorMarker.borderWidth", v)),
  setVectorByWallsElevatorMarkerGapWidth: (v) => set(wallsParam("elevatorMarker.gapWidth", v)),
  setVectorByWallsElevatorMarkerSize: (v) => set(wallsParam("elevatorMarker.size", v)),
  patchVectorByWallsTeleportSettings: (patch) =>
    set((s) => wallsPatch(pruneUnchanged(s.vectorByWallsSettings, patch), TELEPORT_OVERRIDABLE, (c) => ({ ...c, ...patch }))(s)),
  setVectorByWallsTeleportGroupOverride: (groupKey, patch) =>
    set((s) => {
      const overrides = { ...s.vectorByWallsSettings.teleportGroupOverrides };
      const merged = patch === null ? null : mergeGroupOverridePatch(overrides[groupKey], patch);
      if (merged === null) delete overrides[groupKey];
      else overrides[groupKey] = merged;
      return wallsPlain("teleportGroupOverrides", overrides)(s);
    }),
  patchVectorByWallsTeleportGroupOverrides: (patches) =>
    set((s) => {
      const overrides = { ...s.vectorByWallsSettings.teleportGroupOverrides };
      for (const [key, patch] of Object.entries(patches)) {
        const merged = mergeGroupOverridePatch(overrides[key], patch);
        if (merged === null) delete overrides[key];
        else overrides[key] = merged;
      }
      return wallsPlain("teleportGroupOverrides", overrides)(s);
    }),
  setHoveredTeleportNodeIds: (ids) => set({ hoveredTeleportNodeIds: ids }),
  setVectorByWallsSplitNodeColor: (index, color) =>
    set((s) => {
      const colors = [...s.vectorByWallsSettings.splitNodeColors];
      while (colors.length <= index) colors.push(splitSlotColor(colors.length, canvas.node.splitSlots));
      colors[index] = color;
      return wallsPlain("splitNodeColors", colors)(s);
    }),
  setVectorByWallsSplitSpecialShapes: (v) => set(wallsParam("splitSpecialShapes", v)),
  patchVectorByWallsSharedStyle: (patch) =>
    set((s) => ({ vectorByWallsSettings: propagateLinkedSources({ ...s.vectorByWallsSettings, ...patch }, Object.keys(patch) as VectorByWallsParamPath[]) })),
  patchVectorByWallsVerticalSharedStyle: (patch) =>
    set((s) => ({ vectorByWallsSettings: propagateLinkedSources({ ...s.vectorByWallsSettings, ...patch }, Object.keys(patch) as VectorByWallsParamPath[]) })),
  resetVectorByWallsSharedStyleField: (target) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target, true);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: markLinked({ ...settings, links }) };
    }),
  forceVectorByWallsSharedStyle: () =>
    set((s) => {
      const { settings, links } = forceLinks(s.vectorByWallsSettings, s.vectorByWallsSettings.links);
      return { vectorByWallsSettings: markLinked({ ...settings, links }) };
    }),
  resetVectorByWallsSettings: () => set((s) => ({
    vectorByWallsSettings: markLinked(withFloorLabelMode(DEFAULT_VECTOR_BY_WALLS_SETTINGS, defaultFloorLabelMode(s.floors))),
  })),
  setVectorByWallsLinkEnabled: (target, enabled) =>
    set((s) => {
      const { settings, links } = setLinkEnabledByTarget(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target, enabled);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: markLinked({ ...settings, links }) };
    }),
  addVectorByWallsLink: (source, target, modifiers, colorModifiers) =>
    set((s) => {
      const { settings, links } = addLink(s.vectorByWallsSettings, s.vectorByWallsSettings.links, source, target, modifiers, colorModifiers);
      return { vectorByWallsSettings: markLinked({ ...settings, links }) };
    }),
  removeVectorByWallsLink: (target) =>
    set((s) => {
      const { settings, links } = removeLink(s.vectorByWallsSettings, s.vectorByWallsSettings.links, target);
      if (links === s.vectorByWallsSettings.links) return {};
      return { vectorByWallsSettings: markLinked({ ...settings, links }) };
    }),
  setHoveredExportWarningKey: (key) => set({ hoveredExportWarningKey: key }),
});

export const createImageExportSlice: StateCreator<MazeStore, [], [], ImageExportState & ImageExportActions> = (set) => buildImageExportSlice(set);
