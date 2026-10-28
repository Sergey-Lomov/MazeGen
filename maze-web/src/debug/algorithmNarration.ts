import { type PresetSetupEvent, type RecursiveBacktrackerEvent, type KruskalEvent, type WilsonEvent, type VertexBasedEvent, type QcEvent, type IssuePayload, kruskalMergedRoot } from "./eventTape";
import { resolveCheckLabel, resolveStrategyLabel } from "../components/features/qualityI18n";
import { resolveIssueSourceLabel } from "../components/issueRegistry";
import { resolveIssueHighlight, type NormalizedIssuePayload } from "../components/issueHighlight";
import { cellTypeLabel, generatedElementLabel } from "../i18n/cellTypeLabel";
import * as m from "~/paraglide/messages";
import type { Token, ScopeTitleLookup } from "./algorithmRegistry";

/** Formats a roll/param `f64` for narration display, rounded to 2 decimal places for
 *  readability — the exact value is still available in the underlying wire data for any
 *  consumer that needs it (per explicit user decision, narration itself only needs 2 digits). */
export function fmt(value: number): string {
  return value.toFixed(2);
}

/** Wraps a resolved rule/stage title (or the raw id, when `titleLookup` is absent or doesn't
 *  recognize it — see `ScopeTitleLookup`'s doc comment) in `"…"` quotes, so it reads as a distinct
 *  name rather than running into the surrounding narration text with no separator (e.g. "Rule
 *  Waypoints: issue found" reads as "Rule Waypoints" being one phrase; "Rule "Waypoints": issue
 *  found" doesn't). Applied uniformly everywhere a title is interpolated — scope labels and
 *  narration text alike — so quoting is never a per-template decision. */
export function quoted(title: string): string {
  return `"${title}"`;
}

/** Resolves a check instance id's display label via `titleLookup.checkTypeId` (GitHub issue
 *  #171) then `resolveCheckLabel` — falls back to the raw instance id when `titleLookup` is
 *  absent or the instance isn't found in the live store config (same fallback shape every other
 *  `titleLookup`-driven resolution in this module uses). Returns the label unquoted — callers wrap
 *  it in `quoted()` themselves, same as every other `rule`/`stage`/`strategy` resolver in this
 *  module, so quoting stays a call-site decision rather than baked into the resolver. */
export function checkLabelFor(checkId: string, titleLookup?: ScopeTitleLookup): string {
  const typeId = titleLookup?.checkTypeId(checkId);
  return typeId !== undefined ? resolveCheckLabel(typeId, checkId) : checkId;
}

/** Preset setup's events (GitHub issue #225) — see `PresetSetupEvent`'s own doc comment for why
 *  this is a standalone, algorithm-agnostic source rather than an event duplicated into every
 *  instrumented algorithm's own event enum. One narration per connection kind, mirroring
 *  `build_preset_state`'s own three cases (`Wall` blocks a pair without adding anything, so it
 *  emits nothing here). */
