use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::generation::PresetState;
use crate::repair::{RepairStrategy, RepairResult, NestedStrategyConfig, MutationCommand, params::{build_params, StrategyParams}};
use crate::event_log::ScopeGuard;
use super::check::Check;
use super::event::QcEvent;
use super::issue::{Issue, IssueRequirement, IssueMerge};

/// How many of a strategy's proposed `MutationCommand`s actually applied — see GitHub issue #118,
/// `Specs/repair.md`. Carried on `RuleIterationOutcome::Repaired` back to the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyOutcome {
    pub proposed: usize,
    pub applied: usize,
}

/// Applies `commands` to the real `maze`, revalidating each one right before it's applied and
/// silently dropping it (not an error, doesn't change the caller's `RepairResult`) if it no longer
/// holds — see `Specs/repair.md`'s "Where commands are applied and revalidated". Contains no
/// feasibility logic of its own: every arm calls the same `try_*` helper `generation::mod`'s
/// `cmd_*` builders already use internally, so construction-time and apply-time feasibility can
/// never disagree (see `MutationCommand`'s own doc comment).
///
/// `pub` (not `pub(crate)`) so integration tests (`maze-core/tests/*.rs`, a separate crate) can
/// exercise the same apply-then-commit sequencing `Rule::check_and_repair_typed` uses internally.
///
/// `event_log` (GitHub issue #147) emits one `QcEvent` per command, in the same order commands are
/// applied — the mutating mirror variant when `ok == true`, the matching `*Declined` trace variant
/// (same fields) when `ok == false`. Emitted here, not by the caller, because this function is the
/// only place that knows both the command's real fields (already at hand from the `match`) and its
/// actual revalidation outcome — a caller re-deriving that from `ApplyOutcome`'s aggregate counts
/// couldn't tell *which* command in the batch was declined.
pub fn apply_commands<T: Tessellation>(
    maze: &mut Maze<T>,
    preset_state: &PresetState,
    commands: Vec<MutationCommand>,
    mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
) -> ApplyOutcome {
    let proposed = commands.len();
    let mut applied = 0;
    for cmd in commands {
        // `RemoveEdge`/`RemoveEdgeWithReverse`/`RemoveTeleportWithReverse` carry only an opaque
        // `EdgeId` — meaningless to web-side debug narration on its own (GitHub issue #171's
        // follow-up fix: `bubbleLabel` used to mis-render it as a `NodeId`, crashing once the id
        // exceeded the maze's own node count). Resolved to `(from, to)` here, *before* the edge is
        // actually removed below — `graph.edge(id)` returns `None` once removed, so this must
        // happen ahead of the `match`.
        let edge_endpoints = match &cmd {
            MutationCommand::RemoveEdge { id }
            | MutationCommand::RemoveEdgeWithReverse { id }
            | MutationCommand::RemoveTeleportWithReverse { id }
            | MutationCommand::RemoveVerticalPassageWithReverse { id } =>
                maze.graph.edge(*id).map(|e| (e.from, e.to)),
            _ => None,
        };
        // `ReplacePointNodes`'s `old_nodes` (every node currently at `at`'s point) must be resolved
        // before the mutation runs, same "resolve while it's still live" reasoning as
        // `edge_endpoints` above — `field.point_of`/`nodes_at` no longer return the old nodes once
        // `try_replace_point_nodes` has replaced them.
        let old_point_nodes = match &cmd {
            MutationCommand::ReplacePointNodes { at, .. } =>
                maze.field.level_of(*at).zip(maze.field.point_of(*at))
                    .map(|(level, point)| maze.field.nodes_at(level, point).to_vec()),
            _ => None,
        };
        // `reverse_removed` is only meaningful for `RemoveEdgeWithReverse`/
        // `RemoveTeleportWithReverse` (see those two `QcEvent` variants' own doc comments) — both
        // return every `EdgeId` actually removed (one or two), so `len() > 1` means the reverse
        // leg was genuinely there and got removed too, not just assumed from the command shape.
        let mut reverse_removed = false;
        let mut replaced_nodes: Option<Vec<NodeId>> = None;
        let ok = match cmd {
            MutationCommand::AddDirectedEdge { from, to } =>
                crate::generation::try_add_directed_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalEdge { a, b } =>
                crate::generation::try_add_bidirectional_edge(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddDirectedTeleport { from, to } =>
                crate::generation::try_add_directed_teleport(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalTeleport { a, b } =>
                crate::generation::try_add_bidirectional_teleport(&mut maze.graph, a, b, preset_state),
            MutationCommand::AddDirectedVerticalPassage { from, to } =>
                crate::generation::try_add_directed_vertical_passage(&mut maze.graph, from, to, preset_state),
            MutationCommand::AddBidirectionalVerticalPassage { a, b } =>
                crate::generation::try_add_bidirectional_vertical_passage(&mut maze.graph, a, b, preset_state),
            MutationCommand::RemoveEdge { id } =>
                crate::generation::try_remove_edge_by_id(&mut maze.graph, id, preset_state),
            MutationCommand::RemoveEdgeBetween { from, to } =>
                crate::generation::try_remove_edge(&mut maze.graph, from, to, preset_state),
            MutationCommand::RemoveEdgeWithReverse { id } => {
                let removed = crate::generation::try_remove_edge_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::RemoveTeleportWithReverse { id } => {
                let removed = crate::generation::try_remove_teleport_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::RemoveVerticalPassageWithReverse { id } => {
                let removed = crate::generation::try_remove_vertical_passage_with_reverse(&mut maze.graph, id, preset_state);
                reverse_removed = removed.len() > 1;
                !removed.is_empty()
            }
            MutationCommand::SetStart(node) => {
                if maze.meta.start.is_none() { maze.meta.start = Some(node); }
                true
            }
            MutationCommand::SetFinish(node) => {
                if maze.meta.finish.is_none() { maze.meta.finish = Some(node); }
                true
            }
            MutationCommand::RemoveNode { node } => {
                // Note the node's own coordinates into the ledger (GitHub issue #271) *before*
                // removal, same "resolve while it's still live" reasoning as `old_point_nodes`
                // above — `field.point_of` returns `None` once `try_remove_node` has removed it.
                // Needed for a node that was never itself minted mid-run (e.g. the field's own
                // original base nodes), whose coordinates otherwise exist nowhere once gone from
                // both `Field` and the final snapshot.
                if let (Some(state), Some(point)) = (debug_state.as_deref_mut(), maze.field.point_of(node)) {
                    state.note(node, point);
                }
                crate::generation::try_remove_node(&mut maze.field, &mut maze.graph, node, preset_state)
            }
            MutationCommand::ReplacePointNodes { at, ref nodes } => {
                // Note every old node's coordinates into the ledger (GitHub issue #271) *before*
                // replacement — same rationale as `RemoveNode` above. `old_point_nodes` was already
                // resolved while still live; its point is `at`'s own (every old node lives there).
                if let (Some(state), Some(old_nodes)) = (debug_state.as_deref_mut(), old_point_nodes.as_ref()) {
                    if let Some(point) = maze.field.point_of(at) {
                        for &old in old_nodes {
                            state.note(old, point);
                        }
                    }
                }
                let new_nodes = crate::generation::try_replace_point_nodes(&mut maze.field, &mut maze.graph, &mut maze.ids, at, nodes, preset_state, debug_state.as_deref_mut());
                let ok = new_nodes.is_some();
                replaced_nodes = new_nodes;
                ok
            }
        };
        if ok { applied += 1; }
        if let Some(log) = event_log.as_mut() {
            if let Some(event) = qc_event_for_command(&cmd, ok, edge_endpoints, reverse_removed, old_point_nodes, replaced_nodes) {
                log.emit(event);
            }
        }
    }
    ApplyOutcome { proposed, applied }
}

/// Builds the `QcEvent` mirroring `cmd` — the mutating variant when `applied`, the matching
/// `*Declined` trace variant (same fields) otherwise. See `apply_commands`'s doc comment.
/// `edge_endpoints` is `Some((from, to))` for `RemoveEdge`/`RemoveEdgeWithReverse`/
/// `RemoveTeleportWithReverse` (resolved by the caller before the edge was removed — GitHub issue
/// #171's follow-up fix), `None` for every other command (ignored). Returns `None` (nothing to
/// emit) for those three specifically when `edge_endpoints` is `None` — the id was already gone by
/// the time it was resolved — rather than fabricating a `(0, 0)` self-loop via `unwrap_or_default`:
/// node id `0` is a real, valid id in this codebase, so a fabricated pair would be
/// indistinguishable from a genuine edge. `reverse_removed` (GitHub issue #185's follow-up fix) is
/// only read for the two `*WithReverse` commands — `true` iff the reverse leg actually existed and
/// was removed too, straight from `try_remove_edge_with_reverse`/`try_remove_teleport_with_reverse`'s
/// own `Vec<EdgeId>` length, not assumed from the command's shape; lets web-side replay
/// (`applyQc` in `qc.ts`) know whether to also clear the reverse `(to, from)` pair from its own
/// accumulator instead of guessing and risking a phantom removed-edge entry for a direction that
/// was never actually there.
fn qc_event_for_command(cmd: &MutationCommand, applied: bool, edge_endpoints: Option<(NodeId, NodeId)>, reverse_removed: bool, old_point_nodes: Option<Vec<NodeId>>, replaced_nodes: Option<Vec<NodeId>>) -> Option<QcEvent> {
    Some(match (cmd, applied) {
        (MutationCommand::AddDirectedEdge { from, to }, true) => QcEvent::DirectedEdgeAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedEdge { from, to }, false) => QcEvent::DirectedEdgeDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalEdge { a, b }, true) => QcEvent::BidirectionalEdgeAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalEdge { a, b }, false) => QcEvent::BidirectionalEdgeDeclined { a: *a, b: *b },
        (MutationCommand::AddDirectedTeleport { from, to }, true) => QcEvent::DirectedTeleportAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedTeleport { from, to }, false) => QcEvent::DirectedTeleportDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalTeleport { a, b }, true) => QcEvent::BidirectionalTeleportAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalTeleport { a, b }, false) => QcEvent::BidirectionalTeleportDeclined { a: *a, b: *b },
        (MutationCommand::AddDirectedVerticalPassage { from, to }, true) => QcEvent::DirectedVerticalPassageAdded { from: *from, to: *to },
        (MutationCommand::AddDirectedVerticalPassage { from, to }, false) => QcEvent::DirectedVerticalPassageDeclined { from: *from, to: *to },
        (MutationCommand::AddBidirectionalVerticalPassage { a, b }, true) => QcEvent::BidirectionalVerticalPassageAdded { a: *a, b: *b },
        (MutationCommand::AddBidirectionalVerticalPassage { a, b }, false) => QcEvent::BidirectionalVerticalPassageDeclined { a: *a, b: *b },
        (MutationCommand::RemoveEdge { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoved { from, to } }
        (MutationCommand::RemoveEdge { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoveDeclined { from, to } }
        (MutationCommand::RemoveEdgeBetween { from, to }, true) => QcEvent::EdgeRemovedBetween { from: *from, to: *to },
        (MutationCommand::RemoveEdgeBetween { from, to }, false) => QcEvent::EdgeRemoveBetweenDeclined { from: *from, to: *to },
        (MutationCommand::RemoveEdgeWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveEdgeWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::EdgeRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::RemoveTeleportWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::TeleportRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveTeleportWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::TeleportRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::RemoveVerticalPassageWithReverse { .. }, true) => { let (from, to) = edge_endpoints?; QcEvent::VerticalPassageRemovedWithReverse { from, to, reverse_removed } }
        (MutationCommand::RemoveVerticalPassageWithReverse { .. }, false) => { let (from, to) = edge_endpoints?; QcEvent::VerticalPassageRemoveWithReverseDeclined { from, to, reverse_removed } }
        (MutationCommand::SetStart(node), true) => QcEvent::StartSet(*node),
        (MutationCommand::SetStart(node), false) => QcEvent::StartSetDeclined(*node),
        (MutationCommand::SetFinish(node), true) => QcEvent::FinishSet(*node),
        (MutationCommand::SetFinish(node), false) => QcEvent::FinishSetDeclined(*node),
        (MutationCommand::RemoveNode { node }, true) => QcEvent::NodeRemoved(*node),
        (MutationCommand::RemoveNode { node }, false) => QcEvent::NodeRemoveDeclined(*node),
        (MutationCommand::ReplacePointNodes { at, nodes }, true) => {
            let new_nodes = replaced_nodes?;
            let old_nodes = old_point_nodes?;
            QcEvent::PointNodesReplaced { at: *at, old_nodes, new_nodes, nodes: nodes.clone() }
        }
        (MutationCommand::ReplacePointNodes { at, nodes }, false) => {
            let old_nodes = old_point_nodes.unwrap_or_default();
            QcEvent::PointNodesReplaceDeclined { at: *at, old_nodes, nodes: nodes.clone() }
        }
    })
}

