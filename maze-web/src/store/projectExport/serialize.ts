import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { MazeState } from "../mazeStore";
import { selectPostEditDirty } from "../../pixi/selectors/mazeSelectors";
import { CURRENT_VERSION, type ProjectFile, type ProjectFilePostEdit, type ProjectFileFloorField } from "./types";
import { decodePoint } from "../../pixi/tessellationProjection";
import { linksMatchDefaults } from "../slices/parameterLinksEngine";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../slices/parameterLinksDefaults";

export function serializeProject(state: MazeState): ProjectFile {
  const postEdit: ProjectFilePostEdit | null = selectPostEditDirty(state)
    ? {
        commands: state.postEditCommands,
        nextTeleportId: state._nextPostEditTeleportId,
        nextVerticalPassageId: state._nextPostEditVerticalPassageId,
        nextElevatorId: state._nextPostEditElevatorId,
        nextSplitSlotId: state._nextSplitSlotId,
        nextSplitPointId: state._nextPostEditSplitPointId,
      }
    : null;

  const floorFields: Record<string, ProjectFileFloorField> = {};
  for (const [floorId, f] of Object.entries(state.floorFields)) {
    const freeFieldPoints: ProjectFileFloorField["freeFieldPoints"] = {
      square: Array.from(f.freeFieldPoints.square).map((k) => decodePoint(k) as [number, number]),
      hex: Array.from(f.freeFieldPoints.hex).map((k) => decodePoint(k) as [number, number]),
      triangle: Array.from(f.freeFieldPoints.triangle).map((k) => decodePoint(k) as [number, number]),
    };
    floorFields[floorId] = {
      config: f.tessellationConfig,
      savedConfigs: Object.values(f.savedConfigs) as TessellationConfig[],
      freeFieldPoints,
      fieldEditMode: f.fieldEditMode,
    };
  }

  return {
    version: CURRENT_VERSION,
    tessellation: {
      kind: state.tessellationKind,
      hexOrientation: state.hexOrientation,
      triOrientation: state.triOrientation,
    },
    floorFields,
    generation: {
      seed: state.seed,
      randomSeed: state.randomSeed,
      initial: state.initialConfig,
      elements: state.elementsConfig,
      splitGeneration: {
        patternMode: state.splitPatternMode,
        maxSplitNodes: state.splitMaxNodes,
        patterns: state.splitPatterns,
      },
      qcExperiment: state.qcExperiment,
      vertexSettingsPanelOpen: state.vertexSettingsPanelOpen,
      seedHistory: state.seedHistory,
      seedHistoryIndex: state.seedHistoryIndex,
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
      generationSourceMode: state.generationSourceMode,
      teleports: state.presetTeleports,
      verticalPassages: state.presetVerticalPassages,
      elevators: state.presetElevators,
      splitPoints: state.presetSplitPoints,
      splitPointIds: state.presetSplitPointIds,
      entityOrder: state.presetEntityOrder,
    },
    postEdit,
    dirtyFlags: {
      postEdit: state.postEditDirty,
      field: Object.values(state.floorFields).some((f) => f.fieldDirty),
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
      debugStep: state.debugStep,
      debugAutoPlayDelay: state.debugAutoPlayDelay,
    },
    ui: {
      showPresetOrigin: state.showPresetOrigin,
      showPresetLocks: state.showPresetLocks ?? true,
      showFieldOrigin: state.showFieldOrigin,
      openCard: state.openCard,
      postEditAutoConfirm: state.postEditAutoConfirm,
    },
    imageExport: {
      activeRenderMode: state.activeRenderMode,
      openRenderModeSettings: state.openRenderModeSettings,
      vectorByWallsSettings: state.vectorByWallsSettings,
      vectorByWallsSectionsExpanded: state.vectorByWallsSectionsExpanded,
      showColorWarnings: state.showColorWarnings,
      linkIconVisibility: state.linkIconVisibility,
      vectorByCorridorsSettings: state.vectorByCorridorsSettings,
      vectorByCorridorsSectionsExpanded: state.vectorByCorridorsSectionsExpanded,
      pngExportSettings: state.pngExportSettings,
      vectorByWallsLinks: linksMatchDefaults(state.vectorByWallsSettings.links, DEFAULT_VECTOR_BY_WALLS_LINKS) ? null : state.vectorByWallsSettings.links,
      vectorByCorridorsLinks: linksMatchDefaults(state.vectorByCorridorsSettings.links, DEFAULT_VECTOR_BY_CORRIDORS_LINKS) ? null : state.vectorByCorridorsSettings.links,
    },
    floors: {
      floors: state.floors,
      nextFloorNumber: state.nextFloorNumber,
      activeFloorId: state.activeFloorId,
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
