import type { NodeDto } from "../wasm/types";
import type {
  PostEditEdge, PostEditMeta, PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry,
} from "../store/postEditTypes";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import {
  type PostEditEndpoint, nodeEndpoint, splitEndpoint, endpointsEqual, edgeKey, endpointKey,
} from "./postEditEndpoint";
import {
  cyclePostEditTeleportDirection, removePostEditTeleport, movePostEditTeleportEndpoint,
} from "./postEditTeleportUtils";
import {
  cyclePostEditVerticalPassageDirection, removePostEditVerticalPassage, movePostEditVerticalPassageEndpoint,
  removePostEditElevator,
} from "./postEditVerticalUtils";
import { removeSlot } from "./splitPointsCore";
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

function pointKeyOf(point: [number, number], level?: number): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

function nodeAt(nodes: NodeDto[], point: [number, number], level: number | undefined, index: number): NodeDto | undefined {
  const levelNodes = nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0));
  return levelNodes[index];
}

/** True if `ep` currently resolves against `context` (a `node` endpoint always resolves; a
 * `split` endpoint resolves only once its slot has been confirmed into the snapshot). */
function endpointResolves(context: PostEditReplayContext, ep: PostEditEndpoint): boolean {
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
      const cycled = cyclePostEditTeleportDirection(state.teleports, command.id);
      return ok({ ...state, teleports: cycled });
    }
    case "moveTeleportEndpoint": {
      if (!state.teleports.some((t) => t.id === command.id)) return fail(state);
      const next = movePostEditTeleportEndpoint(state.teleports, { id: command.id, end: command.end }, command.endpoint);
      return ok({ ...state, teleports: next });
    }
    case "removeTeleport": {
      if (!state.teleports.some((t) => t.id === command.id)) return fail(state);
      return ok({ ...state, teleports: removePostEditTeleport(state.teleports, command.id) });
    }
    case "setMeta": {
      return ok({ ...state, meta: { ...state.meta, [command.slot]: command.endpoint } });
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
      // Pre-resolved at construction time (see `ResolvedRotateMove`'s doc comment) — replay just
      // re-keys the named edges, no tessellation/field access needed here.
      if (command.moves.length === 0) return ok(state);
      const edges = { ...state.edges };
      for (const move of command.moves) delete edges[move.oldKey];
      for (const move of command.moves) {
        edges[edgeKey(move.from, move.to)] = move.edge;
      }
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
      const refsExisting = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        existingNodeEndpoints.some((t) => endpointsEqual(e.from, t) || endpointsEqual(e.to, t));
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsExisting(e)));
      const teleports = state.teleports.filter((t) => !refsExisting(t));

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
      const verticalPassages = cyclePostEditVerticalPassageDirection(state.verticalPassages, command.id);
      return ok({ ...state, verticalPassages });
    }
    case "moveVerticalPassageEndpoint": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const next = movePostEditVerticalPassageEndpoint(state.verticalPassages, { id: command.id, end: command.end }, command.endpoint);
      return ok({ ...state, verticalPassages: next });
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

/** Stable key(s) identifying which logical entit(y/ies) a command belongs to (plan section 9) —
 * teleport/vertical passage/elevator/split-slot/edge/meta each get their own lifeline. The Delete
 * tool (GitHub issue #386) emits ordinary per-entity commands (`setMeta`/`removeTeleport`/etc.)
 * rather than a single bundled command, so each removal is undone by a point reset through its own
 * existing lifeline — no dedicated "deletePoint" lifeline is needed.
 *
 * Returns an array, not a single key (GitHub issue #564): `setEdgePair` can atomically destroy a
 * one-way on one or both sides while creating a (possibly different) one-way on either — up to two
 * independent `oneWay:${id}` lifelines at once, one per side, neither derivable from the other. A
 * one-way's lifeline is its own stable id (`oneWay:${id}`), not its spatial `edgeKey` — two
 * different one-way entities created in sequence on the same face are two different lifelines, per
 * the user's own "wall/passage -> one-way -> wall/passage -> one-way is a new entity" decision.
 * Every other command kind still returns exactly one key, wrapped in a single-element array. */
