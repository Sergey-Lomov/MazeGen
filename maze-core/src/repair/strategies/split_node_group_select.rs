use std::collections::HashMap;
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::{SplitNodeGroupKind, InvalidSplitNodeGroupIssue, InvalidSplitNodeIssue, INVALID_SPLIT_NODE};
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::group_select::group_select_apply;

pub const PARAM_SELECTION: &str = "selection";

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
];

/// Slot id for the nested strategy this strategy delegates each candidate node's actual removal
/// to — `RemoveSplitNodeStrategy`, the only `INVALID_SPLIT_NODE`-handling strategy.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_SPLIT_NODE, min: 1, max: Some(1) },
];

/// Handles `INVALID_SPLIT_NODE_GROUP` — see GitHub issue #252, epic #246. For each problematic
/// group flagged by `SplitTileNodeCountCheck` (`InvalidSplitNodeGroupIssue.groups:
/// Vec<(Vec<NodeId>, u32)>`, one group per over-limit split tile), picks nodes to remove and
/// delegates each actual removal to the nested `INVALID_SPLIT_NODE` strategy
/// (`RemoveSplitNodeStrategy`) filling `fix_target` — mirrors
/// `SplitNodeConnectionGroupSelectStrategy`'s shape, built on the same shared `group_select_apply`
/// mechanics.
///
/// `PARAM_SELECTION` (default `random`) drives `order_candidates`: which of a tile's own nodes get
/// removed first, judged by that node's own total connection degree (both directions, every edge
/// incident to the node) —
/// - `random`: every candidate node shuffled once, visited in that order.
/// - `most_connected`/`least_connected`: every candidate shuffled first (so same-degree ties
///   resolve randomly, not by incidental iteration order), then stably sorted by degree
///   descending/ascending. Degree is precomputed once per call (`O(E)`, a single pass building
///   both an outgoing and incoming count map) rather than rescanned per candidate inside the sort
///   comparator.
///
/// A tile's slot-0 (`Field::nodes_at(point)`'s first entry) is never offered as a candidate —
/// `element_allowed` excludes it unconditionally (unlike
/// `SplitNodeConnectionGroupSelectStrategy`'s `protect_original`, this has no toggle: epic #246's
/// "never remove slot-0" rule is a hard constraint for this strategy's own unit of work, the node
/// itself, not a configurable preference). A candidate whose removal is infeasible for any other
/// reason (preset-locked) is excluded the same way, mirroring
/// `SplitNodeConnectionGroupSelectStrategy`'s `removal_feasible` check, so a preset-locked split
/// never falsely resolves the group's budget and loops the repair fixpoint to its limit instead of
/// reporting `Failed`.
pub struct SplitNodeGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitNodeGroupIssue> for SplitNodeGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str { "split_node_group_select" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidSplitNodeGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "SplitNodeGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let element_allowed = |node: &NodeId| -> bool {
            crate::generation::remove_node_feasible(&maze.field, preset_state, *node)
        };
        let build_nested_issue = |source_check: &str, target: &NodeId, _others: &[NodeId]| -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidSplitNodeIssue::new_from_check(source_check, vec![*target]))
        };
        let element_invalidated = |node: &NodeId, nested_commands: &[MutationCommand], _maze: &Maze<T>| {
            nested_commands.iter().any(|cmd| matches!(cmd, MutationCommand::RemoveNode { node: removed } if removed == node))
        };
        let order_candidates = |candidates: &mut Vec<NodeId>, _membership: &HashMap<NodeId, usize>, rng: &mut dyn RngCore| {
            let selection = match params.get(PARAM_SELECTION) {
                Some(StrategyParamValue::Enum(v)) => v.as_str(),
                _ => SELECTION_RANDOM,
            };
            candidates.shuffle(rng);
            if selection == SELECTION_MOST_CONNECTED || selection == SELECTION_LEAST_CONNECTED {
                let degree = node_degree_map(maze);
                let node_degree = |node: &NodeId| -> usize { degree.get(node).copied().unwrap_or(0) };
                if selection == SELECTION_MOST_CONNECTED {
                    candidates.sort_by_key(|n| std::cmp::Reverse(node_degree(n)));
                } else {
                    candidates.sort_by_key(node_degree);
                }
            }
        };

        group_select_apply::<T, SplitNodeGroupKind>(issue, maze, rng, preset_state, fix_target, element_allowed, build_nested_issue, element_invalidated, order_candidates)
    }
}

/// Every node's total incident-edge degree (both directions), computed once in a single `O(E)`
/// pass over the graph — used by `PARAM_SELECTION`'s `most_connected`/`least_connected` ordering.
fn node_degree_map<T: Tessellation>(maze: &Maze<T>) -> HashMap<NodeId, usize> {
    let mut degree: HashMap<NodeId, usize> = HashMap::new();
    for edge in maze.graph.edges() {
        *degree.entry(edge.from).or_insert(0) += 1;
        *degree.entry(edge.to).or_insert(0) += 1;
    }
    degree
}

crate::impl_erased_repair_strategy!(SplitNodeGroupSelectStrategy, InvalidSplitNodeGroupIssue);

#[cfg(test)]
#[path = "split_node_group_select_tests.rs"]
mod tests;
