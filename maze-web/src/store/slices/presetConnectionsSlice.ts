import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import { applyTool, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidEndpoint, computeInvalidLockedNodeKeys, computeInvalidSplitPoints, resolveCells, presetEdgeKey, canonicalizePresetPair, resolvePresetActiveEndpoint, resolvePresetPartnerAt, allNodesAt, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint, rotatePresetSplitPoint, cycleVerticalPassageDirection, removeVerticalPassage, moveVerticalPassageEndpoint, removeElevator, cellExistsAt } from "../../pixi/fieldEditUtils";
import { presetEndpoint, presetEndpointKey, presetEndpointIsSplit, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import { buildPresetPointEntities, type PresetPointEntityDescriptor, type PresetPointEntityScope } from "../../pixi/pointEntities";
import type { SplitRef } from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeState, MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock, activeFloorField, activeFloorLevel, resolveFieldAtOf, levelFieldsOf } from "../storeHelpers";

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

export const createPresetConnectionsSlice: StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions> = (set, get) => ({
  presetConnections: new Map<string, PresetConnectionEntry>(),
  presetConnectionsTool: "wall" as PresetConnectionTool,
  defaultEdgeState: "undefined" as const,
  presetStart: null,
  presetFinish: null,
  presetGenSource: null,
  highlightInvalidPresets: false,
  highlightIsolatedNodes: false,
  highlightOrphanSplitNodes: false,
  showPresetOrigin: false,
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
  presetActiveSplitNode: {},
  presetFocusedPoint: null,
  presetHoveredLink: null,
  presetSectionsExpanded: { problems: false },
  presetSplitTargetPrompt: null,
  presetEntityDeletePrompt: null,

  setPresetConnectionsTool: (tool) => set({
    presetConnectionsTool: tool,
    presetTeleportPendingFrom: null,
    presetVerticalPassagePending: null,
    presetElevatorPending: null,
    presetSplitTargetPrompt: null,
    presetEntityDeletePrompt: null,
  }),

  setPresetSectionExpanded: (id, expanded) =>
    set((s) => ({ presetSectionsExpanded: { ...s.presetSectionsExpanded, [id]: expanded } })),

  applyPresetConnectionsTool: (key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, state.presetConnectionsTool, state.defaultEdgeState, state.presetActiveSplitNode, activeFloorLevel(state));
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  applyPresetConnectionsToolAt: (tool, key, from, to) => set((state) => {
    const presetConnections = applyTool(state.presetConnections, { key, from, to }, tool, state.defaultEdgeState, state.presetActiveSplitNode, activeFloorLevel(state));
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  setPresetConnectionUndefined: (key, from, to) => set((state) => {
    const presetConnections = new Map(state.presetConnections);
    presetConnections.set(key, { from, to, state: "undefined", source: "user" });
    return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
  }),

  clearInvalidPresetConnections: () => set((state) => {
    const resolveFieldAt = resolveFieldAtOf(state);
    const invalidKeys = computeInvalidKeys(state.presetConnections, resolveFieldAt);
    const presetConnections = new Map(state.presetConnections);
    for (const key of invalidKeys) presetConnections.delete(key);
    const invalidTeleportIds = computeInvalidTeleportIds(state.presetTeleports, resolveFieldAt);
    const presetTeleports = state.presetTeleports.filter(t => !invalidTeleportIds.has(t.id));
    const invalidVerticalPassageIds = computeInvalidVerticalPassageIds(state.presetVerticalPassages, resolveFieldAt);
    const presetVerticalPassages = state.presetVerticalPassages.filter(p => !invalidVerticalPassageIds.has(p.id));
    const invalidElevatorIds = computeInvalidElevatorIds(state.presetElevators, resolveFieldAt);
    const presetElevators = state.presetElevators.filter(e => !invalidElevatorIds.has(e.id));
    const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, resolveFieldAt);
    const presetStart = invalidMarkers.start ? null : state.presetStart;
    const presetFinish = invalidMarkers.finish ? null : state.presetFinish;
    const presetGenSource = computeInvalidEndpoint(state.presetGenSource, resolveFieldAt) ? null : state.presetGenSource;
    const invalidLockedKeys = computeInvalidLockedNodeKeys(state.lockedNodes, resolveFieldAt);
    const lockedNodes = new Map(state.lockedNodes);
    for (const key of invalidLockedKeys) lockedNodes.delete(key);
    const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, resolveFieldAt);
    const presetSplitPoints = { ...state.presetSplitPoints };
    for (const key of invalidSplitKeys) delete presetSplitPoints[key];
    return withRecomputedAutoLock(state, { presetConnections, presetTeleports, presetVerticalPassages, presetElevators, presetStart, presetFinish, presetGenSource, lockedNodes, presetSplitPoints });
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
    presetActiveSplitNode: {},
    presetFocusedPoint: null,
    presetHoveredLink: null,
    presetSplitTargetPrompt: null,
    presetEntityDeletePrompt: null,
    debugStale: debugStaleOf(state),
  })),

  setAutoLock: (v) => set((state) => ({
    autoLock: v,
    autoLockedNodes: v ? recomputeAutoLock({ ...state, autoLock: v }) : new Set<string>(),
    debugStale: debugStaleOf(state),
  })),

  setPresetStart: (cell) => set((state) => ({
    presetStart: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    debugStale: debugStaleOf(state),
  })),
  setPresetFinish: (cell) => set((state) => ({
    presetFinish: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    debugStale: debugStaleOf(state),
  })),
  setPresetStartEndpoint: (endpoint) => set((state) => ({ presetStart: endpoint, debugStale: debugStaleOf(state) })),
  setPresetFinishEndpoint: (endpoint) => set((state) => ({ presetFinish: endpoint, debugStale: debugStaleOf(state) })),
  setPresetGenSource: (cell) => set((state) => ({
    presetGenSource: cell === null ? null : resolvePresetActiveEndpoint(cell, state.presetActiveSplitNode, activeFloorLevel(state)),
    debugStale: debugStaleOf(state),
  })),
  setPresetGenSourceEndpoint: (endpoint) => set((state) => ({ presetGenSource: endpoint, debugStale: debugStaleOf(state) })),

  setDefaultEdgeState: (s) => set((state) => {
    const presetConnections = applyDefaultEdgeState(state, s);
    return withRecomputedAutoLock(state, { defaultEdgeState: s, presetConnections });
  }),
  setHighlightInvalidPresets: (highlight) => set({ highlightInvalidPresets: highlight }),
  setHighlightIsolatedNodes: (highlight) => set({ highlightIsolatedNodes: highlight }),
  setHighlightOrphanSplitNodes: (highlight) => set({ highlightOrphanSplitNodes: highlight }),
  setShowPresetOrigin: (show) => set({ showPresetOrigin: show }),

  setLockedNode: (x, y, kind, slotId) => set((state) => {
    const next = new Map(state.lockedNodes);
    const level = activeFloorLevel(state);
    const point = presetEndpoint([x, y], slotId, level);
    next.set(presetEndpointKey(point), kind);
    return { lockedNodes: next, debugStale: debugStaleOf(state) };
  }),

  removeLockedNode: (x, y, slotId) => set((state) => {
    const level = activeFloorLevel(state);
    const key = presetEndpointKey(presetEndpoint([x, y], slotId, level));
    if (!state.lockedNodes.has(key)) return {};
    const next = new Map(state.lockedNodes);
    next.delete(key);
    return { lockedNodes: next, debugStale: debugStaleOf(state) };
  }),

  clearLockedNodes: () => set((state) => ({ lockedNodes: new Map<string, NodeLockKind>(), autoLockedNodes: new Set<string>(), debugStale: debugStaleOf(state) })),

  setPresetTeleportPendingFrom: (endpoint) => set({ presetTeleportPendingFrom: endpoint }),

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

  startPresetVerticalPassagePlacement: (origin, tool) => set((state) => {
    const resolveFieldAt = resolveFieldAtOf(state);
    const originLevel = origin.level ?? 0;
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, origin.point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, origin.point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) return {};

    // A click anywhere in a cell must edit an existing vertical passage for that adjacent floor,
    // not mint a second entry for the same pair. Two such entries are resolved as a bidirectional
    // graph connection on generation, regardless of their individual directions (GitHub issues
    // #385/#491). Keep the up/down pairs independent: a cell can have one passage to each floor.
    const entryFor = (direction: "up" | "down") => {
      const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
      const to = presetEndpoint(origin.point, undefined, toLevel === 0 ? undefined : toLevel);
      const pairKey = presetEdgeKey(origin, to);
      return state.presetVerticalPassages.find((p) => presetEdgeKey(p.from, p.to) === pairKey);
    };
    const directionEntries = availableDirections.map((direction) => [direction, entryFor(direction)] as const);
    const freeDirections = directionEntries.filter(([, entry]) => entry === undefined).map(([direction]) => direction);
    if (freeDirections.length === 0) {
      // If the cell identifies exactly one existing pair, mirror marker-click behavior. When both
      // adjacent floors already have passages, a cell click cannot tell which one was intended.
      if (directionEntries.length === 1 && directionEntries[0][1]) {
        return {
          presetVerticalPassages: cycleVerticalPassageDirection(state.presetVerticalPassages, directionEntries[0][1].id),
          presetsDirty: true,
          debugStale: debugStaleOf(state),
        };
      }
      return {};
    }
    if (freeDirections.length === 1) {
      return commitPresetVerticalPassage(state, origin, tool, freeDirections[0]);
    }
    return { presetVerticalPassagePending: { origin, tool, availableDirections: freeDirections } };
  }),

  choosePresetVerticalPassageDirection: (direction) => set((state) => {
    const pending = state.presetVerticalPassagePending;
    if (!pending) return {};
    return commitPresetVerticalPassage(state, pending.origin, pending.tool, direction);
  }),

  cancelPresetVerticalPassagePlacement: () => set({ presetVerticalPassagePending: null }),

  cyclePresetVerticalPassageDirection: (id) => set((state) => ({
    presetVerticalPassages: cycleVerticalPassageDirection(state.presetVerticalPassages, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  removePresetVerticalPassage: (id) => set((state) => ({
    presetVerticalPassages: removeVerticalPassage(state.presetVerticalPassages, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  movePresetVerticalPassageEndpoint: (id, end, endpoint) => set((state) => ({
    presetVerticalPassages: moveVerticalPassageEndpoint(state.presetVerticalPassages, { id, end }, endpoint),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  startPresetElevatorPlacement: (origin) => set((state) => {
    const originLevel = origin.level ?? 0;
    // Clicking an existing elevator's own marker (its point already has an entry reaching this
    // floor) edits that entry instead of creating a second one — `floors` seeds from its actual
    // current floors so the dialog reflects real state, not just the clicked floor (GitHub issue
    // #341 follow-up).
    const existing = state.presetElevators.find((e) =>
      e.floors.some((f) => (f.level ?? 0) === originLevel && f.point[0] === origin.point[0] && f.point[1] === origin.point[1]));
    if (existing) {
      return { presetElevatorPending: { origin, floors: new Set(existing.floors.map((f) => f.level ?? 0)), editingId: existing.id } };
    }
    return { presetElevatorPending: { origin, floors: new Set([originLevel]) } };
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

  confirmPresetElevatorPlacement: () => set((state) => {
    const pending = state.presetElevatorPending;
    if (!pending || pending.floors.size < 2) return {};
    const point = pending.origin.point;
    const floors = Array.from(pending.floors).sort((a, b) => a - b)
      .map((level) => presetEndpoint(point, undefined, level === 0 ? undefined : level));
    const presetElevators = pending.editingId !== undefined
      ? state.presetElevators.map((e) => e.id === pending.editingId ? { ...e, floors } : e)
      : [...state.presetElevators, { id: state._nextPresetElevatorId, floors }];
    return {
      presetElevators,
      _nextPresetElevatorId: pending.editingId !== undefined ? state._nextPresetElevatorId : state._nextPresetElevatorId + 1,
      presetElevatorPending: null,
      presetsDirty: true,
      debugStale: debugStaleOf(state),
    };
  }),

  cancelPresetElevatorPlacement: () => set({ presetElevatorPending: null }),

  removePresetElevator: (id) => set((state) => ({
    presetElevators: removeElevator(state.presetElevators, id),
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  })),

  addPresetSplitNode: (point) => set((state) => {
    const level = activeFloorLevel(state);
    const { splitPoints, slotId } = addSlot(state.presetSplitPoints, point, level);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    return withRecomputedAutoLock(state, {
      presetConnections: state.presetConnections,
      presetSplitPoints: splitPoints,
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
      set({ error: "Cannot remove a node assigned as start/finish/gen-source — reassign it first." });
      return;
    }

    set((state) => {
      const level = activeFloorLevel(state);
      const refsTarget = (ep: PresetEndpoint) => presetEndpointIsSplit(ep, target) && (ep.level ?? 0) === (level ?? 0);

      const presetConnections = new Map(state.presetConnections);
      for (const [key, entry] of presetConnections) {
        if (refsTarget(entry.from) || refsTarget(entry.to)) presetConnections.delete(key);
      }
      const presetTeleports = state.presetTeleports.filter(t => !refsTarget(t.from) && !refsTarget(t.to));
      const lockedNodes = new Map(state.lockedNodes);
      lockedNodes.delete(presetEndpointKey(presetEndpoint(point, slotId, level)));
      const { splitPoints, activeMap } = removeSlot(
        state.presetSplitPoints, state.presetActiveSplitNode, point, slotId,
        (entry, point, slotId) => entry.slotId !== undefined && presetEndpointIsSplit(entry, { point, slotId }) && (entry.level ?? 0) === (level ?? 0),
        level,
      );

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports, lockedNodes,
        presetSplitPoints: splitPoints, presetActiveSplitNode: activeMap,
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
    const presetActiveSplitNode = { ...state.presetActiveSplitNode };
    delete presetActiveSplitNode[key];

    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators, lockedNodes,
      presetSplitPoints, presetActiveSplitNode,
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

  rotatePresetSplitPoint: (point, direction) => set((state) => {
    const field = activeFloorField(state);
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
    const slotIds = state.presetSplitPoints[key] ?? [];
    const customPts = field.fieldEditMode === "custom" && field.fieldPoints.size > 0 ? field.fieldPoints : undefined;
    const cells = resolveCells(field.tessellationConfig, customPts);
    const cellSet = buildCellSet(cells);
    const presetConnections = rotatePresetSplitPoint(
      state.presetConnections, point, slotIds, direction, field.tessellationConfig, cellSet, level,
    );
    if (presetConnections === state.presetConnections) return {};
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

      const nodeEndpoints: PresetEndpoint[] = blueprint.nodeFaces.map((_, i) => (i === 0 ? presetEndpoint(point, undefined, level) : presetEndpoint(point, i - 1, level)));

      const field = activeFloorField(state);
      const { offsets } = getNeighborData(field.tessellationConfig, point[0], point[1]);
      const customPts = field.fieldEditMode === "custom" && field.fieldPoints.size > 0 ? field.fieldPoints : undefined;
      const cells = resolveCells(field.tessellationConfig, customPts);
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

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports,
        presetSplitPoints: nextSplitPoints, presetActiveSplitNode,
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

    const lockedNodes = new Map(state.lockedNodes);
    for (const endpoint of allNodesAt(point, state.presetSplitPoints, level)) {
      lockedNodes.delete(presetEndpointKey(endpoint));
    }

    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators,
      presetSplitPoints, presetActiveSplitNode,
      presetStart, presetFinish, presetGenSource,
      lockedNodes,
      presetsDirty: true,
    });
  }),

  requestPresetSplitTarget: (prompt) => set({ presetSplitTargetPrompt: prompt, presetEntityDeletePrompt: null }),
  cancelPresetSplitTarget: () => set({ presetSplitTargetPrompt: null }),
  applyPresetSplitTargetPick: (slotId) => {
    const prompt = get().presetSplitTargetPrompt;
    if (!prompt) return;
    set({ presetSplitTargetPrompt: null });
    const level = prompt.level;
    const endpoint = presetEndpoint(prompt.point, slotId, level);
    const { action } = prompt;
    switch (action.tool) {
      case "set_start":
        get().setPresetStartEndpoint(endpoint);
        break;
      case "set_finish":
        get().setPresetFinishEndpoint(endpoint);
        break;
      case "lock_in":
      case "lock_out":
      case "full_lock": {
        const kind: NodeLockKind = action.tool === "lock_in" ? "in" : action.tool === "lock_out" ? "out" : "both";
        if (get().lockedNodes.get(presetEndpointKey(endpoint)) === kind) get().removeLockedNode(endpoint.point[0], endpoint.point[1], endpoint.slotId);
        else get().setLockedNode(endpoint.point[0], endpoint.point[1], kind, endpoint.slotId);
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
          return withRecomputedAutoLock(state, { presetConnections, presetsDirty: true });
        });
        break;
      case "split_node":
        get().removePresetSplitAll(descriptor.endpoint.point, descriptor.endpoint.level);
        break;
    }

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
 * a second click. */
function commitPresetVerticalPassage(
  state: MazeState,
  origin: PresetEndpoint,
  tool: "vertical_passage_one_way" | "vertical_passage_two_way",
  direction: "up" | "down",
): Partial<MazeState> {
  const originLevel = origin.level ?? 0;
  const toLevel = direction === "up" ? originLevel + 1 : originLevel - 1;
  const to = presetEndpoint(origin.point, undefined, toLevel === 0 ? undefined : toLevel);
  const entry: PresetVerticalPassageEntry = {
    id: state._nextPresetVerticalPassageId,
    from: origin,
    to,
    direction: tool === "vertical_passage_two_way" ? "two_way" : "forward",
  };
  return {
    presetVerticalPassages: [...state.presetVerticalPassages, entry],
    _nextPresetVerticalPassageId: state._nextPresetVerticalPassageId + 1,
    presetVerticalPassagePending: null,
    presetsDirty: true,
    debugStale: debugStaleOf(state),
  };
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
