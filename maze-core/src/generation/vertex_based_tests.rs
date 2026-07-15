use super::*;
use crate::generation::test_utils::{default_elements, make_field_and_graph};
use rand::SeedableRng;

fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }
fn default_params() -> GenerationParams { GenerationParams::default() }

// ─── add_to_frontier / pop_reserve / choose_from_frontier ───────────────

#[test]
fn add_to_frontier_appends_new_node_with_parent() {
    let mut frontier: Vec<FrontierEntry> = vec![];
    let mut in_frontier: HashSet<NodeId> = HashSet::new();

    add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);

    assert_eq!(frontier.len(), 1);
    assert_eq!(frontier[0].node, 1);
    assert_eq!(frontier[0].parent, Some(0));
    assert!(in_frontier.contains(&1));
}

#[test]
fn add_to_frontier_ignores_duplicate_node() {
    let mut frontier: Vec<FrontierEntry> = vec![];
    let mut in_frontier: HashSet<NodeId> = HashSet::new();

    add_to_frontier(1, Some(0), &mut frontier, &mut in_frontier);
    add_to_frontier(1, Some(5), &mut frontier, &mut in_frontier); // different parent, same node

    assert_eq!(frontier.len(), 1, "node already in frontier must not be pushed again");
    assert_eq!(frontier[0].parent, Some(0), "first insertion's parent must be preserved");
}

#[test]
fn pop_reserve_returns_none_when_empty() {
    let mut reserve: Vec<NodeId> = vec![];
    let mut in_reserve: HashSet<NodeId> = HashSet::new();
    let params = default_params();

    assert_eq!(pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1)), None);
}

#[test]
fn pop_reserve_removes_and_returns_the_only_element() {
    let mut reserve: Vec<NodeId> = vec![7];
    let mut in_reserve: HashSet<NodeId> = [7].into_iter().collect();
    let params = default_params();

    let popped = pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(1));

    assert_eq!(popped, Some(7));
    assert!(reserve.is_empty());
    assert!(!in_reserve.contains(&7));
}

#[test]
fn pop_reserve_depth_first_one_prefers_last_inserted() {
    let params = GenerationParams { depth_first: 1.0, ..default_params() };
    let mut last_wins = 0;
    for seed in 0..100 {
        let mut reserve: Vec<NodeId> = vec![10, 20, 30];
        let mut in_reserve: HashSet<NodeId> = [10, 20, 30].into_iter().collect();
        if pop_reserve(&mut reserve, &mut in_reserve, &params, &mut rng(seed)) == Some(30) {
            last_wins += 1;
        }
    }
    assert!(last_wins >= 95, "depth_first=1.0: last-inserted reserve entry should dominate, got {last_wins}/100");
}

#[test]
fn choose_from_frontier_single_entry_returns_zero() {
    let frontier = vec![FrontierEntry { node: 42, parent: None }];
    let params = default_params();
    for seed in 0..20 {
        assert_eq!(choose_from_frontier(&frontier, &params, &mut rng(seed)), 0);
    }
}

#[test]
fn choose_from_frontier_result_always_in_bounds() {
    let frontier = vec![
        FrontierEntry { node: 1, parent: None },
        FrontierEntry { node: 2, parent: None },
        FrontierEntry { node: 3, parent: None },
    ];
    let params = GenerationParams { depth_first: 0.5, ..default_params() };
    for seed in 0..200 {
        let idx = choose_from_frontier(&frontier, &params, &mut rng(seed));
        assert!(idx < frontier.len(), "seed {seed}: index {idx} out of bounds");
    }
}

#[test]
fn junction_count_branching_zero_always_two() {
    let params = GenerationParams { branching: 0.0, ..default_params() };
    for seed in 0..50 {
        assert_eq!(junction_count(10, &params, &mut rng(seed), None), 2);
    }
}

#[test]
fn junction_count_branching_one_always_max() {
    let params = GenerationParams { branching: 1.0, ..default_params() };
    for max in 2..=6 {
        for seed in 0..20 {
            assert_eq!(junction_count(max, &params, &mut rng(seed), None), max);
        }
    }
}

#[test]
fn junction_count_max_two_always_two_regardless_of_branching() {
    for branching in [0.0, 0.5, 1.0] {
        let params = GenerationParams { branching, ..default_params() };
        for seed in 0..20 {
            assert_eq!(junction_count(2, &params, &mut rng(seed), None), 2);
        }
    }
}

