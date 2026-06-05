use std::collections::{HashMap, HashSet};
use crate::ids::NodeId;
use super::Graph;

pub type NavNodeId = usize;
pub type NavEdgeId = usize;

/// A junction node in the navigation graph. Corresponds to a node in the maze graph
/// that is not a simple bidirectional corridor node.
#[derive(Debug, Clone)]
pub struct NavNode {
    pub id: NavNodeId,
    /// The maze graph node this nav node represents.
    pub node_id: NodeId,
    pub outgoing: Vec<NavEdgeId>,
    pub incoming: Vec<NavEdgeId>,
}

/// A directed edge in the navigation graph, representing a compressed corridor.
/// `path` contains all maze nodes from source to target (inclusive), in traversal order:
/// path[0] is the source nav node's maze node, path[last] is the target nav node's maze node.
#[derive(Debug, Clone)]
pub struct NavEdge {
    pub id: NavEdgeId,
    pub from: NavNodeId,
    pub to: NavNodeId,
    /// All maze NodeIds along this corridor, inclusive of both endpoints.
    pub path: Vec<NodeId>,
}

#[derive(Debug, Clone)]
pub struct NavGraph {
    pub nodes: Vec<NavNode>,
    pub edges: Vec<NavEdge>,
    node_index: HashMap<NodeId, NavNodeId>,
}

impl NavGraph {
    fn new() -> Self {
        Self { nodes: Vec::new(), edges: Vec::new(), node_index: HashMap::new() }
    }

    fn add_node(&mut self, node_id: NodeId) -> NavNodeId {
        if let Some(&id) = self.node_index.get(&node_id) {
            return id;
        }
        let id = self.nodes.len();
        self.nodes.push(NavNode { id, node_id, outgoing: Vec::new(), incoming: Vec::new() });
        self.node_index.insert(node_id, id);
        id
    }

    fn add_edge(&mut self, from_nav: NavNodeId, to_nav: NavNodeId, path: Vec<NodeId>) -> NavEdgeId {
        let id = self.edges.len();
        self.edges.push(NavEdge { id, from: from_nav, to: to_nav, path });
        self.nodes[from_nav].outgoing.push(id);
        self.nodes[to_nav].incoming.push(id);
        id
    }

    pub fn nav_node_for(&self, node_id: NodeId) -> Option<NavNodeId> {
        self.node_index.get(&node_id).copied()
    }
}

/// A node is a corridor node if it has exactly 2 outgoing and 2 incoming edges,
/// and those form two symmetric pairs: for each outgoing neighbor B there is a
/// corresponding incoming edge from B (and vice versa).
fn is_corridor_node(graph: &Graph, node: NodeId) -> bool {
    let out: Vec<NodeId> = graph.outgoing_neighbors(node).collect();
    let inc: Vec<NodeId> = graph.incoming_neighbors(node).collect();
    if out.len() != 2 || inc.len() != 2 {
        return false;
    }
    let out_set: HashSet<NodeId> = out.into_iter().collect();
    let inc_set: HashSet<NodeId> = inc.into_iter().collect();
    out_set == inc_set
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
) -> (Vec<NodeId>, NodeId) {
    let mut path = vec![start];
    let mut current = start;
    let mut next = next_node;

    loop {
        if visited_corridor.contains(&next) || !is_corridor_node(graph, next) {
            // next is a junction or already visited (ring close)
            path.push(next);
            return (path, next);
        }
        visited_corridor.insert(next);
        path.push(next);
        // advance: find the outgoing neighbor of `next` that is not `current`
        let candidates: Vec<NodeId> = graph
            .outgoing_neighbors(next)
            .filter(|&n| n != current)
            .collect();
        if candidates.is_empty() {
            return (path, next);
        }
        current = next;
        next = candidates[0];
    }
}

