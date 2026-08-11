use std::collections::HashSet;
use crate::ids::NodeId;
use crate::space::{MultiLevelField, Tessellation};
use crate::graph::Graph;
use super::classify::{GeometricNodeClass, classify_node};

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
}

// Teleport edge statistics — teleports link non-adjacent tiles, so they fall outside
// `adjacency_pairs` and need their own pairing pass over `EdgeKind::Teleport` edges.
pub struct TeleportEdgeStats {
    pub two_way: usize,
    pub one_way: usize,
}

pub fn compute_node_stats<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> GeometricNodeStats {
    let mut dead_ends = 0usize;
    let mut straight = 0usize;
    let mut turns = 0usize;
    let mut junction_map: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();

    for node in graph.nodes() {
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
        .filter(|e| e.kind == super::EdgeKind::Teleport)
        .map(|e| e.to)
        .collect();

    let stats = GeometricNodeStats { dead_ends, straight, turns, junctions, teleport_entries: teleport_entries.len() };

    debug_assert!(
        stats.dead_ends
            + stats.straight
            + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>()
            == graph.node_count()
    );

    stats
}

fn adjacency_pairs<T: Tessellation>(graph: &Graph, field: &MultiLevelField<T>) -> Vec<(NodeId, NodeId)> {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut pairs = Vec::new();
    for node in graph.nodes() {
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
    let pairs = adjacency_pairs(graph, field);
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

    SpatialEdgeStats { bidirectional, one_way_passages, walls }
}

pub fn compute_teleport_edge_stats(graph: &Graph) -> TeleportEdgeStats {
    let mut seen: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut two_way = 0usize;
    let mut one_way = 0usize;

    for edge in graph.edges() {
        if edge.kind != super::EdgeKind::Teleport {
            continue;
        }
        let pair = if edge.from < edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if !seen.insert(pair) {
            continue;
        }
        let reverse = graph.edges().any(|e| {
            e.kind == super::EdgeKind::Teleport && e.from == edge.to && e.to == edge.from
        });
        if reverse {
            two_way += 1;
        } else {
            one_way += 1;
        }
    }

    TeleportEdgeStats { two_way, one_way }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

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
    fn compute_node_stats_junctions_grouped_and_sorted_by_degree() {
        // Two distinct junction degrees present: one 3-way, one 4-way.
        let (field, mut graph) = make_field_and_graph(3, 3);
        let three_way = node_at(&field, 0, 1); // edge node: up/down/right = 3 neighbors max
        graph.add_edge(three_way, node_at(&field, 0, 0), EdgeKind::Basic);
        graph.add_edge(three_way, node_at(&field, 0, 2), EdgeKind::Basic);
        graph.add_edge(three_way, node_at(&field, 1, 1), EdgeKind::Basic);

        let four_way = node_at(&field, 1, 1);
        graph.add_edge(four_way, node_at(&field, 0, 1), EdgeKind::Basic);
        graph.add_edge(four_way, node_at(&field, 2, 1), EdgeKind::Basic);
        graph.add_edge(four_way, node_at(&field, 1, 0), EdgeKind::Basic);
        graph.add_edge(four_way, node_at(&field, 1, 2), EdgeKind::Basic);

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
        assert_eq!(stats.bidirectional + stats.one_way_passages + stats.walls, 2, "3x1 field has 2 adjacent pairs");
        assert_eq!(stats.bidirectional, 1);
        assert_eq!(stats.walls, 1);
    }

    #[test]
    fn adjacency_pairs_does_not_double_count_symmetric_neighbors() {
        let (field, graph) = make_field_and_graph(2, 1);
        let pairs = adjacency_pairs(&graph, &field);
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
}
