// --- Quality-control/repair event replay (GitHub issue #147; decoding lives in generated/qc.ts) ---

import { type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { validateStepShape, type Edge } from "./applyShared";
import { decodeQcEvent, isMutatingQcEvent, type QcEvent } from "./generated/qc";

export type { QcEvent } from "./generated/qc";
export { decodeQcEvent, isMutatingQcEvent, QC_EVENT_TAG } from "./generated/qc";
export type { RepairLimitKind, SplitNodeEdgeDirection, SplitNodeEdge, IssuePayload } from "./qcCustom";

export type MutatingQcEventAt = MutatingEventAt<QcEvent>;

/** Flat layer for QC: forward scan over the node table, skipping scope nodes, decoding events,
 *  filtering to mutating ones only. No checkpoints (GitHub issue #128 is RB-only; QC's own tape
 *  is expected far shorter than a full generation tape — see the plan's "out of scope" section),
 *  same `startIndex`/`limit` shape for consistency with every other `mutatingXEventsWithIndex`. */
export function mutatingQcEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingQcEventAt[] {
  return mutatingEventsWithIndex(tape, decodeQcEvent, isMutatingQcEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingQcEventsWithIndex` for callers that only need the decoded
 *  events, not their arena indices. */
export function mutatingQcEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): QcEvent[] {
  return mutatingQcEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

export interface QcApplyResult {
  /** `edges`/`removedEdges` — QC's own contribution, expressed as an add/remove patch rather than
   *  a full edge list (unlike every generation adapter's `ApplyResult.edges`, which is a
   *  ground-truth full list built from scratch each replay). QC operates on an *existing* graph a
   *  generation source already built, so `mergeDebugMazeView` (`debugSelectors.ts`) needs to know
   *  which edges QC added on top of generation's own list and which it removed from it — a plain
   *  `edges` list alone can't express "remove this edge", only "these edges exist". */
  edges: Edge[];
  removedEdges: { from: bigint; to: bigint }[];
  /** Maze node ids removed by `MutationCommand::RemoveNode` (GitHub issue #248's `remove_split`
   *  strategy) or replaced by `MutationCommand::ReplacePointNodes` (GitHub issue #247's
   *  `AddSplitStrategy` — its `old_nodes`, slot-0 included) up to this step — append-only, since a
   *  node once removed never reappears within QC's own event stream (unlike edges, which can be
   *  re-added). Lets `mergeDebugMazeView` exclude a removed/replaced node from the reconstructed
   *  node list, mirroring how `removedEdges` lets it retract an earlier source's edges. */
  removedNodes: bigint[];
  /** Node ids minted by `MutationCommand::ReplacePointNodes` (GitHub issue #247's
   *  `AddSplitStrategy`) up to this step — append-only, mirrors `removedNodes`. Lets
   *  `mergeDebugMazeView` include a freshly minted split-tile node in the reconstructed node list,
   *  the same way `VertexBasedApplyResult.createdNodes` does for a generation-time split. */
  createdNodes: bigint[];
  start: bigint | null;
  finish: bigint | null;
  step: number;
  nodeIndex: number;
}

/** Replays QC's own mutating events, starting the underlying node-table scan at `startNodeIndex`
 *  (the QC top-level source scope's own arena index — see `topLevelSourceScopes`/
 *  `sourceScopeForNode` in `tree.ts`) rather than index 0: QC is always merged as a source *after*
 *  generation (Contract A, `Specs/event_log.md`'s #147 section), so its own mutating events never
 *  start at the beginning of the merged tape. `targetStep` is relative to QC's own mutating-event
 *  stream (0-based, independent of however many generation steps preceded it) — the caller
 *  (`selectDebugMazeView`) is responsible for subtracting generation's own step count first.
 *
 *  Processes events **in order**, folding each add/remove into a running `Edge` accumulator keyed
 *  by `from:to` (not two independent append-only lists) — QC's own repair loop can plausibly add
 *  an edge in one iteration and remove that same edge in a later one within the same
 *  `[0, targetStep]` window (e.g. one strategy adds a shortcut, a later check flags it invalid,
 *  another strategy removes it); folding in order means a later remove correctly cancels an
 *  earlier add from *this same contribution*, and a later re-add correctly overrides an earlier
 *  remove, before this result is ever handed to `mergeDebugMazeView`. Only the *net* additions and
 *  removals relative to `[0, targetStep]`'s starting point (nothing from this source yet) are
 *  reported — `removedEdges` therefore only ever needs to reach into an *earlier* source's
 *  contribution (e.g. generation's own edge list), never cancel this same call's own `edges`.
 *
 *  `EdgeRemoved`/`EdgeRemovedWithReverse`/`TeleportRemovedWithReverse`/`VerticalPassageRemovedWithReverse`
 *  carry the removed edge's `(from, to)` (GitHub issue
 *  #171's follow-up fix — resolved on the Rust side from the graph immediately before removal,
 *  since the wire's own `EdgeId` alone is meaningless off-graph) and participate in the keyed
 *  accumulator exactly like `EdgeRemovedBetween`. */
export function applyQc(tape: ParsedTape, targetStep: number, from?: QcApplyResult, startNodeIndex = 0): QcApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyQc: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], removedEdges: [...from.removedEdges], removedNodes: [...from.removedNodes], createdNodes: [...from.createdNodes], start: from.start, finish: from.finish, step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startNodeIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingQcEventsWithIndex(tape, needed, scanStart);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  // Keyed by `from:to`, in event order — `net.set(key, edge)` on add, `net.delete(key)` on
  // remove, so a later event always overrides an earlier one for the same pair, regardless of
  // whether it's add-then-remove or remove-then-(re-)add. Seeded from `from`'s own net state when
  // resuming — `from.edges`/`from.removedEdges` are already the flattened `[0, from.step]` result,
  // so re-keying them back into `net`/`removedFromEarlierSources` reproduces the same accumulator
  // a from-scratch replay up to `from.step` would have built.
  const net = new Map<string, Edge>(from ? from.edges.map((e) => [`${e.from}:${e.to}`, e]) : undefined);
  const removedFromEarlierSources = new Set<string>(from ? from.removedEdges.map((e) => `${e.from}:${e.to}`) : undefined);
  const removedNodes = new Set<bigint>(from?.removedNodes);
  const createdNodes = new Set<bigint>(from?.createdNodes);
  let start: bigint | null = from?.start ?? null;
  let finish: bigint | null = from?.finish ?? null;

  const add = (from: bigint, to: bigint, kind: "basic" | "teleport" | "vertical_passage" | "elevator") => {
    const key = `${from}:${to}`;
    net.set(key, { from, to, kind });
    removedFromEarlierSources.delete(key);
  };
  const remove = (from: bigint, to: bigint) => {
    const key = `${from}:${to}`;
    if (net.has(key)) {
      net.delete(key);
    } else {
      removedFromEarlierSources.add(key);
    }
  };

  for (const { event } of events) {
    switch (event.kind) {
      case "DirectedEdgeAdded":
        add(event.from, event.to, "basic");
        break;
      case "BidirectionalEdgeAdded":
        add(event.a, event.b, "basic");
        add(event.b, event.a, "basic");
        break;
      case "DirectedTeleportAdded":
        add(event.from, event.to, "teleport");
        break;
      case "BidirectionalTeleportAdded":
        add(event.a, event.b, "teleport");
        add(event.b, event.a, "teleport");
        break;
      case "DirectedVerticalPassageAdded":
        add(event.from, event.to, "vertical_passage");
        break;
      case "BidirectionalVerticalPassageAdded":
        add(event.a, event.b, "vertical_passage");
        add(event.b, event.a, "vertical_passage");
        break;
      case "BidirectionalElevatorAdded":
        add(event.a, event.b, "elevator");
        add(event.b, event.a, "elevator");
        break;
      case "EdgeRemovedBetween":
      case "EdgeRemoved":
        remove(event.from, event.to);
        break;
      case "EdgeRemovedWithReverse":
      case "TeleportRemovedWithReverse":
      case "VerticalPassageRemovedWithReverse":
        // Carries only the primary direction's `(from, to)` (GitHub issue #171's "primary id
        // only" convention) — the reverse direction is always the same node pair swapped, so
        // it's cleared from the accumulator too, but ONLY when `reverseRemoved` (GitHub issue
        // #185's follow-up fix) confirms the reverse leg genuinely existed and was actually
        // removed on the Rust side. Without gating on this flag, a one-way edge/teleport that
        // degenerates this command to a single-direction removal would still unconditionally
        // clear `(to, from)` here, fabricating a phantom removed-edge entry for a direction that
        // was never real.
        remove(event.from, event.to);
        if (event.reverseRemoved) remove(event.to, event.from);
        break;
      case "StartSet":
        start = event.id;
        break;
      case "FinishSet":
        finish = event.id;
        break;
      case "NodeRemoved":
        removedNodes.add(event.id);
        break;
      case "PointNodesReplaced":
        // `net` here only ever holds edges QC itself added/removed on top of generation's own
        // list — an old node's *generation-time* edges never entered `net` at all, so there's
        // nothing meaningful to purge from it here. `removedNodes.add(old)` is what actually
        // keeps a replaced node's edges from leaking into the final view — `mergeDebugMazeView`
        // (`debugSelectors.ts`) filters `edges` against the accumulated `removedNodes`/
        // `removedSoFar` set once, after every source's contribution (including generation's) is
        // merged, which is the only point that can see both an old node's full edge set and its
        // removal together.
        for (const old of event.oldNodes) {
          removedNodes.add(old);
        }
        for (let i = 0; i < event.newNodes.length; i++) {
          const node = event.newNodes[i];
          createdNodes.add(node);
          for (const edge of event.nodes[i]) {
            if (edge.direction === "Forward") add(node, edge.target, "basic");
            else if (edge.direction === "Backward") add(edge.target, node, "basic");
            else { add(node, edge.target, "basic"); add(edge.target, node, "basic"); }
          }
        }
        break;
      default:
        break;
    }
  }

  const edges = [...net.values()];
  const removedEdges = [...removedFromEarlierSources].map((key) => {
    const [from, to] = key.split(":");
    return { from: BigInt(from), to: BigInt(to) };
  });

  return { edges, removedEdges, removedNodes: [...removedNodes], createdNodes: [...createdNodes], start, finish, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
