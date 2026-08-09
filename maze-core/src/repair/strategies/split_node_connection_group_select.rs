use std::collections::HashMap;
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::graph::route_protection::is_edge_on_route;
use crate::quality_control::{SplitNodeConnectionGroupKind, InvalidSplitNodeConnectionGroupIssue, InvalidSplitNodeConnectionIssue, INVALID_SPLIT_NODE_CONNECTION};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig, NestedDispatchKind};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::group_select::group_select_apply;

pub const PARAM_SELECTION: &str = "selection";
pub const PARAM_PROTECT_ORIGINAL: &str = "protect_original";
pub const PARAM_PROTECT_ROUTE: &str = "protect_route";

pub const SELECTION_RANDOM: &str = "random";
pub const SELECTION_MOST_CONNECTED: &str = "most_connected";
pub const SELECTION_LEAST_CONNECTED: &str = "least_connected";

pub static SELECTION_OPTIONS: &[&str] = &[SELECTION_RANDOM, SELECTION_MOST_CONNECTED, SELECTION_LEAST_CONNECTED];

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_SELECTION,
        label: "Node selection method",
        kind: StrategyParamKind::Enum { options: SELECTION_OPTIONS, default: SELECTION_RANDOM },
    },
    StrategyParam {
        id: PARAM_PROTECT_ORIGINAL,
        label: "Protect original node",
        kind: StrategyParamKind::Bool { default: true },
    },
    StrategyParam {
        id: PARAM_PROTECT_ROUTE,
        label: "Protect route connections",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Slot id for the nested strategy this strategy delegates each candidate connection's actual
/// removal to — `RemoveSplitNodeConnectionStrategy`, the only `INVALID_SPLIT_NODE_CONNECTION`-
/// handling strategy.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_SPLIT_NODE_CONNECTION, min: 1, max: Some(1), dispatch_kind: NestedDispatchKind::Unordered },
];

/// Handles `INVALID_SPLIT_NODE_CONNECTION_GROUP` — see GitHub issue #251, epic #246. For each
/// problematic group flagged by `SplitNodeConnectionPerNeighborCheck`/
/// `SplitNodeConnectionPerFaceCheck` (`InvalidSplitNodeConnectionGroupIssue.groups:
/// Vec<(Vec<EdgeId>, u32)>`), picks connections to cut and delegates each actual removal to the
/// nested `INVALID_SPLIT_NODE_CONNECTION` strategy (`RemoveSplitNodeConnectionStrategy`) filling
/// `fix_target` — mirrors `OneWayGroupSelectStrategy`'s shape, built on the same shared
/// `group_select_apply` mechanics.
///
/// `PARAM_SELECTION` (default `random`) drives `order_candidates`: which of a split's own nodes'
/// connections get cut first, judged by that *originating* node's own total connection degree
/// (both directions, every edge incident to `edge.from`) —
/// - `random`: every candidate edge shuffled once, visited in that order.
/// - `most_connected`/`least_connected`: every candidate shuffled first (so same-degree ties
///   resolve randomly, not by incidental iteration order), then stably sorted by the originating
///   node's degree descending/ascending. Degree is precomputed once per call (`O(E)`, a single
///   pass building both an outgoing and incoming count map) rather than rescanned per candidate
///   inside the sort comparator.
///
/// `PARAM_PROTECT_ORIGINAL` (default `true`): a candidate whose originating node (`edge.from`) is
/// its split tile's slot-0 (`Field::nodes_at(point)`'s first entry) is excluded from the candidate
/// pool — epic #246's per-strategy removal-eligibility rule extended to this strategy's own unit
/// of work (a connection, not the node itself): protecting slot-0's connections keeps the original
/// tile's own wiring untouched, cutting only extra nodes' excess links. `PARAM_PROTECT_ROUTE`
/// (default `true`): a candidate lying on the maze's current start->finish route
/// (`is_edge_on_route`) is excluded the same way, mirroring `OneWayGroupSelectStrategy`'s own
/// `protect_route`. A candidate is also excluded when its removal is fully blocked by preset edges
/// (both directions preset-protected), so a preset-locked split never falsely resolves the group's
/// budget and loops the repair fixpoint to its limit instead of reporting `Failed`. All three
/// filters combine into one `element_allowed` closure passed to `group_select_apply` — a candidate
/// excluded by any reason is simply never offered.
pub struct SplitNodeConnectionGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitNodeConnectionGroupIssue> for SplitNodeConnectionGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str { "split_node_connection_group_select" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidSplitNodeConnectionGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "SplitNodeConnectionGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let protect_original = matches!(params.get(PARAM_PROTECT_ORIGINAL), Some(StrategyParamValue::Bool(true)));
        let protect_route = matches!(params.get(PARAM_PROTECT_ROUTE), Some(StrategyParamValue::Bool(true)));

