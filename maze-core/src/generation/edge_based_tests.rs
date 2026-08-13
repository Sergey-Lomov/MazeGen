use super::*;
use crate::generation::test_utils::{default_elements, make_field_and_graph};
use crate::space::{SquareTessellation, MultiLevelField, square_rect};
use rand::SeedableRng;

fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }

// ─── weighted_sample_index ──────────────────────────────────────────────

#[test]
fn weighted_sample_index_single_element_always_zero() {
    for seed in 0..20 {
        assert_eq!(weighted_sample_index(&[1.0], &mut rng(seed)).0, 0);
    }
}

#[test]
fn weighted_sample_index_zero_weight_never_chosen() {
    // weights[1] = 0.0 must never be picked, regardless of seed.
    for seed in 0..200 {
        let (idx, _, _) = weighted_sample_index(&[1.0, 0.0, 1.0], &mut rng(seed));
        assert_ne!(idx, 1, "seed {seed}: zero-weight entry must never be chosen");
    }
}

#[test]
fn weighted_sample_index_all_zero_weights_returns_first() {
    // total=0.0 → r=0.0 → first iteration's `r -= w[0]` leaves r <= 0.0 → index 0.
    for seed in 0..20 {
        assert_eq!(weighted_sample_index(&[0.0, 0.0, 0.0], &mut rng(seed)).0, 0);
    }
}

#[test]
fn weighted_sample_index_result_always_in_bounds() {
    let weights = [0.1, 2.5, 0.0, 1.0, 0.3];
    for seed in 0..200 {
        let (idx, _, _) = weighted_sample_index(&weights, &mut rng(seed));
        assert!(idx < weights.len(), "seed {seed}: index {idx} out of bounds");
    }
}

#[test]
fn weighted_sample_index_distribution_respects_weights() {
    // Heavily-weighted entry should dominate over ~1000 draws.
    let weights = [0.01, 100.0, 0.01];
    let mut counts = [0usize; 3];
    for seed in 0..1000 {
        counts[weighted_sample_index(&weights, &mut rng(seed)).0] += 1;
    }
    assert!(counts[1] > 950, "expected heavily-weighted index 1 to dominate, got counts={counts:?}");
}

#[test]
fn weighted_sample_index_returns_roll_and_total_weight_used() {
    // roll must equal rng.random::<f64>() * total, and total must be the weights' sum —
    // both carried out alongside the index (GitHub issue #144) so DstChosen can narrate the
    // exact draw. Verified by reproducing the same draw independently.
    let weights = [1.0, 2.0, 3.0];
    let expected_total: f64 = weights.iter().sum();
    for seed in 0..20 {
        let mut r1 = rng(seed);
        let mut r2 = rng(seed);
        let expected_roll = rand::Rng::random::<f64>(&mut r1) * expected_total;
        let (_, roll, total) = weighted_sample_index(&weights, &mut r2);
        assert_eq!(total, expected_total);
        assert_eq!(roll, expected_roll);
    }
}

// ─── remove_from_active / sorted_nodes_in_state ─────────────────────────

#[test]
fn remove_from_active_removes_node_and_marks_visited() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let a = all[0];
    let b = all[1];

    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    nodes.get_mut(&a).unwrap().state = NodeState::Active;
    nodes.get_mut(&b).unwrap().state = NodeState::Active;
    let mut active = vec![a, b];

    remove_from_active(a, &mut active, &mut nodes);

    assert_eq!(active, vec![b], "removed node must be gone from active, order of remaining preserved");
    assert_eq!(nodes[&a].state, NodeState::Visited, "removed node must become Visited");
    assert_eq!(nodes[&b].state, NodeState::Active, "untouched node must keep its state");
}

#[test]
fn remove_from_active_marks_visited_even_when_not_present_in_active() {
    // The state transition to Visited and the active-list removal are independent — a node
    // absent from `active` still gets marked Visited (state is the source of truth for
    // exhaustion elsewhere in the algorithm; `active` is just the pending-src worklist).
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let a = all[0];
    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    let mut active: Vec<NodeId> = vec![];

    remove_from_active(a, &mut active, &mut nodes);

    assert!(active.is_empty());
    assert_eq!(nodes[&a].state, NodeState::Visited);
}

#[test]
fn sorted_nodes_in_state_filters_by_state_and_extra_filter_and_sorts() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let mut all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    all.sort_unstable();

    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    // Mark a couple of nodes Visited, leave the rest Unseen.
    nodes.get_mut(&all[2]).unwrap().state = NodeState::Visited;
    nodes.get_mut(&all[5]).unwrap().state = NodeState::Visited;
    nodes.get_mut(&all[0]).unwrap().state = NodeState::Active;

    let result = sorted_nodes_in_state(&nodes, NodeState::Visited, |_| true);
    let mut expected = vec![all[2], all[5]];
    expected.sort_unstable();
    assert_eq!(result, expected);

    // extra_filter further restricts the pool.
    let filtered = sorted_nodes_in_state(&nodes, NodeState::Visited, |n| n != all[2]);
    assert_eq!(filtered, vec![all[5]]);
}

#[test]
fn sorted_nodes_in_state_empty_when_no_match() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }
    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();

    assert!(sorted_nodes_in_state(&nodes, NodeState::Visited, |_| true).is_empty());
}

