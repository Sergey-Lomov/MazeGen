use super::*;
use crate::IdGenerator;
use crate::graph::{EdgeKind, Graph};
use crate::random::MazeRng;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use rand::SeedableRng;
use std::sync::Arc;

fn maze_line(len: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(len, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

/// `regular:4` canonical order [E, N, W, S] — node 1 gets an East face (index 0) and a North
/// face (index 1), matching `at`'s real East and North neighbors on a 3x3 grid centered at
/// (1,1).
fn two_face_pattern() -> crate::generation::SplitPattern {
    use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
    SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![],
            vec![
                SplitPatternFace {
                    face_index: 0,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
                SplitPatternFace {
                    face_index: 1,
                    requirement: SplitFaceRequirement::Passage,
                    sibling_target: None,
                },
            ],
        ],
        weight: 1.0,
    }
}

/// Same shape as `two_face_pattern` but node 1 has only the single East face — no second edge
/// available from the pattern itself.
fn one_face_pattern() -> crate::generation::SplitPattern {
    use crate::generation::{SplitFaceRequirement, SplitPattern, SplitPatternFace};
    SplitPattern {
        shape: "regular:4".to_string(),
        node_count: 2,
        faces: vec![
            vec![],
            vec![SplitPatternFace {
                face_index: 0,
                requirement: SplitFaceRequirement::Passage,
                sibling_target: None,
            }],
        ],
        weight: 1.0,
    }
}

/// The pattern's untransformed variant on a square cell.
fn identity_variant(pattern: &crate::generation::SplitPattern) -> PatternVariant {
    let shape = SquareTessellation
        .shape_of(SquarePoint { x: 0, y: 0 })
        .unwrap();
    let variant = pattern_variants(pattern, &shape).remove(0);
    assert_eq!(variant.transform, 0);
    variant
}

fn maze_grid(side: usize) -> Maze<SquareTessellation> {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(side, side), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    Maze::new(field, g)
}

#[test]
fn try_pattern_adaptation_satisfies_required_bridge_when_pattern_grants_a_second_edge() {
    // `at` starts fully isolated; the pattern's node 1 has both an East face (the required
    // bridge target) and a North face (the mandatory second edge) — both resolve to real
    // neighbors on a 3x3 grid, so the candidate must be accepted.
    let maze = maze_grid(3);
    let at = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 1 })
        .unwrap();
    let point = maze.field.cell_of(at).unwrap();
    let east_neighbor = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 1 })
        .unwrap();
    let required = RequiredConnection {
        neighbor: east_neighbor,
        direction: SplitNodeEdgeDirection::Passage,
    };

    let plan = try_pattern_adaptation(
        &maze,
        at,
        point,
        &two_face_pattern(),
        &identity_variant(&two_face_pattern()),
        true,
        true,
        Some(&required),
        &HashSet::new(),
    )
    .expect("pattern grants the bridge node both required and second edges");
    let bridge_owner = plan
        .iter()
        .position(|edges| edges.iter().any(|e| e.target == east_neighbor))
        .unwrap();
    assert!(
        plan[bridge_owner].len() >= 2,
        "bridge-carrying node must not be left a dead end"
    );
}

#[test]
fn try_pattern_adaptation_rejects_required_bridge_when_pattern_leaves_it_a_dead_end() {
    // Same setup, but the pattern's node 1 only has the East (bridge) face — no second edge
    // anywhere in the pattern for that node, so the candidate must be rejected outright.
    let maze = maze_grid(3);
    let at = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 1 })
        .unwrap();
    let point = maze.field.cell_of(at).unwrap();
    let east_neighbor = maze
        .field
        .node_at(maze.field.single_level_id(), SquarePoint { x: 2, y: 1 })
        .unwrap();
    let required = RequiredConnection {
        neighbor: east_neighbor,
        direction: SplitNodeEdgeDirection::Passage,
    };

    let plan = try_pattern_adaptation(
        &maze,
        at,
        point,
        &one_face_pattern(),
        &identity_variant(&one_face_pattern()),
        true,
        true,
        Some(&required),
        &HashSet::new(),
    );
    assert!(
        plan.is_none(),
        "bridge node left with only the required edge must be rejected, not silently accepted as a dead end"
    );
}

#[test]
fn plan_unconstrained_split_without_required_matches_original_behavior() {
    let mut maze = maze_line(3);
    let nodes: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    maze.graph
        .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
    let mut rng = MazeRng::seed_from_u64(1);
    let plan =
        plan_unconstrained_split(&maze, nodes[1], 2, None, &HashSet::new(), &mut rng).unwrap();
    let total_edges: usize = plan.iter().map(|n| n.len()).sum();
    assert_eq!(total_edges, 1);
}

