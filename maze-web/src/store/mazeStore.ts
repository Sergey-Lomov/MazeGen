import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, TessellationConfig, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto } from "../wasm/types";
import { encodePoint, decodePoint } from "../pixi/tessellationProjection";
import type { PresetConnectionEntry, PresetConnectionTool } from "../pixi/presetConnectionsUtils";
import { applyTool, computeInvalidKeys } from "../pixi/presetConnectionsUtils";
import { configAllCells } from "../pixi/tessellationCells";

export type TessellationKind = "square" | "hex" | "triangle";
export type SquareShape = "rect" | "free";
export type HexShape = "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive = "point" | "square_rect" | "hex_parallelogram" | "hex_hexagon" | "tri_rect" | "tri_triangle" | "tri_hexagon";

const DEFAULT_HEX_ORI: HexOrientation = "flat_top";
const DEFAULT_TRI_ORI: TriOrientation = "r0";

interface MazeState {
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
  showGraphOverlay: boolean;
  showNavOverlay: boolean;
  showComponents: boolean;
  showRoute: boolean;
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
  fieldSetupOpen: boolean;
  fieldEditMode: "default" | "custom";
  fieldPrimitive: FieldPrimitive;
  presetConnectionsOpen: boolean;
  presetConnections: Map<string, PresetConnectionEntry>;
  presetConnectionsTool: PresetConnectionTool;
  presetStart: [number, number] | null;
  presetFinish: [number, number] | null;
  highlightInvalidPresets: boolean;
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
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze" | "showGraphOverlay" | "showNavOverlay" | "showComponents" | "showRoute", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => Promise<void>;
  addCheck: (id: string) => void;
  removeCheck: (id: string) => void;
  setCheckParam: (checkId: string, paramId: string, value: string) => void;
  setStrategy: (issueKind: string, strategyId: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
  setGenerationParam: (key: keyof GenerationParams, value: number) => void;
  setEdgeBasedParam: (key: keyof EdgeBasedParams, value: number) => void;
  setGenerationMethod: (method: string) => void;
  setElementsParam: (key: keyof ElementsConfig, value: number) => void;
  setDebugState: (nodes: NodeDto[], edges: EdgeDto[], cfg: TessellationConfig) => void;
  addFieldPoint: (x: number, y: number) => void;
  removeFieldPoint: (x: number, y: number) => void;
  addFieldPoints: (cells: [number, number][]) => void;
  removeFieldPoints: (cells: [number, number][]) => void;
  clearFieldPoints: () => void;
  setShowFieldOverlay: (show: boolean) => void;
  setFieldSetupOpen: (open: boolean) => void;
  setFieldEditMode: (mode: "default" | "custom") => void;
  setFieldPrimitive: (p: FieldPrimitive) => void;
  setPresetConnectionsOpen: (open: boolean) => void;
  setPresetConnectionsTool: (tool: PresetConnectionTool) => void;
  applyPresetConnectionsTool: (key: string, from: [number, number], to: [number, number]) => void;
  applyPresetConnectionsReset: (key: string) => void;
  clearInvalidPresetConnections: () => void;
  resetPresetConnections: () => void;
  setPresetStart: (cell: [number, number] | null) => void;
  setPresetFinish: (cell: [number, number] | null) => void;
  setHighlightInvalidPresets: (highlight: boolean) => void;
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
    return { type: "square", width: base?.width ?? 10, height: base?.height ?? 10 };
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
  if (kind === "square") return { type: "square", width: 10, height: 10 };
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
  previewTessellationConfig: { type: "square", width: 10, height: 10 },
  squareShape: "rect",
  hexShape: "parallelogram",
  triangleShape: "rect",
  savedConfigs: {},
  tessellationConfig: { type: "square", width: 10, height: 10 },
  activeTessellationConfig: { type: "square", width: 10, height: 10 },
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
  showGraphOverlay: true,
  showNavOverlay: false,
  showComponents: false,
  showRoute: false,
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
  initialConfig: { method: "custom_vertex_based" as const, depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
  elementsConfig: { one_way_chance: 0.04 },
  nodeStats: null,
  edgeStats: null,
  routeInfo: null,
  showFieldOverlay: true,
  fieldSetupOpen: false,
  fieldEditMode: "default",
  fieldPrimitive: "point",
  presetConnectionsOpen: false,
  presetConnections: new Map<string, PresetConnectionEntry>(),
  presetConnectionsTool: "wall" as PresetConnectionTool,
  presetStart: null,
  presetFinish: null,
  highlightInvalidPresets: false,

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
    const hexShape: HexShape = "parallelogram";
    const triangleShape: TriangleShape = "rect";
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
        presetStart: null,
        presetFinish: null,
        fieldEditMode: "default" as const,
      } : {}),
    };
  }),

  setTessellationKind: (kind) => set((state) => {
    if (kind === state.tessellationKind) return {};
    const squareShape: SquareShape = "rect";
    const hexShape: HexShape = "parallelogram";
    const triangleShape: TriangleShape = "rect";
    const cfg = buildPredefinedConfig(kind, hexShape, triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    const freeFieldPoints = { ...state.freeFieldPoints, [kind]: new Set<number>() };
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    return {
      tessellationKind: kind, squareShape, hexShape, triangleShape,
      tessellationConfig: cfg, isEditingField, fieldPoints, freeFieldPoints,
      nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [],
      selectedNode: null, warnings: [], nodeStats: null, edgeStats: null, routeInfo: null,
      error: null,
    };
  }),

  setSquareShape: (shape) => set((state) => {
    if (shape === state.squareShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, shape, state.hexShape, state.triangleShape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("square", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("square", state.hexShape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { squareShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, error: null };
  }),

  setHexShape: (shape) => set((state) => {
    if (shape === state.hexShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, state.squareShape, shape, state.triangleShape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("hex", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("hex", shape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { hexShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, error: null };
  }),

  setTriangleShape: (shape) => set((state) => {
    if (shape === state.triangleShape) return {};
    const { isEditingField, fieldPoints } = deriveEditState(state.tessellationKind, state.squareShape, state.hexShape, shape, state.freeFieldPoints);
    const cfg = isEditingField
      ? buildFreeConfig("triangle", fieldPoints, state.hexOrientation, state.triOrientation)
      : buildPredefinedConfig("triangle", state.hexShape, shape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { triangleShape: shape, tessellationConfig: cfg, isEditingField, fieldPoints, error: null };
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
    return { hexOrientation: orientation, tessellationConfig, savedConfigs, activeTessellationConfig, error: null };
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
    return { triOrientation: orientation, tessellationConfig, savedConfigs, activeTessellationConfig, error: null };
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
    set({ tessellationConfig: cfg, tessellationKind: kind, squareShape, hexShape, triangleShape, hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints, savedConfigs, error: null });
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
    const { seed, tessellationConfig, tessellationKind, isEditingField, fieldPoints, hexOrientation, triOrientation, selectedChecks, selectedStrategies, strategyParams, availableStrategies, initialConfig, elementsConfig, presetConnections, checkParams } = get();
    try {
      if (isEditingField && fieldPoints.size < 2) {
        set({ error: "Free field requires at least 2 cells" });
        return;
      }

      const strategies: Record<string, { id: string; params: Record<string, string> }> = {};
      for (const [kind, strategyId] of Object.entries(selectedStrategies)) {
        if (!strategyId) continue;
        const descriptor = availableStrategies.find((s) => s.id === strategyId);
        const paramOverrides = strategyParams[strategyId] ?? {};
        const params: Record<string, string> = {};
        if (descriptor) {
          for (const p of descriptor.params) {
            if (paramOverrides[p.id] !== undefined) {
              params[p.id] = paramOverrides[p.id];
            }
          }
        }
        strategies[kind] = { id: strategyId, params };
      }

      let activeTessellation: TessellationConfig = tessellationConfig;
      if (isEditingField) {
        activeTessellation = buildFreeConfig(tessellationKind, fieldPoints, hexOrientation, triOrientation);
      }

      const customPts = isEditingField ? fieldPoints : undefined;
      const invalidKeys = computeInvalidKeys(presetConnections, activeTessellation, customPts);
      const validPresets = Array.from(presetConnections.values())
        .filter(e => !invalidKeys.has(`${e.from[0]},${e.from[1]}-${e.to[0]},${e.to[1]}`))
        .map(e => ({ from: e.from, to: e.to, state: e.state }));

      const snapshot = generateMaze(seed, {
        tessellation: activeTessellation,
        checks: selectedChecks,
        strategies,
        check_params: checkParams,
        initial: initialConfig,
        elements: elementsConfig,
        preset_connections: validPresets,
      });
      set({ nodes: snapshot.nodes, edges: snapshot.edges, start: snapshot.start, finish: snapshot.finish, navNodes: snapshot.nav_nodes, navEdges: snapshot.nav_edges, components: snapshot.components, selectedNode: null, warnings: snapshot.warnings, error: null, activeTessellationConfig: activeTessellation, nodeStats: snapshot.node_stats, edgeStats: snapshot.edge_stats, routeInfo: snapshot.route_info });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  reset: () => set({ nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [], selectedNode: null, warnings: [], error: null, nodeStats: null, edgeStats: null, routeInfo: null }),

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
    };
  }),

  removeCheck: (id) => set((state) => ({
    selectedChecks: state.selectedChecks.filter((c) => c !== id),
  })),

  setCheckParam: (checkId, paramId, value) => set((state) => ({
    checkParams: {
      ...state.checkParams,
      [checkId]: { ...(state.checkParams[checkId] ?? {}), [paramId]: value },
    },
  })),

  setStrategy: (issueKind, strategyId) => set((state) => ({
    selectedStrategies: { ...state.selectedStrategies, [issueKind]: strategyId },
  })),

  setStrategyParam: (strategyId, paramId, value) => set((state) => ({
    strategyParams: {
      ...state.strategyParams,
      [strategyId]: { ...(state.strategyParams[strategyId] ?? {}), [paramId]: value },
    },
  })),

  setGenerationParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_vertex_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value } };
  }),

  setEdgeBasedParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_edge_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value } };
  }),

  setGenerationMethod: (method) => {
    const defaults: Record<string, InitialGenerationConfig> = {
      custom_vertex_based: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
      custom_edge_based: { method: "custom_edge_based", corridor_length: 0.5, branching: 0.5, locality: 0.0, directionality: 0.0 },
      recursive_backtracker: { method: "recursive_backtracker" },
      wilson_algorithm: { method: "wilson_algorithm" },
      kruskal_algorithm: { method: "kruskal_algorithm" },
    };
    const next = defaults[method];
    if (!next) {
      console.error(`Unknown generation method: ${method}`);
      return;
    }
    set({ initialConfig: next });
  },

  setElementsParam: (key, value) => set((state) => ({
    elementsConfig: { ...state.elementsConfig, [key]: value },
  })),

  setDebugState: (nodes, edges, cfg) => set((state) => {
    const { kind, squareShape, hexShape, triangleShape } = kindAndShapeFromConfig(cfg);
    const hexOrientation = (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom")
      ? ((cfg as { orientation?: HexOrientation }).orientation ?? "flat_top")
      : "flat_top";
    const triOrientation = (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom")
      ? ((cfg as { orientation?: TriOrientation }).orientation ?? "r0")
      : "r0";
    const isCustom = cfg.type === "square_custom" || cfg.type === "hex_custom" || cfg.type === "tri_custom";
    const freeFieldPoints = isCustom
      ? {
          ...state.freeFieldPoints,
          [kind]: new Set<number>((cfg as { points?: [number, number][] }).points?.map(([x, y]) => encodePoint(x, y)) ?? []),
        }
      : state.freeFieldPoints;
    const { isEditingField, fieldPoints } = deriveEditState(kind, squareShape, hexShape, triangleShape, freeFieldPoints);
    return {
      nodes, edges,
      start: null, finish: null, navNodes: [], navEdges: [], components: [],
      selectedNode: null, warnings: [], error: null,
      nodeStats: null, edgeStats: null, routeInfo: null,
      tessellationKind: kind, squareShape, hexShape, triangleShape,
      hexOrientation, triOrientation, freeFieldPoints, isEditingField, fieldPoints,
      tessellationConfig: cfg, activeTessellationConfig: cfg,
      showFieldOverlay: isEditingField ? true : state.showFieldOverlay,
    };
  }),

  addFieldPoint: (x, y) => set((state) => {
    const key = encodePoint(x, y);
    if (state.fieldPoints.has(key)) return {};
    const fieldPoints = new Set(state.fieldPoints);
    fieldPoints.add(key);
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig };
  }),

  removeFieldPoint: (x, y) => set((state) => {
    const key = encodePoint(x, y);
    if (!state.fieldPoints.has(key)) return {};
    const fieldPoints = new Set(state.fieldPoints);
    fieldPoints.delete(key);
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig };
  }),

  setShowFieldOverlay: (show) => set({ showFieldOverlay: show }),

  setFieldSetupOpen: (open) => set({ fieldSetupOpen: open }),

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
      return { fieldEditMode: mode, isEditingField: true, fieldPoints, freeFieldPoints, tessellationConfig, fieldPrimitive: "point" };
    }
    const cfg = buildPredefinedConfig(state.tessellationKind, state.hexShape, state.triangleShape, state.hexOrientation, state.triOrientation, state.savedConfigs);
    return { fieldEditMode: mode, isEditingField: false, tessellationConfig: cfg, fieldPrimitive: "point" };
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
    return { fieldPoints, freeFieldPoints, tessellationConfig };
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
    return { fieldPoints, freeFieldPoints, tessellationConfig };
  }),

  clearFieldPoints: () => set((state) => {
    const fieldPoints = new Set<number>();
    const freeFieldPoints = { ...state.freeFieldPoints, [state.tessellationKind]: fieldPoints };
    const tessellationConfig = buildFreeConfig(state.tessellationKind, fieldPoints, state.hexOrientation, state.triOrientation);
    return { fieldPoints, freeFieldPoints, tessellationConfig };
  }),

  setFieldPrimitive: (p) => set({ fieldPrimitive: p }),

  setPresetConnectionsOpen: (open) => set(open ? { presetConnectionsOpen: true } : { presetConnectionsOpen: false, highlightInvalidPresets: false }),

  setPresetConnectionsTool: (tool) => set({ presetConnectionsTool: tool }),

  applyPresetConnectionsTool: (key, from, to) => set((state) => ({
    presetConnections: applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool),
  })),

  clearInvalidPresetConnections: () => set((state) => {
    const customPts = state.isEditingField ? state.fieldPoints : undefined;
    const invalidKeys = computeInvalidKeys(state.presetConnections, state.tessellationConfig, customPts);
    const next = new Map(state.presetConnections);
    for (const key of invalidKeys) next.delete(key);
    return { presetConnections: next };
  }),

  resetPresetConnections: () => set({ presetConnections: new Map<string, PresetConnectionEntry>(), presetStart: null, presetFinish: null }),

  applyPresetConnectionsReset: (key) => set((state) => {
    if (!state.presetConnections.has(key)) return {};
    const next = new Map(state.presetConnections);
    next.delete(key);
    return { presetConnections: next };
  }),

  setPresetStart: (cell) => set({ presetStart: cell }),
  setPresetFinish: (cell) => set({ presetFinish: cell }),
  setHighlightInvalidPresets: (highlight) => set({ highlightInvalidPresets: highlight }),
}));

function mergeOrientation(current: TessellationConfig, orientation: HexOrientation | TriOrientation): TessellationConfig {
  return { ...current, orientation } as TessellationConfig;
}

export { decodePoint };
