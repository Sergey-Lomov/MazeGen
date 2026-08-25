use super::*;
use super::test_utils::*;
use crate::space::SquarePoint;
use rand::SeedableRng;

fn rng(seed: u64) -> MazeRng { MazeRng::seed_from_u64(seed) }

fn node_at(field: &MultiLevelField<crate::space::SquareTessellation>, x: i32, y: i32) -> NodeId {
    let level = field.single_level_id();
    field.node_at(level, SquarePoint { x, y }).unwrap()
}

#[test]
fn elements_config_default_one_way_chance() {
    assert_eq!(ElementsConfig::default().one_way_chance, 0.0);
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

// ─── bidirectional_edge_feasible ────────────────────────────────────────

#[test]
fn bidirectional_edge_feasible_true_when_no_constraints() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let preset_state = PresetState::empty();
    assert!(bidirectional_edge_feasible(&preset_state, a, b));
}

#[test]
fn bidirectional_edge_feasible_false_when_only_one_direction_blocked() {
    // Unlike `can_connect` (either direction free suffices for a one-way pick),
    // `bidirectional_edge_feasible` requires *both* directions free — a single blocked
    // direction must already fail it, since a bidirectional add needs both.
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    assert!(!bidirectional_edge_feasible(&preset_state, a, b));
}

#[test]
fn bidirectional_edge_feasible_false_when_both_directions_blocked() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((a, b));
    preset_state.blocked.insert((b, a));
    assert!(!bidirectional_edge_feasible(&preset_state, a, b));
}

#[test]
fn bidirectional_edge_feasible_false_when_src_locked_out() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    assert!(!bidirectional_edge_feasible(&preset_state, a, b));
}

#[test]
fn bidirectional_edge_feasible_false_when_dst_locked_in() {
    let (field, _graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_in.insert(b);
    assert!(!bidirectional_edge_feasible(&preset_state, a, b));
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
    let elements = ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() };

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

// ─── try_add_edge_kind / add_edge_kind ─────────────────────────────────────

#[test]
fn add_edge_kind_zero_chance_always_bidirectional_with_given_kind() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    add_edge_kind(&mut graph, a, b, EdgeKind::Teleport, 0.0, &mut rng(1));
    assert!(graph.edges().any(|e| e.from == a && e.to == b && e.kind == EdgeKind::Teleport));
    assert!(graph.edges().any(|e| e.from == b && e.to == a && e.kind == EdgeKind::Teleport));
}

#[test]
fn add_edge_kind_one_chance_always_one_way_with_given_kind() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    add_edge_kind(&mut graph, a, b, EdgeKind::Teleport, 1.0, &mut rng(1));
    let ab = graph.edges().any(|e| e.from == a && e.to == b && e.kind == EdgeKind::Teleport);
    let ba = graph.edges().any(|e| e.from == b && e.to == a && e.kind == EdgeKind::Teleport);
    assert!(ab ^ ba, "one_way_chance=1.0 must produce exactly one direction, got ab={ab} ba={ba}");
}

#[test]
fn try_add_edge_kind_respects_preset_state_for_teleport_kind() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(a);
    try_add_edge_kind(&mut graph, a, b, EdgeKind::Teleport, 0.0, &preset_state, &mut rng(1));
    assert!(graph.edges().count() == 0, "locked_out source must block a Teleport edge exactly like a Basic one");
}

#[test]
fn try_add_edge_kind_forces_forward_only_when_reverse_blocked_for_teleport_kind() {
    let (field, mut graph) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let mut preset_state = PresetState::empty();
    preset_state.blocked.insert((b, a));
    try_add_edge_kind(&mut graph, a, b, EdgeKind::Teleport, 0.0, &preset_state, &mut rng(1));
    assert!(graph.edges().any(|e| e.from == a && e.to == b && e.kind == EdgeKind::Teleport));
    assert!(!graph.edges().any(|e| e.from == b && e.to == a));
}

#[test]
fn try_add_edge_delegates_to_try_add_edge_kind_with_basic_and_one_way_chance() {
    // try_add_edge must behave identically to try_add_edge_kind(..., EdgeKind::Basic,
    // elements.one_way_chance, ...) — same seed must produce the same result via both paths.
    let (field, mut graph_a) = make_field_and_graph(3, 3);
    let (_, mut graph_b) = make_field_and_graph(3, 3);
    let a = node_at(&field, 0, 0);
    let b = node_at(&field, 1, 0);
    let elements = ElementsConfig { one_way_chance: 0.5, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0, ..Default::default() };
    let preset_state = PresetState::empty();

    try_add_edge(&mut graph_a, a, b, &elements, &preset_state, &mut rng(3));
    try_add_edge_kind(&mut graph_b, a, b, EdgeKind::Basic, elements.one_way_chance, &preset_state, &mut rng(3));

    let mut ea: Vec<_> = graph_a.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    let mut eb: Vec<_> = graph_b.edges().map(|e| (e.from, e.to, e.kind.clone())).collect();
    ea.sort_by_key(|(f, t, _)| (*f, *t));
    eb.sort_by_key(|(f, t, _)| (*f, *t));
    assert_eq!(ea, eb);
}

// ─── qualify_debug_value_names (GitHub issue #169) ─────────────────────────

use crate::event_log::DebugValueKind;

#[test]
fn qualify_debug_value_names_leaves_a_single_source_unqualified() {
    // The only case exercised via generate_maze_with_events today (always exactly one source) —
    // names must pass through verbatim, matching every existing test/UI expectation.
    let sources = [("generation", vec![("visited", DebugValueKind::Region), ("recursion_stack", DebugValueKind::Sequence)])];
    let result = qualify_debug_value_names(&sources);
    assert_eq!(
        result,
        vec![("visited".to_string(), DebugValueKind::Region), ("recursion_stack".to_string(), DebugValueKind::Sequence)]
    );
}

#[test]
fn qualify_debug_value_names_leaves_a_single_empty_source_unqualified() {
    let sources = [("generation", vec![])];
    let result = qualify_debug_value_names(&sources);
    assert!(result.is_empty());
}

#[test]
fn qualify_debug_value_names_qualifies_every_name_with_its_scope_when_two_sources_present() {
    // Not reachable from generate_maze_with_events yet (always one source today) — this is the
    // path future #147 (a second, QC source) will exercise. "visited" is deliberately reused by
    // both sources here, mirroring the real collision RB/Wilson/CustomVertexBased
    // already have independently (see Specs/event_log.md) — qualification must disambiguate it.
    let sources = [
        ("generation", vec![("visited", DebugValueKind::Region), ("recursion_stack", DebugValueKind::Sequence)]),
        ("quality_control", vec![("visited", DebugValueKind::Region)]),
    ];
    let result = qualify_debug_value_names(&sources);
    assert_eq!(
        result,
        vec![
            ("generation:visited".to_string(), DebugValueKind::Region),
            ("generation:recursion_stack".to_string(), DebugValueKind::Sequence),
            ("quality_control:visited".to_string(), DebugValueKind::Region),
        ]
    );
}

#[test]
fn qualify_debug_value_names_with_two_sources_where_one_declares_nothing() {
    let sources = [
        ("generation", vec![("visited", DebugValueKind::Region)]),
        ("quality_control", vec![]),
    ];
    let result = qualify_debug_value_names(&sources);
    assert_eq!(result, vec![("generation:visited".to_string(), DebugValueKind::Region)]);
}