/// Builds the `QcEvent::*Proposed` variant mirroring `cmd`, narrating what a strategy's `apply()`
/// asked for before `apply_commands` has revalidated/applied any of it — see
/// `check_and_repair_typed`'s doc comment for where this is emitted (the `"strategy <id>"` scope,
/// ahead of the separate `"apply requests"` scope `apply_commands` itself emits into). `maze` is
/// only used to resolve `RemoveEdge`/`RemoveTeleportWithReverse`'s `EdgeId` to `(from, to)` (GitHub
/// issue #171's follow-up fix) — the graph is still fully intact here (nothing has been mutated
/// yet), so `graph.edge(id)` is always a hit unless the strategy proposed a stale id. Returns `None`
/// (nothing to emit) in that stale-id case rather than fabricating a `(0, 0)` self-loop via
/// `unwrap_or_default` — node id `0` is a real, valid id, so a fabricated pair would be
/// indistinguishable from a genuine edge; `apply_commands`'s own revalidation declines the stale
/// command anyway, so skipping the proposal narration here loses nothing meaningful.
fn qc_event_proposed_for_command<T: Tessellation>(cmd: &MutationCommand, maze: &Maze<T>) -> Option<QcEvent> {
    Some(match cmd {
        MutationCommand::AddDirectedEdge { from, to } => QcEvent::DirectedEdgeProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalEdge { a, b } => QcEvent::BidirectionalEdgeProposed { a: *a, b: *b },
        MutationCommand::AddDirectedTeleport { from, to } => QcEvent::DirectedTeleportProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalTeleport { a, b } => QcEvent::BidirectionalTeleportProposed { a: *a, b: *b },
        MutationCommand::AddDirectedVerticalPassage { from, to } => QcEvent::DirectedVerticalPassageProposed { from: *from, to: *to },
        MutationCommand::AddBidirectionalVerticalPassage { a, b } => QcEvent::BidirectionalVerticalPassageProposed { a: *a, b: *b },
        MutationCommand::RemoveEdge { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::EdgeRemoveProposed { from, to }
        }
        MutationCommand::RemoveEdgeBetween { from, to } => QcEvent::EdgeRemoveBetweenProposed { from: *from, to: *to },
        MutationCommand::RemoveEdgeWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::EdgeRemoveWithReverseProposed { from, to }
        }
        MutationCommand::RemoveTeleportWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::TeleportRemoveWithReverseProposed { from, to }
        }
        MutationCommand::RemoveVerticalPassageWithReverse { id } => {
            let (from, to) = maze.graph.edge(*id).map(|e| (e.from, e.to))?;
            QcEvent::VerticalPassageRemoveWithReverseProposed { from, to }
        }
        MutationCommand::SetStart(node) => QcEvent::StartSetProposed(*node),
        MutationCommand::SetFinish(node) => QcEvent::FinishSetProposed(*node),
        MutationCommand::RemoveNode { node } => QcEvent::NodeRemoveProposed(*node),
        MutationCommand::ReplacePointNodes { at, nodes } => {
            let old_nodes = maze.field.level_of(*at).zip(maze.field.point_of(*at))
                .map(|(level, point)| maze.field.nodes_at(level, point).to_vec()).unwrap_or_default();
            QcEvent::PointNodesReplaceProposed { at: *at, old_nodes, nodes: nodes.clone() }
        }
    })
}

