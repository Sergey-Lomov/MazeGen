use super::super::*;
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

/// Two teleports whose four endpoints (entry_a, exit_a, entry_b, exit_b) sit on four
/// mutually-disconnected corridors, each corridor far longer than the test's threshold —
/// `entry_a`/`exit_a`/`entry_b`/`exit_b` are never connected to each other by anything except
/// the two teleport edges themselves, and neither teleport is used as a shortcut between the
/// two corridors under test (each corridor only touches one of the four endpoints). This
/// isolates exactly one endpoint-to-endpoint distance per combination — `close_pair` picks
/// which two corridors sit `close_gap` apart (the pair under test), every other combination's
/// corridors sit far apart, so leaking through a route via either teleport itself does not
/// create a false-positive shortcut for the *other* three combinations.
#[derive(Clone, Copy)]
enum ClosePair {
    EntryEntry,
    EntryExit,
    ExitEntry,
    ExitExit,
}

fn maze_with_one_close_endpoint_pair(
    close: ClosePair,
) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    // Four far-apart corridors (20 tiles each) plus a short bridge for the close pair,
    // arranged as four disjoint blocks: entry_a=[0..20], exit_a=[20..40], entry_b=[40..60],
    // exit_b=[60..80]. Every block is a straight bidirectional corridor with no cross-links,
    // so the only routes between blocks are the two teleport edges themselves.
    let (field, mut g) = bootstrap_row(80);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    for block_start in [0, 20, 40, 60] {
        for x in block_start..block_start + 19 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
    }
    let entry_a = p(0);
    let exit_a = p(20);
    let entry_b = p(40);
    let exit_b = p(60);
    // The close pair gets a direct 1-tile bridge straight from the relevant endpoint itself
    // (not from the far end of its 19-tile corridor) -- everything else stays disconnected,
    // so only the endpoint pair under test is ever within the test's threshold (3).
    let _ = match close {
        ClosePair::EntryEntry => g.add_bidirectional_edge(entry_a, entry_b, EdgeKind::Basic),
        ClosePair::EntryExit => g.add_bidirectional_edge(entry_a, exit_b, EdgeKind::Basic),
        ClosePair::ExitEntry => g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic),
        ClosePair::ExitExit => g.add_bidirectional_edge(exit_a, exit_b, EdgeKind::Basic),
    };
    let id_a = g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
    let id_b = g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
    (Maze::new(field, g), id_a, id_b)
}

#[test]
fn entry_vs_entry_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::EntryEntry);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn entry_vs_exit_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::EntryExit);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Exit,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn exit_vs_entry_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitEntry);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Exit,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn exit_vs_exit_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitExit);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Exit,
        TeleportProximityEdge::Exit,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn own_entry_or_exit_fires_regardless_of_which_own_end_is_close() {
    // own=EntryOrExit must catch the close pair whether the bridge lands on a's entry or
    // a's exit -- exercise all four ClosePair placements with own_edge fixed to EntryOrExit
    // and other_edge fixed to Entry (the close pair always has entry(b) on the other side).
    for close in [ClosePair::EntryEntry, ClosePair::ExitEntry] {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(
            3.0,
            TeleportProximityEdge::EntryOrExit,
            TeleportProximityEdge::Entry,
        )
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "own=EntryOrExit must fire regardless of which own end is close"
        );
        let pairs = pairs_of(&issues[0]);
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }
}

#[test]
fn other_entry_or_exit_fires_regardless_of_which_other_end_is_close() {
    // other=EntryOrExit must catch the close pair whether the bridge lands on b's entry or
    // b's exit -- own_edge fixed to Entry (the close pair always has entry(a) on this side).
    for close in [ClosePair::EntryEntry, ClosePair::EntryExit] {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(
            3.0,
            TeleportProximityEdge::Entry,
            TeleportProximityEdge::EntryOrExit,
        )
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = pairs_of(&issues[0]);
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }
}

#[test]
fn both_entry_or_exit_fires_for_any_close_combination() {
    for close in [
        ClosePair::EntryEntry,
        ClosePair::EntryExit,
        ClosePair::ExitEntry,
        ClosePair::ExitExit,
    ] {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(
            3.0,
            TeleportProximityEdge::EntryOrExit,
            TeleportProximityEdge::EntryOrExit,
        )
        .repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = pairs_of(&issues[0]);
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }
}

