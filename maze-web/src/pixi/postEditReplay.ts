import type { NodeDto } from "../wasm/types";
import type {
  PostEditEdge, PostEditMeta, PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry,
} from "../store/postEditTypes";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, edgeKey,
} from "./postEditEndpoint";
import {
  cyclePostEditTeleportDirection, removePostEditTeleport,
} from "./postEditTeleportUtils";
import {
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage,
  removePostEditElevator,
} from "./postEditVerticalUtils";
import { removeSlot } from "./splitPointsCore";
import { nodeAt, applyRotatedNodesToEdges } from "./postEditRotation";
import type { EdgeDto } from "../wasm/types";

/** Baseline nodes/edges a log's endpoints resolve against, plus the split-slot resolver built from
 * the latest confirmed snapshot — never live confirmed `state.nodes`/`state.edges` (see plan
 * section 3/4). Mirrors `PostEditController`'s own resolver contract (`postEditEndpoint.ts`). */
export interface PostEditReplayContext {
  nodes: NodeDto[];
  edges: EdgeDto[];
  resolveSplit: (point: [number, number], slotId: number, level?: number) => number | undefined;
}

/** The derived, computed state a command log folds down to — same shape the old 9 draft fields
 * used to carry directly, now produced by `applyPostEditCommand`/`replayPostEditCommands` instead
 * of ad-hoc per-action mutation. `splitPointIds` (GitHub issue #564) is the split TILE's own stable
 * id per point key (`pointKeyOf`) — distinct from `splitPoints`' per-point slotId list. Generation-
 * baked vertical passages/elevators are full entries in `verticalPassages`/`elevators` from the
 * baseline onward (GitHub issue #564) — there is no separate generation-mesh suppression concept
 * any more; editing/removing one is an ordinary edit of an existing draft entry. */
export interface PostEditDerivedState {
  edges: Record<string, PostEditEdge>;
  teleports: PostEditTeleportEntry[];
  meta: PostEditMeta;
  splitPoints: Record<string, number[]>;
  splitPointIds: Record<string, string>;
  verticalPassages: PostEditVerticalPassageEntry[];
  elevators: PostEditElevatorEntry[];
}

export interface PostEditBaseline {
  /** Bumped on every new generation, never on post-edit reset. */
  revision: number;
  context: PostEditReplayContext;
  derived: PostEditDerivedState;
}

export interface PostEditApplyResult {
  state: PostEditDerivedState;
  /** false when the command's references don't resolve against `state`/`context` — distinguishes
   * "no-op but valid" from "invalid, must not be appended/kept". */
  applied: boolean;
}

export function pointKeyOf(point: [number, number], level?: number): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

/** True if `ep` currently resolves against `context` (a `node` endpoint always resolves; a
 * `split` endpoint resolves only once its slot has been confirmed into the snapshot). */
export function endpointResolves(context: PostEditReplayContext, ep: PostEditEndpoint): boolean {
  if (ep.kind === "node") return true;
  return context.resolveSplit(ep.point, ep.slotId, ep.level) !== undefined;
}

const ok = (state: PostEditDerivedState): PostEditApplyResult => ({ state, applied: true });
const fail = (state: PostEditDerivedState): PostEditApplyResult => ({ state, applied: false });

/** Single primitive every command funnels through — `replayPostEditCommands` and incremental
 * `appendPostEditCommand` both call this, never duplicate its logic (plan section 3's mandatory
 * parity contract). Never mutates `state`/`context` or any nested Record/array. */
