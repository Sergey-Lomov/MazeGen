use std::collections::{HashMap, HashSet};
use crate::ids::NodeId;
use crate::space::{LevelId, MultiLevelField, Tessellation};
use crate::graph::Graph;
use super::classify::{GeometricNodeClass, classify_node};

/// Whether `node` belongs to the floor `stats.rs`'s per-floor functions are restricted to —
/// `level` of `None` means "maze-wide, no restriction" (every existing single-floor call site).
fn in_scope<T: Tessellation>(field: &MultiLevelField<T>, node: NodeId, level: Option<LevelId>) -> bool {
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
    /// `Teleport` pairs (mirrors `TeleportEdgeStats`'s pairing) whose two ends are on different
    /// floors.
    pub cross_floor_teleports: usize,
}

pub fn compute_node_stats<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> GeometricNodeStats {
    compute_node_stats_scoped(graph, field, None)
}

/// Same as `compute_node_stats`, restricted to `level`'s own floor when `Some` — a node counts
/// only if it belongs to `level`; a `Teleport` edge counts toward `teleport_entries` only if its
/// destination is on `level` too (GitHub issue #364: a cross-floor teleport target isn't "this
/// floor's" teleport entry, mirrors `compute_spatial_edge_stats_scoped`'s own edge-scoping rule).
pub fn compute_node_stats_scoped<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>, level: Option<LevelId>) -> GeometricNodeStats {
    let mut dead_ends = 0usize;
    let mut straight = 0usize;
    let mut turns = 0usize;
    let mut junction_map: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
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

    let teleport_entries: HashSet<NodeId> = graph.edges()
        .filter(|e| e.kind == super::EdgeKind::Teleport && in_scope(field, e.to, level))
        .map(|e| e.to)
        .collect();

    let stats = GeometricNodeStats { dead_ends, straight, turns, junctions, teleport_entries: teleport_entries.len() };

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
fn adjacency_pairs<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>, level: Option<LevelId>) -> Vec<(NodeId, NodeId)> {
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

pub fn compute_spatial_edge_stats<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> SpatialEdgeStats {
    compute_spatial_edge_stats_scoped(graph, field, None)
}

/// Same as `compute_spatial_edge_stats`, restricted to `level`'s own floor when `Some`.
pub fn compute_spatial_edge_stats_scoped<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>, level: Option<LevelId>) -> SpatialEdgeStats {
    let pairs = adjacency_pairs(graph, field, level);
    let total = pairs.len();
    let mut bidirectional = 0usize;
    let mut one_way_passages = 0usize;
    let mut walls = 0usize;

    for (a, b) in &pairs {
        let ab = graph.edge_between(*a, *b).is_some();
        let ba = graph.edge_between(*b, *a).is_some();
        match (ab, ba) {
            (true, true)   => bidirectional += 1,
            (false, false) => walls += 1,
            _              => one_way_passages += 1,
        }
    }

    debug_assert!(bidirectional + one_way_passages + walls == total);

    SpatialEdgeStats { bidirectional, one_way_passages, walls, total_pairs: total }
}

pub fn compute_teleport_edge_stats(graph: &Graph) -> TeleportEdgeStats {
    compute_teleport_edge_stats_impl(graph, |_, _| true)
}

/// Same as `compute_teleport_edge_stats`, restricted to `level`'s own floor — a teleport pair
/// counts only if *both* ends are on `level` (GitHub issue #364: a cross-floor teleport is
/// excluded from either floor's own count entirely, not attributed to one side).
pub fn compute_teleport_edge_stats_scoped<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>, level: LevelId) -> TeleportEdgeStats {
    compute_teleport_edge_stats_impl(graph, |a, b| in_scope(field, a, Some(level)) && in_scope(field, b, Some(level)))
}

fn compute_teleport_edge_stats_impl(graph: &Graph, in_scope_edge: impl Fn(NodeId, NodeId) -> bool) -> TeleportEdgeStats {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut two_way = 0usize;
    let mut one_way = 0usize;

    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::Teleport || !in_scope_edge(edge.from, edge.to) {
            continue;
        }
        let pair = if edge.from < edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if !seen.insert(pair) {
            continue;
        }
        let reverse = graph.edge_between_kind(edge.to, edge.from, &super::EdgeKind::Teleport).is_some();
        if reverse {
            two_way += 1;
        } else {
            one_way += 1;
        }
    }

    TeleportEdgeStats { two_way, one_way }
}

