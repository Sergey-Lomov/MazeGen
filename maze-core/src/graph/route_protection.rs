use std::collections::HashSet;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;

/// True if `edge_id` is one of the hops on the maze's current start->finish route (per
/// `MazeAnalysis::route_info`, reusing its cache rather than recomputing the path). `false` when
/// either endpoint is unset, the edge no longer exists, or no route currently connects them.
///
/// `pub`, not just an internal step of `is_teleport_route_protected`: any strategy protecting
/// route hops from a non-teleport mutation (e.g. `RegionShrinkSplitStrategy`'s split-edge
/// selection, which must never sever the critical path) needs the same check for `Basic` edges.
pub fn is_edge_on_route<T: Tessellation>(maze: &Maze<T>, edge_id: EdgeId) -> bool {
    let Some(edge) = maze.graph.edge(edge_id) else { return false; };
    let Some(route) = maze.analysis.route_info(&maze.graph, &maze.field, &maze.meta) else { return false; };

    let hops: HashSet<(NodeId, NodeId)> = route.path.windows(2)
        .map(|w| (w[0], w[1]))
        .collect();
    hops.contains(&(edge.from, edge.to))
}

/// True if `edge_id` (a `Teleport` edge) is protected by the maze's current start->finish route:
/// either the edge itself is a route hop, or — for a two-way teleport — its opposite-direction
/// counterpart is. A two-way teleport is two independent `EdgeId`s in the base `Graph` (no
/// `reverse_edge` link like `NavEdge` has), so protecting only the direction that happens to sit
/// on the route would leave the other direction unprotected, silently downgrading the teleport
/// from two-way to one-way instead of treating it as fully route-critical.
///
/// Used by every per-teleport `Check` (GitHub issue #78's `protect_route` param) to decide
/// whether a teleport is even eligible to be flagged in the first place — protection lives on
/// the producing check, not on `RemoveTeleportStrategy`/`TeleportGroupSelectStrategy` (the
/// group-proximity strategy is the one exception, using this to redirect *which* side of an
/// already-flagged pair gets removed).
pub fn is_teleport_route_protected<T: Tessellation>(maze: &Maze<T>, edge_id: EdgeId) -> bool {
    if is_edge_on_route(maze, edge_id) {
        return true;
    }
    match maze.graph.teleport_reverse(edge_id) {
        Some(reverse_id) => is_edge_on_route(maze, reverse_id),
        None => false,
    }
}

/// If `a`/`b` are adjacent on the maze's current start->finish route (in either order), returns
/// `Some((from, to))` naming the direction the route actually walks the pair in — `route.path` is
/// ordered start->finish (see `RouteInfo::path`'s doc comment), so the hop direction is read
/// directly off consecutive `path` entries rather than inferred. Returns `None` if the pair isn't
/// a route hop at all, or no route currently exists.
///
/// Used by a strategy that must downgrade a route-critical passage to a one-way without severing
/// the route — the removed direction must be the *other* one, never the route's own direction
/// (`MissingOneWaysFromPassageStrategy`, GitHub issue #201's follow-up).
pub fn route_direction<T: Tessellation>(maze: &Maze<T>, a: NodeId, b: NodeId) -> Option<(NodeId, NodeId)> {
    let route = maze.analysis.route_info(&maze.graph, &maze.field, &maze.meta)?;
    route.path.windows(2).find_map(|w| {
        let (from, to) = (w[0], w[1]);
        if (from, to) == (a, b) || (from, to) == (b, a) {
            Some((from, to))
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, EdgeKind};
    use crate::meta::MazeMeta;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::IdGenerator;

    /// 1x3 corridor: n0 -> n1 -> n2, start = n0, finish = n2.
    fn maze_with_corridor_route() -> (Maze<SquareTessellation>, NodeId, NodeId, NodeId) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let (n0, n1, n2) = (p(0), p(1), p(2));
        g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
        g.add_bidirectional_edge(n1, n2, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(n0), finish: Some(n2), route_score: None };
        (maze, n0, n1, n2)
    }

    #[test]
    fn route_direction_returns_the_routes_own_order_regardless_of_argument_order() {
        let (maze, n0, n1, _) = maze_with_corridor_route();
        assert_eq!(route_direction(&maze, n0, n1), Some((n0, n1)), "args already in route order");
        assert_eq!(route_direction(&maze, n1, n0), Some((n0, n1)), "args reversed from route order must still resolve to the route's own (from, to)");
    }

    #[test]
    fn route_direction_resolves_every_hop_on_a_multi_hop_route() {
        let (maze, n0, n1, n2) = maze_with_corridor_route();
        assert_eq!(route_direction(&maze, n0, n1), Some((n0, n1)));
        assert_eq!(route_direction(&maze, n1, n2), Some((n1, n2)));
    }

    #[test]
    fn route_direction_is_none_for_a_pair_not_on_the_route() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 2), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32, y: i32| field.node_at(SquarePoint { x, y }).unwrap();
        let (n0, n1) = (p(0, 0), p(1, 0));
        let (n2, n3) = (p(0, 1), p(1, 1));
        g.add_bidirectional_edge(n0, n1, EdgeKind::Basic);
        g.add_bidirectional_edge(n2, n3, EdgeKind::Basic);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(n0), finish: Some(n1), route_score: None };

        // n2/n3 form a disconnected side passage, never touched by the n0->n1 route.
        assert_eq!(route_direction(&maze, n2, n3), None);
    }

    #[test]
    fn route_direction_is_none_when_no_route_exists() {
        let (maze, n0, n1, _) = maze_with_corridor_route();
        let mut maze = maze;
        maze.meta.finish = None;
        assert_eq!(route_direction(&maze, n0, n1), None, "no finish set -> no route -> None");
    }

    #[test]
    fn route_direction_is_none_for_non_adjacent_route_nodes() {
        // n0 and n2 are both on the route but not consecutive hop endpoints (n1 sits between).
        let (maze, n0, _, n2) = maze_with_corridor_route();
        assert_eq!(route_direction(&maze, n0, n2), None);
    }
}
