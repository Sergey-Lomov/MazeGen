use super::*;
use crate::dto::NodeDto;
use maze_core::ids::IdGenerator;
use maze_core::space::{SquarePoint, SquareTessellation, square_rect};
use std::sync::Arc;

fn edge(from: u32, to: u32, kind: &str) -> PostEditEdgeDto {
    PostEditEdgeDto {
        from: PostEditEndpointDto::Node { id: from },
        to: PostEditEndpointDto::Node { id: to },
        kind: kind.to_string(),
    }
}

fn graph_with_nodes(ids: &[u64]) -> Graph {
    let mut graph = Graph::new();
    for &id in ids {
        graph.add_node(id);
    }
    graph
}

fn no_splits() -> HashMap<([i32; 2], u32, u32), u64> {
    HashMap::new()
}

fn preset_endpoint(x: i32, y: i32) -> maze_runner::config::PresetEndpointDto {
    maze_runner::config::PresetEndpointDto {
        point: [x, y],
        slot: None,
        level: None,
    }
}

fn preset(
    from: (i32, i32),
    to: (i32, i32),
    state: maze_runner::config::PresetConnectionStateDto,
) -> PresetConnectionDto {
    PresetConnectionDto {
        from: preset_endpoint(from.0, from.1),
        to: preset_endpoint(to.0, to.1),
        state,
    }
}

#[test]
fn build_graph_from_post_edit_edges_basic_adds_both_directions() {
    let mut graph = graph_with_nodes(&[1, 2]);
    build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic")], &no_splits()).unwrap();
    assert!(graph.edge_between(1, 2).is_some());
    assert!(graph.edge_between(2, 1).is_some());
    assert_eq!(graph.edges().count(), 2);
}

#[test]
fn build_graph_from_post_edit_edges_one_way_adds_only_forward() {
    let mut graph = graph_with_nodes(&[1, 2]);
    build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "one_way")], &no_splits()).unwrap();
    assert!(graph.edge_between(1, 2).is_some());
    assert!(graph.edge_between(2, 1).is_none());
    assert_eq!(graph.edges().count(), 1);
}

#[test]
fn build_graph_from_post_edit_edges_teleport_adds_only_forward_as_teleport_kind() {
    let mut graph = graph_with_nodes(&[1, 2]);
    build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport")], &no_splits()).unwrap();
    let e = graph
        .edges()
        .find(|e| e.from == 1 && e.to == 2)
        .expect("teleport edge must exist");
    assert_eq!(e.kind, EdgeKind::Teleport);
    assert!(
        graph.edge_between(2, 1).is_none(),
        "one \"teleport\" entry must add only one direction"
    );
    assert_eq!(graph.edges().count(), 1);
}

#[test]
fn build_graph_from_post_edit_edges_two_teleport_entries_produce_two_way_teleport() {
    // A two-way teleport is represented as two separate "teleport" entries (one per
    // direction), not a single entry that auto-adds both — mirrors how the web side
    // extracts each directed EdgeDto from generation 1:1 (see extractTeleportEdges).
    let mut graph = graph_with_nodes(&[1, 2]);
    build_graph_from_post_edit_edges(
        &mut graph,
        &[edge(1, 2, "teleport"), edge(2, 1, "teleport")],
        &no_splits(),
    )
    .unwrap();
    assert!(
        graph
            .edges()
            .any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport)
    );
    assert!(
        graph
            .edges()
            .any(|e| e.from == 2 && e.to == 1 && e.kind == EdgeKind::Teleport)
    );
    assert_eq!(graph.edges().count(), 2);
}

