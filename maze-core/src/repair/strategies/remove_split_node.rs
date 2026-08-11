use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::quality_control::InvalidSplitNodeIssue;
use crate::generation::PresetState;
use crate::repair::params::{StrategyParam, StrategyParamKind, StrategyParamValue, StrategyParams};
use crate::repair::result::RepairResult;
use crate::repair::strategy::{RepairStrategy, NestedStrategyConfig};
use crate::repair::command::MutationCommand;

pub const PARAM_REDISTRIBUTE: &str = "redistribute";

static PARAMS: &[StrategyParam] = &[
    StrategyParam {
        id: PARAM_REDISTRIBUTE,
        label: "Redistribute connections to another node of the same split",
        kind: StrategyParamKind::Bool { default: true },
    },
];

/// Handles `INVALID_SPLIT_NODE` — see GitHub issue #250, epic #246. Removes each flagged split
/// node entirely (`MutationCommand::RemoveNode`) — never a tile's last remaining node, mirroring
/// the hard constraint every strategy in this epic shares (`remove_node_feasible` never allows it,
/// same as `RemoveSplitStrategy`); a check flagging a node that happens to be the tile's last one
/// simply has that entry declined here, rather than being special-cased out up front.
///
/// `redistribute` (default `true`): what happens to the removed node's own connections.
/// - `false`: the node's edges simply disappear along with it (`RemoveNode` already clears every
///   incident edge, both directions).
/// - `true`: before removing the node, this strategy proposes an equivalent edge/teleport (same
///   `EdgeKind`, same direction) for every one of the removed node's incident edges, each
///   independently redirected to/from a node picked uniformly at random from the other remaining
///   nodes of the same split (any node still at the point after this node is gone, on equal
///   footing regardless of slot). The candidate pool excludes every other node this same `issue`
///   flags *and* that is actually feasible to remove (`remove_node_feasible`) — those get their
///   own `RemoveNode` command later in this same batch, which would immediately wipe out any edge
///   just redistributed onto them (`RemoveNode` clears every incident edge). A node merely flagged
///   but not actually removable (the tile's last remaining node, or a preset-protected sibling) is
///   *not* excluded — it's never touched by any `RemoveNode` in this batch, so it remains a
///   perfectly safe target. Edges are grouped by (neighbor, `EdgeKind`) before picking a target —
///   a bidirectional passage (forward + reverse edge to the same neighbor) redistributes onto one
///   shared randomly-picked target, not two independently-drawn ones (GitHub issue #276), so a
///   physical two-way connection is never silently split into two one-ways to different siblings.
///   Different (neighbor, kind) groups still draw independent targets — a multi-edge removed
///   node's connections scatter across the remaining siblings rather than all landing on one. An
///   edge that would connect its target to itself (the sibling edge between the removed node and
///   that particular target, if any) is skipped — a self-loop is never proposed. Each redistribution
///   command is independently revalidated by `apply_commands` same as any other (e.g. dropped if
///   it duplicates an edge the target already has), so this is "best-effort preservation," not a
///   guarantee. An empty candidate pool (every other node at the point is both flagged and
///   feasible) simply drops that edge's redistribution — a tile always keeping at least one
///   removal-ineligible node makes this practically unreachable, but the code path (`pick_random`
///   returning `None`) is handled, not assumed impossible.
pub struct RemoveSplitNodeStrategy;

impl<T: Tessellation> RepairStrategy<T, InvalidSplitNodeIssue> for RemoveSplitNodeStrategy {
    fn strategy_id(&self) -> &'static str { "remove_split_node" }

