import { create } from "zustand";
import { decodePoint, encodePoint } from "../pixi/tessellationProjection";
import type { MazeStore, MazeState } from "./storeTypes";
import { createTessellationSlice } from "./slices/tessellationSlice";
import { createFloorFieldSlice } from "./slices/floorFieldSlice";
import { createPresetConnectionsSlice } from "./slices/presetConnectionsSlice";
import { createGenerationSlice, generateWithSeed } from "./slices/generationSlice";
import { createAnalyticsOverlaySlice } from "./slices/analyticsOverlaySlice";
import { createPostEditSlice } from "./slices/postEditSlice";
import { createImageExportSlice } from "./slices/imageExportSlice";
import { createFloorsSlice } from "./slices/floorsSlice";
import { buildPreviewState, buildResetMazeState, deriveEditState, kindAndShapeFromConfig, recomputeAutoLock } from "./storeHelpers";
import type { FloorFieldConfig } from "./storeTypes";
import { warmCartesianCache } from "../pixi/cartesianCache";

export type {
  PostEditEdgeKind, PostEditTool, PostEditEdge, PostEditMeta, PostEditAnalytics,
  PostEditTeleportDirection, PostEditTeleportEntry, PostEditTeleportEndpointHit,
  PostEditVerticalPassageDirection, PostEditVerticalPassageEntry, PostEditVerticalPassageEndpointHit, PostEditElevatorEntry,
  TessellationKind, SquareShape, HexShape, TriangleShape, HexOrientation, TriOrientation,
  FieldPrimitive, FeatureId, RenderModeId, ExportFormatId, MazeState,
  PngExportOutputMode, PngCanvasMode, PrintDensity, PaperSize, PaperOrientation, PrintAnchor,
  DigitalExportSettings, PrintExportSettings, PngExportSettings, FloorState,
} from "./storeTypes";

export { decodePoint };