/// Maze-wide `VerticalPassage`/`Elevator`/cross-floor-`Teleport` statistics — see `VerticalStats`.
pub fn compute_vertical_stats<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> VerticalStats {
    let mut seen_passage_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut bidirectional_passages = 0usize;
    let mut one_way_passages_up = 0usize;
    let mut one_way_passages_down = 0usize;

    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::VerticalPassage {
            continue;
        }
        let pair = if edge.from < edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if !seen_passage_pairs.insert(pair) {
            continue;
        }
        let reverse = graph.edge_between_kind(edge.to, edge.from, &super::EdgeKind::VerticalPassage).is_some();
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

    let elevator_groups = graph.elevator_groups().len();

    let mut seen_teleport_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut cross_floor_teleports = 0usize;
    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::Teleport || field.level_of(edge.from) == field.level_of(edge.to) {
            continue;
        }
        let pair = if edge.from < edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if seen_teleport_pairs.insert(pair) {
            cross_floor_teleports += 1;
        }
    }

    VerticalStats {
        bidirectional_passages,
        one_way_passages_up,
        one_way_passages_down,
        elevator_groups,
        cross_floor_teleports,
    }
}

/// Average out-degree over the real graph (not the compressed nav-graph): `2*E/V` treated as
/// undirected — a bidirectional edge pair between two nodes counts as one connection per node, an
/// unpaired one-way edge counts once for its source. `0.0` for an empty graph.
pub fn average_degree(graph: &Graph) -> f64 {
    let node_count = graph.node_count();
    if node_count == 0 {
        return 0.0;
    }
    let total_degree: usize = graph.nodes()
        .map(|n| crate::graph::classify::unique_neighbors(graph, n.id).len())
        .sum();
    total_degree as f64 / node_count as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

    /// Two independent `w`x`h` floors, no cross-floor edges wired — callers add those themselves.
    fn make_two_level_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph, LevelId, LevelId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let level0 = field.single_level_id();
        let level1 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph, level0, level1)
    }

    fn make_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph)
    }

    fn node_at(field: &MultiLevelField<SquareTessellation>, x: i32, y: i32) -> NodeId {
        let level = field.single_level_id();
        field.node_at(level, SquarePoint { x, y }).unwrap()
    }

    fn node_at_level(field: &MultiLevelField<SquareTessellation>, level: LevelId, x: i32, y: i32) -> NodeId {
        field.node_at(level, SquarePoint { x, y }).unwrap()
    }

    #[test]
    fn compute_node_stats_empty_graph_no_edges_all_dead_ends() {
        let (field, graph) = make_field_and_graph(3, 1);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.dead_ends, 3);
        assert_eq!(stats.straight, 0);
        assert_eq!(stats.turns, 0);
        assert!(stats.junctions.is_empty());
        assert_eq!(stats.teleport_entries, 0);
    }

    #[test]
    fn compute_node_stats_teleport_entries_one_way() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 1, "only b is a teleport destination");
    }

    #[test]
    fn compute_node_stats_teleport_entries_two_way_counts_both_ends() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        graph.add_edge(b, a, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 2, "both a and b are destinations of a two-way teleport");
    }

    #[test]
    fn compute_node_stats_teleport_entries_dedups_multiple_incoming_to_same_node() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        let c = node_at(&field, 3, 0);
        graph.add_edge(a, c, EdgeKind::Teleport);
        graph.add_edge(b, c, EdgeKind::Teleport);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.teleport_entries, 1, "c counted once despite two incoming teleports");
    }

    #[test]
    fn compute_node_stats_counts_match_node_count() {
        let (field, mut graph) = make_field_and_graph(3, 2);
        let center = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let right = node_at(&field, 2, 0);
        let down = node_at(&field, 1, 1);
        graph.add_edge(center, left, EdgeKind::Basic);
        graph.add_edge(center, right, EdgeKind::Basic);
        graph.add_edge(center, down, EdgeKind::Basic);
        let stats = compute_node_stats(&graph, &field);
        let total = stats.dead_ends + stats.straight + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>();
        assert_eq!(total, graph.node_count());
    }

    #[test]
    fn compute_node_stats_counts_a_turn() {
        // Corner of a 2x2 grid: (1,0)'s two neighbors (0,0) and (1,1) form a right angle.
        let (field, mut graph) = make_field_and_graph(2, 2);
        let corner = node_at(&field, 1, 0);
        let left = node_at(&field, 0, 0);
        let down = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(corner, left, EdgeKind::Basic);
        graph.add_bidirectional_edge(corner, down, EdgeKind::Basic);
        let stats = compute_node_stats(&graph, &field);
        assert_eq!(stats.turns, 1);
    }

    #[test]
    fn compute_node_stats_junctions_grouped_and_sorted_by_degree() {
        // Two distinct junction degrees present: one 3-way, one 4-way.
        let (field, mut graph) = make_field_and_graph(3, 3);
        let three_way = node_at(&field, 0, 1); // edge node: up/down/right = 3 neighbors max
        graph.add_bidirectional_edge(three_way, node_at(&field, 0, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(three_way, node_at(&field, 0, 2), EdgeKind::Basic);
        graph.add_bidirectional_edge(three_way, node_at(&field, 1, 1), EdgeKind::Basic);

        let four_way = node_at(&field, 1, 1);
        graph.add_bidirectional_edge(four_way, node_at(&field, 0, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 2, 1), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 1, 0), EdgeKind::Basic);
        graph.add_bidirectional_edge(four_way, node_at(&field, 1, 2), EdgeKind::Basic);

        let stats = compute_node_stats(&graph, &field);
        let degrees: Vec<usize> = stats.junctions.iter().map(|&(deg, _)| deg).collect();
        let mut sorted = degrees.clone();
        sorted.sort_unstable();
        assert_eq!(degrees, sorted, "junctions must be sorted by degree");
        assert!(degrees.contains(&3));
        assert!(degrees.contains(&4));
    }

    #[test]
    fn compute_spatial_edge_stats_no_edges_all_walls() {
        let (field, graph) = make_field_and_graph(2, 1);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.walls, 1, "single adjacent pair, no edges -> 1 wall");
        assert_eq!(stats.bidirectional, 0);
        assert_eq!(stats.one_way_passages, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_bidirectional_edge() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.bidirectional, 1);
        assert_eq!(stats.walls, 0);
        assert_eq!(stats.one_way_passages, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_one_way_edge() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.one_way_passages, 1);
        assert_eq!(stats.bidirectional, 0);
        assert_eq!(stats.walls, 0);
    }

    #[test]
    fn compute_spatial_edge_stats_total_matches_adjacency_pair_count() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        // (1,0)-(2,0) stays a wall.
        let stats = compute_spatial_edge_stats(&graph, &field);
        assert_eq!(stats.total_pairs, 2, "3x1 field has 2 adjacent pairs");
        assert_eq!(stats.bidirectional + stats.one_way_passages + stats.walls, stats.total_pairs);
        assert_eq!(stats.bidirectional, 1);
        assert_eq!(stats.walls, 1);
    }

    #[test]
    fn adjacency_pairs_does_not_double_count_symmetric_neighbors() {
        let (field, graph) = make_field_and_graph(2, 1);
        let pairs = adjacency_pairs(&graph, &field, None);
        assert_eq!(pairs.len(), 1, "one adjacent pair, not counted twice from each direction");
    }

    #[test]
    fn compute_teleport_edge_stats_no_teleports() {
        let (_, graph) = make_field_and_graph(3, 1);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 0);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_two_way_pair() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        graph.add_edge(b, a, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 1);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_one_way_pair() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 3, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.one_way, 1);
        assert_eq!(stats.two_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_ignores_basic_edges() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Basic);
        graph.add_edge(b, a, EdgeKind::Basic);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 0);
        assert_eq!(stats.one_way, 0);
    }

    #[test]
    fn compute_teleport_edge_stats_counts_multiple_pairs() {
        let (field, mut graph) = make_field_and_graph(4, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        let c = node_at(&field, 2, 0);
        let d = node_at(&field, 3, 0);
        graph.add_edge(a, d, EdgeKind::Teleport);
        graph.add_edge(d, a, EdgeKind::Teleport);
        graph.add_edge(b, c, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats(&graph);
        assert_eq!(stats.two_way, 1);
        assert_eq!(stats.one_way, 1);
    }

    #[test]
    fn compute_node_stats_scoped_counts_only_the_given_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(3, 1);
        // level0: a-b-c chain (a and c are dead ends, b is straight).
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        let c0 = node_at_level(&field, level0, 2, 0);
        graph.add_bidirectional_edge(a0, b0, EdgeKind::Basic);
        graph.add_bidirectional_edge(b0, c0, EdgeKind::Basic);
        // level1: left untouched, all 3 nodes stay dead ends.
        let stats0 = compute_node_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.dead_ends, 2);
        assert_eq!(stats0.straight, 1);
        let stats1 = compute_node_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.dead_ends, 3);
        assert_eq!(stats1.straight, 0);
    }

    #[test]
    fn compute_node_stats_scoped_teleport_entry_excluded_when_destination_on_other_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        let stats0 = compute_node_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.teleport_entries, 0, "teleport destination is on level1, not level0");
        let stats1 = compute_node_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.teleport_entries, 1, "b1 is the teleport's destination, on level1");
    }

    #[test]
    fn compute_spatial_edge_stats_scoped_counts_only_the_given_floor() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        graph.add_edge(a0, b0, EdgeKind::Basic);
        graph.add_edge(b0, a0, EdgeKind::Basic);
        // level1's only adjacent pair stays a wall.
        let stats0 = compute_spatial_edge_stats_scoped(&graph, &field, Some(level0));
        assert_eq!(stats0.bidirectional, 1);
        assert_eq!(stats0.walls, 0);
        let stats1 = compute_spatial_edge_stats_scoped(&graph, &field, Some(level1));
        assert_eq!(stats1.bidirectional, 0);
        assert_eq!(stats1.walls, 1);
    }

    #[test]
    fn compute_teleport_edge_stats_scoped_counts_same_floor_teleport() {
        let (field, mut graph, level0, _level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        graph.add_edge(a0, b0, EdgeKind::Teleport);
        graph.add_edge(b0, a0, EdgeKind::Teleport);
        let stats = compute_teleport_edge_stats_scoped(&graph, &field, level0);
        assert_eq!(stats.two_way, 1);
    }

    #[test]
    fn compute_teleport_edge_stats_scoped_excludes_cross_floor_teleport_from_both_floors() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 0, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        graph.add_edge(b1, a0, EdgeKind::Teleport);
        let stats0 = compute_teleport_edge_stats_scoped(&graph, &field, level0);
        assert_eq!(stats0.two_way + stats0.one_way, 0, "cross-floor teleport must not count toward level0");
        let stats1 = compute_teleport_edge_stats_scoped(&graph, &field, level1);
        assert_eq!(stats1.two_way + stats1.one_way, 0, "cross-floor teleport must not count toward level1 either");
    }

    #[test]
    fn average_degree_empty_graph_is_zero() {
        let graph = Graph::new();
        assert_eq!(average_degree(&graph), 0.0);
    }

    #[test]
    fn average_degree_no_edges_is_zero() {
        let (_, graph) = make_field_and_graph(3, 1);
        assert_eq!(average_degree(&graph), 0.0);
    }

    #[test]
    fn average_degree_matches_hand_computed_value() {
        let (field, mut graph) = make_field_and_graph(3, 1);
        let left = node_at(&field, 0, 0);
        let mid = node_at(&field, 1, 0);
        let right = node_at(&field, 2, 0);
        graph.add_bidirectional_edge(left, mid, EdgeKind::Basic);
        graph.add_bidirectional_edge(mid, right, EdgeKind::Basic);
        // left: 1 neighbor, mid: 2 neighbors, right: 1 neighbor -> total 4 / 3 nodes.
        assert_eq!(average_degree(&graph), 4.0 / 3.0);
    }

    /// Three independent `w`x`h` floors, no cross-floor edges wired — callers add those
    /// themselves. Needed (over `make_two_level_field_and_graph`) for `Elevator` tests, which
    /// require 3+ floors to distinguish "one group across many floors" from "one group per pair".
    fn make_three_level_field_and_graph(w: usize, h: usize) -> (MultiLevelField<SquareTessellation>, Graph, LevelId, LevelId, LevelId) {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(w, h), &mut ids).unwrap();
        let level0 = field.single_level_id();
        let level1 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let level2 = field.add_level(Field::new(square_rect(w, h), &mut ids).unwrap());
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        (field, graph, level0, level1, level2)
    }

    #[test]
    fn compute_vertical_stats_no_vertical_edges_all_zero() {
        let (field, graph, _level0, _level1) = make_two_level_field_and_graph(2, 1);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.bidirectional_passages, 0);
        assert_eq!(stats.one_way_passages_up, 0);
        assert_eq!(stats.one_way_passages_down, 0);
        assert_eq!(stats.elevator_groups, 0);
        assert_eq!(stats.cross_floor_teleports, 0);
    }

    #[test]
    fn compute_vertical_stats_bidirectional_passage() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        graph.add_bidirectional_edge(a0, a1, EdgeKind::VerticalPassage);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.bidirectional_passages, 1);
        assert_eq!(stats.one_way_passages_up, 0);
        assert_eq!(stats.one_way_passages_down, 0);
    }

    #[test]
    fn compute_vertical_stats_one_way_up_and_down() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(3, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        graph.add_edge(a0, a1, EdgeKind::VerticalPassage); // level0 -> level1: up
        let b0 = node_at_level(&field, level0, 1, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(b1, b0, EdgeKind::VerticalPassage); // level1 -> level0: down
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.one_way_passages_up, 1);
        assert_eq!(stats.one_way_passages_down, 1);
        assert_eq!(stats.bidirectional_passages, 0);
    }

    #[test]
    fn compute_vertical_stats_elevator_counts_one_group_for_full_fan() {
        let (field, mut graph, level0, level1, level2) = make_three_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        let a2 = node_at_level(&field, level2, 0, 0);
        // Full fan across 3 floors at the same x-y point (mirrors `try_add_elevator_edge`'s
        // pairwise bidirectional wiring) -> one elevator group, not 3 edges' worth.
        for (x, y) in [(a0, a1), (a0, a2), (a1, a2)] {
            graph.add_bidirectional_edge(x, y, EdgeKind::Elevator);
        }
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 1);
    }

    #[test]
    fn compute_vertical_stats_elevator_counts_distinct_points_separately() {
        let (field, mut graph, level0, level1, _level2) = make_three_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let a1 = node_at_level(&field, level1, 0, 0);
        let b0 = node_at_level(&field, level0, 1, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_bidirectional_edge(a0, a1, EdgeKind::Elevator);
        graph.add_bidirectional_edge(b0, b1, EdgeKind::Elevator);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 2);
    }

    #[test]
    fn compute_vertical_stats_elevator_same_point_disjoint_floor_sets_count_as_two_groups() {
        // 6-floor field: floors 0-2 form one elevator at (0,0), floors 3-5 form a separate
        // elevator at the same x-y point, with no edges connecting the two sets.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let levels: Vec<LevelId> = std::iter::once(field.single_level_id())
            .chain((1..6).map(|_| field.add_level(Field::new(square_rect(2, 1), &mut ids).unwrap())))
            .collect();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }

        let node_at_floor = |field: &MultiLevelField<SquareTessellation>, idx: usize| node_at_level(field, levels[idx], 0, 0);
        for (i, j) in [(0, 1), (0, 2), (1, 2)] {
            let (a, b) = (node_at_floor(&field, i), node_at_floor(&field, j));
            graph.add_bidirectional_edge(a, b, EdgeKind::Elevator);
        }
        for (i, j) in [(3, 4), (3, 5), (4, 5)] {
            let (a, b) = (node_at_floor(&field, i), node_at_floor(&field, j));
            graph.add_bidirectional_edge(a, b, EdgeKind::Elevator);
        }

        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.elevator_groups, 2, "same x-y point but disjoint floor sets are two separate elevators");
    }

    #[test]
    fn compute_vertical_stats_cross_floor_teleport_counted_once_per_pair() {
        let (field, mut graph, level0, level1) = make_two_level_field_and_graph(2, 1);
        let a0 = node_at_level(&field, level0, 0, 0);
        let b1 = node_at_level(&field, level1, 1, 0);
        graph.add_edge(a0, b1, EdgeKind::Teleport);
        graph.add_edge(b1, a0, EdgeKind::Teleport);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.cross_floor_teleports, 1);
    }

    #[test]
    fn compute_vertical_stats_same_floor_teleport_excluded() {
        let (field, mut graph) = make_field_and_graph(2, 1);
        let a = node_at(&field, 0, 0);
        let b = node_at(&field, 1, 0);
        graph.add_edge(a, b, EdgeKind::Teleport);
        let stats = compute_vertical_stats(&graph, &field);
        assert_eq!(stats.cross_floor_teleports, 0);
    }
}
