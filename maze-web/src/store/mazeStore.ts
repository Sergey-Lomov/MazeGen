import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies, computeAnalytics } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, GenerationStepsSnapshot, GenerateConfig, WasmTessellationConfig, NodeLockKind, PostEditEdgeWasmDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";
import type { PresetConnectionEntry, PresetConnectionTool } from "../pixi/presetConnectionsUtils";
import { applyTool, computeInvalidKeys, computeAutoLockedNodes, resolveCells, edgeKey, canonicalize } from "../pixi/presetConnectionsUtils";
import { buildCellSet } from "../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../pixi/tessellationGeometry";
import { configAllCells } from "../pixi/tessellationCells";
import { buildPostEditDraftEdgesFromGenerated, applyPostEditEdgeTool } from "../pixi/postEditUtils";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish";

export interface PostEditEdge {
  from: number;
  to: number;
  kind: PostEditEdgeKind;
}

export interface PostEditMeta {
  start: number | null;
  finish: number | null;
}

export interface PostEditAnalytics {
  nodeStats: NodeStatsDto;
  edgeStats: SpatialEdgeStatsDto;
  routeInfo: RouteInfoDto | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  components: number[][];
  warnings: string[];
}

export type TessellationKind = "square" | "hex" | "triangle";
export type SquareShape = "rect" | "free";
export type HexShape = "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive = "point" | "square_rect" | "hex_parallelogram" | "hex_hexagon" | "tri_rect" | "tri_triangle" | "tri_hexagon";
export type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation" | "post_edit" | "analytics";

const DEFAULT_HEX_ORI: HexOrientation = "flat_top";
const DEFAULT_TRI_ORI: TriOrientation = "r0";

export interface MazeState {
  seed: number;
  // Confirmed tessellation — set only on confirmTessellation()
  tessellationKind: TessellationKind;
  hexOrientation: HexOrientation;
  triOrientation: TriOrientation;
  tessellationConfirmed: boolean;
  // Preview tessellation — changes with every dropdown selection, drives canvas grid
  previewKind: TessellationKind;
  previewHexOrientation: HexOrientation;
  previewTriOrientation: TriOrientation;
  previewTessellationConfig: TessellationConfig;
  // Shape / field editing (operates on confirmed tessellation kind)
  squareShape: SquareShape;
  hexShape: HexShape;
  triangleShape: TriangleShape;
  /** Saved params per predefined config type, preserved across shape/mode switches. */
  savedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>>;
  tessellationConfig: TessellationConfig;
  activeTessellationConfig: TessellationConfig;
  /** Per-kind free-field points, preserved when switching shapes within same kind. */
  freeFieldPoints: Record<TessellationKind, Set<number>>;
  /**
   * True when the active field is custom (free-draw). Set by:
   * - shape actions (setSquareShape/setHexShape/setTriangleShape) when shape === "free"
   * - setFieldEditMode("custom") / setFieldEditMode("default") for card-based editing
   * generate() reads this directly to decide whether to use fieldPoints.
   */
  isEditingField: boolean;
  /**
   * Active custom cell set for the current tessellation kind.
   * Mirrors freeFieldPoints[tessellationKind] for predefined-shape flow;
   * set directly by setFieldEditMode for card-based custom editing.
   */
  fieldPoints: Set<number>;
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  components: number[][];
  showNodeIds: boolean;
  showCoords: boolean;
  showMaze: boolean;
  selectedNode: number | null;
  warnings: string[];
  error: string | null;
  registryLoaded: boolean;
  availableChecks: CheckDescriptor[];
  availableStrategies: StrategyDescriptor[];
  selectedChecks: string[];
  selectedStrategies: Record<string, string>;
  /** strategyParams[strategyId][paramId] = raw string value */
  strategyParams: Record<string, Record<string, string>>;
  /** checkParams[checkId][paramId] = raw string value */
  checkParams: Record<string, Record<string, string>>;
  initialConfig: InitialGenerationConfig;
  elementsConfig: ElementsConfig;
  nodeStats: NodeStatsDto | null;
  edgeStats: SpatialEdgeStatsDto | null;
  routeInfo: RouteInfoDto | null;
  showFieldOverlay: boolean;
  fieldEditMode: "default" | "custom";
  fieldPrimitive: FieldPrimitive;
  presetConnections: Map<string, PresetConnectionEntry>;
  presetConnectionsTool: PresetConnectionTool;
  defaultEdgeState: "undefined" | "wall" | "passage";
  presetStart: [number, number] | null;
  presetFinish: [number, number] | null;
  presetGenSource: [number, number] | null;
  highlightInvalidPresets: boolean;
  highlightIsolatedNodes: boolean;
  showPresetOrigin: boolean;
  showFieldOrigin: boolean;
  /** Locked nodes: key = "x,y", value = lock kind */
  lockedNodes: Map<string, NodeLockKind>;
  autoLock: boolean;
  /** Auto-locked nodes (fully-defined cells): key = "x,y". Always lock_both. */
  autoLockedNodes: Set<string>;
  // Runtime generation state
  randomSeed: boolean;
  lastUsedSeed: number | null;
  generationStatus: "idle" | "done" | "error";
  // Active feature card
  openCard: FeatureId;
  // Debug state — read-only projection, does not mutate production graph
  debugMode: boolean;
  debugAutoPlayDelay: number;
  debugSnapshot: GenerationStepsSnapshot | null;
  debugStep: number;
  debugStale: boolean;
  showDebugFrontier: boolean;
  // Analytics state
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showRouteOverlay: boolean;
  // Post-edit state
  postEditAutoConfirm: boolean;
  postEditTool: PostEditTool;
  /** Working copy — updated on every tool click. Read by PostEditRenderer. */
  postEditDraftEdges: Record<string, PostEditEdge> | null;
  /** Working copy — updated on endpoint changes. Read by PostEditRenderer. */
  postEditDraftMeta: PostEditMeta | null;
  /** Confirmed snapshot of postEditDraftEdges. Read by AnalyticsRenderer. */
  postEditEdges: Record<string, PostEditEdge> | null;
  /** Confirmed snapshot of postEditDraftMeta. Read by AnalyticsRenderer. */
  postEditMeta: PostEditMeta | null;
  /** Analytics over confirmed graph. null until first confirmPostEdit completes. */
  postEditAnalytics: PostEditAnalytics | null;
  /** Incremented on each confirmPostEdit call; stale async results are discarded. */
  _postEditRequestId: number;
  /** start/finish as generated — restored on resetPostEdit. */
  _generatedStart: number | null;
  _generatedFinish: number | null;
  /** True after any manual post-edit change since the last generate/reset. */
  postEditDirty: boolean;
  /** True after any field setup change since the last confirmTessellation. */
  fieldDirty: boolean;
  /** True after any preset connection change since the last confirmTessellation. */
  presetsDirty: boolean;
  /** True after the maze has been generated since the last confirmTessellation. */
  mazeDirty: boolean;
}

