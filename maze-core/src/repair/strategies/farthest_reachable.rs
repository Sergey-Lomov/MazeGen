use crate::ids::NodeId;
use crate::graph::nav::NavGraph;
use crate::graph::pathfinding::{dijkstra_forward, dijkstra_reverse};

/// Farthest node forward-reachable from `source` via directed BFS/Dijkstra — ties break toward
/// the lowest `NodeId` (Determinism Contract, `Specs/repair.md`). Falls back to `source` itself
/// when nothing else is reachable. Shared by `FarthestEndpointsStrategy` (GitHub issue #89) and
/// `MissingTeleportsStrategy`'s `entry_pick: farthest_from_random` (GitHub issue #212) — both need
/// "farthest node you can walk to from here" on the same directed `NavGraph`.
pub(crate) fn farthest_from(nav: &NavGraph, source: usize) -> NodeId {
    let dist = dijkstra_forward(nav, source);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[source].node_id)
}

/// Farthest node that can forward-reach `target` (reverse BFS/Dijkstra) — same tie-break and
/// fallback rules as `farthest_from`, mirrored for the incoming direction.
pub(crate) fn farthest_to(nav: &NavGraph, target: usize) -> NodeId {
    let dist = dijkstra_reverse(nav, target);
    dist.iter().enumerate()
        .filter(|&(_, &d)| d != usize::MAX)
        .max_by_key(|&(nav_id, &d)| (d, std::cmp::Reverse(nav.nodes[nav_id].node_id)))
        .map(|(nav_id, _)| nav.nodes[nav_id].node_id)
        .unwrap_or(nav.nodes[target].node_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Maze;
    use crate::graph::{Graph, EdgeKind};
    use crate::IdGenerator;
    use crate::space::{SquareTessellation, square_rect, MultiLevelField};

    fn nav_for(maze: &Maze<SquareTessellation>) -> NavGraph {
        maze.analysis.nav_graph(&maze.graph, &maze.meta)
    }

    #[test]
    fn farthest_from_breaks_ties_by_lowest_node_id() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        g.build_initial_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.build_initial_edge(nodes[0], nodes[2], EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        let farthest = farthest_from(&nav, source);
        assert_eq!(farthest, nodes[1], "tie between nodes[1]/nodes[2] must break toward the lower NodeId");
    }

    #[test]
    fn farthest_from_returns_source_itself_when_nothing_else_is_reachable() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        assert_eq!(farthest_from(&nav, source), nodes[0]);
    }

    #[test]
    fn farthest_to_finds_the_node_with_the_longest_incoming_path() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = field.field_of(field_level).unwrap().all_points().map(|p| field.node_at(field_level, p).unwrap()).collect();
        for i in 0..3 {
            g.build_initial_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        let maze: Maze<SquareTessellation> = Maze::new(field, g);
        let nav = nav_for(&maze);
        let target = nav.nav_node_for(nodes[3]).unwrap();
        assert_eq!(farthest_to(&nav, target), nodes[0], "node farthest upstream from the target via reverse BFS");
    }
}