#[test]
fn build_graph_from_post_edit_edges_teleport_coexists_with_parallel_basic() {
    // A Basic and a Teleport edge in the same direction between the same pair must both
    // survive — kind-aware dedup in Graph::add_edge allows this (see graph::parallel_edges_tests).
    let mut graph = graph_with_nodes(&[1, 2]);
    build_graph_from_post_edit_edges(
        &mut graph,
        &[edge(1, 2, "basic"), edge(1, 2, "teleport")],
        &no_splits(),
    )
    .unwrap();
    assert!(
        graph
            .edges()
            .any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Basic)
    );
    assert!(
        graph
            .edges()
            .any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport)
    );
    assert_eq!(
        graph.edges().count(),
        3,
        "basic(2 directions) + teleport(1 direction) = 3 edges"
    );
}

fn vertical_edge(from: u32, to: u32, kind: &str) -> VerticalEdgeDto {
    VerticalEdgeDto {
        from,
        to,
        kind: kind.to_string(),
    }
}

#[test]
fn restore_vertical_edges_adds_vertical_passage_and_elevator_edges() {
    let mut graph = graph_with_nodes(&[1, 2, 3]);
    restore_vertical_edges(
        &mut graph,
        &[
            vertical_edge(1, 2, "vertical_passage"),
            vertical_edge(2, 3, "elevator"),
        ],
    );
    let e1 = graph
        .edges()
        .find(|e| e.from == 1 && e.to == 2)
        .expect("vertical_passage edge must exist");
    assert_eq!(e1.kind, EdgeKind::VerticalPassage);
    let e2 = graph
        .edges()
        .find(|e| e.from == 2 && e.to == 3)
        .expect("elevator edge must exist");
    assert_eq!(e2.kind, EdgeKind::Elevator);
    assert_eq!(graph.edges().count(), 2);
}

#[test]
fn restore_vertical_edges_skips_edges_referencing_a_pruned_node() {
    // Node 2 no longer exists in the rebuilt graph (e.g. it was a split slot removed by the
    // user) — a stale vertical edge referencing it must be dropped silently, not panic.
    let mut graph = graph_with_nodes(&[1]);
    restore_vertical_edges(&mut graph, &[vertical_edge(1, 2, "vertical_passage")]);
    assert_eq!(graph.edges().count(), 0);
}

#[test]
fn build_graph_from_post_edit_edges_unknown_kind_is_rejected() {
    let mut graph = graph_with_nodes(&[1, 2]);
    let err = build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "wall")], &no_splits())
        .unwrap_err();
    assert!(
        err.contains("wall"),
        "error must mention the offending kind, got: {err}"
    );
}

#[test]
fn resolve_post_edit_endpoint_node_passthrough() {
    let map = no_splits();
    let ep = PostEditEndpointDto::Node { id: 42 };
    assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 42);
}

#[test]
fn resolve_post_edit_endpoint_split_resolves_from_map() {
    let mut map = no_splits();
    map.insert(([1, 2], 0, 0), 99);
    let ep = PostEditEndpointDto::Split {
        point: [1, 2],
        slot_id: 0,
        level: 0,
    };
    assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 99);
}

#[test]
fn resolve_post_edit_endpoint_split_missing_is_error() {
    let map = no_splits();
    let ep = PostEditEndpointDto::Split {
        point: [1, 2],
        slot_id: 0,
        level: 0,
    };
    let err = resolve_post_edit_endpoint(&ep, &map).unwrap_err();
    assert!(
        err.contains("slot 0"),
        "error should mention the offending slot, got: {err}"
    );
}

#[test]
fn resolve_post_edit_endpoint_split_disambiguates_by_level() {
    // Two levels each have their own slot 0 at the same point — the endpoint's own `level`
    // must pick the right one, not collide (GitHub issue #359).
    let mut map = no_splits();
    map.insert(([0, 0], 0, 0), 10);
    map.insert(([0, 0], 0, 1), 20);
    let ep_l0 = PostEditEndpointDto::Split {
        point: [0, 0],
        slot_id: 0,
        level: 0,
    };
    let ep_l1 = PostEditEndpointDto::Split {
        point: [0, 0],
        slot_id: 0,
        level: 1,
    };
    assert_eq!(resolve_post_edit_endpoint(&ep_l0, &map).unwrap(), 10);
    assert_eq!(resolve_post_edit_endpoint(&ep_l1, &map).unwrap(), 20);
}

