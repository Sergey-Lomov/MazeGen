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
    /// True if this is a single-hop (`path.len() == 2`) edge backed by an `Elevator`-kind graph
    /// edge between `path[0]` and `path[1]`. Elevator endpoints are never corridor nodes (their
    /// fan degree rules out the 2-in/2-out shape `is_corridor_node` requires), so an `Elevator`
    /// hop is always single-hop, mirroring `is_teleport` above — including the same coexistence
    /// caveat (a `Basic`/`VerticalPassage` edge can share the same pair in the same direction as
    /// an `Elevator` edge, per `Graph::add_edge`'s kind-aware dedup) and the same reason
    /// `link_reverse_edges` must key on this flag too, not just `path`.
    pub is_elevator: bool,
    /// True if this is a single-hop (`path.len() == 2`) edge backed by a `VerticalPassage`-kind
    /// graph edge between `path[0]` and `path[1]`. Mirrors `is_teleport`/`is_elevator` above for
    /// the same reason: `VerticalPassage` endpoints are never corridor nodes (see
    /// `graph::nav::build::is_corridor_node`), so a `VerticalPassage` hop is always single-hop.
    pub is_vertical: bool,
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
    /// Maps corridor maze NodeId → every `(edge_idx, index_within_path)` pair it appears as an
    /// interior node of — a corridor node can be interior to up to two edges (a corridor edge
    /// and its reverse, see `link_reverse_edges`), and callers needing the exact tile-hop offset
    /// to either end of the corridor (not just the coarse "which edge's destination" `corridor_index`
    /// gives) must see both, not just whichever edge happened to be built first.
    pub(crate) corridor_positions: HashMap<NodeId, Vec<(usize, usize)>>,
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
            corridor_positions: HashMap::new(),
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

    pub(super) fn add_edge(&mut self, from_nav: NavNodeId, to_nav: NavNodeId, path: Vec<NodeId>, is_teleport: bool, is_elevator: bool, is_vertical: bool) {
        let edge_idx = self.edges.len();
        // Index all interior corridor nodes to the destination nav node (coarse lookup), plus
        // their exact index within this edge's path (precise lookup — see `corridor_positions`).
        for (i, &corridor_node) in path.iter().enumerate().take(path.len().saturating_sub(1)).skip(1) {
            self.corridor_index.entry(corridor_node).or_insert(to_nav);
            self.corridor_positions.entry(corridor_node).or_default().push((edge_idx, i));
        }
        self.edges.push(NavEdge { from: from_nav, to: to_nav, path, reverse_edge: None, is_teleport, is_elevator, is_vertical });
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

    /// For a corridor-interior maze node, every `(nav_node, forward_hops)` pair reachable by
    /// continuing forward along a corridor edge that node sits on — `forward_hops` is the exact
    /// tile-hop count from `node_id` to `nav_node`, not the coarse "which edge's destination"
    /// `corridor_index` gives. A node interior to both a corridor edge and its reverse (the common
    /// case for a bidirectional corridor) yields one pair per edge, since only forward traversal
    /// within a single `NavEdge`'s `path` is ever valid (going the other way requires the reverse
    /// edge, indexed separately). Empty for a junction/nav node itself (callers should treat it as
    /// already being at its own `NavNodeId`, offset 0).
    pub fn corridor_exit_offsets(&self, node_id: NodeId) -> impl Iterator<Item = (NavNodeId, usize)> + '_ {
        self.corridor_positions.get(&node_id).into_iter().flatten().map(|&(edge_idx, i)| {
            let edge = &self.edges[edge_idx];
            (edge.to, edge.path.len() - 1 - i)
        })
    }

    /// Like `corridor_exit_offsets`, but the other direction: every `(nav_node, forward_hops)`
    /// pair such that continuing forward from `nav_node` along its corridor edge reaches
    /// `node_id` — `forward_hops` is the exact tile-hop count from `nav_node` to `node_id`.
    pub fn corridor_entry_offsets(&self, node_id: NodeId) -> impl Iterator<Item = (NavNodeId, usize)> + '_ {
        self.corridor_positions.get(&node_id).into_iter().flatten().map(|&(edge_idx, i)| {
            let edge = &self.edges[edge_idx];
            (edge.from, i)
        })
    }

    /// Every raw `(edge_idx, index_within_path)` pair `node_id` is interior to — the same data
    /// `corridor_exit_offsets`/`corridor_entry_offsets` derive their nav-node-relative offsets
    /// from, exposed directly so a caller can detect "these two corridor-interior nodes sit on
    /// the very same edge" (shared `edge_idx`) and take the direct in-path distance between them,
    /// instead of always routing through each side's nav-node endpoint.
    pub fn corridor_edge_positions(&self, node_id: NodeId) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.corridor_positions.get(&node_id).into_iter().flatten().copied()
    }

    /// For each edge, find its reverse (same path reversed, same `is_teleport`/`is_elevator`/
    /// `is_vertical` kind) and link them via `reverse_edge`. Keyed on
    /// `(path, is_teleport, is_elevator, is_vertical)`, not `path` alone — a `Basic`, a
    /// `Teleport`, an `Elevator`, and a `VerticalPassage` one-hop `NavEdge` can each share the
    /// same `path` in each direction (parallel edges between the same node pair, see
    /// `NavEdge::is_teleport`/`NavEdge::is_elevator`/`NavEdge::is_vertical`), and keying by `path`
    /// alone would let one direction's insert overwrite another's slot, risking linking a `Basic`
    /// edge's `reverse_edge` to an unrelated `Teleport`/`Elevator`/`VerticalPassage` edge (or vice
    /// versa) instead of its true same-kind reverse. GitHub issue #197.
    pub(super) fn link_reverse_edges(&mut self) {
        let mut path_to_idx: HashMap<(Vec<NodeId>, bool, bool, bool), usize> = HashMap::new();
        for (i, edge) in self.edges.iter().enumerate() {
            path_to_idx.insert((edge.path.clone(), edge.is_teleport, edge.is_elevator, edge.is_vertical), i);
        }
        for i in 0..self.edges.len() {
            if self.edges[i].reverse_edge.is_some() { continue; }
            let rev_path: Vec<NodeId> = self.edges[i].path.iter().rev().copied().collect();
            if let Some(&j) = path_to_idx.get(&(rev_path, self.edges[i].is_teleport, self.edges[i].is_elevator, self.edges[i].is_vertical)) {
                if i != j {
                    self.edges[i].reverse_edge = Some(j);
                    self.edges[j].reverse_edge = Some(i);
                }
            }
        }
    }
}