/// One rule's strategy assignment — checks + strategy + resolved params/requirement, held
/// together so `Rule` can dispatch repair by itself. `None` on `Rule::strategy` (not this type)
/// means "no_fix". `params`/`requirement` are resolved once in `Rule::new` (not `param_overrides`
/// kept around raw) — see GitHub issue #105: both are pure functions of `strategy`+
/// `param_overrides`, computed once and reused by every `check_and_repair_typed` call instead of
/// rebuilt per call.
struct RuleStrategy<T: Tessellation, I: IssueRequirement + IssueMerge> {
    strategy: Box<dyn RepairStrategy<T, I>>,
    nested: Vec<NestedStrategyConfig<T>>,
    params: StrategyParams,
    requirement: I::Requirement,
}

/// What happened when `Rule::check_and_repair_typed` ran this rule for one fixpoint iteration —
/// the issue itself never crosses back out to the caller (GitHub issue #170's Stage/Rule
/// simplification: the check→strategy pipeline is now fully internal to `Rule`, not surfaced as a
/// `Box<dyn Issue>` the caller has to hold onto between a check step and a dispatch step).
pub enum RuleIterationOutcome {
    /// No check in this rule found anything this iteration.
    NoIssue,
    /// A check found an issue, but this rule has no registered strategy ("no_fix") — nothing to
    /// dispatch.
    NoStrategy,
    /// A check found an issue and this rule's strategy was dispatched against it.
    Repaired(RepairResult, ApplyOutcome),
}