export const useMazeStore = create<MazeStore>()((...a) => ({
  ...createTessellationSlice(...a),
  ...createFloorFieldSlice(...a),
  ...createPresetConnectionsSlice(...a),
  ...createGenerationSlice(...a),
  ...createAnalyticsOverlaySlice(...a),
  ...createPostEditSlice(...a),
  ...createImageExportSlice(...a),
  ...createFloorsSlice(...a),

  loadProject: (file) => {
    const [set, get] = a;
    const { kind, hexOrientation, triOrientation } = file.tessellation;
    const previewState = buildPreviewState(kind, hexOrientation, triOrientation);

    // Build each floor's own FloorFieldConfig (GitHub issue #338) — mirrors deriveTessellationFromConfig's
    // per-config derivation, applied per floor instead of once maze-wide.
    const floorFields: Record<string, FloorFieldConfig> = {};
    for (const floor of file.floors.floors) {
      const ff = file.floorFields[floor.id];
      const { squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(ff.config);
      const freeFieldPoints = {
        square: new Set(ff.freeFieldPoints.square.map(([x, y]) => encodePoint(x, y))),
        hex: new Set(ff.freeFieldPoints.hex.map(([x, y]) => encodePoint(x, y))),
        triangle: new Set(ff.freeFieldPoints.triangle.map(([x, y]) => encodePoint(x, y))),
      };
      const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
      floorFields[floor.id] = {
        squareShape, hexShape, triangleShape,
        savedConfigs: Object.fromEntries(ff.savedConfigs.map((c) => [c.type, c])),
        tessellationConfig: ff.config,
        freeFieldPoints,
        isEditingField,
        fieldPoints,
        fieldEditMode: ff.fieldEditMode,
        fieldPrimitive: "point",
        fieldDirty: file.dirtyFlags.field,
      };
    }
    const activeFloorId = file.floors.floors[0].id;
    const activeField = floorFields[activeFloorId];
    const cfg = activeField.tessellationConfig;

    // Recompute auto-locked nodes against the active floor's own field.
    const restoredPresetConnections = new Map(file.presets.connections);
    const autoLockedNodes = recomputeAutoLock({
      autoLock: file.presets.autoLock,
      activeFloorId,
      floors: file.floors.floors,
      floorFields,
      tessellationKind: kind,
      hexOrientation,
      triOrientation,
      presetConnections: restoredPresetConnections,
      presetSplitPoints: file.presets.splitPoints,
    } as MazeState);

    // Single atomic set of all non-maze state
    warmCartesianCache(cfg);
    set({
      // tessellation
      tessellationKind: kind,
      hexOrientation,
      triOrientation,
      floorFields,
      activeTessellationConfig: cfg,
      tessellationConfirmed: true,
      ...previewState,
      // generation settings (seed used below for generate call)
      seed: file.generation.seed,
      randomSeed: file.generation.randomSeed,
      initialConfig: file.generation.initial,
      elementsConfig: file.generation.elements,
      splitPatternMode: file.generation.splitGeneration.patternMode,
      splitMaxNodes: file.generation.splitGeneration.maxSplitNodes,
      splitPatterns: file.generation.splitGeneration.patterns,
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
      presetVerticalPassages: file.presets.verticalPassages,
      presetVerticalPassagePending: null,
      _nextPresetVerticalPassageId: file.presets.verticalPassages.length === 0
        ? 1
        : Math.max(...file.presets.verticalPassages.map((p) => p.id)) + 1,
      presetElevators: file.presets.elevators,
      presetElevatorPending: null,
      _nextPresetElevatorId: file.presets.elevators.length === 0
        ? 1
        : Math.max(...file.presets.elevators.map((e) => e.id)) + 1,
      presetSplitPoints: file.presets.splitPoints,
      presetActiveSplitNode: {},
      presetFocusedPoint: null,
      // reset maze state — will be populated by generate below
      ...buildResetMazeState(),
      generationStatus: "idle" as const,
      postEditAutoConfirm: file.ui.postEditAutoConfirm,
      postEditDraftEdges: null,
      postEditDraftTeleports: [],
      postEditTeleportPendingFrom: null,
      _nextPostEditTeleportId: 1,
      postEditDraftMeta: null,
      postEditDraftSplitPoints: {},
      postEditActiveSplitNode: {},
      postEditFocusedPoint: null,
      postEditEdges: null,
      postEditTeleportEdges: [],
      postEditMeta: null,
      postEditAnalytics: null,
      postEditTool: "wall" as const,
      postEditDirty: file.dirtyFlags.postEdit,
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
      highlightOrphanSplitNodes: false,
      error: null,
      // image export (GitHub issue #295) — buildResetMazeState() above resets these to their
      // defaults; restore the saved values on top.
      activeRenderMode: file.imageExport.activeRenderMode,
      openRenderModeSettings: file.imageExport.openRenderModeSettings,
      vectorByWallsSettings: file.imageExport.vectorByWallsSettings,
      vectorByWallsSectionsExpanded: file.imageExport.vectorByWallsSectionsExpanded,
      vectorByCorridorsSettings: file.imageExport.vectorByCorridorsSettings,
      vectorByCorridorsSectionsExpanded: file.imageExport.vectorByCorridorsSectionsExpanded,
      pngExportSettings: file.imageExport.pngExportSettings,
      // floors
      floors: file.floors.floors,
      nextFloorNumber: file.floors.nextFloorNumber,
      activeFloorId: file.floors.floors[0].id,
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
        // Defaults to {} for project files saved before split points existed (GitHub issue #221).
        // No separate slotId counter to restore — addSplitNode computes the next slotId on the
        // fly from the max of each point's existing slotIds (see postEditSlice.ts).
        postEditDraftSplitPoints: file.postEdit.splitPoints ?? {},
        // Ephemeral UI selection, never persisted — always starts fresh on load.
        postEditActiveSplitNode: {},
        postEditEdges: null,
        postEditMeta: null,
        postEditAnalytics: null,
        // Defaults to [] for project files saved before post-edit vertical passages/elevators
        // existed (GitHub issue #341).
        postEditDraftVerticalPassages: file.postEdit.verticalPassages ?? [],
        _nextPostEditVerticalPassageId: !file.postEdit.verticalPassages || file.postEdit.verticalPassages.length === 0
          ? 1
          : Math.max(...file.postEdit.verticalPassages.map((p) => p.id)) + 1,
        postEditDraftElevators: file.postEdit.elevators ?? [],
        _nextPostEditElevatorId: !file.postEdit.elevators || file.postEdit.elevators.length === 0
          ? 1
          : Math.max(...file.postEdit.elevators.map((e) => e.id)) + 1,
        postEditSuppressedElevatorPairs: new Set(file.postEdit.suppressedElevatorPairs ?? []),
        postEditSuppressedVerticalPassagePairs: new Set(file.postEdit.suppressedVerticalPassagePairs ?? []),
      });
    }

    // Restore dirty flags — generateWithSeed resets them, but saved values take precedence
    set((state) => ({
      postEditDirty: file.dirtyFlags.postEdit,
      floorFields: Object.fromEntries(
        Object.entries(state.floorFields).map(([id, f]) => [id, { ...f, fieldDirty: file.dirtyFlags.field }]),
      ),
      presetsDirty: file.dirtyFlags.presets,
      mazeDirty: file.dirtyFlags.maze,
    }));

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