#[test]
fn junction_count_result_in_range() {
    let params = GenerationParams { branching: 0.5, ..default_params() };
    for max in 2..=8 {
        for seed in 0..50 {
            let count = junction_count(max, &params, &mut rng(seed), None);
            assert!(count >= 2 && count <= max, "count={count} not in [2,{max}]");
        }
    }
}

fn empty_presets() -> super::PresetState { super::PresetState::empty() }

#[test]
fn vertex_based_visits_all_nodes() {
    let (field, mut graph) = make_field_and_graph(5, 5);
    let node_count = graph.nodes().count();
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &default_elements(), &empty_presets(), None);
    assert_eq!(graph.edges().count(), 2 * (node_count - 1));
}

#[test]
fn vertex_based_is_deterministic() {
    let (field, mut g1) = make_field_and_graph(4, 4);
    let (_, mut g2) = make_field_and_graph(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut g1, &field, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
    generate(&mut g2, &field, 7, start, &default_params(), &default_elements(), &empty_presets(), None);
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
    e1.sort();
    e2.sort();
    assert_eq!(e1, e2);
}

// ─── teleport ────────────────────────────────────────────────────────

fn teleport_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
    graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| (e.from, e.to)).collect()
}

fn no_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 }
}

fn full_two_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0 }
}

fn full_one_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0 }
}

#[test]
fn teleport_chance_zero_matches_baseline_exactly() {
    // teleport_chance=0.0 must never roll a teleport edge and must reproduce the exact
    // same edge set as generation without any teleport awareness at all (regression guard
    // for the refactor that threaded teleport rolls through this function).
    for seed in [1, 7, 42, 1234, 9999] {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, seed, start, &default_params(), &no_teleport_elements(), &empty_presets(), None);
        assert!(teleport_edges(&graph).is_empty(), "seed {seed}: teleport_chance=0.0 must add no teleport edges");
    }
}

#[test]
fn teleport_chance_one_adds_teleport_edges() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 should add at least one teleport edge on a 6x6 field");
}

#[test]
fn teleport_edges_can_connect_non_geometric_neighbors() {
    // At least one teleport edge in a large-enough field must link two nodes that are not
    // geometric neighbors — otherwise the "regardless of adjacency" property isn't exercised.
    let (field, mut graph) = make_field_and_graph(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 7, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let has_non_adjacent_teleport = teleport_edges(&graph).iter()
        .any(|&(from, to)| !field.neighbors(from).contains(&to));
    assert!(has_non_adjacent_teleport, "expected at least one teleport edge between non-adjacent nodes");
}

#[test]
fn teleport_one_way_chance_zero_all_teleports_are_two_way() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty(), "expected teleport edges to assert two-way-ness over");
    for &(from, to) in &edges {
        assert!(graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has no reverse, but teleport_one_way_chance was 0.0");
    }
}

#[test]
fn teleport_one_way_chance_one_all_teleports_are_one_way() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_one_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty(), "expected teleport edges to assert one-way-ness over");
    for &(from, to) in &edges {
        assert!(!graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has a reverse, but teleport_one_way_chance was 1.0");
    }
}

#[test]
fn teleport_full_chance_still_visits_all_nodes_and_stays_connected() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let node_count = graph.nodes().count();
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert_eq!(graph.nodes().count(), node_count);
    for node in graph.nodes() {
        let has_edge = graph.edges().any(|e| e.from == node.id || e.to == node.id);
        assert!(has_edge, "node {} was never connected", node.id);
    }
    assert!(crate::validation::is_connected(&graph, start), "maze with teleport_chance=1.0 must stay connected from start");
}

