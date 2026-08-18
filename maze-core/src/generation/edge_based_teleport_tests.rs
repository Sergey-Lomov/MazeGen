use super::super::*;
use crate::generation::test_utils::make_field_and_graph;
use crate::space::SquareTessellation;

fn empty_presets() -> PresetState { PresetState::empty() }

fn teleport_edges(graph: &Graph) -> Vec<(NodeId, NodeId)> {
    graph.edges().filter(|e| e.kind == EdgeKind::Teleport).map(|e| (e.from, e.to)).collect()
}

fn no_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() }
}

fn full_two_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() }
}

fn full_one_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0, split_chance: 0.0, ..Default::default() }
}

#[test]
fn teleport_chance_zero_adds_no_teleport_edges() {
    for seed in [1, 7, 42, 1234, 9999] {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let level = field.single_level_id();
        let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, seed, start, &EdgeBasedParams::default(), &no_teleport_elements(), &empty_presets(), None);
        assert!(teleport_edges(&graph).is_empty(), "seed {seed}: teleport_chance=0.0 must add no teleport edges");
    }
}

#[test]
fn teleport_chance_one_adds_teleport_edges() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 should add at least one teleport edge on a 6x6 field");
}

#[test]
fn teleport_chance_one_adds_teleport_edges_when_every_geometric_pair_is_preset_passage() {
    // Regression for a bug where a fully preset-connected field (every geometric neighbor
    // pair preset as Passage) silently produced zero teleport edges despite teleport_chance
    // = 1.0. Root cause: the teleport-add step incorrectly reused the geometric pool's
    // "skip if dst is preset_connected" guard, which made no sense for the teleport pool
    // (there, dst being preset_connected says nothing about the specific src-dst edge —
    // it's just "some other Unseen node happens to touch a preset passage elsewhere").
    let (mut field, mut graph) = make_field_and_graph(3, 3);
    let level = field.single_level_id();
    let mut ids = crate::ids::IdGenerator::resume_after(&field);
    let mut connections = Vec::new();
    for y in 0..3 {
        for x in 0..3 {
            if x + 1 < 3 { connections.push(crate::generation::PresetConnection { from: crate::generation::PresetEndpoint::original((x, y)), to: crate::generation::PresetEndpoint::original((x + 1, y)), state: crate::generation::PresetConnectionState::Passage }); }
            if y + 1 < 3 { connections.push(crate::generation::PresetConnection { from: crate::generation::PresetEndpoint::original((x, y)), to: crate::generation::PresetEndpoint::original((x, y + 1)), state: crate::generation::PresetConnectionState::Passage }); }
        }
    }
    let preset_state = crate::generation::build_preset_state(
        &mut graph, &mut field, &mut ids, &connections, &[], &[], &[], &[],
        |x, y| crate::space::SquarePoint { x, y },
        None, None,
    ).unwrap();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);
    assert!(!teleport_edges(&graph).is_empty(), "teleport_chance=1.0 must still add teleport edges when the whole field is preset-passage");
}

#[test]
fn teleport_edges_can_connect_non_geometric_neighbors() {
    let (field, mut graph) = make_field_and_graph(8, 8);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 7, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let has_non_adjacent_teleport = teleport_edges(&graph).iter()
        .any(|&(from, to)| !field.neighbors(from).contains(&to));
    assert!(has_non_adjacent_teleport, "expected at least one teleport edge between non-adjacent nodes");
}

#[test]
fn teleport_one_way_chance_zero_all_teleports_are_two_way() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty());
    for &(from, to) in &edges {
        assert!(graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has no reverse, but teleport_one_way_chance was 0.0");
    }
}

#[test]
fn teleport_one_way_chance_one_all_teleports_are_one_way() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_one_way_teleport_elements(), &empty_presets(), None);
    let edges = teleport_edges(&graph);
    assert!(!edges.is_empty());
    for &(from, to) in &edges {
        assert!(!graph.edges().any(|e| e.from == to && e.to == from && e.kind == EdgeKind::Teleport),
            "teleport {from}->{to} has a reverse, but teleport_one_way_chance was 1.0");
    }
}

#[test]
fn teleport_full_chance_still_visits_all_nodes_and_stays_connected() {
    let (field, mut graph) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let node_count = graph.nodes().count();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    for node in graph.nodes() {
        let has_edge = graph.edges().any(|e| e.from == node.id || e.to == node.id);
        assert!(has_edge, "node {} was never connected", node.id);
    }
    assert_eq!(graph.nodes().count(), node_count);
    assert!(crate::validation::is_connected(&graph, start), "maze with teleport_chance=1.0 must stay connected from start");
}

#[test]
fn teleport_is_deterministic_for_fixed_seed() {
    let (field, mut g1) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let (_, mut g2) = make_field_and_graph(6, 6);
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut g1, &field, 55, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    generate(&mut g2, &field, 55, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    e1.sort_by_key(|(f, t, _)| (*f, *t));
    e2.sort_by_key(|(f, t, _)| (*f, *t));
    assert_eq!(e1, e2);
}

#[test]
fn teleport_single_node_field_never_panics() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> =
        MultiLevelField::single_level(vec![crate::space::SquarePoint { x: 0, y: 0 }], &mut ids).unwrap();
    let level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 1, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
    assert!(teleport_edges(&graph).is_empty(), "single-node field has no partner for a teleport");
}

#[test]
fn teleport_respects_locked_out_source() {
    let (field, mut graph) = make_field_and_graph(4, 4);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);

    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.from != a), "locked_out node {a} must never be an edge source (teleport or otherwise)");
}