fn xy_to_square(xy: [i32; 2]) -> Option<SquarePoint> {
    Some(SquarePoint { x: xy[0], y: xy[1] })
}

fn node(id: u32, x: i32, y: i32, i: u32) -> NodeDto {
    NodeDto {
        id,
        x,
        y,
        i,
        level: 0,
    }
}

#[test]
fn build_field_from_nodes_preserves_given_ids_and_populates_index_maps() {
    let nodes = vec![node(10, 0, 0, 0), node(20, 1, 0, 0)];
    let (field, existing_by_index, index_by_node, level_ids) =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &nodes, 1, &xy_to_square)
            .unwrap();
    let level = level_ids[0];

    assert_eq!(field.nodes_at(level, SquarePoint { x: 0, y: 0 }), &[10]);
    assert_eq!(field.nodes_at(level, SquarePoint { x: 1, y: 0 }), &[20]);
    assert_eq!(existing_by_index[&([0, 0], 0, 0)], 10);
    assert_eq!(existing_by_index[&([1, 0], 0, 0)], 20);
    assert_eq!(index_by_node[&10], 0);
    assert_eq!(index_by_node[&20], 0);
}

#[test]
fn build_field_from_nodes_places_extra_slots_after_the_original_regardless_of_input_order() {
    // Given out of i-order (i=1 before i=0) — the field must still put i=0 at position 0,
    // matching `nodes_at`'s creation-order contract regardless of input order.
    let nodes = vec![node(2, 0, 0, 1), node(1, 0, 0, 0)];
    let (field, _, _, level_ids) =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &nodes, 1, &xy_to_square)
            .unwrap();

    assert_eq!(
        field.nodes_at(level_ids[0], SquarePoint { x: 0, y: 0 }),
        &[1, 2]
    );
}

#[test]
fn build_field_from_nodes_rejects_a_node_outside_the_current_tessellation() {
    // xy_to_cell that maps every coordinate to None -- simulates a project saved before the
    // tessellation shrank, whose stale node no longer resolves to a real point.
    let nodes = vec![node(1, 5, 5, 0)];
    let xy_to_none = |_: [i32; 2]| -> Option<SquarePoint> { None };
    let result =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &nodes, 1, &xy_to_none);
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected an error for a node outside the current tessellation"),
    };
    assert!(
        err.contains("[5, 5]"),
        "error should mention the offending coordinates, got: {err}"
    );
    assert!(
        err.contains('1'),
        "error should mention the offending node id, got: {err}"
    );
}

#[test]
fn build_field_from_nodes_rejects_a_node_referencing_an_unknown_level() {
    let mut n = node(1, 0, 0, 0);
    n.level = 3;
    let result =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &[n], 1, &xy_to_square);
    let err = match result {
        Err(e) => e,
        Ok(_) => panic!("expected an error for a node referencing an unknown level"),
    };
    assert!(
        err.contains("level 3"),
        "error should mention the offending level, got: {err}"
    );
}

/// GitHub issue #359: two levels, one node each at the same (x, y) — must resolve as two
/// distinct nodes on two distinct levels, not collide into one `Field` entry.
#[test]
fn build_field_from_nodes_keeps_two_levels_sharing_a_point_separate() {
    let mut n0 = node(1, 0, 0, 0);
    n0.level = 0;
    let mut n1 = node(2, 0, 0, 0);
    n1.level = 1;
    let (field, _, _, level_ids) =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &[n0, n1], 2, &xy_to_square)
            .unwrap();

    assert_eq!(level_ids.len(), 2);
    assert_eq!(
        field.nodes_at(level_ids[0], SquarePoint { x: 0, y: 0 }),
        &[1]
    );
    assert_eq!(
        field.nodes_at(level_ids[1], SquarePoint { x: 0, y: 0 }),
        &[2]
    );
}

