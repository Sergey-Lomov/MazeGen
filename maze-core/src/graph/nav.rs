use std::collections::{HashMap, HashSet};
use crate::ids::NodeId;
use super::Graph;

pub type NavNodeId = usize;

/// A junction node in the navigation graph. Corresponds to a node in the maze graph
/// that is not a simple bidirectional corridor node.
#[derive(Debug, Clone)]
pub struct NavNode {
    /// The maze graph node this nav node represents.
    pub node_id: NodeId,
}

/// A directed edge in the navigation graph, representing a compressed corridor.
/// `path` contains all maze nodes from source to target (inclusive), in traversal order:
/// path[0] is the source nav node's maze node, path[last] is the target nav node's maze node.
#[derive(Debug, Clone)]
pub struct NavEdge {
    pub from: NavNodeId,
    pub to: NavNodeId,
    /// All maze NodeIds along this corridor, inclusive of both endpoints.
    pub path: Vec<NodeId>,
    /// Index of the reverse edge (same corridor, opposite direction), if it exists.
    pub reverse_edge: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct NavGraph {
    pub nodes: Vec<NavNode>,
    edges: Vec<NavEdge>,
    /// Maps junction maze NodeId → NavNodeId.
    node_index: HashMap<NodeId, NavNodeId>,
    /// Maps corridor maze NodeId → the NavNodeId of the edge's destination nav node.
    /// Populated during nav graph construction for O(1) lookup of corridor nodes.
    pub(crate) corridor_index: HashMap<NodeId, NavNodeId>,
    outgoing: Vec<Vec<usize>>,
    incoming: Vec<Vec<usize>>,
}

impl NavGraph {
    fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            node_index: HashMap::new(),
            corridor_index: HashMap::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
        }
    }

    fn add_node(&mut self, node_id: NodeId) -> NavNodeId {
        if let Some(&id) = self.node_index.get(&node_id) {
            return id;
        }
        let id = self.nodes.len();
        self.nodes.push(NavNode { node_id });
        self.node_index.insert(node_id, id);
        self.outgoing.push(Vec::new());
        self.incoming.push(Vec::new());
        id
    }

    fn add_edge(&mut self, from_nav: NavNodeId, to_nav: NavNodeId, path: Vec<NodeId>) {
        let edge_idx = self.edges.len();
        // Index all interior corridor nodes to the destination nav node.
        for &corridor_node in path[1..path.len().saturating_sub(1)].iter() {
            self.corridor_index.entry(corridor_node).or_insert(to_nav);
        }
        self.edges.push(NavEdge { from: from_nav, to: to_nav, path, reverse_edge: None });
        self.outgoing[from_nav].push(edge_idx);
        self.incoming[to_nav].push(edge_idx);
    }

    /// For each edge, find its reverse (same path reversed) and link them via `reverse_edge`.
    fn link_reverse_edges(&mut self) {
        // Build index: (from, to, first_interior_node) → edge_idx for fast lookup.
        // Two edges are reverse of each other iff one's path reversed equals the other's path.
        let mut path_to_idx: HashMap<Vec<NodeId>, usize> = HashMap::new();
        for (i, edge) in self.edges.iter().enumerate() {
            path_to_idx.insert(edge.path.clone(), i);
        }
        for i in 0..self.edges.len() {
            if self.edges[i].reverse_edge.is_some() { continue; }
            let rev_path: Vec<NodeId> = self.edges[i].path.iter().rev().copied().collect();
            if let Some(&j) = path_to_idx.get(&rev_path) {
                if i != j {
                    self.edges[i].reverse_edge = Some(j);
                    self.edges[j].reverse_edge = Some(i);
                }
            }
        }
    }

    pub fn nav_node_for(&self, node_id: NodeId) -> Option<NavNodeId> {
        self.node_index.get(&node_id).copied()
    }

    pub fn edges(&self) -> impl Iterator<Item = &NavEdge> {
        self.edges.iter()
    }

    /// Panics if `node` is not a valid NavNodeId for this graph.
    pub fn outgoing_edges(&self, node: NavNodeId) -> impl Iterator<Item = &NavEdge> {
        self.outgoing[node].iter().map(|&i| &self.edges[i])
    }

    /// Outgoing edges with their index in the internal edge list.
    pub fn outgoing_edges_indexed(&self, node: NavNodeId) -> impl Iterator<Item = (usize, &NavEdge)> {
        self.outgoing[node].iter().map(|&i| (i, &self.edges[i]))
    }

    pub fn edge_by_idx(&self, idx: usize) -> &NavEdge {
        &self.edges[idx]
    }

    /// Panics if `node` is not a valid NavNodeId for this graph.
    pub fn incoming_edges(&self, node: NavNodeId) -> impl Iterator<Item = &NavEdge> {
        self.incoming[node].iter().map(|&i| &self.edges[i])
    }
}