#[test]
fn plan_unconstrained_split_with_required_adds_bridge_and_second_edge() {
    // 1x5 line: node at x=2 is isolated (no existing edges at all). Bridge to node at x=0
    // (not a geometric neighbor, but required doesn't need it to be) plus a second edge drawn
    // from a real free neighbor (x=1 or x=3).
    let maze = maze_line(5);
    let nodes: Vec<NodeId> = (0..5)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    let at = nodes[2];
    let bridge_target = nodes[0];
    let required = RequiredConnection {
        neighbor: bridge_target,
        direction: SplitNodeEdgeDirection::Passage,
    };
    let mut rng = MazeRng::seed_from_u64(3);
    let plan =
        plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng).unwrap();
    let bridge_owner = plan
        .iter()
        .position(|edges| edges.iter().any(|e| e.target == bridge_target))
        .unwrap();
    assert!(
        plan[bridge_owner].len() >= 2,
        "bridge-carrying node must have a second edge"
    );
    assert!(
        plan[bridge_owner].iter().any(|e| e.target != bridge_target),
        "second edge must go elsewhere"
    );
}

#[test]
fn plan_unconstrained_split_reuses_an_existing_edge_to_satisfy_the_required_bridge() {
    // `at` already has a real edge to the required neighbor — the bridge must be satisfied by
    // redistributing that existing connection (not by adding a redundant new one).
    let mut maze = maze_line(3);
    let nodes: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    let at = nodes[1];
    let bridge_target = nodes[0];
    maze.graph
        .add_bidirectional_edge(at, bridge_target, EdgeKind::Basic);
    maze.graph
        .add_bidirectional_edge(at, nodes[2], EdgeKind::Basic);
    let required = RequiredConnection {
        neighbor: bridge_target,
        direction: SplitNodeEdgeDirection::Passage,
    };
    let mut rng = MazeRng::seed_from_u64(1);
    let plan =
        plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng).unwrap();

    let total_edges: usize = plan.iter().map(|n| n.len()).sum();
    assert_eq!(
        total_edges, 2,
        "both pre-existing edges must be redistributed, none added or dropped"
    );
    let bridge_owner = plan
        .iter()
        .position(|edges| edges.iter().any(|e| e.target == bridge_target))
        .unwrap();
    assert_eq!(
        plan[bridge_owner]
            .iter()
            .filter(|e| e.target == bridge_target)
            .count(),
        1,
        "bridge target must appear exactly once, not duplicated"
    );
}

#[test]
fn plan_unconstrained_split_fails_when_no_second_edge_available() {
    // 1x1 field: the only point has no geometric neighbor at all, so a bridge-only node can
    // never gain a second edge.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let at = field.node_at(level, SquarePoint { x: 0, y: 0 }).unwrap();
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    // A synthetic "elsewhere" neighbor id that isn't geometrically real — required connection
    // itself is always satisfiable (any NodeId), only the *second* edge needs a real neighbor.
    let fake_neighbor = at; // stand-in; the important part is the field has no other neighbor
    let required = RequiredConnection {
        neighbor: fake_neighbor,
        direction: SplitNodeEdgeDirection::Passage,
    };
    let mut rng = MazeRng::seed_from_u64(1);
    let result = plan_unconstrained_split(&maze, at, 2, Some(&required), &HashSet::new(), &mut rng);
    assert!(result.is_none());
}

#[test]
fn plan_unconstrained_split_rejects_a_required_neighbor_already_excluded() {
    // A caller must never plan a bridge to a point another command in the same batch already
    // committed to replace — that node's id won't exist by apply time.
    let maze = maze_line(3);
    let nodes: Vec<NodeId> = (0..3)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    let at = nodes[1];
    let bridge_target = nodes[0];
    let required = RequiredConnection {
        neighbor: bridge_target,
        direction: SplitNodeEdgeDirection::Passage,
    };
    let mut excluded = HashSet::new();
    excluded.insert(bridge_target);
    let mut rng = MazeRng::seed_from_u64(1);
    let result = plan_unconstrained_split(&maze, at, 2, Some(&required), &excluded, &mut rng);
    assert!(result.is_none());
}

#[test]
fn plan_unconstrained_split_never_picks_an_excluded_node_for_the_second_edge() {
    // 1x5 line, node at x=2 isolated. Bridge to x=0 (required), but x=1 (the only real
    // geometric neighbor that could supply a second edge on one side) is excluded — the only
    // remaining free neighbor is x=3.
    let maze = maze_line(5);
    let nodes: Vec<NodeId> = (0..5)
        .map(|x| {
            maze.field
                .node_at(maze.field.single_level_id(), SquarePoint { x, y: 0 })
                .unwrap()
        })
        .collect();
    let at = nodes[2];
    let bridge_target = nodes[0];
    let required = RequiredConnection {
        neighbor: bridge_target,
        direction: SplitNodeEdgeDirection::Passage,
    };
    let mut excluded = HashSet::new();
    excluded.insert(nodes[1]);
    let mut rng = MazeRng::seed_from_u64(3);
    let plan =
        plan_unconstrained_split(&maze, at, 2, Some(&required), &excluded, &mut rng).unwrap();
    let bridge_owner = plan
        .iter()
        .position(|edges| edges.iter().any(|e| e.target == bridge_target))
        .unwrap();
    assert!(
        plan[bridge_owner].iter().all(|e| e.target != nodes[1]),
        "excluded node must never be picked as the second edge"
    );
    assert!(
        plan[bridge_owner].iter().any(|e| e.target == nodes[3]),
        "must fall back to the other free neighbor"
    );
}
