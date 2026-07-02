import type { StateCreator } from "zustand";
import { generateMaze, getAvailableChecks, getAvailableStrategies } from "../../wasm/mazeService";
import { initWasm } from "../../wasm/wasmLoader";
import type { InitialGenerationConfig, GenerateConfig, WasmTessellationConfig, GenerationStepsSnapshot, CheckDescriptor } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { computeInvalidKeys } from "../../pixi/presetConnectionsUtils";
import { configAllCells } from "../../pixi/tessellationCells";
import { buildPostEditDraftEdgesFromGenerated } from "../../pixi/postEditUtils";
import type { MazeStore, GenerationState, GenerationActions, PostEditTool, QcRuleState, CheckInstance, RepairStageState } from "../storeTypes";
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

// Most checks may only have one active instance at a time, across all rules — only checks with
// `allow_multiple_instances` (none currently — see GitHub issue #60, retired) can have several
// independent configurations active simultaneously. Exported so component-layer
// candidate filters (RulesColumn, CheckSelectDialog) apply the exact same predicate the store
// itself enforces, instead of each re-implementing it.
export function isTypeAlreadyActive(rules: QcRuleState[], typeId: string): boolean {
  return rules.some((g) => g.checks.some((c) => c.typeId === typeId));
}

function defaultParamsFor(descriptor: CheckDescriptor): Record<string, string> {
  return Object.fromEntries(
    descriptor.params.map((p) => {
      const k = p.kind;
      const def = k.type === "bool" ? (k.default ? "true" : "false") : String(k.default);
      return [p.id, def];
    })
  );
}

// Default rule name = the issue kind's own label (the same text shown in IssueSelectDialog's
// picker), mirroring `qualityI18n.resolveIssueLabel`'s fallback to the raw kind — duplicated
// here rather than imported to keep the store layer free of component-layer imports.
function defaultRuleName(kind: string): string {
  const fn = (m as unknown as Record<string, (() => string) | undefined>)[`issue.${kind}.label`];
  return fn?.() ?? kind;
}

// `name` is plain user-editable text seeded from the current locale at creation time (renaming
// UI not implemented yet) — it does not re-translate later, same as any other user-entered
// string would not. `id` is a UUID, not a counter-derived string — a module-level counter resets
// on store re-initialization (HMR, project load, undo/redo replay) while previously-created rules
// (e.g. from an imported project) keep their old ids, so a fresh counter can mint an id that
// collides with one already in use. `nextLocalCheckId` starts at `checks.length` (the lowest id
// not already in use among the member checks passed in at creation).
function newRule(kind: string, checks: CheckInstance[], strategyId: string | null, disabled: boolean): QcRuleState {
  return {
    id: `rule_${crypto.randomUUID()}`,
    name: defaultRuleName(kind),
    kind,
    checks,
    nextLocalCheckId: checks.length,
    strategyId,
    disabled,
    ruleDisabled: false,
  };
}

// Default stage name — the very first stage (index 0) is seeded as "Путевые точки" ("Waypoints"),
// since it's the one every fresh project starts with and typically holds the endpoint-placement
// rules; later stages fall back to "Stage N" by creation-order position, not renumbered on
// rename/reorder (same pattern as `defaultRuleName`'s "Rule N" fallback in `validateQcRule`, see
// projectExport). `id` is a UUID for the same reason `newRule`'s `id` is — see that function's
// doc comment.
function newStage(index: number, ruleIds: string[] = []): RepairStageState {
  return {
    id: `stage_${crypto.randomUUID()}`,
    name: index === 0 ? m["quality.default_stage_name"]() : `Stage ${index + 1}`,
    ruleIds,
    disabled: false,
  };
}

