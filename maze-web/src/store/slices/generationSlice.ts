import type { StateCreator } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../../wasm/mazeService";
import { initWasm } from "../../wasm/wasmLoader";
import type { InitialGenerationConfig, GenerateConfig, WasmTessellationConfig, GenerationStepsSnapshot } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { computeInvalidKeys } from "../../pixi/presetConnectionsUtils";
import { configAllCells } from "../../pixi/tessellationCells";
import { buildPostEditDraftEdgesFromGenerated } from "../../pixi/postEditUtils";
import type { MazeStore, GenerationState, GenerationActions, PostEditTool } from "../storeTypes";
import { activeTessellationOf, buildResetMazeState, debugStaleOf } from "../storeHelpers";

export const createGenerationSlice: StateCreator<MazeStore, [], [], GenerationState & GenerationActions> = (set, get) => ({
  nodes: [],
  edges: [],
  start: null,
  finish: null,
  navNodes: [],
  navEdges: [],
  graphAnalytics: null,
  showNodeIds: false,
  showCoords: false,
  showMaze: true,
  selectedNode: null,
  issues: [],
  error: null,
  registryLoaded: false,
  availableChecks: [],
  availableStrategies: [],
  selectedChecks: [],
  selectedStrategies: {},
  disabledStrategies: {},
  strategyParams: {},
  checkParams: {},
  initialConfig: { method: "recursive_backtracker" as const },
  elementsConfig: { one_way_chance: 0.04 },
  nodeStats: null,
  edgeStats: null,
  routeInfo: null,
  randomSeed: false,
  lastUsedSeed: null,
  generationStatus: "idle" as const,
  openCard: "basic_config" as const,
  debugMode: false,
  debugAutoPlayDelay: 200,
  debugSnapshot: null,
  debugStep: 0,
  debugStale: false,
  showDebugFrontier: true,
  mazeDirty: false,

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
        const disabledStrategies = state.registryLoaded ? state.disabledStrategies : {};
        const checkParams = Object.fromEntries(
          Object.entries(state.checkParams).filter(([id]) => knownIds.has(id))
        );
        return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, selectedChecks, selectedStrategies, disabledStrategies, checkParams };
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
    generateWithSeed(usedSeed, get, set);
  },

  regenerate: () => {
    const state = get();
    if (state.lastUsedSeed === null) return;
    generateWithSeed(state.lastUsedSeed, get, set);
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

  reset: () => set({ ...buildResetMazeState(), error: null, generationStatus: "idle" as const, postEditDraftEdges: null, postEditDraftMeta: null, postEditEdges: null, postEditMeta: null, postEditAnalytics: null, postEditDirty: false }),

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
      debugStale: debugStaleOf(state),
    };
  }),

  removeCheck: (id) => set((state) => ({
    selectedChecks: state.selectedChecks.filter((c) => c !== id),
    debugStale: debugStaleOf(state),
  })),

  setCheckParam: (checkId, paramId, value) => set((state) => ({
    checkParams: {
      ...state.checkParams,
      [checkId]: { ...(state.checkParams[checkId] ?? {}), [paramId]: value },
    },
    debugStale: debugStaleOf(state),
  })),

  setStrategy: (issueKind, strategyId) => set((state) => ({
    selectedStrategies: { ...state.selectedStrategies, [issueKind]: strategyId },
    debugStale: debugStaleOf(state),
  })),

  clearStrategy: (issueKind) => set((state) => {
    const next = { ...state.selectedStrategies };
    delete next[issueKind];
    const nextDisabled = { ...state.disabledStrategies };
    delete nextDisabled[issueKind];
    return { selectedStrategies: next, disabledStrategies: nextDisabled, debugStale: debugStaleOf(state) };
  }),

  toggleStrategyDisabled: (issueKind) => set((state) => ({
    disabledStrategies: { ...state.disabledStrategies, [issueKind]: !state.disabledStrategies[issueKind] },
    debugStale: debugStaleOf(state),
  })),

  setStrategyParam: (strategyId, paramId, value) => set((state) => ({
    strategyParams: {
      ...state.strategyParams,
      [strategyId]: { ...(state.strategyParams[strategyId] ?? {}), [paramId]: value },
    },
    debugStale: debugStaleOf(state),
  })),

  setGenerationParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_vertex_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value }, debugStale: debugStaleOf(state) };
  }),

  setEdgeBasedParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_edge_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value }, debugStale: debugStaleOf(state) };
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
    const stale = debugStaleOf(get());
    set({ initialConfig: next, debugStale: stale });
  },

  setElementsParam: (key, value) => set((state) => ({
    elementsConfig: { ...state.elementsConfig, [key]: value },
    debugStale: debugStaleOf(state),
  })),

  setError: (msg) => set({ error: msg }),
});

export type StoreSet = (partial: Partial<MazeStore> | ((s: MazeStore) => Partial<MazeStore>)) => void;
export type StoreGet = () => MazeStore;

export function fieldConfigToWasm(cfg: TessellationConfig): WasmTessellationConfig {
  const t = cfg.type;
  const tessellation_type = t.startsWith("hex") ? "hex" as const
    : (t.startsWith("tri") || t.startsWith("triangle")) ? "tri" as const
    : "square" as const;
  const points = configAllCells(cfg);
  return { tessellation_type, points };
}

export function buildGenerateConfig(state: MazeStore): GenerateConfig | null {
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const strategies: Record<string, { id: string; params: Record<string, string> }> = {};
  for (const [kind, strategyId] of Object.entries(state.selectedStrategies)) {
    if (!strategyId || state.disabledStrategies[kind]) continue;
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
  const activeTessellation = activeTessellationOf(state);
  const customPts = state.isEditingField ? state.fieldPoints : undefined;
  const invalidKeys = computeInvalidKeys(state.presetConnections, activeTessellation, customPts);
  const validPresets = Array.from(state.presetConnections.values())
    .filter(e => e.state !== "undefined" && !invalidKeys.has(`${e.from[0]},${e.from[1]}-${e.to[0]},${e.to[1]}`))
    .map(e => ({ from: e.from, to: e.to, state: e.state as import("../../wasm/types").PresetConnectionState }));
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

export function generateWithSeed(seed: number, get: StoreGet, set: StoreSet, skipConfirmPostEdit = false): void {
  const state = get();
  if (state.isEditingField && state.fieldPoints.size < 2) {
    set({ error: "Free field requires at least 2 cells", generationStatus: "error" });
    return;
  }
  const activeTessellation = activeTessellationOf(state);
  const debugMode = state.debugMode;
  const config = buildGenerateConfig(state);
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
      graphAnalytics: snapshot.graph_analytics,
      selectedNode: null,
      issues: snapshot.issues,
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
    if (!skipConfirmPostEdit) void get().confirmPostEdit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({ error: msg, generationStatus: "error" });
  }
}