/// A node is a corridor node if it has exactly 2 outgoing and 2 incoming edges,
/// and those form two symmetric pairs: for each outgoing neighbor B there is a
/// corresponding incoming edge from B (and vice versa).
/// Pinned nodes are never corridor nodes — they are forced to be nav nodes.
fn is_corridor_node(graph: &Graph, node: NodeId, pinned: &HashSet<NodeId>) -> bool {
    if pinned.contains(&node) { return false; }
    let out: Vec<NodeId> = graph.outgoing_neighbors(node).collect();
    let inc: Vec<NodeId> = graph.incoming_neighbors(node).collect();
    if out.len() != 2 || inc.len() != 2 {
        return false;
    }
    let out_set: HashSet<NodeId> = out.into_iter().collect();
    let inc_set: HashSet<NodeId> = inc.into_iter().collect();
    out_set == inc_set
}

/// Advance one step along a chain: pick the outgoing neighbor of `current` that is not `prev`.
/// Returns `None` if no such neighbor exists (dead end or all neighbors are `prev`).
fn advance_chain(graph: &Graph, current: NodeId, prev: NodeId) -> Option<NodeId> {
    graph.outgoing_neighbors(current).filter(|&n| n != prev).min()
}

/// Walk a directed corridor from `start` in direction `next_node`, collecting the path
/// until we reach a non-corridor node or revisit a node (ring detection).
/// Returns the path (inclusive of start, exclusive of the final junction or the ring-close node)
/// and the terminal node.
fn walk_corridor(
    graph: &Graph,
    start: NodeId,
    next_node: NodeId,
    visited_corridor: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
) -> (Vec<NodeId>, NodeId) {
    let mut path = vec![start];
    let mut current = start;
    let mut next = next_node;

    loop {
        if visited_corridor.contains(&next) || !is_corridor_node(graph, next, pinned) {
            // next is a junction or already visited (ring close)
            path.push(next);
            return (path, next);
        }
        visited_corridor.insert(next);
        path.push(next);
        let Some(advance) = advance_chain(graph, next, current) else {
            return (path, next);
        };
        current = next;
        next = advance;
    }
}

pub fn build_nav_graph(graph: &Graph) -> NavGraph {
    build_nav_graph_pinned(graph, &HashSet::new())
}

pub fn build_nav_graph_pinned(graph: &Graph, pinned: &HashSet<NodeId>) -> NavGraph {
    let mut nav = NavGraph::new();
    let mut remaining: HashSet<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited_junctions: HashSet<NodeId> = HashSet::new();

    while !remaining.is_empty() {
        let seed = *remaining.iter().min().unwrap();
        let size_before = remaining.len();
        let component_start = find_component_start(graph, &remaining, pinned);

        match component_start {
            ComponentStart::Junction(junction) => {
                dfs_from_junction(graph, junction, &mut nav, &mut remaining, &mut visited_junctions, pinned);
            }
            ComponentStart::Ring(ring_start) => {
                build_ring(graph, ring_start, &mut nav, &mut remaining, pinned);
            }
        };

        // Safety guard: if remaining did not shrink, the seed node is unreachable from the found
        // component start (possible in directed graphs). Force-remove seed to avoid infinite loop.
        if remaining.len() == size_before {
            remaining.remove(&seed);
        }
    }

    nav.link_reverse_edges();
    nav
}

enum ComponentStart {
    Junction(NodeId),
    Ring(NodeId),
}

/// Walk from any node in `remaining` until we find a junction or loop back to start.
fn find_component_start(graph: &Graph, remaining: &HashSet<NodeId>, pinned: &HashSet<NodeId>) -> ComponentStart {
    let seed = *remaining.iter().min().unwrap();

    // If seed itself is a junction, done
    if !is_corridor_node(graph, seed, pinned) {
        return ComponentStart::Junction(seed);
    }

    // Walk forward looking for a junction
    let mut visited = HashSet::new();
    visited.insert(seed);
    let mut current = seed;

    loop {
        let next_opt = graph.outgoing_neighbors(current).min();
        let Some(next) = next_opt else {
            // Dead end with no outgoing — treat as junction
            return ComponentStart::Junction(current);
        };

        if next == seed {
            return ComponentStart::Ring(seed);
        }
        if visited.contains(&next) {
            // Loop that doesn't pass through seed — pick the repeated node as ring anchor
            return ComponentStart::Ring(next);
        }
        if !is_corridor_node(graph, next, pinned) {
            return ComponentStart::Junction(next);
        }
        visited.insert(next);
        current = next;
    }
}

