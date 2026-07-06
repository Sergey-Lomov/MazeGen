import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import { applyTool, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers, resolveCells, edgeKey, canonicalize, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint } from "../../pixi/fieldEditUtils";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeState, MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock } from "../storeHelpers";

export const createPresetConnectionsSlice: StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions> = (set) => ({
  presetConnections: new Map<string, PresetConnectionEntry>(),
  presetConnectionsTool: "wall" as PresetConnectionTool,
  defaultEdgeState: "undefined" as const,
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  highlightInvalidPresets: false,
  highlightIsolatedNodes: false,
  showPresetOrigin: false,
  lockedNodes: new Map<string, NodeLockKind>(),
  autoLock: true,
  autoLockedNodes: new Set<string>(),
  presetsDirty: false,
  presetTeleports: [] as PresetTeleportEntry[],
  presetTeleportPendingFrom: null,
  _nextPresetTeleportId: 1,

  setPresetConnectionsTool: (tool) => set({ presetConnectionsTool: tool, presetTeleportPendingFrom: null }),

  applyPresetConnectionsTool: (key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool);
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  clearInvalidPresetConnections: () => set((state) => {
    const customPts = state.isEditingField ? state.fieldPoints : undefined;
    const invalidKeys = computeInvalidKeys(state.presetConnections, state.tessellationConfig, customPts);
    const presetConnections = new Map(state.presetConnections);
    for (const key of invalidKeys) presetConnections.delete(key);
    const invalidTeleportIds = computeInvalidTeleportIds(state.presetTeleports, state.tessellationConfig, customPts);
    const presetTeleports = state.presetTeleports.filter(t => !invalidTeleportIds.has(t.id));
    const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, state.tessellationConfig, customPts);
    const presetStart = invalidMarkers.start ? null : state.presetStart;
    const presetFinish = invalidMarkers.finish ? null : state.presetFinish;
    return withRecomputedAutoLock(state, { presetConnections, presetTeleports, presetStart, presetFinish });
  }),

  resetPresetConnections: () => set((state) => ({
    presetConnections: new Map<string, PresetConnectionEntry>(),
    defaultEdgeState: "undefined" as const,
    presetStart: null,
    presetFinish: null,
    presetGenSource: null,
    lockedNodes: new Map<string, NodeLockKind>(),
    autoLockedNodes: new Set<string>(),
    presetTeleports: [] as PresetTeleportEntry[],
    presetTeleportPendingFrom: null,
    _nextPresetTeleportId: 1,
    debugStale: debugStaleOf(state),
  })),

  applyPresetConnectionsReset: (key) => set((state) => {
    const existing = state.presetConnections.get(key);
    if (!existing) return {};
    const presetConnections = new Map(state.presetConnections);
    presetConnections.set(key, { from: existing.from, to: existing.to, state: "undefined", source: "user" });
    return withRecomputedAutoLock(state, { presetConnections });
  }),

  setAutoLock: (v) => set((state) => ({
    autoLock: v,
    autoLockedNodes: v ? recomputeAutoLock({ ...state, autoLock: v }) : new Set<string>(),
    debugStale: debugStaleOf(state),
  })),

  setPresetStart: (cell) => set((state) => ({ presetStart: cell, debugStale: debugStaleOf(state) })),
  setPresetFinish: (cell) => set((state) => ({ presetFinish: cell, debugStale: debugStaleOf(state) })),
  setPresetGenSource: (cell) => set((state) => ({ presetGenSource: cell, debugStale: debugStaleOf(state) })),

  setDefaultEdgeState: (s) => set((state) => {
    const presetConnections = applyDefaultEdgeState(state, s);
    return withRecomputedAutoLock(state, { defaultEdgeState: s, presetConnections });
  }),
  setHighlightInvalidPresets: (highlight) => set({ highlightInvalidPresets: highlight }),
  setHighlightIsolatedNodes: (highlight) => set({ highlightIsolatedNodes: highlight }),
  setShowPresetOrigin: (show) => set({ showPresetOrigin: show }),

  setLockedNode: (x, y, kind) => set((state) => {
    const next = new Map(state.lockedNodes);
    next.set(`${x},${y}`, kind);
    return { lockedNodes: next, debugStale: debugStaleOf(state) };
  }),

  removeLockedNode: (x, y) => set((state) => {
    const key = `${x},${y}`;
    if (!state.lockedNodes.has(key)) return {};
    const next = new Map(state.lockedNodes);
    next.delete(key);
    return { lockedNodes: next, debugStale: debugStaleOf(state) };
  }),

  clearLockedNodes: () => set((state) => ({ lockedNodes: new Map<string, NodeLockKind>(), autoLockedNodes: new Set<string>(), debugStale: debugStaleOf(state) })),

  setPresetTeleportPendingFrom: (cell) => set({ presetTeleportPendingFrom: cell }),

  addPresetTeleport: (from, to, direction) => set((state) => {
    const entry: PresetTeleportEntry = { id: state._nextPresetTeleportId, from, to, direction };
    return {
      presetTeleports: [...state.presetTeleports, entry],
      _nextPresetTeleportId: state._nextPresetTeleportId + 1,
      presetTeleportPendingFrom: null,
      presetsDirty: true,
      debugStale: debugStaleOf(state),
    };
  }),

  cyclePresetTeleportDirection: (id) => set((state) => ({
    presetTeleports: cycleTeleportDirection(state.presetTeleports, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  removePresetTeleport: (id) => set((state) => ({
    presetTeleports: removeTeleport(state.presetTeleports, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  movePresetTeleportEndpoint: (id, end, cell) => set((state) => ({
    presetTeleports: moveTeleportEndpoint(state.presetTeleports, { id, end }, cell),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),
});

export function applyDefaultEdgeState(
  state: MazeState,
  newDefault: "undefined" | "wall" | "passage",
): Map<string, PresetConnectionEntry> {
  const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0 ? state.fieldPoints : undefined;
  const cells = resolveCells(state.tessellationConfig, customPts);
  const cellSet = buildCellSet(cells);

  // Remove all existing default entries, then add new ones if needed
  const presetConnections = new Map(state.presetConnections);
  for (const [key, entry] of presetConnections) {
    if (entry.source === "default") presetConnections.delete(key);
  }

  if (newDefault === "undefined") return presetConnections;

  for (const [x, y] of cells) {
    const { offsets } = getNeighborData(state.tessellationConfig, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      const [from, to] = canonicalize([x, y], [nx, ny]);
      if (from[0] !== x || from[1] !== y) continue; // only process edge once (owner = canonical-lesser cell)
      const key = edgeKey(from, to);
      if (!presetConnections.has(key)) {
        presetConnections.set(key, { from, to, state: newDefault, source: "default" });
      }
    }
  }
  return presetConnections;
}
