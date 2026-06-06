import { create } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../wasm/mazeService";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor } from "../wasm/types";

interface MazeState {
  seed: number;
  width: number;
  height: number;
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
}

interface MazeActions {
  setSeed: (seed: number) => void;
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze" | "showGraphOverlay" | "showNavOverlay" | "showComponents", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => void;
  toggleCheck: (id: string) => void;
  setStrategy: (issueKind: string, strategyId: string) => void;
}

export const useMazeStore = create<MazeState & MazeActions>((set, get) => ({
  seed: 42,
  width: 10,
  height: 10,
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

  setSeed: (seed) => set({ seed, error: null }),
  setWidth: (width) => set({ width, error: null }),
  setHeight: (height) => set({ height, error: null }),

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
    const { seed, width, height, selectedChecks, selectedStrategies } = get();
    try {
      const activeStrategies = Object.fromEntries(
        Object.entries(selectedStrategies).filter(([, v]) => v !== "")
      );
      const snapshot = generateMaze(seed, width, height, {
        checks: selectedChecks,
        strategies: activeStrategies,
      });
      set({ nodes: snapshot.nodes, edges: snapshot.edges, start: snapshot.start, finish: snapshot.finish, navNodes: snapshot.nav_nodes, navEdges: snapshot.nav_edges, components: snapshot.components, selectedNode: null, warnings: snapshot.warnings, error: null });
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
}));
