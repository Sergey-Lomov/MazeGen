import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import { applyTool, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys, computeInvalidSplitPoints, resolveCells, presetEdgeKey, canonicalizePresetPair, resolvePresetActiveEndpoint, resolvePresetPartnerAt, allNodesAt, resolvePresetSplitTargets, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint, rotatePresetSplitPoint, cycleVerticalPassageDirection, removeVerticalPassage, moveVerticalPassageEndpoint, moveElevatorEndpoint, removeElevator, cellExistsAt } from "../../pixi/fieldEditUtils";
import { presetEndpoint, presetEndpointKey, presetEndpointIsSplit, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { buildPresetPointEntities, type PresetPointEntityDescriptor, type PresetPointEntityScope } from "../../pixi/pointEntities";
import { presetPurposeEntitiesAt, type EntityToolPurpose } from "../../pixi/entityToolKinds";
import type { SplitRef } from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import { isPresetLockTool, type MazeState, type MazeStore, type PresetConnectionsState, type PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock, activeFloorField, activeFloorLevel, resolveFieldAtOf, levelFieldsOf } from "../storeHelpers";
import { registerNotificationCode } from "../../notifications/notificationRegistry";
import { notify } from "../../notifications/notificationStore";
import {
  notifyEditRefusal, notifyVerticalDragFailure, SPLIT_ROTATION_OUTSIDE_FIELD,
} from "../../notifications/editRefusalNotifications";
import * as m from "~/paraglide/messages";

const REMOVE_ENDPOINT_NODE_REJECTED = "preset_connections.remove_endpoint_node_rejected";
registerNotificationCode(REMOVE_ENDPOINT_NODE_REJECTED, { category: "notice", message: () => m[REMOVE_ENDPOINT_NODE_REJECTED]() });

/** Plain 0-based active floor index (0 = floor 0), unlike `activeFloorLevel` (`undefined` = floor
 * 0) — `buildPresetPointEntities`'s `activeFloorLevel` param needs this convention to match
 * `cellInspectionResolver.ts`'s `activeFloorIndex`, since it's compared directly against a
 * `PresetEndpoint.level` normalized the same way (`other.level ?? 0`). */
function activeFloorIndex(state: MazeState): number {
  return Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
}

/** Removes `presetConnections[key]`, but — unlike a plain `.delete` — leaves the pair reading as
 *  the maze's current `defaultEdgeState` (GitHub issue #540 follow-up bug report) rather than
 *  always falling back to `"undefined"`: when the default is `"wall"`/`"passage"`, every ordinary
 *  edge of the field already carries an explicit `source: "default"` entry (`applyDefaultEdgeState`)
 *  representing that state, so simply deleting the entry would silently regress it to undefined
 *  instead of the configured default. Mutates `presetConnections` in place — callers own cloning
 *  the map first. */
function resetEdgeToDefault(
  presetConnections: Map<string, PresetConnectionEntry>,
  defaultEdgeState: "undefined" | "wall" | "passage",
  key: string,
  from: PresetEndpoint,
  to: PresetEndpoint,
): void {
  if (defaultEdgeState === "undefined") presetConnections.delete(key);
  else presetConnections.set(key, { from, to, state: defaultEdgeState, source: "default" });
}

function appendPresetEntityOrder(order: string[], key: string): string[] {
  return order.includes(key) ? order : [...order, key];
}

function removePresetEntityOrder(order: string[], key: string): string[] {
  return order.filter((existing) => existing !== key);
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

function edgeEntityKey(key: string): string {
  return `edge:${key}`;
}

function splitEntityKey(key: string): string {
  return `split:${key}`;
}

function addNewUserEdgeOrder(
  previous: Map<string, PresetConnectionEntry>,
  next: Map<string, PresetConnectionEntry>,
  order: string[],
): string[] {
  let result = order;
  for (const [key, entry] of next) {
    if (entry.source === "user" && previous.get(key)?.source !== "user") result = appendPresetEntityOrder(result, edgeEntityKey(key));
  }
  return result;
}

function removeDeletedUserEdgeOrder(
  previous: Map<string, PresetConnectionEntry>,
  next: Map<string, PresetConnectionEntry>,
  order: string[],
): string[] {
  const removed = new Set<string>();
  for (const [key, entry] of previous) {
    if (entry.source === "user" && next.get(key)?.source !== "user") removed.add(edgeEntityKey(key));
  }
  return order.filter((key) => !removed.has(key));
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

  startPresetVerticalPassagePlacement: (origin, tool) => {
    const state = get();
    const resolveFieldAt = resolveFieldAtOf(state);
    const originLevel = origin.level ?? 0;
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, origin.point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, origin.point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) return;
    // Every click adds a new passage, even where one already exists (GitHub issue #748): a cell may
    // hold any number of elements. Editing an existing passage is the settings tool's job.
    if (availableDirections.length === 1) {
      tryCommitPresetVerticalPassage(get, set, origin, tool, availableDirections[0]);
      return;
    }
    set({ presetVerticalPassagePending: { origin, tool, availableDirections } });
  },

  choosePresetVerticalPassageDirection: (direction) => {
    const pending = get().presetVerticalPassagePending;
    if (!pending) return;
    tryCommitPresetVerticalPassage(get, set, pending.origin, pending.tool, direction);
  },

  cancelPresetVerticalPassagePlacement: () => set({ presetVerticalPassagePending: null }),

  cyclePresetVerticalPassageDirection: (id) => set((state) => ({
    presetVerticalPassages: cycleVerticalPassageDirection(state.presetVerticalPassages, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  removePresetVerticalPassage: (id) => set((state) => ({
    presetVerticalPassages: removeVerticalPassage(state.presetVerticalPassages, id),
    presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `vertical_passage:${id}`),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  movePresetVerticalPassageEndpoint: (id, end, point) => {
    const state = get();
    const entry = state.presetVerticalPassages.find((p) => p.id === id);
    if (!entry) return;
    const otherEnd = end === "from" ? entry.to : entry.from;
    const ownLevel = (end === "from" ? entry.from.level : entry.to.level) ?? 0;
    const otherLevel = otherEnd.level ?? 0;
    // Whether the OTHER floor even has a cell at the new point is checked here, before ANY
    // split-target dialog opens — `moveVerticalPassageEndpoint`'s own `cellExistsAt` failure path
    // only runs after the split-target queue (if any) has fully drained, which used to mean the
    // user could answer a "which node?" prompt only to be told afterwards that the drag failed
    // outright. A failure here is unaffected by which split node gets picked, so it's cheaper and
    // more honest to catch it up front.
    const resolveFieldAt = resolveFieldAtOf(state);
    if (!cellExistsAt(resolveFieldAt, point, otherLevel)) {
      notifyVerticalDragFailure("preset_connections", "vertical_passage", point, otherLevel);
      return;
    }
    // Both landing points (the dragged end's new point AND the other end's own point, same (x, y),
    // GitHub issue #566) can independently be declared split (GitHub issue #594) — checked BEFORE
    // `moveVerticalPassageEndpoint`'s own `cellExistsAt` failure path, since a split pick has
    // nothing to do with whether the other floor even has a cell there.
    const { picks, queue } = resolvePresetSplitTargets(
      [{ point, level: ownLevel === 0 ? undefined : ownLevel }, { point, level: otherLevel === 0 ? undefined : otherLevel }],
      state.presetSplitPoints,
    );
    if (queue.length === 0) {
      const result = moveVerticalPassageEndpoint(state.presetVerticalPassages, { id, end }, point, resolveFieldAt, picks[0], picks[1]);
      if (result.failure) notifyVerticalDragFailure("preset_connections", "vertical_passage", result.failure.point, result.failure.level);
      else set({ presetVerticalPassages: result.passages, presetsDirty: true, debugStale: debugStaleOf(state) });
      return;
    }
    const first = queue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "move_vertical_passage_endpoint", id, end },
        queue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  movePresetElevatorEndpoint: (id, level, point) => {
    const state = get();
    const entry = state.presetElevators.find((e) => e.id === id);
    if (!entry) return;
    const levels = entry.floors.map((f) => f.level ?? 0).sort((a, b) => a - b);
    // `levels` order mirrors `moveElevatorEndpoint`'s own — dragged floor first, then every OTHER
    // floor ascending — so `picks[i]` matches `levels[i]` the same way `place_elevator_target`'s
    // `picks` matches its own `levels` (GitHub issue #594, parity with post-edit's
    // `move_elevator_endpoint` from GitHub issue #567).
    const orderedLevels = [level, ...levels.filter((l) => l !== level)];
    // Every OTHER floor's cell existence at the new point is checked here, before ANY split-target
    // dialog opens — `moveElevatorEndpoint`'s own `cellExistsAt` failure path only runs after the
    // whole split-target queue has drained, which used to let the user answer several "which node?"
    // prompts only to be told afterwards the drag failed outright because some other floor simply
    // has no cell there. A failure here is unaffected by which split node gets picked on any floor.
    const resolveFieldAt = resolveFieldAtOf(state);
    for (const otherLevel of levels.filter((l) => l !== level)) {
      if (!cellExistsAt(resolveFieldAt, point, otherLevel)) {
        notifyVerticalDragFailure("preset_connections", "elevator", point, otherLevel);
        return;
      }
    }
    const { picks, queue } = resolvePresetSplitTargets(
      orderedLevels.map((l) => ({ point, level: l === 0 ? undefined : l })),
      state.presetSplitPoints,
    );
    if (queue.length === 0) {
      const overridesByLevel = new Map(orderedLevels.map((l, i) => [l, picks[i]!]));
      const result = moveElevatorEndpoint(state.presetElevators, { id, level }, point, resolveFieldAt, overridesByLevel);
      if (result.failure) notifyVerticalDragFailure("preset_connections", "elevator", result.failure.point, result.failure.level);
      else set({ presetElevators: result.elevators, presetsDirty: true, debugStale: debugStaleOf(state) });
      return;
    }
    const first = queue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "move_elevator_endpoint", id, levels: orderedLevels },
        queue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  setPresetDragOverride: (override) => set({ presetDragOverride: override }),
  // Always starts a new elevator, even on a point that already has one (GitHub issue #748).
  startPresetElevatorPlacement: (origin) => set({ presetElevatorPending: { origin, floors: new Set([origin.level ?? 0]) } }),

  // `floors` seeds from the entry's current floors so the dialog reflects real state, and confirming
  // updates the entry in place (GitHub issue #341 follow-up).
  editPresetElevator: (id, origin) => set((state) => {
    const existing = state.presetElevators.find((e) => e.id === id);
    if (!existing) return {};
    return { presetElevatorPending: { origin, floors: new Set(existing.floors.map((f) => f.level ?? 0)), editingId: existing.id } };
  }),

  togglePresetElevatorFloor: (floorIndex) => set((state) => {
    const pending = state.presetElevatorPending;
    if (!pending) return {};
    const originLevel = pending.origin.level ?? 0;
    if (floorIndex === originLevel) return {};
    const floors = new Set(pending.floors);
    if (floors.has(floorIndex)) floors.delete(floorIndex);
    else floors.add(floorIndex);
    return { presetElevatorPending: { ...pending, floors } };
  }),

  confirmPresetElevatorPlacement: () => {
    const state = get();
    const pending = state.presetElevatorPending;
    if (!pending || pending.floors.size < 2) return;
    const point = pending.origin.point;
    const originLevel = pending.origin.level ?? 0;
    const levels = Array.from(pending.floors).sort((a, b) => a - b);
    // The ORIGIN's own level (GitHub issue #594 follow-up bug report) must NOT be re-resolved here
    // even if it's declared split — `pending.origin` already carries the exact node the user picked
    // for it (either a plain click, or an earlier `PresetSplitTargetDialog` pick when the origin
    // point itself was split — see `applyPresetSplitTargetPick`'s `elevator` branch). Re-running
    // `resolvePresetSplitTargets` against every floor including the origin's own re-queued a pick
    // for a point the user had already resolved, and — because that extra queue entry's
    // `targetIndex` never got filled by anything downstream — the elevator never committed at all
    // (`dispatchPresetElevatorPlacement`'s `floors.length === action.levels.length` check kept
    // failing forever): the origin's own point was in BOTH `presetSplitTargetPrompt`'s queue and
    // already "resolved" in the user's mind, but nothing in this flow ever wrote `pending.origin`
    // into `picks` for it.
    const otherLevels = levels.filter((level) => level !== originLevel);
    const { picks: otherPicks, queue } = resolvePresetSplitTargets(
      otherLevels.map((level) => ({ point, level: level === 0 ? undefined : level })),
      state.presetSplitPoints,
    );
    const picks: (PresetEndpoint | undefined)[] = levels.map((level) =>
      level === originLevel ? pending.origin : otherPicks[otherLevels.indexOf(level)]);
    // `queue` entries carry `targetIndex` into `otherPicks`/`otherLevels` — remap onto `picks`' own
    // (full `levels`-based) indexing, since `levels` and `otherLevels` diverge by one skipped slot.
    const remappedQueue = queue.map((q) => ({ ...q, targetIndex: levels.indexOf(otherLevels[q.targetIndex]) }));
    if (remappedQueue.length === 0) {
      const floors = picks.filter((p): p is PresetEndpoint => p !== undefined);
      dispatchPresetElevatorPlacement(get, set, pending.editingId, floors);
      return;
    }
    const first = remappedQueue[0];
    set({
      presetSplitTargetPrompt: {
        point: first.point, level: first.level, slotIds: first.slotIds,
        action: { tool: "place_elevator_target", origin: pending.origin, levels, editingId: pending.editingId },
        queue: remappedQueue, picks,
      },
      presetEntityDeletePrompt: null,
    });
  },

  cancelPresetElevatorPlacement: () => set({ presetElevatorPending: null }),

  removePresetElevator: (id) => set((state) => ({
    presetElevators: removeElevator(state.presetElevators, id),
    presetEntityOrder: removePresetEntityOrder(state.presetEntityOrder, `elevator:${id}`),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  addPresetSplitNode: (point) => set((state) => {
    const level = activeFloorLevel(state);
    const { splitPoints, slotId } = addSlot(state.presetSplitPoints, point, level);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const isNewSplit = (state.presetSplitPoints[key] ?? []).length === 0;
    const splitPointIds = isNewSplit
      ? { ...state.presetSplitPointIds, [key]: `s${state._nextPresetSplitPointId}` }
      : state.presetSplitPointIds;
    return withRecomputedAutoLock(state, {
      presetConnections: state.presetConnections,
      presetSplitPoints: splitPoints,
      presetSplitPointIds: splitPointIds,
      _nextPresetSplitPointId: isNewSplit ? state._nextPresetSplitPointId + 1 : state._nextPresetSplitPointId,
      presetEntityOrder: isNewSplit ? appendPresetEntityOrder(state.presetEntityOrder, splitEntityKey(key)) : state.presetEntityOrder,
      presetActiveSplitNode: { ...state.presetActiveSplitNode, [key]: presetEndpoint(point, slotId, level) },
      presetsDirty: true,
    });
  }),

  removePresetSplitNode: (point, slotId) => {
    const state = get();
    const target: SplitRef = { point, slotId };

    const meta = { start: state.presetStart, finish: state.presetFinish, genSource: state.presetGenSource };
    if ((meta.start && presetEndpointIsSplit(meta.start, target))
      || (meta.finish && presetEndpointIsSplit(meta.finish, target))
      || (meta.genSource && presetEndpointIsSplit(meta.genSource, target))) {
      notify({ source: "preset_connections", code: REMOVE_ENDPOINT_NODE_REJECTED });
      return;
    }

    set((state) => {
      const level = activeFloorLevel(state);
      const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
      const refsTarget = (ep: PresetEndpoint) => presetEndpointIsSplit(ep, target) && (ep.level ?? 0) === (level ?? 0);
      const removedEntityKeys = new Set<string>();

      const presetConnections = new Map(state.presetConnections);
      for (const [key, entry] of presetConnections) {
        if (refsTarget(entry.from) || refsTarget(entry.to)) presetConnections.delete(key);
      }
      const presetTeleports = state.presetTeleports.filter((t) => {
        const removed = refsTarget(t.from) || refsTarget(t.to);
        if (removed) removedEntityKeys.add(`teleport:${t.id}`);
        return !removed;
      });
      const lockedNodes = new Map(state.lockedNodes);
      const removedLockKey = presetEndpointKey(presetEndpoint(point, slotId, level));
      lockedNodes.delete(removedLockKey);
      removedEntityKeys.add(`lock:${removedLockKey}`);
      const { splitPoints, activeMap } = removeSlot(
        state.presetSplitPoints, state.presetActiveSplitNode, point, slotId,
        (entry, point, slotId) => entry.slotId !== undefined && presetEndpointIsSplit(entry, { point, slotId }) && (entry.level ?? 0) === (level ?? 0),
        level,
      );
      const splitRemoved = splitPoints[key] === undefined;
      if (splitRemoved) removedEntityKeys.add(splitEntityKey(key));

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports, lockedNodes,
        presetSplitPoints: splitPoints, presetActiveSplitNode: activeMap,
        presetSplitPointIds: splitRemoved ? Object.fromEntries(Object.entries(state.presetSplitPointIds).filter(([candidate]) => candidate !== key)) : state.presetSplitPointIds,
        presetEntityOrder: removeDeletedUserEdgeOrder(
          state.presetConnections,
          presetConnections,
          state.presetEntityOrder,
        ).filter((entityKey) => !removedEntityKeys.has(entityKey)),
        presetsDirty: true,
      });
    });
  },

  /** Removes an entire preset split point (every declared slot at once) and migrates every
   *  entity anchored on a removed slot node onto the point's original node (GitHub issue #540) —
   *  unlike `removePresetSplitNode`, nothing is deleted except the connections/edges of the split
   *  shape itself: those simply drop (reverting to the default/undefined state, since an absent
   *  `presetConnections` entry already reads as `"undefined"`) — this includes the original node's
   *  own edges too, not just the removed slot nodes', because a recognized special shape (bridge,
   *  diagonal, ...) draws across faces of *both* the original and its slot node together, so once
   *  the split is gone there's no single "this edge belongs to the shape" vs "this edge doesn't"
   *  distinction left to preserve. Meanwhile teleports/vertical passages/elevators/start/finish/
   *  gen-source are retargeted in place so they keep working, now anchored on the original node.
   *  Never refuses — the previous "reassign start/finish/gen-source first" restriction doesn't
   *  apply once those markers migrate instead of being destroyed. */
  removePresetSplitAll: (point, level) => set((state) => {
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotIds = state.presetSplitPoints[key] ?? [];
    if (slotIds.length === 0) return state;

    const original = presetEndpoint(point, undefined, level);
    const isRemovedNode = (ep: PresetEndpoint) =>
      ep.slotId !== undefined && ep.point[0] === point[0] && ep.point[1] === point[1] && (ep.level ?? 0) === (level ?? 0);
    const isPointNode = (ep: PresetEndpoint) => isRemovedNode(ep) || presetEndpointsEqual(ep, original);
    const retarget = (ep: PresetEndpoint) => (isRemovedNode(ep) ? original : ep);

    const presetConnections = new Map<string, PresetConnectionEntry>();
    for (const entry of state.presetConnections.values()) {
      const fromIsPoint = isPointNode(entry.from);
      const toIsPoint = isPointNode(entry.to);
      if (!fromIsPoint && !toIsPoint) {
        presetConnections.set(presetEdgeKey(entry.from, entry.to), entry);
        continue;
      }
      if (fromIsPoint && toIsPoint) continue; // internal to the split shape — just gone, no edge left to default
      // One side leaves the field (the split), the other is a real external neighbor — that
      // neighbor-facing edge still exists once the split is gone, so it reverts to the current
      // default state rather than vanishing outright (GitHub issue #540 follow-up bug report).
      const from = fromIsPoint ? original : entry.from;
      const to = toIsPoint ? original : entry.to;
      resetEdgeToDefault(presetConnections, state.defaultEdgeState, presetEdgeKey(from, to), from, to);
    }
    const presetTeleports = state.presetTeleports.map((t) => (
      isRemovedNode(t.from) || isRemovedNode(t.to) ? { ...t, from: retarget(t.from), to: retarget(t.to) } : t
    ));
    const presetVerticalPassages = state.presetVerticalPassages.map((v) => (
      isRemovedNode(v.from) || isRemovedNode(v.to) ? { ...v, from: retarget(v.from), to: retarget(v.to) } : v
    ));
    const presetElevators = state.presetElevators.map((e) => (
      e.floors.some(isRemovedNode) ? { ...e, floors: e.floors.map(retarget) } : e
    ));
    const lockedNodes = new Map(state.lockedNodes);
    const originalKey = presetEndpointKey(original);
    const mergeLock = (a: NodeLockKind | undefined, b: NodeLockKind): NodeLockKind =>
      a === undefined || a === b ? (a ?? b) : "both";
    for (const slotId of slotIds) {
      const removedKey = presetEndpointKey(presetEndpoint(point, slotId, level));
      const removedKind = lockedNodes.get(removedKey);
      if (removedKind !== undefined) {
        lockedNodes.delete(removedKey);
        lockedNodes.set(originalKey, mergeLock(lockedNodes.get(originalKey), removedKind));
      }
    }

    const presetSplitPoints = { ...state.presetSplitPoints };
    delete presetSplitPoints[key];
    const presetSplitPointIds = { ...state.presetSplitPointIds };
    delete presetSplitPointIds[key];
    const presetActiveSplitNode = { ...state.presetActiveSplitNode };
    delete presetActiveSplitNode[key];
    const removedLockOrderKeys = new Set(slotIds.map((slotId) => `lock:${presetEndpointKey(presetEndpoint(point, slotId, level))}`));

    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators, lockedNodes,
      presetSplitPoints, presetActiveSplitNode,
      presetSplitPointIds,
      presetEntityOrder: removeDeletedUserEdgeOrder(
        state.presetConnections,
        presetConnections,
        state.presetEntityOrder,
      ).filter((entityKey) => entityKey !== splitEntityKey(key) && !removedLockOrderKeys.has(entityKey)),
      presetStart: state.presetStart && isRemovedNode(state.presetStart) ? retarget(state.presetStart) : state.presetStart,
      presetFinish: state.presetFinish && isRemovedNode(state.presetFinish) ? retarget(state.presetFinish) : state.presetFinish,
      presetGenSource: state.presetGenSource && isRemovedNode(state.presetGenSource) ? retarget(state.presetGenSource) : state.presetGenSource,
      presetsDirty: true,
    });
  }),

  cyclePresetActiveSplitNode: (point) => set((state) => {
    const level = activeFloorLevel(state);
    return {
      presetActiveSplitNode: cycleActive(
        state.presetSplitPoints, state.presetActiveSplitNode, point,
        (point, slotId) => presetEndpoint(point, slotId, level), (entry) => entry?.slotId,
        level,
      ),
    };
  }),

  setPresetActiveSplitNode: (point, endpoint) => set((state) => ({
    presetActiveSplitNode: setActive(state.presetActiveSplitNode, point, endpoint, (e) => e.slotId === undefined, activeFloorLevel(state)),
  })),

  setPresetFocusedPoint: (point) => set({ presetFocusedPoint: point }),
  setPresetHoveredLink: (link) => set({ presetHoveredLink: link }),
  setPresetHoveredEntity: (endpoints, mode = "inset") => set({ presetHoveredEntity: endpoints, presetHoveredEntityMode: mode }),

  rotatePresetSplitPoint: (point, direction) => set((state) => {
    const field = activeFloorField(state);
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotIds = state.presetSplitPoints[key] ?? [];
    const customPts = field.fieldEditMode === "custom" && field.fieldPoints.size > 0 ? field.fieldPoints : undefined;
    const cells = resolveCells(field.fieldConfig, customPts);
    const cellSet = buildCellSet(cells);
    const presetConnections = rotatePresetSplitPoint(
      state.presetConnections, point, slotIds, direction, field.fieldConfig, cellSet,
      state.presetSplitPoints, state.presetActiveSplitNode, level,
    );
    if (presetConnections.refusalReason) {
      notifyEditRefusal("preset_connections", SPLIT_ROTATION_OUTSIDE_FIELD);
      return {};
    }
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  applyPresetSplitBlueprint: (point, blueprint) => {
    const state = get();
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const existingSlots = state.presetSplitPoints[key] ?? [];
    // Every node currently at this point — original plus every declared slot — is about to have
    // its faces fully rebuilt by the blueprint.
    const existingNodeEndpoints: PresetEndpoint[] = [presetEndpoint(point, undefined, level), ...existingSlots.map((slotId) => presetEndpoint(point, slotId, level))];
    const refsExistingNode = (ep: PresetEndpoint) => existingNodeEndpoints.some((t) => presetEndpointsEqual(ep, t));

    set((state) => {
      const presetConnections = new Map(state.presetConnections);
      const removedEntityKeys = new Set<string>();
      for (const [k, entry] of presetConnections) {
        if (refsExistingNode(entry.from) || refsExistingNode(entry.to)) {
          presetConnections.delete(k);
          if (entry.source === "user") removedEntityKeys.add(edgeEntityKey(k));
        }
      }
      const nodeEndpoints: PresetEndpoint[] = blueprint.nodeFaces.map((_, i) => (i === 0 ? presetEndpoint(point, undefined, level) : presetEndpoint(point, i - 1, level)));
      const originalEndpoint = nodeEndpoints[0] ?? presetEndpoint(point, undefined, level);
      const targetForExistingEndpoint = (endpoint: PresetEndpoint): PresetEndpoint => {
        if (endpoint.point[0] !== point[0] || endpoint.point[1] !== point[1] || (endpoint.level ?? 0) !== (level ?? 0)) return endpoint;
        if (endpoint.slotId === undefined) return originalEndpoint;
        const oldIndex = existingSlots.indexOf(endpoint.slotId);
        return oldIndex >= 0 ? (nodeEndpoints[oldIndex + 1] ?? originalEndpoint) : originalEndpoint;
      };
      const presetTeleports = state.presetTeleports.map((t) => ({
        ...t, from: targetForExistingEndpoint(t.from), to: targetForExistingEndpoint(t.to),
      }));
      const presetVerticalPassages = state.presetVerticalPassages.map((p) => ({
        ...p, from: targetForExistingEndpoint(p.from), to: targetForExistingEndpoint(p.to),
      }));
      const presetElevators = state.presetElevators.map((e) => ({
        ...e, floors: e.floors.map(targetForExistingEndpoint),
      }));
      const presetStart = state.presetStart ? targetForExistingEndpoint(state.presetStart) : null;
      const presetFinish = state.presetFinish ? targetForExistingEndpoint(state.presetFinish) : null;
      const presetGenSource = state.presetGenSource ? targetForExistingEndpoint(state.presetGenSource) : null;

      const lockedNodes = new Map(state.lockedNodes);
      const lockKeyRemap = new Map<string, string>();
      const mergeLock = (a: NodeLockKind | undefined, b: NodeLockKind): NodeLockKind =>
        a === undefined || a === b ? (a ?? b) : "both";
      for (const oldEndpoint of existingNodeEndpoints) {
        const oldKey = presetEndpointKey(oldEndpoint);
        const oldKind = lockedNodes.get(oldKey);
        if (oldKind === undefined) continue;
        const targetKey = presetEndpointKey(targetForExistingEndpoint(oldEndpoint));
        lockKeyRemap.set(oldKey, targetKey);
        if (targetKey !== oldKey) {
          lockedNodes.delete(oldKey);
          lockedNodes.set(targetKey, mergeLock(lockedNodes.get(targetKey), oldKind));
        }
      }
      const presetActiveSplitNode = { ...state.presetActiveSplitNode };
      const active = presetActiveSplitNode[key];
      if (active) {
        const target = targetForExistingEndpoint(active);
        if (target.slotId === undefined) delete presetActiveSplitNode[key];
        else presetActiveSplitNode[key] = target;
      }
      const presetEntityOrder = state.presetEntityOrder.reduce<string[]>((order, entityKey) => {
        const remapped = entityKey.startsWith("lock:")
          ? `lock:${lockKeyRemap.get(entityKey.slice("lock:".length)) ?? entityKey.slice("lock:".length)}`
          : entityKey;
        return order.includes(remapped) ? order : [...order, remapped];
      }, []);

      const field = activeFloorField(state);
      const { offsets } = getNeighborData(field.fieldConfig, point[0], point[1]);
      const customPts = field.fieldEditMode === "custom" && field.fieldPoints.size > 0 ? field.fieldPoints : undefined;
      const cells = resolveCells(field.fieldConfig, customPts);
      const inFieldCells = buildCellSet(cells);
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
          // The neighbor's real connecting node — not just its active UI slot (GitHub issue #243).
          // Resolved against the pre-cleanup snapshot (`state.presetConnections`) and `point`'s
          // *old* (pre-blueprint) endpoints: any pre-existing neighbor entry was recorded against
          // one of those, never against `endpoint` (a fresh node this call is about to mint).
          const neighborPartner = resolvePresetPartnerAt(existingNodeEndpoints, neighbor, state.presetConnections, state.presetSplitPoints, presetActiveSplitNode, level);
          const edgeK = presetEdgeKey(endpoint, neighborPartner);
          const [from, to] = canonicalizePresetPair(endpoint, neighborPartner);
          presetConnections.set(edgeK, { from, to, state: requiredFaces.has(faceIndex) ? "passage" : "wall", source: "user" });

          // If the neighbor point is itself split, every one of its *other* nodes (not the resolved
          // partner) must end up with an explicit `wall` on this face too, unless one of them
          // already has its own decided (non-`undefined`) entry here — otherwise that other node's
          // side of this face silently stays `undefined` instead of reading as forbidden (GitHub
          // issue #243 follow-up).
          for (const other of allNodesAt(neighbor, state.presetSplitPoints, level)) {
            if (presetEndpointsEqual(other, neighborPartner)) continue;
            const otherKey = presetEdgeKey(endpoint, other);
            const otherState = presetConnections.get(otherKey)?.state;
            if (otherState !== undefined && otherState !== "undefined") continue;
            const [oFrom, oTo] = canonicalizePresetPair(endpoint, other);
            presetConnections.set(otherKey, { from: oFrom, to: oTo, state: "wall", source: "user" });
          }
        }
      }

      const nextSplitPoints = { ...state.presetSplitPoints };
      const slotCount = blueprint.nodeFaces.length - 1;
      if (slotCount <= 0) delete nextSplitPoints[key];
      else nextSplitPoints[key] = Array.from({ length: slotCount }, (_, i) => i);

      const createsSplit = slotCount > 0 && existingSlots.length === 0;
      const presetSplitPointIds = { ...state.presetSplitPointIds };
      if (slotCount > 0) {
        if (createsSplit) presetSplitPointIds[key] = `s${state._nextPresetSplitPointId}`;
      } else {
        delete presetSplitPointIds[key];
        removedEntityKeys.add(splitEntityKey(key));
      }

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports, presetVerticalPassages, presetElevators,
        presetStart, presetFinish, presetGenSource, lockedNodes,
        presetSplitPoints: nextSplitPoints, presetActiveSplitNode,
        presetSplitPointIds,
        _nextPresetSplitPointId: createsSplit ? state._nextPresetSplitPointId + 1 : state._nextPresetSplitPointId,
        presetEntityOrder: (createsSplit ? appendPresetEntityOrder(presetEntityOrder, splitEntityKey(key)) : presetEntityOrder)
          .filter((entityKey) => !removedEntityKeys.has(entityKey)),
        presetsDirty: true,
      });
    });
  },

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

/** Builds the new `PresetVerticalPassageEntry` for a single-click placement (GitHub issue #357
 * follow-up) — `origin` is always `from`; `direction` ("up"/"down", already resolved as available
 * by `startPresetVerticalPassagePlacement`/the dialog) picks `to`'s floor. `vertical_passage_two_way`
 * always creates `direction: "two_way"`; `vertical_passage_one_way` always creates `"forward"` (`from`
 * is the departure end) — mirrors the old two-click tool's own click-order convention, just without
 * a second click.
 *
 * `toOverride` (GitHub issue #594) is the user's own pick from `PresetSplitTargetDialog`, already
 * resolved by `applyPresetSplitTargetPick` — when present it short-circuits the plain
 * `presetEndpoint(origin.point, undefined, toLevel)` default below, which otherwise always attached
 * `to` to the target floor's ORIGINAL node even when that point is declared split. Callers only ever
 * pass it once `tryCommitPresetVerticalPassage` has already confirmed `to`'s point isn't split (or
 * the dialog resolved it) — this function itself never re-checks split-ness. */
function commitPresetVerticalPassage(
  state: MazeState,
  origin: PresetEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
  toOverride?: PresetEndpoint,
): Partial<MazeState> {
  const originLevel = origin.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const to = toOverride ?? presetEndpoint(origin.point, undefined, toLevel === 0 ? undefined : toLevel);
  const entry: PresetVerticalPassageEntry = {
    id: state._nextPresetVerticalPassageId,
    from: origin,
    to,
    direction: tool === "vertical_passage_two_way" ? "two_way" : "forward",
  };
  return {
    presetVerticalPassages: [...state.presetVerticalPassages, entry],
    _nextPresetVerticalPassageId: state._nextPresetVerticalPassageId + 1,
    presetEntityOrder: appendPresetEntityOrder(state.presetEntityOrder, `vertical_passage:${entry.id}`),
    presetVerticalPassagePending: null,
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  };
}

/** Entry point for a FRESH vertical-passage placement (GitHub issue #594, parity with post-edit's
 * `tryCommitPostEditVerticalPassage` from GitHub issue #567) — wraps `commitPresetVerticalPassage`
 * with a split-tile check on the TARGET floor: `to`'s own point is looked up in `presetSplitPoints`
 * and, if declared split, the commit is deferred through `presetSplitTargetPrompt`
 * (`action.tool: "place_vertical_passage_target"`) instead of silently taking
 * `commitPresetVerticalPassage`'s previous `slotId: undefined` default. An unsplit `to` point
 * commits exactly as before. */
function tryCommitPresetVerticalPassage(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  origin: PresetEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
): void {
  const state = get();
  const originLevel = origin.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const { picks, queue } = resolvePresetSplitTargets([{ point: origin.point, level: toLevel === 0 ? undefined : toLevel }], state.presetSplitPoints);
  if (queue.length === 0) {
    set(commitPresetVerticalPassage(state, origin, tool, direction, picks[0]));
    return;
  }
  const first = queue[0];
  set({
    presetSplitTargetPrompt: {
      point: first.point, level: first.level, slotIds: first.slotIds,
      action: { tool: "place_vertical_passage_target", origin, passageTool: tool, direction },
      queue, picks,
    },
    presetEntityDeletePrompt: null,
  });
}

/** Appends/updates the `PresetElevatorEntry` for a resolved `floors` list (GitHub issue #594,
 * parity with post-edit's `dispatchPostEditElevatorPlacement` from GitHub issue #567) — the tail end
 * of `confirmPresetElevatorPlacement`, factored out so `applyPresetSplitTargetPick`'s
 * `place_elevator_target` branch can call it too once every queued split floor has been resolved
 * through the dialog. `editingId` set → updates that existing entry in place; unset → mints a fresh
 * one with the next elevator id. */
function dispatchPresetElevatorPlacement(
  get: () => MazeStore,
  set: (partial: Partial<MazeStore> | ((state: MazeStore) => Partial<MazeStore>)) => void,
  editingId: number | undefined,
  floors: PresetEndpoint[],
): void {
  const state = get();
  const presetElevators = editingId !== undefined
    ? state.presetElevators.map((e) => e.id === editingId ? { ...e, floors } : e)
    : [...state.presetElevators, { id: state._nextPresetElevatorId, floors }];
  const entityKey = `elevator:${editingId !== undefined ? editingId : state._nextPresetElevatorId}`;
  set({
    presetElevators,
    _nextPresetElevatorId: editingId !== undefined ? state._nextPresetElevatorId : state._nextPresetElevatorId + 1,
    presetEntityOrder: editingId !== undefined
      ? state.presetEntityOrder
      : appendPresetEntityOrder(state.presetEntityOrder, entityKey),
    presetElevatorPending: null,
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  });
}

export function applyDefaultEdgeState(
  state: MazeState,
  newDefault: "undefined" | "wall" | "passage",
): Map<string, PresetConnectionEntry> {
  // Remove every existing default entry across all floors — `defaultEdgeState` is one maze-wide
  // toggle (GitHub issue #434), not per-floor, so a change must repopulate every floor's default
  // entries, not just the active floor's.
  const presetConnections = new Map(state.presetConnections);
  for (const [key, entry] of presetConnections) {
    if (entry.source === "default") presetConnections.delete(key);
  }

  if (newDefault === "undefined") return presetConnections;

  for (const levelField of levelFieldsOf(state)) {
    const { cfg, customPoints } = levelField;
    const cells = resolveCells(cfg, customPoints);
    const cellSet = buildCellSet(cells);

    for (const [x, y] of cells) {
      const { offsets } = getNeighborData(cfg, x, y);
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (!cellSet.has(`${nx},${ny}`)) continue;
        const less = x < nx || (x === nx && y < ny);
        if (!less) continue; // only process edge once (owner = canonical-lesser cell)
        const from = presetEndpoint([x, y], undefined, levelField.level);
        const to = presetEndpoint([nx, ny], undefined, levelField.level);
        const key = presetEdgeKey(from, to);
        if (!presetConnections.has(key)) {
          presetConnections.set(key, { from, to, state: newDefault, source: "default" });
        }
      }
    }
  }
  return presetConnections;
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
