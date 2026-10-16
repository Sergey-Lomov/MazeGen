use super::super::*;
use super::{maze_grid, maze_line, missing_issue, no_params};
use crate::IdGenerator;
use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
use crate::graph::{EdgeKind, Graph};
use crate::random::MazeRng;
use crate::repair::params::build_params;
use crate::repair::strategies::split_core;
use crate::repair::strategies::test_utils::apply_and_commit;
use crate::space::test_support::GappedSquareTessellation;
use crate::space::{MultiLevelField, SquareFace, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

fn two_node_passage_pattern() -> SplitPattern {
    // SquareFace order [N, S, E, W] — node 1 gets an East face (index 2), matching node 0's
    // real East neighbor.
    SplitPattern {
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace {
                face_index: 2,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    }
}

#[test]
fn pattern_mode_adds_a_split_tile_matching_the_configured_pattern() {
    // 3x3 field (not a bare 1-row line) so every candidate point has a real neighbor in every
    // direction — whichever rotation/mirror `plan_pattern_split` tries first, the pattern's
    // single East face (after transform) always lands on a real neighbor, never off-field
    // (a degenerate case `try_pattern_adaptation` accepts as "nothing to add" under
    // `allow_add`, unrelated to this fix, that would otherwise make this test's outcome
    // dependent on which rotation happens to be tried first). Every candidate point starts
    // fully isolated, so node 0's faces (empty, Wall on every side) match trivially and only
    // the claiming node's own face adds the new connection.
    let mut maze = maze_grid(3, 3);

    let strategy = AddSplitStrategy {
        split_patterns: vec![two_node_passage_pattern()],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    };
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    let nodes_before = maze.field.node_count();
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));
    assert_eq!(maze.field.node_count(), nodes_before + 1);
    let split_point = (0..3)
        .flat_map(|x| (0..3).map(move |y| SquarePoint { x, y }))
        .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
        .expect("exactly one point must have been split");
    let tile_nodes = maze
        .field
        .nodes_at(maze.field.single_level_id(), split_point);
    assert!(
        crate::quality_control::split_pattern_match::split_tile_matches_any(
            &maze.graph,
            &maze.field,
            tile_nodes,
            std::slice::from_ref(&two_node_passage_pattern()),
        ),
        "the resulting tile must structurally match the single configured pattern"
    );
}

#[test]
fn pick_weighted_pattern_respects_configured_weight_not_uniform() {
    // GitHub issue #275: `AddSplitStrategy` used to pick a pattern index uniformly, ignoring
    // `SplitPattern::weight` entirely. A near-zero-weight pattern must almost never be picked
    // against a heavily-weighted sibling.
    let low = SplitPattern {
        node_count: 2,
        faces: vec![vec![], vec![]],
        weight: 0.001,
    };
    let high = SplitPattern {
        node_count: 2,
        faces: vec![vec![], vec![]],
        weight: 999.0,
    };
    let patterns = vec![low, high];

    let mut low_picks = 0;
    for seed in 0..500 {
        let mut rng = MazeRng::seed_from_u64(seed);
        if pick_weighted_pattern(&patterns, &mut rng) == 0 {
            low_picks += 1;
        }
    }
    assert!(
        low_picks < 10,
        "low-weight pattern picked {low_picks}/500 times, expected near-zero under weighting"
    );
}

#[test]
fn pattern_mode_fails_when_no_pattern_can_ever_match_and_lose_is_forbidden() {
    // A fully-isolated point (no connections at all) can never satisfy a pattern requiring an
    // East passage without adding a new connection — with allow_add forbidden, every rotation
    // fails.
    let mut maze = maze_line(3);
    let strategy = AddSplitStrategy {
        split_patterns: vec![two_node_passage_pattern()],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    };
    let mut overrides = std::collections::HashMap::new();
    overrides.insert(PARAM_ALLOW_ADD_CONNECTIONS.to_string(), "false".to_string());
    let params = build_params(
        <AddSplitStrategy as RepairStrategy<SquareTessellation, MissingSplitTilesIssue>>::params(
            &strategy,
        ),
        Some(&overrides),
    );

    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(9);
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &params,
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "no rotation of this pattern can match without adding a connection, which is forbidden here"
    );
}

