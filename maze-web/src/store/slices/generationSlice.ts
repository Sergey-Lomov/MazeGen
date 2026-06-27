import type { StateCreator } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../../wasm/mazeService";
import { initWasm } from "../../wasm/wasmLoader";
import type { InitialGenerationConfig, GenerateConfig, WasmTessellationConfig, GenerationStepsSnapshot, CheckDescriptor } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { computeInvalidKeys } from "../../pixi/presetConnectionsUtils";
import { configAllCells } from "../../pixi/tessellationCells";
import { buildPostEditDraftEdgesFromGenerated } from "../../pixi/postEditUtils";
import type { MazeStore, GenerationState, GenerationActions, PostEditTool, QcRuleState } from "../storeTypes";
import { activeTessellationOf, buildResetMazeState, debugStaleOf } from "../storeHelpers";
import * as m from "~/paraglide/messages";

// Rule-kind matching across the store (addCheck/newRule below, RulesColumn's candidate filter,
// useQualityViewModel) all assume one issue kind per check and read issue_kinds[0]. No current
// check produces more than one kind, but nothing enforces it at the descriptor level — warn
// loudly instead of silently dropping the other kinds if that assumption is ever violated.
function resolveCheckKind(descriptor: CheckDescriptor): string {
  if (descriptor.issue_kinds.length > 1) {
    console.error(`check "${descriptor.id}" produces multiple issue kinds (${descriptor.issue_kinds.join(", ")}); rules only support one kind per check — using "${descriptor.issue_kinds[0]}"`);
  }
  return descriptor.issue_kinds[0];
}

let ruleIdCounter = 0;
// Default rule name = the issue kind's own label (the same text shown in IssueSelectDialog's
// picker), mirroring `qualityI18n.resolveIssueLabel`'s fallback to the raw kind — duplicated
// here rather than imported to keep the store layer free of component-layer imports.
function defaultRuleName(kind: string): string {
  const fn = (m as unknown as Record<string, (() => string) | undefined>)[`issue.${kind}.label`];
  return fn?.() ?? kind;
}

