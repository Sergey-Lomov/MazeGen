use std::collections::{HashMap, HashSet};
use maze_core::{
    space::Tessellation,
    graph::{Graph, EdgeKind},
    space::{Field, MultiLevelField},
    Maze,
};
use crate::dto::{PostEditEdgeDto, PostEditEndpointDto};
use crate::generation_config::PresetConnectionDto;

/// Resolves one `PostEditEndpointDto` to a real `NodeId` (as `u64`). `Node` passes through as-is;
/// `Split` looks up `(point, slot_id, level)` in `split_map` (built by `apply_split_points`) — `Err`
/// if absent, meaning the edge list and `split_points` disagree about which slots exist (a caller
/// bug, not a panic-worthy invariant violation, so it's a `Result` like every other malformed-
/// input case on this path).
pub(crate) fn resolve_post_edit_endpoint(
    ep: &PostEditEndpointDto,
    split_map: &HashMap<([i32; 2], u32, u32), u64>,
) -> Result<u64, String> {
    match ep {
        PostEditEndpointDto::Node { id } => Ok(*id as u64),
        PostEditEndpointDto::Split { point, slot_id, level } => {
            split_map.get(&(*point, *slot_id, *level)).copied()
                .ok_or_else(|| format!("split endpoint {point:?}/slot {slot_id}/level {level} was not created by split_points"))
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
    split_map: &HashMap<([i32; 2], u32, u32), u64>,
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
/// `Maze::add_node_at_on_level` only for a slot with no existing node yet (just `addSplitNode`'d in
/// the UI, not yet confirmed). This is what makes a split node's `NodeId` stable across confirms —
/// the old approach (always re-minting every slot in sorted order every call) is exactly the bug
/// this issue fixes: a split node's absolute id shifting between calls depending on what else
/// changed.
///
/// `existing_by_index` is `(point, i, level) -> NodeId` (`NodeDto.i`, see its doc comment; `level`
/// is `NodeDto.level`, GitHub issue #359), built directly by the caller from `cfg.nodes` — **not**
/// reconstructed from position in `nodes_at`. `slot_id` maps onto `i` as `slot_id + 1` (`i = 0` is
/// always the point's original node, which `split_points` never addresses). Matching by the real
/// `i` rather than by position is what keeps this correct after a non-last split node is removed:
/// `i` never shifts or gets compacted when an earlier sibling at the same point disappears (a
/// position-based scheme would silently resolve a surviving slot to whatever node happens to now
/// sit at that position instead).
///
/// `level_ids` maps a `split_points` entry's own 0-based `level_fields` index to the `MultiLevelField`'s
/// real `LevelId` (`levels_ordered()` order, same as `build_field_from_nodes` builds it) — every
/// point is checked against that level's own field with `xy_to_point`/`contains` before calling
/// `add_node_at_on_level`: `Field::add_node_at` panics on an unknown point, and a stale
/// `split_points` entry (e.g. a project saved when the point existed, loaded after the tessellation
/// shrank, or naming a level index that no longer exists) must surface as an ordinary `Err`, not
/// take down the whole call.
pub(crate) fn apply_split_points<T: Tessellation>(
    maze: &mut Maze<T>,
    xy_to_point: impl Fn([i32; 2]) -> Option<T::Point>,
    split_points: &[([i32; 2], u32, u32)],
    existing_by_index: &HashMap<([i32; 2], u32, u32), u64>,
    level_ids: &[maze_core::space::LevelId],
) -> Result<HashMap<([i32; 2], u32, u32), u64>, String> {
    let mut map = HashMap::new();
    for &(xy, slot_id, level_index) in split_points {
        let node = match existing_by_index.get(&(xy, slot_id + 1, level_index)) {
            Some(&id) => id,
            None => {
                let &level = level_ids.get(level_index as usize)
                    .ok_or_else(|| format!("split_points references unknown level {level_index}"))?;
                let point = xy_to_point(xy)
                    .filter(|&p| maze.field.field_of(level).is_some_and(|f| f.contains(p)))
                    .ok_or_else(|| format!("split_points references unknown point {xy:?} on level {level_index}"))?;
                maze.add_node_at_on_level(level, point)
            }
        };
        map.insert((xy, slot_id, level_index), node);
    }
    Ok(map)
}

/// Resolves one `PresetEndpointDto` to a real `NodeId` against post-edit's own already-resolved
/// maps — `existing_by_index` (`(point, i, level)`, `i = 0` is the point's original node) and
/// `split_map` (`(point, slot_id, level)`, built by `apply_split_points` above). `ep.level`
/// (GitHub issue #359, `None` meaning level 0) selects which floor's own maps entry is looked up.
/// Returns `None` for an unresolvable endpoint (unknown point/level, or a slot not present in
/// either map), same "silently unresolved" contract `maze_core::generation::resolve_preset_endpoint`
/// uses for the generation path.
fn resolve_preset_endpoint_for_post_edit(
    ep: &maze_runner::config::PresetEndpointDto,
    existing_by_index: &HashMap<([i32; 2], u32, u32), u64>,
    split_map: &HashMap<([i32; 2], u32, u32), u64>,
) -> Option<u64> {
    let level = ep.level.unwrap_or(0);
    match ep.slot {
        None => existing_by_index.get(&(ep.point, 0, level)).copied(),
        Some(slot_id) => split_map.get(&(ep.point, slot_id, level)).copied(),
    }
}

/// Computes just the `preset_edges` a full `maze_core::generation::PresetState` would carry
/// (GitHub issue #245) — post-edit's `Field`/`Graph` are already fully rebuilt from the client's
/// own node/edge list (see `run_compute_analytics`), so unlike `build_preset_state` this never
/// mutates anything: every preset connection is resolved against the maps `run_compute_analytics`
/// already built, and only `Passage`/`OneWayForward`/`OneWayBackward`/`Teleport` endpoints
/// contribute an entry (mirrors `build_preset_state`'s own directed-pair semantics exactly —
/// `Wall` never establishes an edge, a one-way's blocked reverse direction is never inserted).
/// A preset whose endpoint doesn't resolve (stale/removed point or slot) is silently skipped, same
/// as `build_preset_state`.
pub(crate) fn preset_edges_for_post_edit(
    preset_connections: &[PresetConnectionDto],
    existing_by_index: &HashMap<([i32; 2], u32, u32), u64>,
    split_map: &HashMap<([i32; 2], u32, u32), u64>,
) -> HashSet<(u64, u64)> {
    let mut preset_edges = HashSet::new();
    for preset in preset_connections {
        let (Some(from_id), Some(to_id)) = (
            resolve_preset_endpoint_for_post_edit(&preset.from, existing_by_index, split_map),
            resolve_preset_endpoint_for_post_edit(&preset.to, existing_by_index, split_map),
        ) else { continue };
        match &preset.state {
            maze_runner::config::PresetConnectionStateDto::Wall => {}
            maze_runner::config::PresetConnectionStateDto::Passage => {
                preset_edges.insert((from_id, to_id));
                preset_edges.insert((to_id, from_id));
            }
            maze_runner::config::PresetConnectionStateDto::OneWayForward => {
                preset_edges.insert((from_id, to_id));
            }
            maze_runner::config::PresetConnectionStateDto::OneWayBackward => {
                preset_edges.insert((to_id, from_id));
            }
            maze_runner::config::PresetConnectionStateDto::TeleportForward => {
                preset_edges.insert((from_id, to_id));
            }
            maze_runner::config::PresetConnectionStateDto::TeleportBackward => {
                preset_edges.insert((to_id, from_id));
            }
            maze_runner::config::PresetConnectionStateDto::TeleportTwoWay => {
                preset_edges.insert((from_id, to_id));
                preset_edges.insert((to_id, from_id));
            }
        }
    }
    preset_edges
}

/// Computes the set of `NodeId`s the preset snapshot currently declares as split nodes (GitHub
/// issue #245's split-node/route extension) — resolves each `(point, slot)` entry through the
/// same `existing_by_index`/`split_map` maps `preset_edges_for_post_edit` already builds. Feeds
/// `PresetState.preset_declared_nodes` on the post-edit path: unlike the generate path (where that
/// field means "actually minted in this call"), here it means "the preset snapshot currently
/// declares this node" — `PresetState::is_preset_locked_node` is reused unchanged on both paths,
/// only how this set is populated differs. An entry whose `(point, slot)` doesn't resolve (stale
/// point, or a slot never confirmed into `split_map`) is silently skipped, same contract as
/// `preset_edges_for_post_edit`.
pub(crate) fn resolve_preset_nodes_for_post_edit(
    preset_split_points: &[([i32; 2], u32, u32)],
    existing_by_index: &HashMap<([i32; 2], u32, u32), u64>,
    split_map: &HashMap<([i32; 2], u32, u32), u64>,
) -> HashSet<u64> {
    preset_split_points.iter()
        .filter_map(|&(point, slot, level)| split_map.get(&(point, slot, level)).or_else(|| existing_by_index.get(&(point, slot + 1, level))).copied())
        .collect()
}

/// Builds the artifacts `run_compute_analytics` needs from `cfg.nodes`/`cfg.level_fields` (GitHub
/// issues #236, #359) — split out so this pure `(NodeDto[], level count)` → `(MultiLevelField,
/// index maps, level ids)` transformation can be unit-tested without a `JsValue`/wasm context,
/// unlike `run_compute_analytics` itself (ends in
/// `serde_wasm_bindgen::Serializer::json_compatible()`, which panics outside a real WASM runtime —
/// see `run_initial_generation`'s doc comment in `runner.rs` for the same constraint on the
/// generation path).
///
/// Returns `(field, existing_by_index, index_by_node, level_ids)`:
/// - `field`: one `Field` per `level_field_count` entry, each built (via `Field::from_id_points`)
///   only from `cfg.nodes` entries whose own `level` matches that level's index — rebuilt directly
///   from the client's own node ids, not re-minted from `tessellation.points` order, so the rebuild
///   reproduces exactly the ids the client already holds, including auto-split nodes whose ids come
///   from generator traversal order rather than coordinate order. Each level's own entries are
///   sorted by `i` (`Vec::sort_by_key` is stable, but the sort itself is what matters here, not
///   stability) so `Field`'s own "position 0 is the original, never-removable node" invariant lines
///   up with `i`'s identical "0 is original" rule regardless of what order the client happened to
///   list a point's nodes in.
/// - `existing_by_index`: `(point, i, level) -> NodeId`, what `apply_split_points` matches
///   `split_points` entries against.
/// - `index_by_node`: `NodeId -> i`, what `build_analytics_snapshot`'s `index_of` callback reuses.
/// - `level_ids`: this call's freshly-built `MultiLevelField`'s `LevelId`s in `level_fields` order
///   (index `k` is the level `NodeDto.level == k` resolves against) — what `apply_split_points`
///   maps a split point's own `level` index onto before minting/looking up a node on it.
///
/// A node whose `(x, y)` doesn't resolve against its own level's tessellation (e.g. a project saved
/// before the tessellation shrank) or whose `level` is outside `0..level_field_count` is an `Err`,
/// not a silent drop — `apply_split_points` already treats the analogous stale-`split_points`-point
/// case as an error, and silently excluding a node here would leave `IdGenerator::resume_after`'s
/// next-id ceiling computed from fewer nodes than the client actually holds, risking a freshly
/// minted node colliding with an id the client still has cached for a node outside this call's
/// surviving set.
pub(crate) fn build_field_from_nodes<T: Tessellation>(
    nodes: &[crate::dto::NodeDto],
    level_field_count: usize,
    xy_to_point: &impl Fn([i32; 2]) -> Option<T::Point>,
) -> Result<(MultiLevelField<T>, HashMap<([i32; 2], u32, u32), u64>, HashMap<u64, u32>, Vec<maze_core::space::LevelId>), String>
where
    T::Point: Copy,
{
    let mut entries_by_level: Vec<Vec<(u64, T::Point, u32)>> = vec![Vec::new(); level_field_count];
    for n in nodes {
        let entries = entries_by_level.get_mut(n.level as usize)
            .ok_or_else(|| format!("node {} references unknown level {}", n.id, n.level))?;
        let point = xy_to_point([n.x, n.y])
            .ok_or_else(|| format!("node {} references a point outside the current tessellation: [{}, {}] (level {})", n.id, n.x, n.y, n.level))?;
        entries.push((n.id as u64, point, n.i));
    }
    for entries in &mut entries_by_level {
        entries.sort_by_key(|&(_, _, i)| i);
    }
    let existing_by_index: HashMap<([i32; 2], u32, u32), u64> = nodes.iter()
        .map(|n| (([n.x, n.y], n.i, n.level), n.id as u64))
        .collect();
    let index_by_node: HashMap<u64, u32> = nodes.iter()
        .map(|n| (n.id as u64, n.i))
        .collect();
    let mut level_fields = entries_by_level.into_iter()
        .map(|entries| Field::<T>::from_id_points(entries.into_iter().map(|(id, p, _)| (id, p))));
    let first = level_fields.next().ok_or_else(|| "level_fields must not be empty".to_string())?;
    let mut field = MultiLevelField::new([first]);
    for level_field in level_fields {
        field.add_level(level_field);
    }
    let level_ids: Vec<maze_core::space::LevelId> = field.levels_ordered().collect();
    Ok((field, existing_by_index, index_by_node, level_ids))
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

    fn no_splits() -> HashMap<([i32; 2], u32, u32), u64> {
        HashMap::new()
    }

    fn preset_endpoint(x: i32, y: i32) -> maze_runner::config::PresetEndpointDto {
        maze_runner::config::PresetEndpointDto { point: [x, y], slot: None, level: None }
    }

    fn preset(from: (i32, i32), to: (i32, i32), state: maze_runner::config::PresetConnectionStateDto) -> PresetConnectionDto {
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
        map.insert(([1, 2], 0, 0), 99);
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0, level: 0 };
        assert_eq!(resolve_post_edit_endpoint(&ep, &map).unwrap(), 99);
    }

    #[test]
    fn resolve_post_edit_endpoint_split_missing_is_error() {
        let map = no_splits();
        let ep = PostEditEndpointDto::Split { point: [1, 2], slot_id: 0, level: 0 };
        let err = resolve_post_edit_endpoint(&ep, &map).unwrap_err();
        assert!(err.contains("slot 0"), "error should mention the offending slot, got: {err}");
    }

    #[test]
    fn resolve_post_edit_endpoint_split_disambiguates_by_level() {
        // Two levels each have their own slot 0 at the same point — the endpoint's own `level`
        // must pick the right one, not collide (GitHub issue #359).
        let mut map = no_splits();
        map.insert(([0, 0], 0, 0), 10);
        map.insert(([0, 0], 0, 1), 20);
        let ep_l0 = PostEditEndpointDto::Split { point: [0, 0], slot_id: 0, level: 0 };
        let ep_l1 = PostEditEndpointDto::Split { point: [0, 0], slot_id: 0, level: 1 };
        assert_eq!(resolve_post_edit_endpoint(&ep_l0, &map).unwrap(), 10);
        assert_eq!(resolve_post_edit_endpoint(&ep_l1, &map).unwrap(), 20);
    }

    fn xy_to_square(xy: [i32; 2]) -> Option<SquarePoint> {
        Some(SquarePoint { x: xy[0], y: xy[1] })
    }

    fn node(id: u32, x: i32, y: i32, i: u32) -> NodeDto {
        NodeDto { id, x, y, i, level: 0 }
    }

    #[test]
    fn build_field_from_nodes_preserves_given_ids_and_populates_index_maps() {
        let nodes = vec![node(10, 0, 0, 0), node(20, 1, 0, 0)];
        let (field, existing_by_index, index_by_node, level_ids) = build_field_from_nodes::<SquareTessellation>(&nodes, 1, &xy_to_square).unwrap();
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
        let (field, _, _, level_ids) = build_field_from_nodes::<SquareTessellation>(&nodes, 1, &xy_to_square).unwrap();

        assert_eq!(field.nodes_at(level_ids[0], SquarePoint { x: 0, y: 0 }), &[1, 2]);
    }

    #[test]
    fn build_field_from_nodes_rejects_a_node_outside_the_current_tessellation() {
        // xy_to_point that maps every coordinate to None -- simulates a project saved before the
        // tessellation shrank, whose stale node no longer resolves to a real point.
        let nodes = vec![node(1, 5, 5, 0)];
        let xy_to_none = |_: [i32; 2]| -> Option<SquarePoint> { None };
        let result = build_field_from_nodes::<SquareTessellation>(&nodes, 1, &xy_to_none);
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected an error for a node outside the current tessellation"),
        };
        assert!(err.contains("[5, 5]"), "error should mention the offending coordinates, got: {err}");
        assert!(err.contains('1'), "error should mention the offending node id, got: {err}");
    }

    #[test]
    fn build_field_from_nodes_rejects_a_node_referencing_an_unknown_level() {
        let mut n = node(1, 0, 0, 0);
        n.level = 3;
        let result = build_field_from_nodes::<SquareTessellation>(&[n], 1, &xy_to_square);
        let err = match result {
            Err(e) => e,
            Ok(_) => panic!("expected an error for a node referencing an unknown level"),
        };
        assert!(err.contains("level 3"), "error should mention the offending level, got: {err}");
    }

    /// GitHub issue #359: two levels, one node each at the same (x, y) — must resolve as two
    /// distinct nodes on two distinct levels, not collide into one `Field` entry.
    #[test]
    fn build_field_from_nodes_keeps_two_levels_sharing_a_point_separate() {
        let mut n0 = node(1, 0, 0, 0);
        n0.level = 0;
        let mut n1 = node(2, 0, 0, 0);
        n1.level = 1;
        let (field, _, _, level_ids) = build_field_from_nodes::<SquareTessellation>(&[n0, n1], 2, &xy_to_square).unwrap();

        assert_eq!(level_ids.len(), 2);
        assert_eq!(field.nodes_at(level_ids[0], SquarePoint { x: 0, y: 0 }), &[1]);
        assert_eq!(field.nodes_at(level_ids[1], SquarePoint { x: 0, y: 0 }), &[2]);
    }

    fn build_single_level_maze() -> (Maze<SquareTessellation>, Vec<maze_core::space::LevelId>) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let level_ids: Vec<_> = field.levels_ordered().collect();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        (Maze::new(field, g), level_ids)
    }

    #[test]
    fn apply_split_points_mints_distinct_new_nodes_when_none_exist_yet() {
        let (mut maze, level_ids) = build_single_level_maze();
        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0), ([0, 0], 1, 0), ([0, 0], 2, 0)], &no_splits(), &level_ids).unwrap();

        assert_ne!(map[&([0, 0], 0, 0)], map[&([0, 0], 1, 0)]);
        assert_ne!(map[&([0, 0], 1, 0)], map[&([0, 0], 2, 0)]);
        assert_ne!(map[&([0, 0], 0, 0)], map[&([0, 0], 2, 0)]);
    }

    /// GitHub issue #236's core fix: a slot that already has a real node (the field was rebuilt
    /// from the client's own authoritative node list via `Field::from_id_points`, matched by its
    /// real `i` — not by position) resolves to that exact same `NodeId` — no re-mint, no drift —
    /// instead of the old behavior where every call re-minted every slot from scratch in sorted
    /// order.
    #[test]
    fn apply_split_points_reuses_an_already_existing_slots_node_id() {
        let mut ids = IdGenerator::new();
        let mut field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let level_ids = vec![level];
        let p = SquarePoint { x: 0, y: 0 };
        // Simulates a field rebuilt with slot 0 already confirmed at a prior call (i = 1: slot_id
        // 0 + 1, since i = 0 is always the point's original node).
        let existing_node = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        g.add_node(existing_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let existing = HashMap::from([(([0, 0], 1u32, 0u32), existing_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0)], &existing, &level_ids).unwrap();

        assert_eq!(map[&([0, 0], 0, 0)], existing_node, "must reuse the existing node, not mint a new one");
    }

    /// One slot already exists (from a prior confirm), a second is newly added in the UI
    /// (`addSplitNode`) — the existing slot's id is reused, only the new one gets minted.
    #[test]
    fn apply_split_points_mints_only_the_newly_added_slot() {
        let mut ids = IdGenerator::new();
        let mut field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let level_ids = vec![level];
        let p = SquarePoint { x: 0, y: 0 };
        let existing_node = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        g.add_node(existing_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let existing = HashMap::from([(([0, 0], 1u32, 0u32), existing_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0), ([0, 0], 1, 0)], &existing, &level_ids).unwrap();

        assert_eq!(map[&([0, 0], 0, 0)], existing_node, "first slot reuses the pre-existing node");
        assert_ne!(map[&([0, 0], 1, 0)], existing_node, "second slot must be a freshly minted, distinct node");
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
        let mut field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let level_ids = vec![level];
        let p = SquarePoint { x: 0, y: 0 };
        let removed_node = field.add_node_at(level, p, &mut ids);
        let surviving_node = field.add_node_at(level, p, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        g.add_node(removed_node);
        g.add_node(surviving_node);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        // Only slot_id 1 (i = 2) survives in the client's node list — slot_id 0 (i = 1, the
        // removed node) is gone entirely, exactly as `removeSplitNode` leaves `state.nodes` before
        // the next confirm resends a pruned `cfg.nodes`.
        let existing = HashMap::from([(([0, 0], 2u32, 0u32), surviving_node)]);

        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 1, 0)], &existing, &level_ids).unwrap();

        assert_eq!(map[&([0, 0], 1, 0)], surviving_node,
            "the surviving slot must resolve to its own node, not the removed slot's");
    }

    /// Same set, same call — resolving `(point, slot_id, level)` twice within one
    /// `apply_split_points` output must obviously agree with itself (the actual guarantee this
    /// function makes).
    #[test]
    fn split_map_is_internally_consistent_within_one_call() {
        let (mut maze, level_ids) = build_single_level_maze();
        let map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0), ([0, 0], 1, 0)], &no_splits(), &level_ids).unwrap();

        assert_ne!(map[&([0, 0], 0, 0)], map[&([0, 0], 1, 0)], "distinct slots must resolve to distinct nodes");
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 0, 0)]));
        assert!(maze.graph.nodes().any(|n| n.id == map[&([0, 0], 1, 0)]));
    }

    #[test]
    fn apply_split_points_rejects_unknown_point() {
        let (mut maze, level_ids) = build_single_level_maze();

        let err = apply_split_points(&mut maze, xy_to_square, &[([5, 5], 0, 0)], &no_splits(), &level_ids).unwrap_err();
        assert!(err.contains("[5, 5]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn apply_split_points_rejects_unknown_level() {
        let (mut maze, level_ids) = build_single_level_maze();

        let err = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 7)], &no_splits(), &level_ids).unwrap_err();
        assert!(err.contains("level 7"), "error should mention the offending level, got: {err}");
    }

    #[test]
    fn apply_split_points_rejects_point_removed_from_field_without_panicking() {
        // xy_to_point that maps every coordinate to a Some(...) point, but the point isn't in
        // the field — must not panic (Field::add_node_at panics on an unknown point), must
        // surface as an ordinary Err instead (e.g. a project saved before the tessellation shrank).
        let (mut maze, level_ids) = build_single_level_maze();

        let err = apply_split_points(&mut maze, xy_to_square, &[([9, 9], 0, 0)], &no_splits(), &level_ids).unwrap_err();
        assert!(err.contains("[9, 9]"), "error should mention the offending point, got: {err}");
    }

    #[test]
    fn build_graph_from_post_edit_edges_accepts_split_endpoints_end_to_end() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let level_ids: Vec<_> = field.levels_ordered().collect();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).first().copied().unwrap();

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0)], &no_splits(), &level_ids).unwrap();
        let split_node = split_map[&([0, 0], 0, 0)];

        let edges = vec![PostEditEdgeDto {
            from: PostEditEndpointDto::Node { id: a as u32 },
            to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0, level: 0 },
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
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let level_ids: Vec<_> = field.levels_ordered().collect();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        let a = maze.field.nodes_at(maze.field.single_level_id(), SquarePoint { x: 0, y: 0 }).first().copied().unwrap();
        let b = maze.field.nodes_at(maze.field.single_level_id(), SquarePoint { x: 1, y: 0 }).first().copied().unwrap();
        // No edge at all between a and b — the direct passage is walled off.

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0)], &no_splits(), &level_ids).unwrap();
        let split_node = split_map[&([0, 0], 0, 0)];

        let edges = vec![
            PostEditEdgeDto {
                from: PostEditEndpointDto::Node { id: a as u32 },
                to: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0, level: 0 },
                kind: "basic".to_string(),
            },
            PostEditEdgeDto {
                from: PostEditEndpointDto::Split { point: [0, 0], slot_id: 0, level: 0 },
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

    /// GitHub issue #359 end-to-end regression: two floors sharing the same (x, y) must not
    /// collide — each level's own node resolves independently, and an edge on one level never
    /// reaches the other level's node at the same point.
    #[test]
    fn two_levels_sharing_a_point_resolve_to_independent_nodes() {
        let n0 = node(1, 0, 0, 0);
        let mut n1 = node(2, 0, 0, 0);
        n1.level = 1;
        let (field, existing_by_index, _, level_ids) = build_field_from_nodes::<SquareTessellation>(&[n0, n1], 2, &xy_to_square).unwrap();
        let mut g = Graph::new();
        for id in field.all_node_ids() { g.add_node(id); }
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);

        let split_map = apply_split_points(&mut maze, xy_to_square, &[([0, 0], 0, 0), ([0, 0], 0, 1)], &existing_by_index, &level_ids).unwrap();
        let l0_split = split_map[&([0, 0], 0, 0)];
        let l1_split = split_map[&([0, 0], 0, 1)];

        assert_ne!(l0_split, l1_split, "the two levels' slot-0 split nodes must be distinct");
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

        fn existing(entries: &[(([i32; 2], u32, u32), u64)]) -> HashMap<([i32; 2], u32, u32), u64> {
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
            let presets = vec![preset((0, 0), (1, 0), PresetConnectionStateDto::OneWayForward)];

            let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &no_splits());

            assert!(edges.contains(&(1, 2)));
            assert!(!edges.contains(&(2, 1)), "the blocked reverse direction must never resolve as a preset edge");
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
                to: maze_runner::config::PresetEndpointDto { point: [1, 0], slot: Some(0), level: None },
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
                from: maze_runner::config::PresetEndpointDto { point: [0, 0], slot: Some(0), level: Some(1) },
                to: maze_runner::config::PresetEndpointDto { point: [0, 0], slot: Some(0), level: None },
                state: PresetConnectionStateDto::OneWayForward,
            }];

            let edges = preset_edges_for_post_edit(&presets, &existing_by_index, &split_map);

            assert!(edges.contains(&(20, 10)), "level-1 endpoint must resolve to the level-1 node, level-0(default) to the level-0 node");
        }
    }

    mod resolve_preset_nodes_for_post_edit_tests {
        use super::*;

        fn existing(entries: &[(([i32; 2], u32, u32), u64)]) -> HashMap<([i32; 2], u32, u32), u64> {
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
            let nodes = resolve_preset_nodes_for_post_edit(&[([9, 9], 0, 0)], &no_splits(), &no_splits());
            assert!(nodes.is_empty());
        }
    }
}
