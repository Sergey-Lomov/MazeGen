use super::*;
use rand::SeedableRng;
use crate::random::MazeRng;
use crate::{Graph, IdGenerator};
use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
use crate::quality_control::SplitTileNodes;
use crate::repair::params::build_params;
use crate::repair::strategies::test_utils::apply_and_commit;

fn no_params() -> StrategyParams {
    build_params(<RemoveSplitStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileIssue>>::params(&RemoveSplitStrategy), None)
}

fn params_with(overrides: &[(&str, &str)]) -> StrategyParams {
    let mut map = std::collections::HashMap::new();
    for &(k, v) in overrides {
        map.insert(k.to_string(), v.to_string());
    }
    build_params(<RemoveSplitStrategy as RepairStrategy<SquareTessellation, InvalidSplitTileIssue>>::params(&RemoveSplitStrategy), Some(&map))
}

/// A 2-node split (slot0 + extra): slot0 <-> left, extra <-> right.
fn maze_with_split_node() -> (Maze<SquareTessellation>, NodeId, NodeId) {
    let mut ids = IdGenerator::new();
    let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(p).unwrap();
    let extra = field.add_node_at(p, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let left = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let right = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    g.add_bidirectional_edge(slot0, left, EdgeKind::Basic);
    g.add_bidirectional_edge(extra, right, EdgeKind::Basic);
    let maze = Maze::new(field, g);
    (maze, slot0, extra)
}

fn only_surviving_node(maze: &Maze<SquareTessellation>, point: SquarePoint) -> NodeId {
    let remaining = maze.field.nodes_at(point);
    assert_eq!(remaining.len(), 1, "collapse must leave exactly one node at the point");
    remaining[0]
}

#[test]
fn apply_collapses_the_tile_to_exactly_one_node() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert_ne!(survivor, slot0, "collapse must mint a brand-new node, not reuse an old id");
    assert_ne!(survivor, extra, "collapse must mint a brand-new node, not reuse an old id");
    assert!(maze.field.point_of(slot0).is_none(), "old slot0 must be gone");
    assert!(maze.field.point_of(extra).is_none(), "old extra must be gone");
}

#[test]
fn apply_most_connected_default_keeps_the_more_connected_nodes_edges() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let left = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let right = maze.field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    // Give extra a second connection so it strictly outranks slot0 (1 vs 2).
    maze.graph.add_edge(extra, left, EdgeKind::Basic);

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edge_between(survivor, right).is_some() && maze.graph.edge_between(right, survivor).is_some(),
        "the more-connected node's (extra) bidirectional edge to `right` must survive");
    assert!(maze.graph.edge_between(survivor, left).is_some(), "the more-connected node's (extra) one-way edge to `left` must survive");
}

#[test]
fn apply_least_connected_keeps_the_less_connected_nodes_edges() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let left = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let right = maze.field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    maze.graph.add_edge(extra, left, EdgeKind::Basic); // extra now has degree 2, slot0 has 1

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let params = params_with(&[(PARAM_SELECTION, SELECTION_LEAST_CONNECTED)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edge_between(left, survivor).is_some(), "the less-connected node's (slot0) edge to `left` must survive");
    assert!(maze.graph.edge_between(survivor, right).is_none(), "extra's edges must not survive under least_connected");
}

#[test]
fn apply_most_connected_counts_basic_and_teleport_to_the_same_target_as_two_connections() {
    // Regression: a Basic and a Teleport edge to the same target must count as two distinct
    // connections in the degree tie-break, not dedupe into one the way a bidirectional Basic
    // pair does (`Graph::add_edge`'s own dedup is kind-aware -- a node can genuinely hold both).
    let (mut maze, slot0, extra) = maze_with_split_node();
    let right = maze.field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    // extra: bidirectional Basic to `right` (degree 1 if kind-aware, would wrongly stay 1 even
    // after adding a same-target Teleport if the dedup ignored kind) plus a Teleport to `right` --
    // true degree 2, same as slot0's own bidirectional-to-`left` (also degree 1) plus nothing else
    // would be degree 1, so extra must strictly outrank slot0 only if the Teleport is counted.
    maze.graph.add_edge(extra, right, EdgeKind::Teleport);

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edges().any(|e| e.from == survivor && e.to == right && e.kind == EdgeKind::Teleport),
        "extra (degree 2: Basic + Teleport to right) must outrank slot0 (degree 1) under most_connected");
}

#[test]
fn apply_merge_unions_edges_from_every_node() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    let left = maze.field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let right = maze.field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let params = params_with(&[(PARAM_SELECTION, SELECTION_MERGE)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edge_between(survivor, left).is_some() && maze.graph.edge_between(left, survivor).is_some(),
        "slot0's bidirectional connection to `left` must be preserved");
    assert!(maze.graph.edge_between(survivor, right).is_some() && maze.graph.edge_between(right, survivor).is_some(),
        "extra's bidirectional connection to `right` must be preserved");
}

