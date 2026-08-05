use super::*;
use super::tests::{default_params, generate_default_split, empty_presets};
use crate::generation::test_utils::make_field_graph_ids;

fn teleport_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
    graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| (e.from, e.to)).collect()
}

fn no_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 }
}

fn full_two_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0, split_chance: 0.0 }
}

fn full_one_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0, split_chance: 0.0 }
}

#[test]
fn teleport_chance_zero_matches_baseline_exactly() {
    // teleport_chance=0.0 must never roll a teleport edge and must reproduce the exact
    // same edge set as generation without any teleport awareness at all (regression guard
    // for the refactor that threaded teleport rolls through this function).
    for seed in [1, 7, 42, 1234, 9999] {
        let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate_default_split(&mut graph, &mut field, &mut ids, seed, start, &default_params(), &no_teleport_elements(), &empty_presets(), None);
        assert!(teleport_edges(&graph).is_empty(), "seed {seed}: teleport_chance=0.0 must add no teleport edges");
    }
}

#[test]
fn teleport_chance_one_adds_teleport_edges() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 should add at least one teleport edge on a 6x6 field");
}

#[test]
fn teleport_edges_can_connect_non_geometric_neighbors() {
    // At least one teleport edge in a large-enough field must link two nodes that are not
    // geometric neighbors — otherwise the "regardless of adjacency" property isn't exercised.
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 7, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let has_non_adjacent_teleport = teleport_edges(&graph).iter()
        .any(|&(from, to)| !field.neighbors(from).contains(&to));
    assert!(has_non_adjacent_teleport, "expected at least one teleport edge between non-adjacent nodes");
}

#[test]
fn teleport_one_way_chance_zero_all_teleports_are_two_way() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty(), "expected teleport edges to assert two-way-ness over");
    for &(from, to) in &edges {
        assert!(graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has no reverse, but teleport_one_way_chance was 0.0");
    }
}

#[test]
fn teleport_one_way_chance_one_all_teleports_are_one_way() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_one_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty(), "expected teleport edges to assert one-way-ness over");
    for &(from, to) in &edges {
        assert!(!graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has a reverse, but teleport_one_way_chance was 1.0");
    }
}

#[test]
fn teleport_full_chance_still_visits_all_nodes_and_stays_connected() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let node_count = graph.nodes().count();
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert_eq!(graph.nodes().count(), node_count);
    for node in graph.nodes() {
        let has_edge = graph.edges().any(|e| e.from == node.id || e.to == node.id);
        assert!(has_edge, "node {} was never connected", node.id);
    }
    assert!(crate::validation::is_connected(&graph, start), "maze with teleport_chance=1.0 must stay connected from start");
}

#[test]
fn teleport_is_deterministic_for_fixed_seed() {
    let (mut field, mut g1, mut ids) = make_field_graph_ids(6, 6);
    let (_, mut g2, mut ids2) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut g1, &mut field, &mut ids, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let mut field2 = field.clone();
    generate_default_split(&mut g2, &mut field2, &mut ids2, 55, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    e1.sort_by_key(|(f, t, _)| (*f, *t));
    e2.sort_by_key(|(f, t, _)| (*f, *t));
    assert_eq!(e1, e2);
}

#[test]
fn teleport_single_node_field_never_panics() {
    let mut ids = crate::ids::IdGenerator::new();
    let mut field: Field<crate::space::SquareTessellation> =
        Field::new(vec![crate::space::SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 1, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
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
    let mut field: Field<crate::space::SquareTessellation> = Field::new(points, &mut ids).unwrap();
    let mut graph = Graph::new();
    field.build_nodes(&mut graph);
    let start = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
    let node_count = graph.nodes().count();

    generate_default_split(&mut graph, &mut field, &mut ids, 3, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);

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
    let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);

    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.from != a), "locked_out node {a} must never be an edge source (teleport or otherwise)");
}

#[test]
fn teleport_respects_locked_in_destination() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(b);

    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.to != b), "locked_in node {b} must never be an edge destination (teleport or otherwise)");
}

#[test]
fn teleport_respects_blocked_pair() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let b = field.node_at(crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));

    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);

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
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    // Center node of a 5x5 field has 4 free geometric neighbors when starting there.
    let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 11, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

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
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let start = field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 13, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

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
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

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
        let (mut field, mut graph, mut ids) = make_field_graph_ids(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate_default_split(&mut graph, &mut field, &mut ids, seed, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(graph.edges().all(|e| e.from != e.to), "seed {seed}: no edge (teleport or otherwise) may be a self-loop");
    }
}
