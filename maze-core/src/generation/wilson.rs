use std::collections::{HashSet, HashMap};
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
    start: NodeId,
    elements: &ElementsConfig,
    mut on_step: Option<&mut dyn FnMut(&Graph)>,
) {
    let all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = SmallRng::seed_from_u64(seed);

    visited.insert(start);

    // Build list of unvisited nodes in a stable order for determinism.
    // We pick a random index from this list each outer iteration.
    let mut unvisited: Vec<NodeId> = all_nodes.iter().copied().filter(|&n| n != start).collect();

    while !unvisited.is_empty() {
        // Pick a random unvisited node to start a random walk from.
        let pick_idx = rng.random_range(0..unvisited.len());
        let walk_start = unvisited[pick_idx];

        // Loop-erased random walk until we hit a visited node.
        // next[node] = the node we stepped to from node during the walk.
        let mut next: HashMap<NodeId, NodeId> = HashMap::new();
        let mut current = walk_start;
        loop {
            let neighbors = field.neighbors(current);
            let chosen = neighbors[rng.random_range(0..neighbors.len())];
            next.insert(current, chosen);
            if visited.contains(&chosen) {
                break;
            }
            current = chosen;
        }

        // Commit the loop-erased path: walk from walk_start following next[] until visited.
        let mut node = walk_start;
        while !visited.contains(&node) {
            let dst = next[&node];
            add_edge(graph, node, dst, elements, &mut rng);
            visited.insert(node);
            if let Some(ref mut cb) = on_step { cb(graph); }
            node = dst;
        }

        unvisited.retain(|n| !visited.contains(n));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::{Field, SquareTessellation, square_rect};

    fn make_field_and_graph(w: usize, h: usize) -> (Field<SquareTessellation>, Graph) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(w, h), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        (field, graph)
    }

    fn default_elements() -> ElementsConfig { ElementsConfig { one_way_chance: 0.0 } }

    #[test]
    fn wilson_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_elements(), None);
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn wilson_is_deterministic() {
        let (field, mut g1) = make_field_and_graph(4, 4);
        let (_, mut g2) = make_field_and_graph(4, 4);
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut g1, &field, 7, start, &default_elements(), None);
        generate(&mut g2, &field, 7, start, &default_elements(), None);
        let mut e1: Vec<_> = g1.edges().map(|e| (e.from, e.to)).collect();
        let mut e2: Vec<_> = g2.edges().map(|e| (e.from, e.to)).collect();
        e1.sort();
        e2.sort();
        assert_eq!(e1, e2);
    }
}
