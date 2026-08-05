use super::*;
use crate::quality_control::Issue;
use rand::SeedableRng;
use crate::{Graph, IdGenerator};
use crate::ids::NodeId;
use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

const TEST_ID: &str = "teleport_group_proximity";

fn check(distance: f64, own_edge: TeleportProximityEdge, other_edge: TeleportProximityEdge) -> TeleportGroupProximityCheck {
    TeleportGroupProximityCheck { instance_id: TEST_ID.to_string(), distance, own_edge, other_edge, protect_route: true }
}

/// Flattens `issue.groups` (`Vec<(Vec<EdgeId>, u32)>`, each entry a two-element proximity pair)
/// back into `(EdgeId, EdgeId)` pairs -- lets the rest of this file's assertions read the same
/// way they did before GitHub issue #209 migrated the issue onto the generic group shape.
fn pairs_of(issue: &InvalidTeleportGroupIssue) -> Vec<(EdgeId, EdgeId)> {
    issue.groups.iter().map(|(g, _)| {
        assert_eq!(g.len(), 2, "every teleport proximity group must have exactly two elements");
        (g[0], g[1])
    }).collect()
}

/// Shared test-maze bootstrap: a `width`-wide, 1-tall `SquareTessellation` field with an empty
/// `Graph` (no edges built in yet) plus a `p(x)` helper resolving row-0 tile x to its `NodeId` —
/// every test below builds its own edges on top of this same field/graph shape.
fn bootstrap_row(width: usize) -> (Field<SquareTessellation>, Graph) {
    let mut ids = IdGenerator::new();
    let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    field.build_nodes(&mut g);
    (field, g)
}

#[test]
fn silent_with_fewer_than_two_teleports() {
    let (field, mut g) = bootstrap_row(3);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(1000.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

/// Two teleports whose entries sit `entry_gap` nav-hops apart on a shared corridor:
/// entry_a(0) -- ... -- entry_b(entry_gap), each teleporting off to its own far node.
fn maze_with_two_teleport_entries_at_gap(entry_gap: usize) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    let width = entry_gap + 3;
    let (field, mut g) = bootstrap_row(width);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
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
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert_eq!(pairs.len(), 2, "both directions of the scan (a->b and b->a) each record their own pair entry");
    for &(x, y) in &pairs {
        assert!((x == id_a && y == id_b) || (x == id_b && y == id_a));
    }
}

#[test]
fn silent_when_entries_farther_than_threshold() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(10);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn silent_when_threshold_is_zero() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(0);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(0.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "a threshold of 0 should never flag any pair");
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
    check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze_close, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "gap of 1 tile-hop must fire against threshold 1.5");

    let (maze_far, _, _) = maze_with_two_teleport_entries_at_gap(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze_far, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "gap of 2 tile-hops must stay silent against threshold 1.5");
}

#[test]
fn records_a_fractional_distance_as_a_detail_without_truncation() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(1);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(1.5, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].details().get(TEST_ID).and_then(|kv| kv.get("distance")), Some(&"1.5".to_string()));
}

#[test]
fn respects_directed_edges_reverse_still_counts_via_min() {
    // A one-way corridor a->b: forward distance a->b is 2, reverse (b->a) is unreachable.
    // min(forward, reverse) must still catch it via the forward side.
    let (field, mut g) = bootstrap_row(5);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way only
    g.add_edge(p(1), p(2), EdgeKind::Basic); // one-way only
    let id_a = g.add_edge(p(0), p(3), EdgeKind::Teleport);
    let id_b = g.add_edge(p(2), p(4), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b), "forward a->b (distance 2) must be caught even though b->a is unreachable");
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
enum ClosePair { EntryEntry, EntryExit, ExitEntry, ExitExit }

fn maze_with_one_close_endpoint_pair(close: ClosePair) -> (Maze<SquareTessellation>, EdgeId, EdgeId) {
    // Four far-apart corridors (20 tiles each) plus a short bridge for the close pair,
    // arranged as four disjoint blocks: entry_a=[0..20], exit_a=[20..40], entry_b=[40..60],
    // exit_b=[60..80]. Every block is a straight bidirectional corridor with no cross-links,
    // so the only routes between blocks are the two teleport edges themselves.
    let (field, mut g) = bootstrap_row(80);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
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
    check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn entry_vs_exit_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::EntryExit);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn exit_vs_entry_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitEntry);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
}

