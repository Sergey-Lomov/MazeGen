import { emptyFreePoints } from "../store/storeHelpers";

export { emptyFreePoints };

export const mockSnapshot = {
  nodes: [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }],
  edges: [{ from: 0, to: 1 }],
  start: 0,
  finish: 1,
  issues: [],
  nav_nodes: [],
  nav_edges: [],
  graph_analytics: { node_count: 0, edge_count: 0, component_count: 0, cycle_count: 0, cycle_region_count: 0, node_component: {}, pure_cycle_node_ids: [], pure_cycle_edge_pairs: [] },
  node_stats: { dead_ends: 2, straight: 0, turns: 0, junctions: [] },
  edge_stats: { bidirectional: 0, one_way: 1, walls: 0 },
  route_info: null,
  debug_steps: [],
};

export function baseStoreState() {
  return {
    seed: 42,
    tessellationKind: "square" as const,
    squareShape: "rect" as const,
    hexShape: "parallelogram" as const,
    triangleShape: "rect" as const,
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
    tessellationConfig: { type: "square" as const, width: 10, height: 10 },
    activeTessellationConfig: { type: "square" as const, width: 10, height: 10 },
    freeFieldPoints: emptyFreePoints(),
    isEditingField: false,
    fieldPoints: new Set<number>(),
    nodes: [],
    edges: [],
    start: null,
    finish: null,
    showNodeIds: false,
    showCoords: false,
    showFieldOverlay: true,
    selectedNode: null,
    error: null,
    initialConfig: { method: "custom_vertex_based" as const, depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0 },
    elementsConfig: { one_way_chance: 0.04 },
    selectedChecks: [],
    selectedStrategies: {},
    strategyParams: {},
    checkParams: {},
    registryLoaded: false,
    availableChecks: [],
    availableStrategies: [],
  };
}

/** Free-field-editing state for a given kind, used by free field point mutation tests. */
export function freeFieldEditState(kind: "square" | "hex" | "triangle", pts: Set<number>) {
  const squareShape: "free" | "rect" = kind === "square" ? "free" : "rect";
  const hexShape: "free" | "parallelogram" = kind === "hex" ? "free" : "parallelogram";
  const triangleShape: "free" | "rect" = kind === "triangle" ? "free" : "rect";
  return {
    tessellationKind: kind,
    squareShape,
    hexShape,
    triangleShape,
    isEditingField: true,
    fieldPoints: pts,
    freeFieldPoints: { ...emptyFreePoints(), [kind]: pts },
    hexOrientation: "flat_top" as const,
    triOrientation: "r0" as const,
  };
}

/** State for hex-predefined-mode orientation tests: hexShape=parallelogram, other shapes=rect. */
export function hexPredefinedState(extra?: Record<string, unknown>) {
  return {
    tessellationKind: "hex" as const,
    hexShape: "parallelogram" as const,
    squareShape: "rect" as const,
    triangleShape: "rect" as const,
    hexOrientation: "flat_top" as const,
    freeFieldPoints: emptyFreePoints(),
    ...extra,
  };
}

/** State for triangle-predefined-mode orientation tests: triangleShape=rect, other shapes=rect/parallelogram. */
export function trianglePredefinedState(extra?: Record<string, unknown>) {
  return {
    tessellationKind: "triangle" as const,
    triangleShape: "rect" as const,
    hexShape: "parallelogram" as const,
    squareShape: "rect" as const,
    triOrientation: "r0" as const,
    freeFieldPoints: emptyFreePoints(),
    ...extra,
  };
}

/** Resets generateMaze/computeAnalytics/initWasm mocks to their default working state. Call in beforeEach. */
export function resetGenerationMocks<TGenerate extends { mockReset: () => void }, TAnalytics extends { mockReset: () => void; mockReturnValue: (v: typeof mockSnapshot) => unknown }, TWasm extends { mockResolvedValue: (v: undefined) => unknown }>(
  generateMaze: TGenerate,
  computeAnalytics: TAnalytics,
  initWasm: TWasm,
) {
  generateMaze.mockReset();
  computeAnalytics.mockReset();
  computeAnalytics.mockReturnValue(mockSnapshot);
  initWasm.mockResolvedValue(undefined);
}
