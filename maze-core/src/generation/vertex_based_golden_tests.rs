use super::tests::{default_params, empty_presets, generate_default_split};
use super::*;
use crate::generation::test_utils::{default_elements, make_field_graph_ids};

// ─── golden snapshots ────────────────────────────────────────────────────
// Pins the exact edge set `generate()` produces for a fixed seed/config, on top of the
// self-consistency determinism checks in `vertex_based_tests.rs` (which only prove "same seed
// twice -> same output", not "output didn't silently change"). Guards the RNG-sample-consumption
// order contract documented on `generate`/`add_edge_kind`/`try_add_edge_kind` across refactors
// that don't trip any structural invariant (connectivity, no-self-loop, etc.) — two RNG calls
// swapped in a way that's still individually valid would pass every other test here but change
// the maze a saved seed produces. Regenerate deliberately (not silently) if `generate`'s actual
// RNG-consumption order is meant to change. Last regenerated for GitHub issue #758: square
// `faces_of` became the canonical circular order `[E, N, W, S]`, which changes neighbor iteration
// order (connectivity and the other structural invariants are unaffected).

fn full_two_way_teleport_elements() -> ElementsConfig {
    ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 1.0,
        teleport_one_way_chance: 0.0,
        split_chance: 0.0,
        ..Default::default()
    }
}

fn full_one_way_teleport_elements() -> ElementsConfig {
    ElementsConfig {
        one_way_chance: 0.0,
        teleport_chance: 1.0,
        teleport_one_way_chance: 1.0,
        split_chance: 0.0,
        ..Default::default()
    }
}

fn snapshot(graph: &Graph) -> Vec<(NodeId, NodeId, &'static str)> {
    let mut edges: Vec<(NodeId, NodeId, &'static str)> = graph
        .edges()
        .map(|e| {
            (
                e.from,
                e.to,
                if e.kind == EdgeKind::Teleport {
                    "T"
                } else {
                    "B"
                },
            )
        })
        .collect();
    edges.sort();
    edges
}

#[test]
fn golden_baseline_params_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        &default_params(),
        &default_elements(),
        &empty_presets(),
        None,
    );
    // Regenerated for GitHub issue #222: the split roll is always consumed regardless of
    // split_chance (RNG-parity discipline, see vertex_based.rs's `try_split_src` doc comment) —
    // every existing seed's output changes the moment this feature ships, even at split_chance ==
    // 0.0 (default_elements()). Documented, one-time breaking change, not a regression.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 1, "B"),
            (0, 6, "B"),
            (1, 0, "B"),
            (1, 2, "B"),
            (2, 1, "B"),
            (2, 8, "B"),
            (3, 9, "B"),
            (4, 5, "B"),
            (5, 4, "B"),
            (5, 11, "B"),
            (6, 0, "B"),
            (7, 13, "B"),
            (8, 2, "B"),
            (8, 9, "B"),
            (9, 3, "B"),
            (9, 8, "B"),
            (9, 10, "B"),
            (9, 15, "B"),
            (10, 9, "B"),
            (10, 16, "B"),
            (11, 5, "B"),
            (11, 17, "B"),
            (12, 13, "B"),
            (12, 18, "B"),
            (13, 7, "B"),
            (13, 12, "B"),
            (13, 19, "B"),
            (14, 15, "B"),
            (15, 9, "B"),
            (15, 14, "B"),
            (15, 21, "B"),
            (16, 10, "B"),
            (16, 17, "B"),
            (17, 11, "B"),
            (17, 16, "B"),
            (18, 12, "B"),
            (18, 24, "B"),
            (19, 13, "B"),
            (19, 20, "B"),
            (20, 19, "B"),
            (21, 15, "B"),
            (21, 22, "B"),
            (22, 21, "B"),
            (22, 23, "B"),
            (22, 28, "B"),
            (23, 22, "B"),
            (23, 29, "B"),
            (24, 18, "B"),
            (24, 25, "B"),
            (24, 30, "B"),
            (25, 24, "B"),
            (25, 26, "B"),
            (26, 25, "B"),
            (26, 27, "B"),
            (27, 26, "B"),
            (27, 33, "B"),
            (28, 22, "B"),
            (29, 23, "B"),
            (29, 35, "B"),
            (30, 24, "B"),
            (30, 31, "B"),
            (31, 30, "B"),
            (31, 32, "B"),
            (32, 31, "B"),
            (33, 27, "B"),
            (33, 34, "B"),
            (34, 33, "B"),
            (34, 35, "B"),
            (35, 29, "B"),
            (35, 34, "B"),
        ]
    );
}