fn enqueue_junction(
    node: NodeId,
    visited_junctions: &HashSet<NodeId>,
    junction_stack: &mut Vec<NodeId>,
) {
    if !visited_junctions.contains(&node) {
        junction_stack.push(node);
    }
}

fn process_corridor(
    graph: &Graph,
    junction: NodeId,
    next: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
    junction_stack: &mut Vec<NodeId>,
    pinned: &HashSet<NodeId>,
) {
    let mut visited_corridor: HashSet<NodeId> = HashSet::new();
    visited_corridor.insert(junction);

    let (path, terminal) = walk_corridor(graph, junction, next, &mut visited_corridor, pinned);

    for &n in &path[1..] {
        remaining.remove(&n);
    }

    let from_nav = nav.add_node(junction);
    let to_nav   = nav.add_node(terminal);
    nav.add_edge(from_nav, to_nav, path);

    enqueue_junction(terminal, visited_junctions, junction_stack);
}

fn process_direct_edge(
    junction: NodeId,
    next: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
    junction_stack: &mut Vec<NodeId>,
) {
    remaining.remove(&next);
    let from_nav = nav.add_node(junction);
    let to_nav   = nav.add_node(next);
    nav.add_edge(from_nav, to_nav, vec![junction, next]);

    enqueue_junction(next, visited_junctions, junction_stack);
}

/// DFS from a junction node, building nav edges for all reachable corridors.
fn dfs_from_junction(
    graph: &Graph,
    start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
) {
    let mut junction_stack: Vec<NodeId> = vec![start];

    while let Some(junction) = junction_stack.pop() {
        if !visited_junctions.insert(junction) {
            continue;
        }
        remaining.remove(&junction);
        nav.add_node(junction);

        for next in graph.outgoing_neighbors(junction).collect::<Vec<_>>() {
            if is_corridor_node(graph, next, pinned) {
                process_corridor(graph, junction, next, nav, remaining, visited_junctions, &mut junction_stack, pinned);
            } else {
                process_direct_edge(junction, next, nav, remaining, visited_junctions, &mut junction_stack);
            }
        }
    }
}

/// Walk the ring from `ring_start` to find the first pinned node. Returns ring_start if none found.
fn find_ring_anchor(graph: &Graph, ring_start: NodeId, pinned: &HashSet<NodeId>) -> NodeId {
    let Some(first) = graph.outgoing_neighbors(ring_start).min() else {
        return ring_start;
    };
    let mut walk = first;
    let mut walk_prev = ring_start;
    loop {
        if pinned.contains(&walk) { return walk; }
        match advance_chain(graph, walk, walk_prev) {
            Some(n) if n == ring_start => return ring_start,
            Some(n) => { walk_prev = walk; walk = n; }
            None => return ring_start,
        }
    }
}

/// Walk one direction around the ring from `anchor` via `first_step`.
/// Returns the complete path (anchor → ... → anchor) if the ring closes, else None.
/// Always removes all visited corridor nodes from `remaining`, even if the ring does not close.
fn walk_ring_direction(
    graph: &Graph,
    anchor: NodeId,
    first_step: NodeId,
    remaining: &mut HashSet<NodeId>,
) -> Option<Vec<NodeId>> {
    let mut path = vec![anchor, first_step];
    remaining.remove(&first_step);
    let mut prev = anchor;
    let mut current = first_step;

    loop {
        match advance_chain(graph, current, prev) {
            Some(n) if n == anchor => {
                path.push(anchor);
                return Some(path);
            }
            Some(next) => {
                remaining.remove(&next);
                path.push(next);
                prev = current;
                current = next;
            }
            None => return None,
        }
    }
}

/// Build nav edges for a pure ring (all corridor nodes, no junctions).
/// If any node in the ring is pinned, it becomes the anchor nav node.
/// Otherwise picks `ring_start` as the single nav node, adds two self-edges (CW and CCW).
fn build_ring(
    graph: &Graph,
    ring_start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    pinned: &HashSet<NodeId>,
) {
    let anchor = if pinned.is_empty() {
        ring_start
    } else {
        find_ring_anchor(graph, ring_start, pinned)
    };

    let nav_id = nav.add_node(anchor);
    remaining.remove(&anchor);
    if ring_start != anchor {
        remaining.remove(&ring_start);
    }

    for first_step in graph.outgoing_neighbors(anchor).collect::<Vec<_>>() {
        if let Some(path) = walk_ring_direction(graph, anchor, first_step, remaining) {
            nav.add_edge(nav_id, nav_id, path);
        }
    }
}