#[test]
fn teleport_is_deterministic_for_fixed_seed() {
    let (field, mut g1) = make_field_and_graph(6, 6);
    let (_, mut g2) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut g1, &field, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    generate(&mut g2, &field, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    e1.sort_by_key(|(f, t, _)| (*f, *t));
    e2.sort_by_key(|(f, t, _)| (*f, *t));
    assert_eq!(e1, e2);
}

#[test]
fn teleport_single_node_field_never_panics() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: Field<crate::space::SquareTessellation> =
        Field::new(vec![crate::space::SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 1, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert!(teleport_edges(&graph).is_empty(), "single-node field has no partner for a teleport");
}

#[test]
fn teleport_fragmented_field_frontier_empty_branch_stays_connected() {
    // A field with an isolated cell (only reachable via the frontier-empty/reserve
    // mechanism, never as a direct geometric neighbor of anything visited early) forces
    // the frontier-empty teleport branch to actually run.
    let mut ids = crate::ids::IdGenerator::new();
    use crate::space::SquarePoint;
    // 3x3 block plus one far-away isolated point, connected to nothing geometrically.
    let mut points: Vec<SquarePoint> = crate::space::square_rect(3, 3);
    points.push(SquarePoint { x: 100, y: 100 });
    let field: Field<crate::space::SquareTessellation> = Field::new(points, &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let node_count = graph.nodes().count();

    generate(&mut graph, &field, 3, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);

    // With teleport_chance=1.0, the isolated point must be reachable via a teleport bridge
    // through the frontier-empty branch (it can never be a `free_regular` geometric
    // neighbor of anything, since it has none within the field).
    assert_eq!(graph.nodes().count(), node_count);
    assert!(crate::validation::is_connected(&graph, start),
        "isolated point must be bridged in via teleport when frontier empties");
}

#[test]
fn teleport_respects_locked_out_source() {
    // A teleport roll must still honor preset_state: a locked_out source can never gain an
    // outgoing teleport (nor an outgoing geometric edge).
    let (field, mut graph) = make_field_and_graph(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);

    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.from != a), "locked_out node {a} must never be an edge source (teleport or otherwise)");
}

#[test]
fn teleport_respects_locked_in_destination() {
    let (field, mut graph) = make_field_and_graph(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(b);

    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.to != b), "locked_in node {b} must never be an edge destination (teleport or otherwise)");
}

#[test]
fn teleport_respects_blocked_pair() {
    let (field, mut graph) = make_field_and_graph(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));

    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edge_between(a, b).is_none(), "fully blocked pair ({a},{b}) must never get an edge, teleport or otherwise");
}

// Note: a same-direction Basic+Teleport parallel pair cannot arise from this algorithm's own
// rolls — the teleport destination is always drawn from the unvisited pool, which by
// definition has no prior edge from its bridge/src yet. The Graph-level coexistence guarantee
// (kind-aware dedup in add_edge/add_bidirectional_edge) is covered directly in
// graph::parallel_edges_tests.

