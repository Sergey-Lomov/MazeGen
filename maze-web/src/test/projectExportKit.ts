import { parseAndValidate, serializeProject } from "../store/projectExport";
import type { MazeState } from "../store/mazeStore";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { buildPostEditBaseline } from "../store/slices/postEditBaselineBuilders";
import type { PostEditEdgeState } from "../store/postEditTypes";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../store/slices/imageExportSlice";
import { fieldOf } from "./fieldConfigFixtures";
import type { WireTopology } from "../wasm/types";

export const es = (from: PostEditEndpoint, to: PostEditEndpoint, kind: PostEditEdgeState["kind"], _legacyId?: string): PostEditEdgeState => ({ kind, from, to });

export function makeState(overrides: Partial<MazeState> = {}): MazeState {
  const base = {
    tessellationKind: "square",
    tessellationParams: {},
    hexOrientation: "flat_top",
    triOrientation: "r0",
    floorFields: {
      floor_1: {
        squareShape: "rect",
        hexShape: "parallelogram",
        triangleShape: "rect",
        fieldConfig: fieldOf("square", { shape: "rect", cols: 5, rows: 5 }),
        savedShapes: {},
        freeFieldPoints: { square: new Set<number>(), hex: new Set<number>(), tri: new Set<number>() },
        isEditingField: false,
        fieldPoints: new Set<number>(),
        fieldEditMode: "default",
        fieldPrimitive: "point",
        fieldDirty: false,
      },
    },
    seed: 42,
    randomSeed: false,
    seedHistory: [],
    seedHistoryIndex: 0,
    initialConfig: { method: "recursive_backtracker" },
    elementsConfig: {},
    splitPatternMode: false,
    splitMaxNodes: 2,
    splitPatterns: [],
    qcExperiment: false,
    vertexSettingsPanelOpen: false,
    rules: [{ id: "rule_1", name: "Rule 1", kind: "k1", checks: [{ localId: 0, typeId: "check_a", params: { param_a: "1" }, disabled: false }], nextLocalCheckId: 1, strategyId: "strategy_a", strategyParams: { param_b: "2" }, disabled: false, ruleDisabled: false, nestedStrategies: [], params: {}, collapsed: false }],
    stages: [{ id: "stage_1", name: "Stage 1", ruleIds: ["rule_1"], disabled: false, collapsed: false }],
    repairMaxIterations: 100,
    repairTimeBudgetSecs: 10,
    presetConnections: new Map(),
    lockedNodes: new Map(),
    defaultEdgeState: "undefined",
    autoLock: true,
    presetStart: presetEndpoint([1, 2]),
    presetFinish: presetEndpoint([3, 4]),
    presetGenSource: null,
    generationSourceMode: "default",
    presetTeleports: [],
    presetVerticalPassages: [],
    presetVerticalPassagePending: null,
    presetElevators: [],
    presetElevatorPending: null,
    presetSplitPoints: {},
    presetSplitPointIds: {},
    presetEntityOrder: [],
    presetActiveSplitNode: {},
    presetFocusedPoint: null,
    postEditDirty: false,
    postEditCommands: [],
    postEditBaseline: buildPostEditBaseline([], [], 0, null, null),
    postEditDerived: buildPostEditBaseline([], [], 0, null, null).derived,
    postEditDraftEdges: null,
    postEditDraftMeta: null,
    postEditDraftTeleports: [],
    postEditDraftSplitPoints: {},
    postEditActiveSplitNode: {},
    postEditDraftVerticalPassages: [],
    postEditVerticalPassagePending: null,
    _nextPostEditTeleportId: 1,
    _nextPostEditVerticalPassageId: 1,
    postEditDraftElevators: [],
    postEditElevatorPending: null,
    _nextPostEditElevatorId: 1,
    _nextSplitSlotId: {},
    postEditDraftSplitPointIds: {},
    _nextPostEditSplitPointId: 1,
    fieldDirty: false,
    presetsDirty: false,
    mazeDirty: false,
    showMazeOverlay: true,
    showComponentsOverlay: false,
    showGraphOverlay: false,
    showNavGraphOverlay: false,
    showPureCyclesOverlay: false,
    showRouteOverlay: false,
    showRegionClassesOverlay: false,
    analyticsSectionsExpanded: { layers: true },
    debugMode: false,
    debugStep: 0,
    debugAutoPlayDelay: 200,
    showPresetOrigin: false,
    showFieldOrigin: true,
    openCard: "basic_config",
    postEditAutoConfirm: true,
    activeRenderMode: null,
    openRenderModeSettings: null,
      vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS,
    vectorByWallsSectionsExpanded: {},
    vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
    vectorByCorridorsSectionsExpanded: {},
    pngExportSettings: DEFAULT_PNG_EXPORT_SETTINGS,
    floorLabelModeChosen: true,
    floors: [{ id: "floor_1", title: "Floor 1" }],
    nextFloorNumber: 2,
    activeFloorId: "floor_1",
    floorTopology: {},
    showColorWarnings: true,
    linkIconVisibility: "linked",
  };
  return { ...base, ...overrides } as unknown as MazeState;
}

export const CYLINDER: WireTopology = {
  fingerprint: "square{}",
  folds: [{ a: { cell: [4, 0], face_idx: 0 }, b: { cell: [0, 0], face_idx: 2 }, twist: false, group: 0 }],
  groups: [{ id: 0, folds: [0] }],
};

/** Serializes `state` to JSON text and parses it back, as a save/load cycle would. */
export const reparse = (state: MazeState) => parseAndValidate(JSON.parse(JSON.stringify(serializeProject(state))));

/** JSON round-trip of the serialized project, as written to and read from disk. */
export const toJson = (state: MazeState) => JSON.parse(JSON.stringify(serializeProject(state)));
