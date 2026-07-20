use std::collections::HashSet;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::graph::EdgeKind;

/// Counts distinct teleports on the field — shared by `MinTeleportCountCheck`/
/// `MinTeleportRatioCheck` (GitHub issue #211). A bidirectional teleport (`A->B` plus a parallel
/// `B->A`, both `EdgeKind::Teleport`) is one logical portal, not two: each direction is built as
/// its own `Teleport`-kind edge (see `maze-wasm/src/analytics.rs`'s
/// `build_graph_from_post_edit_edges` doc comment), so counting raw edges would double-count
/// every bidirectional teleport relative to a one-way teleport. Dedups by the unordered node pair
/// instead.
pub fn count_distinct_teleports<T: Tessellation>(maze: &Maze<T>) -> u32 {
    let mut seen_pairs: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut count = 0u32;
    for edge in maze.graph.edges().filter(|e| e.kind == EdgeKind::Teleport) {
        let pair = if edge.from <= edge.to { (edge.from, edge.to) } else { (edge.to, edge.from) };
        if seen_pairs.insert(pair) {
            count += 1;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};

    fn maze_with_edges(edges: &[(i32, i32, EdgeKind)]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        for (from, to, kind) in edges {
            g.add_edge(p(*from), p(*to), kind.clone());
        }
        Maze::new(field, g)
    }

    #[test]
    fn a_one_way_teleport_counts_as_one() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 1);
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport), (1, 0, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 1, "A<->B is one logical portal, not two");
    }

    #[test]
    fn two_independent_teleports_count_as_two() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Teleport), (2, 3, EdgeKind::Teleport)]);
        assert_eq!(count_distinct_teleports(&maze), 2);
    }

    #[test]
    fn a_basic_edge_is_ignored() {
        let maze = maze_with_edges(&[(0, 1, EdgeKind::Basic)]);
        assert_eq!(count_distinct_teleports(&maze), 0);
    }
}