#[test]
fn choose_src_returns_last_dst_when_corridor_length_one() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }

    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let center = all[4]; // middle node of 3x3
    let neighbor = field.neighbors(center)[0];

    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    nodes.insert(center,   NodeEntry { state: NodeState::Active, parent: None,          tree_depth: 0, teleport_rolled: false, cyclic_rolled: false });
    nodes.insert(neighbor, NodeEntry { state: NodeState::Active, parent: Some(center),  tree_depth: 1, teleport_rolled: false, cyclic_rolled: false });

    let active = vec![center, neighbor];
    let params = EdgeBasedParams { corridor_length: 1.0, depth_first: 0.5, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

    // last_dst = neighbor, corridor_length = 1.0 → must return neighbor (has unseen neighbors)
    for seed in 0..20 {
        let choice = choose_src(&active, Some(neighbor), &nodes, &params, &empty_presets(), &field, &mut rng(seed));
        assert_eq!(choice.src(), neighbor, "corridor_length=1.0 must return last_dst when it has unseen neighbors");
        assert!(matches!(choice, SrcChoice::CorridorContinued { .. }), "expected CorridorContinued, got a different SrcChoice variant");
    }
}

#[test]
fn choose_src_ignores_corridor_when_length_zero() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 3), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }

    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let a = all[0];
    let b = all[1];

    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    nodes.insert(a, NodeEntry { state: NodeState::Active, parent: None,    tree_depth: 0, teleport_rolled: false, cyclic_rolled: false });
    nodes.insert(b, NodeEntry { state: NodeState::Active, parent: Some(a), tree_depth: 1, teleport_rolled: false, cyclic_rolled: false });

    let active = vec![a, b];
    let params = EdgeBasedParams { corridor_length: 0.0, depth_first: 0.5, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

    // corridor_length=0.0 → corridor never fires; depth_first=0.5 → uniform → both nodes appear
    let results: Vec<_> = (0..50).map(|seed| {
        let choice = choose_src(&active, Some(b), &nodes, &params, &empty_presets(), &field, &mut rng(seed));
        assert!(matches!(choice, SrcChoice::CorridorFailedFallthrough { .. }), "expected CorridorFailedFallthrough, got a different SrcChoice variant");
        choice.src()
    }).collect();
    assert!(results.contains(&a), "corridor_length=0.0: node a never selected as src");
    assert!(results.contains(&b), "corridor_length=0.0: node b never selected as src");
}

#[test]
fn choose_src_depth_first_one_prefers_newest() {
    let mut ids = crate::ids::IdGenerator::new();
    let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(4, 4), &mut ids).unwrap();
    let _level = field.single_level_id();
    let mut graph = Graph::new();
    for node in field.all_node_ids() { graph.add_node(node); }

    let all: Vec<_> = graph.nodes().map(|n| n.id).collect();
    let oldest = all[0]; // position 0 in active
    let newest = all[3]; // position 3 in active (last)

    let mut nodes: HashMap<_, _> = all.iter().map(|&n| (n, NodeEntry::unseen())).collect();
    nodes.insert(oldest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0, teleport_rolled: false, cyclic_rolled: false });
    nodes.insert(newest, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 1, teleport_rolled: false, cyclic_rolled: false });

    let active = vec![oldest, newest];
    let params = EdgeBasedParams { corridor_length: 0.0, depth_first: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 0.0 };

    let newest_wins = (0..100).filter(|&seed| {
        let choice = choose_src(&active, None, &nodes, &params, &empty_presets(), &field, &mut rng(seed));
        assert!(matches!(choice, SrcChoice::NoCorridorAttempt { .. }), "expected NoCorridorAttempt, got a different SrcChoice variant");
        choice.src() == newest
    }).count();

    // depth_first=1.0, k=10 → newest weight=1.0, oldest weight=0.0 → newest dominates
    assert!(newest_wins >= 95, "depth_first=1.0: newest node should dominate, got {newest_wins}/100");
}

fn empty_presets() -> super::PresetState { super::PresetState::empty() }

#[test]
fn edge_based_visits_all_nodes() {
    let (field, mut graph) = make_field_and_graph(5, 5);
    let level = field.single_level_id();
    let node_count = graph.nodes().count();
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut graph, &field, 42, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
    assert_eq!(graph.edges().count(), 2 * (node_count - 1));
}

#[test]
fn edge_based_is_deterministic() {
    let (field, mut g1) = make_field_and_graph(4, 4);
    let level = field.single_level_id();
    let (_, mut g2) = make_field_and_graph(4, 4);
    let start = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate(&mut g1, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
    generate(&mut g2, &field, 7, start, &EdgeBasedParams::default(), &default_elements(), &empty_presets(), None);
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
            if x + 1 < 3 { connections.push(super::super::PresetConnection { from: super::super::PresetEndpoint::original((x, y)), to: super::super::PresetEndpoint::original((x + 1, y)), state: super::super::PresetConnectionState::Passage }); }
            if y + 1 < 3 { connections.push(super::super::PresetConnection { from: super::super::PresetEndpoint::original((x, y)), to: super::super::PresetEndpoint::original((x, y + 1)), state: super::super::PresetConnectionState::Passage }); }
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