#[test]
fn pattern_mode_never_produces_a_truncated_tile_when_a_required_face_points_off_field() {
    // A 1x1 field — every face of the only point points off-field, so a pattern requiring a
    // real Passage/OneWay connection can never structurally fit here no matter what
    // `allow_add_connections` says (there's nothing on the other side to connect to). The
    // strategy must fail this candidate outright rather than silently mint a tile missing the
    // required connection (the original bug: a pattern applied where it can't fit, producing
    // a truncated tile that doesn't match the pattern at all).
    let mut maze = maze_line(1);
    let strategy = AddSplitStrategy {
        split_patterns: vec![two_node_passage_pattern()],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    };
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(
        matches!(result, RepairResult::Failed),
        "no rotation/mirror can satisfy an East-passage requirement on a field with no neighbors at all"
    );
    assert_eq!(
        maze.field.node_count(),
        1,
        "no split tile must be minted when the pattern can't structurally fit anywhere"
    );
}

#[test]
fn pattern_mode_rejects_a_required_face_when_step_has_no_coordinate() {
    let origin = SquarePoint { x: 0, y: 0 };
    let east = SquarePoint { x: 1, y: 0 };
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<GappedSquareTessellation> =
        MultiLevelField::single_level(Arc::default(), [origin, east], &mut ids).unwrap();
    let level = field.single_level_id();
    let at = field.node_at(level, origin).unwrap();
    let mut graph = Graph::new();
    for node in field.all_node_ids() {
        graph.add_node(node);
    }
    let maze = Maze::new(field, graph);
    let pattern = SplitPattern {
        node_count: 1,
        faces: vec![vec![SplitPatternFace {
            face_index: east_face_index(),
            requirement: SplitFaceRequirement::Passage,
            sibling_target: None,
        }]],
        weight: 1.0,
    };

    assert!(
        split_core::try_pattern_adaptation(
            &maze,
            at,
            origin,
            &pattern,
            0,
            None,
            true,
            true,
            None,
            &std::collections::HashSet::new(),
        )
        .is_none()
    );
}

#[test]
fn pattern_mode_rewires_slot0_itself_to_match_the_pattern_instead_of_leaving_it_untouched() {
    // 3x3 field (see `pattern_mode_adds_a_split_tile_matching_the_configured_pattern`'s own
    // comment for why a bare 1-row line risks a degenerate off-field candidate unrelated to
    // this fix). Every point along y=1 starts connected both West and East.
    // `two_node_passage_pattern`'s node 0 has empty faces (Wall on every side) — with slot-0
    // now resolved the same way as every other node, one of the two real connections is
    // dropped (allow_lose) rather than silently left in place on an untouched slot-0 (the
    // original bug: a resulting tile whose real slot-0 connections didn't match the pattern
    // at all).
    let mut maze = maze_grid(3, 3);
    let row: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 1 })
                .unwrap()
        })
        .collect();
    maze.graph
        .add_bidirectional_edge(row[0], row[1], EdgeKind::Basic);
    maze.graph
        .add_bidirectional_edge(row[1], row[2], EdgeKind::Basic);

    let strategy = AddSplitStrategy {
        split_patterns: vec![two_node_passage_pattern()],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    };
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    let result = apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );
    assert!(matches!(result, RepairResult::Fixed { score: None }));

    let split_point = (0..3)
        .flat_map(|x| (0..3).map(move |y| SquarePoint { x, y }))
        .find(|&p| maze.field.nodes_at(maze.field.single_level_id(), p).len() > 1)
        .expect("exactly one point must have been split");
    let tile_nodes = maze
        .field
        .nodes_at(maze.field.single_level_id(), split_point);
    assert!(
        crate::quality_control::split_pattern_match::split_tile_matches_any(
            &maze.graph,
            &maze.field,
            tile_nodes,
            std::slice::from_ref(&two_node_passage_pattern()),
        ),
        "the resulting tile must structurally match the pattern, including its node-0/slot-0 requirements"
    );
}