export function narrationTokensForPresetSetup(event: PresetSetupEvent): Token[] {
  switch (event.kind) {
    case "PassageEstablished":
      return [{ kind: "text", text: m["debug.tree.passage_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "OneWayEstablished":
      return [{ kind: "text", text: m["debug.tree.one_way_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "TeleportEstablished":
      return [{ kind: "text", text: m["debug.tree.teleport_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.twoWay }];
    case "VerticalPassageEstablished":
      return [{ kind: "text", text: m["debug.tree.vertical_passage_established"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.twoWay }];
    case "ElevatorEstablished":
      return [{ kind: "text", text: m["debug.tree.elevator_established"]() + " " }, { kind: "region", nodes: event.nodes }];
  }
}

export function narrationTokensForRb(event: RecursiveBacktrackerEvent): Token[] {
  switch (event.kind) {
    case "VertexSelected": return [{ kind: "text", text: m["debug.tree.vertex_selected"]() + " " }, { kind: "node", id: event.id }];
    case "CandidatesComputed": return [{ kind: "text", text: m["debug.tree.candidates_computed"]({ count: event.ids.length }) }];
    case "DeadEnd": return [{ kind: "text", text: m["debug.tree.dead_end"]() }];
    case "CandidateChosen": return [{ kind: "text", text: m["debug.tree.candidate_chosen"]() + " " }, { kind: "node", id: event.id }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "VertexVisited": return [{ kind: "text", text: m["debug.tree.vertex_visited"]() + " " }, { kind: "node", id: event.id }];
    case "VertexPopped": return [{ kind: "text", text: m["debug.tree.vertex_popped"]() + " " }, { kind: "node", id: event.id }];
    case "VertexPushed": return [{ kind: "text", text: m["debug.tree.vertex_pushed"]() + " " }, { kind: "node", id: event.id }];
  }
}

/** Kruskal's counterpart to `narrationTokensForRb` (GitHub issue #146). Per explicit user
 *  feedback, narration must make the edge/root relationship explicit, and state the comparison's
 *  outcome in words rather than leaving the reader to infer it from which event follows. */
export function narrationTokensForKruskal(event: KruskalEvent): Token[] {
  switch (event.kind) {
    case "EdgesShuffled": return [{ kind: "text", text: m["debug.tree.edges_shuffled"]({ count: event.edges.length }) }];
    case "EdgeSelected":
      return [{ kind: "text", text: m["debug.tree.edge_selected"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "RootsCompared": {
      const rootsEqual = event.rootOfFrom === event.rootOfTo;
      return [
        { kind: "text", text: m["debug.tree.root_of"]() + " " }, { kind: "node", id: event.from },
        { kind: "text", text: " = " }, { kind: "node", id: event.rootOfFrom },
        { kind: "text", text: ", " + m["debug.tree.root_of"]() + " " }, { kind: "node", id: event.to },
        { kind: "text", text: " = " }, { kind: "node", id: event.rootOfTo },
        { kind: "text", text: ". " + (rootsEqual ? m["debug.tree.roots_equal"]() : m["debug.tree.roots_different"]()) },
      ];
    }
    case "EdgeRejected":
      return [{ kind: "text", text: m["debug.tree.edge_rejected"]() }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "SetsMerged": {
      const newRoot = kruskalMergedRoot(event.rootA, event.rootB);
      return [
        { kind: "text", text: m["debug.tree.sets_merged"]() + " " }, { kind: "node", id: event.rootA },
        { kind: "text", text: " / " }, { kind: "node", id: event.rootB },
        { kind: "text", text: ". " + m["debug.tree.new_root"]() + " " }, { kind: "node", id: newRoot },
      ];
    }
    case "PresetUnionsApplied":
      return [{ kind: "text", text: m["debug.tree.preset_unions_applied"]({ count: event.pairs.length }) }];
  }
}

/** Wilson's counterpart to `narrationTokensForRb`/`narrationTokensForKruskal` (GitHub issue
 *  #145). `"walk N"` scopes contain exactly two fixed, non-numbered nested scopes — `"search"`
 *  and `"commit"` — handled by `scopeLabel` below, not here. */
export function narrationTokensForWilson(event: WilsonEvent): Token[] {
  switch (event.kind) {
    case "StartVisited": return [{ kind: "text", text: m["debug.tree.start_visited"]() + " " }, { kind: "node", id: event.id }];
    case "WalkStartPicked": return [{ kind: "text", text: m["debug.tree.walk_start_picked"]() + " " }, { kind: "node", id: event.id }];
    case "StepTaken":
      return [{ kind: "text", text: m["debug.tree.step_taken"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "LoopErased": return [{ kind: "text", text: m["debug.tree.loop_erased"]() + " " }, { kind: "node", id: event.node }];
    case "WalkDeadEnd": return [{ kind: "text", text: m["debug.tree.walk_dead_end"]() }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: event.bidirectional }];
    case "NodeVisited": return [{ kind: "text", text: m["debug.tree.vertex_visited"]() + " " }, { kind: "node", id: event.id }];
  }
}

/** `CustomVertexBased`'s counterpart to `narrationTokensForRb`/`.../Kruskal`/`.../Wilson`
 *  (GitHub issue #143). Every `"step N"` scope is flat, mirroring
 *  Kruskal's shape, except when the frontier empties out mid-run: then a fixed,
 *  non-numbered `"reserve_search"` sub-scope opens (mirroring Wilson's fixed `"search"`/`"commit"`
 *  names) to hold the reserve-candidate scan's possibly-several rejected/chosen events — handled
 *  by `scopeLabel` below, not here. Roll/param values are rendered via `fmt` (2 decimals) directly
 *  in the narration text. */
export function narrationTokensForVertexBased(event: VertexBasedEvent): Token[] {
  switch (event.kind) {
    case "TeleportBridgeRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.teleport_bridge_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) })
          : m["debug.tree.teleport_bridge_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }),
      }];
    case "TeleportBridgeAdded":
      return [{ kind: "text", text: m["debug.tree.teleport_bridge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "ReserveCandidateRejected":
      return [{
        kind: "text",
        text: event.alreadyVisited ? m["debug.tree.reserve_candidate_rejected_visited"]() : m["debug.tree.reserve_candidate_rejected_unreachable"](),
      }, { kind: "node", id: event.node }];
    case "ReserveCandidateChosen":
      return [{ kind: "text", text: m["debug.tree.reserve_candidate_chosen"]() + " " }, { kind: "node", id: event.node }];
    case "ReserveExhausted":
      return [{ kind: "text", text: m["debug.tree.reserve_exhausted"]() }];
    case "BridgeAdded":
      return [{ kind: "text", text: m["debug.tree.bridge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "SrcChosenFromFrontier":
      return [
        // position is a 0-based array index on the wire (0 = oldest); +1 for a 1-based display,
        // so "position N of total" reads naturally (e.g. the newest/highest-priority entry shows
        // as "total of total", not "total-1 of total" looking like it wasn't the max).
        { kind: "text", text: m["debug.tree.src_chosen_from_frontier"]({ param: fmt(event.depthFirst), position: event.position + 1, total: event.frontierLen }) + " " },
        { kind: "node", id: event.src },
      ];
    case "TeleportRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.teleport_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) })
          : m["debug.tree.teleport_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }),
      }];
    case "CyclicRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.cyclic_rolled_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) })
          : m["debug.tree.cyclic_rolled_not_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) }),
      }];
    case "CyclicCandidatesComputed":
      return [{
        kind: "text",
        text: event.geometric
          ? m["debug.tree.cyclic_candidates_computed_geometric"]({ count: event.candidates.length })
          : m["debug.tree.cyclic_candidates_computed_teleport"]({ count: event.candidates.length }),
      }];
    case "CyclicEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.cyclic_edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "CorridorRolled":
      return [{
        kind: "text",
        text: event.isCorridor
          ? m["debug.tree.corridor_rolled_vertex_based_corridor"]({ param: fmt(event.corridorChance), roll: fmt(event.roll) })
          : m["debug.tree.corridor_rolled_vertex_based_junction"]({ param: fmt(event.corridorChance), roll: fmt(event.roll) }),
      }];
    case "SingleCandidateSkipsDirectionality":
      return [{ kind: "text", text: m["debug.tree.single_candidate_skips_directionality"]() }];
    case "NoParentSkipsDirectionality":
      return [{ kind: "text", text: m["debug.tree.no_parent_skips_directionality"]() }];
    case "DirectionalityRolled":
      return [{
        kind: "text",
        text: !event.fired
          ? m["debug.tree.directionality_rolled_not_fired"]({ param: fmt(event.directionality), roll: fmt(event.roll) })
          : event.straightFound
            ? m["debug.tree.directionality_rolled_fired_straight_found"]({ param: fmt(event.directionality), roll: fmt(event.roll) })
            : m["debug.tree.directionality_rolled_fired_no_straight"]({ param: fmt(event.directionality), roll: fmt(event.roll) }),
      }];
    case "CandidateChosen":
      return [{ kind: "text", text: m["debug.tree.candidate_chosen_vertex_based"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "JunctionRollSetup":
      return [{ kind: "text", text: m["debug.tree.junction_roll_setup"]({ max: event.max, mandatory: 2, optional: event.max - 2 }) }];
    case "JunctionSlotRolled":
      return [{
        kind: "text",
        text: event.taken
          ? m["debug.tree.junction_slot_rolled_taken"]({ param: fmt(event.branching), roll: fmt(event.roll) })
          : m["debug.tree.junction_slot_rolled_not_taken"]({ param: fmt(event.branching), roll: fmt(event.roll) }),
      }];
    case "JunctionCandidatesChosen":
      return [{ kind: "text", text: m["debug.tree.junction_candidates_chosen"]({ count: event.candidates.length }) + " " }, { kind: "region", nodes: event.candidates }];
    case "EdgeAdded":
      return [{ kind: "text", text: m["debug.tree.edge_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "PresetNeighborVisited":
      return [{ kind: "text", text: m["debug.tree.preset_skipped"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: false }];
    case "TeleportConnectAdded":
      return [{ kind: "text", text: m["debug.tree.teleport_connect_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: event.bidirectional }];
    case "NodeVisited":
      return [{ kind: "text", text: m["debug.tree.node_added_to_visited_and_frontier"]() + " " }, { kind: "node", id: event.node }];
    case "NodeQueuedToReserve":
      return [{ kind: "text", text: m["debug.tree.node_queued_to_reserve"]() + " " }, { kind: "node", id: event.node }];
    case "StartVisited":
      return [{ kind: "text", text: m["debug.tree.start_added_to_visited_and_frontier"]() + " " }, { kind: "node", id: event.node }];
    case "SplitRolled":
      return [{
        kind: "text",
        text: !event.fired
          ? m["debug.tree.split_rolled_not_fired"]({ param: fmt(event.splitChance), roll: fmt(event.roll) })
          : event.eligible
            ? m["debug.tree.split_rolled_fired_eligible"]({ param: fmt(event.splitChance), roll: fmt(event.roll) })
            : m["debug.tree.split_rolled_fired_ineligible"]({ param: fmt(event.splitChance), roll: fmt(event.roll) }),
      }];
    case "SplitNodesCreated":
      return [{
        kind: "text",
        text: event.pattern !== null
          ? m["debug.tree.split_nodes_created_pattern"]({ count: event.nodes.length, pattern: event.pattern })
          : m["debug.tree.split_nodes_created_non_pattern"]({ count: event.nodes.length }),
      }, { kind: "region", nodes: event.nodes }];
    case "SplitCyclicRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.split_cyclic_rolled_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) })
          : m["debug.tree.split_cyclic_rolled_not_fired"]({ param: fmt(event.cyclicity), roll: fmt(event.roll) }),
      }];
    case "PatternAdaptationsComputed":
      return [{ kind: "text", text: m["debug.tree.pattern_adaptations_computed"]({ pattern: event.pattern, count: event.count }) }];
    case "PatternAdaptationChosen":
      return [{ kind: "text", text: m["debug.tree.pattern_adaptation_chosen"]({ pattern: event.pattern, transform: event.transform }) }];
    case "SplitTeleportRolled":
      return event.fired && event.anchor !== null
        ? [{ kind: "text", text: m["debug.tree.split_teleport_rolled_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }) + " " }, { kind: "node", id: event.anchor }]
        : [{ kind: "text", text: m["debug.tree.split_teleport_rolled_not_fired"]({ param: fmt(event.teleportChance), roll: fmt(event.roll) }) }];
    case "SplitStartReassigned":
      return [{ kind: "text", text: m["debug.tree.split_start_reassigned"]() + " " }, { kind: "node", id: event.reassignedTo }];
    case "SplitParentEdgeRelocated":
      return [{ kind: "text", text: m["debug.tree.split_parent_edge_relocated"]() + " " }, { kind: "edge", from: event.parent, to: event.takenBy, bidirectional: false }];
    case "VerticalRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.vertical_rolled_fired"]({ param: fmt(event.verticalChance), roll: fmt(event.roll) })
          : m["debug.tree.vertical_rolled_not_fired"]({ param: fmt(event.verticalChance), roll: fmt(event.roll) }),
      }];
    case "VerticalBalanceRolled":
      return [{
        kind: "text",
        text: event.isElevator
          ? m["debug.tree.vertical_balance_rolled_elevator"]({ param: fmt(event.balance), roll: fmt(event.roll) })
          : m["debug.tree.vertical_balance_rolled_passage"]({ param: fmt(event.balance), roll: fmt(event.roll) }),
      }];
    case "VerticalPassageOneWayRolled":
      return [{
        kind: "text",
        text: event.fired
          ? m["debug.tree.vertical_passage_one_way_rolled_fired"]({ param: fmt(event.oneWayChance), roll: fmt(event.roll) })
          : m["debug.tree.vertical_passage_one_way_rolled_not_fired"]({ param: fmt(event.oneWayChance), roll: fmt(event.roll) }),
      }];
    case "VerticalPassageDirectionRolled":
      return [{
        kind: "text",
        text: event.upward
          ? m["debug.tree.vertical_passage_direction_rolled_upward"]({ param: fmt(event.balance), roll: fmt(event.roll) })
          : m["debug.tree.vertical_passage_direction_rolled_downward"]({ param: fmt(event.balance), roll: fmt(event.roll) }),
      }];
    case "VerticalPassageAdded":
      return [{ kind: "text", text: m["debug.tree.vertical_passage_added"]() + " " }, { kind: "edge", from: event.src, to: event.dst, bidirectional: !event.oneWay }];
    case "VerticalPassageFailed":
      return [{
        kind: "text",
        text: event.elevatorFallbackAllowed
          ? m["debug.tree.vertical_passage_failed_fallback_allowed"]()
          : m["debug.tree.vertical_passage_failed_fallback_not_allowed"](),
      }];
    case "ElevatorSlotsComputed":
      return [{
        kind: "text",
        text: m["debug.tree.elevator_slots_computed"]({
          unvisitedPoolSize: event.unvisitedPoolSize,
          hasCyclicVisited: event.hasCyclicVisited ? "yes" : "no",
          maxSlots: event.maxSlots,
          spanMin: event.spanMin,
        }),
      }];
    case "ElevatorSlotsFailed":
      return [{
        kind: "text",
        text: event.fallbackAllowed
          ? m["debug.tree.elevator_slots_failed_fallback_allowed"]()
          : m["debug.tree.elevator_slots_failed_fallback_not_allowed"](),
      }];
    case "ElevatorFloorCountChosen":
      return [{ kind: "text", text: m["debug.tree.elevator_floor_count_chosen"]({ floorCount: event.floorCount }) }];
    case "ElevatorAdded":
      return [{ kind: "text", text: m["debug.tree.elevator_added"]({ edgesAdded: event.edgesAdded }) + " " }, { kind: "region", nodes: event.nodes }];
    case "CrossFloorTeleportRolled":
      return [{
        kind: "text",
        text: event.otherFloorPreferred
          ? m["debug.tree.cross_floor_teleport_rolled_other"]({ param: fmt(event.balance), roll: fmt(event.roll) })
          : m["debug.tree.cross_floor_teleport_rolled_same"]({ param: fmt(event.balance), roll: fmt(event.roll) }),
      }];
    case "ElementRollSkipped":
      return [
        {
          kind: "text",
          text: m["debug.tree.element_roll_skipped"]({
            element: generatedElementLabel(event.element).toLocaleLowerCase(),
            cellType: cellTypeLabel(event.cellType).toLocaleLowerCase(),
          }) + " ",
        },
        { kind: "node", id: event.src },
      ];
  }
}

/** QC's counterpart to `narrationTokensForRb`/etc. (GitHub issue #147). `issueKind` is a plain
 *  wire string (not localized) — a stable core identifier; the `issue` token narrates it via
 *  `resolveIssue` (see `issueHighlightTarget`'s call site) rather than showing it raw, mirroring
 *  how `checkId` below is resolved rather than shown as its wire string. `ruleId` is resolved
 *  through `titleLookup` to its current user-facing title first (same resolution `scopeLabel`
 *  applies to a `"rule <id>"` scope's own label — see that doc comment for why this is resolved
 *  live rather than sent across the wire), falling back to the raw id when `titleLookup` is absent
 *  or doesn't recognize it. `checkId` is a check *instance* id (GitHub issue #171, matches
 *  `IssueDto.source_checks`' own keys) — resolved to its type id via `titleLookup.checkTypeId`
 *  then to a display label via `resolveCheckLabel` (`checkLabelFor`, above), mirroring how
 *  `IssuesBlock` resolves the same instance id through `IssueDto.source_check_types`. There is no
 *  dedicated "dispatch result" event/narration line — a rule's applied/proposed outcome is instead
 *  read off the `"apply requests"` scope's own label (see `QC_ADAPTER.scopeLabel`'s doc comment),
 *  mirroring `CustomVertexBased`'s `"junction_count"` scope label precedent. */
export function narrationTokensForQc(event: QcEvent, titleLookup?: ScopeTitleLookup): Token[] {
  switch (event.kind) {
    case "IterationStarted":
      return [{ kind: "text", text: m["debug.tree.qc.iteration_started"]({ iteration: event.iteration + 1 }) }];
    case "CheckRan": {
      const checkLabel = quoted(checkLabelFor(event.checkId, titleLookup));
      return event.issue
        ? [
            { kind: "text", text: m["debug.tree.qc.check_ran_found"]({ checkId: checkLabel }) + " " },
            {
              kind: "issue", issueKind: event.issue.issueKind,
              target: issueHighlightTarget(event.issue.payload),
              reasons: issueReasons(event.issue.issueKind, [{ checkId: event.checkId, details: event.issue.details }], titleLookup),
            },
          ]
        : [{ kind: "text", text: m["debug.tree.qc.check_ran_clean"]({ checkId: checkLabel }) }];
    }
    case "IssuesMerged":
      return [
        { kind: "text", text: m["debug.tree.qc.issues_merged"]() + " " },
        {
          kind: "issue", issueKind: event.issueKind,
          target: issueHighlightTarget(event.payload),
          reasons: issueReasons(
            event.issueKind,
            [...event.details].map(([checkId, details]) => ({ checkId, details })),
            titleLookup,
          ),
        },
      ];
    case "IterationLimitReached":
      return [{
        kind: "text",
        text: event.limit === "MaxIterations"
          ? m["debug.tree.qc.iteration_limit_reached_max_iterations"]()
          : m["debug.tree.qc.iteration_limit_reached_time_budget"](),
      }];
    case "DirectedEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportAdded":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedVerticalPassageAdded":
      return [{ kind: "text", text: m["debug.tree.qc.directed_vertical_passage_added"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalVerticalPassageAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_vertical_passage_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "BidirectionalElevatorAdded":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_elevator_added"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoved":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemovedBetween":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed_between"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.edge_removed_with_reverse"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_removed_with_reverse"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "VerticalPassageRemovedWithReverse":
      return [{ kind: "text", text: m["debug.tree.qc.vertical_passage_removed_with_reverse"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "StartSet":
      return [{ kind: "text", text: m["debug.tree.qc.start_set"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSet":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set"]() + " " }, { kind: "node", id: event.id }];
    case "DirectedEdgeDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedVerticalPassageDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.directed_vertical_passage_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalVerticalPassageDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_vertical_passage_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "BidirectionalElevatorDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_elevator_declined"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoveDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveBetweenDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_between_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_with_reverse_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_remove_with_reverse_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "VerticalPassageRemoveWithReverseDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.vertical_passage_remove_with_reverse_declined"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "StartSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.start_set_declined"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSetDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set_declined"]() + " " }, { kind: "node", id: event.id }];
    case "DirectedEdgeProposed":
      return [{ kind: "text", text: m["debug.tree.qc.directed_edge_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalEdgeProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_edge_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedTeleportProposed":
      return [{ kind: "text", text: m["debug.tree.qc.directed_teleport_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalTeleportProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_teleport_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "DirectedVerticalPassageProposed":
      return [{ kind: "text", text: m["debug.tree.qc.directed_vertical_passage_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "BidirectionalVerticalPassageProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_vertical_passage_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "BidirectionalElevatorProposed":
      return [{ kind: "text", text: m["debug.tree.qc.bidirectional_elevator_proposed"]() + " " }, { kind: "edge", from: event.a, to: event.b, bidirectional: true }];
    case "EdgeRemoveProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveBetweenProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_between_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: false }];
    case "EdgeRemoveWithReverseProposed":
      return [{ kind: "text", text: m["debug.tree.qc.edge_remove_with_reverse_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "TeleportRemoveWithReverseProposed":
      return [{ kind: "text", text: m["debug.tree.qc.teleport_remove_with_reverse_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "VerticalPassageRemoveWithReverseProposed":
      return [{ kind: "text", text: m["debug.tree.qc.vertical_passage_remove_with_reverse_proposed"]() + " " }, { kind: "edge", from: event.from, to: event.to, bidirectional: true }];
    case "StartSetProposed":
      return [{ kind: "text", text: m["debug.tree.qc.start_set_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "FinishSetProposed":
      return [{ kind: "text", text: m["debug.tree.qc.finish_set_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoved":
      return [{ kind: "text", text: m["debug.tree.qc.node_removed"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoveDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.node_remove_declined"]() + " " }, { kind: "node", id: event.id }];
    case "NodeRemoveProposed":
      return [{ kind: "text", text: m["debug.tree.qc.node_remove_proposed"]() + " " }, { kind: "node", id: event.id }];
    case "StrategyFailed":
      return [{ kind: "text", text: m["debug.tree.qc.strategy_failed"]({ strategyId: quoted(resolveStrategyLabel(event.strategyId)) }) }];
    case "PointNodesReplaced":
      return [{ kind: "text", text: m["debug.tree.qc.point_nodes_replaced"]({ count: event.newNodes.length }) + " " }, { kind: "node", id: event.at }];
    case "PointNodesReplaceDeclined":
      return [{ kind: "text", text: m["debug.tree.qc.point_nodes_replace_declined"]() + " " }, { kind: "node", id: event.at }];
    case "PointNodesReplaceProposed":
      return [{ kind: "text", text: m["debug.tree.qc.point_nodes_replace_proposed"]({ count: event.nodes.length }) + " " }, { kind: "node", id: event.at }];
  }
}

export function numberedScopeIndex(scopeName: string): number {
  const match = STEP_SCOPE_RE.exec(scopeName);
  return match ? Number(match[1]) : 0;
}

export const STEP_SCOPE_RE = /^(?:step|edge|walk) (\d+)$/;

export const QC_STAGE_SCOPE_RE = /^stage (.+)$/;

export const QC_ITERATION_SCOPE_RE = /^iteration (\d+)$/;

export const QC_RULE_SCOPE_RE = /^rule (.+)$/;

export const QC_STRATEGY_SCOPE_RE = /^strategy (.+)$/;

/** Structural highlight data an `issue` token carries, when the underlying `IssuePayload` (see
 *  `eventTape.ts`) resolved to one — both fields `null` for the majority of issue kinds with no
 *  structural edge/node data (mirrors `IssuePayload::None`). `cycle`/`region` are independent, not
 *  mutually exclusive (mirrors Analytics' own two independent store fields,
 *  `hoveredIssueLoopEdges`/`hoveredIssueRegionGroups` in `postEditFullTypes.ts`) -- an
 *  `InvalidCrossElementGroup` pair mixing a one-way member (wall) with a split/region member needs
 *  both drawn at once, same as `IssueBubble`'s own `highlightEdges`/`highlightRegionGroups` split.
 *  `region`'s `groups` carries one group of node ids per flagged element (tile/region/passage/etc)
 *  rather than one flat node list — two different flagged elements must never merge into one
 *  contour just because they're both part of the same issue token, even when they happen to sit
 *  right next to each other (e.g. a `*_group_graph_proximity`/`*_group_geometric_proximity` pair
 *  flagging two distinct, adjacent elements as too close: GitHub issue #619) -- except split tiles,
 *  which always merge with each other regardless of source. `isSplit` picks the outward "split"
 *  inset instead of the normal inward one, set explicitly per group rather than guessed from its
 *  geometry (same rationale as Analytics'). */
export interface IssueHighlightTarget {
  cycle: { edges: [bigint, bigint][]; asWall: boolean } | null;
  region: { groups: { nodes: bigint[]; isSplit: boolean }[] } | null;
}

/** Flattens an `IssuePayload` (per-source-check-keyed) into `resolveIssueHighlight`'s normalized
 *  input shape — used for the debug tree's own issue bubble, which (unlike Analytics'
 *  `IssueBubble`) has no per-check bubble breakdown to key into: `CheckRan`/`IssuesMerged` narrate
 *  one issue per event, so every contributing check's own cycles/regions are shown together
 *  (`[...map.values()].flat()`, no per-check narrowing). */
export function normalizeIssuePayload(payload: IssuePayload): NormalizedIssuePayload<bigint> {
  switch (payload.kind) {
    case "None":
      return { kind: "none" };
    case "InvalidLoop":
      return { kind: "invalidLoop", groups: [...payload.edges.values()].flat().map(normalizeEdgeGroup) };
    case "RegionNeedsExpansion":
      return { kind: "regionNeedsExpansion", groups: [...payload.nodes.values()].flat().map(normalizeRegionGroup) };
    case "RegionNeedsShrink":
      return { kind: "regionNeedsShrink", groups: [...payload.nodes.values()].flat().map(normalizeRegionGroup) };
    case "InvalidTeleport":
      return { kind: "invalidTeleport", groups: [...payload.groups.values()].flat().map(normalizeEdgeGroup) };
    case "InvalidOneWay":
      return { kind: "invalidOneWay", groups: [...payload.groups.values()].flat().map(normalizeEdgeGroup) };
    case "InvalidSplitTile":
      return { kind: "invalidSplitTile", groups: [...payload.groups.values()].flat().map(normalizeSplitGroup) };
    case "InvalidSplitRoute":
      return { kind: "invalidSplitRoute", edges: [...payload.routes.values()].flat(2).map(([from, to]) => [from, to] as [bigint, bigint]) };
    case "ExcessiveSccCount":
      return { kind: "excessiveSccCount" };
    case "InvalidVerticalPassage":
      return { kind: "invalidVerticalPassage", groups: [...payload.groups.values()].flat().map(normalizeEdgeGroup) };
    case "InvalidElevator":
      return { kind: "invalidElevator", groups: [...payload.groups.values()].flat().map(normalizeEdgeGroup) };
    case "InvalidElevatorStop":
      return { kind: "invalidElevatorStop", groups: [...payload.nodes.values()].flat().map(normalizeRegionGroup) };
    case "InvalidDeadEnd":
      return { kind: "invalidDeadEnd", groups: [...payload.nodes.values()].flat().map(normalizeRegionGroup) };
    case "AreaDeficit":
      return { kind: "areaDeficit" };
    case "MissingElevatorStopCount":
      // `available` candidate floor nodes are intentionally dropped here — only the elevator's real
      // fan edges participate in the highlight (GitHub issue #402).
      return { kind: "missingElevatorStopCount", groups: [...payload.groups.values()].flat().map((g) => ({ edges: g.edges })) };
    case "IndeterminateDistance":
      return { kind: "indeterminateDistance", pairs: payload.pairs.map((p) => p.nodes) };
    case "InvalidCrossElementGroup":
      return {
        kind: "invalidCrossElementGroup",
        entries: [...payload.groups.values()].flat(2).map((entry) => ({
          kind: entry.kind,
          edges: entry.edges,
          nodes: entry.nodes,
          tile: entry.tile != null ? { nodes: entry.tile.nodes } : null,
        })),
      };
  }
}

export function normalizeEdgeGroup(group: { edges: [bigint, bigint][] }) {
  return { edges: group.edges };
}

export function normalizeRegionGroup(group: { region: bigint[] }) {
  return { nodes: group.region };
}

export function normalizeSplitGroup(group: { tiles: { nodes: bigint[] }[] }) {
  return { tiles: group.tiles.map((t) => ({ nodes: t.nodes })) };
}

/** Resolves an `IssuePayload` into the debug tree's own `IssueHighlightTarget` shape — `null` when
 *  `resolveIssueHighlight` finds no structural highlight data at all (mirrors the old function's
 *  own "no highlight" `null` return, since `IssueHighlightTarget`'s fields are only ever both
 *  populated or one-of-populated, never a meaningful all-`null` object). */
export function issueHighlightTarget(payload: IssuePayload): IssueHighlightTarget | null {
  const { cycle, region } = resolveIssueHighlight(normalizeIssuePayload(payload));
  return cycle != null || region != null ? { cycle, region } : null;
}

/** Resolves one contributing check's own "reason" text for an `issue` token's modal (GitHub issue
 *  #171) — `resolveIssueSourceLabel` (`issueRegistry.ts`, the same function `IssueBubble` calls)
 *  keyed by the check's *type* id (resolved from its instance id via `titleLookup.checkTypeId`,
 *  same as `checkLabelFor`), falling back to the issue kind's generic label when the instance
 *  can't be resolved (e.g. the check was removed after this tape was generated) — there's no
 *  type id to pick a `DETAIL_LABELS` formatter with in that case. */
export function issueReasonFor(issueKind: string, checkId: string, details: Map<string, string>, titleLookup?: ScopeTitleLookup): string {
  const typeId = titleLookup?.checkTypeId(checkId);
  if (typeId === undefined) return resolveIssueSourceLabel(issueKind, checkId, undefined);
  return resolveIssueSourceLabel(issueKind, typeId, Object.fromEntries(details));
}

/** Builds an `issue` token's `reasons` list from one or more `(checkId, details)` contributions —
 *  `CheckRan` always passes exactly one (this event narrates a single check), `IssuesMerged` one
 *  per contributing check (GitHub issue #171, mirrors `IssuesBlock` rendering one bubble per
 *  `source_checks` entry for a merged `IssueDto`). Deduplicates identical resolved strings — two
 *  checks of the same type with the same params/details would otherwise repeat the same reason
 *  twice for no informational gain. */
export function issueReasons(
  issueKind: string,
  contributions: { checkId: string; details: Map<string, string> }[],
  titleLookup?: ScopeTitleLookup,
): string[] {
  const resolved = contributions.map(({ checkId, details }) => issueReasonFor(issueKind, checkId, details, titleLookup));
  return [...new Set(resolved)];
}
