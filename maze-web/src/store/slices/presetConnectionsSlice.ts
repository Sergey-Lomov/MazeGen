import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry } from "../../pixi/fieldEditUtils";
import { applyTool, materializeReset, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers, computeInvalidSplitPoints, resolveCells, presetEdgeKey, canonicalizePresetPair, resolvePresetActiveEndpoint, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint, rotatePresetSplitPoint } from "../../pixi/fieldEditUtils";
import { presetEndpoint, presetEndpointIsSplit, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import type { SplitRef } from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeState, MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock } from "../storeHelpers";

export const createPresetConnectionsSlice: StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions> = (set, get) => ({
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
  presetSplitPoints: {},
  presetActiveSplitNode: {},
  presetFocusedPoint: null,
  presetHoveredLink: null,

  setPresetConnectionsTool: (tool) => set({ presetConnectionsTool: tool, presetTeleportPendingFrom: null }),

  applyPresetConnectionsTool: (key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool, state.defaultEdgeState, state.presetActiveSplitNode);
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  applyPresetConnectionsToolAt: (tool, key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, tool, state.defaultEdgeState, state.presetActiveSplitNode);
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  setPresetConnectionUndefined: (key, from, to) => set((state) => {
    const presetConnections = new Map(state.presetConnections);
    presetConnections.set(key, { from, to, state: "undefined", source: "user" });
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
    const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, state.tessellationConfig, customPts);
    const presetSplitPoints = { ...state.presetSplitPoints };
    for (const key of invalidSplitKeys) delete presetSplitPoints[key];
    return withRecomputedAutoLock(state, { presetConnections, presetTeleports, presetStart, presetFinish, presetSplitPoints });
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
    presetSplitPoints: {},
    presetActiveSplitNode: {},
    presetFocusedPoint: null,
    presetHoveredLink: null,
    debugStale: debugStaleOf(state),
  })),

  applyPresetConnectionsReset: (key) => set((state) => {
    const existing = state.presetConnections.get(key);
    if (!existing) return {};
    const presetConnections = materializeReset(state.presetConnections, { key, from: existing.from.point, to: existing.to.point }, state.defaultEdgeState);
    return withRecomputedAutoLock(state, { presetConnections });
  }),

  setAutoLock: (v) => set((state) => ({
    autoLock: v,
    autoLockedNodes: v ? recomputeAutoLock({ ...state, autoLock: v }) : new Set<string>(),
    debugStale: debugStaleOf(state),
  })),

  setPresetStart: (cell) => set((state) => ({
    presetStart: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode),
    debugStale: debugStaleOf(state),
  })),
  setPresetFinish: (cell) => set((state) => ({
    presetFinish: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode),
    debugStale: debugStaleOf(state),
  })),
  setPresetStartEndpoint: (endpoint) => set((state) => ({ presetStart: endpoint, debugStale: debugStaleOf(state) })),
  setPresetFinishEndpoint: (endpoint) => set((state) => ({ presetFinish: endpoint, debugStale: debugStaleOf(state) })),
  setPresetGenSource: (cell) => set((state) => ({
    presetGenSource: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode),
    debugStale: debugStaleOf(state),
  })),

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
    const entry: PresetTeleportEntry = { id: state._nextPresetTeleportId, from: presetEndpoint(from), to: presetEndpoint(to), direction };
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

  addPresetSplitNode: (point) => set((state) => {
    const { splitPoints, slotId } = addSlot(state.presetSplitPoints, point);
    return {
      presetSplitPoints: splitPoints,
      presetActiveSplitNode: { ...state.presetActiveSplitNode, [`${point[0]},${point[1]}`]: presetEndpoint(point, slotId) },
      presetsDirty: true,
      debugStale: debugStaleOf(state),
    };
  }),

  removePresetSplitNode: (point, slotId) => {
    const state = get();
    const target: SplitRef = { point, slotId };

    const meta = { start: state.presetStart, finish: state.presetFinish, genSource: state.presetGenSource };
    if ((meta.start && presetEndpointIsSplit(meta.start, target))
      || (meta.finish && presetEndpointIsSplit(meta.finish, target))
      || (meta.genSource && presetEndpointIsSplit(meta.genSource, target))) {
      set({ error: "Cannot remove a node assigned as start/finish/gen-source — reassign it first." });
      return;
    }

    set((state) => {
      const refsTarget = (ep: PresetEndpoint) => presetEndpointIsSplit(ep, target);

      const presetConnections = new Map(state.presetConnections);
      for (const [key, entry] of presetConnections) {
        if (refsTarget(entry.from) || refsTarget(entry.to)) presetConnections.delete(key);
      }
      const presetTeleports = state.presetTeleports.filter(t => !refsTarget(t.from) && !refsTarget(t.to));
      // Locked nodes are keyed by plain "x,y" (point only, no slot) — a lock addressing this
      // exact split node isn't representable in that map today (locks are always original-node
      // only), so nothing to clean up there.

      const { splitPoints, activeMap } = removeSlot(
        state.presetSplitPoints, state.presetActiveSplitNode, point, slotId,
        (entry, point, slotId) => entry.slotId !== undefined && presetEndpointIsSplit(entry, { point, slotId }),
      );

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports,
        presetSplitPoints: splitPoints, presetActiveSplitNode: activeMap,
        presetsDirty: true,
      });
    });
  },

  cyclePresetActiveSplitNode: (point) => set((state) => ({
    presetActiveSplitNode: cycleActive(
      state.presetSplitPoints, state.presetActiveSplitNode, point,
      presetEndpoint, (entry) => entry?.slotId,
    ),
  })),

  setPresetActiveSplitNode: (point, endpoint) => set((state) => ({
    presetActiveSplitNode: setActive(state.presetActiveSplitNode, point, endpoint, (e) => e.slotId === undefined),
  })),

  setPresetFocusedPoint: (point) => set({ presetFocusedPoint: point }),
  setPresetHoveredLink: (link) => set({ presetHoveredLink: link }),

  rotatePresetSplitPoint: (point, direction) => set((state) => {
    const key = `${point[0]},${point[1]}`;
    const slotIds = state.presetSplitPoints[key] ?? [];
    const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0 ? state.fieldPoints : undefined;
    const cells = resolveCells(state.tessellationConfig, customPts);
    const cellSet = buildCellSet(cells);
    const presetConnections = rotatePresetSplitPoint(
      state.presetConnections, point, slotIds, direction, state.tessellationConfig, cellSet,
    );
    if (presetConnections === state.presetConnections) return {};
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  applyPresetSplitBlueprint: (point, blueprint) => {
    const state = get();
    const key = `${point[0]},${point[1]}`;
    const existingSlots = state.presetSplitPoints[key] ?? [];
    // Every node currently at this point — original plus every declared slot — is about to have
    // its faces fully rebuilt by the blueprint.
    const existingNodeEndpoints: PresetEndpoint[] = [presetEndpoint(point), ...existingSlots.map((slotId) => presetEndpoint(point, slotId))];
    const refsExistingNode = (ep: PresetEndpoint) => existingNodeEndpoints.some((t) => presetEndpointsEqual(ep, t));

    if ((state.presetStart && refsExistingNode(state.presetStart))
      || (state.presetFinish && refsExistingNode(state.presetFinish))
      || (state.presetGenSource && refsExistingNode(state.presetGenSource))) {
      set({ error: "Cannot apply a blueprint while an existing split node is assigned as start/finish/gen-source — reassign it first." });
      return;
    }

    set((state) => {
      const presetConnections = new Map(state.presetConnections);
      for (const [k, entry] of presetConnections) {
        if (refsExistingNode(entry.from) || refsExistingNode(entry.to)) presetConnections.delete(k);
      }
      const presetTeleports = state.presetTeleports.filter((t) => !refsExistingNode(t.from) && !refsExistingNode(t.to));
      const presetActiveSplitNode = { ...state.presetActiveSplitNode };
      delete presetActiveSplitNode[key];

      const nodeEndpoints: PresetEndpoint[] = blueprint.nodeFaces.map((_, i) => (i === 0 ? presetEndpoint(point) : presetEndpoint(point, i - 1)));

      const { offsets } = getNeighborData(state.tessellationConfig, point[0], point[1]);
      const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0 ? state.fieldPoints : undefined;
      const cells = resolveCells(state.tessellationConfig, customPts);
      const inFieldCells = buildCellSet(cells);
      const resolveActiveAt = (p: [number, number]): PresetEndpoint =>
        resolvePresetActiveEndpoint(p, presetActiveSplitNode);

      // Every one of the blueprint's declared faces gets a `passage`; every other in-field face
      // of the tile gets an explicit `wall` — presets default to `undefined` (optional), which
      // would leave a blueprint's "no connection here" faces looking undecided instead of forbidden.
      // Bounded by `offsets.length` (the tile's real degree), not `blueprint.degree` — guards
      // against a caller passing a blueprint authored for a different tile degree (normal UI flow
      // always picks one via `blueprintsForDegree`, so this only matters for a direct call).
      const faceCount = Math.min(blueprint.degree, offsets.length);
      for (let nodeIndex = 0; nodeIndex < blueprint.nodeFaces.length; nodeIndex++) {
        const endpoint = nodeEndpoints[nodeIndex];
        const requiredFaces = new Set(blueprint.nodeFaces[nodeIndex]);
        for (let faceIndex = 0; faceIndex < faceCount; faceIndex++) {
          const [dx, dy] = offsets[faceIndex];
          const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
          if (!inFieldCells.has(`${neighbor[0]},${neighbor[1]}`)) continue;
          const neighborActive = resolveActiveAt(neighbor);
          const edgeK = presetEdgeKey(endpoint, neighborActive);
          const [from, to] = canonicalizePresetPair(endpoint, neighborActive);
          presetConnections.set(edgeK, { from, to, state: requiredFaces.has(faceIndex) ? "passage" : "wall", source: "user" });
        }
      }

      const nextSplitPoints = { ...state.presetSplitPoints };
      const slotCount = blueprint.nodeFaces.length - 1;
      if (slotCount <= 0) delete nextSplitPoints[key];
      else nextSplitPoints[key] = Array.from({ length: slotCount }, (_, i) => i);

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports,
        presetSplitPoints: nextSplitPoints, presetActiveSplitNode,
        presetsDirty: true,
      });
    });
  },
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
      const less = x < nx || (x === nx && y < ny);
      if (!less) continue; // only process edge once (owner = canonical-lesser cell)
      const from = presetEndpoint([x, y]);
      const to = presetEndpoint([nx, ny]);
      const key = presetEdgeKey(from, to);
      if (!presetConnections.has(key)) {
        presetConnections.set(key, { from, to, state: newDefault, source: "default" });
      }
    }
  }
  return presetConnections;
}