#[test]
fn exit_vs_exit_selector_fires_only_on_the_close_pair() {
    let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(ClosePair::ExitExit);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
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
        check(3.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "own=EntryOrExit must fire regardless of which own end is close");
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
        check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = pairs_of(&issues[0]);
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }
}

#[test]
fn both_entry_or_exit_fires_for_any_close_combination() {
    for close in [ClosePair::EntryEntry, ClosePair::EntryExit, ClosePair::ExitEntry, ClosePair::ExitExit] {
        let (maze, id_a, id_b) = maze_with_one_close_endpoint_pair(close);
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check(3.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let pairs = pairs_of(&issues[0]);
        assert!(pairs.iter().any(|&(x, y)| x == id_a && y == id_b));
    }
}

#[test]
fn entry_or_exit_silent_when_nothing_is_close() {
    let (field, mut g) = bootstrap_row(6);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(4), p(5), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(1000.0, TeleportProximityEdge::EntryOrExit, TeleportProximityEdge::EntryOrExit).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "unreachable in every combination must not be treated as distance 0");
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
    check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn exit_vs_exit_selector_silent_when_the_close_pair_is_elsewhere() {
    let (maze, _, _) = maze_with_one_close_endpoint_pair(ClosePair::EntryEntry);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(3.0, TeleportProximityEdge::Exit, TeleportProximityEdge::Exit).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty());
}

#[test]
fn unreachable_pair_in_both_directions_is_never_flagged() {
    let (field, mut g) = bootstrap_row(6);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    // Two isolated teleport pairs, no path connects them at all.
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(4), p(5), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(1000.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "unreachable in both directions must not be treated as distance 0");
}

/// entry_a(0) and entry_b(2) are 1 hop apart via a one-way Basic edge entry_b->entry_a --
/// independent of either teleport, so their proximity (measured via `min(forward, reverse)`,
/// same as the check itself) is genuine, not an artifact of routing through a teleport hop
/// (GitHub issue #190). It's one-way (not bidirectional) so it can never shortcut the
/// entry_a->exit_b route below: `route_info` only ever searches forward from `start`, and
/// entry_a has no *forward* edge to entry_b, only a reverse one. A separate forward-only route
/// chain (start=entry_a -> exit_a via teleport a -> bridge -> entry_b -> exit_b via teleport b
/// -> finish) makes both teleports route-critical without that chain being the reason
/// entry_a/entry_b look close to each other.
fn maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries() -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId, NodeId) {
    let (field, mut g) = bootstrap_row(6);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let exit_a = p(1);
    let entry_b = p(2);
    let exit_b = p(3);
    let bridge = p(4);
    g.add_edge(entry_b, entry_a, EdgeKind::Basic); // one-way proximity edge, reverse direction only
    g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
    g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
    // Forward-only route chain: entry_a -> exit_a (teleport a) -> bridge -> entry_b (basic) ->
    // exit_b (teleport b), entirely separate from the entry_b->entry_a proximity edge above.
    g.add_edge(exit_a, bridge, EdgeKind::Basic);
    g.add_edge(bridge, entry_b, EdgeKind::Basic);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);
    (maze, entry_a, exit_a, entry_b, exit_b)
}

#[test]
fn protect_route_excludes_a_pair_where_both_teleports_are_route_critical() {
    // start=entry_a, finish=exit_b: the only route is entry_a->exit_a (teleport a) ->
    // bridge -> entry_b (basic) -> exit_b (teleport b) -- both teleports are route-critical.
    // entry_a and entry_b are still only 1 hop apart via their own direct corridor (well
    // within the check's threshold), so without protect_route this pair would fire.
    let (mut maze, entry_a, _exit_a, _entry_b, exit_b) = maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries();
    maze.meta.start = Some(entry_a);
    maze.meta.finish = Some(exit_b);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "a pair where both teleports are route-critical must not be recorded");
}

#[test]
fn protect_route_still_records_a_pair_where_only_one_side_is_route_critical() {
    // start=entry_a, finish=exit_a: only teleport a is route-critical; teleport b is unrelated
    // and still a legitimate removal candidate, so the pair must still be recorded. entry_a and
    // entry_b are connected by a direct Basic corridor, independent of either teleport.
    let (mut maze, entry_a, exit_a, _entry_b, _exit_b) = maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries();
    maze.meta.start = Some(entry_a);
    maze.meta.finish = Some(exit_a);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "a pair with only one route-critical side must still be recorded");
}

