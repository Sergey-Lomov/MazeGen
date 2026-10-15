import type { StateCreator } from "zustand";
import { getAvailableChecks, getAvailableStrategies, getAvailableRuleParams } from "../../wasm/mazeService";
import { initWasm } from "../../wasm/wasmLoader";
import type { InitialGenerationConfig } from "../../wasm/types";
import type { MazeStore, GenerationState, GenerationActions, QcRuleState } from "../storeTypes";
import { debugStaleOf, buildResetDownstreamState } from "../storeHelpers";
import { chooseFloorLabelModeOnce } from "../floorLabelModeChoice";
import { resolveCheckKind, defaultParamsFor, newRule, newStage } from "./generationSliceHelpers";
import { generateWithSeed, generateWithSeedAsync } from "./generateConfigBuilder";
import { createGenerationRulesSlice } from "./generationSliceRules";
import { createGenerationStagesSlice } from "./generationSliceStages";
import { createGenerationDebugSlice } from "./generationSliceDebug";

export { fieldConfigToWasm, buildGenerateConfig, buildValidPresetConnections, generateWithSeed, generateWithSeedAsync, buildExactGenerateCallPayload, resolveAlgorithmKind, NESTED_STRATEGY_WEIGHT_PARAM_ID } from "./generateConfigBuilder";
export type { StoreSet, StoreGet } from "./generateConfigBuilder";

