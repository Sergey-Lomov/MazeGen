use super::classify::{GeometricNodeClass, classify_node};
use crate::graph::Graph;
use crate::ids::NodeId;
use crate::space::{LevelId, MultiLevelField, Tessellation};
use std::collections::HashSet;

/// Whether `node` belongs to the floor `stats.rs`'s per-floor functions are restricted to —
/// `level` of `None` means "maze-wide, no restriction" (every existing single-floor call site).
fn in_scope<T: Tessellation>(
    field: &MultiLevelField<T>,
    node: NodeId,
    level: Option<LevelId>,
) -> bool {
    level.is_none_or(|l| field.level_of(node) == Some(l))
}

pub struct GeometricNodeStats {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<(usize, usize)>, // (degree, count), sorted by degree
    // Distinct nodes that are the destination of at least one `EdgeKind::Teleport` edge — a
    // two-way teleport pair counts both ends, each being the other's destination. Not part of
    // the dead_ends/straight/turns/junctions partition (a node can be both a teleport entry and
    // e.g. a junction), so not included in that sum invariant.
    pub teleport_entries: usize,
}

// Spatial edge statistics. Walls are a spatial concept (adjacent node pair with no edge),
// not a graph property. Computed via field neighbors, not graph edges alone.
pub struct SpatialEdgeStats {
    pub bidirectional: usize,
    pub one_way_passages: usize,
    pub walls: usize,
    /// Total adjacent tile-pair count (`bidirectional + one_way_passages + walls`), computed
    /// directly from `adjacency_pairs` rather than summed from the other fields — stays correct
    /// if a future edge category is added without also updating every summation site.
    pub total_pairs: usize,
}

// Teleport edge statistics — teleports link non-adjacent tiles, so they fall outside
// `adjacency_pairs` and need their own pairing pass over `EdgeKind::Teleport` edges.
pub struct TeleportEdgeStats {
    pub two_way: usize,
    pub one_way: usize,
}

// `VerticalPassage`/`Elevator`/cross-floor-`Teleport` statistics — maze-wide only (GitHub issue
// #346): every one of these edge kinds spans 2+ floors by construction, so there is no meaningful
// single-floor attribution (unlike `TeleportEdgeStats`, which has same-floor pairs too).
pub struct VerticalStats {
    pub bidirectional_passages: usize,
    pub one_way_passages_up: usize,
    pub one_way_passages_down: usize,
    /// Count of distinct `Elevator` groups — see `Graph::elevator_groups`'s own doc comment for
    /// what defines a group (connected component, not shared x-y point).
    pub elevator_groups: usize,
    /// Sum of stop counts (nodes) over every `Elevator` group — GitHub issue #436.
    pub elevator_stop_count: usize,
    /// `elevator_stop_count as f64 / elevator_groups as f64` — `0.0` when there are no elevators
    /// (GitHub issue #436).
    pub average_elevator_stops: f64,
    /// `Teleport` pairs (mirrors `TeleportEdgeStats`'s pairing) whose two ends are on different
    /// floors.
    pub cross_floor_teleports: usize,
}

pub fn compute_node_stats<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> GeometricNodeStats {
    compute_node_stats_scoped(graph, field, None)
}

/// Same as `compute_node_stats`, restricted to `level`'s own floor when `Some` — a node counts
/// only if it belongs to `level`; a `Teleport` edge counts toward `teleport_entries` only if its
/// destination is on `level` too (GitHub issue #364: a cross-floor teleport target isn't "this
/// floor's" teleport entry, mirrors `compute_spatial_edge_stats_scoped`'s own edge-scoping rule).
pub fn compute_node_stats_scoped<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    level: Option<LevelId>,
) -> GeometricNodeStats {
    let mut dead_ends = 0usize;
    let mut straight = 0usize;
    let mut turns = 0usize;
    let mut junction_map: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut node_count = 0usize;

    for node in graph.nodes() {
        if !in_scope(field, node.id, level) {
            continue;
        }
        node_count += 1;
        match classify_node(graph, node.id, field) {
            GeometricNodeClass::DeadEnd => dead_ends += 1,
            GeometricNodeClass::Straight => straight += 1,
            GeometricNodeClass::Turn => turns += 1,
            GeometricNodeClass::Junction(n) => *junction_map.entry(n).or_insert(0) += 1,
        }
    }

    let mut junctions: Vec<(usize, usize)> = junction_map.into_iter().collect();
    junctions.sort_unstable_by_key(|&(deg, _)| deg);

    let teleport_entries: HashSet<NodeId> = graph
        .edges()
        .filter(|e| e.kind == super::EdgeKind::Teleport && in_scope(field, e.to, level))
        .map(|e| e.to)
        .collect();

    let stats = GeometricNodeStats {
        dead_ends,
        straight,
        turns,
        junctions,
        teleport_entries: teleport_entries.len(),
    };

    debug_assert!(
        stats.dead_ends
            + stats.straight
            + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>()
            == node_count
    );

    stats
}

