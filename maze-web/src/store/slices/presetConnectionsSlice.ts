import type { StateCreator } from "zustand";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../../pixi/fieldEditUtils";
import { applyTool, computeInvalidKeys, computeInvalidTeleportIds, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, computeInvalidMarkers, computeInvalidSplitPoints, resolveCells, presetEdgeKey, canonicalizePresetPair, resolvePresetActiveEndpoint, resolvePresetPartnerAt, allNodesAt, cycleTeleportDirection, removeTeleport, moveTeleportEndpoint, rotatePresetSplitPoint, cycleVerticalPassageDirection, removeVerticalPassage, moveVerticalPassageEndpoint, removeElevator, cellExistsAt } from "../../pixi/fieldEditUtils";
import { presetEndpoint, presetEndpointIsSplit, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import type { SplitRef } from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import type { MazeState, MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { debugStaleOf, withRecomputedAutoLock, recomputeAutoLock, activeFloorField, activeFloorLevel, resolveFieldAtOf, levelFieldsOf } from "../storeHelpers";

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
  presetSectionsExpanded: { problems: true },
  presetSplitTargetPrompt: null,

  setPresetConnectionsTool: (tool) => set({
    presetConnectionsTool: tool,
    presetTeleportPendingFrom: null,
    presetVerticalPassagePending: null,
    presetElevatorPending: null,
    presetSplitTargetPrompt: null,
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
    const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, resolveFieldAt);
    const presetSplitPoints = { ...state.presetSplitPoints };
    for (const key of invalidSplitKeys) delete presetSplitPoints[key];
    return withRecomputedAutoLock(state, { presetConnections, presetTeleports, presetVerticalPassages, presetElevators, presetStart, presetFinish, presetSplitPoints });
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

  setLockedNode: (x, y, kind) => set((state) => {
    const next = new Map(state.lockedNodes);
    const level = activeFloorLevel(state);
    next.set(level === undefined ? `${x},${y}` : `${x},${y}@${level}`, kind);
    return { lockedNodes: next, debugStale: debugStaleOf(state) };
  }),

  removeLockedNode: (x, y) => set((state) => {
    const level = activeFloorLevel(state);
    const key = level === undefined ? `${x},${y}` : `${x},${y}@${level}`;
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
    if (availableDirections.length === 1) {
      return commitPresetVerticalPassage(state, origin, tool, availableDirections[0]);
    }
    return { presetVerticalPassagePending: { origin, tool, availableDirections } };
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
      // Locked nodes are keyed by plain "x,y[@level]" (point + level only, no slot) — a lock
      // addressing this exact split node isn't representable in that map today (locks are always
      // original-node only), so nothing to clean up there.

      const { splitPoints, activeMap } = removeSlot(
        state.presetSplitPoints, state.presetActiveSplitNode, point, slotId,
        (entry, point, slotId) => entry.slotId !== undefined && presetEndpointIsSplit(entry, { point, slotId }) && (entry.level ?? 0) === (level ?? 0),
        level,
      );

      return withRecomputedAutoLock(state, {
        presetConnections, presetTeleports,
        presetSplitPoints: splitPoints, presetActiveSplitNode: activeMap,
        presetsDirty: true,
      });
    });
  },

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
      if (touchesPoint(entry.from) || touchesPoint(entry.to)) presetConnections.delete(k);
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
    lockedNodes.delete(key);

    return withRecomputedAutoLock(state, {
      presetConnections, presetTeleports, presetVerticalPassages, presetElevators,
      presetSplitPoints, presetActiveSplitNode,
      presetStart, presetFinish, presetGenSource,
      lockedNodes,
      presetsDirty: true,
    });
  }),

  requestPresetSplitTarget: (prompt) => set({ presetSplitTargetPrompt: prompt }),
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
});

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
