import type { StateCreator } from "zustand";
import type { MazeStore, PostEditState, PostEditActions } from "../storeTypes";
import { resolveVerticalPassageMove, resolveElevatorMove } from "../../pixi/postEditUtils";
import { selectNodeLevelResolver } from "../../pixi/selectors/mazeSelectors";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { type PostEditEndpoint, resolveEndpoint, buildSplitNodeResolver } from "../../pixi/postEditEndpoint";
import { resolveFieldAtOf } from "../storeHelpers";
import { tryCommitPostEditVerticalPassage, resolveDragTargets, dispatchPostEditElevatorPlacement, appendPostEditCommand } from "./postEditSliceHelpers";
import { buildMultiFloorPointNodeMap } from "./postEditBaselineBuilders";
import { notifyVerticalDragFailure, notifyVerticalPassageUnavailable } from "../../notifications/editRefusalNotifications";

type Creator = StateCreator<MazeStore, [], [], PostEditState & PostEditActions>;
type CreatorSet = Parameters<Creator>[0];
type CreatorGet = Parameters<Creator>[1];

export const createPostEditVerticalActions = (set: CreatorSet, get: CreatorGet): Pick<PostEditActions, "startPostEditVerticalPassagePlacement" | "choosePostEditVerticalPassageDirection" | "cancelPostEditVerticalPassagePlacement" | "setPostEditVerticalPassageDirection" | "removePostEditVerticalPassage" | "movePostEditVerticalPassageEndpoint" | "startPostEditElevatorPlacement" | "editPostEditElevator" | "togglePostEditElevatorFloor" | "confirmPostEditElevatorPlacement" | "cancelPostEditElevatorPlacement" | "removePostEditElevator" | "movePostEditElevatorEndpoint"> => ({
  startPostEditVerticalPassagePlacement: (origin, tool) => {
    const state = get();
    // `origin` can be a `split`-kind endpoint (GitHub issue #550 ninth follow-up) — a plain
    // `origin.kind !== "node"` guard here used to silently drop every placement started from a split
    // point's numbered slot (the disambiguation dialog picks a slot fine, but this rejected it
    // outright), so `point`/`originLevel` are resolved from either kind: a `node` endpoint via its
    // confirmed coordinates, a `split` endpoint directly from its own `point`/`level` fields.
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const point: [number, number] = origin.kind === "node" ? [originNode!.x, originNode!.y] : origin.point;
    const originLevel = origin.kind === "node" ? (originNode!.level ?? 0) : (origin.level ?? 0);
    // Every click adds a new passage, even where one already exists (GitHub issue #748): a cell may
    // hold any number of elements. Editing an existing passage is the settings tool's job.
    const resolveFieldAt = resolveFieldAtOf(state);
    const availableDirections: ("up" | "down")[] = [];
    if (cellExistsAt(resolveFieldAt, point, originLevel + 1)) availableDirections.push("up");
    if (originLevel > 0 && cellExistsAt(resolveFieldAt, point, originLevel - 1)) availableDirections.push("down");
    if (availableDirections.length === 0) {
      notifyVerticalPassageUnavailable("post_edit");
      return;
    }
    if (availableDirections.length === 1) {
      tryCommitPostEditVerticalPassage(get, set, origin, tool, availableDirections[0]);
      return;
    }
    set({ postEditVerticalPassagePending: { origin, tool, availableDirections } });
  },

  choosePostEditVerticalPassageDirection: (direction) => {
    const pending = get().postEditVerticalPassagePending;
    if (!pending) return;
    tryCommitPostEditVerticalPassage(get, set, pending.origin, pending.tool, direction);
  },

  cancelPostEditVerticalPassagePlacement: () => set({ postEditVerticalPassagePending: null }),

  setPostEditVerticalPassageDirection: (id, direction) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target || target.direction === direction) return;
    appendPostEditCommand(get, set, {
      kind: "setVerticalPassageDirection", id, direction, from: target.from, to: target.to, absolute: true,
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  removePostEditVerticalPassage: (id) => {
    const target = get().postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target) return;
    appendPostEditCommand(get, set, { kind: "removeVerticalPassage", id, from: target.from, to: target.to, direction: target.direction });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditVerticalPassageEndpoint: (id, end, endpoint, otherEndpoint) => {
    const state = get();
    const target = state.postEditDraftVerticalPassages.find((p) => p.id === id);
    if (!target) return;
    // `endpoint` is normally `node`-kind (the plain landing node) but can now be a `split`-kind
    // pick (GitHub issue #567, when the user picked a numbered slot via `PostEditSplitTargetDialog`
    // for the dragged end's own landing point) — either way the real node id is resolved fresh via
    // `resolveEndpoint`/`buildSplitNodeResolver` to drive `resolveVerticalPassageMove`'s (x, y)
    // lookup; `endpoint` itself is passed through unchanged as the dragged end's own resulting form.
    const nodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
    const newNodeId = resolveEndpoint(endpoint, resolveSplit);
    const newNode = newNodeId !== undefined ? state.nodes.find((n) => n.id === newNodeId) : undefined;
    if (!newNode) return;
    // GitHub issue #566: dragging one end of a vertical passage must move BOTH ends to the same
    // (x, y) — `resolveVerticalPassageMove` resolves the OTHER end's own node on its own floor and
    // fails (reverting the whole gesture, no command appended) if that floor has no node there.
    // `otherEndpoint` (GitHub issue #567) is the user's own pick for that other floor when it also
    // turned out to be split — passed straight through instead of `findNodeAt`'s bare first-node
    // pick.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const resolved = resolveVerticalPassageMove(target, end, newNode, state.nodes, resolveNodeLevel, endpoint, otherEndpoint);
    if ("failure" in resolved) {
      notifyVerticalDragFailure("post_edit", "vertical_passage", resolved.failure.point, resolved.failure.level);
      return;
    }
    appendPostEditCommand(get, set, {
      kind: "moveVerticalPassageEndpoint", id, end, endpoint, from: resolved.from, to: resolved.to, direction: target.direction,
    });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  startPostEditElevatorPlacement: (origin) => {
    // `origin` can be a `split`-kind endpoint (GitHub issue #550 ninth follow-up) — a plain
    // `origin.kind !== "node"` guard here used to silently drop every placement started from a
    // split point's numbered slot. `point`/`originLevel` resolve from either kind: a `node`
    // endpoint via its confirmed coordinates, a `split` endpoint directly from its own fields.
    const state = get();
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const originLevel = origin.kind === "node" ? (originNode!.level ?? 0) : (origin.level ?? 0);
    // Always starts a new elevator, even on a node that already has one (GitHub issue #748).
    set({ postEditElevatorPending: { origin, floors: new Set([originLevel]) } });
  },

  // `floors` seeds from the entry's current floors so the dialog reflects real state, and confirming
  // updates the entry in place (GitHub issue #341 follow-up). Generation-baked elevators are full
  // baseline draft entries with their own ids (GitHub issue #564), so they are edited the same way.
  editPostEditElevator: (id, origin) => {
    const state = get();
    const existing = state.postEditDraftElevators.find((e) => e.id === id);
    if (!existing) return;
    const floors = new Set<number>();
    for (const f of existing.floors) {
      floors.add(f.kind === "node" ? (state.nodes.find((nd) => nd.id === f.id)?.level ?? 0) : (f.level ?? 0));
    }
    set({ postEditElevatorPending: { origin, floors, editingId: existing.id } });
  },

  togglePostEditElevatorFloor: (floorIndex) => {
    set((state) => {
      const pending = state.postEditElevatorPending;
      if (!pending) return {};
      const origin = pending.origin;
      const originLevel = origin.kind === "node" ? (state.nodes.find((n) => n.id === origin.id)?.level ?? 0) : (origin.level ?? 0);
      if (floorIndex === originLevel) return {};
      const floors = new Set(pending.floors);
      if (floors.has(floorIndex)) floors.delete(floorIndex);
      else floors.add(floorIndex);
      return { postEditElevatorPending: { ...pending, floors } };
    });
  },

  confirmPostEditElevatorPlacement: () => {
    const state = get();
    const pending = state.postEditElevatorPending;
    if (!pending || pending.floors.size < 2) return;
    const origin = pending.origin;
    const originNode = origin.kind === "node" ? state.nodes.find((n) => n.id === origin.id) : undefined;
    if (origin.kind === "node" && !originNode) return;
    const point: [number, number] = origin.kind === "node" ? [originNode!.x, originNode!.y] : origin.point;
    const levels = Array.from(pending.floors).sort((a, b) => a - b);
    // GitHub issue #567 second follow-up: any of the pending floors can independently be a split
    // point — checked here via the same maze-wide `pointNodeMap` the drag-commit path uses, BEFORE
    // falling back to `resolveActiveNodeIdAt`'s active/first-node default. Before this fix, a fresh
    // elevator placement whose target floor happened to already be split silently attached to
    // whichever node was "active" there (or the first one), the same ambiguity the drag-onto-
    // existing-endpoint case already got a dialog for.
    const pointNodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const { picks, queue } = resolveDragTargets(levels.map((level) => ({ point, level: level === 0 ? undefined : level })), pointNodeMap);
    if (queue.length > 0) {
      const first = queue[0];
      set({
        postEditSplitTargetPrompt: {
          point: first.point, level: first.level, nodeIds: first.nodeIds,
          action: { tool: "place_elevator", origin, levels, editingId: pending.editingId },
          queue, picks,
        },
      });
      return;
    }
    // Every floor resolved for free (none split) — same fallback `resolveActiveNodeIdAt` gave before
    // this fix for the single-confirmed-node/no-node cases (`resolveDragTargets` only fills `picks`
    // from a point's CONFIRMED nodes, same as `resolveActiveNodeIdAt`'s own `nodeIds` source).
    const floors = picks.filter((p): p is PostEditEndpoint => p !== undefined);
    if (floors.length < 2) return;
    dispatchPostEditElevatorPlacement(get, set, pending.editingId, floors);
  },

  cancelPostEditElevatorPlacement: () => set({ postEditElevatorPending: null }),

  removePostEditElevator: (id) => {
    const target = get().postEditDraftElevators.find((e) => e.id === id);
    if (!target) return;
    appendPostEditCommand(get, set, { kind: "removeElevator", id, floors: target.floors });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },

  movePostEditElevatorEndpoint: (id, level, endpoint, otherEndpoints) => {
    const state = get();
    const target = state.postEditDraftElevators.find((e) => e.id === id);
    if (!target) return;
    // `endpoint` is normally `node`-kind (the plain landing node) but can now be a `split`-kind
    // pick (GitHub issue #567, when the user picked a numbered slot for the dragged floor's own
    // landing point) — resolve the real node id fresh via `resolveEndpoint`/`buildSplitNodeResolver`
    // to drive `resolveElevatorMove`'s (x, y) lookup; `endpoint` itself passes through unchanged.
    const nodeMap = buildMultiFloorPointNodeMap(state.nodes);
    const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
    const newNodeId = resolveEndpoint(endpoint, resolveSplit);
    const newNode = newNodeId !== undefined ? state.nodes.find((n) => n.id === newNodeId) : undefined;
    if (!newNode) return;
    // GitHub issue #566: dragging one floor's marker moves every OTHER floor's own endpoint to the
    // same (x, y) too — reuses `updateElevatorFloors`, no dedicated command kind needed since it
    // already carries the full resulting `floors` array. `otherEndpoints` (GitHub issue #567) are
    // the user's own picks for whichever OTHER floors also turned out split, keyed by level —
    // passed straight through `resolveElevatorMove`'s override map instead of `findNodeAt`'s bare
    // first-node pick.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const overridesByLevel = new Map<number, PostEditEndpoint>([[level, endpoint], ...(otherEndpoints ?? []).map((o): [number, PostEditEndpoint] => [o.level, o.endpoint])]);
    const resolved = resolveElevatorMove(target, { id, level }, newNode, state.nodes, resolveNodeLevel, overridesByLevel);
    if ("failure" in resolved) {
      notifyVerticalDragFailure("post_edit", "elevator", resolved.failure.point, resolved.failure.level);
      return;
    }
    // `resolved.own`/`.others` are already the correct final `PostEditEndpoint` for each floor —
    // either the user's own explicit pick (already the right node/split kind) or a plain
    // `nodeEndpoint` from `findNodeAt`. No re-wrap needed: unlike before GitHub issue #567, a
    // floor's resulting kind is decided by what it actually resolved to this move, not by whether
    // it happened to be split-addressed BEFORE the move.
    const floors = target.floors.map((f) => {
      const floorLevel = f.kind === "node" ? (resolveNodeLevel(f.id) ?? 0) : (f.level ?? 0);
      return floorLevel === level ? resolved.own : (resolved.others.get(floorLevel) ?? f);
    });
    appendPostEditCommand(get, set, { kind: "updateElevatorFloors", id, floors });
    if (get().postEditAutoConfirm) {
      void get().confirmPostEdit();
    }
  },
});
