import { create } from "zustand";
import { generateMaze } from "../wasm/mazeService";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto } from "../wasm/types";

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
}

interface MazeActions {
  setSeed: (seed: number) => void;
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze" | "showGraphOverlay" | "showNavOverlay" | "showComponents", value: boolean) => void;
  selectNode: (id: number | null) => void;
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

  setSeed: (seed) => set({ seed, error: null }),
  setWidth: (width) => set({ width, error: null }),
  setHeight: (height) => set({ height, error: null }),

  generate: () => {
    const { seed, width, height } = get();
    try {
      const snapshot = generateMaze(seed, width, height);
      set({ nodes: snapshot.nodes, edges: snapshot.edges, start: snapshot.start, finish: snapshot.finish, navNodes: snapshot.nav_nodes, navEdges: snapshot.nav_edges, components: snapshot.components, selectedNode: null, warnings: snapshot.warnings, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  reset: () => set({ nodes: [], edges: [], start: null, finish: null, navNodes: [], navEdges: [], components: [], selectedNode: null, warnings: [], error: null }),

  setDebugFlag: (key, value) => set({ [key]: value }),

  selectNode: (id) => set({ selectedNode: id }),
}));
