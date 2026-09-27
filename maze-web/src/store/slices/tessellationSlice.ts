import type { StateCreator } from "zustand";
import { warmCartesianCache } from "../../pixi/cartesianCache";
import type { PresetConnectionEntry } from "../../pixi/fieldEditUtils";
import type { NodeLockKind, SplitPattern } from "../../wasm/types";
import type { MazeStore, TessellationState, TessellationActions, FloorFieldConfig } from "../storeTypes";
import { DEFAULT_HEX_ORI, DEFAULT_TRI_ORI } from "../storeTypes";
import { buildPreviewState, debugStaleOf, buildResetDownstreamState, defaultFloorFieldConfig, makeOrientationSetter } from "../storeHelpers";

export const createTessellationSlice: StateCreator<MazeStore, [], [], TessellationState & TessellationActions> = (set) => ({
  seed: 42,
  tessellationKind: "square",
  hexOrientation: DEFAULT_HEX_ORI,
  triOrientation: DEFAULT_TRI_ORI,
  tessellationConfirmed: false,
  previewKind: "square",
  previewHexOrientation: DEFAULT_HEX_ORI,
  previewTriOrientation: DEFAULT_TRI_ORI,
  previewTessellationConfig: { type: "square", width: 11, height: 11 },
  activeTessellationConfig: { type: "square", width: 11, height: 11 },
  showFieldOverlay: true,
  showFieldOrigin: true,

  setSeed: (seed) => set({ seed, error: null, seedAttachedToHistory: false }),

  setPreviewKind: (kind) => set((state) => ({
    previewKind: kind,
    previewTessellationConfig: buildPreviewState(kind, state.previewHexOrientation, state.previewTriOrientation).previewTessellationConfig,
  })),

  setPreviewHexOrientation: (orientation) => set((state) => ({
    previewHexOrientation: orientation,
    previewTessellationConfig: buildPreviewState(state.previewKind, orientation, state.previewTriOrientation).previewTessellationConfig,
  })),

  setPreviewTriOrientation: (orientation) => set((state) => ({
    previewTriOrientation: orientation,
    previewTessellationConfig: buildPreviewState(state.previewKind, state.previewHexOrientation, orientation).previewTessellationConfig,
  })),

  syncPreviewToConfirmed: () => set((state) =>
    buildPreviewState(state.tessellationKind, state.hexOrientation, state.triOrientation)
  ),

  confirmTessellation: () => set((state) => {
    const kind = state.previewKind;
    const hexOrientation = state.previewHexOrientation;
    const triOrientation = state.previewTriOrientation;
    const clearMaze = kind !== state.tessellationKind;
    const freshField = defaultFloorFieldConfig(kind, hexOrientation, triOrientation);
    warmCartesianCache(freshField.tessellationConfig);
    // Kind/orientation are maze-wide (Specs/field-editor.md) — every floor's own field config is
    // rebuilt against the newly confirmed kind, same as a single-floor maze always did.
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const floorId of Object.keys(state.floorFields)) floorFields[floorId] = freshField;
    return {
      tessellationKind: kind,
      hexOrientation,
      triOrientation,
      tessellationConfirmed: true,
      ...buildPreviewState(kind, hexOrientation, triOrientation),
      floorFields,
      ...(clearMaze ? {
        ...buildResetDownstreamState(),
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
        postEditDraftSplitPoints: {},
        postEditActiveSplitNode: {},
        postEditFocusedPoint: null,
        // A split pattern's `face_index` values (GitHub issue #222) are relative to the
        // tessellation they were authored against — meaningless (or silently wrong) once the
        // tessellation kind changes, same rationale as `presetSplitPoints` above.
        splitPatterns: [] as SplitPattern[],
      } : { debugStale: debugStaleOf(state) }),
      presetsDirty: false,
      mazeDirty: false,
      postEditDirty: false,
    };
  }),

  setTessellationKind: (kind) => set((state) => {
    if (kind === state.tessellationKind) return {};
    const freshField = defaultFloorFieldConfig(kind, state.hexOrientation, state.triOrientation);
    // Kind is maze-wide — every floor's per-kind field config is meaningless once it changes
    // (same rationale confirmTessellation's kind-change branch already applies).
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const floorId of Object.keys(state.floorFields)) floorFields[floorId] = freshField;
    return {
      tessellationKind: kind,
      floorFields,
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
    };
  }),

  setHexOrientation: (orientation) => set(makeOrientationSetter("hex", "hexOrientation")(orientation)),
  setTriOrientation: (orientation) => set(makeOrientationSetter("triangle", "triOrientation")(orientation)),

  setShowFieldOverlay: (show) => set({ showFieldOverlay: show }),
  setShowFieldOrigin: (show) => set({ showFieldOrigin: show }),
});
