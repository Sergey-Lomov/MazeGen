use std::collections::HashSet;
use crate::ids::NodeId;
use crate::space::Field;
use crate::graph::Graph;
use crate::graph::nav::{NavGraph, NavNodeId};

// Geometric classification depends on tessellation geometry (is_straight).
// The same graph on a different tessellation may yield different classes.
pub enum GeometricNodeClass {
    DeadEnd,
    Straight,
    Turn,
    Junction(usize),
}

pub struct GeometricNodeStats {
    pub dead_ends: usize,
    pub straight: usize,
    pub turns: usize,
    pub junctions: Vec<(usize, usize)>, // (degree, count), sorted by degree
}

// Spatial edge statistics. Walls are a spatial concept (adjacent node pair with no edge),
// not a graph property. Computed via field neighbors, not graph edges alone.
pub struct SpatialEdgeStats {
    pub bidirectional: usize,
    pub one_way: usize,
    pub walls: usize,
}

pub struct RouteInfo {
    pub path_length: usize,    // node count including start and finish
    pub junction_count: usize, // nav-nodes with degree >= 3 on the path
    pub one_way_count: usize,  // nav-edges without reverse on the path
    pub score: Option<f64>,    // filled externally from ScoredEndpointsStrategy
    pub path: Vec<NodeId>,     // all maze nodes on the route in order
}

fn unique_neighbors(graph: &Graph, node: NodeId) -> Vec<NodeId> {
    let neighbors: HashSet<NodeId> = graph.outgoing_neighbors(node).collect();
    let mut v: Vec<NodeId> = neighbors.into_iter().collect();
    v.sort_unstable();
    v
}

pub fn classify_node<F: Field>(graph: &Graph, node: NodeId, field: &F) -> GeometricNodeClass {
    let neighbors = unique_neighbors(graph, node);
    match neighbors.len() {
        0 | 1 => GeometricNodeClass::DeadEnd,
        2 => {
            if field.is_straight(neighbors[0], node, neighbors[1]) {
                GeometricNodeClass::Straight
            } else {
                GeometricNodeClass::Turn
            }
        }
        n => GeometricNodeClass::Junction(n),
    }
}

pub fn compute_node_stats<F: Field>(graph: &Graph, field: &F) -> GeometricNodeStats {
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

    let stats = GeometricNodeStats { dead_ends, straight, turns, junctions };

    debug_assert!(
        stats.dead_ends
            + stats.straight
            + stats.turns
            + stats.junctions.iter().map(|(_, c)| c).sum::<usize>()
            == graph.node_count()
    );

    stats
}

