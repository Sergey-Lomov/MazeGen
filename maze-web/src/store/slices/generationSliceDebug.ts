import type { StateCreator } from "zustand";
import type { MazeStore, GenerationActions } from "../storeTypes";
import { resolveStepFloorIndex } from "../debugSelectors";

type DebugSliceKeys =
  | "setDebugMode" | "setDebugStep" | "toggleDebugAutoSwitchFloor" | "focusDebugStep" | "focusDebugNode"
  | "setDebugAutoPlayDelay" | "setHoveredDebugRef" | "toggleDebugValue" | "toggleKruskalDsuGroups"
  | "setDebugSearchQuery";

export const createGenerationDebugSlice: StateCreator<MazeStore, [], [], Pick<GenerationActions, DebugSliceKeys>> = (set) => ({
  setDebugMode: (v) => set(v ? { debugMode: true } : { debugMode: false, debugStale: false, hoveredDebugRef: null, debugValueToggles: new Set(), showKruskalDsuGroups: false, debugSearchQuery: "", debugFocusNodeIndex: null }),
  // GitHub issue #350: every playback path (autoplay, next/prev, scrubber, tree row click) goes
  // through this one action, so auto-switching the active floor to match the step being shown
  // lives here rather than being duplicated at each caller. `resolveStepFloorIndex` returns `null`
  // both on a single-floor maze and whenever the step's own mutating event touches more than one
  // floor at once (e.g. a vertical connection) — either way, the active floor is left alone.
  // `switchFloor: false` (only `StepSlider`'s in-flight drag ticks pass this) skips the switch
  // entirely — without it, dragging the scrubber across many floors in quick succession flickered
  // the active floor on every intermediate tick, not just the final settled position.
  // `state.debugAutoSwitchFloor` is the user-facing on/off toggle (`DebugPanel`'s "Auto-switch
  // floors" row) — when off, no trigger auto-switches at all, matching `switchFloor: false`'s own
  // early return; a debug-tree bubble's own click-to-switch (`DebugEventTree.tsx`'s
  // `onClickFloor`) bypasses this action entirely (calls `setActiveFloorId` directly), so it's
  // never gated by this toggle either.
  setDebugStep: (step, switchFloor = true) => set((state) => {
    if (!switchFloor || !state.debugAutoSwitchFloor) return { debugStep: step };
    const floorIndex = resolveStepFloorIndex(state.debugArena, state.floors, step);
    const floor = floorIndex !== null ? state.floors[floorIndex] : undefined;
    return floor ? { debugStep: step, activeFloorId: floor.id } : { debugStep: step };
  }),
  toggleDebugAutoSwitchFloor: () => set((state) => ({ debugAutoSwitchFloor: !state.debugAutoSwitchFloor })),
  focusDebugStep: () => set((state) => ({ debugFocusToken: state.debugFocusToken + 1, debugFocusNodeIndex: null })),
  focusDebugNode: (nodeIndex) => set((state) => ({ debugFocusToken: state.debugFocusToken + 1, debugFocusNodeIndex: nodeIndex })),
  setDebugAutoPlayDelay: (ms) => set({ debugAutoPlayDelay: ms }),
  setHoveredDebugRef: (ref) => set({ hoveredDebugRef: ref }),
  toggleDebugValue: (name) => set((state) => {
    const next = new Set(state.debugValueToggles);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return { debugValueToggles: next };
  }),
  toggleKruskalDsuGroups: () => set((state) => ({ showKruskalDsuGroups: !state.showKruskalDsuGroups })),
  setDebugSearchQuery: (query) => set({ debugSearchQuery: query }),
});
