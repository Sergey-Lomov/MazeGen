import { create } from "zustand";
import { decodePoint } from "../pixi/tessellationProjection";
import type { MazeStore, MazeState } from "./storeTypes";
import { createTessellationSlice } from "./slices/tessellationSlice";
import { createPresetConnectionsSlice } from "./slices/presetConnectionsSlice";
import { createGenerationSlice, generateWithSeed } from "./slices/generationSlice";
import { createAnalyticsOverlaySlice } from "./slices/analyticsOverlaySlice";
import { createPostEditSlice } from "./slices/postEditSlice";
import { buildPreviewState, buildResetMazeState, deriveTessellationFromConfig, recomputeAutoLock } from "./storeHelpers";
import { warmCartesianCache } from "../pixi/cartesianCache";

export type {
  PostEditEdgeKind, PostEditTool, PostEditEdge, PostEditMeta, PostEditAnalytics,
  PostEditTeleportDirection, PostEditTeleportEntry, PostEditTeleportEndpointHit,
  TessellationKind, SquareShape, HexShape, TriangleShape, HexOrientation, TriOrientation,
  FieldPrimitive, FeatureId, MazeState,
} from "./storeTypes";

export { decodePoint };

export const useMazeStore = create<MazeStore>()((...a) => ({
  ...createTessellationSlice(...a),
  ...createPresetConnectionsSlice(...a),
  ...createGenerationSlice(...a),
  ...createAnalyticsOverlaySlice(...a),
  ...createPostEditSlice(...a),

  loadProject: (file) => {
    const [set, get] = a;
    const cfg = file.tessellation.config;

    // Derive all tessellation fields (same logic as setTessellationConfig)
    const restoredSavedConfigs: Partial<Record<import("../fieldConfig").FieldConfig["type"], import("../fieldConfig").FieldConfig>> =
      Object.fromEntries(file.tessellation.savedConfigs.map(c => [c.type, c]));
    const { kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, isCustom: isCustomConfig } =
      deriveTessellationFromConfig(cfg, get().hexOrientation, get().triOrientation, get().freeFieldPoints, restoredSavedConfigs);
    const previewState = buildPreviewState(kind, hexOrientation, triOrientation);

    // Recompute auto-locked nodes
    const restoredPresetConnections = new Map(file.presets.connections);
    const autoLockedNodes = recomputeAutoLock({
      autoLock: file.presets.autoLock,
      isEditingField,
      tessellationKind: kind,
      fieldPoints,
      hexOrientation,
      triOrientation,
      tessellationConfig: cfg,
      presetConnections: restoredPresetConnections,
    } as MazeState);

    // Single atomic set of all non-maze state
    warmCartesianCache(cfg);
    set({
      // tessellation
      tessellationConfig: cfg,
      tessellationKind: kind,
      squareShape,
      hexShape,
      triangleShape,
      hexOrientation,
      triOrientation,
      freeFieldPoints,
      isEditingField,
      fieldPoints,
      savedConfigs,
      activeTessellationConfig: cfg,
      tessellationConfirmed: true,
      fieldEditMode: isCustomConfig ? "custom" : "default",
      fieldPrimitive: "point",
      ...previewState,
      // generation settings (seed used below for generate call)
      seed: file.generation.seed,
      randomSeed: file.generation.randomSeed,
      initialConfig: file.generation.initial,
      elementsConfig: file.generation.elements,
      qcExperiment: file.generation.qcExperiment,
      lastUsedQcExperiment: file.generation.qcExperiment,
      seedHistory: file.generation.seedHistory,
      seedHistoryIndex: file.generation.seedHistoryIndex,
      seedAttachedToHistory: file.generation.seedHistory.length > 0
        && file.generation.seedHistory[file.generation.seedHistoryIndex] === file.generation.seed,
      // quality
      // nextLocalCheckId recomputed below, not stored in the project file — see CheckInstance's
      // doc comment in storeTypes.ts.
      rules: file.quality.rules.map((rule) => ({
        ...rule,
        nextLocalCheckId: rule.checks.length === 0 ? 0 : Math.max(...rule.checks.map((c) => c.localId)) + 1,
      })),
      stages: file.quality.stages,
      strategyParams: file.quality.strategyParams,
      repairMaxIterations: file.quality.repairMaxIterations,
      repairTimeBudgetSecs: file.quality.repairTimeBudgetSecs,
      // presets
      presetConnections: restoredPresetConnections,
      lockedNodes: new Map(file.presets.lockedNodes),
      defaultEdgeState: file.presets.defaultEdgeState,
      autoLock: file.presets.autoLock,
      autoLockedNodes,
      presetStart: file.presets.start,
      presetFinish: file.presets.finish,
      presetGenSource: file.presets.genSource,
      presetTeleports: file.presets.teleports,
      presetTeleportPendingFrom: null,
      _nextPresetTeleportId: file.presets.teleports.length === 0
        ? 1
        : Math.max(...file.presets.teleports.map((t) => t.id)) + 1,
      // reset maze state — will be populated by generate below
      ...buildResetMazeState(),
      generationStatus: "idle" as const,
      postEditAutoConfirm: file.ui.postEditAutoConfirm,
      postEditDraftEdges: null,
      postEditDraftTeleports: [],
      postEditTeleportPendingFrom: null,
      _nextPostEditTeleportId: 1,
      postEditDraftMeta: null,
      postEditEdges: null,
      postEditTeleportEdges: [],
      postEditMeta: null,
      postEditAnalytics: null,
      postEditTool: "wall" as const,
      postEditDirty: file.dirtyFlags.postEdit,
      fieldDirty: file.dirtyFlags.field,
      presetsDirty: file.dirtyFlags.presets,
      mazeDirty: file.dirtyFlags.maze,
      _generatedStart: null,
      _generatedFinish: null,
      _postEditRequestId: 0,
      showMaze: true,
      // analytics overlays
      showMazeOverlay: file.analytics.showMazeOverlay,
      showComponentsOverlay: file.analytics.showComponentsOverlay,
      showGraphOverlay: file.analytics.showGraphOverlay,
      showNavGraphOverlay: file.analytics.showNavGraphOverlay,
      showPureCyclesOverlay: file.analytics.showPureCyclesOverlay,
      showRouteOverlay: file.analytics.showRouteOverlay,
      showRegionClassesOverlay: file.analytics.showRegionClassesOverlay,
      analyticsSectionsExpanded: file.analytics.sectionsExpanded,
      // debug settings
      debugMode: file.debug.debugMode,
      debugAutoPlayDelay: file.debug.debugAutoPlayDelay,
      debugArena: null,
      debugStep: 0,
      debugStale: false,
      // ui
      showPresetOrigin: file.ui.showPresetOrigin,
      showFieldOrigin: file.ui.showFieldOrigin,
      openCard: file.ui.openCard,
      // clear transient UI flags
      highlightInvalidPresets: false,
      highlightIsolatedNodes: false,
      error: null,
    });

    // Generate maze with saved seed (deterministic) — generateWithSeed reads debugMode from store.
    // Its own post-edit fields (filled from the fresh generation snapshot) get overwritten below
    // if a saved postEdit exists, then confirmPostEdit recomputes analytics over the restored
    // state either way (see the final confirmPostEdit call below).
    set({ lastUsedSeed: file.generation.seed });
    generateWithSeed(file.generation.seed, get, set, file.generation.qcExperiment);

    // Only proceed with post-edit and analytics if generation succeeded
    if (get().generationStatus !== "done") return;

    // After generation: if postEdit was saved, restore it over the generated draft
    if (file.postEdit !== null) {
      set({
        postEditDraftEdges: Object.fromEntries(file.postEdit.edges),
        postEditDraftMeta: file.postEdit.meta,
        postEditDraftTeleports: file.postEdit.teleports,
        _nextPostEditTeleportId: file.postEdit.teleports.length === 0
          ? 1
          : Math.max(...file.postEdit.teleports.map((t) => t.id)) + 1,
        postEditEdges: null,
        postEditMeta: null,
        postEditAnalytics: null,
      });
    }

    // Restore dirty flags — generateWithSeed resets them, but saved values take precedence
    set({
      postEditDirty: file.dirtyFlags.postEdit,
      fieldDirty: file.dirtyFlags.field,
      presetsDirty: file.dirtyFlags.presets,
      mazeDirty: file.dirtyFlags.maze,
    });

    // confirmPostEdit to compute analytics over restored state
    void get().confirmPostEdit();

    // If debug mode: restore the saved step, clamped to the freshly (re)generated arena's range —
    // generateWithSeed above already set debugStep to the last step of the new run.
    if (file.debug.debugMode) {
      const maxStep = get().debugStep;
      set({ debugStep: Math.min(file.debug.debugStep, maxStep) });
    }
  },
}));