export const createGenerationSlice: StateCreator<MazeStore, [], [], GenerationState & GenerationActions> = (...a) => {
  const [set, get] = a;
  const prepareGenerate = () => {
    const state = get();
    let usedSeed = state.seed;
    if (state.randomSeed) usedSeed = Math.floor(Math.random() * 1_000_000);
    const reuseSameHistorySeed = state.seedAttachedToHistory
      && state.seedHistory.length > 0
      && state.seedHistory[state.seedHistoryIndex] === usedSeed;
    const historyPatch = reuseSameHistorySeed
      ? {}
      : (() => {
          const truncated = state.seedHistory.slice(0, state.seedHistoryIndex + (state.seedHistory.length > 0 ? 1 : 0));
          let next = [...truncated, usedSeed];
          if (next.length > 20) next = next.slice(next.length - 20);
          return { seedHistory: next, seedHistoryIndex: next.length - 1, seedAttachedToHistory: true };
        })();
    set({ seed: usedSeed, lastUsedSeed: usedSeed, lastUsedQcExperiment: state.qcExperiment, ...historyPatch });
    return { usedSeed, qcExperiment: state.qcExperiment };
  };
  return {
  ...createGenerationRulesSlice(...a),
  ...createGenerationStagesSlice(...a),
  ...createGenerationDebugSlice(...a),
  nodes: [],
  edges: [],
  start: null,
  finish: null,
  navNodes: [],
  navEdges: [],
  statistics: null,
  showNodeIds: false,
  showCoords: false,
  showMaze: true,
  selectedNode: null,
  issues: [],
  error: null,
  registryLoaded: false,
  availableChecks: [],
  availableStrategies: [],
  availableRuleParams: [],
  rules: [],
  stages: [newStage(0)],
  strategyParams: {},
  initialConfig: { method: "recursive_backtracker" as const },
  elementsConfig: { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
  routeInfo: null,
  timing: null,
  randomSeed: false,
  lastUsedSeed: null,
  seedHistory: [],
  seedHistoryIndex: 0,
  seedAttachedToHistory: false,
  qcExperiment: false,
  lastUsedQcExperiment: false,
  vertexSettingsPanelOpen: false,
  generationStatus: "idle" as const,
  openCard: "basic_config" as const,
  debugMode: false,
  debugAutoPlayDelay: 200,
  debugArena: null,
  debugStep: 0,
  debugFocusToken: 0,
  debugFocusNodeIndex: null,
  debugAutoSwitchFloor: true,
  debugStale: false,
  hoveredDebugRef: null,
  debugValueToggles: new Set<string>(),
  showKruskalDsuGroups: false,
  debugSearchQuery: "",
  mazeDirty: false,
  repairMaxIterations: 100,
  repairTimeBudgetSecs: 10,
  splitPatternMode: false,
  splitMaxNodes: 2,
  splitPatterns: [],

  loadRegistry: () => {
    return initWasm().then(() => {
      const checks = getAvailableChecks();
      const strategies = getAvailableStrategies();
      const ruleParams = getAvailableRuleParams();
      // Teleport checks are excluded from the default set even when they have no params
      // (`teleport_duplicates_connection`) — teleport validation isn't relevant unless the user
      // actually enables teleports, so it shouldn't show up as a pre-populated rule by default.
      const TELEPORT_ISSUE_KINDS = new Set(["invalid_teleport", "invalid_teleport_group"]);
      const defaultSelectedChecks = checks
        .filter((c) => c.params.length === 0 && !c.issue_kinds.some((k) => TELEPORT_ISSUE_KINDS.has(k)))
        .map((c) => c.id);
      // Default: one singleton rule per default-selected check, with a default strategy for its
      // kind (if any) — preserves the old "auto-pick a strategy" behavior for checks without
      // params, since there's no UI yet to have configured anything else. `scored_endpoints` is
      // preferred for the start/finish kind over the first match (random/farthest) since it
      // produces better-scored placements; other kinds fall back to the first strategy handling
      // them. `localId` is fixed at 0 for these bootstrap-created singletons (no counter
      // involved, created once at app boot — see `CheckInstance`'s doc comment).
      const defaultRules: QcRuleState[] = defaultSelectedChecks.map((checkId) => {
        const descriptor = checks.find((c) => c.id === checkId)!;
        const kind = resolveCheckKind(descriptor);
        const candidates = strategies.filter((s) => s.handles === kind);
        const match = candidates.find((s) => s.id === "scored_endpoints") ?? candidates[0];
        return newRule(kind, [{ localId: 0, typeId: checkId, params: defaultParamsFor(descriptor), disabled: false }], match?.id ?? null, false, strategies);
      });
      const knownIds = new Set(checks.map((c) => c.id));
      set((state) => {
        if (!state.registryLoaded) {
          // First load: default rules go into the sole (default) stage created by initial state.
          const stages = state.stages.length > 0
            ? [{ ...state.stages[0], ruleIds: defaultRules.map((r) => r.id) }, ...state.stages.slice(1)]
            : [newStage(0, defaultRules.map((r) => r.id))];
          return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, availableRuleParams: ruleParams, rules: defaultRules, stages };
        }
        // Reload: rules left empty by the registry filter are dropped (see
        // Specs/quality-feature.md's "Default State") — their ids must also be scrubbed from
        // every stage's `ruleIds`, or a stage would keep a stale reference to a rule that no
        // longer exists.
        const rules = state.rules
          .map((g) => ({ ...g, checks: g.checks.filter((c) => knownIds.has(c.typeId)) }))
          .filter((g) => g.checks.length > 0);
        const survivingIds = new Set(rules.map((r) => r.id));
        const stages = state.stages.map((s) => ({ ...s, ruleIds: s.ruleIds.filter((id) => survivingIds.has(id)) }));
        return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, availableRuleParams: ruleParams, rules, stages };
      });
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load WASM registry:", msg);
      set({ error: msg });
    });
  },

  generate: () => {
    const { usedSeed, qcExperiment } = prepareGenerate();
    generateWithSeed(usedSeed, get, set, qcExperiment);
  },

  generateAsync: async () => {
    if (typeof Worker === "undefined") {
      get().generate();
      return;
    }
    const { usedSeed, qcExperiment } = prepareGenerate();
    await generateWithSeedAsync(usedSeed, get, set, qcExperiment);
  },

  seedHistoryBack: () => set((state) => {
    if (state.seedHistory.length === 0 || state.seedHistoryIndex <= 0) return {};
    const idx = state.seedHistoryIndex - 1;
    return { seed: state.seedHistory[idx], seedHistoryIndex: idx, seedAttachedToHistory: true, randomSeed: false, error: null };
  }),

  seedHistoryForward: () => set((state) => {
    if (state.seedHistoryIndex >= state.seedHistory.length - 1) return {};
    const idx = state.seedHistoryIndex + 1;
    return { seed: state.seedHistory[idx], seedHistoryIndex: idx, seedAttachedToHistory: true, randomSeed: false, error: null };
  }),

  seedHistoryJump: (index) => set((state) => {
    if (index < 0 || index >= state.seedHistory.length) return {};
    return { seed: state.seedHistory[index], seedHistoryIndex: index, seedAttachedToHistory: true, randomSeed: false, error: null };
  }),

  setQcExperiment: (v) => set((state) => ({ qcExperiment: v, debugStale: debugStaleOf(state) })),
  setVertexSettingsPanelOpen: (v) => set({ vertexSettingsPanelOpen: v }),

  setRandomSeed: (v) => set({ randomSeed: v }),

  setOpenCard: (card) => set((state) => ({
    ...(card === "image_export" ? chooseFloorLabelModeOnce(state) : {}),
    openCard: card,
    ...(state.openCard === "preset_connections" && card !== "preset_connections"
      ? { highlightInvalidPresets: false, highlightIsolatedNodes: false, highlightOrphanSplitNodes: false }
      : {}),
  })),

  reset: () => set(buildResetDownstreamState()),

  setDebugFlag: (key, value) => set({ [key]: value }),

  selectNode: (id) => set({ selectedNode: id }),

  setGenerationParam: (key, value) => set((state) => {
    if (state.initialConfig.method !== "custom_vertex_based") return {};
    return { initialConfig: { ...state.initialConfig, [key]: value }, debugStale: debugStaleOf(state) };
  }),

  setGenerationMethod: (method) => {
    const defaults: Record<string, InitialGenerationConfig> = {
      custom_vertex_based: { method: "custom_vertex_based", depth_first: 0.9, corridor_chance: 0.7, branching: 0.5, directionality: 0.0, cyclicity: 0.0 },
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
    set({
      initialConfig: next,
      debugStale: stale,
      ...(method !== "custom_vertex_based" ? { vertexSettingsPanelOpen: false } : {}),
    });
  },

  setElementsParam: (key, value) => set((state) => ({
    elementsConfig: { ...state.elementsConfig, [key]: value },
    debugStale: debugStaleOf(state),
  })),

  setElementsBoolParam: (key, value) => set((state) => ({
    elementsConfig: { ...state.elementsConfig, [key]: value },
    debugStale: debugStaleOf(state),
  })),

  setError: (msg) => set({ error: msg }),

  setRepairMaxIterations: (v) => set({ repairMaxIterations: v }),
  setRepairTimeBudgetSecs: (v) => set({ repairTimeBudgetSecs: v }),

  setSplitPatternMode: (v) => set((state) => ({ splitPatternMode: v, debugStale: debugStaleOf(state) })),
  setSplitMaxNodes: (v) => set((state) => ({ splitMaxNodes: v, debugStale: debugStaleOf(state) })),
  setSplitPatterns: (patterns) => set((state) => ({
    splitPatterns: patterns,
    debugStale: debugStaleOf(state),
  })),
  };
};
