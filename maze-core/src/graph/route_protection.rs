use std::collections::HashSet;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;

/// True if `edge_id` is one of the hops on the maze's current start->finish route (per
/// `MazeAnalysis::route_info`, reusing its cache rather than recomputing the path). `false` when
/// either endpoint is unset, the edge no longer exists, or no route currently connects them.
fn is_edge_on_route<T: Tessellation>(maze: &Maze<T>, edge_id: EdgeId) -> bool {
    let Some(edge) = maze.graph.edge(edge_id) else { return false; };
    let Some(route) = maze.analysis.route_info(&maze.graph, &maze.meta) else { return false; };

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
/// the producing check, not on `RemoveTeleportStrategy`/`TeleportGroupProximityStrategy` (the
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