        let is_original_node = |edge: &EdgeId| -> bool {
            let Some(e) = maze.graph.edge(*edge) else { return false };
            let Some(point) = maze.field.point_of(e.from) else { return false };
            maze.field.nodes_at(point).first() == Some(&e.from)
        };
        // A candidate whose removal (forward + reverse, per `RemoveEdgeWithReverse` semantics) is
        // fully blocked by preset edges would let `group_select_apply` "resolve" the group's budget
        // without the graph actually changing, so the same excess connection resurfaces next QC
        // pass and the repair loop spins until `RepairLimitReached` — see GitHub issue #251 bug
        // report. Excluding it upfront (mirrors `invalid_loop_random.rs`/`invalid_loop_scored.rs`)
        // keeps the group `Failed` instead of falsely `Fixed`.
        let removal_feasible = |edge: &EdgeId| -> bool {
            let Some(e) = maze.graph.edge(*edge) else { return false };
            let forward_ok = !preset_state.is_preset_edge(e.from, e.to);
            let reverse_exists = maze.graph.edge_between(e.to, e.from).is_some();
            let reverse_ok = reverse_exists && !preset_state.is_preset_edge(e.to, e.from);
            forward_ok || reverse_ok
        };
        let element_allowed = |edge: &EdgeId| {
            (!protect_original || !is_original_node(edge))
                && (!protect_route || !is_edge_on_route(maze, *edge))
                && removal_feasible(edge)
        };
        let build_nested_issue = |source_check: &str, target: &EdgeId, _others: &[EdgeId]| -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidSplitNodeConnectionIssue::new_from_check(source_check, vec![*target]))
        };
        let element_invalidated = |edge: &EdgeId, nested_commands: &[MutationCommand], _maze: &Maze<T>| {
            crate::repair::removed_edge_ids(nested_commands).contains(edge)
        };
        let order_candidates = |candidates: &mut Vec<EdgeId>, _membership: &HashMap<EdgeId, usize>, rng: &mut dyn RngCore| {
            let selection = match params.get(PARAM_SELECTION) {
                Some(StrategyParamValue::Enum(v)) => v.as_str(),
                _ => SELECTION_RANDOM,
            };
            candidates.shuffle(rng);
            if selection == SELECTION_MOST_CONNECTED || selection == SELECTION_LEAST_CONNECTED {
                let degree = node_degree_map(maze);
                let origin_degree = |edge: &EdgeId| -> usize {
                    maze.graph.edge(*edge).and_then(|e| degree.get(&e.from).copied()).unwrap_or(0)
                };
                if selection == SELECTION_MOST_CONNECTED {
                    candidates.sort_by_key(|e| std::cmp::Reverse(origin_degree(e)));
                } else {
                    candidates.sort_by_key(origin_degree);
                }
            }
        };

        group_select_apply::<T, SplitNodeConnectionGroupKind>(issue, maze, rng, preset_state, fix_target, element_allowed, build_nested_issue, element_invalidated, order_candidates)
    }
}

/// Every node's total incident-edge degree (both directions), computed once in a single `O(E)`
/// pass over the graph — used by `PARAM_SELECTION`'s `most_connected`/`least_connected` ordering.
fn node_degree_map<T: Tessellation>(maze: &Maze<T>) -> HashMap<crate::ids::NodeId, usize> {
    let mut degree: HashMap<crate::ids::NodeId, usize> = HashMap::new();
    for edge in maze.graph.edges() {
        *degree.entry(edge.from).or_insert(0) += 1;
        *degree.entry(edge.to).or_insert(0) += 1;
    }
    degree
}

crate::impl_erased_repair_strategy!(SplitNodeConnectionGroupSelectStrategy, InvalidSplitNodeConnectionGroupIssue);

#[cfg(test)]
#[path = "split_node_connection_group_select_tests.rs"]
mod tests;
