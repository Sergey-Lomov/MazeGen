import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, TessellationConfig } from "../wasm/types";

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
  selectedNode: number | null;
  warnings: string[];
  error: string | null;
  availableChecks: CheckDescriptor[];
  availableStrategies: StrategyDescriptor[];
  selectedChecks: string[];
  selectedStrategies: Record<string, string>;
  /** strategyParams[strategyId][paramId] = raw string value */
  strategyParams: Record<string, Record<string, string>>;
}

interface MazeActions {
  setSeed: (seed: number) => void;
  setTessellationConfig: (cfg: TessellationConfig) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze" | "showGraphOverlay" | "showNavOverlay" | "showComponents", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => void;
  toggleCheck: (id: string) => void;
  setStrategy: (issueKind: string, strategyId: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
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
  selectedNode: null,
  warnings: [],
  error: null,
  availableChecks: [],
  availableStrategies: [],
  selectedChecks: [],
  selectedStrategies: {},
  strategyParams: {},

  setSeed: (seed) => set({ seed, error: null }),
  setTessellationConfig: (cfg) => set({ tessellationConfig: cfg, error: null }),

  loadRegistry: () => {
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
  },

  generate: () => {
    const { seed, tessellationConfig, selectedChecks, selectedStrategies, strategyParams, availableStrategies } = get();
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
      });
      set({ nodes: snapshot.nodes, edges: snapshot.edges, start: snapshot.start, finish: snapshot.finish, navNodes: snapshot.nav_nodes, navEdges: snapshot.nav_edges, components: snapshot.components, selectedNode: null, warnings: snapshot.warnings, error: null, activeTessellationConfig: tessellationConfig });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  reset: () => set({ nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [], selectedNode: null, warnings: [], error: null }),

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
}));