#[test]
fn protect_route_skips_a_fully_protected_pair_and_still_finds_a_farther_unprotected_one() {
    // a's first-scanned candidate (b) is close AND both route-critical -- excluded, but the
    // scan for `a` must not stop there: a second candidate (c), also close but NOT
    // route-critical, must still be found and recorded. This exercises that skipping a
    // fully-protected pair doesn't `break` (unlike a normal hit), so a route-critical
    // teleport doesn't silently "use up" its scan slot on an unresolvable pair.
    //
    // Layout: entry_a(0) -> exit_a(1) [teleport a, route-critical]
    //         exit_a --- entry_b(2)   [basic corridor, 1 hop]
    //         entry_b(2) -> exit_b(3) [teleport b, route-critical -- inserted first so the
    //                                  scan visits it before c]
    //         exit_b --- entry_c(4)  is NOT built -- c is reached via its own short bridge
    //         from entry_a instead, so it's close to a but off the actual route entirely.
    let (field, mut g) = bootstrap_row(7);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let exit_a = p(1);
    let entry_b = p(2);
    let exit_b = p(3);
    let entry_c = p(5);
    let exit_c = p(6);

    let id_a = g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
    g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic);
    // b inserted before c so the scan from a's side visits b (the protected candidate) first.
    let id_b = g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
    // c sits near entry_a via its own short bridge -- close enough to be a candidate, but
    // reaching finish through c is impossible (c dead-ends past exit_c with no way back to
    // exit_b), so c is not on the route and not route-critical.
    g.add_bidirectional_edge(entry_a, entry_c, EdgeKind::Basic);
    let id_c = g.add_edge(entry_c, exit_c, EdgeKind::Teleport);

    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    maze.meta.start = Some(entry_a);
    maze.meta.finish = Some(exit_b);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());

    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    // The key assertion is the *direction* (a, c): if the skip incorrectly `break`s a's scan
    // right after seeing the protected (a, b) candidate, a's own scan records nothing at all
    // for `a` — the only way (a, c)/(c, a) could still appear would be from c's own
    // independent scan (recorded as (c, a), never (a, c)). Asserting the exact (a, c)
    // direction is what actually exercises "skip doesn't break the scan", not a looser
    // "either direction" check which a regression could still satisfy via c's side alone.
    assert!(
        pairs.contains(&(id_a, id_c)),
        "a's scan must skip the fully-protected (a, b) pair and still record (a, c) from a's own side: got {pairs:?}"
    );
    assert!(
        !pairs.contains(&(id_a, id_b)) && !pairs.contains(&(id_b, id_a)),
        "the fully-protected (a, b) pair must never be recorded: got {pairs:?}"
    );
}

#[test]
fn stops_at_first_problematic_pair_per_teleport() {
    // a is close to both b and c -- per the spec ("once one problematic pair is found for a
    // teleport, record it and move to the next teleport"), scanning from a's side must
    // record exactly one pair (a, _), not both (a, b) and (a, c).
    let (field, mut g) = bootstrap_row(3);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
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
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    let a_pairs: Vec<_> = pairs.iter().filter(|&&(x, _)| x == id_a).collect();
    assert_eq!(a_pairs.len(), 1, "scanning from a's side must stop at the first problematic pair (b or c), not record both: {a_pairs:?}");
    let (_, matched) = a_pairs[0];
    assert!(*matched == id_b || *matched == id_c);
}

#[test]
fn records_the_configured_distance_as_a_detail() {
    let (maze, _, _) = maze_with_two_teleport_entries_at_gap(2);
    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].details().get(TEST_ID).and_then(|kv| kv.get("distance")), Some(&"5".to_string()));
}

#[test]
fn check_type_id_matches_registered_type_id() {
    let c = check(0.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry);
    assert_eq!(<TeleportGroupProximityCheck as Check<SquareTessellation, InvalidTeleportGroupIssue>>::check_type_id(&c), "teleport_group_proximity");
}

#[test]
fn fires_for_both_directions_of_a_two_way_teleport_independently() {
    // A two-way teleport is two independent Teleport edges -- each direction is scanned as
    // its own element, same as TeleportSuperHubAvoidanceCheck/TeleportWaypointDistanceCheck.
    let (field, mut g) = bootstrap_row(5);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
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
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1);
    let pairs = pairs_of(&issues[0]);
    // The original forward id_a->id_b pair (and its symmetric b->a) must still be present;
    // the new reverse-direction teleport has its own entry (= a's old exit) far from b's
    // entry, so it should not itself produce a pair under Entry/Entry.
    assert!(pairs.iter().any(|&(x, y)| (x == id_a && y == id_b) || (x == id_b && y == id_a)));
}