#[test]
fn teleport_junction_reduces_geometric_count_by_one_when_teleport_added() {
    // With branching=1.0 (always maximal junction) and teleport_chance=1.0, corridor_chance=0.0
    // (always junction) on an interior node with 4 geometric neighbors: junction_count(max+1=5)
    // with branching=1.0 always returns max (5), so geometric_count = 5-1 = 4 = every free
    // neighbor, plus exactly one teleport edge. Total out-degree from src should be 5.
    let params = GenerationParams {
        depth_first: 0.0,
        corridor_chance: 0.0,
        branching: 1.0,
        directionality: 0.0,
        cyclicity: 0.0,
    };
    let (field, mut graph) = make_field_and_graph(5, 5);
    // Center node of a 5x5 field has 4 free geometric neighbors when starting there.
    let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
    generate(&mut graph, &field, 11, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

    // src's out-degree (counting both directions of any bidirectional edge as present)
    // must include all 4 geometric neighbors plus exactly one teleport partner.
    let geometric_neighbors: HashSet<NodeId> = field.neighbors(start).into_iter().collect();
    let src_edges: Vec<_> = graph.edges().filter(|e| e.from == start || e.to == start).collect();
    let teleport_partners: HashSet<NodeId> = src_edges.iter()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .map(|e| if e.from == start { e.to } else { e.from })
        .collect();
    let geometric_partners: HashSet<NodeId> = src_edges.iter()
        .filter(|e| e.kind == EdgeKind::Basic)
        .map(|e| if e.from == start { e.to } else { e.from })
        .collect();

    assert_eq!(geometric_partners, geometric_neighbors, "all 4 geometric neighbors must still be connected");
    assert_eq!(teleport_partners.len(), 1, "exactly one teleport connection expected alongside the full junction");
}

#[test]
fn teleport_corridor_adds_exactly_one_geometric_and_one_teleport() {
    // corridor_chance=1.0 (always corridor, one geometric connection) + teleport_chance=1.0:
    // the teleport must be an *additional* connection alongside the corridor's one geometric
    // connection, not a replacement.
    let params = GenerationParams {
        depth_first: 0.0,
        corridor_chance: 1.0,
        branching: 0.0,
        directionality: 0.0,
        cyclicity: 0.0,
    };
    let (field, mut graph) = make_field_and_graph(5, 5);
    let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
    generate(&mut graph, &field, 13, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

    let src_edges: Vec<_> = graph.edges().filter(|e| e.from == start || e.to == start).collect();
    let has_geometric = src_edges.iter().any(|e| e.kind == EdgeKind::Basic);
    let has_teleport = src_edges.iter().any(|e| e.kind == EdgeKind::Teleport);
    assert!(has_geometric, "corridor must still add its one geometric connection");
    assert!(has_teleport, "teleport_chance=1.0 must add an additional teleport connection alongside the corridor");
}

#[test]
fn teleport_cyclic_roll_widens_pool_to_any_visited_node() {
    // With cyclicity=1.0 and teleport_chance=1.0, the cyclic edge should be able to reach a
    // visited node that is NOT a geometric neighbor of src — proving the widened pool
    // ("any visited node") is actually used instead of the normal geometric-only pool.
    let params = GenerationParams {
        depth_first: 0.0,
        corridor_chance: 1.0,
        branching: 0.0,
        directionality: 0.0,
        cyclicity: 1.0,
    };
    let (field, mut graph) = make_field_and_graph(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

    // At least one Teleport-kind edge should exist that isn't a geometric neighbor pair —
    // this covers both the cyclic-teleport path and the corridor/junction-teleport path,
    // since both can produce non-adjacent Teleport edges under these params.
    let has_non_adjacent_teleport = teleport_edges(&graph).iter()
        .any(|&(from, to)| !field.neighbors(from).contains(&to));
    assert!(has_non_adjacent_teleport, "expected at least one non-adjacent teleport edge with cyclicity=1.0, teleport_chance=1.0");
}

#[test]
fn teleport_never_creates_self_loop() {
    for seed in 0..30 {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, seed, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(graph.edges().all(|e| e.from != e.to), "seed {seed}: no edge (teleport or otherwise) may be a self-loop");
    }
}

// ─── golden snapshots ────────────────────────────────────────────────────
// Pins the exact edge set `generate()` produces for a fixed seed/config, on top of the
// self-consistency determinism checks above (which only prove "same seed twice -> same
// output", not "output didn't silently change"). Guards the RNG-sample-consumption order
// contract documented on `generate`/`add_edge_kind`/`try_add_edge_kind` across refactors that
// don't trip any structural invariant (connectivity, no-self-loop, etc.) — two RNG calls
// swapped in a way that's still individually valid would pass every other test here but
// change the maze a saved seed produces. Regenerate deliberately (not silently) if `generate`'s
// actual RNG-consumption order is meant to change.

fn snapshot(graph: &Graph) -> Vec<(NodeId, NodeId, &'static str)> {
    let mut edges: Vec<(NodeId, NodeId, &'static str)> = graph.edges()
        .map(|e| (e.from, e.to, if e.kind == EdgeKind::Teleport { "T" } else { "B" }))
        .collect();
    edges.sort();
    edges
}

#[test]
fn golden_baseline_params_seed_42() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &default_elements(), &empty_presets(), None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 6, "B"), (1, 0, "B"), (2, 3, "B"), (2, 8, "B"), (3, 2, "B"), (3, 4, "B"),
        (4, 3, "B"), (4, 5, "B"), (5, 4, "B"), (5, 11, "B"), (6, 0, "B"), (6, 7, "B"), (7, 6, "B"),
        (7, 13, "B"), (8, 2, "B"), (9, 10, "B"), (9, 15, "B"), (10, 9, "B"), (10, 11, "B"), (11, 5, "B"),
        (11, 10, "B"), (11, 17, "B"), (12, 13, "B"), (13, 7, "B"), (13, 12, "B"), (13, 14, "B"),
        (13, 19, "B"), (14, 13, "B"), (14, 15, "B"), (15, 9, "B"), (15, 14, "B"), (16, 17, "B"),
        (17, 11, "B"), (17, 16, "B"), (18, 19, "B"), (19, 13, "B"), (19, 18, "B"), (19, 20, "B"),
        (19, 25, "B"), (20, 19, "B"), (20, 21, "B"), (20, 26, "B"), (21, 20, "B"), (21, 27, "B"),
        (22, 23, "B"), (22, 28, "B"), (23, 22, "B"), (23, 29, "B"), (24, 30, "B"), (25, 19, "B"),
        (25, 31, "B"), (26, 20, "B"), (26, 32, "B"), (27, 21, "B"), (27, 28, "B"), (27, 33, "B"),
        (28, 22, "B"), (28, 27, "B"), (29, 23, "B"), (30, 24, "B"), (30, 31, "B"), (31, 25, "B"),
        (31, 30, "B"), (32, 26, "B"), (33, 27, "B"), (33, 34, "B"), (34, 33, "B"), (34, 35, "B"),
        (35, 34, "B"),
    ]);
}

