use std::collections::HashMap;
use super::nav::{NavGraph, NavNodeId};

/// Undirected connected components of a nav-graph.
/// Edges are treated as bidirectional regardless of direction.
/// Domain: physical connectivity (geometry), not directed reachability.
#[derive(Debug, Clone)]
pub struct UndirectedComponents {
    /// node_component[nav_node_id] = component_id
    pub node_component: HashMap<NavNodeId, usize>,
    pub component_count: usize,
    pub largest_component_size: usize,
}

struct Dsu {
    parent: Vec<usize>,
    rank: Vec<usize>,
    size: Vec<usize>,
}

impl Dsu {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
            rank: vec![0; n],
            size: vec![1; n],
        }
    }

    fn find(&mut self, x: usize) -> usize {
        if self.parent[x] != x {
            self.parent[x] = self.find(self.parent[x]);
        }
        self.parent[x]
    }

    fn union(&mut self, a: usize, b: usize) {
        let ra = self.find(a);
        let rb = self.find(b);
        if ra == rb { return; }
        if self.rank[ra] < self.rank[rb] {
            self.parent[ra] = rb;
            self.size[rb] += self.size[ra];
        } else if self.rank[ra] > self.rank[rb] {
            self.parent[rb] = ra;
            self.size[ra] += self.size[rb];
        } else {
            self.parent[rb] = ra;
            self.size[ra] += self.size[rb];
            self.rank[ra] += 1;
        }
    }
}

/// Build undirected connected components via DSU (path compression + union by rank).
/// O(E α(V)).
pub fn build_undirected_cc(nav: &NavGraph) -> UndirectedComponents {
    let node_count = nav.nodes.len();
    if node_count == 0 {
        return UndirectedComponents {
            node_component: HashMap::new(),
            component_count: 0,
            largest_component_size: 0,
        };
    }

    let mut dsu = Dsu::new(node_count);

    for edge in nav.edges() {
        dsu.union(edge.from, edge.to);
    }

    // Assign component ids in root order (deterministic: sort roots by id)
    let mut root_to_component: HashMap<usize, usize> = HashMap::new();
    let mut component_count = 0usize;
    let mut node_component: HashMap<NavNodeId, usize> = HashMap::with_capacity(node_count);

    for nav_node_id in 0..node_count {
        let root = dsu.find(nav_node_id);
        let comp_id = *root_to_component.entry(root).or_insert_with(|| {
            let id = component_count;
            component_count += 1;
            id
        });
        node_component.insert(nav_node_id, comp_id);
    }

    let largest_component_size = root_to_component
        .keys()
        .map(|&root| dsu.size[root])
        .max()
        .unwrap_or(0);

    UndirectedComponents {
        node_component,
        component_count,
        largest_component_size,
    }
}
