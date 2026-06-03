import { create } from "zustand";
import { generateMaze } from "../wasm/mazeService";
import type { NodeDto, EdgeDto } from "../wasm/types";

interface MazeState {
  seed: number;
  width: number;
  height: number;
  nodes: NodeDto[];
  edges: EdgeDto[];
  showNodeIds: boolean;
  showCoords: boolean;
  selectedNode: number | null;
  error: string | null;
}

interface MazeActions {
  setSeed: (seed: number) => void;
  setWidth: (width: number) => void;
  setHeight: (height: number) => void;
  generate: () => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords", value: boolean) => void;
  selectNode: (id: number | null) => void;
}

export const useMazeStore = create<MazeState & MazeActions>((set, get) => ({
  seed: 42,
  width: 10,
  height: 10,
  nodes: [],
  edges: [],
  showNodeIds: false,
  showCoords: false,
  selectedNode: null,
  error: null,

  setSeed: (seed) => set({ seed, error: null }),
  setWidth: (width) => set({ width, error: null }),
  setHeight: (height) => set({ height, error: null }),

  generate: () => {
    const { seed, width, height } = get();
    try {
      const snapshot = generateMaze(seed, width, height);
      set({ nodes: snapshot.nodes, edges: snapshot.edges, selectedNode: null, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
    }
  },

  reset: () => set({ nodes: [], edges: [], selectedNode: null, error: null }),

  setDebugFlag: (key, value) => set({ [key]: value }),

  selectNode: (id) => set({ selectedNode: id }),
}));