/// A user-defined QC rule: a set of checks producing one `Issue` type `I`, driving its own check
/// dispatch, issue merge, and (if configured) repair dispatch. `I` is fixed at the type level —
/// there is no runtime `kind` field to independently agree with, and no possibility of
/// constructing a `Rule` whose checks disagree on kind (see GitHub issue #113): every `Box<dyn
/// Check<T, I>>` in `checks` and the one `Box<dyn RepairStrategy<T, I>>` in `strategy` are all
/// generic over the exact same `I`.
///
pub struct Rule<T: Tessellation, I: IssueRequirement + IssueMerge> {
    pub id: String,
    checks: Vec<(String, Box<dyn Check<T, I>>)>,
    strategy: Option<RuleStrategy<T, I>>,
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge> Rule<T, I> {
    pub fn new(
        id: String,
        checks: Vec<(String, Box<dyn Check<T, I>>)>,
        strategy: Option<Box<dyn RepairStrategy<T, I>>>,
        param_overrides: HashMap<String, String>,
        nested: Vec<NestedStrategyConfig<T>>,
    ) -> Self {
        let strategy = strategy.map(|strategy| {
            let params = build_params(strategy.params(), Some(&param_overrides));
            let requirement = strategy.requirement(&params);
            RuleStrategy { strategy, nested, params, requirement }
        });
        Self { id, checks, strategy }
    }

    /// `(local_id, &dyn Check<T, I>)` pairs, in the order checks were configured.
    pub fn checks(&self) -> impl Iterator<Item = (&str, &dyn Check<T, I>)> {
        self.checks.iter().map(|(local_id, check)| (local_id.as_str(), check.as_ref()))
    }

    pub fn has_strategy(&self) -> bool {
        self.strategy.is_some()
    }

    /// Runs every check in this rule via `Check::repair_check`, folding all raw issues into at
    /// most one merged issue via `IssueMerge::merge` — the per-rule concern issue #106 calls out
    /// ("gives rule-level issue merging a natural home"). Returns `None` if no check in this rule
    /// found anything this call. `pub` so tests can exercise per-rule check-merge behavior
    /// directly, without needing a real repair dispatch.
    ///
    /// `event_log` (GitHub issue #147) emits one `QcEvent::CheckRan` per check, each carrying that
    /// check's own raw (pre-merge) issue if any — resolved against the same `maze`/graph the check
    /// itself just ran against, via `resolve_issue_payload` (this crate's shared payload resolver;
    /// see `issue_payload.rs`). When two or more checks in this rule each contribute a raw issue,
    /// one `QcEvent::IssuesMerged` is emitted after the per-check events, once merging has actually
    /// combined them — a rule with only one contributing check never emits it.
    pub fn run_checks_typed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
    ) -> Option<I> {
        // Resolved once per call (not per check) from the bound strategy's cached requirement —
        // no_fix (no strategy) falls back to the default (all()), same as an unmigrated check
        // always got before this mechanism existed. See GitHub issue #105.
        let requirement = self.strategy.as_ref()
            .map(|s| s.requirement)
            .unwrap_or_default();
        // Built once, only when narration is actually on — `resolve_issue_payload` is the only
        // consumer, and most issue kinds don't even need it (see its own doc comment).
        let scc = event_log.is_some().then(|| crate::graph::scc::build_scc(&maze.graph));

        let mut merged: Option<I> = None;
        let mut contributing_checks = 0u32;
        for (local_id, check) in &self.checks {
            // The composite routing key `Issue::details()`/`source_checks()` are keyed by (see
            // `issue.rs`'s doc comment on `new_from_check`) — mirrors `composite_check_id` in
            // `maze-runner/src/runner/check_factory.rs`, which built this same string once, at
            // construction time, to seed each `Check`'s own `instance_id` field; `self.checks`
            // only carries the plain `local_id` half of that (see `rule_factory.rs`'s
            // `build_rule_for!`), so it must be re-derived here rather than read off the tuple
            // directly — `maze-core` has no dependency on `maze-runner` to call the same helper.
            let instance_id = format!("{}:{}", self.id, local_id);
            let issues = timed(timing, check.check_type_id(), now_ms, || {
                let mut v = Vec::new();
                check.repair_check(maze, &mut v, rng, requirement);
                v
            });
            let check_issue = issues.into_iter().reduce(|mut acc, issue| { acc.merge(issue); acc });
            if let Some(log) = event_log.as_mut() {
                let payload = check_issue.as_ref().map(|issue| {
                    let payload = super::issue_payload::resolve_issue_payload(issue, &maze.graph, &maze.field, scc.as_ref().unwrap(), preset_state);
                    let details = issue.details().get(instance_id.as_str()).cloned().unwrap_or_default();
                    (I::KIND, payload, details)
                });
                log.emit(QcEvent::CheckRan { check_id: instance_id, issue: payload });
            }
            if let Some(issue) = check_issue {
                contributing_checks += 1;
                match &mut merged {
                    None => merged = Some(issue),
                    Some(existing) => existing.merge(issue),
                }
            }
        }
        if contributing_checks > 1 {
            if let Some(log) = event_log.as_mut() {
                let payload = merged.as_ref()
                    .map(|issue| super::issue_payload::resolve_issue_payload(issue, &maze.graph, &maze.field, scc.as_ref().unwrap(), preset_state))
                    .unwrap_or_default();
                let details = merged.as_ref().map(|issue| issue.details().clone()).unwrap_or_default();
                log.emit(QcEvent::IssuesMerged { issue_kind: I::KIND, payload, details });
            }
        }
        merged
    }