/// `field.neighbors` is purely spatial adjacency (same tessellation face), which never crosses a
/// floor boundary by construction — `VerticalPassage`/`Elevator` are graph edges, not field
/// adjacency — so restricting to `level` only needs to check one endpoint.
fn adjacency_pairs<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    level: Option<LevelId>,
) -> Vec<(NodeId, NodeId)> {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut pairs = Vec::new();
    for node in graph.nodes() {
        if !in_scope(field, node.id, level) {
            continue;
        }
        for neighbor in field.neighbors(node.id) {
            let pair = if node.id < neighbor {
                (node.id, neighbor)
            } else {
                (neighbor, node.id)
            };
            if seen.insert(pair) {
                pairs.push(pair);
            }
        }
    }
    pairs
}

pub fn compute_spatial_edge_stats<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> SpatialEdgeStats {
    compute_spatial_edge_stats_scoped(graph, field, None)
}

/// Same as `compute_spatial_edge_stats`, restricted to `level`'s own floor when `Some`.
pub fn compute_spatial_edge_stats_scoped<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    level: Option<LevelId>,
) -> SpatialEdgeStats {
    let pairs = adjacency_pairs(graph, field, level);
    let total = pairs.len();
    let mut bidirectional = 0usize;
    let mut one_way_passages = 0usize;
    let mut walls = 0usize;

    for (a, b) in &pairs {
        let ab = graph.edge_between(*a, *b).is_some();
        let ba = graph.edge_between(*b, *a).is_some();
        match (ab, ba) {
            (true, true) => bidirectional += 1,
            (false, false) => walls += 1,
            _ => one_way_passages += 1,
        }
    }

    debug_assert!(bidirectional + one_way_passages + walls == total);

    SpatialEdgeStats {
        bidirectional,
        one_way_passages,
        walls,
        total_pairs: total,
    }
}

pub fn compute_teleport_edge_stats(graph: &Graph) -> TeleportEdgeStats {
    compute_teleport_edge_stats_impl(graph, |_, _| true)
}

/// Same as `compute_teleport_edge_stats`, restricted to `level`'s own floor — a teleport pair
/// counts only if *both* ends are on `level` (GitHub issue #364: a cross-floor teleport is
/// excluded from either floor's own count entirely, not attributed to one side).
pub fn compute_teleport_edge_stats_scoped<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
    level: LevelId,
) -> TeleportEdgeStats {
    compute_teleport_edge_stats_impl(graph, |a, b| {
        in_scope(field, a, Some(level)) && in_scope(field, b, Some(level))
    })
}

fn compute_teleport_edge_stats_impl(
    graph: &Graph,
    in_scope_edge: impl Fn(NodeId, NodeId) -> bool,
) -> TeleportEdgeStats {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut two_way = 0usize;
    let mut one_way = 0usize;

    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::Teleport || !in_scope_edge(edge.from, edge.to) {
            continue;
        }
        let pair = if edge.from < edge.to {
            (edge.from, edge.to)
        } else {
            (edge.to, edge.from)
        };
        if !seen.insert(pair) {
            continue;
        }
        let reverse = graph
            .edge_between_kind(edge.to, edge.from, &super::EdgeKind::Teleport)
            .is_some();
        if reverse {
            two_way += 1;
        } else {
            one_way += 1;
        }
    }

    TeleportEdgeStats { two_way, one_way }
}

