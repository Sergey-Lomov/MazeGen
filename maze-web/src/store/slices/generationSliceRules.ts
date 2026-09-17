import type { StateCreator } from "zustand";
import { entriesForSlot } from "../storeTypes";
import type { MazeStore, GenerationActions, NestedStrategyState, PathSegment } from "../storeTypes";
import { debugStaleOf } from "../storeHelpers";
import {
  resolveCheckKind, defaultParamsFor, buildDefaultNestedStrategies,
  newRule, appendRuleToStage, updateNestedAt, moveNestedAt,
} from "./generationSliceHelpers";

type RulesSliceKeys =
  | "addCheck" | "createRule" | "removeCheck" | "setCheckParam" | "toggleCheckDisabled" | "removeCheckFromRule"
  | "setStrategy" | "clearStrategy" | "setNestedStrategy" | "setNestedStrategyParam" | "addNestedStrategy"
  | "removeNestedStrategy" | "moveNestedStrategy" | "toggleStrategyDisabled" | "toggleRuleDisabled"
  | "toggleRuleCollapsed" | "renameRule" | "removeRule" | "moveRule";

export const createGenerationRulesSlice: StateCreator<MazeStore, [], [], Pick<GenerationActions, RulesSliceKeys>> = (set) => ({
  // retired) could always be added, including one already active elsewhere — each call mints a
  // fresh, independent `CheckInstance`. Every other check type is still limited to one active
  // instance at a time, across all rules.
  addCheck: (typeId, ruleId, initialParams) => set((state) => {
    const descriptor = state.availableChecks.find((c) => c.id === typeId);
    if (!descriptor) return {};
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
      ;
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

  toggleRuleCollapsed: (ruleId) => set((state) => ({
    rules: state.rules.map((g) => g.id === ruleId ? { ...g, collapsed: !g.collapsed } : g),
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
});