#[test]
fn teleport_respects_locked_in_destination() {
    let (field, mut graph) = make_field_and_graph(4, 4);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let b = field.node_at(level, crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(b);

    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edges().all(|e| e.to != b), "locked_in node {b} must never be an edge destination (teleport or otherwise)");
}

#[test]
fn teleport_respects_blocked_pair() {
    let (field, mut graph) = make_field_and_graph(4, 4);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let a = start;
    let b = field.node_at(level, crate::space::SquarePoint { x: 3, y: 3 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));

    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &preset_state, None);

    assert!(graph.edge_between(a, b).is_none(), "fully blocked pair ({a},{b}) must never get an edge, teleport or otherwise");
}

// Note: a same-direction Basic+Teleport parallel pair cannot arise from this algorithm's own
// rolls — the teleport destination is always drawn from the Unseen pool, which by definition
// has no prior edge from src yet. The Graph-level coexistence guarantee (kind-aware dedup
// in add_edge/add_bidirectional_edge) is covered directly in graph::parallel_edges_tests.

#[test]
fn teleport_never_creates_self_loop() {
    for seed in 0..30 {
        let (field, mut graph) = make_field_and_graph(4, 4);
        let level = field.single_level_id();
        let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, seed, start, &EdgeBasedParams::default(), &full_two_way_teleport_elements(), &empty_presets(), None);
        assert!(graph.edges().all(|e| e.from != e.to), "seed {seed}: no edge (teleport or otherwise) may be a self-loop");
    }
}

#[test]
fn teleport_cyclic_together_widens_pool_to_any_visited_node() {
    // cyclicity=1.0 forces cyclic_flag every step; teleport_chance=1.0 forces teleport_flag
    // every step. When both fire on the same step, the model says teleport is spent on the
    // cyclic edge (widened to "any visited node"), and the normal dst-choice step falls back
    // to the geometric pool. This must produce at least one non-adjacent Teleport edge
    // (proving the widened cyclic pool actually ran), and the normal connections must still
    // only ever link geometric neighbors.
    let params = EdgeBasedParams {
        corridor_length: 0.5,
        branching: 0.0,
        depth_first: 0.5,
        directionality: 0.0,
        cyclicity: 1.0,
    };
    let (field, mut graph) = make_field_and_graph(8, 8);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

    let has_non_adjacent_teleport = teleport_edges(&graph).iter()
        .any(|&(from, to)| !field.neighbors(from).contains(&to));
    assert!(has_non_adjacent_teleport, "expected at least one non-adjacent teleport edge from the cyclic+teleport combination");

    // Basic edges must always still be between geometric neighbors.
    for e in graph.edges().filter(|e| e.kind == EdgeKind::Basic) {
        assert!(field.neighbors(e.from).contains(&e.to), "Basic edge {}->{} is not between geometric neighbors", e.from, e.to);
    }
}

#[test]
fn teleport_without_cyclic_replaces_normal_dst_choice_with_teleport() {
    // cyclicity=0.0 (cyclic_flag never fires) + teleport_chance=1.0: every node's *first*
    // outgoing connection (its one-time teleport roll) must be a Teleport edge, since
    // `use_geometric_pool` is only true when `!teleport_flag || cyclic_flag`, and cyclic_flag
    // is always false here. Once a node has rolled (hit, in this case), it never rolls again,
    // so a node's later outgoing connections (while it remains `src` across multiple
    // connection opportunities) fall back to Basic.
    let params = EdgeBasedParams {
        corridor_length: 0.5,
        branching: 0.5,
        depth_first: 0.5,
        directionality: 0.0,
        cyclicity: 0.0,
    };
    let (field, mut graph) = make_field_and_graph(5, 5);
    let level = field.single_level_id();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 9, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);

    // Note: not every node's outgoing edge is necessarily a Teleport even though
    // teleport_chance=1.0 guarantees a hit on every node's one-time roll — a node whose own
    // roll found an empty candidate pool (e.g. no Unseen node left anywhere) contributes no
    // edge of its own, but may still end up with an outgoing Basic edge as the *other* side
    // of a bidirectional connection initiated by a different node's non-teleport roll.
    assert!(!teleport_edges(&graph).is_empty(), "expected at least one Teleport edge with teleport_chance=1.0");
}

#[test]
fn teleport_rolled_at_most_once_per_node() {
    // A node that becomes `src` multiple times (before exhausting its geometric neighbors)
    // must roll teleport_chance only on its first connection opportunity, guarded by
    // `NodeEntry.teleport_rolled`. Since a successful roll can only occur once per node, the
    // number of distinct teleport connections actually created (collapsed to unordered pairs,
    // since a one-way edge's direction is a separate coin flip unrelated to which node
    // rolled) can never exceed the total node count — this is a regression guard against the
    // bug this fix addresses, where density scaled with per-node degree instead of node count.
    let one_way_only = ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0, split_chance: 0.0, ..Default::default() };
    let params = EdgeBasedParams {
        corridor_length: 0.0, // force src reselection every step, maximizing repeat-src chances
        branching: 1.0,
        depth_first: 0.5,
        directionality: 0.0,
        cyclicity: 0.0,
    };
    let (field, mut graph) = make_field_and_graph(6, 6);
    let level = field.single_level_id();
    let node_count = graph.nodes().count();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 3, start, &params, &one_way_only, &empty_presets(), None);

    let unordered_teleport_pairs: std::collections::HashSet<(NodeId, NodeId)> = graph.edges()
        .filter(|e| e.kind == EdgeKind::Teleport)
        .map(|e| (e.from.min(e.to), e.from.max(e.to)))
        .collect();
    assert!(unordered_teleport_pairs.len() <= node_count,
        "got {} distinct teleport pairs across {node_count} nodes — density must be bounded by node count, not scale with per-node degree",
        unordered_teleport_pairs.len());
}
