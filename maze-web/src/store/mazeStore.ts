import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, TessellationConfig, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto } from "../wasm/types";

interface MazeState {
  seed: number;
  tessellationConfig: TessellationConfig;
  activeTessellationConfig: TessellationConfig;
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
  availableChecks: CheckDescriptor[];
  availableStrategies: StrategyDescriptor[];
  selectedChecks: string[];
  selectedStrategies: Record<string, string>;
  /** strategyParams[strategyId][paramId] = raw string value */
  strategyParams: Record<string, Record<string, string>>;
  initialConfig: InitialGenerationConfig;
  elementsConfig: ElementsConfig;
  nodeStats: NodeStatsDto | null;
  edgeStats: SpatialEdgeStatsDto | null;
  routeInfo: RouteInfoDto | null;
}

interface MazeActions {
  setSeed: (seed: number) => void;
  setTessellationConfig: (cfg: TessellationConfig) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze" | "showGraphOverlay" | "showNavOverlay" | "showComponents" | "showRoute", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => Promise<void>;
  toggleCheck: (id: string) => void;
  setStrategy: (issueKind: string, strategyId: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
  setGenerationParam: (key: keyof GenerationParams, value: number) => void;
  setEdgeBasedParam: (key: keyof EdgeBasedParams, value: number) => void;
  setGenerationMethod: (method: string) => void;
  setElementsParam: (key: keyof ElementsConfig, value: number) => void;
  setDebugState: (nodes: NodeDto[], edges: EdgeDto[], cfg: TessellationConfig) => void;
}

export const useMazeStore = create<MazeState & MazeActions>((set, get) => ({
  seed: 42,
  tessellationConfig: { type: "square", width: 10, height: 10 },
  activeTessellationConfig: { type: "square", width: 10, height: 10 },
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
  availableChecks: [],
  availableStrategies: [],
  selectedChecks: [],
  selectedStrategies: {},
  strategyParams: {},
  initialConfig: { method: "custom_vertex_based" as const, depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
  elementsConfig: { one_way_chance: 0.04 },
  nodeStats: null,
  edgeStats: null,
  routeInfo: null,

  setSeed: (seed) => set({ seed, error: null }),
  setTessellationConfig: (cfg) => set({ tessellationConfig: cfg, error: null }),

  loadRegistry: () => {
    return initWasm().then(() => {
      const checks = getAvailableChecks();
      const strategies = getAvailableStrategies();
      const selectedChecks = checks.map((c) => c.id);
      const selectedStrategies: Record<string, string> = {};
      for (const check of checks) {
        for (const kind of check.issue_kinds) {
          const match = strategies.find((s) => s.handles === kind);
          if (match) selectedStrategies[kind] = match.id;
        }
      }
      set({ availableChecks: checks, availableStrategies: strategies, selectedChecks, selectedStrategies });
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load WASM registry:", msg);
      set({ error: msg });
    });
  },

  generate: () => {
    const { seed, tessellationConfig, selectedChecks, selectedStrategies, strategyParams, availableStrategies, initialConfig, elementsConfig } = get();
    try {
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
      const snapshot = generateMaze(seed, {
        tessellation: tessellationConfig,
        checks: selectedChecks,
        strategies,
        initial: initialConfig,
        elements: elementsConfig,
      });
      set({ nodes: snapshot.nodes, edges: snapshot.edges, start: snapshot.start, finish: snapshot.finish, navNodes: snapshot.nav_nodes, navEdges: snapshot.nav_edges, components: snapshot.components, selectedNode: null, warnings: snapshot.warnings, error: null, activeTessellationConfig: tessellationConfig, nodeStats: snapshot.node_stats, edgeStats: snapshot.edge_stats, routeInfo: snapshot.route_info });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  reset: () => set({ nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [], selectedNode: null, warnings: [], error: null, nodeStats: null, edgeStats: null, routeInfo: null }),

  setDebugFlag: (key, value) => set({ [key]: value }),

  selectNode: (id) => set({ selectedNode: id }),

  toggleCheck: (id) => set((state) => {
    const selected = state.selectedChecks.includes(id)
      ? state.selectedChecks.filter((c) => c !== id)
      : [...state.selectedChecks, id];
    return { selectedChecks: selected };
  }),

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

  setDebugState: (nodes, edges, cfg) => set({
    nodes,
    edges,
    start: null,
    finish: null,
    navNodes: [],
    navEdges: [],
    components: [],
    selectedNode: null,
    warnings: [],
    error: null,
    nodeStats: null,
    edgeStats: null,
    routeInfo: null,
    activeTessellationConfig: cfg,
  }),
}));
