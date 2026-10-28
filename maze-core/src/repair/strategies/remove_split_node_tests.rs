use super::*;
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::sync::Arc;

fn no_params() -> StrategyParams {
    build_params(
        <RemoveSplitNodeStrategy as RepairStrategy<
            SquareTessellation,
            InvalidSplitNodeIssue,
        >>::params(&RemoveSplitNodeStrategy),
        None,
    )
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(
        <RemoveSplitNodeStrategy as RepairStrategy<
            SquareTessellation,
            InvalidSplitNodeIssue,
        >>::params(&RemoveSplitNodeStrategy),
        Some(&map),
    )
}

fn maze_with_split_node() -> (Maze<SquareTessellation>, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
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
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.field.cell_of(extra).is_none(),
        "extra node must be gone from the field"
    );
    assert!(
        !maze.graph.edges().any(|e| e.from == extra || e.to == extra),
        "extra node's edges must be gone"
    );
}

#[test]
fn apply_never_removes_slot0_when_it_is_the_last_node() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    // slot0 is the point's only node here -- RemoveNode must be declined by
    // try_remove_node's own feasibility check, same as any other last-remaining node would be.
    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![slot0]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    assert!(
        maze.field.cell_of(slot0).is_some(),
        "a point's last remaining node must never be removed"
    );
}

#[test]
fn apply_removes_slot0_when_a_sibling_remains() {
    let (mut maze, slot0, _extra) = maze_with_split_node();
    // Slot-0 is no longer special: with a sibling (extra) still at the point, slot0 is just
    // as removable as any other split node.
    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![slot0]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.field.cell_of(slot0).is_none(),
        "slot0 must be removed since it isn't the point's last remaining node"
    );
}

#[test]
fn apply_with_redistribute_reconnects_the_removed_nodes_neighbor_to_the_sibling() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let right = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 })
        .unwrap();
    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
    let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.cell_of(extra).is_none());
    // Only sibling is slot0 (2-node split), so redistribution must land there deterministically.
    assert!(
        maze.graph.edge_between(slot0, right).is_some(),
        "the only sibling (slot0) must inherit the removed node's connection"
    );
    assert!(
        maze.graph.edge_between(right, slot0).is_some(),
        "both directions of the redistributed bidirectional edge must land"
    );
}

#[test]
fn apply_with_redistribute_picks_among_multiple_siblings() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra1 = field.add_node_at(level, p, &mut ids);
    let extra2 = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
    g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1]);
    let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
    let mut rng = MazeRng::seed_from_u64(7);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.cell_of(extra1).is_none());
    // Exactly one of slot0/extra2 must have inherited the connection to `right`.
    let slot0_has = maze.graph.edge_between(slot0, right).is_some();
    let extra2_has = maze.graph.edge_between(extra2, right).is_some();
    assert!(
        slot0_has ^ extra2_has,
        "exactly one sibling (slot0 or extra2) must inherit the connection, not both or neither"
    );
}

