use crate::dto::{PostEditEdgeDto, PostEditEndpointDto, VerticalEdgeDto};
use crate::generation_config::PresetConnectionDto;
use maze_core::{
    Maze,
    graph::{EdgeKind, Graph},
    space::Tessellation,
    space::{Field, MultiLevelField},
};
use std::collections::{HashMap, HashSet};

/// Split-tile slot map: `(point, slot_id, level)` -> resolved `NodeId` (as `u64`).
pub(crate) type SplitSlotMap = HashMap<([i32; 2], u32, u32), u64>;

/// `build_field_from_nodes`'s result: the assembled field, the split-slot map built from `nodes`,
/// each node's degree, and the `level_fields` index -> real `LevelId` mapping.
pub(crate) type BuildFieldFromNodesResult<T> = Result<
    (
        MultiLevelField<T>,
        SplitSlotMap,
        HashMap<u64, u32>,
        Vec<maze_core::space::LevelId>,
    ),
    String,
>;

/// Resolves one `PostEditEndpointDto` to a real `NodeId` (as `u64`). `Node` passes through as-is;
/// `Split` looks up `(point, slot_id, level)` in `split_map` (built by `apply_split_points`) — `Err`
/// if absent, meaning the edge list and `split_points` disagree about which slots exist (a caller
/// bug, not a panic-worthy invariant violation, so it's a `Result` like every other malformed-
/// input case on this path).
pub(crate) fn resolve_post_edit_endpoint(
    ep: &PostEditEndpointDto,
    split_map: &SplitSlotMap,
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
    split_map: &SplitSlotMap,
) -> Result<(), String> {
    for e in edges {
        let from_id = resolve_post_edit_endpoint(&e.from, split_map)?;
        let to_id = resolve_post_edit_endpoint(&e.to, split_map)?;
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

/// Re-adds `VerticalPassage`/`Elevator` edges into `graph` verbatim (GitHub issue #358 follow-up)
/// — see `VerticalEdgeDto`'s own doc comment for why these need a separate pass-through instead of
/// going through `build_graph_from_post_edit_edges`: post-edit never edits either kind, so there is
/// no tool-driven draft, only the previous snapshot's own edges resent unchanged. Endpoints are
/// plain `NodeId`s already (no `Split` resolution needed — neither kind is ever wired to a split
/// slot); a `from`/`to` that no longer exists in `graph` (e.g. its node was pruned by a removed
/// split slot) is silently skipped rather than erroring, since that is a stale edge referencing a
/// node the client itself already dropped, not a caller bug.
pub(crate) fn restore_vertical_edges(graph: &mut Graph, edges: &[VerticalEdgeDto]) {
    let node_ids: HashSet<u64> = graph.nodes().map(|n| n.id).collect();
    for e in edges {
        let (from, to) = (e.from as u64, e.to as u64);
        if !node_ids.contains(&from) || !node_ids.contains(&to) {
            continue;
        }
        match e.kind.as_str() {
            "vertical_passage" => {
                graph.build_initial_edge(from, to, EdgeKind::VerticalPassage);
            }
            "elevator" => {
                graph.build_initial_edge(from, to, EdgeKind::Elevator);
            }
            _ => continue,
        }
    }
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
    existing_by_index: &SplitSlotMap,
    level_ids: &[maze_core::space::LevelId],
) -> Result<SplitSlotMap, String> {
    let mut map = HashMap::new();
    for &(xy, slot_id, level_index) in split_points {
        let node = match existing_by_index.get(&(xy, slot_id + 1, level_index)) {
            Some(&id) => id,
            None => {
                let &level = level_ids.get(level_index as usize).ok_or_else(|| {
                    format!("split_points references unknown level {level_index}")
                })?;
                let point = xy_to_point(xy)
                    .filter(|&p| maze.field.field_of(level).is_some_and(|f| f.contains(p)))
                    .ok_or_else(|| {
                        format!(
                            "split_points references unknown point {xy:?} on level {level_index}"
                        )
                    })?;
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
pub(crate) fn resolve_preset_endpoint_for_post_edit(
    ep: &maze_runner::config::PresetEndpointDto,
    existing_by_index: &SplitSlotMap,
    split_map: &SplitSlotMap,
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
    existing_by_index: &SplitSlotMap,
    split_map: &SplitSlotMap,
) -> HashSet<(u64, u64)> {
    let mut preset_edges = HashSet::new();
    for preset in preset_connections {
        let (Some(from_id), Some(to_id)) = (
            resolve_preset_endpoint_for_post_edit(&preset.from, existing_by_index, split_map),
            resolve_preset_endpoint_for_post_edit(&preset.to, existing_by_index, split_map),
        ) else {
            continue;
        };
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
    existing_by_index: &SplitSlotMap,
    split_map: &SplitSlotMap,
) -> HashSet<u64> {
    preset_split_points
        .iter()
        .filter_map(|&(point, slot, level)| {
            split_map
                .get(&(point, slot, level))
                .or_else(|| existing_by_index.get(&(point, slot + 1, level)))
                .copied()
        })
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
) -> BuildFieldFromNodesResult<T>
where
    T::Point: Copy,
{
    let mut entries_by_level: Vec<Vec<(u64, T::Point, u32)>> = vec![Vec::new(); level_field_count];
    for n in nodes {
        let entries = entries_by_level
            .get_mut(n.level as usize)
            .ok_or_else(|| format!("node {} references unknown level {}", n.id, n.level))?;
        let point = xy_to_point([n.x, n.y]).ok_or_else(|| {
            format!(
                "node {} references a point outside the current tessellation: [{}, {}] (level {})",
                n.id, n.x, n.y, n.level
            )
        })?;
        entries.push((n.id as u64, point, n.i));
    }
    for entries in &mut entries_by_level {
        entries.sort_by_key(|&(_, _, i)| i);
    }
    let existing_by_index: SplitSlotMap = nodes
        .iter()
        .map(|n| (([n.x, n.y], n.i, n.level), n.id as u64))
        .collect();
    let index_by_node: HashMap<u64, u32> = nodes.iter().map(|n| (n.id as u64, n.i)).collect();
    let mut level_fields = entries_by_level
        .into_iter()
        .map(|entries| Field::<T>::from_id_points(entries.into_iter().map(|(id, p, _)| (id, p))));
    let first = level_fields
        .next()
        .ok_or_else(|| "level_fields must not be empty".to_string())?;
    let mut field = MultiLevelField::new([first]);
    for level_field in level_fields {
        field.add_level(level_field);
    }
    let level_ids: Vec<maze_core::space::LevelId> = field.levels_ordered().collect();
    Ok((field, existing_by_index, index_by_node, level_ids))
}

#[cfg(test)]
#[path = "post_edit_tests.rs"]
mod tests;