// `name` is plain user-editable text seeded from the current locale at creation time (renaming
// UI not implemented yet) — it does not re-translate later, same as any other user-entered
// string would not. The counter is shared with `id` so a rule's number stays stable as other
// rules are added/removed (not derived from array position, which would shift on removal).
function newRule(kind: string, checks: string[], strategyId: string | null, disabled: boolean): QcRuleState {
  ruleIdCounter += 1;
  return { id: `rule_${ruleIdCounter}`, name: defaultRuleName(kind), kind, checks, strategyId, disabled, ruleDisabled: false };
}

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
  rules: [],
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
  repairMaxIterations: 10,
  repairTimeBudgetSecs: null,

  loadRegistry: () => {
    return initWasm().then(() => {
      const checks = getAvailableChecks();
      const strategies = getAvailableStrategies();
      const defaultSelectedChecks = checks.filter((c) => c.params.length === 0).map((c) => c.id);
      // Default: one singleton rule per default-selected check, with a default strategy for its
      // kind (if any) — preserves the old "auto-pick a strategy" behavior for checks without
      // params, since there's no UI yet to have configured anything else. `scored_endpoints` is
      // preferred for the start/finish kind over the first match (random/farthest) since it
      // produces better-scored placements; other kinds fall back to the first strategy handling
      // them.
      const defaultRules: QcRuleState[] = defaultSelectedChecks.map((checkId) => {
        const descriptor = checks.find((c) => c.id === checkId)!;
        const kind = resolveCheckKind(descriptor);
        const candidates = strategies.filter((s) => s.handles === kind);
        const match = candidates.find((s) => s.id === "scored_endpoints") ?? candidates[0];
        return newRule(kind, [checkId], match?.id ?? null, false);
      });
      const knownIds = new Set(checks.map((c) => c.id));
      set((state) => {
        const selectedChecks = state.registryLoaded
          ? state.selectedChecks.filter((id) => knownIds.has(id))
          : defaultSelectedChecks;
        const rules = state.registryLoaded
          ? state.rules
              .map((g) => ({ ...g, checks: g.checks.filter((id) => knownIds.has(id)) }))
              .filter((g) => g.checks.length > 0)
          : defaultRules;
        const checkParams = Object.fromEntries(
          Object.entries(state.checkParams).filter(([id]) => knownIds.has(id))
        );
        return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, selectedChecks, rules, checkParams };
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

  addCheck: (id, ruleId, initialParams) => set((state) => {
    if (state.selectedChecks.includes(id)) return {};
    const descriptor = state.availableChecks.find((c) => c.id === id);
    if (!descriptor) return {};
    const existing = state.checkParams[id];
    const params = existing ?? initialParams ?? Object.fromEntries(
      descriptor.params.map((p) => {
        const k = p.kind;
        const def = k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
        return [p.id, def];
      })
    );
    const checkKind = resolveCheckKind(descriptor);
    // A kind mismatch here would only be caught later, at wasm config-build time, with a
    // confusing "checks in rule produce different issue kinds" error far from this action — the
    // dialogs that call `addCheck` with a ruleId already pre-filter candidates by kind (see
    // `RulesColumn.candidatesFor`), but the store must not rely on that being the only caller.
    const targetRule = ruleId ? state.rules.find((g) => g.id === ruleId && g.kind === checkKind) : undefined;
    const rules = targetRule
      ? state.rules.map((g) => g.id === ruleId ? { ...g, checks: [...g.checks, id] } : g)
      : [...state.rules, newRule(checkKind, [id], null, false)];
    return {
      selectedChecks: [...state.selectedChecks, id],
      checkParams: { ...state.checkParams, [id]: params },
      rules,
      debugStale: debugStaleOf(state),
    };
  }),

  createRule: (ids, strategyId, initialCheckParams, initialStrategyParams) => set((state) => {
    if (ids.length === 0) return {};
    const descriptors = ids.map((id) => state.availableChecks.find((c) => c.id === id)).filter((d): d is NonNullable<typeof d> => d !== undefined);
    if (descriptors.length === 0) return {};
    const checkKind = resolveCheckKind(descriptors[0]);
    const checkParams = { ...state.checkParams };
    for (const descriptor of descriptors) {
      if (checkParams[descriptor.id]) continue;
      const override = initialCheckParams?.[descriptor.id];
      checkParams[descriptor.id] = override ?? Object.fromEntries(
        descriptor.params.map((p) => {
          const k = p.kind;
          const def = k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
          return [p.id, def];
        })
      );
    }
    const strategyParams = { ...state.strategyParams };
    if (strategyId && !strategyParams[strategyId]) {
      const strategyDescriptor = state.availableStrategies.find((s) => s.id === strategyId);
      strategyParams[strategyId] = initialStrategyParams ?? Object.fromEntries(
        (strategyDescriptor?.params ?? []).map((p) => {
          const k = p.kind;
          const def = k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
          return [p.id, def];
        })
      );
    }
    return {
      selectedChecks: [...state.selectedChecks, ...descriptors.map((d) => d.id)],
      checkParams,
      strategyParams,
      rules: [...state.rules, newRule(checkKind, descriptors.map((d) => d.id), strategyId, false)],
      debugStale: debugStaleOf(state),
    };
  }),

  // Unlike addCheckToRule/removeCheckFromRule, an empty rule here is not auto-dropped —
  // the user removed the check via the card's own X, not by moving it elsewhere, so the empty
  // card stays as a place to add a new check back into (see RulesColumn's add-check row).
  removeCheck: (id) => set((state) => ({
    selectedChecks: state.selectedChecks.filter((c) => c !== id),
    rules: state.rules.map((g) => ({ ...g, checks: g.checks.filter((c) => c !== id) })),
    debugStale: debugStaleOf(state),
  })),

  setCheckParam: (checkId, paramId, value) => set((state) => ({
    checkParams: {
      ...state.checkParams,
      [checkId]: { ...(state.checkParams[checkId] ?? {}), [paramId]: value },
    },
    debugStale: debugStaleOf(state),
  })),

  removeCheckFromRule: (checkId) => set((state) => {
    const descriptor = state.availableChecks.find((c) => c.id === checkId);
    const rules = state.rules
      .map((g) => ({ ...g, checks: g.checks.filter((c) => c !== checkId) }))
      .filter((g) => g.checks.length > 0);
    rules.push(newRule(descriptor ? resolveCheckKind(descriptor) : "", [checkId], null, false));
    return { rules, debugStale: debugStaleOf(state) };
  }),

  setStrategy: (ruleId, strategyId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, strategyId } : g),
    debugStale: debugStaleOf(state),
  })),

  clearStrategy: (ruleId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, strategyId: null, disabled: false } : g),
    debugStale: debugStaleOf(state),
  })),

  toggleStrategyDisabled: (ruleId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, disabled: !g.disabled } : g),
    debugStale: debugStaleOf(state),
  })),

  toggleRuleDisabled: (ruleId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, ruleDisabled: !g.ruleDisabled } : g),
    debugStale: debugStaleOf(state),
  })),

  renameRule: (ruleId, name) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, name } : g),
  })),

  removeRule: (ruleId) => set((state) => {
    const rule = state.rules.find((g) => g.id === ruleId);
    if (!rule) return {};
    const removedIds = new Set(rule.checks);
    return {
      rules: state.rules.filter((g) => g.id !== ruleId),
      selectedChecks: state.selectedChecks.filter((c) => !removedIds.has(c)),
      debugStale: debugStaleOf(state),
    };
  }),

  moveRule: (ruleId, direction) => set((state) => {
    const idx = state.rules.findIndex((g) => g.id === ruleId);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= state.rules.length) return {};
    const rules = [...state.rules];
    [rules[idx], rules[swapWith]] = [rules[swapWith], rules[idx]];
    return { rules, debugStale: debugStaleOf(state) };
  }),

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

  setRepairMaxIterations: (v) => set({ repairMaxIterations: v }),
  setRepairTimeBudgetSecs: (v) => set({ repairTimeBudgetSecs: v }),
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