export function lifelineKeysOf(command: PostEditCommand): string[] {
  switch (command.kind) {
    case "addTeleport": case "setTeleportDirection": case "moveTeleportEndpoint": case "removeTeleport":
      return [`teleport:${command.id}`];
    case "addVerticalPassage": case "setVerticalPassageDirection": case "moveVerticalPassageEndpoint": case "removeVerticalPassage":
      return [`vertical:${command.id}`];
    case "addElevator": case "updateElevatorFloors": case "removeElevator":
      return [`elevator:${command.id}`];
    case "addSplitNode": case "removeSplitNode":
      return [`slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`];
    case "updateSplitNodeFaces":
      // `slotId: undefined` addresses the point's original node (GitHub issue #564 follow-up) —
      // same standing as a numbered slot, just no slot-removal command of its own to share a
      // lifeline with (the original node can never be removed) — its own point-scoped key.
      return [command.slotId === undefined
        ? `originalNode:${pointKeyOf(command.point, command.level)}`
        : `slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`];
    case "rotateSplitPoint": case "applySplitBlueprint":
      return [`point:${pointKeyOf(command.point, command.level)}`];
    case "setEdge":
      // Same "resulting id, or spatial key if wall/basic" rule as `setEdgePair`'s own sides — a
      // one-way `setEdge` is its own stable id lifeline, not the spatial edge key.
      return command.edge.kind.startsWith("one_way")
        ? [`oneWay:${(command.edge as { id: string }).id}`]
        : [`edge:${edgeKey(command.edge.from, command.edge.to)}`];
    case "setEdgePair": {
      // A wall/basic side has no lifeline of its own (it's not an addressable entity); a one-way
      // side's lifeline is its RESULTING id, and `replacedOneWayIds` (resolved at construction time)
      // names any id it just destroyed — both are included, since a lifeline being destroyed must
      // still cascade a point-reset the same way one being created does.
      const keys: string[] = [];
      if (command.aToB.kind === "one_way_forward" || command.aToB.kind === "one_way_backward") keys.push(`oneWay:${command.aToB.id}`);
      if (command.bToA.kind === "one_way_forward" || command.bToA.kind === "one_way_backward") keys.push(`oneWay:${command.bToA.id}`);
      if (command.replacedOneWayIds?.aToB !== undefined) keys.push(`oneWay:${command.replacedOneWayIds.aToB}`);
      if (command.replacedOneWayIds?.bToA !== undefined) keys.push(`oneWay:${command.replacedOneWayIds.bToA}`);
      return keys;
    }
    case "setMeta":
      return [`meta:${command.slot}`];
  }
}

/** True if `command`'s own entity resolves (on the state *before* this command applies) to
 * `point`/`level` — includes move-commands' old *or* new endpoint (plan section 9 step 2). */
function commandTouchesPoint(
  context: PostEditReplayContext,
  before: PostEditDerivedState,
  command: PostEditCommand,
  point: [number, number],
  level: number | undefined,
): boolean {
  const epTouches = (ep: PostEditEndpoint): boolean => {
    if (ep.kind === "split") return ep.point[0] === point[0] && ep.point[1] === point[1] && (ep.level ?? 0) === (level ?? 0);
    const node = context.nodes.find((n) => n.id === ep.id);
    return node !== undefined && node.x === point[0] && node.y === point[1] && (node.level ?? 0) === (level ?? 0);
  };
  switch (command.kind) {
    case "setEdge":
      return epTouches(command.edge.from) || epTouches(command.edge.to);
    case "setEdgePair":
      return epTouches(command.a) || epTouches(command.b);
    case "addTeleport":
      return epTouches(command.from) || epTouches(command.to);
    case "setTeleportDirection": case "removeTeleport": {
      const t = before.teleports.find((x) => x.id === command.id);
      return t !== undefined && (epTouches(t.from) || epTouches(t.to));
    }
    case "moveTeleportEndpoint": {
      const t = before.teleports.find((x) => x.id === command.id);
      return (t !== undefined && (epTouches(t.from) || epTouches(t.to))) || epTouches(command.endpoint);
    }
    case "setMeta":
      return command.endpoint !== null && epTouches(command.endpoint);
    case "addSplitNode": case "removeSplitNode": case "rotateSplitPoint": case "applySplitBlueprint": case "updateSplitNodeFaces":
      return command.point[0] === point[0] && command.point[1] === point[1] && (command.level ?? 0) === (level ?? 0);
    case "addVerticalPassage":
      return epTouches(command.from) || epTouches(command.to);
    case "removeVerticalPassage": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return p !== undefined && (epTouches(p.from) || epTouches(p.to));
    }
    case "setVerticalPassageDirection": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return p !== undefined && (epTouches(p.from) || epTouches(p.to));
    }
    case "moveVerticalPassageEndpoint": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return (p !== undefined && (epTouches(p.from) || epTouches(p.to))) || epTouches(command.endpoint);
    }
    case "addElevator":
      return command.floors.some(epTouches);
    case "updateElevatorFloors": {
      const e = before.elevators.find((x) => x.id === command.id);
      return e !== undefined && e.floors.some(epTouches);
    }
    case "removeElevator": {
      const e = before.elevators.find((x) => x.id === command.id);
      return e !== undefined && e.floors.some(epTouches);
    }
    default:
      return false;
  }
}