    fn params(&self) -> &'static [StrategyParam] {
        PARAMS
    }

    fn apply(
        &self,
        issue: &InvalidSplitNodeIssue,
        maze: &Maze<T>,
        rng: &mut dyn RngCore,
        params: &StrategyParams,
        preset_state: &PresetState,
        _nested: &[NestedStrategyConfig<T>],
    ) -> (RepairResult, Vec<MutationCommand>) {
        let redistribute = matches!(params.get(PARAM_REDISTRIBUTE), Some(StrategyParamValue::Bool(true)));

        let mut commands = Vec::new();
        let mut any_removable = false;
        for &node in &issue.invalid {
            // `remove_node_feasible` is the exact predicate `try_remove_node` uses at apply time
            // (preset locks/edges, never a tile's last remaining node) -- checked here up front so
            // this strategy's own `Fixed`/`Failed` verdict agrees with whether `RemoveNode` will
            // actually be applied, same "declined command must not silently count as fixed"
            // rationale as `RemoveSplitStrategy`. This also naturally declines a flagged entry that
            // happens to be the tile's last remaining node.
            if !crate::generation::remove_node_feasible(&maze.field, preset_state, node) {
                continue;
            }
            let level = maze.field.level_of(node).expect("remove_node_feasible confirmed this node exists");
            let point = maze.field.point_of(node).expect("remove_node_feasible confirmed this node exists");
            any_removable = true;

            if redistribute {
                // Exclude every other node this same issue flags *and* that will actually be
                // removed later in this batch (i.e. also passes remove_node_feasible) -- each of
                // those gets its own RemoveNode command later on, which clears all of its incident
                // edges, including one just redistributed onto it here. A node merely flagged but
                // declined (e.g. the tile's last remaining node, which a check may legitimately
                // flag like any other split node, or a preset-protected sibling) is never actually
                // removed and remains a perfectly safe target -- excluding it too would wrongly
                // shrink the candidate pool, even to empty for a 2-node split whose only other node
                // is a flagged-but-undeletable last remaining node.
                let siblings: Vec<NodeId> = maze.field.nodes_at(level, point).iter().copied()
                    .filter(|&n| n != node)
                    .filter(|&n| !issue.invalid.contains(&n) || !crate::generation::remove_node_feasible(&maze.field, preset_state, n))
                    .collect();
                // Edges are grouped by (neighbor, kind) before picking a target -- a bidirectional
                // passage (forward + reverse edge, same neighbor, same kind) must redistribute onto
                // one shared randomly-picked target, not two independently-drawn ones, or a single
                // physical two-way connection would silently split into two one-ways to different
                // siblings (GitHub issue #276). Different (neighbor, kind) groups still draw
                // independent targets, so a multi-edge removed node's connections still spread
                // across the remaining siblings rather than all landing on one.
                let mut groups: std::collections::BTreeMap<(NodeId, EdgeKind), Vec<(NodeId, NodeId)>> = std::collections::BTreeMap::new();
                for edge in maze.graph.edges().filter(|e| e.from == node || e.to == node) {
                    let neighbor = if edge.from == node { edge.to } else { edge.from };
                    groups.entry((neighbor, edge.kind)).or_default().push((edge.from, edge.to));
                }
                for ((_, kind), dirs) in groups {
                    let Some(&target) = pick_random(&siblings, rng) else { continue };
                    for (from, to) in dirs {
                        let (from, to) = if from == node { (target, to) } else { (from, target) };
                        if from == to { continue; } // the sibling edge to/from the chosen target itself
                        commands.push(match kind {
                            EdgeKind::Basic => MutationCommand::AddDirectedEdge { from, to },
                            EdgeKind::Teleport => MutationCommand::AddDirectedTeleport { from, to },
                        });
                    }
                }
            }
            commands.push(MutationCommand::RemoveNode { node });
        }

        // Every flagged node failed remove_node_feasible (already removed by an earlier command in
        // this same batch, a stale issue, the tile's last remaining node, or preset-protected) --
        // nothing could be fixed, same "Failed if nothing could be fixed" rationale as
        // RemoveSplitStrategy/OneWayToWallStrategy.
        let result = if issue.invalid.is_empty() || any_removable {
            RepairResult::Fixed { score: None }
        } else {
            RepairResult::Failed
        };
        (result, commands)
    }
}

/// Picks one element uniformly at random from `slice`, or `None` if empty.
fn pick_random<'a, X>(slice: &'a [X], rng: &mut dyn RngCore) -> Option<&'a X> {
    if slice.is_empty() {
        return None;
    }
    let idx = (rng.next_u32() as usize) % slice.len();
    slice.get(idx)
}

