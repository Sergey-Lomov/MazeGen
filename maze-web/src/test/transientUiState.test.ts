import { describe, expect, it } from "vitest";
import { useMazeStore } from "../store/mazeStore";
import { TRANSIENT_UI_STATE } from "../store/transientUiState";

/** Every store state key that is not in `TRANSIENT_UI_STATE`, grouped by why loading a project leaves it alone.
 * A new key fails the test until it is declared in a slice's `<slice>TransientUi` (a UI mode, prompt,
 * hover or open panel that must end when a project loads) or listed here with its reason. */
const NOT_TRANSIENT: Record<string, readonly string[]> = {
  "restored from the project file by loadProject": [
    "seed", "tessellationKind", "tessellationParams", "hexOrientation", "triOrientation", "tessellationConfirmed",
    "previewKind", "previewParams", "previewHexOrientation", "previewTriOrientation", "previewFieldConfig",
    "activeFieldConfig", "showFieldOrigin", "showBackgroundImage", "backgroundImage",
    "backgroundImageManualPositioning", "backgroundImageCropping", "floorFields", "presetConnections",
    "defaultEdgeState", "presetStart", "presetFinish", "presetGenSource", "generationSourceMode",
    "showPresetOrigin", "showPresetLocks", "lockedNodes", "autoLock", "autoLockedNodes", "presetsDirty",
    "presetTeleports", "_nextPresetTeleportId", "presetVerticalPassages", "_nextPresetVerticalPassageId",
    "presetElevators", "_nextPresetElevatorId", "presetSplitPoints", "presetSplitPointIds",
    "_nextPresetSplitPointId", "presetEntityOrder", "rules", "stages", "initialConfig", "elementsConfig",
    "randomSeed", "lastUsedSeed", "seedHistory", "seedHistoryIndex", "seedAttachedToHistory", "qcExperiment",
    "lastUsedQcExperiment", "vertexSettingsPanelOpen", "openCard", "debugMode", "debugAutoPlayDelay",
    "debugStep", "mazeDirty", "repairMaxIterations", "repairTimeBudgetSecs", "splitPatternMode",
    "splitMaxNodes", "splitPatterns", "showGridOverlay", "showMazeOverlay", "showComponentsOverlay", "showGraphOverlay",
    "showNavGraphOverlay", "showPureCyclesOverlay", "showRouteOverlay", "showRegionClassesOverlay",
    "analyticsSectionsExpanded", "postEditAutoConfirm", "postEditCommands", "postEditDirty",
    "_nextPostEditTeleportId", "_nextSplitSlotId", "_nextPostEditSplitPointId",
    "_nextPostEditVerticalPassageId", "_nextPostEditElevatorId", "activeRenderMode", "openRenderModeSettings",
    "vectorByWallsSectionsExpanded", "showColorWarnings", "linkIconVisibility", "vectorByWallsSettings",
    "floorLabelModeChosen", "vectorByCorridorsSectionsExpanded", "vectorByCorridorsSettings", "pngExportSettings",
    "floors", "nextFloorNumber", "activeFloorId", "floorTopology", "floorCreases", "edgeMarkerOrder",
  ],
  "rebuilt by the regeneration and post-edit replay that loadProject runs": [
    "nodes", "edges", "start", "finish", "navNodes", "navEdges", "statistics", "issues", "error", "routeInfo",
    "timing", "generationStatus", "debugArena", "debugStale", "debugValueToggles", "postEditBaseline",
    "postEditDerived", "postEditDraftEdges", "postEditDraftTeleports", "postEditDraftMeta",
    "postEditDraftSplitPoints", "postEditDraftSplitPointIds", "postEditEdges", "postEditTeleportEdges",
    "postEditMeta", "postEditAnalytics", "postEditRefreshError", "_postEditRequestId", "_generatedStart",
    "_generatedFinish", "_generatedNodes", "_generatedEdges", "postEditDraftVerticalPassages",
    "postEditDraftElevators",
  ],
  "app-wide, independent of the project": [
    "registryError", "registryLoaded", "availableChecks", "availableStrategies", "availableRuleParams",
    "showFieldOverlay", "showPaperLayout", "showNodeIds", "showCoords", "showMaze", "showKruskalDsuGroups",
    "showFullyPresetLockedIssues", "postEditAutoCompact", "debugAutoSwitchFloor", "debugFocusToken",
    "presetSectionsExpanded",
  ],
  "owned by the canvas controller that sets it": ["fieldHasSelection"],
};

describe("transient UI state registry (GitHub issue #946)", () => {
  const state = useMazeStore.getState() as unknown as Record<string, unknown>;
  const stateKeys = Object.keys(state).filter((key) => typeof state[key] !== "function");
  const exempt = Object.values(NOT_TRANSIENT).flat();

  it("classifies every store state key", () => {
    const classified = new Set([...Object.keys(TRANSIENT_UI_STATE), ...exempt]);
    expect(stateKeys.filter((key) => !classified.has(key))).toEqual([]);
  });

  it("keeps a key in one place and names only existing keys", () => {
    const transient = Object.keys(TRANSIENT_UI_STATE);
    expect(exempt.filter((key) => transient.includes(key))).toEqual([]);
    expect(exempt.filter((key, i) => exempt.indexOf(key) !== i)).toEqual([]);
    expect([...transient, ...exempt].filter((key) => !stateKeys.includes(key))).toEqual([]);
  });
});