fn build_single_level_maze() -> (Maze<SquareTessellation>, Vec<maze_core::space::LevelId>) {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level_ids: Vec<_> = field.levels_ordered().collect();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    (Maze::new(field, g), level_ids)
}

#[test]
fn apply_split_points_mints_distinct_new_nodes_when_none_exist_yet() {
    let (mut maze, level_ids) = build_single_level_maze();
    let map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0), ([0, 0], 1, 0), ([0, 0], 2, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap();

    assert_ne!(map[&([0, 0], 0, 0)], map[&([0, 0], 1, 0)]);
    assert_ne!(map[&([0, 0], 1, 0)], map[&([0, 0], 2, 0)]);
    assert_ne!(map[&([0, 0], 0, 0)], map[&([0, 0], 2, 0)]);
}

/// GitHub issue #236's core fix: a slot that already has a real node (the field was rebuilt
/// from the client's own authoritative node list via `Field::from_id_cells`, matched by its
/// real `i` — not by position) resolves to that exact same `NodeId` — no re-mint, no drift —
/// instead of the old behavior where every call re-minted every slot from scratch in sorted
/// order.
#[test]
fn apply_split_points_reuses_an_already_existing_slots_node_id() {
    let mut ids = IdGenerator::new();
    let mut field =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let level_ids = vec![level];
    let p = SquarePoint { x: 0, y: 0 };
    // Simulates a field rebuilt with slot 0 already confirmed at a prior call (i = 1: slot_id
    // 0 + 1, since i = 0 is always the point's original node).
    let existing_node = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    g.add_node(existing_node);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let existing = HashMap::from([(([0, 0], 1u32, 0u32), existing_node)]);

    let map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0)],
        &existing,
        &level_ids,
    )
    .unwrap();

    assert_eq!(
        map[&([0, 0], 0, 0)],
        existing_node,
        "must reuse the existing node, not mint a new one"
    );
}

/// One slot already exists (from a prior confirm), a second is newly added in the UI
/// (`addSplitNode`) — the existing slot's id is reused, only the new one gets minted.
#[test]
fn apply_split_points_mints_only_the_newly_added_slot() {
    let mut ids = IdGenerator::new();
    let mut field =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let level_ids = vec![level];
    let p = SquarePoint { x: 0, y: 0 };
    let existing_node = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    g.add_node(existing_node);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let existing = HashMap::from([(([0, 0], 1u32, 0u32), existing_node)]);

    let map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0), ([0, 0], 1, 0)],
        &existing,
        &level_ids,
    )
    .unwrap();

    assert_eq!(
        map[&([0, 0], 0, 0)],
        existing_node,
        "first slot reuses the pre-existing node"
    );
    assert_ne!(
        map[&([0, 0], 1, 0)],
        existing_node,
        "second slot must be a freshly minted, distinct node"
    );
}

/// The actual regression this issue fixes: slot 0 (the *first* of two confirmed extra nodes)
/// is removed by the user — its `NodeId` no longer appears in `existing_by_index` at all (the
/// client's `state.nodes`/`i` no longer carries it), while slot 1 (the *second*, surviving
/// extra node) keeps its own `i` and must keep resolving to its own real `NodeId`, not to
/// whatever node used to sit before it. A position-based scheme would wrongly resolve slot 1
/// to slot 0's old node (or mint a fresh one) once slot 0's entry disappears from the list.
#[test]
fn apply_split_points_keeps_a_surviving_later_slot_correct_after_an_earlier_slot_is_removed() {
    let mut ids = IdGenerator::new();
    let mut field =
        MultiLevelField::single_level(Arc::default(), square_rect(1, 1), &mut ids).unwrap();
    let level = field.single_level_id();
    let level_ids = vec![level];
    let p = SquarePoint { x: 0, y: 0 };
    let removed_node = field.add_node_at(level, p, &mut ids);
    let surviving_node = field.add_node_at(level, p, &mut ids);
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    g.add_node(removed_node);
    g.add_node(surviving_node);
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    // Only slot_id 1 (i = 2) survives in the client's node list — slot_id 0 (i = 1, the
    // removed node) is gone entirely, exactly as `removeSplitNode` leaves `state.nodes` before
    // the next confirm resends a pruned `cfg.nodes`.
    let existing = HashMap::from([(([0, 0], 2u32, 0u32), surviving_node)]);

    let map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 1, 0)],
        &existing,
        &level_ids,
    )
    .unwrap();

    assert_eq!(
        map[&([0, 0], 1, 0)],
        surviving_node,
        "the surviving slot must resolve to its own node, not the removed slot's"
    );
}

