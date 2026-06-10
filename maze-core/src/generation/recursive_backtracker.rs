use std::collections::HashSet;
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
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut stack: Vec<NodeId> = vec![start];
    visited.insert(start);
    let mut rng = SmallRng::seed_from_u64(seed);

    while let Some(&current) = stack.last() {
        let unvisited: Vec<NodeId> = field
            .neighbors(current)
            .into_iter()
            .filter(|n| !visited.contains(n))
            .collect();

        if unvisited.is_empty() {
            stack.pop();
        } else {
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            add_edge(graph, current, chosen, elements, &mut rng);
            visited.insert(chosen);
            stack.push(chosen);
            if let Some(ref mut cb) = on_step { cb(graph); }
        }
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
    fn recursive_backtracker_visits_all_nodes() {
        let (field, mut graph) = make_field_and_graph(5, 5);
        let node_count = graph.nodes().count();
        let start = field.node_at(crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        generate(&mut graph, &field, 42, start, &default_elements(), None);
        // Perfect maze: exactly node_count - 1 bidirectional corridors = 2*(node_count-1) directed edges
        assert_eq!(graph.edges().count(), 2 * (node_count - 1));
    }

    #[test]
    fn recursive_backtracker_is_deterministic() {
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
