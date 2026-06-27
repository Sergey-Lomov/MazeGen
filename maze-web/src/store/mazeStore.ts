import { create } from "zustand";
import { decodePoint } from "../pixi/tessellationProjection";
import type { MazeStore, MazeState } from "./storeTypes";
import { createTessellationSlice } from "./slices/tessellationSlice";
import { createPresetConnectionsSlice } from "./slices/presetConnectionsSlice";
import { createGenerationSlice, generateWithSeed } from "./slices/generationSlice";
import { createAnalyticsOverlaySlice } from "./slices/analyticsOverlaySlice";
import { createPostEditSlice } from "./slices/postEditSlice";
import { buildPreviewState, buildResetMazeState, deriveTessellationFromConfig, recomputeAutoLock } from "./storeHelpers";

export type {
  PostEditEdgeKind, PostEditTool, PostEditEdge, PostEditMeta, PostEditAnalytics,
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
      // quality
      selectedChecks: file.quality.selectedChecks,
      rules: file.quality.rules,
      checkParams: file.quality.checkParams,
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
      // reset maze state — will be populated by generate below
      ...buildResetMazeState(),
      generationStatus: "idle" as const,
      postEditAutoConfirm: file.ui.postEditAutoConfirm,
      postEditDraftEdges: null,
      postEditDraftMeta: null,
      postEditEdges: null,
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
      showDebugFrontier: file.debug.showDebugFrontier,
      debugAutoPlayDelay: file.debug.debugAutoPlayDelay,
      debugSnapshot: null,
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

    // Generate maze with saved seed (deterministic) — generateWithSeed reads debugMode from store
    // skipConfirmPostEdit=true to avoid double confirmPostEdit (we call it ourselves below)
    set({ lastUsedSeed: file.generation.seed });
    generateWithSeed(file.generation.seed, get, set, true);

    // Only proceed with post-edit and analytics if generation succeeded
    if (get().generationStatus !== "done") return;

    // After generation: if postEdit was saved, restore it over the generated draft
    if (file.postEdit !== null) {
      set({
        postEditDraftEdges: Object.fromEntries(file.postEdit.edges),
        postEditDraftMeta: file.postEdit.meta,
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

    // If debug mode: restore the saved step clamped to actual snapshot length
    if (file.debug.debugMode) {
      const snap = get().debugSnapshot;
      const maxStep = snap ? snap.steps.length - 1 : 0;
      set({ debugStep: Math.min(file.debug.debugStep, maxStep) });
    }
  },
}));