// Appends `ruleId` to a stage's `ruleIds` — the "new rule goes at the end" placement used by
// `addCheck` (singleton path), `createRule`, and `removeCheckFromRule`'s new-singleton path.
// `targetStageId`, when given and resolving to a known stage, receives the rule (the per-stage
// "+ Add rule" toolbar button — see RulesColumn); otherwise falls back to the last stage. `stages`
// can legitimately be empty (there is no "at least one stage" invariant — a stage is only ever
// created explicitly via `addStage`, or implicitly here) — in that case a fresh stage is created
// to hold the new rule, rather than the rule ending up in no stage at all.
function appendRuleToStage(stages: RepairStageState[], ruleId: string, targetStageId?: string): RepairStageState[] {
  if (stages.length === 0) return [newStage(0, [ruleId])];
  if (targetStageId && stages.some((s) => s.id === targetStageId)) {
    return stages.map((s) => s.id === targetStageId ? { ...s, ruleIds: [...s.ruleIds, ruleId] } : s);
  }
  return stages.map((s, i) => i === stages.length - 1 ? { ...s, ruleIds: [...s.ruleIds, ruleId] } : s);
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
  rules: [],
  stages: [newStage(0)],
  strategyParams: {},
  initialConfig: { method: "recursive_backtracker" as const },
  elementsConfig: { one_way_chance: 0.04 },
  nodeStats: null,
  edgeStats: null,
  routeInfo: null,
  timing: null,
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
      // them. `localId` is fixed at 0 for these bootstrap-created singletons (no counter
      // involved, created once at app boot — see `CheckInstance`'s doc comment).
      const defaultRules: QcRuleState[] = defaultSelectedChecks.map((checkId) => {
        const descriptor = checks.find((c) => c.id === checkId)!;
        const kind = resolveCheckKind(descriptor);
        const candidates = strategies.filter((s) => s.handles === kind);
        const match = candidates.find((s) => s.id === "scored_endpoints") ?? candidates[0];
        return newRule(kind, [{ localId: 0, typeId: checkId, params: defaultParamsFor(descriptor) }], match?.id ?? null, false);
      });
      const knownIds = new Set(checks.map((c) => c.id));
      set((state) => {
        if (!state.registryLoaded) {
          // First load: default rules go into the sole (default) stage created by initial state.
          const stages = state.stages.length > 0
            ? [{ ...state.stages[0], ruleIds: defaultRules.map((r) => r.id) }, ...state.stages.slice(1)]
            : [newStage(0, defaultRules.map((r) => r.id))];
          return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, rules: defaultRules, stages };
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
        return { registryLoaded: true, availableChecks: checks, availableStrategies: strategies, rules, stages };
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

  // A check type with `allow_multiple_instances` (none currently — see GitHub issue #60,
  // retired) could always be added, including one already active elsewhere — each call mints a
  // fresh, independent `CheckInstance`. Every other check type is still limited to one active
  // instance at a time, across all rules.
  addCheck: (typeId, ruleId, initialParams) => set((state) => {
    const descriptor = state.availableChecks.find((c) => c.id === typeId);
    if (!descriptor) return {};
    if (!descriptor.allow_multiple_instances && isTypeAlreadyActive(state.rules, typeId)) return {};
    const params = initialParams ?? defaultParamsFor(descriptor);
    const checkKind = resolveCheckKind(descriptor);
    // A kind mismatch here would only be caught later, at wasm config-build time, with a
    // confusing "checks in rule produce different issue kinds" error far from this action — the
    // dialogs that call `addCheck` with a ruleId already pre-filter candidates by kind (see
    // `RulesColumn.candidatesFor`), but the store must not rely on that being the only caller.
    const targetRule = ruleId ? state.rules.find((g) => g.id === ruleId && g.kind === checkKind) : undefined;
    if (targetRule) {
      const rules = state.rules.map((g) => g.id === ruleId
        ? { ...g, checks: [...g.checks, { localId: g.nextLocalCheckId, typeId, params }], nextLocalCheckId: g.nextLocalCheckId + 1 }
        : g);
      return { rules, debugStale: debugStaleOf(state) };
    }
    // New singleton rule — goes into the last stage (a fresh one is created if `stages` is
    // currently empty — see `appendRuleToStage`).
    const rule = newRule(checkKind, [{ localId: 0, typeId, params }], null, false);
    const stages = appendRuleToStage(state.stages, rule.id);
    return { rules: [...state.rules, rule], stages, debugStale: debugStaleOf(state) };
  }),

  createRule: (typeIds, strategyId, initialCheckParams, initialStrategyParams, targetStageId) => set((state) => {
    if (typeIds.length === 0) return {};
    const descriptors = typeIds
      .map((id) => state.availableChecks.find((c) => c.id === id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined)
      // Drop any type that's single-instance-only and already active elsewhere — same
      // restriction as `addCheck`, applied per id rather than rejecting the whole call (the
      // multiselect dialog already pre-filters its candidate list, but the store must not rely
      // on that being the only caller).
      .filter((d) => d.allow_multiple_instances || !isTypeAlreadyActive(state.rules, d.id));
    if (descriptors.length === 0) return {};
    const checkKind = resolveCheckKind(descriptors[0]);
    const checks: CheckInstance[] = descriptors.map((descriptor, i) => ({
      localId: i,
      typeId: descriptor.id,
      params: initialCheckParams?.[descriptor.id] ?? defaultParamsFor(descriptor),
    }));
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
    const rule = newRule(checkKind, checks, strategyId, false);
    const stages = appendRuleToStage(state.stages, rule.id, targetStageId);
    return {
      strategyParams,
      rules: [...state.rules, rule],
      stages,
      debugStale: debugStaleOf(state),
    };
  }),

  // Unlike addCheckToRule/removeCheckFromRule, an empty rule here is not auto-dropped —
  // the user removed the check via the card's own X, not by moving it elsewhere, so the empty
  // card stays as a place to add a new check back into (see RulesColumn's add-check row).
  removeCheck: (ruleId, localId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, checks: g.checks.filter((c) => c.localId !== localId) }
      : g),
    debugStale: debugStaleOf(state),
  })),

  setCheckParam: (ruleId, localId, paramId, value) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, checks: g.checks.map((c) => c.localId === localId ? { ...c, params: { ...c.params, [paramId]: value } } : c) }
      : g),
    debugStale: debugStaleOf(state),
  })),

  removeCheckFromRule: (ruleId, localId) => set((state) => {
    const sourceRule = state.rules.find((g) => g.id === ruleId);
    const moved = sourceRule?.checks.find((c) => c.localId === localId);
    if (!moved) return {};
    const rules = state.rules
      .map((g) => g.id === ruleId ? { ...g, checks: g.checks.filter((c) => c.localId !== localId) } : g)
      .filter((g) => g.checks.length > 0);
    const descriptor = state.availableChecks.find((c) => c.id === moved.typeId);
    const newSingleton = newRule(descriptor ? resolveCheckKind(descriptor) : "", [{ ...moved, localId: 0 }], null, false);
    rules.push(newSingleton);
    // Source rule left empty by this move is not dropped (see `QcRuleState`'s doc comment) —
    // its own stage membership is untouched. The new singleton rule goes into the last stage,
    // same placement `addCheck`/`createRule` use for a freshly created rule.
    const stages = appendRuleToStage(state.stages, newSingleton.id);
    return { rules, stages, debugStale: debugStaleOf(state) };
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

  removeRule: (ruleId) => set((state) => ({
    rules: state.rules.filter((g) => g.id !== ruleId),
    stages: state.stages.map((s) => ({ ...s, ruleIds: s.ruleIds.filter((id) => id !== ruleId) })),
    debugStale: debugStaleOf(state),
  })),

  // See `Specs/quality-feature.md`'s "moveRule and stages" section for the full algorithm this
  // implements. Within one stage: adjacent swap in that stage's `ruleIds` (unchanged from before
  // staging existed). At a stage boundary: the rule physically moves to the neighboring stage,
  // inserted at its near edge — front for "down" (moving into the next stage), back for "up"
  // (moving into the previous stage) — including into an empty neighboring stage. No-op only at
  // the global boundary.
  moveRule: (ruleId, direction) => set((state) => {
    const stageIdx = state.stages.findIndex((s) => s.ruleIds.includes(ruleId));
    if (stageIdx === -1) return {};
    const stage = state.stages[stageIdx];
    const ruleIdx = stage.ruleIds.indexOf(ruleId);

    if (direction === "up" && ruleIdx > 0) {
      const ruleIds = [...stage.ruleIds];
      [ruleIds[ruleIdx - 1], ruleIds[ruleIdx]] = [ruleIds[ruleIdx], ruleIds[ruleIdx - 1]];
      const stages = state.stages.map((s, i) => i === stageIdx ? { ...s, ruleIds } : s);
      return { stages, debugStale: debugStaleOf(state) };
    }
    if (direction === "down" && ruleIdx < stage.ruleIds.length - 1) {
      const ruleIds = [...stage.ruleIds];
      [ruleIds[ruleIdx], ruleIds[ruleIdx + 1]] = [ruleIds[ruleIdx + 1], ruleIds[ruleIdx]];
      const stages = state.stages.map((s, i) => i === stageIdx ? { ...s, ruleIds } : s);
      return { stages, debugStale: debugStaleOf(state) };
    }

    // At the stage's own boundary — cross into the neighboring stage, if any.
    const neighborIdx = direction === "up" ? stageIdx - 1 : stageIdx + 1;
    if (neighborIdx < 0 || neighborIdx >= state.stages.length) return {}; // global boundary
    const sourceRuleIds = stage.ruleIds.filter((id) => id !== ruleId);
    const neighbor = state.stages[neighborIdx];
    const neighborRuleIds = direction === "up" ? [...neighbor.ruleIds, ruleId] : [ruleId, ...neighbor.ruleIds];
    const stages = state.stages.map((s, i) => {
      if (i === stageIdx) return { ...s, ruleIds: sourceRuleIds };
      if (i === neighborIdx) return { ...s, ruleIds: neighborRuleIds };
      return s;
    });
    return { stages, debugStale: debugStaleOf(state) };
  }),

  // Default name index is the highest "Stage N" suffix seen among current stages, not
  // `stages.length` — using length alone can reproduce an already-used name after a stage in
  // the middle was removed (e.g. remove "Stage 2" out of ["Waypoints", "Stage 2", "Stage 3"],
  // then Add stage would otherwise mint another "Stage 3").
  addStage: () => set((state) => {
    const usedIndices = state.stages
      .map((s) => /^Stage (\d+)$/.exec(s.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    const nextIndex = usedIndices.length > 0 ? Math.max(...usedIndices) : state.stages.length;
    return { stages: [...state.stages, newStage(nextIndex)] };
  }),

  renameStage: (stageId, name) => set((state) => ({
    stages: state.stages.map((s) => s.id === stageId ? { ...s, name } : s),
  })),

  // Removes the stage and every rule it holds (cascading delete) — same "explicit, confirmed
  // destructive action" pattern as `removeRule` (RulesColumn gates this behind a ConfirmModal,
  // whose message calls out that member rules are removed too when the stage isn't empty). No
  // "last remaining stage" restriction — `stages` can legitimately be empty (see
  // `appendRuleToStage`, which creates a fresh one on demand if a rule needs a home and none
  // exists).
  removeStage: (stageId) => set((state) => {
    const stage = state.stages.find((s) => s.id === stageId);
    if (!stage) return {};
    const removedRuleIds = new Set(stage.ruleIds);
    return {
      stages: state.stages.filter((s) => s.id !== stageId),
      rules: state.rules.filter((r) => !removedRuleIds.has(r.id)),
      debugStale: debugStaleOf(state),
    };
  }),

  moveStage: (stageId, direction) => set((state) => {
    const idx = state.stages.findIndex((s) => s.id === stageId);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= state.stages.length) return {};
    const stages = [...state.stages];
    [stages[idx], stages[swapWith]] = [stages[swapWith], stages[idx]];
    return { stages, debugStale: debugStaleOf(state) };
  }),

  toggleStageDisabled: (stageId) => set((state) => ({
    stages: state.stages.map((s) => s.id === stageId ? { ...s, disabled: !s.disabled } : s),
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

// Builds one `QcRuleConfig` from a `QcRuleState` — `ruleDisabled` filtering happens in
// `buildGenerateConfig` before this is called (per-stage, per rule), not here.
function ruleToConfig(state: MazeStore, g: QcRuleState): { id: string; checks: { local_id: string; type_id: string; params: Record<string, string> }[]; strategy: { id: string; params: Record<string, string> } | null } {
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
  // Order preserved from `QcRuleState.checks` — no resorting, so serialization/test
  // determinism doesn't depend on Map/object iteration order at this layer.
  const checks = g.checks.map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params }));
  return { id: g.id, checks, strategy };
}

export function buildGenerateConfig(state: MazeStore): GenerateConfig | null {
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const ruleById = new Map(state.rules.map((g) => [g.id, g]));
  // A `disabled` stage is omitted entirely — as if it didn't exist for this run, same as a
  // `ruleDisabled` rule being omitted from its stage's `rules` below (not sent with an empty
  // `rules: []`, which would still be a real, dispatchable-if-non-empty stage entry).
  // `ruleDisabled` filtering happens here, per stage, before any config crosses the wasm
  // boundary — a disabled rule is simply absent from `stage.rules`, not sent as `strategy: null`
  // (that shape is reserved for a rule that legitimately has no strategy assigned). Every
  // remaining rule is sent, including ones with no strategy — `strategy: null` for those, not an
  // omitted entry. The wasm layer still needs the rule's check composition to merge/attribute
  // issues correctly even when nothing repairs them (see Specs/repair.md). An empty stage after
  // this filtering is sent as-is (`rules: []`) — core handles a stage with no dispatchable rules
  // as a trivial degenerate case (see Specs/repair.md's "Stages" section).
  const stages = state.stages
    .filter((s) => !s.disabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      rules: s.ruleIds
        .map((id) => ruleById.get(id))
        .filter((g): g is QcRuleState => g !== undefined && !g.ruleDisabled)
        .map((g) => ruleToConfig(state, g)),
    }));
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
    stages,
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
      timing: snapshot.timing,
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

/**
 * Builds the exact `{ seed, config }` payload that `generateWithSeed` would send into
 * `generateMaze` right now -- same `buildGenerateConfig(state)` call, same seed resolution
 * (the last seed actually used, falling back to the configured one) -- but instead of calling
 * the wasm core, returns it for download. Lets a bug report attach the literal input the core
 * received, without anyone hand-reconstructing the JS->wasm config-building logic (tessellation
 * point centering/ordering, rule composition, etc.) by hand and risking drift from the real
 * code path. Returns `null` under the same precondition `generateWithSeed` bails out on.
 */
export function buildExactGenerateCallPayload(get: StoreGet): { seed: number; config: GenerateConfig } | null {
  const state = get();
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const seed = state.lastUsedSeed ?? state.seed;
  const config = buildGenerateConfig(state);
  if (!config) return null;
  return { seed, config };
}
