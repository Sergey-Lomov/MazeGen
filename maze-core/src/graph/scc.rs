use std::collections::HashMap;
use crate::ids::NodeId;
use super::Graph;

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

struct TarjanState<'g> {
    graph: &'g Graph,
    index_counter: usize,
    stack: Vec<NodeId>,
    on_stack: HashMap<NodeId, bool>,
    indices: HashMap<NodeId, usize>,
    lowlinks: HashMap<NodeId, usize>,
    components: Vec<Vec<NodeId>>,
}

impl<'g> TarjanState<'g> {
    fn strongconnect(&mut self, v: NodeId) {
        self.indices.insert(v, self.index_counter);
        self.lowlinks.insert(v, self.index_counter);
        self.index_counter += 1;
        self.stack.push(v);
        self.on_stack.insert(v, true);

        for w in self.graph.outgoing_neighbors(v).collect::<Vec<_>>() {
            if !self.indices.contains_key(&w) {
                self.strongconnect(w);
                let ll_w = self.lowlinks[&w];
                let ll_v = self.lowlinks[&v];
                self.lowlinks.insert(v, ll_v.min(ll_w));
            } else if *self.on_stack.get(&w).unwrap_or(&false) {
                let idx_w = self.indices[&w];
                let ll_v = self.lowlinks[&v];
                self.lowlinks.insert(v, ll_v.min(idx_w));
            }
        }

        if self.lowlinks[&v] == self.indices[&v] {
            let mut component = Vec::new();
            loop {
                let w = self.stack.pop().unwrap();
                self.on_stack.insert(w, false);
                component.push(w);
                if w == v {
                    break;
                }
            }
            component.sort_unstable();
            self.components.push(component);
        }
    }
}

/// Compute strongly connected components via Tarjan's algorithm.
/// Iteration order over nodes is deterministic (sorted by NodeId) for reproducibility.
pub fn build_scc(graph: &Graph) -> ConnectedComponents {
    let mut state = TarjanState {
        graph,
        index_counter: 0,
        stack: Vec::new(),
        on_stack: HashMap::new(),
        indices: HashMap::new(),
        lowlinks: HashMap::new(),
        components: Vec::new(),
    };

    let mut node_ids: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    node_ids.sort_unstable();

    for v in node_ids {
        if !state.indices.contains_key(&v) {
            state.strongconnect(v);
        }
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
