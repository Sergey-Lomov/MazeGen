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
  removePostEditElevator, elevatorComponent,
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

/** The derived, computed state a command log folds down to — same shape the old 9 draft fields +
 * 2 suppression sets used to carry directly, now produced by `applyPostEditCommand`/
 * `replayPostEditCommands` instead of ad-hoc per-action mutation. */
export interface PostEditDerivedState {
  edges: Record<string, PostEditEdge>;
  teleports: PostEditTeleportEntry[];
  meta: PostEditMeta;
  splitPoints: Record<string, number[]>;
  verticalPassages: PostEditVerticalPassageEntry[];
  elevators: PostEditElevatorEntry[];
  /** Generation-time mesh pairs whose seed edge `confirmPostEdit` must no longer resend, because a
   * draft entry now covers them (`suppressGenerationPair` command) — order-independent, keyed by
   * `endpointKey` pair (see `suppressionPairKey`). */
  suppressedVerticalPassagePairs: Set<string>;
  suppressedElevatorPairs: Set<string>;
}

export function suppressionPairKey(a: PostEditEndpoint, b: PostEditEndpoint): string {
  const [x, y] = [endpointKey(a), endpointKey(b)].sort();
  return `${x}|${y}`;
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
      const key = edgeKey(command.from, command.to);
      const next = { ...state.edges };
      if (command.edgeKind === "wall") {
        delete next[key];
      } else {
        next[key] = { from: command.from, to: command.to, kind: command.edgeKind };
      }
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
      return ok({ ...state, splitPoints: { ...state.splitPoints, [key]: [...existing, command.slotId] } });
    }
    case "removeSplitNode": {
      const key = pointKeyOf(command.point, command.level);
      const existing = state.splitPoints[key] ?? [];
      if (!existing.includes(command.slotId)) return fail(state);
      const target = splitEndpoint(command.point, command.slotId, command.level);
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointsEqual(e.from, target) || endpointsEqual(e.to, target);
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsTarget(e)));
      const teleports = state.teleports.filter((t) => !refsTarget(t));
      const { splitPoints } = removeSlot(
        state.splitPoints, {}, command.point, command.slotId,
        () => false, command.level,
      );
      return ok({ ...state, edges, teleports, splitPoints });
    }
    case "rotateSplitPoint": {
      // Pre-resolved at construction time (see `ResolvedRotateMove`'s doc comment) — replay just
      // re-keys the named edges, no tessellation/field access needed here.
      if (command.moves.length === 0) return ok(state);
      const edges = { ...state.edges };
      for (const move of command.moves) delete edges[move.oldKey];
      for (const move of command.moves) {
        edges[edgeKey(move.from, move.to)] = { from: move.from, to: move.to, kind: move.edgeKind };
      }
      return ok({ ...state, edges });
    }
    case "applySplitBlueprint": {
      const key = pointKeyOf(command.point, command.level);
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
      // keeps its own faces via separate `setEdge` commands appended right after this one by the
      // store action, since it has no slotId to be keyed under here.
      for (let i = 0; i < command.resolvedSlots.length; i++) {
        const endpoint = slotEndpoints[i];
        for (const face of command.resolvedSlots[i].faces) {
          edges[edgeKey(endpoint, face.neighbor)] = { from: endpoint, to: face.neighbor, kind: "basic" };
          edges[edgeKey(face.neighbor, endpoint)] = { from: face.neighbor, to: endpoint, kind: "basic" };
        }
      }

      const nextSplitPoints = { ...state.splitPoints };
      if (slotEndpoints.length === 0) delete nextSplitPoints[key];
      else nextSplitPoints[key] = command.resolvedSlots.map((s) => s.slotId);

      return ok({ ...state, edges, teleports, splitPoints: nextSplitPoints });
    }
    case "addVerticalPassage": {
      if (state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const entry: PostEditVerticalPassageEntry = { id: command.id, from: command.from, to: command.to, direction: command.direction };
      return ok({ ...state, verticalPassages: [...state.verticalPassages, entry] });
    }
    case "setVerticalPassageDirection": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      return ok({ ...state, verticalPassages: cyclePostEditVerticalPassageDirection(state.verticalPassages, command.id) });
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
    case "suppressGenerationPair": {
      const key = suppressionPairKey(command.a, command.b);
      const target = command.entity === "verticalPassage" ? state.suppressedVerticalPassagePairs : state.suppressedElevatorPairs;
      if (target.has(key)) return ok(state);
      const next = new Set(target).add(key);
      return ok(
        command.entity === "verticalPassage"
          ? { ...state, suppressedVerticalPassagePairs: next }
          : { ...state, suppressedElevatorPairs: next },
      );
    }
    case "deletePoint": {
      const level = command.level;
      const pointNodeIds = new Set(
        context.nodes.filter((n) => n.x === command.point[0] && n.y === command.point[1] && (n.level ?? 0) === (level ?? 0)).map((n) => n.id),
      );
      const key = pointKeyOf(command.point, level);
      const draftTargets: PostEditEndpoint[] = [
        ...[...pointNodeIds].map((id) => nodeEndpoint(id)),
        ...(state.splitPoints[key] ?? []).map((slotId) => splitEndpoint(command.point, slotId, level)),
      ];
      const endpointRefsTarget = (ep: PostEditEndpoint) => draftTargets.some((t) => endpointsEqual(ep, t));
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointRefsTarget(e.from) || endpointRefsTarget(e.to);

      const nextMeta = { ...state.meta };
      if (nextMeta.start !== null && endpointRefsTarget(nextMeta.start)) nextMeta.start = null;
      if (nextMeta.finish !== null && endpointRefsTarget(nextMeta.finish)) nextMeta.finish = null;

      const teleports = state.teleports.filter((t) => !refsTarget(t));
      const verticalPassages = state.verticalPassages.filter((p) => !refsTarget(p));
      const elevators = state.elevators.filter((e) => !e.floors.some(endpointRefsTarget));

      // A generation-time vertical passage/elevator has no draft entry to filter out above — it's
      // resent verbatim from `context.edges` (the generation snapshot) by `confirmPostEdit` unless
      // suppressed, so deleting the point needs to suppress its generation-time pair(s) too, or the
      // mesh edge would keep reappearing on every confirm. Mirrors the pre-command-log
      // `deletePostEditPoint`'s own suppression logic. An elevator's suppression covers its *entire*
      // generation-time connected component (BFS over `context.edges`' own `elevator` edges), same
      // as a component can span floors that never name this point's own node directly.
      let suppressedVerticalPassagePairs = state.suppressedVerticalPassagePairs;
      for (const e of context.edges) {
        if (e.kind !== "vertical_passage") continue;
        if (!pointNodeIds.has(e.from) && !pointNodeIds.has(e.to)) continue;
        const pairKey = suppressionPairKey(nodeEndpoint(e.from), nodeEndpoint(e.to));
        if (!suppressedVerticalPassagePairs.has(pairKey)) {
          suppressedVerticalPassagePairs = new Set(suppressedVerticalPassagePairs).add(pairKey);
        }
      }
      const elevatorComponentIds = elevatorComponent(context.edges, pointNodeIds);
      let suppressedElevatorPairs = state.suppressedElevatorPairs;
      for (const e of context.edges) {
        if (e.kind !== "elevator") continue;
        if (!elevatorComponentIds.has(e.from) && !elevatorComponentIds.has(e.to)) continue;
        const pairKey = suppressionPairKey(nodeEndpoint(e.from), nodeEndpoint(e.to));
        if (!suppressedElevatorPairs.has(pairKey)) {
          suppressedElevatorPairs = new Set(suppressedElevatorPairs).add(pairKey);
        }
      }

      return ok({
        ...state, meta: nextMeta, teleports, verticalPassages, elevators,
        suppressedVerticalPassagePairs, suppressedElevatorPairs,
      });
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

/** Stable key identifying which logical entity a command belongs to (plan section 9) — teleport/
 * vertical passage/elevator/split-slot/edge/meta each get their own lifeline; `deletePoint` gets
 * its own separate lifeline (`deletePoint:...`) so a point reset always cancels a prior delete. */
export function lifelineKeyOf(command: PostEditCommand): string {
  switch (command.kind) {
    case "addTeleport": case "setTeleportDirection": case "moveTeleportEndpoint": case "removeTeleport":
      return `teleport:${command.id}`;
    case "addVerticalPassage": case "setVerticalPassageDirection": case "moveVerticalPassageEndpoint": case "removeVerticalPassage":
      return `vertical:${command.id}`;
    case "addElevator": case "updateElevatorFloors": case "removeElevator":
      return `elevator:${command.id}`;
    case "addSplitNode": case "removeSplitNode":
      return `slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`;
    case "rotateSplitPoint": case "applySplitBlueprint":
      return `point:${pointKeyOf(command.point, command.level)}`;
    case "setEdge":
      return `edge:${edgeKey(command.from, command.to)}`;
    case "setMeta":
      return `meta:${command.slot}`;
    case "deletePoint":
      return `deletePoint:${pointKeyOf(command.point, command.level)}`;
    case "suppressGenerationPair":
      return `suppress:${command.entity}:${suppressionPairKey(command.a, command.b)}`;
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
      return epTouches(command.from) || epTouches(command.to);
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
    case "addSplitNode": case "removeSplitNode": case "rotateSplitPoint": case "applySplitBlueprint": case "deletePoint":
      return command.point[0] === point[0] && command.point[1] === point[1] && (command.level ?? 0) === (level ?? 0);
    case "addVerticalPassage":
      return epTouches(command.from) || epTouches(command.to);
    case "setVerticalPassageDirection": case "removeVerticalPassage": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return p !== undefined && (epTouches(p.from) || epTouches(p.to));
    }
    case "moveVerticalPassageEndpoint": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return (p !== undefined && (epTouches(p.from) || epTouches(p.to))) || epTouches(command.endpoint);
    }
    case "addElevator":
      return command.floors.some(epTouches);
    case "updateElevatorFloors": case "removeElevator": {
      const e = before.elevators.find((x) => x.id === command.id);
      return e !== undefined && e.floors.some(epTouches);
    }
    case "suppressGenerationPair":
      return epTouches(command.a) || epTouches(command.b);
    default:
      return false;
  }
}