#[test]
fn entry_or_exit_silent_when_nothing_is_close() {
    let (field, mut g) = bootstrap_row(6);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(4), p(5), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1000.0,
        TeleportProximityEdge::EntryOrExit,
        TeleportProximityEdge::EntryOrExit,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "unreachable in every combination must not be treated as distance 0"
    );
}

#[test]
fn entry_vs_entry_selector_silent_when_the_close_pair_is_elsewhere() {
    // The bridge connects exit(a)/exit(b) (ExitExit) -- Entry/Entry must stay silent.
    // (ExitEntry/EntryExit bridges are unsuitable here: they land the bridge one hop from
    // one teleport's own entry, and that teleport is itself a 1-hop edge to its exit, so
    // Entry/Entry would pick up a short route *through the teleport itself* -- a real
    // topological path, not a check bug, but not what this test means to isolate.)
    let (maze, _, _) = maze_with_one_close_endpoint_pair(ClosePair::ExitExit);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn exit_vs_exit_selector_silent_when_the_close_pair_is_elsewhere() {
    let (maze, _, _) = maze_with_one_close_endpoint_pair(ClosePair::EntryEntry);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Exit,
        TeleportProximityEdge::Exit,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn stops_at_first_problematic_pair_per_teleport() {
    // a is close to both b and c -- per the spec ("once one problematic pair is found for a
    // teleport, record it and move to the next teleport"), scanning from a's side must
    // record exactly one pair (a, _), not both (a, b) and (a, c).
    let (field, mut g) = bootstrap_row(3);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let entry_b = p(1);
    let entry_c = p(2);
    let id_a = g.add_edge(entry_a, entry_a, EdgeKind::Teleport);
    let id_b = g.add_edge(entry_b, entry_b, EdgeKind::Teleport);
    let id_c = g.add_edge(entry_c, entry_c, EdgeKind::Teleport);
    g.add_bidirectional_edge(entry_a, entry_b, EdgeKind::Basic);
    g.add_bidirectional_edge(entry_b, entry_c, EdgeKind::Basic);
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
    let a_pairs: Vec<_> = pairs.iter().filter(|&&(x, _)| x == id_a).collect();
    assert_eq!(
        a_pairs.len(),
        1,
        "scanning from a's side must stop at the first problematic pair (b or c), not record both: {a_pairs:?}"
    );
    let (_, matched) = a_pairs[0];
    assert!(*matched == id_b || *matched == id_c);
}

#[test]
fn fires_for_both_directions_of_a_two_way_teleport_independently() {
    // A two-way teleport is two independent Teleport edges -- each direction is scanned as
    // its own element, same as TeleportSuperHubAvoidanceCheck/TeleportWaypointDistanceCheck.
    let (field, mut g) = bootstrap_row(5);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    g.add_bidirectional_edge(p(0), p(2), EdgeKind::Basic);
    let entry_a = p(0);
    let entry_b = p(2);
    let far_a = p(3);
    let far_b = p(4);
    let id_a = g.add_edge(entry_a, far_a, EdgeKind::Teleport);
    g.add_edge(far_a, entry_a, EdgeKind::Teleport); // reverse direction of teleport a
    let id_b = g.add_edge(entry_b, far_b, EdgeKind::Teleport);
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
    // The original forward id_a->id_b pair (and its symmetric b->a) must still be present;
    // the new reverse-direction teleport has its own entry (= a's old exit) far from b's
    // entry, so it should not itself produce a pair under Entry/Entry.
    assert!(
        pairs
            .iter()
            .any(|&(x, y)| (x == id_a && y == id_b) || (x == id_b && y == id_a))
    );
}

#[test]
fn a_two_way_teleport_never_pairs_with_its_own_reverse_direction() {
    // fwd and bwd are the two directions of one physical two-way teleport, entry/exit swapped --
    // fwd's entry and bwd's entry are the *same* two nodes as fwd's own endpoints, so under a
    // loose enough threshold they would look "close" to each other if not excluded. GitHub issue
    // #190: the reverse direction must never be recorded as a problematic pair with `own_id`,
    // regardless of distance.
    let (field, mut g) = bootstrap_row(3);
    let field_level = field.single_level_id();
    let nodes: Vec<_> = field
        .field_of(field_level)
        .unwrap()
        .all_cells()
        .map(|p| field.node_at(field_level, p).unwrap())
        .collect();
    g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
    g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    // A very high threshold: entry_a and entry_b of the pair are only 1 tile-hop apart via the
    // teleport itself (0 -> 2 -> 0), so without the reverse exclusion this would fire.
    check(
        1000.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "a two-way teleport's own reverse direction must never be reported as a problematic pair with itself"
    );
}