    /// Runs this rule's checks (`run_checks_typed`) then, if a check found anything and this rule
    /// has a registered strategy, dispatches repair against it immediately and applies the
    /// returned commands (see `apply_commands` above) — the Rule-level commit point
    /// `Specs/repair.md` specifies, not batched across the whole `Stage`. The merged issue never
    /// leaves this call — see GitHub issue #170: the check→strategy pipeline is fully internal to
    /// `Rule` from the caller's perspective (the erased `RuleTrait::check_and_repair` entry point
    /// below never sees a `Box<dyn Issue>`), unlike the pre-#170 split, where `Stage` held the
    /// issue between a separate `run_checks`/`dispatch_repair` call pair.
    ///
    /// `per_check`/`per_strategy` accumulate this call's own check/strategy timing — the caller
    /// (`Stage::check_and_dispatch`) folds them into this rule's own `TimingNode` in the
    /// hierarchical tree (see GitHub issue #285, `GenerationTiming::qc`), keyed by this rule's
    /// `self.id`.
    ///
    /// `event_log` (GitHub issue #147): the dispatched strategy gets its own nested `"strategy
    /// <id>"` scope, holding one `QcEvent::*Proposed` per command the strategy's `apply()`
    /// returned — narrating what was *asked for*, before any of it has been revalidated or
    /// applied (a strategy never mutates `Maze` itself, see `RepairStrategy::apply`'s doc comment
    /// — it only proposes `MutationCommand`s). When `commands` is non-empty, a second, separate
    /// `"apply requests"` scope follows (a sibling of `"strategy <id>"`, not nested inside it),
    /// holding the mutating/`*Declined` events `apply_commands` emits for this same batch. No
    /// `"apply requests"` scope is opened when `commands` is empty (a strategy that proposed
    /// nothing has nothing to apply). Its own applied/proposed outcome is narrated by resolving
    /// the scope's *label* from its children's mutating-vs-`*Declined` counts (mirrors
    /// `CustomVertexBased`'s `"junction_count"` scope label — see `algorithmRegistry.ts`'s
    /// `scopeLabel`) rather than a dedicated summary event — there is no `QcEvent` carrying
    /// `proposed`/`applied` directly. What a strategy itself narrates *inside* its own `"strategy
    /// <id>"` scope beyond the `*Proposed` line (e.g. per-strategy decision events) is each
    /// strategy's own concern, added issue-by-issue in later tickets.
    pub fn check_and_repair_typed(
        &self,
        maze: &mut Maze<T>,
        rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
        mut event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        mut debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome {
        let issue = self.run_checks_typed(maze, rng, preset_state, per_check, now_ms, event_log.as_deref_mut());
        let Some(issue) = issue else { return RuleIterationOutcome::NoIssue };
        let Some(rule_strategy) = self.strategy.as_ref() else { return RuleIterationOutcome::NoStrategy };

        let (result, commands) = timed(per_strategy, rule_strategy.strategy.strategy_id(), now_ms, || {
            rule_strategy.strategy.apply(&issue, maze, rng, &rule_strategy.params, preset_state, &rule_strategy.nested)
        });

        {
            let mut strategy_scope = event_log.as_mut().map(|log| log.enter(format!("strategy {}", rule_strategy.strategy.strategy_id())));
            if let Some(scope) = strategy_scope.as_mut() {
                for cmd in &commands {
                    if let Some(event) = qc_event_proposed_for_command(cmd, maze) {
                        scope.emit(event);
                    }
                }
                if matches!(result, RepairResult::Failed) {
                    scope.emit(QcEvent::StrategyFailed { strategy_id: rule_strategy.strategy.strategy_id() });
                }
            }
        }

        let outcome = if commands.is_empty() {
            apply_commands(maze, preset_state, commands, None, debug_state.as_deref_mut())
        } else {
            let mut apply_scope = event_log.as_mut().map(|log| log.enter("apply requests"));
            apply_commands(maze, preset_state, commands, apply_scope.as_mut(), debug_state.as_deref_mut())
        };
        RuleIterationOutcome::Repaired(result, outcome)
    }

    /// Runs every check in this rule via `Check::report_check` — one issue per flagged problem
    /// instance, no merge (see GitHub issue #102).
    pub fn report_checks_typed(
        &self,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64,
    ) -> Vec<I> {
        let mut issues = Vec::new();
        for (_, check) in &self.checks {
            let mut found = timed(timing, check.check_type_id(), now_ms, || check.report_check(maze, rng));
            issues.append(&mut found);
        }
        issues
    }
}

/// Type-erased view of `Rule<T, I>` for the one place genuine cross-`I` heterogeneity is
/// unavoidable: `Stage.rules` (a `Stage` deliberately groups rules of different kinds together —
/// see GitHub issue #113). The check→strategy pipeline itself never crosses this boundary — `I`
/// stays entirely inside `Rule::check_and_repair_typed` (see GitHub issue #170); `check_and_repair`
/// below is the only erased entry point into it.
pub trait RuleTrait<T: Tessellation> {
    fn id(&self) -> &str;
    fn report_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>>;
    fn check_and_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome;
}

impl<T: Tessellation, I: IssueRequirement + IssueMerge + 'static> RuleTrait<T> for Rule<T, I> {
    fn id(&self) -> &str {
        &self.id
    }

