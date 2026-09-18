use crate::Graph;
use crate::ids::{EdgeId, NodeId};
use crate::space::{LevelId, MultiLevelField, Tessellation};
use std::collections::HashSet;

/// Floors touched by a single edge's endpoints — both endpoints' own floors, deduped. A same-floor
/// edge yields exactly one `LevelId`; a cross-floor edge (e.g. a teleport between floors) yields
/// two, so `FloorScope::PerFloor` counts it toward both floors' own tally (GitHub issue #369).
pub fn floors_of_edge<T: Tessellation>(
    field: &MultiLevelField<T>,
    graph: &Graph,
    edge: EdgeId,
) -> HashSet<LevelId> {
    let mut floors = HashSet::new();
    if let Some(e) = graph.edge(edge) {
        floors.extend(field.level_of(e.from));
        floors.extend(field.level_of(e.to));
    }
    floors
}

/// Floors touched by any edge in `edges` — union of `floors_of_edge` over the whole slice. Used to
/// assign a cycle/route/group of edges to every floor it has a foothold on.
pub fn floors_of_edges<T: Tessellation>(
    field: &MultiLevelField<T>,
    graph: &Graph,
    edges: &[EdgeId],
) -> HashSet<LevelId> {
    edges
        .iter()
        .flat_map(|&e| floors_of_edge(field, graph, e))
        .collect()
}

/// Floors touched by a single node.
pub fn floors_of_node<T: Tessellation>(
    field: &MultiLevelField<T>,
    node: NodeId,
) -> HashSet<LevelId> {
    field.level_of(node).into_iter().collect()
}

/// Number of field cells (tiles) on `level` — the per-floor denominator for a density check under
/// `FloorScope::PerFloor`, mirroring `Field::point_count()`'s whole-maze role.
pub fn floor_point_count<T: Tessellation>(field: &MultiLevelField<T>, level: LevelId) -> usize {
    field.field_of(level).map(|f| f.point_count()).unwrap_or(0)
}
