use super::*;
use super::test_utils::*;
use crate::space::SquarePoint;
use rand::SeedableRng;

fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }

fn node_at(field: &Field<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    field.node_at(SquarePoint { x, y }).unwrap()
}

#[test]
fn elements_config_default_one_way_chance() {
    assert_eq!(ElementsConfig::default().one_way_chance, 0.04);
}

// ─── can_connect ─────────────────────────────────────────────────────────

#[test]
fn can_connect_true_when_no_constraints() {
    let (field, graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let preset_state = PresetState::empty();
    assert!(can_connect(a, b, &preset_state));
    let _ = graph;
}

#[test]
fn can_connect_false_when_both_locked_out() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    preset_state.locked_out.insert(b);
    assert!(!can_connect(a, b, &preset_state));
}

#[test]
fn can_connect_false_when_both_locked_in() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(a);
    preset_state.locked_in.insert(b);
    assert!(!can_connect(a, b, &preset_state));
}

#[test]
fn can_connect_false_when_both_directions_blocked() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    assert!(!can_connect(a, b, &preset_state));
}

#[test]
fn can_connect_true_when_only_one_direction_blocked() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    // a->b blocked but b->a still open, so the pair can connect (one_way).
    assert!(can_connect(a, b, &preset_state));
}

#[test]
fn can_connect_true_when_src_locked_out_and_dst_locked_in_but_not_both_ways() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    preset_state.locked_in.insert(b);
    // fwd a->b is blocked (a locked_out), but bwd b->a is still open
    // (b isn't locked_out and a isn't locked_in), so one direction remains possible.
    assert!(can_connect(a, b, &preset_state));
}

#[test]
fn can_connect_false_when_locked_out_and_locked_in_overlap_both_ways() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    preset_state.locked_in.insert(a);
    preset_state.locked_out.insert(b);
    preset_state.locked_in.insert(b);
    assert!(!can_connect(a, b, &preset_state));
}

// ─── try_add_edge ────────────────────────────────────────────────────────

#[test]
fn try_add_edge_noop_when_src_locked_out() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    let elements = default_elements();
    try_add_edge(&mut graph, a, b, &elements, &preset_state, &mut rng(1));
    assert!(graph.edge_between(a, b).is_none());
    assert!(graph.edge_between(b, a).is_none());
}

#[test]
fn try_add_edge_noop_when_dst_locked_in() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(b);
    let elements = default_elements();
    try_add_edge(&mut graph, a, b, &elements, &preset_state, &mut rng(1));
    assert!(graph.edge_between(a, b).is_none());
    assert!(graph.edge_between(b, a).is_none());
}

#[test]
fn try_add_edge_noop_when_forward_blocked() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    let elements = default_elements();
    try_add_edge(&mut graph, a, b, &elements, &preset_state, &mut rng(1));
    assert!(graph.edge_between(a, b).is_none());
}

#[test]
fn try_add_edge_forces_forward_only_when_reverse_blocked() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((b, a));
    let elements = default_elements();
    try_add_edge(&mut graph, a, b, &elements, &preset_state, &mut rng(1));
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_none());
}

#[test]
fn try_add_edge_rng_parity_matches_add_edge_when_unconstrained() {
    // try_add_edge's reverse_blocked branch consumes the same two RNG samples
    // (f64 + bool) as add_edge's one_way branch, so seed parity must hold across
    // both paths. one_way_chance=1.0 forces add_edge to also draw both samples.
    let (field, mut graph_a) = make_field_and_graph(3, 3);
    let (_, mut graph_b) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let elements = ElementsConfig { one_way_chance: 1.0 };

    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((b, a)); // force reverse_blocked branch
    let mut r1 = rng(7);
    try_add_edge(&mut graph_a, a, b, &elements, &preset_state, &mut r1);

    let mut r2 = rng(7);
    add_edge(&mut graph_b, a, b, &elements, &mut r2);

    // Same seed must advance the RNG identically: next draw should match.
    assert_eq!(r1.random::<f64>(), r2.random::<f64>());
}

#[test]
fn try_add_edge_normal_path_delegates_to_add_edge() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let preset_state = PresetState::empty();
    let elements = default_elements(); // one_way_chance == 0.0 => always bidirectional
    try_add_edge(&mut graph, a, b, &elements, &preset_state, &mut rng(1));
    assert!(graph.edge_between(a, b).is_some());
    assert!(graph.edge_between(b, a).is_some());
}

