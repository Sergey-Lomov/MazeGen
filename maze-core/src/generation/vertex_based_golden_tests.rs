use super::*;
use super::tests::{default_params, generate_default_split, empty_presets};
use crate::generation::test_utils::{default_elements, make_field_graph_ids};

// ─── golden snapshots ────────────────────────────────────────────────────
// Pins the exact edge set `generate()` produces for a fixed seed/config, on top of the
// self-consistency determinism checks in `vertex_based_tests.rs` (which only prove "same seed
// twice -> same output", not "output didn't silently change"). Guards the RNG-sample-consumption
// order contract documented on `generate`/`add_edge_kind`/`try_add_edge_kind` across refactors
// that don't trip any structural invariant (connectivity, no-self-loop, etc.) — two RNG calls
// swapped in a way that's still individually valid would pass every other test here but change
// the maze a saved seed produces. Regenerate deliberately (not silently) if `generate`'s actual
// RNG-consumption order is meant to change.

fn full_two_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 0.0, split_chance: 0.0 }
}

fn full_one_way_teleport_elements() -> ElementsConfig {
    ElementsConfig { one_way_chance: 0.0, teleport_chance: 1.0, teleport_one_way_chance: 1.0, split_chance: 0.0 }
}

fn snapshot(graph: &Graph) -> Vec<(NodeId, NodeId, &'static str)> {
    let mut edges: Vec<(NodeId, NodeId, &'static str)> = graph.edges()
        .map(|e| (e.from, e.to, if e.kind == EdgeKind::Teleport { "T" } else { "B" }))
        .collect();
    edges.sort();
    edges
}

#[test]
fn golden_baseline_params_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &default_elements(), &empty_presets(), None);
    // Regenerated for GitHub issue #222: the split roll is always consumed regardless of
    // split_chance (RNG-parity discipline, see vertex_based.rs's `try_split_src` doc comment) —
    // every existing seed's output changes the moment this feature ships, even at split_chance ==
    // 0.0 (default_elements()). Documented, one-time breaking change, not a regression.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 6, "B"), (1, 0, "B"), (2, 3, "B"), (2, 8, "B"), (3, 2, "B"), (3, 4, "B"),
        (4, 3, "B"), (4, 5, "B"), (4, 10, "B"), (5, 4, "B"), (5, 11, "B"), (6, 0, "B"), (6, 12, "B"),
        (7, 8, "B"), (8, 2, "B"), (8, 7, "B"), (8, 9, "B"), (8, 14, "B"), (9, 8, "B"), (9, 15, "B"),
        (10, 4, "B"), (10, 16, "B"), (11, 5, "B"), (11, 17, "B"), (12, 6, "B"), (12, 13, "B"),
        (13, 12, "B"), (13, 19, "B"), (14, 8, "B"), (14, 20, "B"), (15, 9, "B"), (16, 10, "B"),
        (16, 22, "B"), (17, 11, "B"), (18, 19, "B"), (19, 13, "B"), (19, 18, "B"), (19, 20, "B"),
        (19, 25, "B"), (20, 14, "B"), (20, 19, "B"), (20, 21, "B"), (21, 20, "B"), (22, 16, "B"),
        (22, 23, "B"), (22, 28, "B"), (23, 22, "B"), (23, 29, "B"), (24, 30, "B"), (25, 19, "B"),
        (25, 26, "B"), (26, 25, "B"), (26, 32, "B"), (27, 33, "B"), (28, 22, "B"), (28, 34, "B"),
        (29, 23, "B"), (29, 35, "B"), (30, 24, "B"), (30, 31, "B"), (31, 30, "B"), (31, 32, "B"),
        (32, 26, "B"), (32, 31, "B"), (33, 27, "B"), (33, 34, "B"), (34, 28, "B"), (34, 33, "B"),
        (35, 29, "B"),
    ]);
}

