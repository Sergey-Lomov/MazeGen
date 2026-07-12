use crate::Maze;
use crate::ids::EdgeId;
use crate::space::Tessellation;
use crate::generation::PresetState;

/// Candidate edges for cutting within one cycle: must still exist in the graph (an earlier cut
/// in this same `apply` may have already removed it) and must not be preset-protected.
pub(super) fn candidate_edges<T: Tessellation>(
    cycle: &[EdgeId],
    maze: &Maze<T>,
    preset_state: &PresetState,
) -> Vec<EdgeId> {
    cycle.iter().copied()
        .filter(|&id| maze.graph.edge(id).is_some())
        .filter(|&id| {
            let edge = maze.graph.edge(id).expect("checked above");
            !preset_state.preset_edges.contains(&(edge.from, edge.to))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::space::{SquareTessellation, square_rect, Field};
    use crate::IdGenerator;

    fn make_maze_and_edges(n: usize) -> (Maze<SquareTessellation>, Vec<EdgeId>) {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(n, 1), &mut ids).unwrap();
        let mut graph = Graph::new();
        field.build_nodes(&mut graph);
        let nodes: Vec<_> = field.all_points().map(|p| field.node_at(p).unwrap()).collect();
        let mut edge_ids = Vec::new();
        for i in 0..n - 1 {
            edge_ids.push(graph.add_edge(nodes[i], nodes[i + 1], EdgeKind::Basic));
        }
        (Maze::new(field, graph), edge_ids)
    }

    #[test]
    fn candidate_edges_filters_out_removed_edges() {
        let (mut maze, edges) = make_maze_and_edges(3);
        maze.graph.remove_edge(edges[0]);
        let candidates = candidate_edges(&edges, &maze, &PresetState::empty());
        assert_eq!(candidates, vec![edges[1]]);
    }

    #[test]
    fn candidate_edges_filters_out_preset_protected_edges() {
        let (maze, edges) = make_maze_and_edges(3);
        let edge0 = maze.graph.edge(edges[0]).unwrap();
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((edge0.from, edge0.to));
        let candidates = candidate_edges(&edges, &maze, &preset_state);
        assert_eq!(candidates, vec![edges[1]]);
    }

    #[test]
    fn candidate_edges_returns_all_when_nothing_filtered() {
        let (maze, edges) = make_maze_and_edges(3);
        let candidates = candidate_edges(&edges, &maze, &PresetState::empty());
        assert_eq!(candidates, edges);
    }

    #[test]
    fn candidate_edges_empty_cycle_returns_empty() {
        let (maze, _) = make_maze_and_edges(3);
        let candidates = candidate_edges(&[], &maze, &PresetState::empty());
        assert!(candidates.is_empty());
    }
}
