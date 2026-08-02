use std::collections::HashMap;
use maze_core::{
    space::Tessellation,
    graph::{Graph, EdgeKind},
    space::Field,
    Maze,
};
use crate::dto::{PostEditEdgeDto, PostEditEndpointDto};

/// Resolves one `PostEditEndpointDto` to a real `NodeId` (as `u64`). `Node` passes through as-is;
/// `Split` looks up `(point, slot_id)` in `split_map` (built by `apply_split_points`) — `Err` if
/// absent, meaning the edge list and `split_points` disagree about which slots exist (a caller
/// bug, not a panic-worthy invariant violation, so it's a `Result` like every other malformed-
/// input case on this path).
pub(crate) fn resolve_post_edit_endpoint(
    ep: &PostEditEndpointDto,
    split_map: &HashMap<([i32; 2], u32), u64>,
) -> Result<u64, String> {
    match ep {
        PostEditEndpointDto::Node { id } => Ok(*id as u64),
        PostEditEndpointDto::Split { point, slot_id } => {
            split_map.get(&(*point, *slot_id)).copied()
                .ok_or_else(|| format!("split endpoint {point:?}/slot {slot_id} was not created by split_points"))
        }
    }
}

/// Builds post-edit's passages (and read-only pass-through teleports) into `graph` — split out
/// from `run_compute_analytics` so the edge-kind matching itself can be unit-tested without a
/// `JsValue`/wasm context. "basic" adds both directions (bidirectional passage); "one_way" adds
/// only `from→to` (direction already normalized by the caller); "teleport" adds a single directed
/// `EdgeKind::Teleport` edge — a two-way teleport arrives as two separate "teleport" entries (one
/// per direction), matching how the web side extracts them 1:1 from the generated `EdgeDto` list
/// (see `extractTeleportEdges`), the same way "one_way" already represents only one direction
/// per entry unlike "basic".
///
/// `split_map` resolves any `Split` endpoint to its real `NodeId` (GitHub issue #221) — built by
/// `apply_split_points`, which must run first.
pub(crate) fn build_graph_from_post_edit_edges(
    graph: &mut Graph,
    edges: &[PostEditEdgeDto],
    split_map: &HashMap<([i32; 2], u32), u64>,
) -> Result<(), String> {
    for e in edges {
        let from_id = resolve_post_edit_endpoint(&e.from, split_map)?;
        let to_id   = resolve_post_edit_endpoint(&e.to, split_map)?;
        match e.kind.as_str() {
            "basic" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
            }
            "one_way" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
            }
            "teleport" => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
            }
            other => return Err(format!("unknown edge kind: {other}")),
        }
    }
    Ok(())
}

/// Resolves `split_points` (GitHub issue #221) against a `Maze` already built from the client's
/// authoritative `nodes` list (GitHub issue #236) — reuses each slot's existing `NodeId` where one
/// already exists (a split node confirmed by an earlier call), minting a fresh one via
/// `Maze::add_node_at` only for a slot with no existing node yet (just `addSplitNode`'d in the UI,
/// not yet confirmed). This is what makes a split node's `NodeId` stable across confirms — the
/// old approach (always re-minting every slot in sorted order every call) is exactly the bug this
/// issue fixes: a split node's absolute id shifting between calls depending on what else changed.
///
/// `existing_by_index` is `(point, i) -> NodeId` (`NodeDto.i`, see its doc comment), built directly
/// by the caller from `cfg.nodes` — **not** reconstructed from position in `nodes_at`. `slot_id`
/// maps onto `i` as `slot_id + 1` (`i = 0` is always the point's original node, which `split_points`
/// never addresses). Matching by the real `i` rather than by position is what keeps this correct
/// after a non-last split node is removed: `i` never shifts or gets compacted when an earlier
/// sibling at the same point disappears (a position-based scheme would silently resolve a
/// surviving slot to whatever node happens to now sit at that position instead).
///
/// Every point is checked against the field with `xy_to_point`/`contains` before calling
/// `add_node_at` — `Field::add_node_at` panics on an unknown point, and a stale `split_points`
/// entry (e.g. a project saved when the point existed, loaded after the tessellation shrank) must
/// surface as an ordinary `Err`, not take down the whole call.
pub(crate) fn apply_split_points<T: Tessellation>(
    maze: &mut Maze<T>,
    xy_to_point: impl Fn([i32; 2]) -> Option<T::Point>,
    split_points: &[([i32; 2], u32)],
    existing_by_index: &HashMap<([i32; 2], u32), u64>,
) -> Result<HashMap<([i32; 2], u32), u64>, String> {
    let mut map = HashMap::new();
    for &(xy, slot_id) in split_points {
        let node = match existing_by_index.get(&(xy, slot_id + 1)) {
            Some(&id) => id,
            None => {
                let point = xy_to_point(xy)
                    .filter(|&p| maze.field.contains(p))
                    .ok_or_else(|| format!("split_points references unknown point {xy:?}"))?;
                maze.add_node_at(point)
            }
        };
        map.insert((xy, slot_id), node);
    }
    Ok(map)
}