#[test]
fn golden_full_two_way_teleport_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        &default_params(),
        &full_two_way_teleport_elements(),
        &empty_presets(),
        None,
    );
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 6, "B"),
            (0, 22, "T"),
            (1, 7, "B"),
            (1, 12, "T"),
            (1, 35, "T"),
            (2, 3, "B"),
            (2, 22, "T"),
            (2, 34, "T"),
            (3, 2, "B"),
            (4, 5, "B"),
            (4, 10, "B"),
            (4, 27, "T"),
            (5, 4, "B"),
            (5, 11, "B"),
            (5, 31, "T"),
            (6, 0, "B"),
            (7, 1, "B"),
            (7, 13, "B"),
            (7, 17, "T"),
            (8, 14, "B"),
            (9, 10, "B"),
            (9, 16, "T"),
            (9, 19, "T"),
            (10, 4, "B"),
            (10, 9, "B"),
            (10, 18, "T"),
            (11, 5, "B"),
            (12, 1, "T"),
            (13, 7, "B"),
            (13, 19, "B"),
            (13, 26, "T"),
            (14, 8, "B"),
            (14, 15, "B"),
            (14, 20, "B"),
            (14, 35, "T"),
            (15, 14, "B"),
            (15, 23, "T"),
            (15, 34, "T"),
            (16, 9, "T"),
            (17, 7, "T"),
            (18, 10, "T"),
            (18, 33, "T"),
            (19, 9, "T"),
            (19, 13, "B"),
            (19, 25, "B"),
            (20, 14, "B"),
            (21, 22, "B"),
            (22, 0, "T"),
            (22, 2, "T"),
            (22, 21, "B"),
            (23, 15, "T"),
            (24, 26, "T"),
            (25, 19, "B"),
            (26, 13, "T"),
            (26, 24, "T"),
            (26, 32, "B"),
            (27, 4, "T"),
            (28, 34, "B"),
            (29, 35, "B"),
            (30, 33, "T"),
            (31, 5, "T"),
            (32, 26, "B"),
            (33, 18, "T"),
            (33, 30, "T"),
            (34, 2, "T"),
            (34, 15, "T"),
            (34, 28, "B"),
            (35, 1, "T"),
            (35, 14, "T"),
            (35, 29, "B"),
        ]
    );
}

#[test]
fn golden_full_one_way_teleport_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        &default_params(),
        &full_one_way_teleport_elements(),
        &empty_presets(),
        None,
    );
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 6, "B"),
            (0, 22, "T"),
            (1, 2, "B"),
            (1, 7, "B"),
            (1, 35, "T"),
            (2, 1, "B"),
            (4, 10, "B"),
            (5, 29, "T"),
            (6, 0, "B"),
            (7, 1, "B"),
            (8, 2, "T"),
            (9, 25, "T"),
            (10, 4, "B"),
            (10, 21, "T"),
            (12, 13, "B"),
            (12, 31, "T"),
            (13, 12, "B"),
            (13, 29, "T"),
            (14, 20, "B"),
            (15, 34, "T"),
            (16, 12, "T"),
            (17, 5, "T"),
            (18, 19, "B"),
            (19, 11, "T"),
            (19, 18, "B"),
            (19, 25, "B"),
            (20, 14, "B"),
            (20, 22, "T"),
            (20, 32, "T"),
            (21, 27, "B"),
            (22, 23, "B"),
            (23, 22, "B"),
            (24, 28, "T"),
            (25, 19, "B"),
            (25, 31, "B"),
            (26, 32, "B"),
            (27, 21, "B"),
            (27, 28, "B"),
            (27, 30, "T"),
            (28, 27, "B"),
            (28, 34, "B"),
            (31, 10, "T"),
            (31, 25, "B"),
            (32, 2, "T"),
            (32, 26, "B"),
            (32, 33, "B"),
            (33, 32, "B"),
            (34, 28, "B"),
            (34, 35, "B"),
            (35, 3, "T"),
            (35, 34, "B"),
        ]
    );
}

