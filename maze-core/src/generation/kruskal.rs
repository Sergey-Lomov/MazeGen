use std::collections::{BTreeSet, HashMap};
use rand::{Rng, SeedableRng};
use rand::rngs::SmallRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use super::{ElementsConfig, add_edge};

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    elements: &ElementsConfig,
    mut on_step: Option<&mut dyn FnMut(&Graph)>,
) {
    let mut rng = SmallRng::seed_from_u64(seed);

    // Collect all unique undirected edges in sorted order for determinism.
    let mut edge_set: BTreeSet<(NodeId, NodeId)> = BTreeSet::new();
    for node in graph.nodes().map(|n| n.id).collect::<Vec<_>>() {
        for neighbor in field.neighbors(node) {
            let pair = if node < neighbor { (node, neighbor) } else { (neighbor, node) };
            edge_set.insert(pair);
        }
    }

    // Shuffle edges for randomness.
    let mut edges: Vec<(NodeId, NodeId)> = edge_set.into_iter().collect();
    for i in (1..edges.len()).rev() {
        let j = rng.random_range(0..=i);
        edges.swap(i, j);
    }

    // Union-Find: parent map, path-compressed find.
    let mut parent: HashMap<NodeId, NodeId> = graph.nodes().map(|n| (n.id, n.id)).collect();

    fn find(parent: &mut HashMap<NodeId, NodeId>, mut x: NodeId) -> NodeId {
        while parent[&x] != x {
            let gp = parent[&parent[&x]];
            *parent.get_mut(&x).unwrap() = gp;
            x = gp;
        }
        x
    }

    for (a, b) in edges {
        let ra = find(&mut parent, a);
        let rb = find(&mut parent, b);
        if ra != rb {
            // Merge smaller into larger (union by id — deterministic).
            if ra < rb { *parent.get_mut(&rb).unwrap() = ra; }
            else       { *parent.get_mut(&ra).unwrap() = rb; }
            add_edge(graph, a, b, elements, &mut rng);
            if let Some(ref mut cb) = on_step { cb(graph); }
        }
    }
}
