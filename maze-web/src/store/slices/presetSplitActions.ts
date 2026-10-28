import type { StateCreator } from "zustand";
import type { MazeStore, PresetConnectionsState, PresetConnectionsActions } from "../storeTypes";
import { REMOVE_ENDPOINT_NODE_REJECTED, resetEdgeToDefault, appendPresetEntityOrder, edgeEntityKey, splitEntityKey, removeDeletedUserEdgeOrder } from "./presetConnectionsHelpers";
import { type PresetConnectionEntry, resolveCells } from "../../pixi/fieldEditUtils";
import { presetEdgeKey, canonicalizePresetPair, resolvePresetPartnerAt, allNodesAt, rotatePresetSplitPoint } from "../../pixi/presetSplitResolve";
import { presetEndpoint, presetEndpointKey, presetEndpointIsSplit, presetEndpointsEqual, type PresetEndpoint } from "../../pixi/presetEndpoint";
import type { SplitRef } from "../../pixi/postEditEndpoint";
import { addSlot, removeSlot, cycleActive, setActive } from "../../pixi/splitPointsCore";
import { buildCellSet } from "../../pixi/selectors/sharedSelectors";
import { getNeighborData } from "../../pixi/tessellationGeometry";
import type { NodeLockKind } from "../../wasm/types";
import { withRecomputedAutoLock, activeFloorField, activeFloorLevel } from "../storeHelpers";
import { notify } from "../../notifications/notificationStore";
import { notifyEditRefusal, SPLIT_ROTATION_OUTSIDE_FIELD } from "../../notifications/editRefusalNotifications";

type Creator = StateCreator<MazeStore, [], [], PresetConnectionsState & PresetConnectionsActions>;
type CreatorSet = Parameters<Creator>[0];
type CreatorGet = Parameters<Creator>[1];

export const createPresetSplitActions = (set: CreatorSet, get: CreatorGet): Pick<PresetConnectionsActions, "addPresetSplitNode" | "removePresetSplitNode" | "removePresetSplitAll" | "cyclePresetActiveSplitNode" | "setPresetActiveSplitNode" | "setPresetFocusedPoint" | "setPresetHoveredLink" | "setPresetHoveredEntity" | "rotatePresetSplitPoint" | "applyPresetSplitBlueprint"> => ({
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
      // always picks one via `blueprintsFor`, so this only matters for a direct call).
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
});