#[test]
fn golden_high_cyclicity_seed_21() {
    let params = GenerationParams {
        depth_first: 0.0,
        corridor_chance: 1.0,
        branching: 0.0,
        directionality: 0.0,
        cyclicity: 1.0,
    };
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        21,
        start,
        &params,
        &full_two_way_teleport_elements(),
        &empty_presets(),
        None,
    );
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 3, "T"),
            (0, 8, "B"),
            (0, 25, "T"),
            (0, 38, "T"),
            (1, 2, "B"),
            (1, 9, "B"),
            (1, 18, "T"),
            (1, 25, "T"),
            (2, 1, "B"),
            (2, 3, "B"),
            (2, 32, "T"),
            (2, 61, "T"),
            (2, 62, "T"),
            (3, 0, "T"),
            (3, 2, "B"),
            (3, 11, "B"),
            (3, 41, "T"),
            (4, 5, "B"),
            (4, 12, "B"),
            (4, 20, "T"),
            (4, 63, "T"),
            (5, 4, "B"),
            (5, 6, "B"),
            (5, 48, "T"),
            (6, 5, "B"),
            (6, 14, "B"),
            (6, 51, "T"),
            (7, 15, "B"),
            (7, 37, "T"),
            (7, 39, "T"),
            (8, 0, "B"),
            (8, 9, "B"),
            (8, 24, "T"),
            (8, 25, "T"),
            (8, 32, "T"),
            (9, 1, "B"),
            (9, 8, "B"),
            (9, 20, "T"),
            (9, 24, "T"),
            (9, 25, "T"),
            (9, 49, "T"),
            (9, 54, "T"),
            (10, 11, "B"),
            (10, 18, "B"),
            (10, 37, "T"),
            (10, 40, "T"),
            (10, 44, "T"),
            (11, 3, "B"),
            (11, 10, "B"),
            (11, 16, "T"),
            (11, 41, "T"),
            (12, 4, "B"),
            (12, 13, "B"),
            (12, 24, "T"),
            (13, 12, "B"),
            (13, 18, "T"),
            (13, 21, "B"),
            (14, 6, "B"),
            (14, 22, "B"),
            (14, 36, "T"),
            (14, 45, "T"),
            (15, 7, "B"),
            (15, 23, "B"),
            (15, 43, "T"),
            (16, 11, "T"),
            (16, 17, "B"),
            (16, 34, "T"),
            (16, 38, "T"),
            (16, 46, "T"),
            (17, 16, "B"),
            (17, 18, "B"),
            (17, 56, "T"),
            (18, 1, "T"),
            (18, 10, "B"),
            (18, 13, "T"),
            (18, 17, "B"),
            (18, 29, "T"),
            (18, 47, "T"),
            (18, 59, "T"),
            (19, 22, "T"),
            (19, 27, "B"),
            (19, 57, "T"),
            (20, 4, "T"),
            (20, 9, "T"),
            (20, 21, "B"),
            (20, 28, "B"),
            (21, 13, "B"),
            (21, 20, "B"),
            (21, 51, "T"),
            (22, 14, "B"),
            (22, 19, "T"),
            (22, 23, "B"),
            (22, 44, "T"),
            (23, 15, "B"),
            (23, 22, "B"),
            (23, 40, "T"),
            (24, 8, "T"),
            (24, 9, "T"),
            (24, 12, "T"),
            (24, 25, "B"),
            (24, 32, "B"),
            (24, 56, "T"),
            (25, 0, "T"),
            (25, 1, "T"),
            (25, 8, "T"),
            (25, 9, "T"),
            (25, 24, "B"),
            (25, 40, "T"),
            (26, 29, "T"),
            (26, 48, "T"),
            (27, 19, "B"),
            (27, 35, "B"),
            (27, 63, "T"),
            (28, 20, "B"),
            (28, 29, "B"),
            (28, 35, "T"),
            (28, 45, "T"),
            (29, 18, "T"),
            (29, 26, "T"),
            (29, 28, "B"),
            (29, 37, "B"),
            (30, 31, "B"),
            (30, 38, "B"),
            (30, 60, "T"),
            (31, 30, "B"),
            (31, 33, "T"),
            (31, 39, "B"),
            (32, 2, "T"),
            (32, 8, "T"),
            (32, 24, "B"),
            (32, 33, "T"),
            (32, 40, "B"),
            (32, 42, "T"),
            (32, 43, "T"),
            (33, 31, "T"),
            (33, 32, "T"),
            (33, 34, "B"),
            (34, 16, "T"),
            (34, 33, "B"),
            (34, 42, "B"),
            (35, 27, "B"),
            (35, 28, "T"),
            (35, 36, "B"),
            (36, 14, "T"),
            (36, 35, "B"),
            (37, 7, "T"),
            (37, 10, "T"),
            (37, 29, "B"),
            (37, 45, "B"),
            (38, 0, "T"),
            (38, 16, "T"),
            (38, 30, "B"),
            (39, 7, "T"),
            (39, 31, "B"),
            (39, 47, "B"),
            (40, 10, "T"),
            (40, 23, "T"),
            (40, 25, "T"),
            (40, 32, "B"),
            (40, 41, "B"),
            (40, 58, "T"),
            (40, 60, "T"),
            (41, 3, "T"),
            (41, 11, "T"),
            (41, 40, "B"),
            (41, 48, "T"),
            (41, 49, "B"),
            (42, 32, "T"),
            (42, 34, "B"),
            (42, 50, "B"),
            (43, 15, "T"),
            (43, 32, "T"),
            (43, 44, "B"),
            (43, 45, "T"),
            (43, 51, "B"),
            (44, 10, "T"),
            (44, 22, "T"),
            (44, 43, "B"),
            (44, 45, "T"),
            (44, 52, "B"),
            (45, 14, "T"),
            (45, 28, "T"),
            (45, 37, "B"),
            (45, 43, "T"),
            (45, 44, "T"),
            (46, 16, "T"),
            (46, 54, "B"),
            (47, 18, "T"),
            (47, 39, "B"),
            (47, 55, "B"),
            (48, 5, "T"),
            (48, 26, "T"),
            (48, 41, "T"),
            (48, 49, "B"),
            (48, 52, "T"),
            (48, 56, "B"),
            (48, 57, "T"),
            (49, 9, "T"),
            (49, 41, "B"),
            (49, 48, "B"),
            (50, 42, "B"),
            (50, 51, "B"),
            (50, 59, "T"),
            (51, 6, "T"),
            (51, 21, "T"),
            (51, 43, "B"),
            (51, 50, "B"),
            (51, 57, "T"),
            (52, 44, "B"),
            (52, 48, "T"),
            (52, 53, "B"),
            (53, 52, "B"),
            (53, 56, "T"),
            (53, 61, "B"),
            (54, 9, "T"),
            (54, 46, "B"),
            (54, 62, "B"),
            (55, 47, "B"),
            (55, 61, "T"),
            (55, 63, "B"),
            (56, 17, "T"),
            (56, 24, "T"),
            (56, 48, "B"),
            (56, 53, "T"),
            (56, 57, "B"),
            (57, 19, "T"),
            (57, 48, "T"),
            (57, 51, "T"),
            (57, 56, "B"),
            (57, 58, "B"),
            (58, 40, "T"),
            (58, 57, "B"),
            (58, 59, "B"),
            (59, 18, "T"),
            (59, 50, "T"),
            (59, 58, "B"),
            (59, 60, "B"),
            (60, 30, "T"),
            (60, 40, "T"),
            (60, 59, "B"),
            (60, 61, "B"),
            (61, 2, "T"),
            (61, 53, "B"),
            (61, 55, "T"),
            (61, 60, "B"),
            (62, 2, "T"),
            (62, 54, "B"),
            (62, 63, "B"),
            (63, 4, "T"),
            (63, 27, "T"),
            (63, 55, "B"),
            (63, 62, "B"),
        ]
    );
}

