import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, GraphAnalyticsDto, GenerationStepsSnapshot, NodeLockKind, IssueDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PresetConnectionEntry, PresetConnectionTool } from "../pixi/presetConnectionsUtils";

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
  graphAnalytics: GraphAnalyticsDto;
  issues: IssueDto[];
}

export type TessellationKind = "square" | "hex" | "triangle";
export type SquareShape = "rect" | "free";
export type HexShape = "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive = "point" | "square_rect" | "hex_parallelogram" | "hex_hexagon" | "tri_rect" | "tri_triangle" | "tri_hexagon";
export type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation" | "post_edit" | "analytics";

export const DEFAULT_HEX_ORI: HexOrientation = "flat_top";
export const DEFAULT_TRI_ORI: TriOrientation = "r0";

export interface TessellationState {
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
  showFieldOverlay: boolean;
  fieldEditMode: "default" | "custom";
  fieldPrimitive: FieldPrimitive;
  showFieldOrigin: boolean;
  /** True after any field setup change since the last confirmTessellation. */
  fieldDirty: boolean;
}

export interface TessellationActions {
  setSeed: (seed: number) => void;
  // Preview actions — only change preview, not confirmed
  setPreviewKind: (kind: TessellationKind) => void;
  setPreviewHexOrientation: (orientation: HexOrientation) => void;
  setPreviewTriOrientation: (orientation: TriOrientation) => void;
  // Confirm — copies preview -> confirmed, triggers confirmed-dependent state
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
  addFieldPoint: (x: number, y: number) => void;
  removeFieldPoint: (x: number, y: number) => void;
  addFieldPoints: (cells: [number, number][]) => void;
  removeFieldPoints: (cells: [number, number][]) => void;
  clearFieldPoints: () => void;
  setShowFieldOverlay: (show: boolean) => void;
  setFieldEditMode: (mode: "default" | "custom") => void;
  setFieldPrimitive: (p: FieldPrimitive) => void;
  setShowFieldOrigin: (show: boolean) => void;
}

export interface PresetConnectionsState {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetConnectionsTool: PresetConnectionTool;
  defaultEdgeState: "undefined" | "wall" | "passage";
  presetStart: [number, number] | null;
  presetFinish: [number, number] | null;
  presetGenSource: [number, number] | null;
  highlightInvalidPresets: boolean;
  highlightIsolatedNodes: boolean;
  showPresetOrigin: boolean;
  /** Locked nodes: key = "x,y", value = lock kind */
  lockedNodes: Map<string, NodeLockKind>;
  autoLock: boolean;
  /** Auto-locked nodes (fully-defined cells): key = "x,y". Always lock_both. */
  autoLockedNodes: Set<string>;
  /** True after any preset connection change since the last confirmTessellation. */
  presetsDirty: boolean;
}

export interface PresetConnectionsActions {
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
  setLockedNode: (x: number, y: number, kind: NodeLockKind) => void;
  removeLockedNode: (x: number, y: number) => void;
  clearLockedNodes: () => void;
  setAutoLock: (v: boolean) => void;
}

export interface GenerationState {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  graphAnalytics: GraphAnalyticsDto | null;
  showNodeIds: boolean;
  showCoords: boolean;
  showMaze: boolean;
  selectedNode: number | null;
  issues: IssueDto[];
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
  /** True after the maze has been generated since the last confirmTessellation. */
  mazeDirty: boolean;
}

export interface GenerationActions {
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
  setRandomSeed: (v: boolean) => void;
  setOpenCard: (card: FeatureId) => void;
  setDebugMode: (v: boolean) => void;
  setDebugStep: (step: number) => void;
  setDebugAutoPlayDelay: (ms: number) => void;
  setShowDebugFrontier: (v: boolean) => void;
  regenerate: () => void;
  setError: (msg: string | null) => void;
}

export interface AnalyticsOverlayState {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showPureCyclesOverlay: boolean;
  showRouteOverlay: boolean;
  /** Base-graph [from, to] edges of the issue loops currently hovered in IssuesBlock. */
  hoveredIssueLoopEdges: [number, number][] | null;
}

export interface AnalyticsOverlayActions {
  setShowMazeOverlay: (v: boolean) => void;
  setShowComponentsOverlay: (v: boolean) => void;
  setShowGraphOverlay: (v: boolean) => void;
  setShowNavGraphOverlay: (v: boolean) => void;
  setShowPureCyclesOverlay: (v: boolean) => void;
  setShowRouteOverlay: (v: boolean) => void;
  setHoveredIssueLoopEdges: (edges: [number, number][] | null) => void;
}

export interface PostEditState {
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
}

export interface PostEditActions {
  setPostEditAutoConfirm: (v: boolean) => void;
  setPostEditTool: (tool: PostEditTool) => void;
  applyPostEditTool: (edgeKey: string, from: number, to: number) => void;
  setPostEditEndpoint: (kind: "start" | "finish", nodeId: number) => void;
  clearPostEditEndpoint: (kind: "start" | "finish") => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
}

export interface RootActions {
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

export type MazeState = TessellationState & PresetConnectionsState & GenerationState & AnalyticsOverlayState & PostEditState;
export type MazeActions = RootActions & TessellationActions & PresetConnectionsActions & GenerationActions & AnalyticsOverlayActions & PostEditActions;
export type MazeStore = MazeState & MazeActions;