/** Every `PostEditEndpoint` a command's own payload references (`from`/`to`/`floors`/`endpoint`)
 * — used to find lifelines that reference a slot lifeline about to be removed (plan section 9
 * step 4, the "cascade in one pass" rule). */
function endpointsReferencedBy(command: PostEditCommand): PostEditEndpoint[] {
  switch (command.kind) {
    case "setEdge": return [command.edge.from, command.edge.to];
    case "setEdgePair": return [command.a, command.b];
    case "addTeleport": return [command.from, command.to];
    case "setTeleportDirection": return [command.from, command.to];
    case "moveTeleportEndpoint": return [command.endpoint, command.from, command.to];
    case "removeTeleport": return [command.from, command.to];
    case "setMeta": return command.endpoint !== null ? [command.endpoint] : (command.previousEndpoint ? [command.previousEndpoint] : []);
    case "addVerticalPassage": return [command.from, command.to];
    case "setVerticalPassageDirection": return [command.from, command.to];
    case "moveVerticalPassageEndpoint": return [command.endpoint, command.from, command.to];
    case "removeVerticalPassage": return [command.from, command.to];
    case "addElevator": return command.floors;
    case "updateElevatorFloors": return command.floors;
    case "removeElevator": return command.floors;
    case "rotateSplitPoint": return command.moves.flatMap((m) => [m.from, m.to]);
    case "updateSplitNodeFaces": return command.faces.map((f) => f.neighbor);
    default: return [];
  }
}

function isSlotLifeline(key: string): { point: [number, number]; level: number | undefined; slotId: number } | undefined {
  const m = /^slot:(-?\d+),(-?\d+)(?:@(\d+))?:(\d+)$/.exec(key);
  if (!m) return undefined;
  return { point: [Number(m[1]), Number(m[2])], level: m[3] === undefined ? undefined : Number(m[3]), slotId: Number(m[4]) };
}

/** One iteration of affected-lifeline collection (plan section 9 step 1-4) — the caller
 * (`filterCommandsForPoint`) repeats this to a fixed point. Replays `commands` once, snapshotting
 * state before each command applies, to evaluate whether that command's entity currently touches
 * `point`/`level`; also cascades through any lifeline that references a slot lifeline already
 * collected. */
function collectAffectedLifelines(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
  point: [number, number],
  level: number | undefined,
): Set<string> {
  const toRemove = new Set<string>();
  let state = baseline.derived;
  const beforeStates: PostEditDerivedState[] = [];
  for (const command of commands) {
    beforeStates.push(state);
    const result = applyPostEditCommand(baseline.context, state, command);
    if (result.applied) state = result.state;
  }

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    if (commandTouchesPoint(baseline.context, beforeStates[i], command, point, level)) {
      for (const key of lifelineKeysOf(command)) toRemove.add(key);
    }
  }

  const removedSlotKeys = new Set([...toRemove].map(isSlotLifeline).filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => endpointKey(splitEndpoint(s.point, s.slotId, s.level))));
  if (removedSlotKeys.size > 0) {
    for (const command of commands) {
      const keys = lifelineKeysOf(command);
      if (keys.some((k) => toRemove.has(k))) continue;
      const refs = endpointsReferencedBy(command);
      if (refs.some((ep) => ep.kind === "split" && removedSlotKeys.has(endpointKey(ep)))) {
        for (const key of keys) toRemove.add(key);
      }
    }
  }

  return toRemove;
}

/** Prunes `commands` to remove every command belonging to a lifeline that currently touches
 * `point`/`level`, iterating to a fixed point so multi-level dependency chains (slot -> edge on
 * slot -> move another lifeline through that slot -> ...) are fully resolved, not just the first
 * hop (plan section 9). A command with more than one lifeline (`setEdgePair` touching two
 * independent one-ways, GitHub issue #564) is removed if ANY of its lifelines is affected — a
 * command belongs fully to every lifeline it names, it can't be partially pruned. */
export function filterCommandsForPoint(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
  point: [number, number],
  level?: number,
): PostEditCommand[] {
  let current = commands;
  for (;;) {
    const toRemove = collectAffectedLifelines(baseline, current, point, level);
    if (toRemove.size === 0) return current;
    current = current.filter((cmd) => !lifelineKeysOf(cmd).some((k) => toRemove.has(k)));
  }
}

export { endpointResolves };