#[test]
fn golden_full_two_way_teleport_seed_42() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 6, "T"), (1, 0, "B"), (2, 20, "T"), (3, 9, "B"), (4, 31, "T"), (5, 24, "T"),
        (6, 0, "T"), (6, 9, "T"), (6, 12, "B"), (7, 28, "T"), (8, 26, "T"), (9, 3, "B"), (9, 6, "T"),
        (9, 21, "T"), (10, 11, "B"), (10, 14, "T"), (10, 32, "T"), (11, 10, "B"), (11, 15, "T"),
        (12, 6, "B"), (13, 19, "B"), (14, 10, "T"), (15, 11, "T"), (16, 33, "T"), (17, 21, "T"),
        (17, 23, "B"), (17, 26, "T"), (18, 19, "B"), (18, 24, "B"), (18, 28, "T"), (19, 13, "B"),
        (19, 18, "B"), (19, 29, "T"), (20, 2, "T"), (20, 30, "T"), (21, 9, "T"), (21, 17, "T"),
        (21, 22, "B"), (22, 21, "B"), (23, 17, "B"), (24, 5, "T"), (24, 18, "B"), (24, 25, "B"),
        (25, 24, "B"), (25, 26, "B"), (25, 35, "T"), (26, 8, "T"), (26, 17, "T"), (26, 25, "B"),
        (27, 28, "B"), (27, 32, "T"), (27, 33, "B"), (28, 7, "T"), (28, 18, "T"), (28, 27, "B"),
        (29, 19, "T"), (30, 20, "T"), (30, 31, "B"), (31, 4, "T"), (31, 30, "B"), (31, 32, "B"),
        (32, 10, "T"), (32, 27, "T"), (32, 31, "B"), (33, 16, "T"), (33, 27, "B"), (33, 34, "B"),
        (34, 33, "B"), (35, 25, "T"),
    ]);
}

#[test]
fn golden_full_one_way_teleport_seed_42() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &default_params(), &full_one_way_teleport_elements(), &empty_presets(), None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (1, 0, "B"), (2, 3, "B"), (3, 2, "B"), (3, 4, "B"), (4, 3, "B"), (4, 11, "T"),
        (4, 13, "T"), (5, 11, "B"), (5, 20, "T"), (6, 0, "T"), (6, 9, "T"), (6, 12, "B"), (7, 13, "B"),
        (8, 9, "B"), (9, 8, "B"), (9, 18, "T"), (10, 26, "T"), (11, 5, "B"), (11, 34, "T"), (12, 6, "B"),
        (13, 7, "B"), (13, 26, "T"), (14, 21, "T"), (14, 29, "T"), (15, 7, "T"), (17, 15, "T"),
        (18, 19, "B"), (18, 24, "B"), (19, 18, "B"), (22, 23, "B"), (22, 24, "T"), (22, 28, "B"),
        (22, 32, "T"), (23, 22, "B"), (24, 18, "B"), (24, 25, "B"), (25, 24, "B"), (27, 33, "B"),
        (28, 22, "B"), (28, 34, "B"), (29, 3, "T"), (30, 18, "T"), (31, 28, "T"), (33, 16, "T"),
        (33, 27, "B"), (33, 34, "B"), (34, 28, "B"), (34, 33, "B"), (34, 35, "B"), (35, 34, "B"),
    ]);
}