// ruleDisabled rules (and their checks) are excluded entirely — as if they were never selected
// at all. Distinct from a rule with strategy:null/disabled (its checks still run): ruleDisabled
// means the checks themselves don't run. Shared by buildGenerateConfig and confirmPostEdit so
// both paths agree on which checks are actually active.
export function activeChecksOf(state: { selectedChecks: string[]; rules: { checks: string[]; ruleDisabled: boolean }[] }): string[] {
  const disabledCheckIds = new Set(state.rules.filter((g) => g.ruleDisabled).flatMap((g) => g.checks));
  return state.selectedChecks.filter((id) => !disabledCheckIds.has(id));
}

export function buildGenerateConfig(state: MazeStore): GenerateConfig | null {
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const activeRules = state.rules.filter((g) => !g.ruleDisabled);
  const checks = activeChecksOf(state);
  // Every remaining rule is sent, including ones with no strategy or disabled — `strategy: null`
  // for those, not an omitted entry. The wasm layer still needs the rule's check composition to
  // merge/attribute issues correctly even when nothing repairs them (see Specs/repair.md).
  const check_rules = activeRules.map((g) => {
    let strategy: { id: string; params: Record<string, string> } | null = null;
    if (g.strategyId && !g.disabled) {
      const descriptor = state.availableStrategies.find((s) => s.id === g.strategyId);
      const paramOverrides = state.strategyParams[g.strategyId] ?? {};
      const params: Record<string, string> = {};
      if (descriptor) {
        for (const p of descriptor.params) {
          if (paramOverrides[p.id] !== undefined) params[p.id] = paramOverrides[p.id];
        }
      }
      strategy = { id: g.strategyId, params };
    }
    return { id: g.id, checks: g.checks, strategy };
  });
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
    checks,
    check_rules,
    check_params: state.checkParams,
    ...(state.repairMaxIterations != null ? { repair_max_iterations: state.repairMaxIterations } : {}),
    ...(state.repairTimeBudgetSecs != null ? { repair_time_budget_secs: state.repairTimeBudgetSecs } : {}),
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