    fn report_checks(
        &self, maze: &Maze<T>, rng: &mut dyn RngCore,
        timing: &mut HashMap<&'static str, (f64, u32)>, now_ms: &dyn Fn() -> f64,
    ) -> Vec<Box<dyn Issue>> {
        self.report_checks_typed(maze, rng, timing, now_ms).into_iter()
            .map(|i| Box::new(i) as Box<dyn Issue>)
            .collect()
    }

    fn check_and_repair(
        &self, maze: &mut Maze<T>, rng: &mut dyn RngCore,
        preset_state: &PresetState,
        per_check: &mut HashMap<&'static str, (f64, u32)>,
        per_strategy: &mut HashMap<&'static str, (f64, u32)>,
        now_ms: &dyn Fn() -> f64, event_log: Option<&mut ScopeGuard<'_, QcEvent>>,
        debug_state: Option<&mut crate::generation::DebugGenerationState<T>>,
    ) -> RuleIterationOutcome {
        self.check_and_repair_typed(maze, rng, preset_state, per_check, per_strategy, now_ms, event_log, debug_state)
    }
}

/// Times one `f` call, accumulating elapsed milliseconds and call count under `check_type_id` —
/// shared by `run_checks_typed`/`report_checks_typed`, the two call sites whose only difference is
/// which `Check` method they invoke (`repair_check`'s out-parameter vs `report_check`'s return
/// value), not worth unifying behind a generic per-check callback for just two call sites.
fn timed<R>(
    timing: &mut HashMap<&'static str, (f64, u32)>,
    check_type_id: &'static str,
    now_ms: &dyn Fn() -> f64,
    f: impl FnOnce() -> R,
) -> R {
    let start = now_ms();
    let result = f();
    let elapsed = now_ms() - start;
    let entry = timing.entry(check_type_id).or_insert((0.0, 0));
    entry.0 += elapsed;
    entry.1 += 1;
    result
}

/// Direct unit tests for `apply_commands` — one revalidation arm per `MutationCommand` variant,
/// plus the revalidate-and-drop mechanism itself (GitHub issue #118, `Specs/repair.md`'s
/// mutation-command contract): a command built against an earlier snapshot that no longer holds
/// by commit time must be silently dropped, not panic or corrupt the graph, and must not prevent
/// the rest of the batch from applying.
#[cfg(test)]
#[path = "apply_commands_tests.rs"]
mod apply_commands_tests;

/// See GitHub issue #105 — proves `Rule::new` resolves a strategy's `requirement()` once and
/// `run_checks_typed` actually threads that exact value into every `Check::repair_check` call in
/// the rule, rather than defaulting to `I::Requirement::default()` or resolving it again per call.
#[cfg(test)]
#[path = "requirement_wiring_tests.rs"]
mod requirement_wiring_tests;
