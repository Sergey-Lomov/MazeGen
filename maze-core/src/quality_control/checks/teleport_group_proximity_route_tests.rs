use super::super::*;
use crate::ids::NodeId;
use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
use crate::{Graph, IdGenerator};
use rand::SeedableRng;

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
        MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    (field, g)
}

#[test]
fn unreachable_pair_in_both_directions_is_never_flagged() {
    let (field, mut g) = bootstrap_row(6);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    // Two isolated teleport pairs, no path connects them at all.
    g.add_edge(p(0), p(1), EdgeKind::Teleport);
    g.add_edge(p(4), p(5), EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        1000.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "unreachable in both directions must not be treated as distance 0"
    );
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
fn maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries()
-> (Maze<SquareTessellation>, NodeId, NodeId, NodeId, NodeId) {
    let (field, mut g) = bootstrap_row(6);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
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
    let (mut maze, entry_a, _exit_a, _entry_b, exit_b) =
        maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries();
    maze.meta.start = Some(entry_a);
    maze.meta.finish = Some(exit_b);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "a pair where both teleports are route-critical must not be recorded"
    );
}

#[test]
fn protect_route_still_records_a_pair_where_only_one_side_is_route_critical() {
    // start=entry_a, finish=exit_a: only teleport a is route-critical; teleport b is unrelated
    // and still a legitimate removal candidate, so the pair must still be recorded. entry_a and
    // entry_b are connected by a direct Basic corridor, independent of either teleport.
    let (mut maze, entry_a, exit_a, _entry_b, _exit_b) =
        maze_with_two_route_critical_teleports_and_a_direct_corridor_between_entries();
    maze.meta.start = Some(entry_a);
    maze.meta.finish = Some(exit_a);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(
        issues.len(),
        1,
        "a pair with only one route-critical side must still be recorded"
    );
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
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
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
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());

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
fn a_teleport_hop_is_never_used_as_a_shortcut_when_measuring_proximity() {
    // entry_a(0) -> exit_a(1) [teleport a]. exit_a is 1 hop (basic) from entry_b(2), which in
    // turn has its own teleport b. entry_a itself has NO basic connection to anything -- the
    // only edge out of it is the teleport. Before GitHub issue #190's fix, Dijkstra could ride
    // teleport a (1 hop) then the basic corridor (1 hop) to reach entry_b, reporting dist=2.
    // With teleport hops excluded from the traversal, entry_a has no path to entry_b at all.
    let (field, mut g) = bootstrap_row(4);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
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
    check(
        5.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "riding through a's own teleport hop must not count as pedestrian proximity to b"
    );
}

#[test]
fn a_basic_edge_running_parallel_to_a_teleport_still_counts_as_pedestrian_proximity() {
    // entry_a(0) -> exit_a(1): connected by BOTH a Teleport edge AND a plain Basic edge in the
    // same direction (Graph::add_edge's kind-aware dedup explicitly allows this). exit_a is
    // teleport b's entry. The Basic edge alone must be enough to make entry_a and exit_a look
    // close -- the presence of a parallel Teleport edge between the same pair must not blind the
    // Dijkstra pass to the genuinely pedestrian Basic edge sitting right alongside it.
    let (field, mut g) = bootstrap_row(3);
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
    let entry_a = p(0);
    let exit_a_entry_b = p(1);
    let exit_b = p(2);
    g.add_edge(entry_a, exit_a_entry_b, EdgeKind::Teleport);
    g.add_edge(entry_a, exit_a_entry_b, EdgeKind::Basic);
    g.add_edge(exit_a_entry_b, exit_b, EdgeKind::Teleport);
    let maze: Maze<SquareTessellation> = Maze::new(field, g);

    let mut issues = Vec::new();
    let mut rng = crate::random::MazeRng::seed_from_u64(0);
    check(
        3.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert_eq!(
        issues.len(),
        1,
        "the parallel Basic edge must still make entry_a and exit_a_entry_b look close, despite the Teleport edge sharing the same pair"
    );
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
    let field_level = field.single_level_id();
    let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
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
    check(
        10.0,
        TeleportProximityEdge::Entry,
        TeleportProximityEdge::Entry,
    )
    .repair_check(&maze, &mut issues, &mut rng, ());
    assert!(
        issues.is_empty(),
        "riding through an unrelated third teleport must not count as pedestrian proximity to b either"
    );
}
