import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import { applyTool, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys, computeInvalidSplitPoints, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint, moveVerticalPassageEndpoint, moveElevatorEndpoint } from "../../pixi/fieldEditUtils";
import { resolvePresetActiveEndpoint, allNodesAt } from "../../pixi/presetSplitResolve";
import { presetEndpoint, presetEndpointKey, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { buildPresetPointEntities, type PresetPointEntityDescriptor, type PresetPointEntityScope } from "../../pixi/pointEntities";
import { presetPurposeEntitiesAt, type EntityToolPurpose } from "../../pixi/entityToolKinds";
import type { NodeLockKind } from "../../wasm/types";
import { isPresetLockTool, type MazeState, type MazeStore, type PresetConnectionsState, type PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock, activeFloorLevel, resolveFieldAtOf } from "../storeHelpers";
import { notifyVerticalDragFailure } from "../../notifications/editRefusalNotifications";
import { createPresetSplitActions } from "./presetSplitActions";
import { createPresetVerticalActions } from "./presetVerticalActions";
import { resetEdgeToDefault, appendPresetEntityOrder, removePresetEntityOrder, edgeEntityKey, splitEntityKey, removeDeletedUserEdgeOrder, addNewUserEdgeOrder, commitPresetVerticalPassage, dispatchPresetElevatorPlacement, applyDefaultEdgeState } from "./presetConnectionsHelpers";
export { applyDefaultEdgeState } from "./presetConnectionsHelpers";

/** Plain 0-based active floor index (0 = floor 0), unlike `activeFloorLevel` (`undefined` = floor
 * 0) — `buildPresetPointEntities`'s `activeFloorLevel` param needs this convention to match
 * `cellInspectionResolver.ts`'s `activeFloorIndex`, since it's compared directly against a
 * `PresetEndpoint.level` normalized the same way (`other.level ?? 0`). */
function activeFloorIndex(state: MazeState): number {
  return Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
}

/** Moves the user lock on `from` to `to`, keeping its kind and its place in the entity order. A
 *  lock already on `to` is replaced. */
function relocatePresetLock(state: MazeState, from: PresetEndpoint, to: PresetEndpoint): Partial<MazeState> {
  const fromKey = presetEndpointKey(from);
  const toKey = presetEndpointKey(to);
  const kind = state.lockedNodes.get(fromKey);
  if (!kind || fromKey === toKey) return {};
  const lockedNodes = new Map(state.lockedNodes);
  lockedNodes.delete(fromKey);
  lockedNodes.set(toKey, kind);
  const presetEntityOrder = removePresetEntityOrder(state.presetEntityOrder, `lock:${toKey}`)
    .map((key) => (key === `lock:${fromKey}` ? `lock:${toKey}` : key));
  return { lockedNodes, presetEntityOrder, debugStale: debugStaleOf(state) };
}

export const createPresetConnectionsSlice: StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions> = (set, get) => ({
  presetConnections: new Map<string, PresetConnectionEntry>(),
  presetConnectionsTool: "wall" as PresetConnectionTool,
  defaultEdgeState: "undefined" as const,
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  generationSourceMode: "random",
  highlightInvalidPresets: false,
  highlightIsolatedNodes: false,
  highlightOrphanSplitNodes: false,
  showPresetOrigin: false,
  showPresetLocks: true,
  showPresetLocksBeforeLockTool: null,
  lockedNodes: new Map<string, NodeLockKind>(),
  autoLock: true,
  autoLockedNodes: new Set<string>(),
  presetsDirty: false,
  presetTeleports: [] as PresetTeleportEntry[],
  presetTeleportPendingFrom: null,
  _nextPresetTeleportId: 1,
  presetVerticalPassages: [] as PresetVerticalPassageEntry[],
  presetVerticalPassagePending: null,
  _nextPresetVerticalPassageId: 1,
  presetElevators: [] as PresetElevatorEntry[],
  presetElevatorPending: null,
  _nextPresetElevatorId: 1,
  presetSplitPoints: {},
  presetSplitPointIds: {},
  _nextPresetSplitPointId: 1,
  presetEntityOrder: [],
  presetActiveSplitNode: {},
  presetFocusedPoint: null,
  presetHoveredLink: null,
  presetHoveredEntity: null,
  presetHoveredEntityMode: "inset" as const,
  presetSectionsExpanded: { problems: false },
  presetSplitTargetPrompt: null,
  presetEntityDeletePrompt: null,
  presetDragOverride: null,
  presetEntityPickPrompt: null,
  presetMoveRequest: null,
  presetConnectionSettingsPrompt: null,
  presetLockSettingsPrompt: null,

  setPresetConnectionsTool: (tool) => set((state) => {
    const enteringLockTools = isPresetLockTool(tool) && !isPresetLockTool(state.presetConnectionsTool);
    const leavingLockTools = !isPresetLockTool(tool) && isPresetLockTool(state.presetConnectionsTool);
    return {
      presetConnectionsTool: tool,
      ...(enteringLockTools ? {
        showPresetLocksBeforeLockTool: state.showPresetLocks,
        showPresetLocks: true,
      } : leavingLockTools ? {
        showPresetLocks: state.showPresetLocksBeforeLockTool ?? state.showPresetLocks,
        showPresetLocksBeforeLockTool: null,
      } : {}),
      presetTeleportPendingFrom: null,
      presetVerticalPassagePending: null,
      presetElevatorPending: null,
      presetSplitTargetPrompt: null,
      presetEntityDeletePrompt: null,
      presetEntityPickPrompt: null,
      presetMoveRequest: null,
      presetConnectionSettingsPrompt: null,
      presetLockSettingsPrompt: null,
      ...(tool !== "manage_split_nodes" ? { presetFocusedPoint: null } : {}),
    };
  }),

  setPresetSectionExpanded: (id, expanded) =>
    set((s) => ({ presetSectionsExpanded: { ...s.presetSectionsExpanded, [id]: expanded } })),

  applyPresetConnectionsTool: (key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool, state.defaultEdgeState, state.presetActiveSplitNode, activeFloorLevel(state));
    if (presetConnections === state.presetConnections) return state;
    return withRecomputedAutoLock(state, { presetConnections, presetEntityOrder: addNewUserEdgeOrder(state.presetConnections, presetConnections, state.presetEntityOrder), presetsDirty: true });
  }),

  applyPresetConnectionsToolAt: (tool, key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, tool, state.defaultEdgeState, state.presetActiveSplitNode, activeFloorLevel(state));
    if (presetConnections === state.presetConnections) return state;
    return withRecomputedAutoLock(state, { presetConnections, presetEntityOrder: addNewUserEdgeOrder(state.presetConnections, presetConnections, state.presetEntityOrder), presetsDirty: true });
  }),

  cyclePresetConnectionDirection: (key) => set((state) => {
    const entry = state.presetConnections.get(key);
    if (!entry || (entry.state !== "one_way_forward" && entry.state !== "one_way_backward")) return state;
    const presetConnections = new Map(state.presetConnections);
    presetConnections.set(key, {
      ...entry,
      state: entry.state === "one_way_forward" ? "one_way_backward" : "one_way_forward",
      source: "user",
    });
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  setPresetConnectionUndefined: (key, from, to) => set((state) => {
    const presetConnections = new Map(state.presetConnections);
    // Keep an explicit user choice as a real entry. `undefined` is not the same as "never
    // configured": orphan split-node diagnostics use entry presence, so reverting every face to
    // undefined intentionally suppresses the warning after the user has edited the node.
    presetConnections.set(key, { from, to, state: "undefined", source: "user" });
    return withRecomputedAutoLock(state, { presetConnections, presetEntityOrder: addNewUserEdgeOrder(state.presetConnections, presetConnections, state.presetEntityOrder), presetsDirty: true });
  }),

  clearInvalidPresetConnections: () => set((state) => {
    const resolveFieldAt = resolveFieldAtOf(state);
    const invalidKeys = computeInvalidKeys(state.presetConnections, resolveFieldAt);
    const presetConnections = new Map(state.presetConnections);
    const removedEntityKeys = new Set<string>();
    for (const key of invalidKeys) {
      if (state.presetConnections.get(key)?.source === "user") removedEntityKeys.add(edgeEntityKey(key));
      presetConnections.delete(key);
    }
    const invalidTeleportIds = computeInvalidTeleportIds(state.presetTeleports, resolveFieldAt);
    const presetTeleports = state.presetTeleports.filter(t => !invalidTeleportIds.has(t.id));
    for (const id of invalidTeleportIds) removedEntityKeys.add(`teleport:${id}`);
    const invalidVerticalPassageIds = computeInvalidVerticalPassageIds(state.presetVerticalPassages, resolveFieldAt);
    const presetVerticalPassages = state.presetVerticalPassages.filter(p => !invalidVerticalPassageIds.has(p.id));
    for (const id of invalidVerticalPassageIds) removedEntityKeys.add(`vertical_passage:${id}`);
    const invalidElevatorIds = computeInvalidElevatorIds(state.presetElevators, resolveFieldAt);
    const presetElevators = state.presetElevators.filter(e => !invalidElevatorIds.has(e.id));
    for (const id of invalidElevatorIds) removedEntityKeys.add(`elevator:${id}`);
    const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, resolveFieldAt);
    const presetStart = invalidMarkers.start ? null : state.presetStart;
    const presetFinish = invalidMarkers.finish ? null : state.presetFinish;
    const presetGenSource = computeInvalidEndpoint(state.presetGenSource, resolveFieldAt) ? null : state.presetGenSource;
    if (invalidMarkers.start) removedEntityKeys.add("start");
    if (invalidMarkers.finish) removedEntityKeys.add("finish");
    if (presetGenSource === null && state.presetGenSource !== null) removedEntityKeys.add("gen_source");
    const invalidLockedKeys = computeInvalidLockedNodeKeys(state.lockedNodes, resolveFieldAt);
    const lockedNodes = new Map(state.lockedNodes);
    for (const key of invalidLockedKeys) lockedNodes.delete(key);
    for (const key of invalidLockedKeys) removedEntityKeys.add(`lock:${key}`);
    const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, resolveFieldAt);
    const presetSplitPoints = { ...state.presetSplitPoints };
    for (const key of invalidSplitKeys) delete presetSplitPoints[key];
    const presetSplitPointIds = { ...state.presetSplitPointIds };
    for (const key of invalidSplitKeys) {
      delete presetSplitPointIds[key];
      removedEntityKeys.add(splitEntityKey(key));
    }
    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators,
      presetStart, presetFinish, presetGenSource, lockedNodes, presetSplitPoints, presetSplitPointIds,
      presetEntityOrder: removeDeletedUserEdgeOrder(state.presetConnections, presetConnections, state.presetEntityOrder)
        .filter((key) => !removedEntityKeys.has(key)),
    });
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
    presetVerticalPassages: [] as PresetVerticalPassageEntry[],
    presetVerticalPassagePending: null,
    _nextPresetVerticalPassageId: 1,
    presetElevators: [] as PresetElevatorEntry[],
    presetElevatorPending: null,
    _nextPresetElevatorId: 1,
    presetSplitPoints: {},
    presetSplitPointIds: {},
    _nextPresetSplitPointId: 1,
    presetEntityOrder: [],
    presetActiveSplitNode: {},
    presetFocusedPoint: null,
    presetHoveredLink: null,
    presetHoveredEntity: null,
    presetSplitTargetPrompt: null,
    presetEntityDeletePrompt: null,
    presetEntityPickPrompt: null,
    presetMoveRequest: null,
    presetConnectionSettingsPrompt: null,
    presetLockSettingsPrompt: null,
    debugStale: debugStaleOf(state),
  })),

  setAutoLock: (v) => set((state) => ({
    autoLock: v,
    autoLockedNodes: v ? recomputeAutoLock({ ...state, autoLock: v }) : new Set<string>(),
    debugStale: debugStaleOf(state),
  })),

  setPresetStart: (cell) => set((state) => ({
    presetStart: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    presetEntityOrder: cell === null
      ? removePresetEntityOrder(state.presetEntityOrder, "start")
      : appendPresetEntityOrder(state.presetEntityOrder, "start"),
    debugStale: debugStaleOf(state),
  })),
  setPresetFinish: (cell) => set((state) => ({
    presetFinish: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    presetEntityOrder: cell === null
      ? removePresetEntityOrder(state.presetEntityOrder, "finish")
      : appendPresetEntityOrder(state.presetEntityOrder, "finish"),
    debugStale: debugStaleOf(state),
  })),
  setPresetStartEndpoint: (endpoint) => set((state) => ({
    presetStart: endpoint,
    presetEntityOrder: endpoint === null
      ? removePresetEntityOrder(state.presetEntityOrder, "start")
      : appendPresetEntityOrder(state.presetEntityOrder, "start"),
    debugStale: debugStaleOf(state),
  })),
  setPresetFinishEndpoint: (endpoint) => set((state) => ({
    presetFinish: endpoint,
    presetEntityOrder: endpoint === null
      ? removePresetEntityOrder(state.presetEntityOrder, "finish")
      : appendPresetEntityOrder(state.presetEntityOrder, "finish"),
    debugStale: debugStaleOf(state),
  })),
  setGenerationSourceMode: (mode) => set((state) => ({
    generationSourceMode: mode,
    debugStale: debugStaleOf(state),
  })),
  setPresetGenSource: (cell) => set((state) => ({
    presetGenSource: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    presetEntityOrder: cell === null
      ? removePresetEntityOrder(state.presetEntityOrder, "gen_source")
      : appendPresetEntityOrder(state.presetEntityOrder, "gen_source"),
    debugStale: debugStaleOf(state),
  })),
  setPresetGenSourceEndpoint: (endpoint) => set((state) => ({
    presetGenSource: endpoint,
    presetEntityOrder: endpoint === null
      ? removePresetEntityOrder(state.presetEntityOrder, "gen_source")
      : appendPresetEntityOrder(state.presetEntityOrder, "gen_source"),
    debugStale: debugStaleOf(state),
  })),

  setDefaultEdgeState: (s) => set((state) => {
    const presetConnections = applyDefaultEdgeState(state, s);
    return withRecomputedAutoLock(state, { defaultEdgeState: s, presetConnections });
  }),
  setHighlightInvalidPresets: (highlight) => set({ highlightInvalidPresets: highlight }),
  setHighlightIsolatedNodes: (highlight) => set({ highlightIsolatedNodes: highlight }),
  setHighlightOrphanSplitNodes: (highlight) => set({ highlightOrphanSplitNodes: highlight }),
  setShowPresetOrigin: (show) => set({ showPresetOrigin: show }),
  setShowPresetLocks: (show) => set({ showPresetLocks: show }),

  setLockedNode: (x, y, kind, slotId) => set((state) => {
    const next = new Map(state.lockedNodes);
    const level = activeFloorLevel(state);
    const point = presetEndpoint([x, y], slotId, level);
    next.set(presetEndpointKey(point), kind);
    return { lockedNodes: next, presetEntityOrder: appendPresetEntityOrder(state.presetEntityOrder, `lock:${presetEndpointKey(point)}`), debugStale: debugStaleOf(state) };
  }),

  removeLockedNode: (x, y, slotId) => set((state) => {
    const level = activeFloorLevel(state);
    const key = presetEndpointKey(presetEndpoint([x, y], slotId, level));
    if (!state.lockedNodes.has(key)) return {};
    const next = new Map(state.lockedNodes);
    next.delete(key);
    return { lockedNodes: next, presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `lock:${key}`), debugStale: debugStaleOf(state) };
  }),

  clearLockedNodes: () => set((state) => ({ lockedNodes: new Map<string, NodeLockKind>(), autoLockedNodes: new Set<string>(), presetEntityOrder: state.presetEntityOrder.filter((key) => !key.startsWith("lock:")), debugStale: debugStaleOf(state) })),

  setPresetTeleportPendingFrom: (endpoint) => set({ presetTeleportPendingFrom: endpoint }),

  addPresetTeleport: (from, to, direction) => set((state) => {
    const entry: PresetTeleportEntry = { id: state._nextPresetTeleportId, from, to, direction };
    return {
      presetTeleports: [...state.presetTeleports, entry],
      _nextPresetTeleportId: state._nextPresetTeleportId + 1,
      presetTeleportPendingFrom: null,
      presetEntityOrder: appendPresetEntityOrder(state.presetEntityOrder, `teleport:${entry.id}`),
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
    presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `teleport:${id}`),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  movePresetTeleportEndpoint: (id, end, cell, level) => set((state) => ({
    presetTeleports: moveTeleportEndpoint(state.presetTeleports, { id, end }, cell, level),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  ...createPresetVerticalActions(set, get),

  ...createPresetSplitActions(set, get),

  resetPresetPoint: (point) => set((state) => {
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const touchesPoint = (ep: PresetEndpoint) =>
      ep.point[0] === point[0] && ep.point[1] === point[1] && (ep.level ?? 0) === (level ?? 0);

    const presetConnections = new Map(state.presetConnections);
    for (const [k, entry] of presetConnections) {
      if (touchesPoint(entry.from) || touchesPoint(entry.to)) {
        resetEdgeToDefault(presetConnections, state.defaultEdgeState, k, entry.from, entry.to);
      }
    }
    const presetTeleports = state.presetTeleports.filter((t) => !touchesPoint(t.from) && !touchesPoint(t.to));
    const presetVerticalPassages = state.presetVerticalPassages.filter((p) => !touchesPoint(p.from) && !touchesPoint(p.to));
    const presetElevators = state.presetElevators.filter((e) => !e.floors.some(touchesPoint));

    const presetSplitPoints = { ...state.presetSplitPoints };
    delete presetSplitPoints[key];
    const presetActiveSplitNode = { ...state.presetActiveSplitNode };
    delete presetActiveSplitNode[key];

    const presetStart = state.presetStart !== null && touchesPoint(state.presetStart) ? null : state.presetStart;
    const presetFinish = state.presetFinish !== null && touchesPoint(state.presetFinish) ? null : state.presetFinish;
    const presetGenSource = state.presetGenSource !== null && touchesPoint(state.presetGenSource) ? null : state.presetGenSource;

    const removedEntityKeys = new Set<string>();
    for (const [edgeKey, entry] of state.presetConnections) {
      if (entry.source === "user" && (touchesPoint(entry.from) || touchesPoint(entry.to))) {
        removedEntityKeys.add(edgeEntityKey(edgeKey));
      }
    }
    for (const entry of state.presetTeleports) {
      if (touchesPoint(entry.from) || touchesPoint(entry.to)) removedEntityKeys.add(`teleport:${entry.id}`);
    }
    for (const entry of state.presetVerticalPassages) {
      if (touchesPoint(entry.from) || touchesPoint(entry.to)) removedEntityKeys.add(`vertical_passage:${entry.id}`);
    }
    for (const entry of state.presetElevators) {
      if (entry.floors.some(touchesPoint)) removedEntityKeys.add(`elevator:${entry.id}`);
    }
    if (presetStart === null && state.presetStart !== null) removedEntityKeys.add("start");
    if (presetFinish === null && state.presetFinish !== null) removedEntityKeys.add("finish");
    if (presetGenSource === null && state.presetGenSource !== null) removedEntityKeys.add("gen_source");

    const lockedNodes = new Map(state.lockedNodes);
    for (const endpoint of allNodesAt(point, state.presetSplitPoints, level)) {
      lockedNodes.delete(presetEndpointKey(endpoint));
      removedEntityKeys.add(`lock:${presetEndpointKey(endpoint)}`);
    }

    const presetSplitPointIds = { ...state.presetSplitPointIds };
    if (presetSplitPoints[key] === undefined) {
      delete presetSplitPointIds[key];
      removedEntityKeys.add(splitEntityKey(key));
    }

    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators,
      presetSplitPoints, presetSplitPointIds, presetActiveSplitNode,
      presetStart, presetFinish, presetGenSource,
      lockedNodes,
      presetEntityOrder: state.presetEntityOrder.filter((entityKey) => !removedEntityKeys.has(entityKey)),
      presetsDirty: true,
    });
  }),

  requestPresetSplitTarget: (prompt) => set({ presetSplitTargetPrompt: prompt, presetEntityDeletePrompt: null }),
  cancelPresetSplitTarget: () => set({ presetSplitTargetPrompt: null, presetDragOverride: null }),
  applyPresetSplitTargetPick: (slotId) => {
    const prompt = get().presetSplitTargetPrompt;
    if (!prompt) return;
    const level = prompt.level;
    const endpoint = presetEndpoint(prompt.point, slotId, level);
    const { action } = prompt;

    // GitHub issue #594 (parity with post-edit's `applyPostEditSplitTargetPick` from GitHub issue
    // #567): a `move_*`/`place_*_target` action defers a drag commit or a fresh placement through a
    // QUEUE of split points (see `presetSplitTargetPrompt`'s own doc comment) — this pick fills one
    // slot of `picks` rather than dispatching immediately. `queue`/`picks` are always present
    // together for these four tools.
    if (
      action.tool === "move_vertical_passage_endpoint" || action.tool === "move_elevator_endpoint"
      || action.tool === "place_vertical_passage_target" || action.tool === "place_elevator_target"
    ) {
      const queue = prompt.queue ?? [];
      const picks = [...(prompt.picks ?? [])];
      const current = queue[0];
      const targetIndex = current ? current.targetIndex : 0;
      picks[targetIndex] = endpoint;
      const rest = queue.slice(1);
      if (rest.length > 0) {
        const next = rest[0];
        set({ presetSplitTargetPrompt: { ...prompt, point: next.point, level: next.level, slotIds: next.slotIds, queue: rest, picks } });
        return;
      }
      set({ presetSplitTargetPrompt: null });
      // Every branch below assumes `picks` is now fully resolved: `queue` is drained
      // (`rest.length === 0`, checked above) and every non-queued target was already filled by
      // `resolvePresetSplitTargets` before the prompt opened, so the "still missing" guards
      // (`own && other`, `resolved.length === action.levels.length`, `if (to)`,
      // `floors.length === action.levels.length`) should never actually trip. They stay as a
      // defensive backstop — logged rather than silently dropped, so a future regression that DOES
      // break the invariant surfaces instead of just quietly not creating the entity.
      if (action.tool === "move_vertical_passage_endpoint") {
        const own = picks[0];
        const other = picks[1];
        const state = get();
        const entry = state.presetVerticalPassages.find((p) => p.id === action.id);
        if (own && other && entry) {
          const point = own.point;
          const result = moveVerticalPassageEndpoint(state.presetVerticalPassages, { id: action.id, end: action.end }, point, resolveFieldAtOf(state), own, other);
          if (result.failure) notifyVerticalDragFailure("preset_connections", "vertical_passage", result.failure.point, result.failure.level);
          else set({ presetVerticalPassages: result.passages, presetsDirty: true, debugStale: debugStaleOf(state) });
        } else {
          console.error("applyPresetSplitTargetPick: move_vertical_passage_endpoint queue drained with an unresolved pick", { action, picks });
        }
      } else if (action.tool === "move_elevator_endpoint") {
        const resolved = action.levels.map((l, i) => ({ level: l, endpoint: picks[i] })).filter((r): r is { level: number; endpoint: PresetEndpoint } => r.endpoint !== undefined);
        if (resolved.length === action.levels.length) {
          const state = get();
          const overridesByLevel = new Map(resolved.map((r) => [r.level, r.endpoint]));
          const point = resolved[0].endpoint.point;
          const result = moveElevatorEndpoint(state.presetElevators, { id: action.id, level: action.levels[0] }, point, resolveFieldAtOf(state), overridesByLevel);
          if (result.failure) notifyVerticalDragFailure("preset_connections", "elevator", result.failure.point, result.failure.level);
          else set({ presetElevators: result.elevators, presetsDirty: true, debugStale: debugStaleOf(state) });
        } else {
          console.error("applyPresetSplitTargetPick: move_elevator_endpoint queue drained with an unresolved pick", { action, picks });
        }
      } else if (action.tool === "place_vertical_passage_target") {
        const to = picks[0];
        if (to) set(commitPresetVerticalPassage(get(), action.origin, action.passageTool, action.direction, to));
        else console.error("applyPresetSplitTargetPick: place_vertical_passage_target queue drained with an unresolved pick", { action, picks });
      } else {
        const floors = picks.filter((p): p is PresetEndpoint => p !== undefined);
        if (floors.length === action.levels.length) dispatchPresetElevatorPlacement(get, set, action.editingId, floors);
        else console.error("applyPresetSplitTargetPick: place_elevator_target queue drained with an unresolved pick", { action, picks });
      }
      return;
    }

    set({ presetSplitTargetPrompt: null, presetDragOverride: null });
    switch (action.tool) {
      case "set_start":
        get().setPresetStartEndpoint(endpoint);
        break;
      case "set_finish":
        get().setPresetFinishEndpoint(endpoint);
        break;
      case "move_lock":
        set((state) => relocatePresetLock(state, action.from, endpoint));
        break;
      case "move_teleport_endpoint":
        set((state) => ({
          presetTeleports: state.presetTeleports.map((t) => (t.id === action.id ? { ...t, [action.end]: endpoint } : t)),
          presetDragOverride: null,
          presetsDirty: true,
          debugStale: debugStaleOf(state),
        }));
        break;
      case "lock_in":
      case "lock_out":
      case "full_lock": {
        // A lock tool always sets its own kind; changing an existing lock is the settings tool's
        // job (GitHub issue #748).
        const kind: NodeLockKind = action.tool === "lock_in" ? "in" : action.tool === "lock_out" ? "out" : "both";
        get().setLockedNode(endpoint.point[0], endpoint.point[1], kind, endpoint.slotId);
        break;
      }
      case "gen_source":
        get().setPresetGenSourceEndpoint(endpoint);
        break;
      case "vertical_passage_one_way":
      case "vertical_passage_two_way":
        get().startPresetVerticalPassagePlacement(endpoint, action.tool);
        break;
      case "elevator":
        get().startPresetElevatorPlacement(endpoint);
        break;
      case "teleport_one_way":
      case "teleport_two_way": {
        const pendingFrom = get().presetTeleportPendingFrom;
        if (pendingFrom === null) {
          get().setPresetTeleportPendingFrom(endpoint);
        } else if (!presetEndpointsEqual(pendingFrom, endpoint)) {
          get().addPresetTeleport(pendingFrom, endpoint, action.tool === "teleport_two_way" ? "two_way" : "forward");
        }
        break;
      }
    }
  },

  requestPresetEntityDelete: (point, level, scope, bulk) => {
    const state = get();
    const entities = buildPresetPointEntities(point, level, activeFloorIndex(state), scope, {
      presetSplitPoints: state.presetSplitPoints,
      presetStart: state.presetStart,
      presetFinish: state.presetFinish,
      presetGenSource: state.presetGenSource,
      presetTeleports: state.presetTeleports,
      presetVerticalPassages: state.presetVerticalPassages,
      presetElevators: state.presetElevators,
      presetConnections: state.presetConnections,
      lockedNodes: state.lockedNodes,
      autoLockedNodes: state.autoLockedNodes,
    });
    if (entities.length === 0) return;
    // Held shift bypasses the picker dialog entirely and removes every entity at once — the old
    // pre-#540 one-shot behavior, kept available for users who don't want a confirm step every time.
    if (bulk) {
      removeAllPresetPointEntitiesFor(get, point, scope, entities);
      return;
    }
    if (entities.length === 1) {
      get().removePresetPointEntity(entities[0]);
      return;
    }
    set({ presetEntityDeletePrompt: { point, level, scope }, presetSplitTargetPrompt: null });
  },

  cancelPresetEntityDelete: () => set({ presetEntityDeletePrompt: null }),

  requestPresetEntityPick: (point, level, purpose) => {
    const entities = presetPurposeEntitiesAt(get(), point, level, purpose);
    if (entities.length === 0) return;
    if (entities.length === 1) {
      actOnPresetEntity(get, set, purpose, entities[0]);
      return;
    }
    set({ presetEntityPickPrompt: { point, level, purpose }, presetSplitTargetPrompt: null, presetEntityDeletePrompt: null });
  },

  choosePresetEntityPick: (descriptor) => {
    const prompt = get().presetEntityPickPrompt;
    if (!prompt) return;
    set({ presetEntityPickPrompt: null });
    actOnPresetEntity(get, set, prompt.purpose, descriptor);
  },

  cancelPresetEntityPick: () => set({ presetEntityPickPrompt: null }),

  takePresetMoveRequest: () => {
    const request = get().presetMoveRequest;
    if (request) set({ presetMoveRequest: null });
    return request;
  },

  openPresetEntitySettings: (descriptor) => {
    switch (descriptor.kind) {
      case "teleport":
      case "vertical_passage":
        set({ presetConnectionSettingsPrompt: { kind: descriptor.kind, id: Number(descriptor.id) } });
        break;
      case "elevator":
        get().editPresetElevator(Number(descriptor.id), descriptor.endpoint);
        break;
      case "lock":
        set({ presetLockSettingsPrompt: { endpoint: descriptor.endpoint } });
        break;
      case "split_node":
        // The split-node panel is only shown while its own tool is active (GitHub issue #699).
        get().setPresetConnectionsTool("manage_split_nodes");
        get().setPresetFocusedPoint(descriptor.endpoint.point);
        break;
      default:
        break;
    }
  },

  cancelPresetConnectionSettings: () => set({ presetConnectionSettingsPrompt: null }),
  cancelPresetLockSettings: () => set({ presetLockSettingsPrompt: null }),

  setPresetTeleportDirection: (id, direction) => set((state) => {
    const entry = state.presetTeleports.find((t) => t.id === id);
    if (!entry || entry.direction === direction) return {};
    return {
      presetTeleports: state.presetTeleports.map((t) => (t.id === id ? { ...t, direction } : t)),
      presetsDirty: true,
      debugStale: debugStaleOf(state),
    };
  }),

  setPresetVerticalPassageDirection: (id, direction) => set((state) => {
    const entry = state.presetVerticalPassages.find((p) => p.id === id);
    if (!entry || entry.direction === direction) return {};
    return {
      presetVerticalPassages: state.presetVerticalPassages.map((p) => (p.id === id ? { ...p, direction } : p)),
      presetsDirty: true,
      debugStale: debugStaleOf(state),
    };
  }),

  setPresetLockKind: (endpoint, kind) => set((state) => {
    const key = presetEndpointKey(endpoint);
    if (!state.lockedNodes.has(key) || state.lockedNodes.get(key) === kind) return {};
    const lockedNodes = new Map(state.lockedNodes);
    lockedNodes.set(key, kind);
    return { lockedNodes, debugStale: debugStaleOf(state) };
  }),

  movePresetMarker: (marker, point) => {
    const state = get();
    const level = activeFloorLevel(state);
    const slotIds = state.presetSplitPoints[splitPointKeyOf(point, level)] ?? [];
    if (slotIds.length > 0) {
      const tool = marker === "start" ? "set_start" : marker === "finish" ? "set_finish" : "gen_source";
      get().requestPresetSplitTarget({ point, level, slotIds: [...slotIds].sort((a, b) => a - b), action: { tool } });
      return;
    }
    const endpoint = presetEndpoint(point, undefined, level);
    if (marker === "start") get().setPresetStartEndpoint(endpoint);
    else if (marker === "finish") get().setPresetFinishEndpoint(endpoint);
    else get().setPresetGenSourceEndpoint(endpoint);
  },

  movePresetTeleportEndpointTo: (id, end, point) => {
    const state = get();
    const entry = state.presetTeleports.find((t) => t.id === id);
    if (!entry) return;
    const level = entry[end].level;
    const allSlotIds = state.presetSplitPoints[splitPointKeyOf(point, level)] ?? [];
    if (allSlotIds.length > 0) {
      // The endpoint may land on any node of a split tile except the one the other endpoint uses.
      const slotIds = [...allSlotIds].sort((a, b) => a - b);
      const other = entry[end === "from" ? "to" : "from"];
      const otherHere = other.point[0] === point[0] && other.point[1] === point[1] && (other.level ?? 0) === (level ?? 0);
      const candidates = [undefined, ...slotIds].filter((slotId) => !otherHere || other.slotId !== slotId);
      if (candidates.length === 1) {
        const endpoint = presetEndpoint(point, candidates[0], level);
        set((s) => ({
          presetTeleports: s.presetTeleports.map((t) => (t.id === id ? { ...t, [end]: endpoint } : t)),
          presetDragOverride: null,
          presetsDirty: true,
          debugStale: debugStaleOf(s),
        }));
      } else {
        get().requestPresetSplitTarget({
          point, level, slotIds, action: { tool: "move_teleport_endpoint", id, end },
          ...(otherHere ? { excluded: other.slotId === undefined ? {} : { slotId: other.slotId } } : {}),
        });
      }
      return;
    }
    get().movePresetTeleportEndpoint(id, end, point, level ?? 0);
  },

  movePresetLockTo: (from, point) => {
    const state = get();
    const level = from.level;
    const slotIds = state.presetSplitPoints[splitPointKeyOf(point, level)] ?? [];
    if (slotIds.length > 0) {
      get().requestPresetSplitTarget({ point, level, slotIds: [...slotIds].sort((a, b) => a - b), action: { tool: "move_lock", from } });
      return;
    }
    set((s) => ({ ...relocatePresetLock(s, from, presetEndpoint(point, undefined, level)), presetDragOverride: null }));
  },

  removePresetPointEntity: (descriptor) => {
    switch (descriptor.kind) {
      case "start":
        get().setPresetStartEndpoint(null);
        break;
      case "finish":
        get().setPresetFinishEndpoint(null);
        break;
      case "gen_source":
        get().setPresetGenSourceEndpoint(null);
        break;
      case "teleport":
        get().removePresetTeleport(Number(descriptor.id));
        break;
      case "vertical_passage":
        get().removePresetVerticalPassage(Number(descriptor.id));
        break;
      case "elevator":
        get().removePresetElevator(Number(descriptor.id));
        break;
      case "lock":
        get().removeLockedNode(descriptor.endpoint.point[0], descriptor.endpoint.point[1], descriptor.endpoint.slotId);
        break;
      case "edge":
        set((state) => {
          const presetConnections = new Map(state.presetConnections);
          const entry = presetConnections.get(descriptor.id);
          if (entry) resetEdgeToDefault(presetConnections, state.defaultEdgeState, descriptor.id, entry.from, entry.to);
          return withRecomputedAutoLock(state, { presetConnections, presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, edgeEntityKey(descriptor.id)), presetsDirty: true });
        });
        break;
      case "split_node":
        get().removePresetSplitAll(descriptor.endpoint.point, descriptor.endpoint.level);
        break;
    }

    // A preset-list row can be deleted while its own hover is still active. Clear both hover
    // sources so the canvas cannot keep highlighting the removed entity (GitHub issue #691).
    set({ presetHoveredLink: null, presetHoveredEntity: null });

    const prompt = get().presetEntityDeletePrompt;
    if (!prompt) return;
    const stateAfter = get();
    const remaining = buildPresetPointEntities(prompt.point, prompt.level, activeFloorIndex(stateAfter), prompt.scope, {
      presetSplitPoints: stateAfter.presetSplitPoints,
      presetStart: stateAfter.presetStart,
      presetFinish: stateAfter.presetFinish,
      presetGenSource: stateAfter.presetGenSource,
      presetTeleports: stateAfter.presetTeleports,
      presetVerticalPassages: stateAfter.presetVerticalPassages,
      presetElevators: stateAfter.presetElevators,
      presetConnections: stateAfter.presetConnections,
      lockedNodes: stateAfter.lockedNodes,
      autoLockedNodes: stateAfter.autoLockedNodes,
    });
    if (remaining.length === 0) set({ presetEntityDeletePrompt: null });
  },

  removeAllPresetPointEntities: () => {
    const prompt = get().presetEntityDeletePrompt;
    if (!prompt) return;
    set({ presetEntityDeletePrompt: null });
    const state = get();
    const entities = buildPresetPointEntities(prompt.point, prompt.level, activeFloorIndex(state), prompt.scope, {
      presetSplitPoints: state.presetSplitPoints,
      presetStart: state.presetStart,
      presetFinish: state.presetFinish,
      presetGenSource: state.presetGenSource,
      presetTeleports: state.presetTeleports,
      presetVerticalPassages: state.presetVerticalPassages,
      presetElevators: state.presetElevators,
      presetConnections: state.presetConnections,
      lockedNodes: state.lockedNodes,
      autoLockedNodes: state.autoLockedNodes,
    });
    removeAllPresetPointEntitiesFor(get, prompt.point, prompt.scope, entities);
  },
});

