import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { PostEditEdge, MazeState } from "../mazeStore";
import { selectPostEditDirty } from "../../pixi/selectors/mazeSelectors";
import { CURRENT_VERSION, type ProjectFile, type ProjectFilePostEdit } from "./types";

export function serializeProject(state: MazeState): ProjectFile {
  const postEdit: ProjectFilePostEdit | null = selectPostEditDirty(state)
    ? {
        edges: Object.entries(state.postEditDraftEdges ?? {}) as [string, PostEditEdge][],
        meta: state.postEditDraftMeta,
        teleports: state.postEditDraftTeleports,
      }
    : null;

  return {
    version: CURRENT_VERSION,
    tessellation: {
      config: state.tessellationConfig,
      savedConfigs: Object.values(state.savedConfigs) as TessellationConfig[],
    },
    generation: {
      seed: state.seed,
      randomSeed: state.randomSeed,
      initial: state.initialConfig,
      elements: state.elementsConfig,
      qcExperiment: state.qcExperiment,
    },
    quality: {
      // `nextLocalCheckId` deliberately omitted — recomputed on load, see CheckInstance's doc
      // comment in storeTypes.ts.
      rules: state.rules.map(({ nextLocalCheckId: _nextLocalCheckId, ...rule }) => rule),
      stages: state.stages,
      strategyParams: state.strategyParams,
      repairMaxIterations: state.repairMaxIterations,
      repairTimeBudgetSecs: state.repairTimeBudgetSecs,
    },
    presets: {
      connections: Array.from(state.presetConnections.entries()),
      lockedNodes: Array.from(state.lockedNodes.entries()),
      defaultEdgeState: state.defaultEdgeState,
      autoLock: state.autoLock,
      start: state.presetStart,
      finish: state.presetFinish,
      genSource: state.presetGenSource,
      teleports: state.presetTeleports,
    },
    postEdit,
    dirtyFlags: {
      postEdit: state.postEditDirty,
      field: state.fieldDirty,
      presets: state.presetsDirty,
      maze: state.mazeDirty,
    },
    analytics: {
      showMazeOverlay: state.showMazeOverlay,
      showComponentsOverlay: state.showComponentsOverlay,
      showGraphOverlay: state.showGraphOverlay,
      showNavGraphOverlay: state.showNavGraphOverlay,
      showPureCyclesOverlay: state.showPureCyclesOverlay,
      showRouteOverlay: state.showRouteOverlay,
      showRegionClassesOverlay: state.showRegionClassesOverlay,
      sectionsExpanded: state.analyticsSectionsExpanded,
    },
    debug: {
      debugMode: state.debugMode,
      showDebugFrontier: state.showDebugFrontier,
      debugStep: state.debugStep,
      debugAutoPlayDelay: state.debugAutoPlayDelay,
    },
    ui: {
      showPresetOrigin: state.showPresetOrigin,
      showFieldOrigin: state.showFieldOrigin,
      openCard: state.openCard,
      postEditAutoConfirm: state.postEditAutoConfirm,
    },
  };
}

export function downloadProjectFile(state: MazeState): void {
  const data = serializeProject(state);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "maze-project.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
