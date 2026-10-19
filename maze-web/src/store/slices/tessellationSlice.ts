import type { StateCreator } from "zustand";
import type { TessellationConfig } from "../../fieldConfig";
import { warmCartesianCache } from "../../pixi/cartesianCache";
import { resolveFieldConfig } from "../../pixi/tessellationCells";
import type { PresetConnectionEntry } from "../../pixi/fieldEditUtils";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeStore, TessellationState, TessellationActions, FloorFieldConfig } from "../storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "../storeTypes";
import { splitPatternsFor } from "../../pixi/shapeTemplates";
import { qcForTessellation } from "./qcTessellationFilter";
import { buildPreviewConfig, buildPreviewState, debugStaleOf, tessellationOf, sameTessellation, defaultTessellationOf, buildResetDownstreamState, defaultFloorFieldConfig, makeOrientationSetter } from "../storeHelpers";

export const createTessellationSlice: StateCreator<MazeStore, [], [], TessellationState & TessellationActions> = (set) => ({
  seed: 42,
  tessellationKind: "square",
  tessellationParams: {},
  hexOrientation: DEFAULT_HEX_ORI,
  triOrientation: DEFAULT_TRI_ORI,
  tessellationConfirmed: false,
  previewKind: "square",
  previewParams: {},
  previewHexOrientation: DEFAULT_HEX_ORI,
  previewTriOrientation: DEFAULT_TRI_ORI,
  previewFieldConfig: buildPreviewConfig(defaultTessellationOf("square"), DEFAULT_HEX_ORI, DEFAULT_TRI_ORI),
  activeFieldConfig: resolveFieldConfig(buildPreviewConfig(defaultTessellationOf("square"), DEFAULT_HEX_ORI, DEFAULT_TRI_ORI)),
  showFieldOverlay: true,
  showFieldOrigin: true,
  showPrimitiveFrame: true,
  showPaperLayout: false,
  showBackgroundImage: false,
  backgroundImage: null,
  backgroundImageManualPositioning: false,
  backgroundImageCropping: false,
  backgroundAutoFillPreview: null,
  smoothPrimitives: true,
  symmetrySnapMode: "centers",
  symmetryScope: "one_side",
  symmetryAxisPoints: [],
  symmetrySourceSide: 1,
  symmetryPolygon: [],
  symmetryPolygonFinished: false,
  fieldOpError: null,

  setSeed: (seed) => set({ seed, error: null, seedAttachedToHistory: false }),

  setPreviewKind: (kind) => set((state) => {
    const preview = buildPreviewState(defaultTessellationOf(kind), state.previewHexOrientation, state.previewTriOrientation);
    return { previewKind: kind, previewParams: preview.previewParams, previewFieldConfig: preview.previewFieldConfig };
  }),

  setPreviewParams: (params) => set((state) => ({
    previewParams: params,
    previewFieldConfig: buildPreviewConfig({ kind: state.previewKind, params }, state.previewHexOrientation, state.previewTriOrientation),
  })),

  setPreviewHexOrientation: (orientation) => set((state) => ({
    previewHexOrientation: orientation,
    previewFieldConfig: buildPreviewState({ kind: state.previewKind, params: state.previewParams }, orientation, state.previewTriOrientation).previewFieldConfig,
  })),

  setPreviewTriOrientation: (orientation) => set((state) => ({
    previewTriOrientation: orientation,
    previewFieldConfig: buildPreviewState({ kind: state.previewKind, params: state.previewParams }, state.previewHexOrientation, orientation).previewFieldConfig,
  })),

  syncPreviewToConfirmed: () => set((state) =>
    buildPreviewState(tessellationOf(state), state.hexOrientation, state.triOrientation)
  ),

  confirmTessellation: () => set((state) => {
    const tessellation: TessellationConfig = { kind: state.previewKind, params: state.previewParams };
    const hexOrientation = state.previewHexOrientation;
    const triOrientation = state.previewTriOrientation;
    // Params define the cell set, so a params change discards the maze like a kind change does.
    const clearMaze = !sameTessellation(tessellation, tessellationOf(state));
    const freshField = defaultFloorFieldConfig(tessellation, hexOrientation, triOrientation);
    warmCartesianCache(freshField.fieldConfig);
    // Kind/orientation are maze-wide (Specs/field-editor.md) — every floor's own field config is
    // rebuilt against the newly confirmed kind, same as a single-floor maze always did.
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const floorId of Object.keys(state.floorFields)) floorFields[floorId] = freshField;
    return {
      tessellationKind: tessellation.kind,
      tessellationParams: tessellation.params,
      hexOrientation,
      triOrientation,
      tessellationConfirmed: true,
      ...buildPreviewState(tessellation, hexOrientation, triOrientation),
      floorFields,
      backgroundAutoFillPreview: null,
      symmetryAxisPoints: [],
      symmetryPolygon: [],
      symmetryPolygonFinished: false,
      ...(clearMaze ? {
        ...buildResetDownstreamState(),
        pngExportSettings: {
          ...state.pngExportSettings,
          print: { ...state.pngExportSettings.print, scaleAutoFit: true },
        },
        error: null,
        presetConnections: new Map<string, PresetConnectionEntry>(),
        lockedNodes: new Map<string, NodeLockKind>(),
        autoLockedNodes: new Set<string>(),
        presetStart: null,
        presetFinish: null,
        presetGenSource: null,
        defaultEdgeState: "undefined" as const,
        presetTeleports: [],
        presetTeleportPendingFrom: null,
        _nextPresetTeleportId: 1,
        presetVerticalPassages: [],
        presetVerticalPassagePending: null,
        _nextPresetVerticalPassageId: 1,
        presetElevators: [],
        presetElevatorPending: null,
        _nextPresetElevatorId: 1,
        presetSplitPointIds: {},
        _nextPresetSplitPointId: 1,
        presetEntityOrder: [],
        debugArena: null, debugStep: 0, debugStale: false,
        // A split point (GitHub issue #221/#231) is a geometric-point-shaped concept — its slotIds
        // are meaningless once the tessellation kind changes and every point coordinate means
        // something else entirely. Left uncleared, a stale entry kept the split-node dot on the
        // canvas with none of its connections (all cleared above, since they live in
        // presetConnections/postEditDraftEdges).
        presetSplitPoints: {},
        presetActiveSplitNode: {},
        presetFocusedPoint: null,
        presetSplitTargetPrompt: null,
        presetEntityDeletePrompt: null,
        presetEntityPickPrompt: null,
        presetMoveRequest: null,
        presetConnectionSettingsPrompt: null,
        presetLockSettingsPrompt: null,
        postEditDraftSplitPoints: {},
        postEditActiveSplitNode: {},
        postEditFocusedPoint: null,
      } : { debugStale: debugStaleOf(state) }),
      // A split pattern belongs to a shape template, not a tessellation (GitHub issue #758): it
      // survives any tessellation config change (kind or params) only when the new config provides
      // its template. Both filters return the same references when nothing is dropped.
      splitPatterns: splitPatternsFor(state.splitPatterns, freshField.fieldConfig.tessellation),
      ...qcForTessellation(state, freshField.fieldConfig.tessellation),
      presetsDirty: false,
      mazeDirty: false,
      postEditDirty: false,
    };
  }),

  setTessellationKind: (kind) => set((state) => {
    if (kind === state.tessellationKind) return {};
    const tessellation = defaultTessellationOf(kind);
    const freshField = defaultFloorFieldConfig(tessellation, state.hexOrientation, state.triOrientation);
    // Kind is maze-wide — every floor's per-kind field config is meaningless once it changes
    // (same rationale confirmTessellation's kind-change branch already applies).
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const floorId of Object.keys(state.floorFields)) floorFields[floorId] = freshField;
    return {
      tessellationKind: kind,
      tessellationParams: tessellation.params,
      floorFields,
      backgroundAutoFillPreview: null,
      symmetryAxisPoints: [],
      symmetryPolygon: [],
      symmetryPolygonFinished: false,
      pngExportSettings: {
        ...state.pngExportSettings,
        print: { ...state.pngExportSettings.print, scaleAutoFit: true },
      },
      ...buildResetDownstreamState(),
      error: null,
      debugArena: null, debugStep: 0, debugStale: false,
      presetTeleports: [],
      presetTeleportPendingFrom: null,
      _nextPresetTeleportId: 1,
      presetVerticalPassages: [],
      presetVerticalPassagePending: null,
      _nextPresetVerticalPassageId: 1,
      presetElevators: [],
      presetElevatorPending: null,
      _nextPresetElevatorId: 1,
      presetSplitPointIds: {},
      _nextPresetSplitPointId: 1,
      presetEntityOrder: [],
      splitPatterns: splitPatternsFor(state.splitPatterns, freshField.fieldConfig.tessellation),
      ...qcForTessellation(state, freshField.fieldConfig.tessellation),
    };
  }),

  setHexOrientation: (orientation) => set(makeOrientationSetter("hex", "hexOrientation")(orientation)),
  setTriOrientation: (orientation) => set(makeOrientationSetter("tri", "triOrientation")(orientation)),

  setShowFieldOverlay: (show) => set({ showFieldOverlay: show }),
  setShowFieldOrigin: (show) => set({ showFieldOrigin: show }),
  setShowPrimitiveFrame: (show) => set({ showPrimitiveFrame: show }),
  setShowPaperLayout: (show) => set({ showPaperLayout: show }),
  setShowBackgroundImage: (show) => set({ showBackgroundImage: show }),
  setBackgroundImage: (image) => set({ backgroundImage: image, showBackgroundImage: true }),
  setBackgroundImageLayer: (layer) => set((state) => state.backgroundImage === null ? {} : {
    backgroundImage: { ...state.backgroundImage, layer },
  }),
  setBackgroundImageOpacity: (opacity) => set((state) => state.backgroundImage === null ? {} : {
    backgroundImage: { ...state.backgroundImage, opacity: Math.min(1, Math.max(0, opacity)) },
  }),
  setBackgroundImageManualPositioning: (enabled) => set(enabled
    ? { backgroundImageManualPositioning: true, backgroundImageCropping: false }
    : { backgroundImageManualPositioning: false }),
  setBackgroundImageCropping: (enabled) => set(enabled
    ? { backgroundImageCropping: true, backgroundImageManualPositioning: false }
    : { backgroundImageCropping: false }),
  setBackgroundImageTransform: (transform) => set((state) => state.backgroundImage === null ? {} : {
    backgroundImage: { ...state.backgroundImage, ...transform },
  }),
  setBackgroundAutoFillPreview: (points) => set({ backgroundAutoFillPreview: points }),
  setSmoothPrimitives: (smooth) => set({ smoothPrimitives: smooth }),
  setFieldOpError: (error) => set({ fieldOpError: error }),
  setSymmetrySnapMode: (mode) => set({ symmetrySnapMode: mode }),
  setSymmetryScope: (scope) => set({ symmetryScope: scope }),
  setSymmetryAxisPoints: (points) => set({ symmetryAxisPoints: points }),
  setSymmetrySourceSide: (side) => set({ symmetrySourceSide: side }),
  setSymmetryPolygon: (points) => set({ symmetryPolygon: points }),
  finishSymmetryPolygon: () => set((state) => state.symmetryPolygon.length >= 3 ? { symmetryPolygonFinished: true } : {}),
  resetSymmetryPolygon: () => set({ symmetryPolygon: [], symmetryPolygonFinished: false }),
  resetSymmetryAxis: () => set({ symmetryAxisPoints: [], symmetryPolygon: [], symmetryPolygonFinished: false }),
});