/** Shared by "Delete all" in the open dialog and by the shift-held bulk-delete shortcut — both
 * resolve the same scope to the same final state, just via different entry points (GitHub issue
 * #540 follow-up). `point_all` reuses the pre-#540 one-shot reset/delete action directly, since it
 * already does the exact same full-point cleanup (including `presetActiveSplitNode`); a narrower
 * `vertex_markers` scope has no equivalent bulk action, so it removes each descriptor in turn. */
function removeAllPresetPointEntitiesFor(
  get: () => MazeStore,
  point: [number, number],
  scope: PresetPointEntityScope,
  entities: PresetPointEntityDescriptor[],
): void {
  if (scope.kind === "point_all") {
    get().resetPresetPoint(point);
    return;
  }
  const order: Record<string, number> = { edge: 0, start: 1, finish: 1, gen_source: 1, teleport: 1, vertical_passage: 1, elevator: 1, lock: 2, split_node: 3 };
  const sorted = [...entities].sort((a, b) => (order[a.kind] ?? 1) - (order[b.kind] ?? 1));
  for (const e of sorted) get().removePresetPointEntity(e);
}

function splitPointKeyOf(point: [number, number], level: number | undefined): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

/** Starts carrying `descriptor` (move) or opens its settings surface (settings) — GitHub issue #748. */
function actOnPresetEntity(
  get: () => MazeStore,
  set: (partial: Partial<MazeState>) => void,
  purpose: EntityToolPurpose,
  descriptor: PresetPointEntityDescriptor,
): void {
  if (purpose === "move") set({ presetMoveRequest: descriptor });
  else get().openPresetEntitySettings(descriptor);
}
