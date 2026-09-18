use super::*;
use crate::graph::EdgeKind;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;

const TEST_ID: &str = "one_way_group_super_hub";

fn check(max_connections: u32) -> OneWayGroupSuperHubCheck {
    OneWayGroupSuperHubCheck {
        instance_id: TEST_ID.to_string(),
        max_connections,
    }
}

#[test]
fn silent_when_no_one_way_edges() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn fires_when_vertex_outgoing_count_exceeds_max() {
    // node[0] has 3 outgoing one-ways -- exceeds max_connections=2.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(4, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32, y: i32| field.node_at(field_level, SquarePoint { x, y }).unwrap();
    let e1 = g.add_edge(p(0, 0), p(1, 0), EdgeKind::Basic);
    let e2 = g.add_edge(p(0, 0), p(0, 1), EdgeKind::Basic);
    let e3 = g.add_edge(p(0, 0), p(1, 1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups.len(), 1);
    let (mut group, to_remove) = issues[0].groups[0].clone();
    group.sort_unstable();
    let mut expected = vec![e1, e2, e3];
    expected.sort_unstable();
    assert_eq!(
        group, expected,
        "group must contain every outgoing one-way at the flagged vertex, not just the excess"
    );
    assert_eq!(
        to_remove, 1,
        "3 incident one-ways over a max of 2 -- excess is 1"
    );
}

#[test]
fn silent_when_vertex_outgoing_count_at_or_below_max() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic);
    g.add_edge(p(0), p(2), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn ignores_bidirectional_edges() {
    // A bidirectional passage is two edges (0->1 and 1->0), each from a different `from` vertex --
    // neither vertex's outgoing one-way count includes it, since it isn't a one-way at all.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
    g.add_bidirectional_edge(p(0), p(2), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "bidirectional edges are not one-ways and must never trip the count"
    );
}

#[test]
fn incoming_and_outgoing_one_ways_count_toward_the_same_vertex_total() {
    // node[1] has 1 outgoing one-way (to node[2]) and 2 incoming (from node[0], node[3]) -- 3
    // total, exceeding max_connections=2, even though neither direction alone would.
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let e1 = g.add_edge(p(0), p(1), EdgeKind::Basic);
    let e2 = g.add_edge(p(3), p(1), EdgeKind::Basic);
    let e3 = g.add_edge(p(1), p(2), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].groups.len(), 1);
    let (mut group, to_remove) = issues[0].groups[0].clone();
    group.sort_unstable();
    let mut expected = vec![e1, e2, e3];
    expected.sort_unstable();
    assert_eq!(
        group, expected,
        "incoming and outgoing one-ways must both count toward the same vertex, and the group must contain all of them"
    );
    assert_eq!(
        to_remove, 1,
        "3 incident one-ways over a max of 2 -- excess is 1"
    );
}

#[test]
fn ignores_teleport_edges() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(0), p(2), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "only EdgeKind::Basic one-ways count toward the vertex's outgoing count"
    );
}

#[test]
fn shared_edge_between_two_over_threshold_vertices_appears_in_both_groups() {
    // node[1] and node[2] are adjacent and connected by a one-way edge between them
    // (e_shared, 1->2). Both vertices are independently over threshold via their own extra
    // one-ways -- e_shared must show up in both vertices' groups, since the check builds groups
    // purely from each vertex's own incident-edge count, with no cross-vertex dedup at the check
    // level (that responsibility belongs to the repair strategy's own `resolved` bookkeeping, see
    // `OneWayGroupSelectStrategy`'s shared-edge tests).
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(5, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32, y: i32| field.node_at(field_level, SquarePoint { x, y }).unwrap();
    let e_shared = g.add_edge(p(1, 0), p(2, 0), EdgeKind::Basic);
    let e_a = g.add_edge(p(1, 0), p(1, 1), EdgeKind::Basic);
    let e_b = g.add_edge(p(2, 0), p(2, 1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(1);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0].groups.len(),
        2,
        "both vertex[1] and vertex[2] are independently over threshold and each contributes its own group"
    );

    let shared_in_group_count = issues[0]
        .groups
        .iter()
        .filter(|(g, _)| g.contains(&e_shared))
        .count();
    assert_eq!(
        shared_in_group_count, 2,
        "e_shared is incident to both flagged vertices, so it must appear in both groups"
    );

    let (mut group_a, to_remove_a) = issues[0]
        .groups
        .iter()
        .find(|(g, _)| g.contains(&e_a))
        .unwrap()
        .clone();
    group_a.sort_unstable();
    let mut expected_a = vec![e_shared, e_a];
    expected_a.sort_unstable();
    assert_eq!(group_a, expected_a);
    assert_eq!(
        to_remove_a, 1,
        "2 incident one-ways over a max of 1 -- excess is 1"
    );

    let (mut group_b, to_remove_b) = issues[0]
        .groups
        .iter()
        .find(|(g, _)| g.contains(&e_b))
        .unwrap()
        .clone();
    group_b.sort_unstable();
    let mut expected_b = vec![e_shared, e_b];
    expected_b.sort_unstable();
    assert_eq!(group_b, expected_b);
    assert_eq!(
        to_remove_b, 1,
        "2 incident one-ways over a max of 1 -- excess is 1"
    );
}

#[test]
fn flags_multiple_vertices_as_separate_groups() {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(square_rect(4, 2), &mut ids).unwrap();
    let field_level = field.single_level_id();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let p = |x: i32, y: i32| field.node_at(field_level, SquarePoint { x, y }).unwrap();
    g.add_edge(p(0, 0), p(1, 0), EdgeKind::Basic);
    g.add_edge(p(0, 0), p(0, 1), EdgeKind::Basic);
    g.add_edge(p(3, 0), p(2, 0), EdgeKind::Basic);
    g.add_edge(p(3, 0), p(3, 1), EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let c = check(1);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    c.repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(
        issues.len(),
        1,
        "both flagged vertices merge into one issue from a single check call"
    );
    assert_eq!(
        issues[0].groups.len(),
        2,
        "each over-threshold vertex produces its own group"
    );
}
