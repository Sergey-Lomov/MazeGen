use super::*;
use crate::quality_control::Issue;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;
use std::sync::Arc;

const TEST_ID: &str = "teleport_group_proximity";

fn check(
    distance: f64,
    own_edge: TeleportProximityEdge,
    other_edge: TeleportProximityEdge,
) -> TeleportGroupProximityCheck {
    TeleportGroupProximityCheck {
        instance_id: TEST_ID.to_string(),
        distance,
        own_edge,
        other_edge,
        protect_route: true,
    }
}

/// Flattens `issue.groups` (`Vec<(Vec<EdgeId>, u32)>`, each entry a two-element proximity pair)
/// back into `(EdgeId, EdgeId)` pairs -- lets the rest of this file's assertions read the same
/// way they did before GitHub issue #209 migrated the issue onto the generic group shape.
fn pairs_of(issue: &InvalidTeleportGroupIssue) -> Vec<(EdgeId, EdgeId)> {
    issue
        .groups
        .iter()
        .map(|(g, _)| {
            assert_eq!(
                g.len(),
                2,
                "every teleport proximity group must have exactly two elements"
            );
            (g[0], g[1])
        })
        .collect()
}

/// Shared test-maze bootstrap: a `width`-wide, 1-tall `SquareTessellation` field with an empty
/// `Graph` (no edges built in yet) plus a `p(x)` helper resolving row-0 tile x to its `NodeId` —
/// every test below builds its own edges on top of this same field/graph shape.
fn bootstrap_row(width: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(Arc::default(), square_rect(width, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    (field, g)
}

#[test]
fn silent_with_fewer_than_two_teleports() {
    let (field, mut g) = bootstrap_row(3);
    let field_level = field.single_level_id();
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1000.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

/// Two teleports whose entries sit `entry_gap` nav-hops apart on a shared corridor:
/// entry_a(0) -- ... -- entry_b(entry_gap), each teleporting off to its own far node.
fn maze_with_two_teleport_entries_at_gap(
    entry_gap: usize,
) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let width = entry_gap + 3;
    let (field, mut g) = bootstrap_row(width);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    for x in 0..entry_gap as i32 {
        g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
    }
    let far_a = p(width as i32 - 2);
    let far_b = p(width as i32 - 1);
    let entry_a = p(0);
    let entry_b = p(entry_gap as i32);
    let id_a = g.add_edge(entry_a, far_a, EdgeKind::Teleport);
    let id_b = g.add_edge(entry_b, far_b, EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);
    (maze, id_a, id_b)
}

#[test]
fn fires_when_entries_closer_than_threshold() {
    let (maze, id_a, id_b) = maze_with_two_teleport_entries_at_gap(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert_eq!(
        pairs.len(),
        2,
        "both directions of the scan (a->b and b->a) each record their own pair entry"
    );
    for &(x, y) in &pairs {
        assert!((x == id_a && y == id_b) || (x == id_b && y == id_a));
    }
}

#[test]
fn silent_when_entries_farther_than_threshold() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(10);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_threshold_is_zero() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        0.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "a threshold of 0 should never flag any pair"
    );
}

#[test]
fn fractional_distance_cleanly_separates_integer_tile_hop_counts() {
    // distance=1.5 must fire for a gap of exactly 1 tile-hop (1 < 1.5) but stay silent for a
    // gap of exactly 2 (2 is not < 1.5) -- exercises that a fractional threshold isn't
    // silently truncated to an integer (the bug this test guards against: `distance=1.1`
    // must behave like 1.1, not fall back to 0 or truncate to 1).
    let (maze_close, _, _) = maze_with_two_teleport_entries_at_gap(1);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1.5,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze_close, &mut issues, &mut rng, ());
    assert_eq!(
        issues.len(),
        1,
        "gap of 1 tile-hop must fire against threshold 1.5"
    );

    let (maze_far, _, _) = maze_with_two_teleport_entries_at_gap(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1.5,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze_far, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "gap of 2 tile-hops must stay silent against threshold 1.5"
    );
}

#[test]
fn records_a_fractional_distance_as_a_detail_without_truncation() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(1);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1.5,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0]
            .details()
            .get(TEST_ID)
            .and_then(|kv| kv.get("distance")),
        Some(&"1.5".to_string())
    );
}

#[test]
fn respects_directed_edges_reverse_still_counts_via_min() {
    // A one-way corridor a->b: forward distance a->b is 2, reverse (b->a) is unreachable.
    // min(forward, reverse) must still catch it via the forward side.
    let (field, mut g) = bootstrap_row(5);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way only
    g.add_edge(p(1), p(2), EdgeKind::Basic); // one-way only
    let id_a = g.add_edge(p(0), p(3), EdgeKind::Teleport);
    let id_b = g.add_edge(p(2), p(4), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(
        pairs.iter().any(|&(x, y)| x == id_a && y == id_b),
        "forward a->b (distance 2) must be caught even though b->a is unreachable"
    );
}

#[test]
fn records_the_configured_distance_as_a_detail() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(
        issues[0]
            .details()
            .get(TEST_ID)
            .and_then(|kv| kv.get("distance")),
        Some(&"5".to_string())
    );
}

#[test]
fn check_type_id_matches_registered_type_id() {
    let c = check(
        0.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    );
    assert_eq!(<TeleportGroupProximityCheck as Check<SquareTessellation, InvalidTeleportGroupIssue>>::check_type_id(&c), "teleport_group_proximity");
}

#[cfg(test)]
#[path = "teleport_group_proximity_selector_tests.rs"]
mod teleport_group_proximity_selector_tests;

#[cfg(test)]
#[path = "teleport_group_proximity_route_tests.rs"]
mod teleport_group_proximity_route_tests;
