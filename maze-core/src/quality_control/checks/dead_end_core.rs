use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;

/// Returns nodes with exactly one distinct outgoing neighbor whose target has a reverse edge back
/// to the node. Incoming-only connections do not affect the classification, and parallel edges to
/// the same target still count as one neighbor.
pub(crate) fn dead_end_nodes<T: Tessellation>(maze: &Maze<T>) -> Vec<NodeId> {
    maze.field
        .all_node_ids()
        .filter(|&node| {
            let mut outgoing = maze.graph.outgoing_neighbors(node);
            let Some(neighbor) = outgoing.next() else {
                return false;
            };
            outgoing.all(|other| other == neighbor)
                && maze
                    .graph
                    .outgoing_neighbors(neighbor)
                    .any(|reverse| reverse == node)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IdGenerator;
    use crate::graph::{EdgeKind, Graph};
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use std::sync::Arc;

    fn maze() -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let nodes = (0..4)
            .map(|x| field.node_at(level, SquarePoint { x, y: 0 }).unwrap())
            .collect::<Vec<_>>();
        let mut graph = Graph::new();
        for &node in &nodes {
            graph.add_node(node);
        }
        (Maze::new(field, graph), nodes)
    }

    #[test]
    fn requires_one_distinct_outgoing_neighbor_with_a_reverse_edge() {
        let (mut maze, nodes) = maze();
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        maze.graph.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        maze.graph.add_edge(nodes[3], nodes[2], EdgeKind::Teleport);
        maze.graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Teleport);

        assert_eq!(dead_end_nodes(&maze), vec![nodes[0], nodes[2], nodes[3]]);
    }

    #[test]
    fn incoming_only_edges_do_not_change_a_dead_end() {
        let (mut maze, nodes) = maze();
        maze.graph
            .add_bidirectional_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.add_edge(nodes[2], nodes[0], EdgeKind::Teleport);

        assert!(dead_end_nodes(&maze).contains(&nodes[0]));
    }

    #[test]
    fn requires_a_reverse_edge_from_the_only_outgoing_neighbor() {
        let (mut maze, nodes) = maze();
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);

        assert!(!dead_end_nodes(&maze).contains(&nodes[0]));
    }
}
