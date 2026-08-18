import type { StateCreator } from "zustand";
import type { MazeStore, GenerationActions } from "../storeTypes";
import { debugStaleOf } from "../storeHelpers";
import { newStage } from "./generationSliceHelpers";

type StagesSliceKeys =
  | "addStage" | "renameStage" | "removeStage" | "moveStage" | "toggleStageDisabled" | "toggleStageCollapsed"
  | "setStrategyParam" | "setRuleParam";

export const createGenerationStagesSlice: StateCreator<MazeStore, [], [], Pick<GenerationActions, StagesSliceKeys>> = (set) => ({
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

  toggleStageCollapsed: (stageId) => set((state) => ({
    stages: state.stages.map((s) => s.id === stageId ? { ...s, collapsed: !s.collapsed } : s),
  })),

  setStrategyParam: (strategyId, paramId, value) => set((state) => ({
    strategyParams: {
      ...state.strategyParams,
      [strategyId]: { ...(state.strategyParams[strategyId] ?? {}), [paramId]: value },
    },
    debugStale: debugStaleOf(state),
  })),

  setRuleParam: (ruleId, paramId, value) => set((state) => ({
    rules: state.rules.map((r) => r.id === ruleId ? { ...r, params: { ...r.params, [paramId]: value } } : r),
    debugStale: debugStaleOf(state),
  })),
});