interface MazeActions {
  setSeed: (seed: number) => void;
  // Preview actions — only change preview, not confirmed
  setPreviewKind: (kind: TessellationKind) => void;
  setPreviewHexOrientation: (orientation: HexOrientation) => void;
  setPreviewTriOrientation: (orientation: TriOrientation) => void;
  // Confirm — copies preview → confirmed, triggers confirmed-dependent state
  confirmTessellation: () => void;
  syncPreviewToConfirmed: () => void;
  // Shape actions (operate on confirmed tessellation)
  setTessellationKind: (kind: TessellationKind) => void;
  setSquareShape: (shape: SquareShape) => void;
  setHexShape: (shape: HexShape) => void;
  setTriangleShape: (shape: TriangleShape) => void;
  setHexOrientation: (orientation: HexOrientation) => void;
  setTriOrientation: (orientation: TriOrientation) => void;
  setTessellationConfig: (cfg: TessellationConfig) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => Promise<void>;
  addCheck: (id: string) => void;
  removeCheck: (id: string) => void;
  setCheckParam: (checkId: string, paramId: string, value: string) => void;
  setStrategy: (issueKind: string, strategyId: string) => void;
  clearStrategy: (issueKind: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
  setGenerationParam: (key: keyof GenerationParams, value: number) => void;
  setEdgeBasedParam: (key: keyof EdgeBasedParams, value: number) => void;
  setGenerationMethod: (method: string) => void;
  setElementsParam: (key: keyof ElementsConfig, value: number) => void;
  addFieldPoint: (x: number, y: number) => void;
  removeFieldPoint: (x: number, y: number) => void;
  addFieldPoints: (cells: [number, number][]) => void;
  removeFieldPoints: (cells: [number, number][]) => void;
  clearFieldPoints: () => void;
  setShowFieldOverlay: (show: boolean) => void;
  setFieldEditMode: (mode: "default" | "custom") => void;
  setFieldPrimitive: (p: FieldPrimitive) => void;
  setPresetConnectionsTool: (tool: PresetConnectionTool) => void;
  applyPresetConnectionsTool: (key: string, from: [number, number], to: [number, number]) => void;
  applyPresetConnectionsReset: (key: string) => void;
  clearInvalidPresetConnections: () => void;
  resetPresetConnections: () => void;
  setPresetStart: (cell: [number, number] | null) => void;
  setPresetFinish: (cell: [number, number] | null) => void;
  setPresetGenSource: (cell: [number, number] | null) => void;
  setDefaultEdgeState: (s: "undefined" | "wall" | "passage") => void;
  setHighlightInvalidPresets: (highlight: boolean) => void;
  setHighlightIsolatedNodes: (highlight: boolean) => void;
  setShowPresetOrigin: (show: boolean) => void;
  setShowFieldOrigin: (show: boolean) => void;
  setLockedNode: (x: number, y: number, kind: NodeLockKind) => void;
  removeLockedNode: (x: number, y: number) => void;
  clearLockedNodes: () => void;
  setAutoLock: (v: boolean) => void;
  setRandomSeed: (v: boolean) => void;
  setOpenCard: (card: FeatureId) => void;
  setDebugMode: (v: boolean) => void;
  setDebugStep: (step: number) => void;
  setDebugAutoPlayDelay: (ms: number) => void;
  setShowDebugFrontier: (v: boolean) => void;
  regenerate: () => void;
  setShowMazeOverlay: (v: boolean) => void;
  setShowComponentsOverlay: (v: boolean) => void;
  setShowGraphOverlay: (v: boolean) => void;
  setShowNavGraphOverlay: (v: boolean) => void;
  setShowRouteOverlay: (v: boolean) => void;
  setPostEditAutoConfirm: (v: boolean) => void;
  setPostEditTool: (tool: PostEditTool) => void;
  applyPostEditTool: (edgeKey: string, from: number, to: number) => void;
  setPostEditEndpoint: (kind: "start" | "finish", nodeId: number) => void;
  clearPostEditEndpoint: (kind: "start" | "finish") => void;
  setError: (msg: string | null) => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

function kindAndShapeFromConfig(cfg: TessellationConfig): { kind: TessellationKind; squareShape: SquareShape; hexShape: HexShape; triangleShape: TriangleShape } {
  switch (cfg.type) {
    case "square":
      return { kind: "square", squareShape: "rect", hexShape: "parallelogram", triangleShape: "rect" };
    case "hex_parallelogram":
      return { kind: "hex", squareShape: "rect", hexShape: "parallelogram", triangleShape: "rect" };
    case "hex_hexagon":
      return { kind: "hex", squareShape: "rect", hexShape: "hexagon", triangleShape: "rect" };
    case "triangle_rect":
      return { kind: "triangle", squareShape: "rect", hexShape: "parallelogram", triangleShape: "rect" };
    case "triangle_triangle":
      return { kind: "triangle", squareShape: "rect", hexShape: "parallelogram", triangleShape: "triangle" };
    case "triangle_hexagon":
      return { kind: "triangle", squareShape: "rect", hexShape: "parallelogram", triangleShape: "hexagon" };
    case "square_custom":
      return { kind: "square", squareShape: "free", hexShape: "parallelogram", triangleShape: "rect" };
    case "hex_custom":
      return { kind: "hex", squareShape: "rect", hexShape: "free", triangleShape: "rect" };
    case "tri_custom":
      return { kind: "triangle", squareShape: "rect", hexShape: "parallelogram", triangleShape: "free" };
  }
}

function buildPredefinedConfig(
  kind: TessellationKind,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  hexOrientation: HexOrientation,
  triOrientation: TriOrientation,
  saved?: Partial<Record<TessellationConfig["type"], TessellationConfig>>,
): TessellationConfig {
  if (kind === "square") {
    const base = saved?.["square"] as { type: "square"; width: number; height: number } | undefined;
    return { type: "square", width: base?.width ?? 11, height: base?.height ?? 11 };
  }
  if (kind === "hex") {
    if (hexShape === "parallelogram") {
      const base = saved?.["hex_parallelogram"] as { type: "hex_parallelogram"; cols: number; rows: number; orientation: HexOrientation } | undefined;
      return { type: "hex_parallelogram", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: hexOrientation };
    }
    const base = saved?.["hex_hexagon"] as { type: "hex_hexagon"; radius: number; orientation: HexOrientation } | undefined;
    return { type: "hex_hexagon", radius: base?.radius ?? 5, orientation: hexOrientation };
  }
  if (triangleShape === "rect") {
    const base = saved?.["triangle_rect"] as { type: "triangle_rect"; cols: number; rows: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_rect", cols: base?.cols ?? 10, rows: base?.rows ?? 10, orientation: triOrientation };
  }
  if (triangleShape === "triangle") {
    const base = saved?.["triangle_triangle"] as { type: "triangle_triangle"; side: number; orientation: TriOrientation } | undefined;
    return { type: "triangle_triangle", side: base?.side ?? 8, orientation: triOrientation };
  }
  const base = saved?.["triangle_hexagon"] as { type: "triangle_hexagon"; radius: number; orientation: TriOrientation } | undefined;
  return { type: "triangle_hexagon", radius: base?.radius ?? 4, orientation: triOrientation };
}

function buildFreeConfig(kind: TessellationKind, pts: Set<number>, hexOrientation: HexOrientation, triOrientation: TriOrientation): TessellationConfig {
  const points = Array.from(pts).map(k => decodePoint(k) as [number, number]);
  if (kind === "square") return { type: "square_custom", points };
  if (kind === "hex") return { type: "hex_custom", points, orientation: hexOrientation } as TessellationConfig;
  return { type: "tri_custom", points, orientation: triOrientation } as TessellationConfig;
}

function buildPreviewConfig(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation): TessellationConfig {
  if (kind === "square") return { type: "square", width: 11, height: 11 };
  if (kind === "hex") return { type: "hex_parallelogram", cols: 10, rows: 10, orientation: hexOri };
  return { type: "triangle_rect", cols: 10, rows: 10, orientation: triOri };
}

function buildPreviewState(kind: TessellationKind, hexOri: HexOrientation, triOri: TriOrientation) {
  return {
    previewKind: kind,
    previewHexOrientation: hexOri,
    previewTriOrientation: triOri,
    previewTessellationConfig: buildPreviewConfig(kind, hexOri, triOri),
  };
}

const emptyFreePoints = (): Record<TessellationKind, Set<number>> => ({
  square: new Set<number>(),
  hex: new Set<number>(),
  triangle: new Set<number>(),
});

function deriveEditState(
  kind: TessellationKind,
  squareShape: SquareShape,
  hexShape: HexShape,
  triangleShape: TriangleShape,
  freeFieldPoints: Record<TessellationKind, Set<number>>,
): { isEditingField: boolean; fieldPoints: Set<number> } {
  const isEditingField = squareShape === "free" || hexShape === "free" || triangleShape === "free";
  const fieldPoints = isEditingField ? freeFieldPoints[kind] : new Set<number>();
  return { isEditingField, fieldPoints };
}


export const useMazeStore = create<MazeState & MazeActions>((set, get) => ({
  seed: 42,
  tessellationKind: "square",
  hexOrientation: DEFAULT_HEX_ORI,
  triOrientation: DEFAULT_TRI_ORI,
  tessellationConfirmed: false,
  previewKind: "square",
  previewHexOrientation: DEFAULT_HEX_ORI,
  previewTriOrientation: DEFAULT_TRI_ORI,
  previewTessellationConfig: { type: "square", width: 11, height: 11 },
  squareShape: "rect",
  hexShape: "hexagon",
  triangleShape: "triangle",
  savedConfigs: {},
  tessellationConfig: { type: "square", width: 11, height: 11 },
  activeTessellationConfig: { type: "square", width: 11, height: 11 },
  freeFieldPoints: emptyFreePoints(),
  isEditingField: false,
  fieldPoints: new Set<number>(),
  nodes: [],
  edges: [],
  start: null,
  finish: null,
  navNodes: [],
  navEdges: [],
  components: [],
  showNodeIds: false,
  showCoords: false,
  showMaze: true,
  selectedNode: null,
  warnings: [],
  error: null,
  registryLoaded: false,
  availableChecks: [],
  availableStrategies: [],
  selectedChecks: [],
  selectedStrategies: {},
  strategyParams: {},
  checkParams: {},
  initialConfig: { method: "recursive_backtracker" as const },
  elementsConfig: { one_way_chance: 0.04 },
  nodeStats: null,
  edgeStats: null,
  routeInfo: null,
  showFieldOverlay: true,
  fieldEditMode: "default",
  fieldPrimitive: "point",
  presetConnections: new Map<string, PresetConnectionEntry>(),
  presetConnectionsTool: "wall" as PresetConnectionTool,
  defaultEdgeState: "undefined" as const,
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  highlightInvalidPresets: false,
  highlightIsolatedNodes: false,
  showPresetOrigin: false,
  showFieldOrigin: true,
  lockedNodes: new Map<string, NodeLockKind>(),
  autoLock: true,
  autoLockedNodes: new Set<string>(),
  randomSeed: false,
  lastUsedSeed: null,
  generationStatus: "idle" as const,
  openCard: "basic_config" as FeatureId,
  debugMode: false,
  debugAutoPlayDelay: 200,
  debugSnapshot: null,
  debugStep: 0,
  debugStale: false,
  showDebugFrontier: true,
  showMazeOverlay: true,
  showComponentsOverlay: false,
  showGraphOverlay: false,
  showNavGraphOverlay: false,
  showRouteOverlay: false,
  postEditAutoConfirm: true,
  postEditTool: "wall" as PostEditTool,
  postEditDraftEdges: null,
  postEditDraftMeta: null,
  postEditEdges: null,
  postEditMeta: null,
  postEditAnalytics: null,
  _postEditRequestId: 0,
  _generatedStart: null,
  _generatedFinish: null,
  postEditDirty: false,
  fieldDirty: false,
  presetsDirty: false,
  mazeDirty: false,

  setSeed: (seed) => set({ seed, error: null }),

  setPreviewKind: (kind) => set((state) => ({
    previewKind: kind,
    previewTessellationConfig: buildPreviewConfig(kind, state.previewHexOrientation, state.previewTriOrientation),
  })),

  setPreviewHexOrientation: (orientation) => set((state) => ({
    previewHexOrientation: orientation,
    previewTessellationConfig: buildPreviewConfig(state.previewKind, orientation, state.previewTriOrientation),
  })),

  setPreviewTriOrientation: (orientation) => set((state) => ({
    previewTriOrientation: orientation,
    previewTessellationConfig: buildPreviewConfig(state.previewKind, state.previewHexOrientation, orientation),
  })),

  syncPreviewToConfirmed: () => set((state) =>
    buildPreviewState(state.tessellationKind, state.hexOrientation, state.triOrientation)
  ),

  confirmTessellation: () => set((state) => {
    const kind = state.previewKind;
    const hexOrientation = state.previewHexOrientation;
    const triOrientation = state.previewTriOrientation;
    const squareShape: SquareShape = "rect";
    const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
    const triangleShape: TriangleShape = kind === "triangle" ? "triangle" : "rect";
    const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, hexOrientation, triOrientation, state.savedConfigs);
    const savedConfigs = { ...state.savedConfigs, [cfg.type]: cfg };
    const freeFieldPoints = kind !== state.tessellationKind
      ? { ...state.freeFieldPoints, [kind]: new Set<number>() }
      : state.freeFieldPoints;
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    const clearMaze = kind !== state.tessellationKind;
    return {
      tessellationKind: kind,
      hexOrientation,
      triOrientation,
      tessellationConfirmed: true,
      ...buildPreviewState(kind, hexOrientation, triOrientation),
      squareShape,
      hexShape,
      triangleShape,
      tessellationConfig: cfg,
      savedConfigs,
      freeFieldPoints,
      isEditingField,
      fieldPoints,
      ...(clearMaze ? {
        nodes: [], edges: [], start: null, finish: null,
        navNodes: [], navEdges: [], components: [],
        selectedNode: null, warnings: [], nodeStats: null, edgeStats: null, routeInfo: null,
        error: null,
        presetConnections: new Map<string, PresetConnectionEntry>(),
        lockedNodes: new Map<string, NodeLockKind>(),
        autoLockedNodes: new Set<string>(),
        presetStart: null,
        presetFinish: null,
        presetGenSource: null,
        defaultEdgeState: "undefined" as const,
        fieldEditMode: "default" as const,
        debugSnapshot: null, debugStep: 0, debugStale: false,
      } : { debugStale: state.debugSnapshot !== null }),
      fieldDirty: false,
      presetsDirty: false,
      mazeDirty: false,
      postEditDirty: false,
    };
  }),

  setTessellationKind: (kind) => set((state) => {
    if (kind === state.tessellationKind) return {};
    const squareShape: SquareShape = "rect";
    const hexShape: HexShape = kind === "hex" ? "hexagon" : "parallelogram";
    const triangleShape: TriangleShape = kind === "triangle" ? "triangle" : "rect";
    const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    const freeFieldPoints = { ...state.freeFieldPoints, [kind]: new Set<number>() };
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    return {
      tessellationKind: kind, squareShape, hexShape, triangleShape,
      tessellationConfig: cfg, isEditingField, fieldPoints, freeFieldPoints,
      nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [],
      selectedNode: null, warnings: [], nodeStats: null, edgeStats: null, routeInfo: null,
      error: null,
      debugSnapshot: null, debugStep: 0, debugStale: false,
    };
  }),

  setSquareShape: (shape) => set((state) => {
    if (shape === state.squareShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, shape, state.hexShape, state.triangleShape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("square", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("square", state.hexShape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { squareShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, fieldDirty: true, error: null, debugStale: state.debugSnapshot !== null };
  }),

  setHexShape: (shape) => set((state) => {
    if (shape === state.hexShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, state.squareShape, shape, state.triangleShape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("hex", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("hex", shape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { hexShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, fieldDirty: true, error: null, debugStale: state.debugSnapshot !== null };
  }),

  setTriangleShape: (shape) => set((state) => {
    if (shape === state.triangleShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, state.squareShape, state.hexShape, shape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("triangle", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("triangle", state.hexShape, shape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { triangleShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, fieldDirty: true, error: null, debugStale: state.debugSnapshot !== null };
  }),

  setHexOrientation: (orientation) => set((state) => {
    if (orientation === state.hexOrientation) return {};
    if (state.tessellationKind !== "hex") return { hexOrientation: orientation };
    const { isEditingField } = deriveEditState(state.tessellationKind, state.squareShape, state.hexShape, state.triangleShape, state.freeFieldPoints);
    const tessellationConfig = mergeOrientation(state.tessellationConfig, orientation);
    const savedConfigs = isEditingField ? state.savedConfigs : { ...state.savedConfigs, [tessellationConfig.type]: tessellationConfig };
    const activeTessellationConfig = state.nodes.length > 0
      ? mergeOrientation(state.activeTessellationConfig, orientation)
      : state.activeTessellationConfig;
    return { hexOrientation: orientation, tessellationConfig, savedConfigs, activeTessellationConfig, fieldDirty: true, error: null, debugStale: state.debugSnapshot !== null };
  }),

  setTriOrientation: (orientation) => set((state) => {
    if (orientation === state.triOrientation) return {};
    if (state.tessellationKind !== "triangle") return { triOrientation: orientation };
    const { isEditingField } = deriveEditState(state.tessellationKind, state.squareShape, state.hexShape, state.triangleShape, state.freeFieldPoints);
    const tessellationConfig = mergeOrientation(state.tessellationConfig, orientation);
    const savedConfigs = isEditingField ? state.savedConfigs : { ...state.savedConfigs, [tessellationConfig.type]: tessellationConfig };
    const activeTessellationConfig = state.nodes.length > 0
      ? mergeOrientation(state.activeTessellationConfig, orientation)
      : state.activeTessellationConfig;
    return { triOrientation: orientation, tessellationConfig, savedConfigs, activeTessellationConfig, fieldDirty: true, error: null, debugStale: state.debugSnapshot !== null };
  }),

  setTessellationConfig: (cfg) => {
    const { kind, squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(cfg);
    const hexOrientation = (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
      ? ((cfg as { orientation?: HexOrientation }).orientation ?? "flat_top")
      : get().hexOrientation;
    const triOrientation = (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom")
      ? ((cfg as { orientation?: TriOrientation }).orientation ?? "r0")
      : get().triOrientation;
    const currentFreeFieldPoints = get().freeFieldPoints;
    const isCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
    const freeFieldPoints = isCustom
      ? {
          ...currentFreeFieldPoints,
          [kind]: new Set<number>((cfg as { points?: [number, number][] }).points?.map(([x, y]) => encodePoint(x, y)) ?? []),
        }
      : currentFreeFieldPoints;
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    const savedConfigs = isCustom ? get().savedConfigs : { ...get().savedConfigs, [cfg.type]: cfg };
    const debugStale = get().debugSnapshot !== null;
    set({ tessellationConfig: cfg, tessellationKind: kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, fieldDirty: true, error: null, debugStale });
  },

  loadRegistry: () => {
    return initWasm().then(() => {
      const checks = getAvailableChecks();
      const strategies = getAvailableStrategies();
      const defaultSelectedChecks = checks.filter((c) => c.params.length === 0).map((c) => c.id);
      const defaultStrategies: Record<string, string> = {};
      for (const check of checks) {
        for (const kind of check.issue_kinds) {
          const match = strategies.find((s) => s.handles === kind);
          if (match) defaultStrategies[kind] = match.id;
        }
      }
      const knownIds = new Set(checks.map((c) => c.id));
      set((state) => {
        const selectedChecks = state.registryLoaded
          ? state.selectedChecks.filter((id) => knownIds.has(id))
          : defaultSelectedChecks;
        const selectedStrategies = state.registryLoaded ? state.selectedStrategies : defaultStrategies;
        const checkParams = Object.fromEntries(
          Object.entries(state.checkParams).filter(([id]) => knownIds.has(id))
        );
        return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, selectedChecks, selectedStrategies, checkParams };
      });
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load WASM registry:", msg);
      set({ error: msg });
    });
  },

  generate: () => {
    const state = get();
    let usedSeed = state.seed;
    if (state.randomSeed) {
      usedSeed = Math.floor(Math.random() * 1_000_000);
      set({ seed: usedSeed });
    }
    set({ lastUsedSeed: usedSeed });
    _generateWithSeed(usedSeed, get, set);
  },


  regenerate: () => {
    const state = get();
    if (state.lastUsedSeed === null) return;
    _generateWithSeed(state.lastUsedSeed, get, set);
  },

  setRandomSeed: (v) => set({ randomSeed: v }),

  setOpenCard: (card) => set((state) => ({
    openCard: card,
    ...(state.openCard === "preset_connections" && card !== "preset_connections"
      ? { highlightInvalidPresets: false, highlightIsolatedNodes: false }
      : {}),
  })),

  setDebugMode: (v) => set(v ? { debugMode: true } : { debugMode: false, debugStale: false }),

  setDebugStep: (step) => set({ debugStep: step }),

  setDebugAutoPlayDelay: (ms) => set({ debugAutoPlayDelay: ms }),

  setShowDebugFrontier: (v) => set({ showDebugFrontier: v }),

  setShowMazeOverlay: (v) => set({ showMazeOverlay: v }),
  setShowComponentsOverlay: (v) => set({ showComponentsOverlay: v }),
  setShowGraphOverlay: (v) => set({ showGraphOverlay: v }),
  setShowNavGraphOverlay: (v) => set({ showNavGraphOverlay: v }),
  setShowRouteOverlay: (v) => set({ showRouteOverlay: v }),

  setPostEditAutoConfirm: (v) => set({ postEditAutoConfirm: v }),
  setPostEditTool: (tool) => set({ postEditTool: tool }),

  applyPostEditTool: (edgeKey, from_, to_) => {
    set((state) => {
      if (state.postEditDraftEdges === null) return {};
      return {
        postEditDraftEdges: applyPostEditEdgeTool(
          state.postEditDraftEdges,
          state.postEditTool,
          edgeKey,
          from_,
          to_,
          state.edges,
        ),
        postEditDirty: true,
      };
    });
  },

  confirmPostEdit: async () => {
    const requestId = useMazeStore.getState()._postEditRequestId + 1;
    set({ _postEditRequestId: requestId });

    const state = useMazeStore.getState();
    const { postEditDraftEdges, postEditDraftMeta, activeTessellationConfig, nodes, start, finish, selectedChecks, checkParams } = state;
    if (postEditDraftEdges === null) return;
    const edgesSnapshot = postEditDraftEdges;
    const metaSnapshot = postEditDraftMeta;

    const effectiveStart = postEditDraftMeta != null ? postEditDraftMeta.start : start;
    const effectiveFinish = postEditDraftMeta != null ? postEditDraftMeta.finish : finish;

    const wasmEdges: PostEditEdgeWasmDto[] = Object.values(postEditDraftEdges)
      .filter(e => e.kind !== "wall")
      .map(e => ({
        from: e.from,
        to: e.to,
        kind: e.kind === "basic" ? "basic" as const : "one_way" as const,
      }));

    const config = {
      tessellation: fieldConfigToWasm(activeTessellationConfig),
      nodes: nodes.map(n => [n.x, n.y] as [number, number]),
      edges: wasmEdges,
      start: effectiveStart ?? null,
      finish: effectiveFinish ?? null,
      checks: selectedChecks,
      check_params: checkParams,
    };

    try {
      const snapshot = computeAnalytics(config);
      if (useMazeStore.getState()._postEditRequestId !== requestId) return;
      set((state) => ({
        postEditAnalytics: {
          nodeStats: snapshot.node_stats,
          edgeStats: snapshot.edge_stats,
          routeInfo: snapshot.route_info,
          navNodes: snapshot.nav_nodes,
          navEdges: snapshot.nav_edges,
          components: snapshot.components,
          warnings: snapshot.warnings,
        },
        postEditEdges: edgesSnapshot,
        postEditMeta: metaSnapshot,
        showRouteOverlay: snapshot.route_info != null ? state.showRouteOverlay : false,
      }));
    } catch (err) {
      if (useMazeStore.getState()._postEditRequestId !== requestId) return;
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  resetPostEdit: () => {
    set((state) => ({
      postEditDraftEdges: buildPostEditDraftEdgesFromGenerated(state.edges),
      postEditEdges: null,
      postEditMeta: null,
      postEditAnalytics: null,
      postEditDraftMeta: { start: state._generatedStart, finish: state._generatedFinish },
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
    }));
    void useMazeStore.getState().confirmPostEdit();
  },

  setPostEditEndpoint: (kind, nodeId) => {
    set((state) => ({
      postEditDraftMeta: { ...(state.postEditDraftMeta ?? { start: state.start, finish: state.finish }), [kind]: nodeId },
      postEditDirty: true,
    }));
    if (useMazeStore.getState().postEditAutoConfirm) {
      void useMazeStore.getState().confirmPostEdit();
    }
  },
  clearPostEditEndpoint: (kind) => {
    set((state) => ({
      postEditDraftMeta: { ...(state.postEditDraftMeta ?? { start: state.start, finish: state.finish }), [kind]: null },
      postEditDirty: true,
    }));
    if (useMazeStore.getState().postEditAutoConfirm) {
      void useMazeStore.getState().confirmPostEdit();
    }
  },

  reset: () => set({ nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [], selectedNode: null, warnings: [], error: null, nodeStats: null, edgeStats: null, routeInfo: null, generationStatus: "idle" as const, postEditDraftEdges: null, postEditDraftMeta: null, postEditEdges: null, postEditMeta: null, postEditAnalytics: null, postEditDirty: false }),

  setDebugFlag: (key, value) => set({ [key]: value }),

  selectNode: (id) => set({ selectedNode: id }),

  addCheck: (id) => set((state) => {
    if (state.selectedChecks.includes(id)) return {};
    const descriptor = state.availableChecks.find((c) => c.id === id);
    if (!descriptor) return {};
    const existing = state.checkParams[id];
    const params = existing ?? Object.fromEntries(
      descriptor.params.map((p) => {
        const k = p.kind;
        const def = k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
        return [p.id, def];
      })
    );
    return {
      selectedChecks: [...state.selectedChecks, id],
      checkParams: { ...state.checkParams, [id]: params },
      debugStale: state.debugSnapshot !== null,
    };
  }),

  removeCheck: (id) => set((state) => ({
    selectedChecks: state.selectedChecks.filter((c) => c !== id),
    debugStale: state.debugSnapshot !== null,
  })),

  setCheckParam: (checkId, paramId, value) => set((state) => ({
    checkParams: {
      ...state.checkParams,
      [checkId]: { ...(state.checkParams[checkId] ?? {}), [paramId]: value },
    },
    debugStale: state.debugSnapshot !== null,
  })),

  setStrategy: (issueKind, strategyId) => set((state) => ({
    selectedStrategies: { ...state.selectedStrategies, [issueKind]: strategyId },
    debugStale: state.debugSnapshot !== null,
  })),

  clearStrategy: (issueKind) => set((state) => {
    const next = { ...state.selectedStrategies };
    delete next[issueKind];
    return { selectedStrategies: next, debugStale: state.debugSnapshot !== null };
  }),

  setStrategyParam: (strategyId, paramId, value) => set((state) => ({
    strategyParams: {
      ...state.strategyParams,
      [strategyId]: { ...(state.strategyParams[strategyId] ?? {}), [paramId]: value },
    },
    debugStale: state.debugSnapshot !== null,
  })),

  setGenerationParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_vertex_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value }, debugStale: state.debugSnapshot !== null };
  }),

  setEdgeBasedParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_edge_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value }, debugStale: state.debugSnapshot !== null };
  }),

  setGenerationMethod: (method) => {
    const defaults: Record<string, InitialGenerationConfig> = {
      custom_vertex_based: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 },
      custom_edge_based: { method: "custom_edge_based", corridor_length: 0.5, branching: 0.5, depth_first: 0.5, directionality: 0.0, cyclicity: 0.0 },
      recursive_backtracker: { method: "recursive_backtracker" },
      wilson_algorithm: { method: "wilson_algorithm" },
      kruskal_algorithm: { method: "kruskal_algorithm" },
    };
    const next = defaults[method];
    if (!next) {
      console.error(`Unknown generation method: ${method}`);
      return;
    }
    const stale = get().debugSnapshot !== null;
    set({ initialConfig: next, debugStale: stale });
  },

  setElementsParam: (key, value) => set((state) => ({
    elementsConfig: { ...state.elementsConfig, [key]: value },
    debugStale: state.debugSnapshot !== null,
  })),

  addFieldPoint: (x, y) => set((state) => {
    const key = encodePoint(x, y);
    if (state.fieldPoints.has(key)) return {};
    const fieldPoints = new Set(state.fieldPoints);
    fieldPoints.add(key);
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  removeFieldPoint: (x, y) => set((state) => {
    const key = encodePoint(x, y);
    if (!state.fieldPoints.has(key)) return {};
    const fieldPoints = new Set(state.fieldPoints);
    fieldPoints.delete(key);
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  setShowFieldOverlay: (show) => set({ showFieldOverlay: show }),

  setFieldEditMode: (mode) => set((state) => {
    if (mode === "custom") {
      const cfg = state.tessellationConfig;
      const isAlreadyCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
      let fieldPoints: Set<number>;
      if (isAlreadyCustom) {
        fieldPoints = state.freeFieldPoints[state.tessellationKind];
      } else {
        const cells = configAllCells(cfg);
        fieldPoints = new Set(cells.map(([x, y]) => encodePoint(x, y)));
      }
      const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
      const tessellationConfig = isAlreadyCustom ? cfg : buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
      return { fieldEditMode: mode, isEditingField: true, fieldPoints, freeFieldPoints, tessellationConfig, fieldPrimitive: "point", fieldDirty: true, debugStale: state.debugSnapshot !== null };
    }
    const cfg = buildPredefinedConfig(state.tessellationKind, state.hexShape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { fieldEditMode: mode, isEditingField: false, tessellationConfig: cfg, fieldPrimitive: "point", fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  addFieldPoints: (cells) => set((state) => {
    let changed = false;
    const fieldPoints = new Set(state.fieldPoints);
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (!fieldPoints.has(key)) { fieldPoints.add(key); changed = true; }
    }
    if (!changed) return {};
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  removeFieldPoints: (cells) => set((state) => {
    let changed = false;
    const fieldPoints = new Set(state.fieldPoints);
    for (const [x, y] of cells) {
      const key = encodePoint(x, y);
      if (fieldPoints.has(key)) { fieldPoints.delete(key); changed = true; }
    }
    if (!changed) return {};
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  clearFieldPoints: () => set((state) => {
    const fieldPoints = new Set<number>();
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig, fieldDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  setFieldPrimitive: (p) => set({ fieldPrimitive: p }),

  setPresetConnectionsTool: (tool) => set({ presetConnectionsTool: tool }),

  applyPresetConnectionsTool: (key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool);
    return { presetConnections, autoLockedNodes: _recomputeAutoLock({ ...state, presetConnections }), presetsDirty: true, debugStale: state.debugSnapshot !== null };
  }),

  clearInvalidPresetConnections: () => set((state) => {
    const customPts = state.isEditingField ? state.fieldPoints : undefined;
    const invalidKeys = computeInvalidKeys(state.presetConnections, state.tessellationConfig, customPts);
    const presetConnections = new Map(state.presetConnections);
    for (const key of invalidKeys) presetConnections.delete(key);
    return { presetConnections, autoLockedNodes: _recomputeAutoLock({ ...state, presetConnections }), debugStale: state.debugSnapshot !== null };
  }),

  resetPresetConnections: () => set((state) => ({
    presetConnections: new Map<string, PresetConnectionEntry>(),
    defaultEdgeState: "undefined" as const,
    presetStart: null,
    presetFinish: null,
    presetGenSource: null,
    lockedNodes: new Map<string, NodeLockKind>(),
    autoLockedNodes: new Set<string>(),
    debugStale: state.debugSnapshot !== null,
  })),

  applyPresetConnectionsReset: (key) => set((state) => {
    const existing = state.presetConnections.get(key);
    if (!existing) return {};
    const presetConnections = new Map(state.presetConnections);
    presetConnections.set(key, { from: existing.from, to: existing.to, state: "undefined", source: "user" });
    return { presetConnections, autoLockedNodes: _recomputeAutoLock({ ...state, presetConnections }), debugStale: state.debugSnapshot !== null };
  }),

  setAutoLock: (v) => set((state) => ({
    autoLock: v,
    autoLockedNodes: v ? _recomputeAutoLock({ ...state, autoLock: v }) : new Set<string>(),
    debugStale: state.debugSnapshot !== null,
  })),

  setPresetStart: (cell) => set((state) => ({ presetStart: cell, debugStale: state.debugSnapshot !== null })),
  setPresetFinish: (cell) => set((state) => ({ presetFinish: cell, debugStale: state.debugSnapshot !== null })),
  setPresetGenSource: (cell) => set((state) => ({ presetGenSource: cell, debugStale: state.debugSnapshot !== null })),

  setDefaultEdgeState: (s) => set((state) => {
    const presetConnections = _applyDefaultEdgeState(state, s);
    return { defaultEdgeState: s, presetConnections, autoLockedNodes: _recomputeAutoLock({ ...state, presetConnections }), debugStale: state.debugSnapshot !== null };
  }),
  setHighlightInvalidPresets: (highlight) => set({ highlightInvalidPresets: highlight }),
  setHighlightIsolatedNodes: (highlight) => set({ highlightIsolatedNodes: highlight }),
  setShowPresetOrigin: (show) => set({ showPresetOrigin: show }),
  setShowFieldOrigin: (show) => set({ showFieldOrigin: show }),

  setLockedNode: (x, y, kind) => set((state) => {
    const next = new Map(state.lockedNodes);
    next.set(`${x},${y}`, kind);
    return { lockedNodes: next, debugStale: state.debugSnapshot !== null };
  }),

  removeLockedNode: (x, y) => set((state) => {
    const key = `${x},${y}`;
    if (!state.lockedNodes.has(key)) return {};
    const next = new Map(state.lockedNodes);
    next.delete(key);
    return { lockedNodes: next, debugStale: state.debugSnapshot !== null };
  }),

  clearLockedNodes: () => set((state) => ({ lockedNodes: new Map<string, NodeLockKind>(), autoLockedNodes: new Set<string>(), debugStale: state.debugSnapshot !== null })),

  setError: (msg) => set({ error: msg }),

  loadProject: (file) => {
    const cfg = file.tessellation.config;

    // Derive all tessellation fields (same logic as setTessellationConfig)
    const { kind, squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(cfg);
    const hexOrientation = (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
      ? ((cfg as { orientation?: HexOrientation }).orientation ?? DEFAULT_HEX_ORI)
      : get().hexOrientation;
    const triOrientation = (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom")
      ? ((cfg as { orientation?: TriOrientation }).orientation ?? DEFAULT_TRI_ORI)
      : get().triOrientation;
    const isCustomConfig = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
    const currentFreeFieldPoints = get().freeFieldPoints;
    const freeFieldPoints = isCustomConfig
      ? {
          ...currentFreeFieldPoints,
          [kind]: new Set<number>((cfg as { points?: [number, number][] }).points?.map(([x, y]) => encodePoint(x, y)) ?? []),
        }
      : currentFreeFieldPoints;
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    const restoredSavedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>> =
      Object.fromEntries(file.tessellation.savedConfigs.map(c => [c.type, c]));
    const savedConfigs = isCustomConfig ? restoredSavedConfigs : { ...restoredSavedConfigs, [cfg.type]: cfg };
    const previewState = buildPreviewState(kind, hexOrientation, triOrientation);

    // Recompute auto-locked nodes
    const restoredPresetConnections = new Map(file.presets.connections);
    const autoLockedNodes = _recomputeAutoLock({
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
      selectedStrategies: file.quality.selectedStrategies,
      checkParams: file.quality.checkParams,
      strategyParams: file.quality.strategyParams,
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
      nodes: [],
      edges: [],
      start: null,
      finish: null,
      navNodes: [],
      navEdges: [],
      components: [],
      warnings: [],
      nodeStats: null,
      edgeStats: null,
      routeInfo: null,
      selectedNode: null,
      generationStatus: "idle" as const,
      postEditAutoConfirm: file.ui.postEditAutoConfirm,
      postEditDraftEdges: null,
      postEditDraftMeta: null,
      postEditEdges: null,
      postEditMeta: null,
      postEditAnalytics: null,
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
      fieldDirty: false,
      presetsDirty: false,
      mazeDirty: false,
      _generatedStart: null,
      _generatedFinish: null,
      _postEditRequestId: 0,
      showMaze: true,
      // analytics overlays
      showMazeOverlay: file.analytics.showMazeOverlay,
      showComponentsOverlay: file.analytics.showComponentsOverlay,
      showGraphOverlay: file.analytics.showGraphOverlay,
      showNavGraphOverlay: file.analytics.showNavGraphOverlay,
      showRouteOverlay: file.analytics.showRouteOverlay,
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

    // Generate maze with saved seed (deterministic) — _generateWithSeed reads debugMode from store
    // skipConfirmPostEdit=true to avoid double confirmPostEdit (we call it ourselves below)
    set({ lastUsedSeed: file.generation.seed });
    _generateWithSeed(file.generation.seed, get, set, true);

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

function mergeOrientation(current: TessellationConfig, orientation: HexOrientation | TriOrientation): TessellationConfig {
  return { ...current, orientation } as TessellationConfig;
}

type StoreSet = (partial: Partial<MazeState & MazeActions> | ((s: MazeState & MazeActions) => Partial<MazeState & MazeActions>)) => void;
type StoreGet = () => MazeState & MazeActions;

function _recomputeAutoLock(state: MazeState): Set<string> {
  if (!state.autoLock) return new Set<string>();
  const activeTessellation: TessellationConfig = state.isEditingField
    ? buildFreeConfig(state.tessellationKind, state.fieldPoints, state.hexOrientation, state.triOrientation)
    : state.tessellationConfig;
  const customPts = state.isEditingField ? state.fieldPoints : undefined;
  return computeAutoLockedNodes(state.presetConnections, activeTessellation, customPts);
}


function fieldConfigToWasm(cfg: TessellationConfig): WasmTessellationConfig {
  const t = cfg.type;
  const tessellation_type = t.startsWith("hex") ? "hex" as const
    : (t.startsWith("tri") || t.startsWith("triangle")) ? "tri" as const
    : "square" as const;
  const points = configAllCells(cfg);
  return { tessellation_type, points };
}

function _buildGenerateConfig(state: MazeState & MazeActions): GenerateConfig | null {
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const strategies: Record<string, { id: string; params: Record<string, string> }> = {};
  for (const [kind, strategyId] of Object.entries(state.selectedStrategies)) {
    if (!strategyId) continue;
    const descriptor = state.availableStrategies.find((s) => s.id === strategyId);
    const paramOverrides = state.strategyParams[strategyId] ?? {};
    const params: Record<string, string> = {};
    if (descriptor) {
      for (const p of descriptor.params) {
        if (paramOverrides[p.id] !== undefined) params[p.id] = paramOverrides[p.id];
      }
    }
    strategies[kind] = { id: strategyId, params };
  }
  const activeTessellation: TessellationConfig = state.isEditingField
    ? buildFreeConfig(state.tessellationKind, state.fieldPoints, state.hexOrientation, state.triOrientation)
    : state.tessellationConfig;
  const customPts = state.isEditingField ? state.fieldPoints : undefined;
  const invalidKeys = computeInvalidKeys(state.presetConnections, activeTessellation, customPts);
  const validPresets = Array.from(state.presetConnections.values())
    .filter(e => e.state !== "undefined" && !invalidKeys.has(`${e.from[0]},${e.from[1]}-${e.to[0]},${e.to[1]}`))
    .map(e => ({ from: e.from, to: e.to, state: e.state as import("../wasm/types").PresetConnectionState }));
  const lockedEntries = new Map(state.lockedNodes);
  for (const key of state.autoLockedNodes) {
    if (!lockedEntries.has(key)) lockedEntries.set(key, "both");
  }
  const locked_nodes = Array.from(lockedEntries.entries()).map(([key, kind]) => {
    const [x, y] = key.split(",").map(Number);
    return { point: [x, y] as [number, number], kind };
  });
  return {
    tessellation: fieldConfigToWasm(activeTessellation),
    checks: state.selectedChecks,
    strategies,
    check_params: state.checkParams,
    initial: state.initialConfig,
    elements: state.elementsConfig,
    preset_connections: validPresets,
    locked_nodes,
    ...(state.presetStart ? { preset_start: state.presetStart } : {}),
    ...(state.presetGenSource ? { preset_gen_source: state.presetGenSource } : {}),
    ...(state.presetFinish ? { preset_finish: state.presetFinish } : {}),
  };
}

function _generateWithSeed(seed: number, get: StoreGet, set: StoreSet, skipConfirmPostEdit = false): void {
  const state = get();
  if (state.isEditingField && state.fieldPoints.size < 2) {
    set({ error: "Free field requires at least 2 cells", generationStatus: "error" });
    return;
  }
  const activeTessellation: TessellationConfig = state.isEditingField
    ? buildFreeConfig(state.tessellationKind, state.fieldPoints, state.hexOrientation, state.triOrientation)
    : state.tessellationConfig;
  const debugMode = state.debugMode;
  const config = _buildGenerateConfig(state);
  if (!config) return;
  if (debugMode) config.debug = true;
  try {
    const snapshot = generateMaze(seed, config);
    let debugSnapshot: GenerationStepsSnapshot | null = null;
    if (debugMode && snapshot.debug_steps.length > 0) {
      // Step 0 is a client-side synthetic "empty graph" state; WASM only emits steps where edges were added.
      const steps = [{ edges: [], active_nodes: [], current_src: null }, ...snapshot.debug_steps];
      debugSnapshot = { nodes: snapshot.nodes, steps };
    }
    const lastStep = debugSnapshot ? debugSnapshot.steps.length - 1 : 0;
    set({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      start: snapshot.start,
      finish: snapshot.finish,
      navNodes: snapshot.nav_nodes,
      navEdges: snapshot.nav_edges,
      components: snapshot.components,
      selectedNode: null,
      warnings: snapshot.warnings,
      error: null,
      activeTessellationConfig: activeTessellation,
      nodeStats: snapshot.node_stats,
      edgeStats: snapshot.edge_stats,
      routeInfo: snapshot.route_info,
      generationStatus: "done",
      debugSnapshot,
      debugStep: lastStep,
      debugStale: false,
      postEditDraftEdges: buildPostEditDraftEdgesFromGenerated(snapshot.edges),
      postEditEdges: null,
      postEditMeta: null,
      postEditAnalytics: null,
      postEditDraftMeta: { start: snapshot.start, finish: snapshot.finish },
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
      mazeDirty: true,
      _generatedStart: snapshot.start,
      _generatedFinish: snapshot.finish,
    });
    if (!skipConfirmPostEdit) void useMazeStore.getState().confirmPostEdit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({ error: msg, generationStatus: "error" });
  }
}

export { decodePoint };

type StoreState = ReturnType<typeof useMazeStore.getState>;

function _applyDefaultEdgeState(
  state: StoreState,
  newDefault: "undefined" | "wall" | "passage",
): Map<string, PresetConnectionEntry> {
  const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0 ? state.fieldPoints : undefined;
  const cells = resolveCells(state.tessellationConfig, customPts);
  const cellSet = buildCellSet(cells);

  // Remove all existing default entries, then add new ones if needed
  const presetConnections = new Map(state.presetConnections);
  for (const [key, entry] of presetConnections) {
    if (entry.source === "default") presetConnections.delete(key);
  }

  if (newDefault === "undefined") return presetConnections;

  for (const [x, y] of cells) {
    const { offsets } = getNeighborData(state.tessellationConfig, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      const [from, to] = canonicalize([x, y], [nx, ny]);
      if (from[0] !== x || from[1] !== y) continue; // only process edge once (owner = canonical-lesser cell)
      const key = edgeKey(from, to);
      if (!presetConnections.has(key)) {
        presetConnections.set(key, { from, to, state: newDefault, source: "default" });
      }
    }
  }
  return presetConnections;
}