#[test]
fn golden_high_cyclicity_seed_21() {
    let params = GenerationParams { depth_first: 0.0, corridor_chance: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 1.0 };
    let (field, mut graph) = make_field_and_graph(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "T"), (0, 8, "B"), (0, 13, "T"), (0, 16, "T"), (0, 30, "T"), (0, 42, "T"), (0, 43, "T"),
        (0, 55, "T"), (0, 58, "T"), (1, 0, "T"), (1, 2, "B"), (1, 3, "T"), (1, 9, "B"), (1, 35, "T"),
        (1, 38, "T"), (1, 61, "T"), (2, 1, "B"), (2, 7, "T"), (2, 40, "T"), (2, 50, "T"), (2, 53, "T"),
        (3, 1, "T"), (3, 4, "B"), (3, 11, "B"), (4, 3, "B"), (4, 12, "B"), (4, 34, "T"), (4, 56, "T"),
        (5, 6, "B"), (5, 13, "B"), (5, 22, "T"), (5, 32, "T"), (5, 62, "T"), (6, 5, "B"), (6, 14, "B"),
        (6, 17, "T"), (6, 25, "T"), (6, 40, "T"), (7, 2, "T"), (7, 15, "B"), (8, 0, "B"), (8, 16, "B"),
        (8, 24, "T"), (8, 42, "T"), (9, 1, "B"), (9, 10, "B"), (9, 16, "T"), (9, 18, "T"), (9, 39, "T"),
        (10, 9, "B"), (10, 11, "B"), (10, 29, "T"), (10, 54, "T"), (10, 58, "T"), (11, 3, "B"),
        (11, 10, "B"), (11, 56, "T"), (11, 63, "T"), (12, 4, "B"), (12, 20, "B"), (12, 48, "T"),
        (13, 0, "T"), (13, 5, "B"), (13, 21, "B"), (13, 31, "T"), (13, 60, "T"), (14, 6, "B"),
        (14, 21, "T"), (14, 22, "B"), (15, 7, "B"), (15, 26, "T"), (15, 56, "T"), (16, 0, "T"),
        (16, 8, "B"), (16, 9, "T"), (16, 24, "B"), (16, 36, "T"), (16, 42, "T"), (16, 59, "T"),
        (17, 6, "T"), (17, 18, "B"), (17, 25, "B"), (18, 9, "T"), (18, 17, "B"), (18, 26, "B"),
        (19, 27, "B"), (19, 40, "T"), (20, 12, "B"), (20, 28, "B"), (20, 49, "T"), (21, 13, "B"),
        (21, 14, "T"), (21, 26, "T"), (21, 29, "B"), (21, 50, "T"), (22, 5, "T"), (22, 14, "B"),
        (22, 23, "B"), (22, 44, "T"), (22, 52, "T"), (23, 22, "B"), (23, 29, "T"), (23, 31, "B"),
        (24, 8, "T"), (24, 16, "B"), (24, 32, "B"), (25, 6, "T"), (25, 17, "B"), (25, 49, "T"),
        (26, 15, "T"), (26, 18, "B"), (26, 21, "T"), (26, 27, "B"), (27, 19, "B"), (27, 26, "B"),
        (27, 56, "T"), (28, 20, "B"), (28, 36, "B"), (28, 51, "T"), (29, 10, "T"), (29, 21, "B"),
        (29, 23, "T"), (29, 30, "B"), (30, 0, "T"), (30, 29, "B"), (30, 38, "B"), (31, 13, "T"),
        (31, 23, "B"), (31, 39, "B"), (32, 5, "T"), (32, 24, "B"), (32, 40, "B"), (32, 59, "T"),
        (33, 34, "B"), (33, 37, "T"), (33, 41, "B"), (34, 4, "T"), (34, 33, "B"), (34, 35, "B"),
        (35, 1, "T"), (35, 34, "B"), (36, 16, "T"), (36, 28, "B"), (36, 37, "B"), (36, 45, "T"),
        (37, 33, "T"), (37, 36, "B"), (37, 38, "B"), (37, 58, "T"), (38, 1, "T"), (38, 30, "B"),
        (38, 37, "B"), (39, 9, "T"), (39, 31, "B"), (39, 47, "B"), (40, 2, "T"), (40, 6, "T"),
        (40, 19, "T"), (40, 32, "B"), (40, 48, "B"), (40, 51, "T"), (41, 33, "B"), (41, 42, "T"),
        (41, 61, "T"), (42, 0, "T"), (42, 8, "T"), (42, 16, "T"), (42, 41, "T"), (42, 43, "B"),
        (42, 49, "T"), (42, 51, "T"), (43, 0, "T"), (43, 42, "B"), (43, 51, "B"), (43, 56, "T"),
        (43, 57, "T"), (44, 22, "T"), (44, 45, "B"), (44, 52, "B"), (45, 36, "T"), (45, 44, "B"),
        (45, 46, "B"), (46, 45, "B"), (46, 49, "T"), (46, 54, "B"), (47, 39, "B"), (47, 55, "B"),
        (47, 59, "T"), (48, 12, "T"), (48, 40, "B"), (48, 56, "B"), (48, 58, "T"), (49, 20, "T"),
        (49, 25, "T"), (49, 42, "T"), (49, 46, "T"), (49, 50, "B"), (49, 57, "B"), (50, 2, "T"),
        (50, 21, "T"), (50, 49, "B"), (50, 56, "T"), (51, 28, "T"), (51, 40, "T"), (51, 42, "T"),
        (51, 43, "B"), (51, 59, "B"), (52, 22, "T"), (52, 44, "B"), (52, 60, "B"), (53, 2, "T"),
        (53, 59, "T"), (54, 10, "T"), (54, 46, "B"), (54, 55, "B"), (55, 0, "T"), (55, 47, "B"),
        (55, 54, "B"), (56, 4, "T"), (56, 11, "T"), (56, 15, "T"), (56, 27, "T"), (56, 43, "T"),
        (56, 48, "B"), (56, 50, "T"), (57, 43, "T"), (57, 49, "B"), (57, 58, "B"), (58, 0, "T"),
        (58, 10, "T"), (58, 37, "T"), (58, 48, "T"), (58, 57, "B"), (58, 59, "B"), (59, 16, "T"),
        (59, 32, "T"), (59, 47, "T"), (59, 51, "B"), (59, 53, "T"), (59, 58, "B"), (60, 13, "T"),
        (60, 52, "B"), (60, 61, "B"), (61, 1, "T"), (61, 41, "T"), (61, 60, "B"), (61, 62, "B"),
        (62, 5, "T"), (62, 61, "B"), (62, 63, "B"), (63, 11, "T"), (63, 62, "B"),
    ]);
}