fn adjacency_pairs<F: Field>(graph: &Graph, field: &F) -> Vec<(NodeId, NodeId)> {
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

pub fn compute_spatial_edge_stats<F: Field>(graph: &Graph, field: &F) -> SpatialEdgeStats {
    let pairs = adjacency_pairs(graph, field);
    let total = pairs.len();
    let mut bidirectional = 0usize;
    let mut one_way = 0usize;
    let mut walls = 0usize;

    for (a, b) in &pairs {
        let ab = graph.edge_between(*a, *b).is_some();
        let ba = graph.edge_between(*b, *a).is_some();
        match (ab, ba) {
            (true, true) => bidirectional += 1,
            (false, false) => walls += 1,
            _ => one_way += 1,
        }
    }

    debug_assert!(bidirectional + one_way + walls == total);

    SpatialEdgeStats { bidirectional, one_way, walls }
}

/// Resolve a maze NodeId to its NavNodeId in O(1).
/// Junction nodes map directly via node_index; corridor nodes via corridor_index.
fn resolve_nav_node(nav: &NavGraph, node_id: NodeId) -> Option<NavNodeId> {
    nav.nav_node_for(node_id)
        .or_else(|| nav.corridor_index.get(&node_id).copied())
}

pub fn compute_route_info(nav: &NavGraph, start: NodeId, finish: NodeId) -> Option<RouteInfo> {
    // Callers must build `nav` with build_nav_graph_pinned({start, finish}) so that both
    // nodes are guaranteed to be junction (nav) nodes, not corridor nodes.
    debug_assert!(
        nav.nav_node_for(start).is_some(),
        "compute_route_info: start node {start:?} is not a nav node; build nav graph with start pinned"
    );
    debug_assert!(
        nav.nav_node_for(finish).is_some(),
        "compute_route_info: finish node {finish:?} is not a nav node; build nav graph with finish pinned"
    );
    let start_nav = resolve_nav_node(nav, start)?;
    let finish_nav = resolve_nav_node(nav, finish)?;

    if start_nav == finish_nav {
        // start and finish may be different maze nodes that collapsed to the same nav node
        let path = if start == finish { vec![start] } else { vec![start, finish] };
        let path_length = path.len();
        return Some(RouteInfo {
            path_length,
            junction_count: 0,
            one_way_count: 0,
            score: None,
            path,
        });
    }

    let all_edges: Vec<_> = nav.edges().collect();

    // Build set of all nav edge pairs for one-way detection
    let edge_pairs: HashSet<(NavNodeId, NavNodeId)> =
        all_edges.iter().map(|e| (e.from, e.to)).collect();

    // Build adjacency list: NavNodeId → Vec<(edge_idx, weight, to)>
    // Avoids O(V*E) inner loop in Dijkstra.
    let n = nav.nodes.len();
    let mut adj: Vec<Vec<(usize, usize, NavNodeId)>> = vec![Vec::new(); n];
    for (ei, e) in all_edges.iter().enumerate() {
        adj[e.from].push((ei, e.path.len().saturating_sub(1), e.to));
    }

    let mut dist: Vec<usize> = vec![usize::MAX; n];
    let mut prev_edge: Vec<Option<usize>> = vec![None; n];
    let mut heap = std::collections::BinaryHeap::new();

    dist[start_nav] = 0;
    heap.push(std::cmp::Reverse((0usize, start_nav)));

    while let Some(std::cmp::Reverse((cost, cur))) = heap.pop() {
        if cost > dist[cur] { continue; }
        for &(ei, w, to) in &adj[cur] {
            let next_cost = cost + w;
            if next_cost < dist[to] {
                dist[to] = next_cost;
                prev_edge[to] = Some(ei);
                heap.push(std::cmp::Reverse((next_cost, to)));
            }
        }
    }

    if dist[finish_nav] == usize::MAX {
        return None;
    }

    // Reconstruct path as sequence of edge indices from start to finish.
    // Guard: path length is bounded by number of nav nodes (Dijkstra tree is acyclic).
    let mut path_edge_indices: Vec<usize> = Vec::new();
    let mut cur = finish_nav;
    while cur != start_nav {
        let ei = prev_edge[cur]?;
        path_edge_indices.push(ei);
        cur = all_edges[ei].from;
        if path_edge_indices.len() > n {
            // Should never happen with a correct Dijkstra tree; guard against infinite loop.
            return None;
        }
    }
    path_edge_indices.reverse();

    // Collect nav nodes on path (start node + each edge's destination)
    let mut nav_nodes_on_path: Vec<NavNodeId> = Vec::new();
    nav_nodes_on_path.push(start_nav);
    for &ei in &path_edge_indices {
        nav_nodes_on_path.push(all_edges[ei].to);
    }

    // Build full maze node path by concatenating nav edge paths.
    // Consecutive edges share one junction node — skip first node of each edge after the first.
    let mut maze_path: Vec<NodeId> = Vec::new();
    for (i, &ei) in path_edge_indices.iter().enumerate() {
        let edge_path = &all_edges[ei].path;
        if i == 0 {
            maze_path.extend_from_slice(edge_path);
        } else {
            maze_path.extend_from_slice(&edge_path[1..]);
        }
    }
    if path_edge_indices.is_empty() {
        maze_path.push(start);
    }

    let path_length = maze_path.len();

    let mut one_way_count = 0usize;
    for &ei in &path_edge_indices {
        let e = all_edges[ei];
        if !edge_pairs.contains(&(e.to, e.from)) {
            one_way_count += 1;
        }
    }

    // junction = nav node with >= 3 distinct outgoing neighbors
    let mut junction_count = 0usize;
    for &nid in &nav_nodes_on_path {
        let out: HashSet<NavNodeId> = nav.outgoing_edges(nid).map(|e| e.to).collect();
        if out.len() >= 3 {
            junction_count += 1;
        }
    }

    Some(RouteInfo { path_length, junction_count, one_way_count, score: None, path: maze_path })
}