/// Maze-wide `VerticalPassage`/`Elevator`/cross-floor-`Teleport` statistics — see `VerticalStats`.
pub fn compute_vertical_stats<T: Tessellation>(
    graph: &Graph,
    field: &MultiLevelField<T>,
) -> VerticalStats {
    let mut seen_passage_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut bidirectional_passages = 0usize;
    let mut one_way_passages_up = 0usize;
    let mut one_way_passages_down = 0usize;

    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::VerticalPassage {
            continue;
        }
        let pair = if edge.from < edge.to {
            (edge.from, edge.to)
        } else {
            (edge.to, edge.from)
        };
        if !seen_passage_pairs.insert(pair) {
            continue;
        }
        let reverse = graph
            .edge_between_kind(edge.to, edge.from, &super::EdgeKind::VerticalPassage)
            .is_some();
        if reverse {
            bidirectional_passages += 1;
        } else {
            let from_idx = field.level_index_of(edge.from);
            let to_idx = field.level_index_of(edge.to);
            match (from_idx, to_idx) {
                (Some(f), Some(t)) if f < t => one_way_passages_up += 1,
                (Some(_), Some(_)) => one_way_passages_down += 1,
                _ => {}
            }
        }
    }

    let elevator_group_list = graph.elevator_groups();
    let elevator_groups = elevator_group_list.len();
    let elevator_stop_count: usize = elevator_group_list.iter().map(|g| g.len()).sum();
    let average_elevator_stops = if elevator_groups == 0 {
        0.0
    } else {
        elevator_stop_count as f64 / elevator_groups as f64
    };

    let mut seen_teleport_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut cross_floor_teleports = 0usize;
    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::Teleport
            || field.level_of(edge.from) == field.level_of(edge.to)
        {
            continue;
        }
        let pair = if edge.from < edge.to {
            (edge.from, edge.to)
        } else {
            (edge.to, edge.from)
        };
        if seen_teleport_pairs.insert(pair) {
            cross_floor_teleports += 1;
        }
    }

    VerticalStats {
        bidirectional_passages,
        one_way_passages_up,
        one_way_passages_down,
        elevator_groups,
        elevator_stop_count,
        average_elevator_stops,
        cross_floor_teleports,
    }
}

/// Per-floor elevator stop count — unlike the rest of `VerticalStats`, a single elevator stop
/// (one node) *does* belong to exactly one floor, so this is meaningful `by_floor` (GitHub issue
/// #436). A floor's count is however still computed independently of `VerticalStats`'
/// maze-wide `elevator_stop_count` (not a partition of it) — mirrors `FloorScoped`'s own
/// total-is-not-a-sum-of-by_floor convention.
///
/// Takes `elevator_groups` (the caller's own `Graph::elevator_groups()` result) rather than
/// recomputing it — that's a union-find pass over every `Elevator` edge, not worth repeating once
/// per floor when a caller needs several floors' counts from the same snapshot.
pub fn compute_elevator_stop_count_scoped<T: Tessellation>(
    elevator_groups: &[HashSet<NodeId>],
    field: &MultiLevelField<T>,
    level: LevelId,
) -> usize {
    elevator_groups
        .iter()
        .flat_map(|group| group.iter())
        .filter(|&&node| in_scope(field, node, Some(level)))
        .count()
}

/// Average out-degree over the real graph (not the compressed nav-graph): `2*E/V` treated as
/// undirected — a bidirectional edge pair between two nodes counts as one connection per node, an
/// unpaired one-way edge counts once for its source. `0.0` for an empty graph.
pub fn average_degree(graph: &Graph) -> f64 {
    let node_count = graph.node_count();
    if node_count == 0 {
        return 0.0;
    }
    let total_degree: usize = graph
        .nodes()
        .map(|n| crate::graph::classify::unique_neighbors(graph, n.id).len())
        .sum();
    total_degree as f64 / node_count as f64
}

#[cfg(test)]
#[path = "stats_tests.rs"]
mod tests;
