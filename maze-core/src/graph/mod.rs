pub mod nav;
pub mod scc;
pub mod classify;
pub mod stats;
pub mod routing;
pub mod graph_analytics;
pub(crate) mod pathfinding;
pub(crate) mod cycles;

use std::collections::{HashMap, HashSet, VecDeque};
use crate::ids::{NodeId, EdgeId};

#[derive(Debug, PartialEq, Eq)]
pub struct Node {
    pub id: NodeId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EdgeKind {
    Basic,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Option<Edge>>,
    outgoing: HashMap<NodeId, Vec<EdgeId>>,
    incoming: HashMap<NodeId, Vec<EdgeId>>,
    version: u64,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: HashMap::new(),
            incoming: HashMap::new(),
            version: 0,
        }
    }

    /// Bumped on every edge insertion/removal that actually changes the edge set. Lets cache
    /// layers (`MazeAnalysis`) detect that previously cached derived data is stale, instead of
    /// relying on callers to remember to invalidate by hand. Node additions don't bump it —
    /// they can't make a cached cycle/nav-graph result wrong, only edges can.
    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn add_node(&mut self, id: NodeId) {
        self.nodes.push(Node { id });
        self.outgoing.insert(id, Vec::new());
        self.incoming.insert(id, Vec::new());
    }

    pub fn add_edge(&mut self, from: NodeId, to: NodeId, kind: EdgeKind) -> EdgeId {
        debug_assert!(self.outgoing.contains_key(&from), "add_edge: node {from} not in graph");
        debug_assert!(self.incoming.contains_key(&to), "add_edge: node {to} not in graph");
        if let Some(existing) = self.edge_between(from, to) {
            return existing;
        }
        let id = self.edges.len();
        self.edges.push(Some(Edge { id, from, to, kind }));
        self.outgoing.entry(from).or_default().push(id);
        self.incoming.entry(to).or_default().push(id);
        self.version += 1;
        id
    }

    pub fn add_bidirectional_edge(&mut self, a: NodeId, b: NodeId, kind: EdgeKind) -> (EdgeId, EdgeId) {
        let ab = self.add_edge(a, b, kind.clone());
        let ba = self.add_edge(b, a, kind);
        (ab, ba)
    }

    pub fn remove_edge(&mut self, id: EdgeId) {
        if let Some(edge) = self.edges[id].take() {
            self.outgoing.entry(edge.from).and_modify(|v| v.retain(|&e| e != id));
            self.incoming.entry(edge.to).and_modify(|v| v.retain(|&e| e != id));
            self.version += 1;
        }
    }

    pub fn outgoing_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.outgoing
            .get(&node)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| {
                self.edges[eid].as_ref().map(|e| e.to)
            })
    }

    pub fn incoming_neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        self.incoming
            .get(&node)
            .into_iter()
            .flat_map(|ids| ids.iter())
            .filter_map(move |&eid| {
                self.edges[eid].as_ref().map(|e| e.from)
            })
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(id).and_then(Option::as_ref)
    }

    pub fn edge_between(&self, from: NodeId, to: NodeId) -> Option<EdgeId> {
        self.outgoing.get(&from)?.iter().find(|&&eid| {
            self.edges[eid].as_ref().map_or(false, |e| e.to == to)
        }).copied()
    }

    pub fn reachable_to(&self, target: NodeId) -> Vec<NodeId> {
        let mut visited: HashSet<NodeId> = HashSet::new();
        let mut queue = VecDeque::new();
        if self.incoming.contains_key(&target) {
            visited.insert(target);
            queue.push_back(target);
        }
        while let Some(current) = queue.pop_front() {
            for neighbor in self.incoming_neighbors(current) {
                if visited.insert(neighbor) {
                    queue.push_back(neighbor);
                }
            }
        }
        let mut result: Vec<NodeId> = visited.into_iter().collect();
        result.sort_unstable();
        result
    }

    pub fn reachable_from(&self, start: NodeId) -> Vec<NodeId> {
        let mut visited: HashSet<NodeId> = HashSet::new();
        let mut queue = VecDeque::new();
        if self.outgoing.contains_key(&start) {
            visited.insert(start);
            queue.push_back(start);
        }
        while let Some(current) = queue.pop_front() {
            for neighbor in self.outgoing_neighbors(current) {
                if visited.insert(neighbor) {
                    queue.push_back(neighbor);
                }
            }
        }
        let mut result: Vec<NodeId> = visited.into_iter().collect();
        result.sort_unstable();
        result
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.iter()
    }

    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.iter().filter_map(|e| e.as_ref())
    }
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}