#[test]
fn golden_full_two_way_teleport_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &empty_presets(), None);
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 22, "T"), (1, 0, "B"), (2, 30, "T"), (3, 9, "B"), (3, 22, "T"), (3, 34, "T"),
        (4, 10, "B"), (4, 31, "T"), (5, 11, "B"), (6, 12, "B"), (6, 18, "T"), (6, 28, "T"), (7, 20, "T"),
        (8, 26, "T"), (9, 3, "B"), (10, 4, "B"), (10, 11, "B"), (10, 14, "T"), (11, 5, "B"), (11, 10, "B"),
        (11, 13, "T"), (11, 17, "B"), (12, 6, "B"), (13, 11, "T"), (13, 19, "B"), (13, 35, "T"),
        (14, 10, "T"), (15, 16, "B"), (15, 21, "T"), (15, 34, "T"), (16, 15, "B"), (16, 17, "B"),
        (16, 25, "T"), (17, 11, "B"), (17, 16, "B"), (17, 24, "T"), (18, 6, "T"), (19, 13, "B"),
        (19, 20, "B"), (19, 26, "T"), (20, 7, "T"), (20, 19, "B"), (21, 15, "T"), (22, 0, "T"),
        (22, 3, "T"), (22, 23, "B"), (23, 22, "B"), (24, 17, "T"), (25, 16, "T"), (26, 8, "T"),
        (26, 19, "T"), (26, 27, "B"), (27, 26, "B"), (27, 28, "B"), (27, 30, "T"), (28, 6, "T"),
        (28, 27, "B"), (29, 35, "B"), (30, 2, "T"), (30, 27, "T"), (31, 4, "T"), (32, 35, "T"),
        (33, 34, "B"), (34, 3, "T"), (34, 15, "T"), (34, 33, "B"), (35, 13, "T"), (35, 29, "B"),
        (35, 32, "T"),
    ]);
}

#[test]
fn golden_full_one_way_teleport_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_one_way_teleport_elements(), &empty_presets(), None);
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 22, "T"), (1, 0, "B"), (2, 3, "B"), (2, 35, "T"), (3, 2, "B"), (5, 34, "T"),
        (6, 12, "B"), (7, 8, "B"), (7, 13, "B"), (8, 3, "T"), (8, 7, "B"), (9, 8, "T"), (10, 16, "B"),
        (10, 17, "T"), (12, 6, "B"), (12, 13, "B"), (12, 18, "B"), (12, 24, "T"), (13, 7, "B"),
        (13, 12, "B"), (14, 18, "T"), (15, 7, "T"), (16, 10, "B"), (17, 23, "B"), (18, 12, "B"),
        (19, 20, "B"), (20, 19, "B"), (20, 22, "T"), (20, 32, "T"), (21, 17, "T"), (22, 28, "B"),
        (23, 17, "B"), (24, 30, "B"), (25, 13, "T"), (26, 32, "B"), (27, 33, "B"), (28, 22, "B"),
        (29, 4, "T"), (29, 16, "T"), (30, 10, "T"), (30, 24, "B"), (31, 32, "B"), (32, 3, "T"),
        (32, 26, "B"), (32, 31, "B"), (33, 11, "T"), (33, 27, "B"), (33, 34, "B"), (34, 24, "T"),
        (34, 33, "B"),
    ]);
}