#[test]
fn a_teleport_hop_is_never_used_as_a_shortcut_when_measuring_proximity() {
    // entry_a(0) -> exit_a(1) [teleport a]. exit_a is 1 hop (basic) from entry_b(2), which in
    // turn has its own teleport b. entry_a itself has NO basic connection to anything -- the
    // only edge out of it is the teleport. Before GitHub issue #190's fix, Dijkstra could ride
    // teleport a (1 hop) then the basic corridor (1 hop) to reach entry_b, reporting dist=2.
    // With teleport hops excluded from the traversal, entry_a has no path to entry_b at all.
    let (field, mut g) = bootstrap_row(4);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let exit_a = p(1);
    let entry_b = p(2);
    let exit_b = p(3);
    g.add_edge(entry_a, exit_a, EdgeKind::Teleport);
    g.add_bidirectional_edge(exit_a, entry_b, EdgeKind::Basic);
    g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(5.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "riding through a's own teleport hop must not count as pedestrian proximity to b");
}

#[test]
fn a_basic_edge_running_parallel_to_a_teleport_still_counts_as_pedestrian_proximity() {
    // entry_a(0) -> exit_a(1): connected by BOTH a Teleport edge AND a plain Basic edge in the
    // same direction (Graph::add_edge's kind-aware dedup explicitly allows this). exit_a is
    // teleport b's entry. The Basic edge alone must be enough to make entry_a and exit_a look
    // close -- the presence of a parallel Teleport edge between the same pair must not blind the
    // Dijkstra pass to the genuinely pedestrian Basic edge sitting right alongside it.
    let (field, mut g) = bootstrap_row(3);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let exit_a_entry_b = p(1);
    let exit_b = p(2);
    g.add_edge(entry_a, exit_a_entry_b, EdgeKind::Teleport);
    g.add_edge(entry_a, exit_a_entry_b, EdgeKind::Basic);
    g.add_edge(exit_a_entry_b, exit_b, EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(3.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(issues.len(), 1, "the parallel Basic edge must still make entry_a and exit_a_entry_b look close, despite the Teleport edge sharing the same pair");
}

#[test]
fn a_third_unrelated_teleport_is_never_used_as_a_shortcut_when_measuring_proximity() {
    // entry_a(0) -> far_a(1) [teleport a] -- far_a is otherwise isolated except for teleport c.
    // far_a -> entry_c(2) [teleport c] -- entry_c is 1 basic hop from entry_b(3), which has its
    // own teleport b. Before the fix, Dijkstra from entry_a could ride teleport a, then teleport
    // c, then the basic hop, to reach entry_b (dist=3) -- none of that is real pedestrian
    // proximity, it's three teleport-assisted jumps. With ALL teleport hops excluded (not just
    // a's own), entry_a has no path to entry_b at all: it has no basic edges whatsoever.
    let (field, mut g) = bootstrap_row(6);
    let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let far_a = p(1);
    let entry_c = p(2);
    let entry_b = p(3);
    let exit_b = p(4);
    g.add_edge(entry_a, far_a, EdgeKind::Teleport);
    g.add_edge(far_a, entry_c, EdgeKind::Teleport);
    g.add_bidirectional_edge(entry_c, entry_b, EdgeKind::Basic);
    g.add_edge(entry_b, exit_b, EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(10.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "riding through an unrelated third teleport must not count as pedestrian proximity to b either");
}

#[test]
fn a_two_way_teleport_never_pairs_with_its_own_reverse_direction() {
    // fwd and bwd are the two directions of one physical two-way teleport, entry/exit swapped --
    // fwd's entry and bwd's entry are the *same* two nodes as fwd's own endpoints, so under a
    // loose enough threshold they would look "close" to each other if not excluded. GitHub issue
    // #190: the reverse direction must never be recorded as a problematic pair with `own_id`,
    // regardless of distance.
    let (field, mut g) = bootstrap_row(3);
    let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
    g.add_edge(nodes[0], nodes[2], EdgeKind::Teleport);
    g.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    // A very high threshold: entry_a and entry_b of the pair are only 1 tile-hop apart via the
    // teleport itself (0 -> 2 -> 0), so without the reverse exclusion this would fire.
    check(1000.0, TeleportProximityEdge::Entry, TeleportProximityEdge::Entry).repair_check(&maze, &mut issues, &mut rng, ());
    assert!(issues.is_empty(), "a two-way teleport's own reverse direction must never be reported as a problematic pair with itself");
}
