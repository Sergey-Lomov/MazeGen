use std::collections::HashMap;
use rand::RngCore;
use rand::seq::SliceRandom;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::{SplitGroupKind, InvalidSplitTileGroupIssue, InvalidSplitTileIssue, SplitTileNodes, INVALID_SPLIT_TILE};
use crate::generation::PresetState;
use crate::repair::params::StrategyParams;
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedSlot, NestedStrategyConfig};
use crate::repair::command::MutationCommand;
use crate::repair::strategies::group_select::{group_select_apply, PARAM_PRIORITY, PRIORITY_PROBLEMATIC, PRIORITY_RANDOM};

/// Most/least voluminous: picks the split tile with the most/fewest total nodes (slot-0
/// included). Most/least connected: picks the tile whose nodes carry the most/fewest incident
/// edges in total (both directions, slot-0 included — slot-0 is an equal member of the tile for
/// every metric, issue #281). Distinct from `PRIORITY_PROBLEMATIC` (membership-across-groups) —
/// these four instead look at a tile's own shape, independent of how many groups it appears in.
pub const PRIORITY_MOST_VOLUMINOUS: &str = "most_voluminous";
pub const PRIORITY_LEAST_VOLUMINOUS: &str = "least_voluminous";
pub const PRIORITY_MOST_CONNECTED: &str = "most_connected";
pub const PRIORITY_LEAST_CONNECTED: &str = "least_connected";

/// `split_group_select`'s own priority option set — a superset of the shared `PRIORITY_OPTIONS`
/// (`random`/`problematic`, see `group_select.rs`) with four split-specific metrics added. Kept
/// local to this module rather than widening the shared constant, since `OneWayGroupSelectStrategy`/
/// `TeleportGroupSelectStrategy` have no equivalent per-candidate size/connectivity notion (an
/// edge has neither).
pub static SPLIT_PRIORITY_OPTIONS: &[&str] = &[
    PRIORITY_RANDOM, PRIORITY_PROBLEMATIC,
    PRIORITY_MOST_VOLUMINOUS, PRIORITY_LEAST_VOLUMINOUS,
    PRIORITY_MOST_CONNECTED, PRIORITY_LEAST_CONNECTED,
];

static PARAMS: &[crate::repair::params::StrategyParam] = &[
    crate::repair::params::StrategyParam {
        id: PARAM_PRIORITY,
        label: "Fix priority",
        kind: crate::repair::params::StrategyParamKind::Enum { options: SPLIT_PRIORITY_OPTIONS, default: PRIORITY_PROBLEMATIC },
    },
];

/// Slot id for the nested strategy this strategy delegates each candidate node's actual removal
/// to — `RemoveSplitStrategy`, the only `INVALID_SPLIT_TILE`-handling strategy.
pub const SLOT_FIX_TARGET: &str = "fix_target";

static NESTED_SLOTS: &[NestedSlot] = &[
    NestedSlot { slot_id: SLOT_FIX_TARGET, kind: INVALID_SPLIT_TILE, min: 1, max: Some(1) },
];

/// Handles `INVALID_SPLIT_TILE_GROUP` — see GitHub issue #249, epic #246. Not tied to any one
/// producing check: `MaxSplitCountCheck`/`MaxSplitDensityCheck` (field-wide excess) and
/// `SplitGroupGeometricProximityCheck`/`SplitGroupGraphProximityCheck` (too-close tile pairs) all
/// emit the same `groups: Vec<(Vec<NodeId>, u32)>` shape, and this strategy handles any of them
/// uniformly, mirroring `OneWayGroupSelectStrategy`'s role.
///
/// `apply()`'s own candidate-pass/budget/nested-delegation mechanics are `group_select::
/// group_select_apply`, shared with every other `InvalidGroupIssue<K>` select strategy — see that
/// function's doc comment. This strategy's own remaining responsibility is resolving
/// `SLOT_FIX_TARGET`/`INVALID_SPLIT_TILE` from `nested` and supplying `build_nested_issue`/
/// `element_invalidated`/`order_by_priority(params)`.
///
/// Every candidate is a whole `SplitTileNodes` — *every* node at that point, slot-0 included (see
/// GitHub issue #249's regression fix: the candidate unit is the tile, not any one of its
/// individual nodes, so a single fix always collapses one whole tile rather than picking nodes
/// across different tiles). There is no route-protection concept here (unlike one-way/teleport
/// groups): a whole tile's collapse feasibility is entirely `RemoveSplitStrategy`'s/
/// `ReplacePointNodes`'s own job at apply time (preset locks block the whole tile, all-or-nothing
/// — issue #281), so `element_allowed` always returns `true`.
pub struct SplitGroupSelectStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitTileGroupIssue> for SplitGroupSelectStrategy {
    fn strategy_id(&self) -> &'static str { "split_group_select" }