#[test]
fn golden_all_one_way_seed_7() {
    let elements = ElementsConfig {
        one_way_chance: 1.0,
        teleport_chance: 0.0,
        teleport_one_way_chance: 0.0,
        split_chance: 0.0,
        ..Default::default()
    };
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        7,
        start,
        &default_params(),
        &elements,
        &empty_presets(),
        None,
    );
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 6, "B"),
            (2, 1, "B"),
            (4, 3, "B"),
            (4, 5, "B"),
            (7, 1, "B"),
            (8, 7, "B"),
            (8, 14, "B"),
            (9, 3, "B"),
            (9, 10, "B"),
            (11, 10, "B"),
            (11, 17, "B"),
            (12, 6, "B"),
            (12, 18, "B"),
            (14, 13, "B"),
            (15, 14, "B"),
            (15, 16, "B"),
            (16, 22, "B"),
            (17, 23, "B"),
            (18, 19, "B"),
            (19, 20, "B"),
            (21, 20, "B"),
            (21, 22, "B"),
            (23, 22, "B"),
            (24, 30, "B"),
            (25, 31, "B"),
            (26, 25, "B"),
            (26, 27, "B"),
            (28, 22, "B"),
            (29, 28, "B"),
            (31, 30, "B"),
            (32, 31, "B"),
            (33, 32, "B"),
            (34, 33, "B"),
            (34, 35, "B"),
            (35, 29, "B"),
        ]
    );
}