crate::impl_erased_repair_strategy!(RemoveSplitNodeStrategy, InvalidSplitNodeIssue);

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::random::MazeRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::repair::params::build_params;
    use crate::repair::strategies::test_utils::apply_and_commit;

    fn no_params() -> StrategyParams {
        build_params(<RemoveSplitNodeStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeIssue>>::params(&RemoveSplitNodeStrategy), None)
    }

    fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
        let mut map = std::collections::HashMap::new();
        for &(k, v) in overrides {
            map.insert(k.to_string(), v.to_string());
        }
        build_params(<RemoveSplitNodeStrategy as RepairStrategy<SquareTessellation, InvalidSplitNodeIssue>>::params(&RemoveSplitNodeStrategy), Some(&map))
    }

    fn maze_with_split_node() -> (Maze<SquareTessellation>, NodeId, NodeId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let left = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
        let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
        g.add_bidirectional_edge(extra, right, EdgeKind::Basic);
        let maze = Maze::new(field, g);
        (maze, slot0, extra)
    }

    #[test]
    fn apply_without_redistribute_removes_the_node_and_its_edges() {
        let (mut maze, _slot0, extra) = maze_with_split_node();
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none(), "extra node must be gone from the field");
        assert!(!maze.graph.edges().any(|e| e.from == extra || e.to == extra), "extra node's edges must be gone");
    }

    #[test]
    fn apply_never_removes_slot0_when_it_is_the_last_node() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        // slot0 is the point's only node here -- RemoveNode must be declined by
        // try_remove_node's own feasibility check, same as any other last-remaining node would be.
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![slot0]);
        let mut rng = MazeRng::seed_from_u64(1);
        apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);

        assert!(maze.field.point_of(slot0).is_some(), "a point's last remaining node must never be removed");
    }

    #[test]
    fn apply_removes_slot0_when_a_sibling_remains() {
        let (mut maze, slot0, _extra) = maze_with_split_node();
        // Slot-0 is no longer special: with a sibling (extra) still at the point, slot0 is just
        // as removable as any other split node.
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![slot0]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(slot0).is_none(), "slot0 must be removed since it isn't the point's last remaining node");
    }

    #[test]
    fn apply_with_redistribute_reconnects_the_removed_nodes_neighbor_to_the_sibling() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let right = maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap();
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none());
        // Only sibling is slot0 (2-node split), so redistribution must land there deterministically.
        assert!(maze.graph.edge_between(slot0, right).is_some(), "the only sibling (slot0) must inherit the removed node's connection");
        assert!(maze.graph.edge_between(right, slot0).is_some(), "both directions of the redistributed bidirectional edge must land");
    }

    #[test]
    fn apply_with_redistribute_picks_among_multiple_siblings() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra1 = field.add_node_at(level, p, &mut ids);
        let extra2 = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(7);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra1).is_none());
        // Exactly one of slot0/extra2 must have inherited the connection to `right`.
        let slot0_has = maze.graph.edge_between(slot0, right).is_some();
        let extra2_has = maze.graph.edge_between(extra2, right).is_some();
        assert!(slot0_has ^ extra2_has, "exactly one sibling (slot0 or extra2) must inherit the connection, not both or neither");
    }

    #[test]
    fn apply_with_redistribute_picks_an_independent_target_per_edge() {
        // The removed node has two separate bidirectional connections (to different neighbors) --
        // each (neighbor, kind) group must draw its own random target, not one target shared
        // across the whole node, so a multi-edge removal can scatter its connections across
        // different remaining siblings instead of funneling them all onto one.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra1 = field.add_node_at(level, p, &mut ids);
        let extra2 = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let right1 = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        let right2 = field.node_at(level, SquarePoint { x: 3, y: 0 }).unwrap();
        g.add_bidirectional_edge(extra1, right1, EdgeKind::Basic);
        g.add_bidirectional_edge(extra1, right2, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        // Seed chosen so the two edges land on different siblings -- asserts the split actually
        // happened rather than merely being possible.
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra1).is_none());
        let right1_target = if maze.graph.edge_between(slot0, right1).is_some() { Some(slot0) } else if maze.graph.edge_between(extra2, right1).is_some() { Some(extra2) } else { None };
        let right2_target = if maze.graph.edge_between(slot0, right2).is_some() { Some(slot0) } else if maze.graph.edge_between(extra2, right2).is_some() { Some(extra2) } else { None };
        assert!(right1_target.is_some(), "right1's connection must have been redistributed to some sibling");
        assert!(right2_target.is_some(), "right2's connection must have been redistributed to some sibling");
        assert_ne!(right1_target, right2_target, "the two edges must have drawn independent random targets and landed on different siblings for this seed");
    }

    #[test]
    fn apply_with_redistribute_keeps_a_bidirectional_passage_on_one_shared_target() {
        // Regression for GitHub issue #276: a bidirectional passage (forward + reverse edge to the
        // same neighbor) must redistribute onto one shared randomly-picked target -- not have each
        // direction independently draw its own target, which would silently split one physical
        // two-way connection into two one-ways to different siblings.
        // Try every seed in a small range -- with the bug present, at least one would show the
        // forward and reverse edges landing on different siblings (slot0 vs extra2).
        for seed in 0..50u64 {
            let mut ids = IdGenerator::new();
            let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
            let p = SquarePoint { x: 1, y: 0 };
            let slot0 = field.node_at(level, p).unwrap();
            let extra1 = field.add_node_at(level, p, &mut ids);
            let extra2 = field.add_node_at(level, p, &mut ids);
            let mut g = Graph::new();
            for node in field.all_node_ids() { g.add_node(node); }
            let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
            g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
            let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

            let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1]);
            let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
            let mut rng = MazeRng::seed_from_u64(seed);
            let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
            assert!(matches!(result, RepairResult::Fixed { score: None }));

            let forward_target = if maze.graph.edge_between(slot0, right).is_some() { Some(slot0) } else if maze.graph.edge_between(extra2, right).is_some() { Some(extra2) } else { None };
            let reverse_target = if maze.graph.edge_between(right, slot0).is_some() { Some(slot0) } else if maze.graph.edge_between(right, extra2).is_some() { Some(extra2) } else { None };
            assert_eq!(forward_target, reverse_target, "seed {seed}: both directions of the bidirectional passage must land on the same sibling");
        }
    }

    #[test]
    fn apply_with_redistribute_never_targets_another_node_flagged_in_the_same_batch() {
        // Regression: a 3-node split with both extra nodes flagged in the same issue. If extra1's
        // redistribute picked extra2 as a target, extra2's own later RemoveNode command would wipe
        // that just-added edge out again (RemoveNode clears every incident edge). The only safe
        // target is slot0, which survives the whole batch.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra1 = field.add_node_at(level, p, &mut ids);
        let extra2 = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1, extra2]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra1).is_none());
        assert!(maze.field.point_of(extra2).is_none());
        assert!(maze.graph.edge_between(slot0, right).is_some(), "slot0 is the only sibling that survives the whole batch, so it must inherit the connection");
        assert!(maze.graph.edge_between(right, slot0).is_some());
    }

    #[test]
    fn apply_with_redistribute_when_both_nodes_of_a_2node_split_are_flagged() {
        // A 2-node split (slot0 + extra) where both are flagged: `apply` evaluates
        // remove_node_feasible for every entry against the pre-batch field, so both look feasible
        // up front (each still sees the other as a live sibling) and both get their own RemoveNode
        // command, with an empty redistribute pool each (their only sibling is the other flagged
        // node). `apply_commands` revalidates each command against the actually-mutated field in
        // order: the first RemoveNode succeeds, leaving the point with one node; the second is
        // declined by `remove_node_feasible` since that remaining node is now the point's last one.
        let (mut maze, slot0, extra) = maze_with_split_node();
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra, slot0]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none(), "extra is processed first and actually removed");
        assert!(maze.field.point_of(slot0).is_some(), "slot0's own RemoveNode is declined once it becomes the point's last remaining node");
    }

    #[test]
    fn pick_random_returns_none_for_an_empty_slice() {
        // `apply`'s redistribute loop relies on this returning None (and simply skipping that
        // edge, no panic) whenever a removed node's sibling pool is empty.
        let empty: [NodeId; 0] = [];
        let mut rng = MazeRng::seed_from_u64(1);
        assert!(pick_random(&empty, &mut rng).is_none());
    }

    #[test]
    fn apply_with_redistribute_skips_the_sibling_edge_to_the_target_itself() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        // The only edge on `extra` is its sibling edge to slot0 -- redistributing it (target =
        // slot0, the only sibling) would be a self-loop, which must never be proposed.
        g.add_bidirectional_edge(slot0, extra, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        assert!(maze.field.point_of(extra).is_none());
        assert!(maze.graph.edge_between(slot0, slot0).is_none(), "must never create a self-loop on the target");
    }

    #[test]
    fn apply_with_redistribute_preserves_teleport_kind() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
            let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let far = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_edge(extra, far, EdgeKind::Teleport);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(1);
        apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);

        assert!(maze.graph.edges().any(|e| e.from == slot0 && e.to == far && e.kind == EdgeKind::Teleport),
            "redistributed edge must keep the Teleport kind, not silently downgrade to Basic");
    }

    #[test]
    fn apply_reports_failed_when_the_only_flagged_node_is_preset_protected() {
        let (mut maze, slot0, extra) = maze_with_split_node();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((extra, maze.field.node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 }).unwrap()));
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
        assert!(matches!(result, RepairResult::Failed));
        assert!(maze.field.point_of(extra).is_some(), "preset-protected node must survive");
        let _ = slot0;
    }

    #[test]
    fn apply_succeeds_on_empty_invalid_list() {
        let (mut maze, _slot0, _extra) = maze_with_split_node();
        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![]);
        let mut rng = MazeRng::seed_from_u64(1);
        let result = apply_and_commit(&RemoveSplitNodeStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
        assert!(matches!(result, RepairResult::Fixed { score: None }));
    }
}