    fn params(&self) -> &'static [crate::repair::params::StrategyParam] {
        PARAMS
    }

    fn expected_nested(&self) -> &'static [NestedSlot] {
        NESTED_SLOTS
    }

    fn apply(
        &self,
        issue: &InvalidSplitTileGroupIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let matching: Vec<&NestedStrategyConfig<T>> =
            nested.iter().filter(|n| n.slot.slot_id == SLOT_FIX_TARGET).collect();
        debug_assert!(matching.len() <= 1,
            "SplitGroupSelectStrategy: expected_nested()'s max: Some(1) for slot \"{SLOT_FIX_TARGET}\" should prevent more than one nested strategy filling it");
        let Some(&fix_target) = matching.first() else {
            if issue.groups.is_empty() {
                return (RepairResult::Fixed { score: None }, vec![]);
            }
            return (RepairResult::Failed, vec![]);
        };

        let build_nested_issue = |source_check: &str, target: &SplitTileNodes, _others: &[SplitTileNodes]| -> Box<dyn crate::quality_control::Issue> {
            Box::new(InvalidSplitTileIssue::new_from_check(source_check, vec![target.clone()]))
        };
        let order_candidates = |candidates: &mut Vec<SplitTileNodes>, membership: &HashMap<SplitTileNodes, usize>, rng: &mut dyn RngCore| {
            let priority = match params.get(PARAM_PRIORITY) {
                Some(crate::repair::params::StrategyParamValue::Enum(v)) => v.as_str(),
                _ => PRIORITY_PROBLEMATIC,
            };
            // Shuffle first regardless of priority, same rationale as `order_by_priority` --
            // ties (equal volume/connectivity/membership) then resolve randomly, not by
            // incidental `HashMap` iteration order.
            candidates.shuffle(rng);
            match priority {
                PRIORITY_PROBLEMATIC => candidates.sort_by_key(|c| std::cmp::Reverse(membership.get(c).copied().unwrap_or(0))),
                PRIORITY_MOST_VOLUMINOUS => candidates.sort_by_key(|c| std::cmp::Reverse(c.0.len())),
                PRIORITY_LEAST_VOLUMINOUS => candidates.sort_by_key(|c| c.0.len()),
                PRIORITY_MOST_CONNECTED | PRIORITY_LEAST_CONNECTED => {
                    // Precompute incoming-degree once (O(E)) rather than re-scanning every graph
                    // edge per node inside the sort comparator (O(candidates * tile_nodes * E) --
                    // `Graph` has no incoming-edge index of its own, see `tile_connectivity`).
                    let incoming_degree = incoming_degree_map(maze);
                    let connectivity = |c: &SplitTileNodes| tile_connectivity(maze, &incoming_degree, c);
                    if priority == PRIORITY_MOST_CONNECTED {
                        candidates.sort_by_key(|c| std::cmp::Reverse(connectivity(c)));
                    } else {
                        candidates.sort_by_key(connectivity);
                    }
                }
                _ => {} // PRIORITY_RANDOM: shuffle above is already the final order.
            }
        };
        // No other still-live candidate tile can ever be invalidated by resolving this one --
        // `RemoveSplitStrategy` collapses exactly one point (`MutationCommand::ReplacePointNodes`
        // keyed by that point's own `at`), and distinct `SplitTileNodes` candidates are always
        // different points' node sets, so they never overlap. `group_select_apply`'s own
        // "target always counts as invalidated" rule already retires this tile's own budget --
        // this hook has nothing left to add.
        let element_invalidated = |_tile: &SplitTileNodes, _nested_commands: &[MutationCommand], _maze: &Maze<T>| false;

        group_select_apply::<T, SplitGroupKind>(issue, maze, rng, preset_state, fix_target, |_| true, build_nested_issue, element_invalidated, order_candidates)
    }
}

/// Every node's incoming-edge count, computed once in a single O(E) pass over the graph --
/// `Graph` only indexes outgoing edges, so an incoming count otherwise means scanning every edge
/// per query; precomputing this map turns `tile_connectivity`'s per-node lookup into O(1).
fn incoming_degree_map<T: Tessellation>(maze: &Maze<T>) -> HashMap<crate::ids::NodeId, usize> {
    let mut degree = HashMap::new();
    for edge in maze.graph.edges() {
        *degree.entry(edge.to).or_insert(0usize) += 1;
    }
    degree
}

/// Total incident edge count (both directions, every node of the tile including slot-0 — see the
/// epic #246 doc comment) across every node in `tile` — the "connectivity" `PRIORITY_MOST_CONNECTED`/
/// `PRIORITY_LEAST_CONNECTED` sort by.
fn tile_connectivity<T: Tessellation>(maze: &Maze<T>, incoming_degree: &HashMap<crate::ids::NodeId, usize>, tile: &SplitTileNodes) -> usize {
    tile.0.iter().map(|&node| {
        maze.graph.outgoing_edges(node).count() + incoming_degree.get(&node).copied().unwrap_or(0)
    }).sum()
}

crate::impl_erased_repair_strategy!(SplitGroupSelectStrategy, InvalidSplitTileGroupIssue);

#[cfg(test)]
#[path = "split_group_select_tests.rs"]
mod tests;
