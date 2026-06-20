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
        self.edges.push(NavEdge { from: from_nav, to: to_nav, path });
        self.outgoing[from_nav].push(edge_idx);
        self.incoming[to_nav].push(edge_idx);
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
        let component_start = find_component_start(graph, &remaining, pinned);

        match component_start {
            ComponentStart::Junction(junction) => {
                dfs_from_junction(graph, junction, &mut nav, &mut remaining, &mut visited_junctions, pinned);
            }
            ComponentStart::Ring(ring_start) => {
                build_ring(graph, ring_start, &mut nav, &mut remaining, pinned);
            }
        }
    }

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

    // Walk forward looking for a junction, using advance_chain to avoid going back.
    // seed has no meaningful "prev", so pick its min outgoing neighbor as first step.
    let first_opt = graph.outgoing_neighbors(seed).min();
    let Some(first) = first_opt else {
        // Isolated node with no edges — treat as junction
        return ComponentStart::Junction(seed);
    };
    if !is_corridor_node(graph, first, pinned) {
        return ComponentStart::Junction(first);
    }

    let mut prev = seed;
    let mut current = first;
    let mut visited = HashSet::new();
    visited.insert(seed);
    visited.insert(first);

    loop {
        let next_opt = advance_chain(graph, current, prev);
        let Some(next) = next_opt else {
            return ComponentStart::Junction(current);
        };

        if next == seed {
            return ComponentStart::Ring(seed);
        }
        if visited.contains(&next) {
            return ComponentStart::Ring(next);
        }
        if !is_corridor_node(graph, next, pinned) {
            return ComponentStart::Junction(next);
        }
        visited.insert(next);
        prev = current;
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
/// Only walks through nodes in `remaining` to stay within the current ring component.
fn find_ring_anchor(graph: &Graph, ring_start: NodeId, pinned: &HashSet<NodeId>, remaining: &HashSet<NodeId>) -> NodeId {
    let Some(first) = graph.outgoing_neighbors(ring_start).filter(|n| remaining.contains(n) || *n == ring_start).min() else {
        return ring_start;
    };
    if first == ring_start { return ring_start; }
    let mut walk = first;
    let mut walk_prev = ring_start;
    loop {
        if pinned.contains(&walk) { return walk; }
        match advance_chain(graph, walk, walk_prev) {
            Some(n) if n == ring_start => return ring_start,
            Some(n) if remaining.contains(&n) => { walk_prev = walk; walk = n; }
            _ => return ring_start,
        }
    }
}

/// Walk one direction around the ring from `anchor` via `first_step`.
/// Returns the complete path (anchor → ... → anchor) if the ring closes, else None.
/// Always removes all visited nodes from `remaining`, whether or not the ring closes.
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
    let mut visited: HashSet<NodeId> = HashSet::new();
    visited.insert(anchor);
    visited.insert(first_step);

    loop {
        match advance_chain(graph, current, prev) {
            Some(n) if n == anchor => {
                path.push(anchor);
                return Some(path);
            }
            Some(next) => {
                remaining.remove(&next);
                if visited.contains(&next) {
                    // cycle without closing on anchor — dead end for ring purposes
                    return None;
                }
                visited.insert(next);
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
        find_ring_anchor(graph, ring_start, pinned, remaining)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};

    fn add_bidir(g: &mut Graph, a: NodeId, b: NodeId) {
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(b, a, EdgeKind::Basic);
    }

    // Simple ring A⇄B⇄C⇄A — no pinned.
    // All three are corridor nodes → one NavNode, two self-edges.
    #[test]
    fn test_simple_ring() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        add_bidir(&mut g, 1, 2);
        add_bidir(&mut g, 2, 3);
        add_bidir(&mut g, 3, 1);

        let nav = build_nav_graph(&g);
        assert_eq!(nav.nodes.len(), 1, "pure ring → 1 nav node");
        assert_eq!(nav.edges().count(), 2, "pure ring → 2 self-edges");
    }

    // Ring A⇄B⇄C⇄A, plus junction J⇄A (J has 1 neighbor = dead-end).
    // A: out={B,C,J} in={B,C,J} — junction (3 neighbors). B,C: corridor.
    // Nav nodes: J, A, plus B/C should be absorbed.
    #[test]
    fn test_ring_with_extra_junction_neighbor() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 10] { g.add_node(id); }
        // ring 1⇄2⇄3⇄1
        add_bidir(&mut g, 1, 2);
        add_bidir(&mut g, 2, 3);
        add_bidir(&mut g, 3, 1);
        // extra junction 10⇄1
        add_bidir(&mut g, 10, 1);

        let nav = build_nav_graph(&g);
        // node 1: out={2,3,10}, in={2,3,10} → junction
        // node 10: out={1}, in={1} → dead-end junction
        // nodes 2,3: each has 2 symmetric bidir neighbors → corridor
        // Expected: nav nodes = {1, 10}, edges = 10→1, 1→10, 1→1(CW), 1→1(CCW)
        let node_ids: Vec<NodeId> = nav.nodes.iter().map(|n| n.node_id).collect();
        assert!(!node_ids.contains(&2), "node 2 should be corridor (absorbed)");
        assert!(!node_ids.contains(&3), "node 3 should be corridor (absorbed)");
        assert!(node_ids.contains(&1), "node 1 should be junction (nav node)");
        assert!(node_ids.contains(&10), "node 10 should be junction (nav node)");
    }

    // Ring A⇄B⇄C⇄A, pinned={A}.
    // A pinned → junction. B,C corridor.
    // build_ring finds ring_start=B (min corridor), anchor=A (pinned).
    // A has outgoing {B, C} (both in ring) → both walks should succeed.
    #[test]
    fn test_ring_with_pinned_node() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3] { g.add_node(id); }
        add_bidir(&mut g, 1, 2);
        add_bidir(&mut g, 2, 3);
        add_bidir(&mut g, 3, 1);

        let mut pinned = HashSet::new();
        pinned.insert(1u64);

        let nav = build_nav_graph_pinned(&g, &pinned);
        assert_eq!(nav.nodes.len(), 1, "pinned ring → 1 nav node (the pinned anchor)");
        assert_eq!(nav.edges().count(), 2, "pinned ring → 2 self-edges");
        assert_eq!(nav.nodes[0].node_id, 1, "anchor should be pinned node 1");
    }

    // Ring A⇄B⇄C⇄A, pinned={A}, plus separate ring D⇄E⇄F⇄D connected to A via A⇄D.
    // A: out={B,C,D}, in={B,C,D} → junction (3 neighbors).
    // B,C: corridor in ring1. D,E,F: D has extra neighbor A → junction; E,F corridor.
    // This is the topology suspected to cause the freeze.
    #[test]
    fn test_ring_pinned_with_extra_ring_neighbor() {
        let mut g = Graph::new();
        for id in [1u64, 2, 3, 4, 5, 6] { g.add_node(id); }
        // ring1: 1⇄2⇄3⇄1
        add_bidir(&mut g, 1, 2);
        add_bidir(&mut g, 2, 3);
        add_bidir(&mut g, 3, 1);
        // ring2: 4⇄5⇄6⇄4
        add_bidir(&mut g, 4, 5);
        add_bidir(&mut g, 5, 6);
        add_bidir(&mut g, 6, 4);
        // bridge: 1⇄4
        add_bidir(&mut g, 1, 4);

        let mut pinned = HashSet::new();
        pinned.insert(1u64);

        // Should terminate without hanging
        let nav = build_nav_graph_pinned(&g, &pinned);
        // All nodes should be accounted for in nav (no remaining)
        let nav_node_ids: HashSet<NodeId> = nav.nodes.iter().map(|n| n.node_id).collect();
        // corridor nodes 2,3 absorbed into edges from node 1
        // node 4: out={1,5,6} in={1,5,6} → junction
        // nodes 5,6: corridor (neighbors {4,6} and {4,5} — symmetric bidir)
        assert!(!nav_node_ids.contains(&2), "node 2 absorbed");
        assert!(!nav_node_ids.contains(&3), "node 3 absorbed");
        assert!(nav_node_ids.contains(&1), "node 1 is junction");
        assert!(nav_node_ids.contains(&4), "node 4 is junction");
    }
}