#[test]
fn apply_merge_unions_forward_and_backward_to_the_same_target_into_a_passage() {
    let mut ids = IdGenerator::new();
    let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(p).unwrap();
    let extra = field.add_node_at(p, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let right = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    // slot0 -> right (Forward), right -> extra (Backward relative to extra) -- same target,
    // opposite directions from the tile's two different nodes.
    g.add_edge(slot0, right, EdgeKind::Basic);
    g.add_edge(right, extra, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let params = params_with(&[(PARAM_SELECTION, SELECTION_MERGE)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edge_between(survivor, right).is_some(), "merged Forward+Backward to the same target must become a full Passage (forward half)");
    assert!(maze.graph.edge_between(right, survivor).is_some(), "merged Forward+Backward to the same target must become a full Passage (backward half)");
}

#[test]
fn apply_never_creates_a_self_loop_from_the_sibling_edge() {
    let mut ids = IdGenerator::new();
    let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(p).unwrap();
    let extra = field.add_node_at(p, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    // The only edge on `extra` is its sibling edge to slot0 -- must never be carried over as a
    // self-loop on the surviving node.
    g.add_bidirectional_edge(slot0, extra, EdgeKind::Basic);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let params = params_with(&[(PARAM_SELECTION, SELECTION_MERGE)]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edge_between(survivor, survivor).is_none(), "must never create a self-loop on the surviving node");
    assert!(maze.graph.edges().filter(|e| e.from == survivor || e.to == survivor).count() == 0,
        "the surviving node must have no edges at all -- its only source edge was the sibling self-loop");
}

#[test]
fn apply_preserves_teleport_kind() {
    let mut ids = IdGenerator::new();
    let mut field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
    let p = SquarePoint { x: 1, y: 0 };
    let slot0 = field.node_at(p).unwrap();
    let extra = field.add_node_at(p, &mut ids);
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    let far = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
    g.add_edge(extra, far, EdgeKind::Teleport);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let params = params_with(&[(PARAM_SELECTION, SELECTION_MERGE)]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &params, &PresetState::empty(), &[]);

    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });
    assert!(maze.graph.edges().any(|e| e.from == survivor && e.to == far && e.kind == EdgeKind::Teleport),
        "carried-over edge must keep the Teleport kind, not silently downgrade to Basic");
}

#[test]
fn apply_reports_failed_and_leaves_the_tile_untouched_when_a_node_is_preset_protected() {
    // Regression: `apply()` must check `replace_point_nodes_feasible` up front and report
    // `Failed`, not silently propose a `ReplacePointNodes` that `apply_commands` will decline --
    // otherwise the repair fixpoint loop would spin on this rule until the budget is exhausted
    // instead of failing fast (same class of bug `OneWayToWallStrategy`'s GitHub issue #230 fixed).
    let (mut maze, slot0, extra) = maze_with_split_node();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(extra);
    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &preset_state, &[]);
    assert!(matches!(result, RepairResult::Failed), "preset-locked tile must report Failed, not silently Fixed");
    assert!(maze.field.point_of(slot0).is_some(), "preset-locked tile must survive untouched");
    assert!(maze.field.point_of(extra).is_some(), "preset-locked tile must survive untouched");
}

#[test]
fn apply_succeeds_on_empty_invalid_list() {
    let (mut maze, _slot0, _extra) = maze_with_split_node();
    let issue = InvalidSplitTileIssue::new_from_check("test", vec![]);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn apply_skips_a_tile_already_collapsed_to_one_node() {
    let (mut maze, slot0, extra) = maze_with_split_node();
    // Collapse it for real first.
    let issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![slot0, extra])]);
    let mut rng = MazeRng::seed_from_u64(1);
    apply_and_commit(&RemoveSplitStrategy, &issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    let survivor = only_surviving_node(&maze, SquarePoint { x: 1, y: 0 });

    // A stale issue still referencing the old (now single-node) tile shape must be a no-op Fixed,
    // not attempt another ReplacePointNodes.
    let stale_issue = InvalidSplitTileIssue::new_from_check("test", vec![SplitTileNodes::new(vec![survivor])]);
    let result = apply_and_commit(&RemoveSplitStrategy, &stale_issue, &mut maze, &mut rng, &no_params(), &PresetState::empty(), &[]);
    assert!(matches!(result, RepairResult::Fixed { score: None }));
}

#[test]
fn union_direction_covers_every_combination() {
    use SplitNodeEdgeDirection::*;
    // Same direction from both owners -- stays that direction, not promoted to Passage.
    assert!(matches!(union_direction(Forward, Forward), Forward));
    assert!(matches!(union_direction(Backward, Backward), Backward));
    // Opposite one-way directions merge into a full Passage.
    assert!(matches!(union_direction(Forward, Backward), Passage));
    assert!(matches!(union_direction(Backward, Forward), Passage));
    // Passage on either side always wins, regardless of the other side.
    assert!(matches!(union_direction(Passage, Forward), Passage));
    assert!(matches!(union_direction(Forward, Passage), Passage));
    assert!(matches!(union_direction(Passage, Passage), Passage));
}
