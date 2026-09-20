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

/** Folds `pairs` (an `addElevator`/`updateElevatorFloors` command's own `suppressPairs`, GitHub
 * issue #545) into a suppression set, returning a fresh `Set` only when at least one pair is new
 * — mirrors the standalone `suppressGenerationPair` command's own idempotent-add behavior, just
 * batched. `undefined`/`[]` returns `set` unchanged (same reference, no-op). */
function addSuppressPairs(set: Set<string>, pairs: [PostEditEndpoint, PostEditEndpoint][] | undefined): Set<string> {
  if (!pairs || pairs.length === 0) return set;
  let next: Set<string> | undefined;
  for (const [a, b] of pairs) {
    const key = suppressionPairKey(a, b);
    if (!set.has(key)) {
      if (!next) next = new Set(set);
      next.add(key);
    }
  }
  return next ?? set;
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
    case "setEdgePair": {
      const abKey = edgeKey(command.a, command.b);
      const baKey = edgeKey(command.b, command.a);
      const next = { ...state.edges };
      if (command.aToB === "wall") delete next[abKey];
      else next[abKey] = { from: command.a, to: command.b, kind: command.aToB };
      if (command.bToA === "wall") delete next[baKey];
      else next[baKey] = { from: command.b, to: command.a, kind: command.bToA };
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
    case "updateSplitNodeFaces": {
      const key = pointKeyOf(command.point, command.level);
      const existing = state.splitPoints[key] ?? [];
      if (!existing.includes(command.slotId)) return fail(state);
      const target = splitEndpoint(command.point, command.slotId, command.level);
      const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
        endpointsEqual(e.from, target) || endpointsEqual(e.to, target);
      const edges = Object.fromEntries(Object.entries(state.edges).filter(([, e]) => !refsTarget(e)));
      for (const face of command.faces) {
        const toKey = edgeKey(target, face.neighbor);
        const fromKey = edgeKey(face.neighbor, target);
        if (face.toNeighbor === "wall") delete edges[toKey];
        else edges[toKey] = { from: target, to: face.neighbor, kind: face.toNeighbor };
        if (face.fromNeighbor === "wall") delete edges[fromKey];
        else edges[fromKey] = { from: face.neighbor, to: target, kind: face.fromNeighbor };
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

      return ok({ ...state, edges, teleports, splitPoints: nextSplitPoints });
    }
    case "addVerticalPassage": {
      if (state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const entry: PostEditVerticalPassageEntry = { id: command.id, from: command.from, to: command.to, direction: command.direction };
      return ok({ ...state, verticalPassages: [...state.verticalPassages, entry] });
    }
    case "setVerticalPassageDirection": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const verticalPassages = cyclePostEditVerticalPassageDirection(state.verticalPassages, command.id);
      const suppressedVerticalPassagePairs = addSuppressPairs(
        state.suppressedVerticalPassagePairs,
        command.suppressPair ? [command.suppressPair] : undefined,
      );
      return ok({ ...state, verticalPassages, suppressedVerticalPassagePairs });
    }
    case "moveVerticalPassageEndpoint": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      const next = movePostEditVerticalPassageEndpoint(state.verticalPassages, { id: command.id, end: command.end }, command.endpoint);
      const suppressedVerticalPassagePairs = addSuppressPairs(state.suppressedVerticalPassagePairs, command.suppressPairs);
      return ok({ ...state, verticalPassages: next, suppressedVerticalPassagePairs });
    }
    case "removeVerticalPassage": {
      if (!state.verticalPassages.some((p) => p.id === command.id)) return fail(state);
      return ok({ ...state, verticalPassages: removePostEditVerticalPassage(state.verticalPassages, command.id) });
    }
    case "addElevator": {
      if (state.elevators.some((e) => e.id === command.id)) return fail(state);
      const entry: PostEditElevatorEntry = { id: command.id, floors: command.floors };
      const suppressedElevatorPairs = addSuppressPairs(state.suppressedElevatorPairs, command.suppressPairs);
      return ok({ ...state, elevators: [...state.elevators, entry], suppressedElevatorPairs });
    }
    case "updateElevatorFloors": {
      if (!state.elevators.some((e) => e.id === command.id)) return fail(state);
      const elevators = state.elevators.map((e) => (e.id === command.id ? { ...e, floors: command.floors } : e));
      const suppressedElevatorPairs = addSuppressPairs(state.suppressedElevatorPairs, command.suppressPairs);
      return ok({ ...state, elevators, suppressedElevatorPairs });
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
 * vertical passage/elevator/split-slot/edge/meta each get their own lifeline. The Delete tool
 * (GitHub issue #386) emits ordinary per-entity commands (`setMeta`/`removeTeleport`/etc. plus
 * `suppressGenerationPair`, GitHub issue #545) rather than a single bundled command, so each
 * removal is undone by a point reset through its own existing lifeline — no dedicated
 * "deletePoint" lifeline is needed. */
export function lifelineKeyOf(command: PostEditCommand): string {
  switch (command.kind) {
    case "addTeleport": case "setTeleportDirection": case "moveTeleportEndpoint": case "removeTeleport":
      return `teleport:${command.id}`;
    case "addVerticalPassage": case "setVerticalPassageDirection": case "moveVerticalPassageEndpoint": case "removeVerticalPassage":
      return `vertical:${command.id}`;
    case "addElevator": case "updateElevatorFloors": case "removeElevator":
      return `elevator:${command.id}`;
    case "addSplitNode": case "removeSplitNode": case "updateSplitNodeFaces":
      return `slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`;
    case "rotateSplitPoint": case "applySplitBlueprint":
      return `point:${pointKeyOf(command.point, command.level)}`;
    case "setEdge":
      return `edge:${edgeKey(command.from, command.to)}`;
    case "setEdgePair":
      // Both directions of the same face pair always touch the same point(s) by construction (see
      // `setEdgePair`'s own doc comment) — one shared lifeline for the pair is enough, keyed the
      // same way an unordered pair would be, so it never collides with a plain `setEdge` lifeline
      // for either direction alone (that key ends with a single `-`-joined `from-to`, this one has
      // two dashes and a `|`).
      return `edgePair:${[edgeKey(command.a, command.b), edgeKey(command.b, command.a)].sort().join("|")}`;
    case "setMeta":
      return `meta:${command.slot}`;
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
      const suppressPair = command.suppressPair;
      return (p !== undefined && (epTouches(p.from) || epTouches(p.to)))
        || (suppressPair !== undefined && (epTouches(suppressPair[0]) || epTouches(suppressPair[1])));
    }
    case "moveVerticalPassageEndpoint": {
      const p = before.verticalPassages.find((x) => x.id === command.id);
      return (p !== undefined && (epTouches(p.from) || epTouches(p.to))) || epTouches(command.endpoint)
        || (command.suppressPairs ?? []).some(([a, b]) => epTouches(a) || epTouches(b));
    }
    case "addElevator":
      return command.floors.some(epTouches) || (command.suppressPairs ?? []).some(([a, b]) => epTouches(a) || epTouches(b));
    case "updateElevatorFloors": {
      const e = before.elevators.find((x) => x.id === command.id);
      return (e !== undefined && e.floors.some(epTouches)) || (command.suppressPairs ?? []).some(([a, b]) => epTouches(a) || epTouches(b));
    }
    case "removeElevator": {
      const e = before.elevators.find((x) => x.id === command.id);
      return e !== undefined && e.floors.some(epTouches);
    }
    case "suppressGenerationPair": {
      if (epTouches(command.a) || epTouches(command.b)) return true;
      // An elevator's generation-time mesh can span more than two floors (GitHub issue #341
      // follow-up) — a pair between two OTHER stops of the same physically-connected mesh (neither
      // naming a node at `point`/`level` directly) must still count as touching, or resetting the
      // point the Delete tool was clicked on wouldn't un-suppress the whole mesh it suppressed
      // (GitHub issue #545 — the Delete tool now emits one `suppressGenerationPair` command per
      // mesh pair instead of one bundled `deletePoint` command, so the *lifeline* check has to
      // restore the old command's component-wide reach itself). Not applicable to
      // `verticalPassage` — that entity is always exactly two nodes, so its one pair already IS the
      // whole entity.
      if (command.entity !== "elevator") return false;
      const pointNodeIds = context.nodes
        .filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0))
        .map((n) => n.id);
      if (pointNodeIds.length === 0) return false;
      const component = elevatorComponent(context.edges, pointNodeIds);
      return (command.a.kind === "node" && component.has(command.a.id))
        || (command.b.kind === "node" && component.has(command.b.id));
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
    case "setEdge": return [command.from, command.to];
    case "setEdgePair": return [command.a, command.b];
    case "addTeleport": return [command.from, command.to];
    case "setTeleportDirection": return [command.from, command.to];
    case "moveTeleportEndpoint": return [command.endpoint, command.from, command.to];
    case "removeTeleport": return [command.from, command.to];
    case "setMeta": return command.endpoint !== null ? [command.endpoint] : (command.previousEndpoint ? [command.previousEndpoint] : []);
    case "addVerticalPassage": return [command.from, command.to];
    case "setVerticalPassageDirection": return [command.from, command.to, ...(command.suppressPair ?? [])];
    case "moveVerticalPassageEndpoint": return [command.endpoint, command.from, command.to, ...(command.suppressPairs ?? []).flat()];
    case "removeVerticalPassage": return [command.from, command.to];
    case "addElevator": return [...command.floors, ...(command.suppressPairs ?? []).flat()];
    case "updateElevatorFloors": return [...command.floors, ...(command.suppressPairs ?? []).flat()];
    case "removeElevator": return command.floors;
    case "rotateSplitPoint": return command.moves.flatMap((m) => [m.from, m.to]);
    case "updateSplitNodeFaces": return command.faces.map((f) => f.neighbor);
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
