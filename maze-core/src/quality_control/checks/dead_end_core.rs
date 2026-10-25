use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;

/// Returns nodes with exactly one traversable outgoing edge whose target has a reverse edge of
/// the same kind. Parallel outgoing edges do not qualify: the definition counts edges, not just
/// distinct neighbors.
pub(crate) fn dead_end_nodes<T: Tessellation>(maze: &Maze<T>) -> Vec<NodeId> {
    maze.field
        .all_node_ids()
        .filter(|&node| {
            let mut outgoing = maze.graph.outgoing_edges(node);
            let Some(edge) = outgoing.next() else {
                return false;
            };
            outgoing.next().is_none()
                && maze
                    .graph
                    .outgoing_edges(edge.to)
                    .any(|reverse| reverse.to == node && reverse.kind == edge.kind)
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
    fn requires_one_outgoing_edge_and_a_same_kind_reverse_edge() {
        let (mut maze, nodes) = maze();
        maze.graph.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        maze.graph.add_edge(nodes[1], nodes[0], EdgeKind::Basic);
        maze.graph.add_edge(nodes[2], nodes[3], EdgeKind::Basic);
        maze.graph.add_edge(nodes[3], nodes[2], EdgeKind::Teleport);
        maze.graph.add_edge(nodes[1], nodes[2], EdgeKind::Basic);

        assert_eq!(dead_end_nodes(&maze), vec![nodes[0]]);
    }
}
