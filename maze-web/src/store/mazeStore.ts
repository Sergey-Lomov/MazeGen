import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies, getAvailableElements } from "../wasm/mazeService";
import { initWasm } from "../wasm/wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, TessellationConfig, ElementDescriptors } from "../wasm/types";

function defaultVertexWeights(elements: ElementDescriptors): number[] {
  const last = elements.vertex_elements[elements.vertex_elements.length - 1];
  const maxDegree = last?.degree ?? 0;
  const arr = new Array(maxDegree + 1).fill(0);
  for (const el of elements.vertex_elements) arr[el.degree] = 1.0;
  return arr;
}

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
  vertexWeights: number[];
  edgeWeights: { standard: number; one_way: number };
  cycleProb: number;
  availableElements: ElementDescriptors | null;
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
  setVertexWeight: (degree: number, weight: number) => void;
  setEdgeWeight: (id: "standard" | "one_way", weight: number) => void;
  setCycleProb: (prob: number) => void;
  loadElements: (tessellationType: string) => void;
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
  vertexWeights: [],
  edgeWeights: { standard: 1.0, one_way: 0.0417 },
  cycleProb: 0.0,
  availableElements: null,

  setSeed: (seed) => set({ seed, error: null }),
  setTessellationConfig: (cfg) => set({ tessellationConfig: cfg, error: null }),

  loadRegistry: () => {
    initWasm().then(() => {
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
      const tessellationType = get().tessellationConfig.type;
      const availableElements = getAvailableElements(tessellationType);
      const prevWeights = get().vertexWeights;
      const defaults = defaultVertexWeights(availableElements);
      const vertexWeights = prevWeights.length === defaults.length ? prevWeights : defaults;
      set({ availableChecks: checks, availableStrategies: strategies, selectedChecks, selectedStrategies, availableElements, vertexWeights });
    });
  },

  generate: () => {
    const { seed, tessellationConfig, selectedChecks, selectedStrategies, strategyParams, availableStrategies, vertexWeights, edgeWeights, cycleProb } = get();
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
        elements: {
          vertex_weights: vertexWeights,
          cycle_prob: cycleProb,
          one_way_weight: edgeWeights.one_way,
          standard_weight: edgeWeights.standard,
        },
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

  setVertexWeight: (degree, weight) => set((state) => {
    const next = [...state.vertexWeights];
    next[degree] = weight;
    return { vertexWeights: next };
  }),

  setEdgeWeight: (id, weight) => set((state) => ({
    edgeWeights: { ...state.edgeWeights, [id]: weight },
  })),

  setCycleProb: (prob) => set({ cycleProb: Math.min(1, Math.max(0, prob)) }),

  loadElements: (tessellationType) => {
    const availableElements = getAvailableElements(tessellationType);
    set((state) => {
      const defaults = defaultVertexWeights(availableElements);
      const vertexWeights = state.vertexWeights.length === defaults.length
        ? state.vertexWeights
        : defaults;
      return { availableElements, vertexWeights };
    });
  },
}));
