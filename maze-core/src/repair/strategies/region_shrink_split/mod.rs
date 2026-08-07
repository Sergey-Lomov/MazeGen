use std::collections::{HashMap, HashSet, VecDeque};
use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::RegionNeedsShrinkIssue;
use crate::generation::PresetState;
use crate::graph::bisect::{group_by_unremovable_edges, farthest_pair_across_groups};
use crate::graph::route_protection::is_edge_on_route;
use crate::repair::params::{StrategyParam, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

#[cfg(test)]
mod tests;

/// Handles `REGION_NEEDS_SHRINK` — see GitHub issue #184 (follow-up to issue #181). Splits an
/// oversized SCC region into two, as close to equal size as possible, by cutting the edges that
/// cross a computed boundary between two grown halves.
///
/// **Algorithm** (see `Specs/repair.md` for the full write-up):
/// 1. Group the region's nodes by every edge that must never be cut (preset-protected, and — when
///    `protect_route` is enabled — on the current start->finish route) —
///    `graph::bisect::group_by_unremovable_edges`. Two nodes in the same group can never end up on
///    opposite sides of the split.
/// 2. If the whole region collapsed into a single group, it cannot be split at all — `Failed`.
/// 3. Pick two seed nodes from different groups, as far apart as possible (double-BFS heuristic,
///    `graph::bisect::farthest_pair_across_groups`).
/// 4. Grow two sets from those seeds, one whole group at a time (never splitting a group across
///    sides), always extending whichever side is currently smaller — a balance-greedy multi-source
///    BFS over the region's group-contraction graph.
/// 5. Cut every edge (either direction) that ends up crossing between the two final sets — safe by
///    construction, since a group-crossing edge was never grouped as unremovable.
///
/// `protect_route` (GitHub issue #253) is a rule-level parameter, resolved once by the factory
/// (`maze-runner`'s `build_rule_for!`) from `RuleParams` — not a per-strategy `StrategyParam`
/// anymore, so it has no local override. Never a nested-strategy target (its own `NestedSlot`
/// list is empty, and no other strategy's slot ever names `REGION_NEEDS_SHRINK`), so it is only
/// ever constructed at a rule's top level, where the factory has a `RuleParams` in hand.
pub struct RegionShrinkSplitStrategy {
    pub protect_route: bool,
}

impl<T: Tessellation> RepairStrategy<T, RegionNeedsShrinkIssue> for RegionShrinkSplitStrategy {
    fn strategy_id(&self) -> &'static str { "region_shrink_split" }

    fn params(&self) -> &'static [StrategyParam] {
        &[]
    }

    fn apply(
        &self,
        issue: &RegionNeedsShrinkIssue,
        maze: &Maze<T>,
        _rng: &mut dyn RngCore,
        _params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        if issue.invalid.is_empty() {
            return (RepairResult::Fixed { score: None }, vec![]);
        }

        let protect_route = self.protect_route;

        let scc = maze.analysis.scc(&maze.graph);
        let mut commands = Vec::new();
        let mut any_fixed = false;

        for &region_idx in &issue.invalid {
            let Some(region) = scc.components.get(region_idx) else { continue };
            if let Some(cut_edges) = split_region(maze, region, preset_state, protect_route) {
                for (from, to) in cut_edges {
                    let Some(id) = maze.graph.edge_between(from, to) else { continue };
                    commands.push(MutationCommand::RemoveEdgeWithReverse { id });
                }
                any_fixed = true;
            }
        }

        if any_fixed {
            (RepairResult::Fixed { score: None }, commands)
        } else {
            (RepairResult::Failed, vec![])
        }
    }
}

crate::impl_erased_repair_strategy!(RegionShrinkSplitStrategy, RegionNeedsShrinkIssue);

/// Whether `from -> to` must never be cut: always true for a preset (Basic) connection; true for a
/// hop on the maze's current start->finish route only when `protect_route` is enabled.
fn is_unremovable<T: Tessellation>(maze: &Maze<T>, preset_state: &PresetState, protect_route: bool, from: NodeId, to: NodeId) -> bool {
    if preset_state.preset_edges.contains(&(from, to)) {
        return true;
    }
    if !protect_route {
        return false;
    }
    let Some(id) = maze.graph.edge_between(from, to) else { return false };
    is_edge_on_route(maze, id)
}

/// Computes the split for one oversized region: which edges (as `(from, to)` pairs, both
/// directions of a crossing passage included so the caller can resolve each to a real `EdgeId` at
/// commit time) to cut so the region falls into two roughly-balanced parts. `None` if the region
/// is a single unremovable-edges group (cannot be split at all).
fn split_region<T: Tessellation>(
    maze: &Maze<T>,
    region: &[NodeId],
    preset_state: &PresetState,
    protect_route: bool,
) -> Option<Vec<(NodeId, NodeId)>> {
    let groups = group_by_unremovable_edges(
        &maze.graph,
        region,
        |a, b| is_unremovable(maze, preset_state, protect_route, a, b),
    );
    if groups.len() < 2 {
        return None;
    }

    let (seed_a, seed_b) = farthest_pair_across_groups(&maze.graph, &groups)?;
    let group_key_of: HashMap<NodeId, NodeId> = groups.iter()
        .flat_map(|(&key, members)| members.iter().map(move |&n| (n, key)))
        .collect();
    let seed_a_key = group_key_of[&seed_a];
    let seed_b_key = group_key_of[&seed_b];

    let side_a = grow_balanced_sides(&maze.graph, region, &groups, &group_key_of, seed_a_key, seed_b_key);

    let region_set: HashSet<NodeId> = region.iter().copied().collect();
    let side_a_set: HashSet<NodeId> = side_a.iter().copied().collect();
    let mut cut: Vec<(NodeId, NodeId)> = Vec::new();
    for &node in region {
        let node_in_a = side_a_set.contains(&node);
        for neighbor in maze.graph.outgoing_neighbors(node) {
            if !region_set.contains(&neighbor) {
                continue; // edge leaves the region entirely — not this split's concern
            }
            let neighbor_in_a = side_a_set.contains(&neighbor);
            if node_in_a != neighbor_in_a {
                cut.push((node, neighbor));
            }
        }
    }

    if cut.is_empty() {
        return None; // defensive: no boundary found, nothing would actually split
    }
    Some(cut)
}