#[test]
fn pattern_mode_never_leaves_a_stale_edge_referencing_the_old_slot0_id() {
    // Guards the neighbor-side edge cleanup specifically: after replacement, no edge anywhere
    // in the graph may still reference the old slot0 NodeId, in either direction.
    let mut maze = maze_grid(3, 3);
    let row: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 1 })
                .unwrap()
        })
        .collect();
    maze.graph
        .add_bidirectional_edge(row[0], row[1], EdgeKind::Basic);
    maze.graph
        .add_bidirectional_edge(row[1], row[2], EdgeKind::Basic);
    let all_nodes_before: Vec<NodeId> = maze.field.all_node_ids().collect();

    let strategy = AddSplitStrategy {
        split_patterns: vec![two_node_passage_pattern()],
        max_split_nodes: 2,
        pattern_weights: vec![],
        protect_route: true,
    };
    let issue = missing_issue(1);
    let mut rng = MazeRng::seed_from_u64(5);
    apply_and_commit(
        &strategy,
        &issue,
        &mut maze,
        &mut rng,
        &no_params(),
        &PresetState::empty(),
        &[],
    );

    let old_slot0 = *all_nodes_before
        .iter()
        .find(|&&n| maze.field.cell_of(n).is_none())
        .expect("exactly one pre-existing node must have been replaced");

    assert!(
        maze.field.cell_of(old_slot0).is_none(),
        "old slot0 id must no longer resolve to a point"
    );
    for other in maze.field.all_node_ids() {
        assert!(maze.graph.edge_between(old_slot0, other).is_none());
        assert!(maze.graph.edge_between(other, old_slot0).is_none());
    }
}

#[test]
fn pattern_mode_reuses_a_neighbors_non_slot0_node_that_already_owns_the_connection() {
    // 3x3 field. The point at (0,1) is pre-split: its slot-0 has no connections, but its
    // second node (slot-1) already has a real East<->West edge to (1,1) — the candidate point.
    // Resolving `at`'s (1,1) West face (pattern index 3, rotation=0, no mirror) against this
    // neighbor must land on (0,1)'s slot-1 — the node that actually owns the connection in
    // that direction — not silently onto (0,1)'s unconnected slot-0.
    let mut ids = IdGenerator::new();
    let mut field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(3, 3), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let west_point = SquarePoint { x: 0, y: 1 };
    let west_slot1 = field.add_node_at(field_level, west_point, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let at = field
        .node_at(field_level, SquarePoint { x: 1, y: 1 })
        .unwrap();
    g.add_bidirectional_edge(west_slot1, at, EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let point = maze.field.cell_of(at).unwrap();
    let pattern = SplitPattern {
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace {
                face_index: 3,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    };
    let per_node = split_core::try_pattern_adaptation(
        &maze,
        at,
        point,
        &pattern,
        0,
        None,
        true,
        true,
        None,
        &std::collections::HashSet::new(),
    )
    .expect("West face has a real neighbor, must resolve");

    let west_slot0 = maze
        .field
        .nodes_at(maze.field.single_level_id(), west_point)[0];
    assert!(
        !per_node[1].iter().any(|e| e.target == west_slot0),
        "must not wire the new node to the neighbor's unconnected slot-0"
    );
    assert!(
        per_node[1].iter().any(|e| e.target == west_slot1),
        "must wire the new node to the neighbor's actual owning node (slot-1)"
    );
}

/// Position of `SquareFace::E` in `GappedSquareTessellation`'s (uniform) face order.
fn east_face_index() -> usize {
    GappedSquareTessellation
        .faces_of(SquarePoint { x: 0, y: 0 })
        .iter()
        .position(|&face| face == SquareFace::E)
        .unwrap()
}
