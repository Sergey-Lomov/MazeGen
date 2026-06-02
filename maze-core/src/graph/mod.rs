use std::collections::HashMap;
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
    pub a: NodeId,
    pub b: NodeId,
    pub kind: EdgeKind,
}

#[derive(Debug)]
pub struct Graph {
    nodes: Vec<Node>,
    edges: Vec<Option<Edge>>,
    adjacency: Vec<Vec<EdgeId>>,
    node_index: HashMap<NodeId, usize>,
}

impl Graph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::new(),
            edges: Vec::new(),
            adjacency: Vec::new(),
            node_index: HashMap::new(),
        }
    }

    pub fn add_node(&mut self, id: NodeId) {
        let idx = self.nodes.len();
        self.nodes.push(Node { id });
        self.adjacency.push(Vec::new());
        self.node_index.insert(id, idx);
    }

    pub fn add_edge(&mut self, a: NodeId, b: NodeId, kind: EdgeKind) -> EdgeId {
        let id = self.edges.len();
        let edge = Edge { id, a, b, kind };
        self.edges.push(Some(edge));
        let idx_a = self.node_index[&a];
        let idx_b = self.node_index[&b];
        self.adjacency[idx_a].push(id);
        self.adjacency[idx_b].push(id);
        id
    }

    pub fn remove_edge(&mut self, id: EdgeId) {
        if let Some(edge) = self.edges[id].take() {
            let idx_a = self.node_index[&edge.a];
            let idx_b = self.node_index[&edge.b];
            self.adjacency[idx_a].retain(|&e| e != id);
            self.adjacency[idx_b].retain(|&e| e != id);
        }
    }

    pub fn neighbors(&self, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
        let idx = self.node_index[&node];
        self.adjacency[idx].iter().filter_map(move |&eid| {
            self.edges[eid].as_ref().map(|e| if e.a == node { e.b } else { e.a })
        })
    }

    pub fn edge_between(&self, a: NodeId, b: NodeId) -> Option<EdgeId> {
        let idx_a = self.node_index.get(&a)?;
        self.adjacency[*idx_a].iter().find(|&&eid| {
            self.edges[eid].as_ref().map_or(false, |e| {
                (e.a == a && e.b == b) || (e.a == b && e.b == a)
            })
        }).copied()
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
