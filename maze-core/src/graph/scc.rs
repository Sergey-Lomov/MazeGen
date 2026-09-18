use super::Graph;
use crate::ids::NodeId;
use std::collections::{HashMap, HashSet};

pub type ComponentId = usize;

/// Strongly connected components of a directed graph.
///
/// Two nodes are in the same component iff each is reachable from the other
/// via directed edges. A one-way edge between two groups keeps them separate
/// even if every node is reachable from every other node in some direction.
#[derive(Debug, Clone)]
pub struct ConnectedComponents {
    /// Each entry is one SCC: a sorted list of NodeIds.
    /// Components are ordered by discovery (Tarjan finishes innermost-SCC first,
    /// so index 0 is a sink component).
    pub components: Vec<Vec<NodeId>>,
    /// Maps each NodeId to its component index in `components`.
    pub node_component: HashMap<NodeId, ComponentId>,
}

impl ConnectedComponents {
    pub fn component_of(&self, node: NodeId) -> Option<ComponentId> {
        self.node_component.get(&node).copied()
    }
}

struct NodeState {
    index: usize,
    lowlink: usize,
}

struct TarjanIter {
    index_counter: usize,
    tarjan_stack: Vec<NodeId>,
    on_stack: HashSet<NodeId>,
    node_state: HashMap<NodeId, NodeState>,
    components: Vec<Vec<NodeId>>,
    /// Work stack: (node, pre-collected neighbors, next neighbor index)
    work: Vec<(NodeId, Vec<NodeId>, usize)>,
}

impl TarjanIter {
    fn new() -> Self {
        Self {
            index_counter: 0,
            tarjan_stack: Vec::new(),
            on_stack: HashSet::new(),
            node_state: HashMap::new(),
            components: Vec::new(),
            work: Vec::new(),
        }
    }

    fn push_node(&mut self, v: NodeId, neighbors: Vec<NodeId>) {
        self.node_state.insert(
            v,
            NodeState {
                index: self.index_counter,
                lowlink: self.index_counter,
            },
        );
        self.index_counter += 1;
        self.tarjan_stack.push(v);
        self.on_stack.insert(v);
        self.work.push((v, neighbors, 0));
    }

    /// Drive the work stack until empty.
    fn run(&mut self, graph: &Graph) {
        while !self.work.is_empty() {
            let (v, _, ni) = &self.work[self.work.len() - 1];
            let v = *v;
            let ni = *ni;
            let neighbors_len = self.work[self.work.len() - 1].1.len();

            if ni < neighbors_len {
                let w = self.work[self.work.len() - 1].1[ni];
                self.work.last_mut().unwrap().2 += 1;

                if !self.node_state.contains_key(&w) {
                    let w_neighbors: Vec<NodeId> = graph.outgoing_neighbors(w).collect();
                    self.push_node(w, w_neighbors);
                } else if self.on_stack.contains(&w) {
                    let idx_w = self.node_state[&w].index;
                    let state_v = self.node_state.get_mut(&v).unwrap();
                    state_v.lowlink = state_v.lowlink.min(idx_w);
                }
            } else {
                // All neighbors processed — check SCC root
                let is_root = {
                    let s = &self.node_state[&v];
                    s.lowlink == s.index
                };
                if is_root {
                    let mut component = Vec::new();
                    loop {
                        let w = self.tarjan_stack.pop().unwrap();
                        self.on_stack.remove(&w);
                        component.push(w);
                        if w == v {
                            break;
                        }
                    }
                    component.sort_unstable();
                    self.components.push(component);
                }

                self.work.pop();

                // Propagate lowlink to parent
                if let Some(frame) = self.work.last() {
                    let parent = frame.0;
                    let ll_v = self.node_state[&v].lowlink;
                    let parent_state = self.node_state.get_mut(&parent).unwrap();
                    parent_state.lowlink = parent_state.lowlink.min(ll_v);
                }
            }
        }
    }
}

/// Compute strongly connected components via iterative Tarjan's algorithm.
/// Iteration order over nodes is deterministic (sorted by NodeId) for reproducibility.
///
/// Uses an explicit work stack to avoid call-stack overflow on large graphs.
pub fn build_scc(graph: &Graph) -> ConnectedComponents {
    let mut state = TarjanIter::new();

    let mut node_ids: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    node_ids.sort_unstable();

    for root in node_ids {
        if state.node_state.contains_key(&root) {
            continue;
        }
        let neighbors: Vec<NodeId> = graph.outgoing_neighbors(root).collect();
        state.push_node(root, neighbors);
        state.run(graph);
    }

    let mut node_component = HashMap::new();
    for (comp_id, nodes) in state.components.iter().enumerate() {
        for &node in nodes {
            node_component.insert(node, comp_id);
        }
    }

    ConnectedComponents {
        components: state.components,
        node_component,
    }
}