/// Same set, same call — resolving `(point, slot_id, level)` twice within one
/// `apply_split_points` output must obviously agree with itself (the actual guarantee this
/// function makes).
#[test]
fn split_map_is_internally_consistent_within_one_call() {
    let (mut maze, level_ids) = build_single_level_maze();
    let map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0), ([0, 0], 1, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap();

    assert_ne!(
        map[&([0, 0], 0, 0)],
        map[&([0, 0], 1, 0)],
        "distinct slots must resolve to distinct nodes"
    );
    assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 0, 0)]));
    assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 1, 0)]));
}

#[test]
fn apply_split_points_rejects_unknown_point() {
    let (mut maze, level_ids) = build_single_level_maze();

    let err = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([5, 5], 0, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap_err();
    assert!(
        err.contains("[5, 5]"),
        "error should mention the offending point, got: {err}"
    );
}

#[test]
fn apply_split_points_rejects_unknown_level() {
    let (mut maze, level_ids) = build_single_level_maze();

    let err = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 7)],
        &no_splits(),
        &level_ids,
    )
    .unwrap_err();
    assert!(
        err.contains("level 7"),
        "error should mention the offending level, got: {err}"
    );
}

#[test]
fn apply_split_points_rejects_point_removed_from_field_without_panicking() {
    // xy_to_cell that maps every coordinate to a Some(...) point, but the point isn't in
    // the field — must not panic (Field::add_node_at panics on an unknown point), must
    // surface as an ordinary Err instead (e.g. a project saved before the tessellation shrank).
    let (mut maze, level_ids) = build_single_level_maze();

    let err = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([9, 9], 0, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap_err();
    assert!(
        err.contains("[9, 9]"),
        "error should mention the offending point, got: {err}"
    );
}

#[test]
fn build_graph_from_post_edit_edges_accepts_split_endpoints_end_to_end() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level_ids: Vec<_> = field.levels_ordered().collect();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let a = maze
        .field
        .nodes_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();

    let split_map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap();
    let split_node = split_map[&([0, 0], 0, 0)];

    let edges = vec![PostEditEdgeDto {
        from: PostEditEndpointDto::Node { id: a as u32 },
        to: PostEditEndpointDto::Split {
            point: [0, 0],
            slot_id: 0,
            level: 0,
        },
        kind: "basic".to_string(),
    }];
    build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

    assert!(maze.graph.edge_between(a, split_node).is_some());
    assert!(maze.graph.edge_between(split_node, a).is_some());
}