/** Every `PostEditEndpoint` a command's own payload references (`from`/`to`/`floors`/`endpoint`)
 * — used to find lifelines that reference a slot lifeline about to be removed (plan section 9
 * step 4, the "cascade in one pass" rule). */
function endpointsReferencedBy(command: PostEditCommand): PostEditEndpoint[] {
  switch (command.kind) {
    case "setEdge": return [command.from, command.to];
    case "addTeleport": return [command.from, command.to];
    case "moveTeleportEndpoint": return [command.endpoint];
    case "setMeta": return command.endpoint !== null ? [command.endpoint] : [];
    case "addVerticalPassage": return [command.from, command.to];
    case "moveVerticalPassageEndpoint": return [command.endpoint];
    case "addElevator": return command.floors;
    case "updateElevatorFloors": return command.floors;
    case "rotateSplitPoint": return command.moves.flatMap((m) => [m.from, m.to]);
    case "suppressGenerationPair": return [command.a, command.b];
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
      toRemove.add(lifelineKeyOf(command));
    }
  }

  const removedSlotKeys = new Set([...toRemove].map(isSlotLifeline).filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => endpointKey(splitEndpoint(s.point, s.slotId, s.level))));
  if (removedSlotKeys.size > 0) {
    for (const command of commands) {
      const key = lifelineKeyOf(command);
      if (toRemove.has(key)) continue;
      const refs = endpointsReferencedBy(command);
      if (refs.some((ep) => ep.kind === "split" && removedSlotKeys.has(endpointKey(ep)))) {
        toRemove.add(key);
      }
    }
  }

  return toRemove;
}

/** Prunes `commands` to remove every command belonging to a lifeline that currently touches
 * `point`/`level`, iterating to a fixed point so multi-level dependency chains (slot -> edge on
 * slot -> move another lifeline through that slot -> ...) are fully resolved, not just the first
 * hop (plan section 9). */
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
    current = current.filter((cmd) => !toRemove.has(lifelineKeyOf(cmd)));
  }
}

export { endpointResolves };