#[test]
fn golden_high_cyclicity_seed_21() {
    let params = GenerationParams { depth_first: 0.0, corridor_chance: 1.0, branching: 0.0, directionality: 0.0, cyclicity: 1.0 };
    let (mut field, mut graph, mut ids) = make_field_graph_ids(8, 8);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 21, start, &params, &full_two_way_teleport_elements(), &empty_presets(), None);
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 12, "T"), (0, 25, "T"), (0, 34, "T"), (0, 43, "T"), (0, 60, "T"), (0, 61, "T"),
        (1, 0, "B"), (1, 9, "B"), (1, 22, "T"), (1, 25, "T"), (1, 33, "T"), (1, 35, "T"), (1, 57, "T"),
        (2, 3, "B"), (2, 4, "T"), (2, 10, "B"), (2, 15, "T"), (2, 17, "T"), (3, 2, "B"), (3, 4, "B"),
        (3, 10, "T"), (4, 2, "T"), (4, 3, "B"), (4, 5, "B"), (5, 4, "B"), (5, 13, "B"), (5, 16, "T"),
        (6, 14, "B"), (6, 28, "T"), (7, 15, "B"), (7, 18, "T"), (7, 63, "T"), (8, 9, "B"), (8, 10, "T"),
        (8, 16, "B"), (8, 17, "T"), (8, 18, "T"), (8, 26, "T"), (8, 39, "T"), (8, 54, "T"), (9, 1, "B"),
        (9, 8, "B"), (9, 18, "T"), (9, 24, "T"), (9, 25, "T"), (9, 26, "T"), (10, 2, "B"), (10, 3, "T"),
        (10, 8, "T"), (10, 11, "B"), (11, 10, "B"), (11, 16, "T"), (11, 19, "B"), (12, 0, "T"),
        (12, 13, "B"), (13, 5, "B"), (13, 12, "B"), (13, 58, "T"), (14, 6, "B"), (14, 15, "B"),
        (14, 59, "T"), (15, 2, "T"), (15, 7, "B"), (15, 14, "B"), (16, 5, "T"), (16, 8, "B"),
        (16, 11, "T"), (16, 24, "B"), (16, 25, "T"), (16, 37, "T"), (16, 38, "T"), (17, 2, "T"),
        (17, 8, "T"), (17, 18, "B"), (18, 7, "T"), (18, 8, "T"), (18, 9, "T"), (18, 17, "B"),
        (18, 26, "B"), (19, 11, "B"), (19, 27, "T"), (19, 47, "T"), (20, 21, "B"), (20, 23, "T"),
        (20, 28, "B"), (20, 49, "T"), (20, 63, "T"), (21, 20, "B"), (21, 22, "B"), (21, 42, "T"),
        (22, 1, "T"), (22, 21, "B"), (22, 23, "B"), (22, 30, "T"), (23, 20, "T"), (23, 22, "B"),
        (23, 31, "B"), (24, 9, "T"), (24, 16, "B"), (24, 32, "B"), (24, 42, "T"), (24, 48, "T"),
        (24, 63, "T"), (25, 0, "T"), (25, 1, "T"), (25, 9, "T"), (25, 16, "T"), (25, 26, "B"),
        (26, 8, "T"), (26, 9, "T"), (26, 18, "B"), (26, 25, "B"), (26, 31, "T"), (26, 32, "T"),
        (27, 19, "T"), (27, 35, "B"), (27, 49, "T"), (27, 55, "T"), (27, 57, "T"), (28, 6, "T"),
        (28, 20, "B"), (28, 29, "B"), (28, 32, "T"), (28, 44, "T"), (28, 45, "T"), (29, 28, "B"),
        (29, 37, "B"), (29, 42, "T"), (30, 22, "T"), (30, 38, "B"), (30, 46, "T"), (31, 23, "B"),
        (31, 26, "T"), (31, 39, "B"), (32, 24, "B"), (32, 26, "T"), (32, 28, "T"), (32, 33, "B"),
        (32, 59, "T"), (33, 1, "T"), (33, 32, "B"), (33, 34, "B"), (33, 41, "T"), (33, 49, "T"),
        (34, 0, "T"), (34, 33, "B"), (34, 40, "T"), (34, 42, "B"), (34, 56, "T"), (35, 1, "T"),
        (35, 27, "B"), (35, 36, "B"), (36, 35, "B"), (36, 37, "B"), (36, 41, "T"), (37, 16, "T"),
        (37, 29, "B"), (37, 36, "B"), (38, 16, "T"), (38, 30, "B"), (38, 39, "B"), (38, 53, "T"),
        (39, 8, "T"), (39, 31, "B"), (39, 38, "B"), (40, 34, "T"), (40, 48, "B"), (41, 33, "T"),
        (41, 36, "T"), (41, 42, "B"), (41, 49, "B"), (42, 21, "T"), (42, 24, "T"), (42, 29, "T"),
        (42, 34, "B"), (42, 41, "B"), (43, 0, "T"), (43, 44, "B"), (43, 51, "B"), (44, 28, "T"),
        (44, 43, "B"), (44, 52, "B"), (45, 28, "T"), (45, 46, "B"), (45, 53, "B"), (46, 30, "T"),
        (46, 45, "B"), (46, 47, "B"), (47, 19, "T"), (47, 46, "B"), (47, 49, "T"), (47, 55, "B"),
        (48, 24, "T"), (48, 40, "B"), (48, 56, "B"), (48, 58, "T"), (49, 20, "T"), (49, 27, "T"),
        (49, 33, "T"), (49, 41, "B"), (49, 47, "T"), (49, 57, "B"), (50, 51, "B"), (50, 58, "B"),
        (50, 63, "T"), (51, 43, "B"), (51, 50, "B"), (51, 62, "T"), (52, 44, "B"), (52, 57, "T"),
        (53, 38, "T"), (53, 45, "B"), (53, 54, "B"), (54, 8, "T"), (54, 53, "B"), (54, 62, "B"),
        (55, 27, "T"), (55, 47, "B"), (55, 63, "B"), (56, 34, "T"), (56, 48, "B"), (56, 57, "B"),
        (57, 1, "T"), (57, 27, "T"), (57, 49, "B"), (57, 52, "T"), (57, 56, "B"), (57, 62, "T"),
        (58, 13, "T"), (58, 48, "T"), (58, 50, "B"), (58, 59, "B"), (59, 14, "T"), (59, 32, "T"),
        (59, 58, "B"), (59, 60, "B"), (60, 0, "T"), (60, 59, "B"), (60, 61, "B"), (61, 0, "T"),
        (61, 60, "B"), (61, 62, "B"), (62, 51, "T"), (62, 54, "B"), (62, 57, "T"), (62, 61, "B"),
        (63, 7, "T"), (63, 20, "T"), (63, 24, "T"), (63, 50, "T"), (63, 55, "B"),
    ]);
}