pub fn build_nav_graph(graph: &Graph) -> NavGraph {
    let mut nav = NavGraph::new();
    let mut remaining: HashSet<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited_junctions: HashSet<NodeId> = HashSet::new();

    while !remaining.is_empty() {
        let component_start = find_component_start(graph, &remaining);

        match component_start {
            ComponentStart::Junction(junction) => {
                dfs_from_junction(graph, junction, &mut nav, &mut remaining, &mut visited_junctions);
            }
            ComponentStart::Ring(ring_start) => {
                build_ring(graph, ring_start, &mut nav, &mut remaining);
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
fn find_component_start(graph: &Graph, remaining: &HashSet<NodeId>) -> ComponentStart {
    let seed = *remaining.iter().min().unwrap();

    // If seed itself is a junction, done
    if !is_corridor_node(graph, seed) {
        return ComponentStart::Junction(seed);
    }

    // Walk forward looking for a junction
    let mut visited = HashSet::new();
    visited.insert(seed);
    let mut current = seed;

    loop {
        let next_candidates: Vec<NodeId> = graph.outgoing_neighbors(current).collect();
        if next_candidates.is_empty() {
            // Dead end with no outgoing — treat as junction
            return ComponentStart::Junction(current);
        }
        let next = next_candidates[0];

        if next == seed {
            return ComponentStart::Ring(seed);
        }
        if visited.contains(&next) {
            // Loop that doesn't pass through seed — pick the repeated node as ring anchor
            return ComponentStart::Ring(next);
        }
        if !is_corridor_node(graph, next) {
            return ComponentStart::Junction(next);
        }
        visited.insert(next);
        current = next;
    }
}

/// DFS from a junction node, building nav edges for all reachable corridors.
fn dfs_from_junction(
    graph: &Graph,
    start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
    visited_junctions: &mut HashSet<NodeId>,
) {
    let mut junction_stack: Vec<NodeId> = vec![start];

    while let Some(junction) = junction_stack.pop() {
        if !visited_junctions.insert(junction) {
            continue;
        }
        remaining.remove(&junction);
        nav.add_node(junction);

        for next in graph.outgoing_neighbors(junction).collect::<Vec<_>>() {
            if is_corridor_node(graph, next) {
                // Walk the corridor
                let mut visited_corridor: HashSet<NodeId> = HashSet::new();
                visited_corridor.insert(junction);
                remaining.remove(&next);

                let (path, terminal) = walk_corridor(graph, junction, next, &mut visited_corridor);

                // Remove all corridor intermediates from remaining
                for &n in &path[1..path.len().saturating_sub(1)] {
                    remaining.remove(&n);
                }
                remaining.remove(&terminal);

                let from_nav = nav.add_node(junction);
                let to_nav = nav.add_node(terminal);
                nav.add_edge(from_nav, to_nav, path);

                if !visited_junctions.contains(&terminal) {
                    junction_stack.push(terminal);
                }
            } else {
                // Direct junction-to-junction edge (no corridor)
                remaining.remove(&next);
                let from_nav = nav.add_node(junction);
                let to_nav = nav.add_node(next);
                nav.add_edge(from_nav, to_nav, vec![junction, next]);

                if !visited_junctions.contains(&next) {
                    junction_stack.push(next);
                }
            }
        }
    }
}

/// Build nav edges for a pure ring (all corridor nodes, no junctions).
/// Picks `ring_start` as the single nav node, adds two self-edges (CW and CCW).
fn build_ring(
    graph: &Graph,
    ring_start: NodeId,
    nav: &mut NavGraph,
    remaining: &mut HashSet<NodeId>,
) {
    let nav_id = nav.add_node(ring_start);
    remaining.remove(&ring_start);

    // Walk both outgoing directions from ring_start
    for first_step in graph.outgoing_neighbors(ring_start).collect::<Vec<_>>() {
        let mut path = vec![ring_start, first_step];
        remaining.remove(&first_step);
        let mut prev = ring_start;
        let mut current = first_step;

        loop {
            let next_candidates: Vec<NodeId> = graph
                .outgoing_neighbors(current)
                .filter(|&n| n != prev)
                .collect();

            if next_candidates.is_empty() || next_candidates[0] == ring_start {
                path.push(ring_start);
                break;
            }

            let next = next_candidates[0];
            remaining.remove(&next);
            path.push(next);
            prev = current;
            current = next;
        }

        nav.add_edge(nav_id, nav_id, path);
    }
}