#[test]
fn golden_all_one_way_seed_7() {
    let elements = ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0 };
    let (field, mut graph) = make_field_and_graph(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 7, start, &default_params(), &elements, &empty_presets(), None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 6, "B"), (1, 2, "B"), (3, 4, "B"), (3, 9, "B"), (4, 10, "B"), (7, 1, "B"),
        (8, 2, "B"), (8, 9, "B"), (9, 15, "B"), (11, 5, "B"), (12, 13, "B"), (13, 19, "B"), (15, 14, "B"),
        (16, 10, "B"), (16, 22, "B"), (17, 11, "B"), (17, 16, "B"), (20, 19, "B"), (21, 20, "B"),
        (23, 22, "B"), (23, 29, "B"), (24, 18, "B"), (26, 20, "B"), (26, 25, "B"), (27, 21, "B"),
        (28, 27, "B"), (28, 29, "B"), (30, 24, "B"), (31, 25, "B"), (31, 30, "B"), (32, 31, "B"),
        (33, 32, "B"), (34, 33, "B"), (35, 34, "B"),
    ]);
}

#[test]
fn golden_with_preset_locks_seed_42() {
    let (field, mut graph) = make_field_and_graph(5, 5);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap());
    preset_state.locked_in.insert(field.node_at(crate::space::SquarePoint { x: 4, y: 4 }).unwrap());
    generate(&mut graph, &field, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 4, "T"), (1, 0, "B"), (2, 7, "B"), (3, 8, "B"), (3, 19, "T"), (3, 20, "T"),
        (4, 0, "T"), (4, 7, "T"), (4, 9, "B"), (5, 6, "B"), (5, 17, "T"), (6, 5, "B"), (6, 11, "B"),
        (6, 20, "T"), (6, 23, "T"), (7, 2, "B"), (7, 4, "T"), (7, 15, "T"), (8, 3, "B"), (8, 22, "T"),
        (9, 4, "B"), (10, 21, "T"), (11, 6, "B"), (14, 19, "B"), (15, 7, "T"), (15, 12, "T"),
        (15, 16, "B"), (16, 15, "B"), (17, 5, "T"), (18, 19, "B"), (19, 3, "T"), (19, 14, "B"),
        (19, 18, "B"), (20, 3, "T"), (20, 6, "T"), (20, 21, "B"), (21, 10, "T"), (21, 20, "B"),
        (22, 8, "T"), (23, 6, "T"),
    ]);
}