/// Builds the three artifacts `run_compute_analytics` needs from `cfg.nodes` (GitHub issue #236)
/// — split out so this pure `NodeDto[]` → `(Field, index maps)` transformation can be unit-tested
/// without a `JsValue`/wasm context, unlike `run_compute_analytics` itself (ends in
/// `serde_wasm_bindgen::Serializer::json_compatible()`, which panics outside a real WASM runtime —
/// see `run_initial_generation`'s doc comment in `runner.rs` for the same constraint on the
/// generation path).
///
/// Returns `(field, existing_by_index, index_by_node)`:
/// - `field`: rebuilt directly from the client's own node ids, not re-minted from
///   `tessellation.points` order — this is what makes the rebuild reproduce exactly the ids the
///   client already holds, including auto-split nodes whose ids come from generator traversal
///   order rather than coordinate order. Entries are sorted by `i` within each point
///   (`Vec::sort_by_key` is stable, but the sort itself is what matters here, not stability) so
///   `Field`'s own "position 0 is the original, never-removable node" invariant lines up with `i`'s
///   identical "0 is original" rule regardless of what order the client happened to list a point's
///   nodes in.
/// - `existing_by_index`: `(point, i) -> NodeId`, what `apply_split_points` matches `split_points`
///   entries against.
/// - `index_by_node`: `NodeId -> i`, what `build_analytics_snapshot`'s `index_of` callback reuses.
///
/// A node whose `(x, y)` doesn't resolve against the current tessellation (e.g. a project saved
/// before the tessellation shrank) is an `Err`, not a silent drop — `apply_split_points` already
/// treats the analogous stale-`split_points`-point case as an error, and silently excluding a node
/// here would leave `IdGenerator::resume_after`'s next-id ceiling computed from fewer nodes than the
/// client actually holds, risking a freshly minted node colliding with an id the client still has
/// cached for a node outside this call's surviving set.
pub(crate) fn build_field_from_nodes<T: Tessellation>(
    nodes: &[crate::dto::NodeDto],
    xy_to_point: &impl Fn([i32; 2]) -> Option<T::Point>,
) -> Result<(Field<T>, HashMap<([i32; 2], u32), u64>, HashMap<u64, u32>), String>
where
    T::Point: Copy,
{
    let mut entries: Vec<(u64, T::Point, u32)> = Vec::with_capacity(nodes.len());
    for n in nodes {
        let point = xy_to_point([n.x, n.y])
            .ok_or_else(|| format!("node {} references a point outside the current tessellation: [{}, {}]", n.id, n.x, n.y))?;
        entries.push((n.id as u64, point, n.i));
    }
    entries.sort_by_key(|&(_, _, i)| i);
    let existing_by_index: HashMap<([i32; 2], u32), u64> = nodes.iter()
        .map(|n| (([n.x, n.y], n.i), n.id as u64))
        .collect();
    let index_by_node: HashMap<u64, u32> = nodes.iter()
        .map(|n| (n.id as u64, n.i))
        .collect();
    let field = Field::<T>::from_id_points(entries.into_iter().map(|(id, p, _)| (id, p)));
    Ok((field, existing_by_index, index_by_node))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maze_core::ids::IdGenerator;
    use maze_core::space::{SquareTessellation, SquarePoint, square_rect};
    use crate::dto::NodeDto;

    fn edge(from: u32, to: u32, kind: &str) -> PostEditEdgeDto {
        PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: from },
            to: PostEditEndpointDto::Node { id: to },
            kind: kind.to_string(),
        }
    }

    fn graph_with_nodes(ids: &[u64]) -> Graph {
        let mut graph = Graph::new();
        for &id in ids { graph.add_node(id); }
        graph
    }

    fn no_splits() -> HashMap<([i32; 2], u32), u64> {
        HashMap::new()
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
        let e = graph.edges().find(|e| e.from == 1 && e.to == 2).expect("teleport edge must exist");
        assert_eq!(e.kind, EdgeKind::Teleport);
        assert!(graph.edge_between(2, 1).is_none(), "one \"teleport\" entry must add only one direction");
        assert_eq!(graph.edges().count(), 1);
    }

    #[test]
    fn build_graph_from_post_edit_edges_two_teleport_entries_produce_two_way_teleport() {
        // A two-way teleport is represented as two separate "teleport" entries (one per
        // direction), not a single entry that auto-adds both — mirrors how the web side
        // extracts each directed EdgeDto from generation 1:1 (see extractTeleportEdges).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "teleport"), edge(2, 1, "teleport")], &no_splits()).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert!(graph.edges().any(|e| e.from == 2 && e.to == 1 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 2);
    }

    #[test]
    fn build_graph_from_post_edit_edges_teleport_coexists_with_parallel_basic() {
        // A Basic and a Teleport edge in the same direction between the same pair must both
        // survive — kind-aware dedup in Graph::add_edge allows this (see graph::parallel_edges_tests).
        let mut graph = graph_with_nodes(&[1, 2]);
        build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "basic"), edge(1, 2, "teleport")], &no_splits()).unwrap();
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Basic));
        assert!(graph.edges().any(|e| e.from == 1 && e.to == 2 && e.kind == EdgeKind::Teleport));
        assert_eq!(graph.edges().count(), 3, "basic(2 directions) + teleport(1 direction) = 3 edges");
    }

    #[test]
    fn build_graph_from_post_edit_edges_unknown_kind_is_rejected() {
        let mut graph = graph_with_nodes(&[1, 2]);
        let err = build_graph_from_post_edit_edges(&mut graph, &[edge(1, 2, "wall")], &no_splits()).unwrap_err();
        assert!(err.contains("wall"), "error must mention the offending kind, got: {err}");
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
        map.insert(([1, 2], 0), 99);
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0 };
        assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 99);
    }

    #[test]
    fn resolve_post_edit_endpoint_split_missing_is_error() {
        let map = no_splits();
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0 };
        let err = resolve_post_edit_endpoint(&ep, &map).unwrap_err();
        assert!(err.contains("slot 0"), "error should mention the offending slot, got: {err}");
    }

    fn xy_to_square(xy: [i32; 2]) -> Option<SquarePoint> {
        Some(SquarePoint { x: xy[0], y: xy[1] })
    }

    fn node(id: u32, x: i32, y: i32, i: u32) -> NodeDto {
        NodeDto { id, x, y, i }
    }

    #[test]
    fn build_field_from_nodes_preserves_given_ids_and_populates_index_maps() {
        let nodes = vec![node(10, 0, 0, 0), node(20, 1, 0, 0)];
        let (field, existing_by_index, index_by_node) = build_field_from_nodes::<SquareTessellation>(&nodes, &xy_to_square).unwrap();

        assert_eq!(field.nodes_at(SquarePoint { x: 0, y: 0 }), &[10]);
        assert_eq!(field.nodes_at(SquarePoint { x: 1, y: 0 }), &[20]);
        assert_eq!(existing_by_index[&([0, 0], 0)], 10);
        assert_eq!(existing_by_index[&([1, 0], 0)], 20);
        assert_eq!(index_by_node[&10], 0);
        assert_eq!(index_by_node[&20], 0);
    }

    #[test]
    fn build_field_from_nodes_places_extra_slots_after_the_original_regardless_of_input_order() {
        // Given out of i-order (i=1 before i=0) — the field must still put i=0 at position 0,
        // matching `nodes_at`'s creation-order contract regardless of input order.
        let nodes = vec![node(2, 0, 0, 1), node(1, 0, 0, 0)];
        let (field, _, _) = build_field_from_nodes::<SquareTessellation>(&nodes, &xy_to_square).unwrap();

        assert_eq!(field.nodes_at(SquarePoint { x: 0, y: 0 }), &[1, 2]);
    }

    #[test]
    fn build_field_from_nodes_rejects_a_node_outside_the_current_tessellation() {
        // xy_to_point that maps every coordinate to None -- simulates a project saved before the
        // tessellation shrank, whose stale node no longer resolves to a real point.
        let nodes = vec![node(1, 5, 5, 0)];
        let xy_to_none = |_: [i32; 2]| -> Option<SquarePoint> { None };
        let result = build_field_from_nodes::<SquareTessellation>(&nodes, &xy_to_none);
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected an error for a node outside the current tessellation"),
        };
        assert!(err.contains("[5, 5]"), "error should mention the offending coordinates, got: {err}");
        assert!(err.contains('1'), "error should mention the offending node id, got: {err}");
    }

    #[test]
    fn apply_split_points_mints_distinct_new_nodes_when_none_exist_yet() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0), ([0, 0], 1), ([0, 0], 2)], &no_splits()).unwrap();

        assert_ne!(map[&([0, 0], 0)], map[&([0, 0], 1)]);
        assert_ne!(map[&([0, 0], 1)], map[&([0, 0], 2)]);
        assert_ne!(map[&([0, 0], 0)], map[&([0, 0], 2)]);
    }

    /// GitHub issue #236's core fix: a slot that already has a real node (the field was rebuilt
    /// from the client's own authoritative node list via `Field::from_id_points`, matched by its
    /// real `i` — not by position) resolves to that exact same `NodeId` — no re-mint, no drift —
    /// instead of the old behavior where every call re-minted every slot from scratch in sorted
    /// order.
    #[test]
    fn apply_split_points_reuses_an_already_existing_slots_node_id() {
        let mut ids = IdGenerator::new();
        let mut field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        // Simulates a field rebuilt with slot 0 already confirmed at a prior call (i = 1: slot_id
        // 0 + 1, since i = 0 is always the point's original node).
        let existing_node = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        g.add_node(existing_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let existing = HashMap::from([(([0, 0], 1u32), existing_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0)], &existing).unwrap();

        assert_eq!(map[&([0, 0], 0)], existing_node, "must reuse the existing node, not mint a new one");
    }

    /// One slot already exists (from a prior confirm), a second is newly added in the UI
    /// (`addSplitNode`) — the existing slot's id is reused, only the new one gets minted.
    #[test]
    fn apply_split_points_mints_only_the_newly_added_slot() {
        let mut ids = IdGenerator::new();
        let mut field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let existing_node = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        g.add_node(existing_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let existing = HashMap::from([(([0, 0], 1u32), existing_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0), ([0, 0], 1)], &existing).unwrap();

        assert_eq!(map[&([0, 0], 0)], existing_node, "first slot reuses the pre-existing node");
        assert_ne!(map[&([0, 0], 1)], existing_node, "second slot must be a freshly minted, distinct node");
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
        let mut field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let p = SquarePoint { x: 0, y: 0 };
        let removed_node = field.add_node_at(p, &mut ids);
        let surviving_node = field.add_node_at(p, &mut ids);
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        g.add_node(removed_node);
        g.add_node(surviving_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        // Only slot_id 1 (i = 2) survives in the client's node list — slot_id 0 (i = 1, the
        // removed node) is gone entirely, exactly as `removeSplitNode` leaves `state.nodes` before
        // the next confirm resends a pruned `cfg.nodes`.
        let existing = HashMap::from([(([0, 0], 2u32), surviving_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 1)], &existing).unwrap();

        assert_eq!(map[&([0, 0], 1)], surviving_node,
            "the surviving slot must resolve to its own node, not the removed slot's");
    }

    /// Same set, same call — resolving `(point, slot_id)` twice within one `apply_split_points`
    /// output must obviously agree with itself (the actual guarantee this function makes).
    #[test]
    fn split_map_is_internally_consistent_within_one_call() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0), ([0, 0], 1)], &no_splits()).unwrap();

        assert_ne!(map[&([0, 0], 0)], map[&([0, 0], 1)], "distinct slots must resolve to distinct nodes");
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 0)]));
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 1)]));
    }

    #[test]
    fn apply_split_points_rejects_unknown_point() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let err = apply_split_points(&mut maze, xy_to_square, &[([5, 5], 0)], &no_splits()).unwrap_err();
        assert!(err.contains("[5, 5]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn apply_split_points_rejects_point_removed_from_field_without_panicking() {
        // xy_to_point that maps every coordinate to a Some(...) point, but the point isn't in
        // the field — must not panic (Field::add_node_at panics on an unknown point), must
        // surface as an ordinary Err instead (e.g. a project saved before the tessellation shrank).
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(1, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let err = apply_split_points(&mut maze, xy_to_square, &[([9, 9], 0)], &no_splits()).unwrap_err();
        assert!(err.contains("[9, 9]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn build_graph_from_post_edit_edges_accepts_split_endpoints_end_to_end() {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0)], &no_splits()).unwrap();
        let split_node = split_map[&([0, 0], 0)];

        let edges = vec![PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: a as u32 },
            to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
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
        let field = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = maze.field.nodes_at(SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        // No edge at all between a and b — the direct passage is walled off.

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0)], &no_splits()).unwrap();
        let split_node = split_map[&([0, 0], 0)];

        let edges = vec![
            PostEditEdgeDto {
                from: PostEditEndpointDto::Node { id: a as u32 },
                to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
                kind: "basic".to_string(),
            },
            PostEditEdgeDto {
                from: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0 },
                to: PostEditEndpointDto::Node { id: b as u32 },
                kind: "basic".to_string(),
            },
        ];
        build_graph_from_post_edit_edges(&mut maze.graph, &edges, &split_map).unwrap();

        maze.meta.start = Some(a);
        maze.meta.finish = Some(b);

        let route = maze.analysis.route_info(&maze.graph, &maze.field, &maze.meta);
        assert!(route.is_some(), "expected a route from a to b via the split node {split_node}, got None");
    }
}
