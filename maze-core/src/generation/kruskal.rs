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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};
    use crate::validation::is_connected;

    fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }

    fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

    #[test]
    fn kruskal_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        generate(&mut graph, &field, 42, &default_elements(), None);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn kruskal_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        generate(&mut g1, &field, 7, &default_elements(), None);
        generate(&mut g2, &field, 7, &default_elements(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }

    #[test]
    fn kruskal_produces_connected_graph() {
        let (field, mut graph) = make_field_and_graph(6, 6);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 99, &default_elements(), None);
        assert!(is_connected(&graph, start));
    }
}
