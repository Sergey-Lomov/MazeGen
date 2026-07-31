import type { StateCreator } from "zustand";
import { getAvailableChecks, getAvailableStrategies } from "../../wasm/mazeService";
import { initWasm } from "../../wasm/wasmLoader";
import type { InitialGenerationConfig } from "../../wasm/types";
import { entriesForSlot } from "../storeTypes";
import type { MazeStore, GenerationState, GenerationActions, QcRuleState, NestedStrategyState, PathSegment } from "../storeTypes";
import { debugStaleOf, buildResetMazeState } from "../storeHelpers";
import {
  resolveCheckKind, isTypeAlreadyActive, defaultParamsFor, buildDefaultNestedStrategies,
  newRule, newStage, appendRuleToStage, updateNestedAt, moveNestedAt,
} from "./generationSliceHelpers";
import { generateWithSeed } from "./generateConfigBuilder";

export { isTypeAlreadyActive } from "./generationSliceHelpers";
export { fieldConfigToWasm, buildGenerateConfig, generateWithSeed, buildExactGenerateCallPayload, resolveAlgorithmKind, NESTED_STRATEGY_WEIGHT_PARAM_ID } from "./generateConfigBuilder";
export type { StoreSet, StoreGet } from "./generateConfigBuilder";

export const createGenerationSlice: StateCreator<MazeStore, [], [], GenerationState & GenerationActions> = (set, get) => ({
  nodes: [],
  edges: [],
  start: null,
  finish: null,
  navNodes: [],
  navEdges: [],
  graphAnalytics: null,
  splitAnalytics: null,
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
  elementsConfig: { one_way_chance: 0.04, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 },
  nodeStats: null,
  edgeStats: null,
  teleportEdgeStats: null,
  routeInfo: null,
  timing: null,
  randomSeed: false,
  lastUsedSeed: null,
  seedHistory: [],
  seedHistoryIndex: 0,
  seedAttachedToHistory: false,
  qcExperiment: false,
  lastUsedQcExperiment: false,
  generationStatus: "idle" as const,
  openCard: "basic_config" as const,
  debugMode: false,
  debugAutoPlayDelay: 200,
  debugArena: null,
  debugStep: 0,
  debugStale: false,
  hoveredDebugRef: null,
  debugValueToggles: new Set<string>(),
  showKruskalDsuGroups: false,
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
        return newRule(kind, [{ localId: 0, typeId: checkId, params: defaultParamsFor(descriptor), disabled: false }], match?.id ?? null, false, strategies);
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
    }

    // Repeat-generate on the exact seed just navigated to (Back/Forward/Jump, unedited) leaves
    // history untouched. Anything else — a new seed, or a hand-edited one, even if it happens to
    // match an old value — truncates from the current position and appends, standard undo/redo
    // stack semantics. Truncation point is always `seedHistoryIndex`, regardless of how it got
    // there (navigation or a prior generate).
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

    set({
      seed: usedSeed,
      lastUsedSeed: usedSeed,
      lastUsedQcExperiment: state.qcExperiment,
      ...historyPatch,
    });
    generateWithSeed(usedSeed, get, set, state.qcExperiment);
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

  setRandomSeed: (v) => set({ randomSeed: v }),

  setOpenCard: (card) => set((state) => ({
    openCard: card,
    ...(state.openCard === "preset_connections" && card !== "preset_connections"
      ? { highlightInvalidPresets: false, highlightIsolatedNodes: false }
      : {}),
  })),

  setDebugMode: (v) => set(v ? { debugMode: true } : { debugMode: false, debugStale: false, hoveredDebugRef: null, debugValueToggles: new Set(), showKruskalDsuGroups: false }),
  setDebugStep: (step) => set({ debugStep: step }),
  setDebugAutoPlayDelay: (ms) => set({ debugAutoPlayDelay: ms }),
  setHoveredDebugRef: (ref) => set({ hoveredDebugRef: ref }),
  toggleDebugValue: (name) => set((state) => {
    const next = new Set(state.debugValueToggles);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return { debugValueToggles: next };
  }),
  toggleKruskalDsuGroups: () => set((state) => ({ showKruskalDsuGroups: !state.showKruskalDsuGroups })),

  reset: () => set({ ...buildResetMazeState(), error: null, generationStatus: "idle" as const, postEditDraftEdges: null, postEditDraftTeleports: [], postEditTeleportPendingFrom: null, _nextPostEditTeleportId: 1, postEditDraftMeta: null, postEditEdges: null, postEditTeleportEdges: [], postEditMeta: null, postEditAnalytics: null, postEditDirty: false }),

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
        ? { ...g, checks: [...g.checks, { localId: g.nextLocalCheckId, typeId, params, disabled: false }], nextLocalCheckId: g.nextLocalCheckId + 1 }
        : g);
      return { rules, debugStale: debugStaleOf(state) };
    }
    // New singleton rule — goes into the last stage (a fresh one is created if `stages` is
    // currently empty — see `appendRuleToStage`).
    const rule = newRule(checkKind, [{ localId: 0, typeId, params, disabled: false }], null, false, state.availableStrategies);
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
    const checks = descriptors.map((descriptor, i) => ({
      localId: i,
      typeId: descriptor.id,
      params: initialCheckParams?.[descriptor.id] ?? defaultParamsFor(descriptor),
      disabled: false,
    }));
    const strategyParams = { ...state.strategyParams };
    if (strategyId && !strategyParams[strategyId]) {
      const strategyDescriptor = state.availableStrategies.find((s) => s.id === strategyId);
      strategyParams[strategyId] = initialStrategyParams ?? defaultParamsFor({ params: strategyDescriptor?.params ?? [] });
    }
    const rule = newRule(checkKind, checks, strategyId, false, state.availableStrategies);
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

  toggleCheckDisabled: (ruleId, localId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, checks: g.checks.map((c) => c.localId === localId ? { ...c, disabled: !c.disabled } : c) }
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
    const newSingleton = newRule(descriptor ? resolveCheckKind(descriptor) : "", [{ ...moved, localId: 0 }], null, false, state.availableStrategies);
    rules.push(newSingleton);
    // Source rule left empty by this move is not dropped (see `QcRuleState`'s doc comment) —
    // its own stage membership is untouched. The new singleton rule goes into the last stage,
    // same placement `addCheck`/`createRule` use for a freshly created rule.
    const stages = appendRuleToStage(state.stages, newSingleton.id);
    return { rules, stages, debugStale: debugStaleOf(state) };
  }),

  // Changing the top-level strategy drops any previously-configured `nestedStrategies` — a
  // different strategy generally has a different (or no) set of nested slots, so a stale nested
  // config left over from the old strategy would be meaningless at best, misleading at worst.
  // Every mandatory slot of the new strategy is auto-filled with a default nested strategy (see
  // `buildDefaultNestedStrategies`) rather than left empty.
  setStrategy: (ruleId, strategyId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, strategyId, nestedStrategies: buildDefaultNestedStrategies(strategyId, state.availableStrategies) }
      : g),
    debugStale: debugStaleOf(state),
  })),

  clearStrategy: (ruleId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, strategyId: null, disabled: false, nestedStrategies: [] } : g),
    debugStale: debugStaleOf(state),
  })),

  // `path` is a chain of `(slotId, index)` steps, each resolved relative to the currently
  // selected nested strategy, not globally — `path[0]` is looked up in the rule's own top-level
  // strategy's `nestedStrategies`, `path[1]` is looked up in *that* entry's own `nested`, and so
  // on. `index` selects among sibling entries sharing this level's `slotId` (see
  // `entriesForSlot`) — for a slot capped at 1 (the overwhelming majority), `index` is always 0.
  // The same `slot_id` string appearing at two different depths never collides, since each
  // lookup only ever searches within its own parent's list, never the whole tree.
  setNestedStrategy: (ruleId, path, strategyId) => set((state) => {
    const transform = (target: NestedStrategyState): NestedStrategyState[] => {
      if (strategyId === null) return [];
      const descriptor = state.availableStrategies.find((s) => s.id === strategyId);
      const params = descriptor ? defaultParamsFor(descriptor) : {};
      const nested = buildDefaultNestedStrategies(strategyId, state.availableStrategies);
      return [{ slotId: target.slotId, strategyId, params, nested }];
    };
    return {
      rules: state.rules.map((g) => g.id === ruleId ? { ...g, nestedStrategies: updateNestedAt(g.nestedStrategies, path, transform) } : g),
      debugStale: debugStaleOf(state),
    };
  }),

  setNestedStrategyParam: (ruleId, path, paramId, value) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, nestedStrategies: updateNestedAt(g.nestedStrategies, path, (target) => [{ ...target, params: { ...target.params, [paramId]: value } }]) }
      : g),
    debugStale: debugStaleOf(state),
  })),

  // Appends a fresh entry (defaulted to the first strategy handling `slotKind`) after every
  // existing sibling sharing the target slot's `slotId` — the target slot is `path`'s last
  // segment, whose own `index` is ignored (ambiguous/stale for an append, unlike
  // `setNestedStrategy`/`removeNestedStrategy` which address one specific existing entry). A
  // no-op if no compatible candidate strategy is registered.
  addNestedStrategy: (ruleId, path, slotKind) => set((state) => {
    const candidate = state.availableStrategies.find((s) => s.handles === slotKind);
    if (!candidate) return {};
    const newEntry: NestedStrategyState = {
      slotId: path[path.length - 1].slotId,
      strategyId: candidate.id,
      params: defaultParamsFor(candidate),
      nested: buildDefaultNestedStrategies(candidate.id, state.availableStrategies),
    };
    function updateList(list: NestedStrategyState[], remainingPath: PathSegment[]): NestedStrategyState[] {
      if (remainingPath.length === 1) return [...list, newEntry];
      const [{ slotId, index }, ...rest] = remainingPath;
      const target = entriesForSlot(list, slotId)[index];
      if (!target) return list;
      return list.map((n) => n === target ? { ...n, nested: updateList(n.nested, rest) } : n);
    }
    return {
      rules: state.rules.map((g) => g.id === ruleId ? { ...g, nestedStrategies: updateList(g.nestedStrategies, path) } : g),
      debugStale: debugStaleOf(state),
    };
  }),

  // Removes the entry at `path` outright (every later sibling sharing its `slotId` shifts down
  // by one, since `index` is a list position — see `PathSegment`), unlike
  // `setNestedStrategy(..., null)` which is reserved for clearing a single-entry slot back to
  // "unset" rather than shrinking a multi-entry slot's list.
  removeNestedStrategy: (ruleId, path) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, nestedStrategies: updateNestedAt(g.nestedStrategies, path, () => []) }
      : g),
    debugStale: debugStaleOf(state),
  })),

  moveNestedStrategy: (ruleId, path, direction) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId
      ? { ...g, nestedStrategies: moveNestedAt(g.nestedStrategies, path, direction) }
      : g),
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

  setSplitPatternMode: (v) => set((state) => ({ splitPatternMode: v, debugStale: debugStaleOf(state) })),
  setSplitMaxNodes: (v) => set((state) => ({ splitMaxNodes: v, debugStale: debugStaleOf(state) })),
  setSplitPatterns: (patterns) => set((state) => ({
    splitPatterns: patterns,
    debugStale: debugStaleOf(state),
  })),
});
