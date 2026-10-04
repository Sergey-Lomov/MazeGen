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
import { resolveFieldConfig } from "../pixi/tessellationCells";
import { replayPostEditCommandsFailClosed } from "../pixi/postEditReplay";
import { derivedStateToLegacyFields as legacyFieldsFor, nextPostEditIdCounters, nextSplitSlotIdCounters } from "./slices/postEditSliceHelpers";

export type {
  PostEditEdgeKind, PostEditTool, PostEditEdge, PostEditMeta, PostEditAnalytics,
  PostEditTeleportDirection, PostEditTeleportEntry, PostEditTeleportEndpointHit,
  PostEditVerticalPassageDirection, PostEditVerticalPassageEntry, PostEditVerticalPassageEndpointHit, PostEditElevatorEntry,
  PostEditElevatorEndpointHit, PostEditVerticalDragFailure,
  TessellationKind, SquareShape, HexShape, TriangleShape, HexOrientation, TriOrientation,
  FieldPrimitive, FieldOperation, FeatureId, RenderModeId, LinkIconVisibility, ExportFormatId, MazeState,
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
        fieldOperation: "add",
        fieldPrimitive: "point",
        fieldDirty: file.dirtyFlags.field,
      };
    }
    const activeFloorId = file.floors.activeFloorId;
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
      activeTessellationConfig: resolveFieldConfig(cfg),
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
      vertexSettingsPanelOpen: file.generation.vertexSettingsPanelOpen,
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
      // `validate.ts` already resolves a missing field to "default" (never "random") for project
      // files predating GitHub issue #640, so opening an old project never silently changes its
      // reproducibility.
      generationSourceMode: file.presets.generationSourceMode,
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
      presetSplitTargetPrompt: null,
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
      showPresetLocks: file.ui.showPresetLocks,
      showPresetLocksBeforeLockTool: null,
      showFieldOrigin: file.ui.showFieldOrigin,
      showPrimitiveFrame: true,
      smoothPrimitives: true,
      symmetrySnapMode: "centers",
      symmetryScope: "one_side",
      symmetryAxisPoints: [],
      symmetrySourceSide: 1,
      symmetryPolygon: [],
      symmetryPolygonFinished: false,
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
      showColorWarnings: file.imageExport.showColorWarnings,
      linkIconVisibility: file.imageExport.linkIconVisibility,
      vectorByCorridorsSettings: file.imageExport.vectorByCorridorsSettings,
      vectorByCorridorsSectionsExpanded: file.imageExport.vectorByCorridorsSectionsExpanded,
      pngExportSettings: file.imageExport.pngExportSettings,
      // floors
      floors: file.floors.floors,
      nextFloorNumber: file.floors.nextFloorNumber,
      activeFloorId,
    });

    // Generate maze with saved seed (deterministic) — generateWithSeed reads debugMode from store.
    // Its own post-edit fields (filled from the fresh generation snapshot) get overwritten below
    // if a saved postEdit exists, then confirmPostEdit recomputes analytics over the restored
    // state either way (see the final confirmPostEdit call below).
    set({ lastUsedSeed: file.generation.seed });
    generateWithSeed(file.generation.seed, get, set, file.generation.qcExperiment);

    // Only proceed with post-edit and analytics if generation succeeded
    if (get().generationStatus !== "done") return;

    // After generation: if postEdit was saved, replay it over the freshly-built baseline
    // (GitHub issue #543) — fail-closed: if a single command doesn't resolve (corrupted file, or a
    // baseline that no longer matches because generation isn't actually deterministic for this
    // config), the *entire* section is rejected, high-water marks included, rather than partially
    // applying a corrupted log or restoring counters detached from the log they belong to (see
    // `ProjectFilePostEdit`'s own doc comment). Rejected: maze stays in the clean post-generation
    // state `generateWithSeed` above already produced, identical to `file.postEdit === null`.
    if (file.postEdit !== null) {
      const baseline = get().postEditBaseline;
      const derived = baseline !== null ? replayPostEditCommandsFailClosed(baseline, file.postEdit.commands) : undefined;
      if (baseline !== null && derived !== undefined) {
        // Load-time high-water-mark normalization (GitHub issue #564 second follow-up): a saved
        // counter is trusted only as a FLOOR, never verbatim — `nextPostEditIdCounters(derived)`
        // recomputes each category's minimum-safe next id from the just-replayed baseline+log state
        // itself (an id can be minted by the log past whatever the baseline alone occupied), and the
        // higher of the two wins. Guards against a hand-edited or stale file whose counter is lower
        // than an id the (successfully replayed) log already uses — replay only checks a command's
        // own resolvability, never cross-checks it against the file's separately-stored counters, so
        // a too-low saved counter would otherwise mint a colliding id on the very next edit.
        const minCounters = nextPostEditIdCounters(derived);
        // `_nextSplitSlotId` (GitHub issue #569, same floor reasoning as `minCounters` above): a
        // saved file predating this fix can carry an empty/incomplete `nextSplitSlotId` map for a
        // generation-baked split point that was never opened in the dialog before saving — merged
        // per-key against `nextSplitSlotIdCounters(derived.splitPoints)` so the floor always covers
        // every slot the replayed derived state actually has, not just what the file happened to
        // record.
        const minSplitSlotIds = nextSplitSlotIdCounters(derived.splitPoints);
        const nextSplitSlotId: Record<string, number> = { ...file.postEdit.nextSplitSlotId };
        for (const [key, minValue] of Object.entries(minSplitSlotIds)) {
          nextSplitSlotId[key] = Math.max(nextSplitSlotId[key] ?? 0, minValue);
        }
        set({
          postEditCommands: file.postEdit.commands,
          postEditDerived: derived,
          ...legacyFieldsFor(derived),
          // Ephemeral UI selection, never persisted — always starts fresh on load.
          postEditActiveSplitNode: {},
          postEditEdges: null,
          postEditMeta: null,
          postEditAnalytics: null,
          _nextPostEditTeleportId: Math.max(file.postEdit.nextTeleportId, minCounters._nextPostEditTeleportId),
          _nextPostEditVerticalPassageId: Math.max(file.postEdit.nextVerticalPassageId, minCounters._nextPostEditVerticalPassageId),
          _nextPostEditElevatorId: Math.max(file.postEdit.nextElevatorId, minCounters._nextPostEditElevatorId),
          _nextSplitSlotId: nextSplitSlotId,
          _nextPostEditSplitPointId: Math.max(file.postEdit.nextSplitPointId, minCounters._nextPostEditSplitPointId),
        });
      } else {
        console.error("Post-edit section rejected: command log doesn't resolve against the regenerated maze; discarding saved post-edit state.");
      }
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