#[test]
fn apply_with_redistribute_picks_an_independent_target_per_edge() {
    // The removed node has two separate bidirectional connections (to different neighbors) --
    // each (neighbor, kind) group must draw its own random target, not one target shared
    // across the whole node, so a multi-edge removal can scatter its connections across
    // different remaining siblings instead of funneling them all onto one.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra1 = field.add_node_at(level, p, &mut ids);
    let extra2 = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
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
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.cell_of(extra1).is_none());
    let right1_target = if maze.graph.edge_between(slot0, right1).is_some() {
        Some(slot0)
    } else if maze.graph.edge_between(extra2, right1).is_some() {
        Some(extra2)
    } else {
        None
    };
    let right2_target = if maze.graph.edge_between(slot0, right2).is_some() {
        Some(slot0)
    } else if maze.graph.edge_between(extra2, right2).is_some() {
        Some(extra2)
    } else {
        None
    };
    assert!(
        right1_target.is_some(),
        "right1's connection must have been redistributed to some sibling"
    );
    assert!(
        right2_target.is_some(),
        "right2's connection must have been redistributed to some sibling"
    );
    assert_ne!(
        right1_target, right2_target,
        "the two edges must have drawn independent random targets and landed on different siblings for this seed"
    );
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
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let p = SquarePoint { x: 1, y: 0 };
        let slot0 = field.node_at(level, p).unwrap();
        let extra1 = field.add_node_at(level, p, &mut ids);
        let extra2 = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
        g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1]);
        let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
        let mut rng = MazeRng::seed_from_u64(seed);
        let result = apply_and_commit(
            &RemoveSplitNodeStrategy,
            &issue,
            &mut maze,
            &mut rng,
            &params,
            &PresetState::empty(),
            &[],
        );
        assert!(matches!(result, RepairResult::Fixed { score: None }));

        let forward_target = if maze.graph.edge_between(slot0, right).is_some() {
            Some(slot0)
        } else if maze.graph.edge_between(extra2, right).is_some() {
            Some(extra2)
        } else {
            None
        };
        let reverse_target = if maze.graph.edge_between(right, slot0).is_some() {
            Some(slot0)
        } else if maze.graph.edge_between(right, extra2).is_some() {
            Some(extra2)
        } else {
            None
        };
        assert_eq!(
            forward_target, reverse_target,
            "seed {seed}: both directions of the bidirectional passage must land on the same sibling"
        );
    }
}

#[test]
fn apply_with_redistribute_never_targets_another_node_flagged_in_the_same_batch() {
    // Regression: a 3-node split with both extra nodes flagged in the same issue. If extra1's
    // redistribute picked extra2 as a target, extra2's own later RemoveNode command would wipe
    // that just-added edge out again (RemoveNode clears every incident edge). The only safe
    // target is slot0, which survives the whole batch.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra1 = field.add_node_at(level, p, &mut ids);
    let extra2 = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let right = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
    g.add_bidirectional_edge(extra1, right, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra1, extra2]);
    let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.cell_of(extra1).is_none());
    assert!(maze.field.cell_of(extra2).is_none());
    assert!(
        maze.graph.edge_between(slot0, right).is_some(),
        "slot0 is the only sibling that survives the whole batch, so it must inherit the connection"
    );
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
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(
        maze.field.cell_of(extra).is_none(),
        "extra is processed first and actually removed"
    );
    assert!(
        maze.field.cell_of(slot0).is_some(),
        "slot0's own RemoveNode is declined once it becomes the point's last remaining node"
    );
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
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    // The only edge on `extra` is its sibling edge to slot0 -- redistributing it (target =
    // slot0, the only sibling) would be a self-loop, which must never be proposed.
    g.add_bidirectional_edge(slot0, extra, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
    let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    assert!(maze.field.cell_of(extra).is_none());
    assert!(
        maze.graph.edge_between(slot0, slot0).is_none(),
        "must never create a self-loop on the target"
    );
}

#[test]
fn apply_with_redistribute_preserves_teleport_kind() {
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(level, p).unwrap();
    let extra = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let far = field.node_at(level, SquarePoint { x: 2, y: 0 }).unwrap();
    g.add_edge(extra, far, EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
    let params = params_with(&[(PARAM_REDISTRIBUTE, "true")]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );

    assert!(
        maze.graph
            .edges()
            .any(|e| e.from == slot0 && e.to == far && e.kind == EdgeKind::Teleport),
        "redistributed edge must keep the Teleport kind, not silently downgrade to Basic"
    );
}

#[test]
fn apply_reports_failed_when_the_only_flagged_node_is_preset_protected() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let mut preset_state = PresetState::empty();
    preset_state.preset_edges.insert((
        extra,
        maze.field
            .node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 0 })
            .unwrap(),
    ));
    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![extra]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &preset_state,
        &[],
    );
    assert!(matches!(result, RepairResult::Failed));
    assert!(
        maze.field.cell_of(extra).is_some(),
        "preset-protected node must survive"
    );
    let _ = slot0;
}

#[test]
fn apply_succeeds_on_empty_invalid_list() {
    let (mut maze, _slot0, _extra) = maze_with_split_node();
    let issue = InvalidSplitNodeIssue::new_from_check("test", vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &RemoveSplitNodeStrategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}