#[test]
fn golden_all_one_way_seed_7() {
    let elements = ElementsConfig { one_way_chance: 1.0, teleport_chance: 0.0, teleport_one_way_chance: 0.0, split_chance: 0.0 };
    let (mut field, mut graph, mut ids) = make_field_graph_ids(6, 6);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    generate_default_split(&mut graph, &mut field, &mut ids, 7, start, &default_params(), &elements, &empty_presets(), None);
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (2, 1, "B"), (2, 3, "B"), (3, 9, "B"), (4, 5, "B"), (7, 6, "B"), (9, 15, "B"),
        (10, 11, "B"), (11, 5, "B"), (12, 6, "B"), (13, 7, "B"), (13, 14, "B"), (14, 8, "B"),
        (16, 10, "B"), (16, 22, "B"), (17, 11, "B"), (19, 18, "B"), (19, 25, "B"), (20, 14, "B"),
        (20, 26, "B"), (21, 15, "B"), (21, 27, "B"), (23, 17, "B"), (24, 18, "B"), (24, 30, "B"),
        (26, 27, "B"), (28, 27, "B"), (29, 23, "B"), (29, 35, "B"), (31, 25, "B"), (31, 32, "B"),
        (32, 33, "B"), (33, 27, "B"), (34, 28, "B"), (35, 34, "B"),
    ]);
}

#[test]
fn golden_with_preset_locks_seed_42() {
    let (mut field, mut graph, mut ids) = make_field_graph_ids(5, 5);
    let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
    let mut preset_state = PresetState::empty();
    preset_state.locked_out.insert(field.node_at(crate::space::SquarePoint { x: 2, y: 2 }).unwrap());
    preset_state.locked_in.insert(field.node_at(crate::space::SquarePoint { x: 4, y: 4 }).unwrap());
    generate_default_split(&mut graph, &mut field, &mut ids, 42, start, &default_params(), &full_two_way_teleport_elements(), &preset_state, None);
    // Regenerated for GitHub issue #222 — see golden_baseline_params_seed_42's comment.
    assert_eq!(snapshot(&graph), vec![
        (0, 1, "B"), (0, 15, "T"), (1, 0, "B"), (2, 7, "B"), (3, 8, "B"), (3, 15, "T"), (4, 17, "T"),
        (6, 19, "T"), (7, 2, "B"), (7, 21, "T"), (8, 3, "B"), (9, 11, "T"), (10, 15, "B"), (11, 9, "T"),
        (11, 16, "T"), (13, 18, "T"), (14, 19, "B"), (15, 0, "T"), (15, 3, "T"), (15, 10, "B"),
        (16, 11, "T"), (16, 17, "B"), (16, 21, "B"), (17, 4, "T"), (17, 12, "B"), (17, 16, "B"),
        (17, 18, "B"), (17, 22, "B"), (18, 13, "T"), (18, 17, "B"), (18, 19, "B"), (19, 6, "T"),
        (19, 14, "B"), (19, 18, "B"), (20, 21, "B"), (21, 7, "T"), (21, 16, "B"), (21, 20, "B"),
        (22, 17, "B"), (24, 5, "T"), (24, 19, "B"), (24, 23, "B"),
    ]);
}