/// Reproduces the reported bug: start/finish blocked by a wall, a split node added between
/// them and wired to both as a detour — `meta.start`/`meta.finish` are resolved from the
/// caller-supplied `start`/`finish` ids exactly as `run_compute_analytics` does (already-
/// resolved plain ids on the wire — see `ComputeAnalyticsConfig.start`/`.finish`'s doc comment,
/// GitHub issue #221's plan section on why those two fields differ from `edges`), so if this
/// passes but the browser still shows "no route", the bug is client-side (stale `state.nodes`
/// used to resolve `start`/`finish` on the frontend before sending), not in this WASM pipeline.
#[test]
fn route_exists_through_a_split_node_bridging_a_walled_off_pair() {
    let mut ids = IdGenerator::new();
    let field = MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap();
    let level_ids: Vec<_> = field.levels_ordered().collect();
    let mut g = Graph::new();
    for node in field.all_node_ids() {
        g.add_node(node);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
    let a = maze
        .field
        .nodes_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 })
        .first()
        .copied()
        .unwrap();
    let b = maze
        .field
        .nodes_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 0 })
        .first()
        .copied()
        .unwrap();
    // No edge at all between a and b — the direct passage is walled off.

    let split_map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0)],
        &no_splits(),
        &level_ids,
    )
    .unwrap();
    let split_node = split_map[&([0, 0], 0, 0)];

    let edges = vec![
        PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: a as u32 },
            to: PostEditEndpointDto::Split {
                point: [0, 0],
                slot_id: 0,
                level: 0,
            },
            kind: "basic".to_string(),
        },
        PostEditEdgeDto {
            from: PostEditEndpointDto::Split {
                point: [0, 0],
                slot_id: 0,
                level: 0,
            },
            to: PostEditEndpointDto::Node { id: b as u32 },
            kind: "basic".to_string(),
        },
    ];
    build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

    maze.meta.start = Some(a);
    maze.meta.finish = Some(b);

    let route = maze
        .analysis
        .route_info(&maze.graph, &maze.field, &maze.meta);
    assert!(
        route.is_some(),
        "expected a route from a to b via the split node {split_node}, got None"
    );
}

/// GitHub issue #359 end-to-end regression: two floors sharing the same (x, y) must not
/// collide — each level's own node resolves independently, and an edge on one level never
/// reaches the other level's node at the same point.
#[test]
fn two_levels_sharing_a_point_resolve_to_independent_nodes() {
    let n0 = node(1, 0, 0, 0);
    let mut n1 = node(2, 0, 0, 0);
    n1.level = 1;
    let (field, existing_by_index, _, level_ids) =
        build_field_from_nodes::<SquareTessellation>(&Arc::default(), &[n0, n1], 2, &xy_to_square)
            .unwrap();
    let mut g = Graph::new();
    for id in field.all_node_ids() {
        g.add_node(id);
    }
    let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

    let split_map = apply_split_points(
        &mut maze,
        xy_to_square,
        &[([0, 0], 0, 0), ([0, 0], 0, 1)],
        &existing_by_index,
        &level_ids,
    )
    .unwrap();
    let l0_split = split_map[&([0, 0], 0, 0)];
    let l1_split = split_map[&([0, 0], 0, 1)];

    assert_ne!(
        l0_split, l1_split,
        "the two levels' slot-0 split nodes must be distinct"
    );
    assert_eq!(maze.field.level_of(1), Some(level_ids[0]));
    assert_eq!(maze.field.level_of(2), Some(level_ids[1]));
    assert_eq!(maze.field.level_of(l0_split), Some(level_ids[0]));
    assert_eq!(maze.field.level_of(l1_split), Some(level_ids[1]));
}

// GitHub issue #245 regression: post-edit's rebuild must still resolve preset connection
// edges by real NodeId, not lose them, so a cycle entirely composed of pre-existing preset
// edges stays `preset_locked` even after the user adds an unrelated post-edit edge.
mod preset_edges_for_post_edit_tests {
    use super::*;
    use maze_runner::config::PresetConnectionStateDto;

    #[allow(clippy::type_complexity)]
    fn existing(entries: &[(([i32; 2], u32, u32), u64)]) -> SplitSlotMap {
        entries.iter().copied().collect()
    }

    #[test]
    fn passage_resolves_to_both_directions() {
        let existing_by_index = existing(&[(([0, 0], 0, 0), 1), (([1, 0], 0, 0), 2)]);
        let presets = vec![preset((0, 0), (1, 0), PresetConnectionStateDto::Passage)];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &no_splits());