/// Grows two sets of region-nodes from `seed_a_key`/`seed_b_key`'s groups, one whole group at a
/// time, always extending whichever side currently has fewer nodes (balance-greedy) — a
/// multi-source BFS over the contraction graph where each unremovable-edges group is one vertex.
/// Returns the final node set for side "a" (every other region node belongs to side "b").
fn grow_balanced_sides(
    graph: &crate::graph::Graph,
    region: &[NodeId],
    groups: &HashMap<NodeId, Vec<NodeId>>,
    group_key_of: &HashMap<NodeId, NodeId>,
    seed_a_key: NodeId,
    seed_b_key: NodeId,
) -> Vec<NodeId> {
    let region_set: HashSet<NodeId> = region.iter().copied().collect();

    // side: false = unassigned, Some(true) = side a, Some(false) = side b.
    let mut side: HashMap<NodeId, bool> = HashMap::new();
    side.insert(seed_a_key, true);
    side.insert(seed_b_key, false);

    let mut queue_a: VecDeque<NodeId> = VecDeque::from([seed_a_key]);
    let mut queue_b: VecDeque<NodeId> = VecDeque::from([seed_b_key]);
    let mut size_a = groups[&seed_a_key].len();
    let mut size_b = groups[&seed_b_key].len();

    let group_neighbors = |key: NodeId| -> Vec<NodeId> {
        let mut neighbor_keys: HashSet<NodeId> = HashSet::new();
        for &member in &groups[&key] {
            let all_neighbors = graph.outgoing_neighbors(member).chain(graph.incoming_neighbors(member));
            for neighbor in all_neighbors {
                if !region_set.contains(&neighbor) {
                    continue;
                }
                let neighbor_key = group_key_of[&neighbor];
                if neighbor_key != key {
                    neighbor_keys.insert(neighbor_key);
                }
            }
        }
        neighbor_keys.into_iter().collect()
    };

    // Tries to claim exactly one new group for the given side from its BFS frontier — pops
    // frontier entries until one yields an unassigned neighbor (a fully-claimed entry is dropped
    // for good, its remaining neighbors already covered by construction) or the frontier empties.
    // Returns whether a group was claimed.
    fn claim_one(
        queue: &mut VecDeque<NodeId>,
        is_a: bool,
        side: &mut HashMap<NodeId, bool>,
        groups: &HashMap<NodeId, Vec<NodeId>>,
        group_neighbors: &impl Fn(NodeId) -> Vec<NodeId>,
        size: &mut usize,
    ) -> bool {
        while let Some(&key) = queue.front() {
            let mut neighbor_keys = group_neighbors(key);
            neighbor_keys.sort_unstable();
            if let Some(&next_key) = neighbor_keys.iter().find(|k| !side.contains_key(k)) {
                side.insert(next_key, is_a);
                *size += groups[&next_key].len();
                queue.push_back(next_key);
                return true;
            }
            queue.pop_front(); // exhausted: every neighbor of `key` is already assigned
        }
        false
    }

    while side.len() < groups.len() {
        let take_a = size_a <= size_b;
        let claimed = if take_a {
            claim_one(&mut queue_a, true, &mut side, groups, &group_neighbors, &mut size_a)
        } else {
            claim_one(&mut queue_b, false, &mut side, groups, &group_neighbors, &mut size_b)
        };
        if !claimed {
            // Preferred side's frontier is exhausted; let the other side try instead. If both
            // frontiers are exhausted the region wasn't group-connected (shouldn't happen for a
            // real SCC region) — the leftover-group fallback below handles it.
            let other_claimed = if take_a {
                claim_one(&mut queue_b, false, &mut side, groups, &group_neighbors, &mut size_b)
            } else {
                claim_one(&mut queue_a, true, &mut side, groups, &group_neighbors, &mut size_a)
            };
            if !other_claimed {
                break;
            }
        }
    }

    // Any group never reached by either frontier (region wasn't group-connected — shouldn't
    // happen for a real SCC region, but defensively assign by proximity-agnostic fallback to the
    // smaller side) goes to whichever side is currently smaller.
    for &key in groups.keys() {
        side.entry(key).or_insert_with(|| size_a <= size_b);
    }

    groups.iter()
        .filter(|(key, _)| side[key])
        .flat_map(|(_, members)| members.iter().copied())
        .collect()
}