#[test]
fn golden_with_preset_locks_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let field_level = field.single_level_id();
    let start = field
        .node_at(field_level, crate::space::SquarePoint { x: 0, y: 0 })
        .unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(
        field
            .node_at(field_level, crate::space::SquarePoint { x: 2, y: 2 })
            .unwrap(),
    );
    preset_state.locked_in.insert(
        field
            .node_at(field_level, crate::space::SquarePoint { x: 4, y: 4 })
            .unwrap(),
    );
    generate_default_split(
        &mut graph,
        &mut field,
        &mut ids,
        42,
        start,
        &default_params(),
        &full_two_way_teleport_elements(),
        &preset_state,
        None,
    );
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(
        snapshot(&graph),
        vec![
            (0, 5, "B"),
            (0, 15, "T"),
            (1, 9, "T"),
            (1, 16, "T"),
            (2, 3, "B"),
            (2, 15, "T"),
            (3, 2, "B"),
            (4, 8, "T"),
            (5, 0, "B"),
            (7, 8, "B"),
            (7, 11, "T"),
            (7, 23, "T"),
            (8, 4, "T"),
            (8, 7, "B"),
            (8, 9, "B"),
            (9, 1, "T"),
            (9, 8, "B"),
            (9, 14, "B"),
            (10, 14, "T"),
            (11, 7, "T"),
            (13, 18, "B"),
            (14, 9, "B"),
            (14, 10, "T"),
            (15, 0, "T"),
            (15, 2, "T"),
            (15, 20, "B"),
            (16, 1, "T"),
            (16, 17, "T"),
            (16, 21, "B"),
            (17, 16, "T"),
            (18, 12, "T"),
            (18, 13, "B"),
            (18, 23, "B"),
            (20, 15, "B"),
            (21, 16, "B"),
            (22, 23, "B"),
            (23, 7, "T"),
            (23, 18, "B"),
            (23, 22, "B"),
            (24, 6, "T"),
            (24, 19, "B"),
            (24, 23, "B"),
        ]
    );
}
