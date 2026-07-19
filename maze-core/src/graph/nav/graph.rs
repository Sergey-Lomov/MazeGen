use std::collections::HashMap;
use crate::ids::NodeId;

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
    /// True if this is a single-hop (`path.len() == 2`) edge backed by a `Teleport`-kind graph
    /// edge between `path[0]` and `path[1]`. Corridor-compressed edges (`path.len() > 2`) are
    /// never teleport-backed: teleport endpoints are always forced to be nav nodes and never
    /// compressed into a corridor's interior (see `graph::nav::build::is_corridor_node`), so a
    /// multi-hop path is always `Basic` hops end to end. A `Basic` edge may coexist in the same
    /// direction between the same pair as a `Teleport` edge (`Graph::add_edge`'s kind-aware
    /// dedup), so this flag distinguishes the two one-hop `NavEdge`s that construction builds in
    /// that case, instead of callers re-deriving it via `Graph::edge_between_kind(path[0],
    /// path[1], ..)`, which is kind-ambiguous relative to the base graph without also checking the
    /// other kind. See GitHub issue #197.
    pub is_teleport: bool,
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
    pub(super) fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            node_index: HashMap::new(),
            corridor_index: HashMap::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
        }
    }

    pub(super) fn add_node(&mut self, node_id: NodeId) -> NavNodeId {
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

    pub(super) fn add_edge(&mut self, from_nav: NavNodeId, to_nav: NavNodeId, path: Vec<NodeId>, is_teleport: bool) {
        let edge_idx = self.edges.len();
        // Index all interior corridor nodes to the destination nav node.
        for &corridor_node in path[1..path.len().saturating_sub(1)].iter() {
            self.corridor_index.entry(corridor_node).or_insert(to_nav);
        }
        self.edges.push(NavEdge { from: from_nav, to: to_nav, path, reverse_edge: None, is_teleport });
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

    pub fn edge_by_idx(&self, idx: usize) -> &NavEdge {
        &self.edges[idx]
    }

    /// For each edge, find its reverse (same path reversed, same `is_teleport` kind) and link
    /// them via `reverse_edge`. Keyed on `(path, is_teleport)`, not `path` alone — a `Basic` and
    /// a `Teleport` one-hop `NavEdge` can share the same `path` in each direction (parallel edges
    /// between the same node pair, see `NavEdge::is_teleport`), and keying by `path` alone would
    /// let one direction's insert overwrite the other's slot, risking linking a `Basic` edge's
    /// `reverse_edge` to an unrelated `Teleport` edge (or vice versa) instead of its true
    /// same-kind reverse. GitHub issue #197.
    pub(super) fn link_reverse_edges(&mut self) {
        let mut path_to_idx: HashMap<(Vec<NodeId>, bool), usize> = HashMap::new();
        for (i, edge) in self.edges.iter().enumerate() {
            path_to_idx.insert((edge.path.clone(), edge.is_teleport), i);
        }
        for i in 0..self.edges.len() {
            if self.edges[i].reverse_edge.is_some() { continue; }
            let rev_path: Vec<NodeId> = self.edges[i].path.iter().rev().copied().collect();
            if let Some(&j) = path_to_idx.get(&(rev_path, self.edges[i].is_teleport)) {
                if i != j {
                    self.edges[i].reverse_edge = Some(j);
                    self.edges[j].reverse_edge = Some(i);
                }
            }
        }
    }
}
