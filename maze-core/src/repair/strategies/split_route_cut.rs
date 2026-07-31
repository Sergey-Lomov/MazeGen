use std::collections::HashSet;
use rand::{Rng, RngCore};
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::quality_control::{InvalidSplitRouteIssue, SplitRouteEdge};
use crate::generation::{PresetState, cmd_remove_edge_with_reverse};
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParams, StrategyParamValue};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::command::{MutationCommand, removed_edge_ids};
use crate::repair::strategies::group_select::{PARAM_PRIORITY, PRIORITY_RANDOM, PRIORITY_PROBLEMATIC, PRIORITY_OPTIONS};

pub const PARAM_EDGE_SCOPE: &str = "edge_scope";

pub const EDGE_SCOPE_SPLIT_ONLY: &str = "split_only";
pub const EDGE_SCOPE_OTHER_ONLY: &str = "other_only";
pub const EDGE_SCOPE_ANY: &str = "any";

static EDGE_SCOPE_OPTIONS: &[&str] = &[EDGE_SCOPE_SPLIT_ONLY, EDGE_SCOPE_OTHER_ONLY, EDGE_SCOPE_ANY];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_EDGE_SCOPE,
        label: "Cuttable edges",
        kind: StrategyParamKind::Enum { options: EDGE_SCOPE_OPTIONS, default: EDGE_SCOPE_OTHER_ONLY },
    },
    StrategyParam {
        id: PARAM_PRIORITY,
        label: "Edge selection priority",
        kind: StrategyParamKind::Enum { options: PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
];

/// Handles `INVALID_SPLIT_ROUTE` (see GitHub issue #277, part of epic #246) by picking, for each
/// flagged route, one edge to cut — breaking the too-short path between the route's two split
/// nodes.
///
/// `edge_scope` restricts which edges of a route are eligible: `split_only` only considers edges
/// incident to the split tile itself (`SplitRouteEdge.1 == true`), `other_only` (the default) only
/// considers every other edge on the route, `any` considers the whole route. `other_only` is the
/// default because cutting a route's own split connections changes the split tile's own topology
/// (fewer/weaker connections to the outside world) where cutting some other passage along the way
/// only removes a shortcut unrelated to the split itself — the least invasive fix by default.
///
/// `priority` (the shared `group_select::PARAM_PRIORITY` param) picks among the eligible
/// candidates: `random` uniformly at random, `problematic` picks the candidate edge shared by the
/// most *other* still-pending routes in this same issue (breaking one such edge is likely to
/// resolve several routes at once) — mirrors `InvalidLoopScoredStrategy`'s overlap-based scoring,
/// ties broken by ascending `EdgeId` for determinism rather than by `rng`, since a `problematic`
/// pick is meant to be reproducible given the same route set.
///
/// Every chosen edge, split or not, is cut directly by this strategy via
/// `cmd_remove_edge_with_reverse` (removes both directions of a bidirectional passage at once) —
/// no nested strategy involved, a route's edge is a plain graph edge with no split-specific
/// removal semantics to delegate to.
///
/// Routes are processed as a queue, same "shared-edge removal drops the rest of the queue" pattern
/// `InvalidLoopGroupSelectStrategy` uses: after each cut, any other still-pending route containing
/// the same edge (or its reverse direction — a two-way passage severed by one cut breaks both
/// directions at once) is dropped from the queue rather than offered a second, redundant cut.
pub struct SplitRouteCutStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitRouteIssue> for SplitRouteCutStrategy {
    fn strategy_id(&self) -> &'static str { "split_route_cut" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        &[]
    }

    fn apply(
        &self,
        issue: &InvalidSplitRouteIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.routes.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let edge_scope = match params.get(PARAM_EDGE_SCOPE) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => EDGE_SCOPE_OTHER_ONLY,
        };
        let priority = match params.get(PARAM_PRIORITY) {
            Some(StrategyParamValue::Enum(s)) => s.as_str(),
            _ => PRIORITY_PROBLEMATIC,
        };

        let mut pending: Vec<Vec<SplitRouteEdge>> = issue.routes.clone();
        let mut commands = Vec::new();
        let mut any_succeeded = false;

        while !pending.is_empty() {
            let route_idx = 0;
            let route = pending.remove(route_idx);

            let candidates: Vec<SplitRouteEdge> = route.iter().copied()
                .filter(|&(_, is_split)| match edge_scope {
                    EDGE_SCOPE_SPLIT_ONLY => is_split,
                    EDGE_SCOPE_ANY => true,
                    _ => !is_split,
                })
                .collect();

            let Some((cut_id, _)) = pick_candidate(&candidates, &pending, priority, rng) else {
                continue;
            };

            let cut_commands = cmd_remove_edge_with_reverse(&maze.graph, cut_id, preset_state);

            if cut_commands.is_empty() {
                continue;
            }
            any_succeeded = true;

            let removed: HashSet<EdgeId> = removed_edge_ids(&cut_commands).into_iter().collect();
            let reversed: HashSet<EdgeId> = removed.iter()
                .filter_map(|&id| maze.graph.edge(id))
                .filter_map(|e| maze.graph.edge_between(e.to, e.from))
                .collect();
            pending.retain(|r| !r.iter().any(|&(id, _)| removed.contains(&id) || reversed.contains(&id)));

            commands.extend(cut_commands);
        }

        let result = if any_succeeded {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

crate::impl_erased_repair_strategy!(SplitRouteCutStrategy, InvalidSplitRouteIssue);

/// Picks one candidate edge to cut from `candidates` (already filtered by `edge_scope`) — `None`
/// if there's nothing eligible. `random` picks uniformly; `problematic` picks the candidate
/// appearing in the most routes among `other_pending_routes`, ties broken by ascending `EdgeId`.
fn pick_candidate(
    candidates: &[SplitRouteEdge],
    other_pending_routes: &[Vec<SplitRouteEdge>],
    priority: &str,
    rng: &mut dyn RngCore,
) -> Option<SplitRouteEdge> {
    if candidates.is_empty() {
        return None;
    }
    if priority != PRIORITY_PROBLEMATIC {
        let idx = rng.random_range(0..candidates.len());
        return Some(candidates[idx]);
    }

    candidates.iter().copied()
        .max_by_key(|&(id, _)| {
            let overlap = other_pending_routes.iter()
                .filter(|route| route.iter().any(|&(other_id, _)| other_id == id))
                .count();
            (overlap, std::cmp::Reverse(id))
        })
}

#[cfg(test)]
#[path = "split_route_cut_tests.rs"]
mod tests;