        assert!(edges.contains(&(1, 2)));
        assert!(edges.contains(&(2, 1)));
        assert_eq!(edges.len(), 2);
    }

    #[test]
    fn one_way_forward_resolves_to_only_the_forward_direction() {
        let existing_by_index = existing(&[(([0, 0], 0, 0), 1), (([1, 0], 0, 0), 2)]);
        let presets = vec![preset(
            (0, 0),
            (1, 0),
            PresetConnectionStateDto::OneWayForward,
        )];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &no_splits());

        assert!(edges.contains(&(1, 2)));
        assert!(
            !edges.contains(&(2, 1)),
            "the blocked reverse direction must never resolve as a preset edge"
        );
        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn wall_never_establishes_a_preset_edge() {
        let existing_by_index = existing(&[(([0, 0], 0, 0), 1), (([1, 0], 0, 0), 2)]);
        let presets = vec![preset((0, 0), (1, 0), PresetConnectionStateDto::Wall)];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &no_splits());

        assert!(edges.is_empty());
    }

    #[test]
    fn unresolvable_endpoint_is_silently_skipped() {
        // Point [9, 9] never appears in existing_by_index -- simulates a preset referencing a
        // point removed from the tessellation since the preset was placed.
        let existing_by_index = existing(&[(([0, 0], 0, 0), 1)]);
        let presets = vec![preset((0, 0), (9, 9), PresetConnectionStateDto::Passage)];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &no_splits());

        assert!(edges.is_empty());
    }

    #[test]
    fn split_slot_endpoint_resolves_via_split_map_not_existing_by_index() {
        let existing_by_index = existing(&[(([0, 0], 0, 0), 1)]);
        let split_map = existing(&[(([1, 0], 0, 0), 42)]);
        let presets = vec![PresetConnectionDto {
            from: preset_endpoint(0, 0),
            to: maze_runner::config::PresetEndpointDto {
                point: [1, 0],
                slot: Some(0),
                level: None,
            },
            state: PresetConnectionStateDto::Passage,
        }];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &split_map);

        assert!(edges.contains(&(1, 42)));
        assert!(edges.contains(&(42, 1)));
    }

    #[test]
    fn split_slot_endpoint_disambiguates_by_level() {
        // Two floors each declare a preset endpoint at the same point/slot — the endpoint's
        // own `level` must select the right one (GitHub issue #359).
        let existing_by_index = no_splits();
        let split_map = existing(&[(([0, 0], 0, 0), 10), (([0, 0], 0, 1), 20)]);
        let presets = vec![PresetConnectionDto {
            from: maze_runner::config::PresetEndpointDto {
                point: [0, 0],
                slot: Some(0),
                level: Some(1),
            },
            to: maze_runner::config::PresetEndpointDto {
                point: [0, 0],
                slot: Some(0),
                level: None,
            },
            state: PresetConnectionStateDto::OneWayForward,
        }];

        let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &split_map);

        assert!(
            edges.contains(&(20, 10)),
            "level-1 endpoint must resolve to the level-1 node, level-0(default) to the level-0 node"
        );
    }
}

mod resolve_preset_nodes_for_post_edit_tests {
    use super::*;

    #[allow(clippy::type_complexity)]
    fn existing(entries: &[(([i32; 2], u32, u32), u64)]) -> SplitSlotMap {
        entries.iter().copied().collect()
    }

    #[test]
    fn resolves_a_confirmed_split_node_via_split_map() {
        let split_map = existing(&[(([0, 0], 0, 0), 42)]);
        let nodes = resolve_preset_nodes_for_post_edit(&[([0, 0], 0, 0)], &no_splits(), &split_map);
        assert!(nodes.contains(&42));
        assert_eq!(nodes.len(), 1);
    }

    #[test]
    fn unresolvable_point_is_silently_skipped() {
        let nodes =
            resolve_preset_nodes_for_post_edit(&[([9, 9], 0, 0)], &no_splits(), &no_splits());
        assert!(nodes.is_empty());
    }
}
