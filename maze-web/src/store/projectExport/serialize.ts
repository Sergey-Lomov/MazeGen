import type { MazeState } from "../mazeStore";
import { selectPostEditDirty } from "../../pixi/selectors/mazeSelectors";
import { CURRENT_VERSION, PROJECT_FILE_EXTENSION, type ProjectFile, type ProjectFilePostEdit, type ProjectFileFloorField, type ProjectFileImageExport, type ProjectFileQuality } from "./types";
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
      tri: Array.from(f.freeFieldPoints.tri).map((k) => decodePoint(k) as [number, number]),
      cairo: Array.from(f.freeFieldPoints.cairo ?? []).map((k) => decodePoint(k) as [number, number]),
      square_octagon: Array.from(f.freeFieldPoints.square_octagon ?? []).map((k) => decodePoint(k) as [number, number]),
      brick: Array.from(f.freeFieldPoints.brick ?? []).map((k) => decodePoint(k) as [number, number]),
      trihexagonal: Array.from(f.freeFieldPoints.trihexagonal ?? []).map((k) => decodePoint(k) as [number, number]),
      snub_hexagonal: Array.from(f.freeFieldPoints.snub_hexagonal ?? []).map((k) => decodePoint(k) as [number, number]),
    };
    floorFields[floorId] = {
      shape: f.fieldConfig.shape,
      savedShapes: Object.values(f.savedShapes),
      freeFieldPoints,
      fieldEditMode: f.fieldEditMode,
    };
  }

  return {
    version: CURRENT_VERSION,
    tessellation: {
      kind: state.tessellationKind,
      params: {},
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
    quality: serializeQuality(state),
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
    showBackgroundImage: state.showBackgroundImage ?? false,
    backgroundImage: state.backgroundImage == null
      ? null
      : {
          ...state.backgroundImage,
          cropX: state.backgroundImage.cropX ?? 0,
          cropY: state.backgroundImage.cropY ?? 0,
          cropWidth: state.backgroundImage.cropWidth ?? state.backgroundImage.naturalWidth,
          cropHeight: state.backgroundImage.cropHeight ?? state.backgroundImage.naturalHeight,
          layer: state.backgroundImage.layer ?? "below_grid",
          opacity: state.backgroundImage.opacity ?? 0.5,
        },
    backgroundImageManualPositioning: state.backgroundImageManualPositioning ?? false,
    backgroundImageCropping: state.backgroundImageCropping ?? false,
    imageExport: serializeImageExport(state),
    floors: {
      floors: state.floors,
      nextFloorNumber: state.nextFloorNumber,
      activeFloorId: state.activeFloorId,
    },
  };
}

export function serializeQuality(state: MazeState): ProjectFileQuality {
  return {
    // `nextLocalCheckId` deliberately omitted — recomputed on load, see CheckInstance's doc
    // comment in storeTypes.ts.
    rules: state.rules.map(({ nextLocalCheckId: _nextLocalCheckId, ...rule }) => rule),
    stages: state.stages,
    strategyParams: state.strategyParams,
    repairMaxIterations: state.repairMaxIterations,
    repairTimeBudgetSecs: state.repairTimeBudgetSecs,
  };
}

export function serializeImageExport(state: MazeState): ProjectFileImageExport {
  return {
    activeRenderMode: state.activeRenderMode,
    openRenderModeSettings: state.openRenderModeSettings,
    vectorByWallsSettings: state.vectorByWallsSettings,
    vectorByWallsSectionsExpanded: state.vectorByWallsSectionsExpanded,
    showColorWarnings: state.showColorWarnings,
    linkIconVisibility: state.linkIconVisibility,
    vectorByCorridorsSettings: state.vectorByCorridorsSettings,
    vectorByCorridorsSectionsExpanded: state.vectorByCorridorsSectionsExpanded,
    pngExportSettings: state.pngExportSettings,
    floorLabelModeChosen: state.floorLabelModeChosen,
    vectorByWallsLinks: linksMatchDefaults(state.vectorByWallsSettings.links, DEFAULT_VECTOR_BY_WALLS_LINKS) ? null : state.vectorByWallsSettings.links,
    vectorByCorridorsLinks: linksMatchDefaults(state.vectorByCorridorsSettings.links, DEFAULT_VECTOR_BY_CORRIDORS_LINKS) ? null : state.vectorByCorridorsSettings.links,
  };
}

/** Downloads `data` as pretty-printed JSON under `fileName`. Neutral MIME type: with
 *  `application/json` some browsers (Safari, mobile) append `.json` to the name, and the resulting
 *  `.maze.json`/`.mazestyle.json`/`.mazequality.json` file no longer passes the load dialog's extension filter. */
export function downloadJsonFile(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadProjectFile(state: MazeState): void {
  downloadJsonFile(serializeProject(state), `maze-project${PROJECT_FILE_EXTENSION}`);
}