export function applyPostEditCommand(
  context: PostEditReplayContext,
  state: PostEditDerivedState,
  command: PostEditCommand,
): PostEditApplyResult {
  switch (command.kind) {
    case "setEdge": {
      const key = edgeKey(command.edge.from, command.edge.to);
      const next = { ...state.edges };
      if (command.edge.kind === "wall") delete next[key];
      else next[key] = command.edge;
      return ok({ ...state, edges: next });
    }
    case "setEdgePair": {
      const abKey = edgeKey(command.a, command.b);
      const baKey = edgeKey(command.b, command.a);
      const next = { ...state.edges };
      if (command.aToB.kind === "wall") delete next[abKey];
      else next[abKey] = command.aToB;
      if (command.bToA.kind === "wall") delete next[baKey];
      else next[baKey] = command.bToA;
      return ok({ ...state, edges: next });
    }
    case "addTeleport": {
      if (state.teleports.some((t) => t.id === command.id)) return fail(state);
      const entry: PostEditTeleportEntry = { id: command.id, from: command.from, to: command.to, direction: command.direction };
      return ok({ ...state, teleports: [...state.teleports, entry] });
    }
    case "setTeleportDirection": {
      if (!state.teleports.some((t) => t.id === command.id)) return fail(state);
      const target = state.teleports.find((t) => t.id === command.id)!;
      if (target.direction === command.direction) return ok(state);
      if (command.absolute) {
        return ok({ ...state, teleports: state.teleports.map((t) => (t.id === command.id ? { ...t, direction: command.direction } : t)) });
      }
      const cycled = cyclePostEditTeleportDirection(state.teleports, command.id);
      return ok({ ...state, teleports: cycled });
    }
    case "moveTeleportEndpoint": {
      if (!state.teleports.some((t) => t.id === command.id)) return fail(state);
      // `from`/`to` are the complete resulting pair captured when the command was created. Apply
      // both directly so one blueprint migration command can move both endpoints when a teleport
      // happens to have both ends on the replaced split point.
      const teleports = state.teleports.map((t) =>
        t.id === command.id ? { ...t, from: command.from, to: command.to } : t);
      return ok({ ...state, teleports });
    }
    case "removeTeleport": {
      if (!state.teleports.some((t) => t.id === command.id)) return fail(state);
      return ok({ ...state, teleports: removePostEditTeleport(state.teleports, command.id) });
    }
    case "addMeta": {
      // Compaction may remove a generated waypoint's obsolete `removeMeta` when the same fixed
      // slot is recreated later. The surviving creation event must still replay over the pristine
      // generated slot; incremental store actions never append addMeta while the slot is occupied.
      return ok({ ...state, meta: { ...state.meta, [command.slot]: command.endpoint } });
    }
    case "setMeta": {
      return ok({ ...state, meta: { ...state.meta, [command.slot]: command.endpoint } });
    }
    case "removeMeta": {
      // `endpoint` is the waypoint's own pre-deletion snapshot used by the Changes panel. It must
      // survive compaction even when an earlier move command is dropped, so deletion addresses the
      // fixed slot/id rather than requiring that denormalized display coordinate to match replay's
      // current coordinate.
      if (state.meta[command.slot] === null) return fail(state);
      return ok({ ...state, meta: { ...state.meta, [command.slot]: null } });
    }
    case "addSplitNode": {
      const key = pointKeyOf(command.point, command.level);
      const existing = state.splitPoints[key] ?? [];
      if (existing.includes(command.slotId)) return fail(state);
      const currentPointId = state.splitPointIds[key];
      if (currentPointId !== undefined && currentPointId !== command.pointId) return fail(state);
      return ok({
        ...state,
        splitPoints: { ...state.splitPoints, [key]: [...existing, command.slotId] },
        splitPointIds: { ...state.splitPointIds, [key]: command.pointId },
      });
    }
    case "removeSplitNode": {
      const key = pointKeyOf(command.point, command.level);
      const existing = state.splitPoints[key] ?? [];
      if (!existing.includes(command.slotId)) return fail(state);
      const currentPointId = state.splitPointIds[key];
      if (currentPointId !== undefined && currentPointId !== command.pointId) return fail(state);
      const target = splitEndpoint(command.point, command.slotId, command.level);
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointsEqual(e.from, target) || endpointsEqual(e.to, target);
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsTarget(e)));
      const teleports = state.teleports.filter((t) => !refsTarget(t));
      const { splitPoints } = removeSlot(
        state.splitPoints, {}, command.point, command.slotId,
        () => false, command.level,
      );
      // Clears the CURRENT derived state's own pointId once the point's last slot is gone —
      // baseline's own `splitPointIds` is never touched (immutable), so point-reset (which restarts
      // replay from baseline) restores the original id regardless of what happened here (GitHub
      // issue #564).
      let splitPointIds = state.splitPointIds;
      if (splitPoints[key] === undefined && splitPointIds[key] !== undefined) {
        splitPointIds = { ...splitPointIds };
        delete splitPointIds[key];
      }
      return ok({ ...state, edges, teleports, splitPoints, splitPointIds });
    }
    case "removeSplitPoint": {
      const key = pointKeyOf(command.point, command.level);
      const currentPointId = state.splitPointIds[key];
      if (currentPointId !== undefined && currentPointId !== command.pointId) return fail(state);
      const existing = state.splitPoints[key] ?? [];
      if (!command.removedSlotIds.every((id) => existing.includes(id))) return fail(state);
      const removedTargets = command.removedSlotIds.map((slotId) => splitEndpoint(command.point, slotId, command.level));
      const refsRemoved = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        removedTargets.some((t) => endpointsEqual(e.from, t) || endpointsEqual(e.to, t));
      let edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsRemoved(e)));
      const teleports = state.teleports.filter((t) => !refsRemoved(t));

      const originalNode = nodeAt(context.nodes, command.point, command.level, 0);
      if (originalNode !== undefined && command.restoredOriginalFaces) {
        const originalEndpoint = nodeEndpoint(originalNode.id);
        const refsOriginal = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
          endpointsEqual(e.from, originalEndpoint) || endpointsEqual(e.to, originalEndpoint);
        edges = Object.fromEntries(Object.entries(edges).filter(([, e]) => !refsOriginal(e)));
        for (const face of command.restoredOriginalFaces) {
          const toKey = edgeKey(originalEndpoint, face.neighbor);
          const fromKey = edgeKey(face.neighbor, originalEndpoint);
          if (face.toNeighbor.kind === "wall") delete edges[toKey];
          else edges[toKey] = face.toNeighbor;
          if (face.fromNeighbor.kind === "wall") delete edges[fromKey];
          else edges[fromKey] = face.fromNeighbor;
        }
      }

      const remainingSlots = existing.filter((id) => !command.removedSlotIds.includes(id));
      const splitPoints = { ...state.splitPoints };
      if (remainingSlots.length === 0) delete splitPoints[key];
      else splitPoints[key] = remainingSlots;
      let splitPointIds = state.splitPointIds;
      if (remainingSlots.length === 0 && splitPointIds[key] !== undefined) {
        splitPointIds = { ...splitPointIds };
        delete splitPointIds[key];
      }
      return ok({ ...state, edges, teleports, splitPoints, splitPointIds });
    }
    case "updateSplitNodeFaces": {
      const key = pointKeyOf(command.point, command.level);
      // `slotId: undefined` addresses the point's original node — same standing as any other slot,
      // just not itself listed in `state.splitPoints[key]` (that list only ever holds EXTRA slot
      // ids, see `deriveSplitPointsFromNodes`'s doc comment) — so it's checked against the resolver
      // instead (the original node always exists once the point itself does), while a numbered slot
      // is still checked the existing way (GitHub issue #564 follow-up).
      let target: PostEditEndpoint;
      if (command.slotId === undefined) {
        const node = nodeAt(context.nodes, command.point, command.level, 0);
        if (node === undefined) return fail(state);
        target = nodeEndpoint(node.id);
      } else {
        const existing = state.splitPoints[key] ?? [];
        if (!existing.includes(command.slotId)) return fail(state);
        target = splitEndpoint(command.point, command.slotId, command.level);
      }
      const currentPointId = state.splitPointIds[key];
      if (currentPointId !== undefined && currentPointId !== command.pointId) return fail(state);
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointsEqual(e.from, target) || endpointsEqual(e.to, target);
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsTarget(e)));
      for (const face of command.faces) {
        const toKey = edgeKey(target, face.neighbor);
        const fromKey = edgeKey(face.neighbor, target);
        if (face.toNeighbor.kind === "wall") delete edges[toKey];
        else edges[toKey] = face.toNeighbor;
        if (face.fromNeighbor.kind === "wall") delete edges[fromKey];
        else edges[fromKey] = face.fromNeighbor;
      }
      return ok({ ...state, edges });
    }
    case "rotateSplitPoint": {
      // Pre-resolved at construction time (see `ResolvedRotateNode`'s doc comment) — each entry is
      // one of the point's own nodes' COMPLETE post-rotation face list, applied the same way
      // `updateSplitNodeFaces` applies a single node's snapshot (GitHub issue #548 compaction
      // follow-up: a full snapshot, unlike the old diff-shaped `moves`, is safe to have an EARLIER
      // command in its own lifeline dropped by compaction without leaving a dangling re-key).
      if (command.nodes.length === 0) return ok(state);
      const edges = applyRotatedNodesToEdges(state.edges, command.point, command.level, context.nodes, command.nodes);
      if (edges === undefined) return fail(state);
      return ok({ ...state, edges });
    }
    case "applySplitBlueprint": {
      const key = pointKeyOf(command.point, command.level);
      const currentPointId = state.splitPointIds[key];
      if (currentPointId !== undefined && currentPointId !== command.pointId) return fail(state);
      const originalNode = nodeAt(context.nodes, command.point, command.level, 0);
      const originalEndpoint = originalNode ? nodeEndpoint(originalNode.id) : null;
      const existingSlots = state.splitPoints[key] ?? [];
      const existingNodeEndpoints: PostEditEndpoint[] = [
        ...(originalEndpoint ? [originalEndpoint] : []),
        ...existingSlots.map((slotId) => splitEndpoint(command.point, slotId, command.level)),
      ];
      // A confirmed split node can be referenced either by its stable `split` form or by the
      // resolved `node` form (manual edge commands use the latter). Strip both forms while the
      // blueprint replaces the point; follow-up movement commands then retarget vertex elements
      // without leaving stale edges behind.
      for (const node of context.nodes) {
        if (node.x !== command.point[0] || node.y !== command.point[1] || (node.level ?? 0) !== (command.level ?? 0)) continue;
        if (node.i === 0 || existingSlots.includes(node.i - 1)) existingNodeEndpoints.push(nodeEndpoint(node.id));
      }
      const refsExisting = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        existingNodeEndpoints.some((t) => endpointsEqual(e.from, t) || endpointsEqual(e.to, t));
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsExisting(e)));
      // Vertex elements are moved by the store action immediately after this single blueprint
      // command. Keep them in the replay state here so those follow-up movement commands can
      // preserve them instead of silently deleting teleports that were anchored on an old slot.
      const teleports = state.teleports;

      const slotEndpoints: PostEditEndpoint[] = command.resolvedSlots.map((s) => splitEndpoint(command.point, s.slotId, command.level));
      // `resolvedSlots` carries only the minted slots' faces — the original node (when present)
      // keeps its own faces via `originalFaces`, folded into the same command (GitHub issue #545),
      // since it has no slotId to be keyed under here.
      for (let i = 0; i < command.resolvedSlots.length; i++) {
        const endpoint = slotEndpoints[i];
        for (const face of command.resolvedSlots[i].faces) {
          edges[edgeKey(endpoint, face.neighbor)] = { from: endpoint, to: face.neighbor, kind: "basic" };
          edges[edgeKey(face.neighbor, endpoint)] = { from: face.neighbor, to: endpoint, kind: "basic" };
        }
      }
      if (originalEndpoint && command.originalFaces) {
        for (const face of command.originalFaces) {
          edges[edgeKey(originalEndpoint, face.neighbor)] = { from: originalEndpoint, to: face.neighbor, kind: "basic" };
          edges[edgeKey(face.neighbor, originalEndpoint)] = { from: face.neighbor, to: originalEndpoint, kind: "basic" };
        }
      }

      // `command.resolvedSlots` is the point's COMPLETE post-blueprint slot list (construction time
      // reuses existing slot ids where possible, only minting fresh ones past that — see
      // `applySplitBlueprint`'s own doc comment in `postEditSlice.ts`), so it's used verbatim here,
      // not merged with `existingSlots`. A survivor slot id reused this way just gets its faces
      // overwritten above like any other; a slot id NOT present in `resolvedSlots` is dropped from
      // the point (its edges/teleports were already stripped by `refsExisting` above).
      const nextSplitPoints = { ...state.splitPoints };
      if (command.resolvedSlots.length === 0) delete nextSplitPoints[key];
      else nextSplitPoints[key] = command.resolvedSlots.map((s) => s.slotId);

      let splitPointIds = state.splitPointIds;
      if (command.resolvedSlots.length === 0 && originalNode === undefined) {
        // No slots left and no original node either — the point is gone from this derived state
        // entirely (mirrors `removeSplitNode`'s own clearing rule).
        if (splitPointIds[key] !== undefined) {
          splitPointIds = { ...splitPointIds };
          delete splitPointIds[key];
        }
      } else if (splitPointIds[key] !== command.pointId) {
        splitPointIds = { ...splitPointIds, [key]: command.pointId };
      }

      return ok({ ...state, edges, teleports, splitPoints: nextSplitPoints, splitPointIds });
    }
    case "addVerticalPassage": {
      if (state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const entry: PostEditVerticalPassageEntry = { id: command.id, from: command.from, to: command.to, direction: command.direction };
      return ok({ ...state, verticalPassages: [...state.verticalPassages, entry] });
    }
    case "setVerticalPassageDirection": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const verticalPassages = command.absolute
        ? state.verticalPassages.map((p) => (p.id === command.id ? { ...p, direction: command.direction } : p))
        : cyclePostEditVerticalPassageDirection(state.verticalPassages, command.id);
      return ok({ ...state, verticalPassages });
    }
    case "moveVerticalPassageEndpoint": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      // Applies the command's own already-resolved `from`/`to` pair directly (GitHub issue #566) —
      // both ends move together, not just `command.end`; the reducer stays a plain, deterministic
      // applier (see `resolveVerticalPassageMove`'s doc comment, postEditVerticalUtils.ts).
      const verticalPassages = state.verticalPassages.map((p) =>
        p.id === command.id ? { ...p, from: command.from, to: command.to } : p);
      return ok({ ...state, verticalPassages });
    }
    case "removeVerticalPassage": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      return ok({ ...state, verticalPassages: removePostEditVerticalPassage(state.verticalPassages, command.id) });
    }
    case "addElevator": {
      if (state.elevators.some((e) => e.id === command.id)) return fail(state);
      const entry: PostEditElevatorEntry = { id: command.id, floors: command.floors };
      return ok({ ...state, elevators: [...state.elevators, entry] });
    }
    case "updateElevatorFloors": {
      if (!state.elevators.some((e) => e.id === command.id)) return fail(state);
      const elevators = state.elevators.map((e) => (e.id === command.id ? { ...e, floors: command.floors } : e));
      return ok({ ...state, elevators });
    }
    case "removeElevator": {
      if (!state.elevators.some((e) => e.id === command.id)) return fail(state);
      return ok({ ...state, elevators: removePostEditElevator(state.elevators, command.id) });
    }
  }
}

/** High-level fold — the only caller that takes a full `PostEditBaseline` and replays commands
 * that aren't a plain append-to-end (reset, point-reset, load). Not used by the incremental append
 * path, which calls `applyPostEditCommand` directly against the current derived state (see
 * `postEditSliceHelpers.ts`'s `appendPostEditCommand`) — parity between the two is covered by
 * `postEditReplay.test.ts`. */
export function replayPostEditCommands(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
): PostEditDerivedState {
  let state = baseline.derived;
  for (const command of commands) {
    const result = applyPostEditCommand(baseline.context, state, command);
    if (result.applied) state = result.state;
  }
  return state;
}

/** Same as `replayPostEditCommands`, but fails closed: returns `undefined` the moment any single
 * command doesn't apply, instead of silently skipping it — used only by project-file load (plan
 * section 8), never by point-reset (which uses `filterCommandsForPoint` to prune to an internally
 * consistent list first) or ordinary in-session replay. */
export function replayPostEditCommandsFailClosed(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
): PostEditDerivedState | undefined {
  let state = baseline.derived;
  for (const command of commands) {
    const result = applyPostEditCommand(baseline.context, state, command);
    if (!result.applied) return undefined;
    state = result.state;
  }
  return state;
}

