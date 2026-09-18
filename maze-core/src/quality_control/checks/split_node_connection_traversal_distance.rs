use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitRouteIssue, SplitRouteEdge};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::{HashMap, VecDeque};

pub const SPLIT_NODE_CONNECTION_TRAVERSAL_DISTANCE_MIN_DETOUR_DEFAULT: u32 = 10;

/// Flags a pair of split nodes belonging to the same split tile connected by a graph path shorter
/// than `min_detour - 1` steps — see GitHub issue #277, part of epic #246. A short path between two
/// nodes of the same tile suggests the split doesn't meaningfully separate its own paths, defeating
/// the point of splitting that tile.
///
/// Uses the raw directed `maze.graph` (outgoing edges only), not the corridor-compressed
/// `NavGraph` — same "count every real hop" rationale `MissingTeleportsStrategy::bfs_distances`
/// uses, mirrored here rather than reused since this check needs early-exit-capped BFS plus the
/// actual full path found, not just a distance map.
///
/// For each ordered pair of a tile's split nodes `(a, b)`, `a != b`, runs a BFS from `a` capped at
/// `min_detour - 1` steps with early exit as soon as `b` is reached. If reached, the whole found
/// path is flagged as one route: an ordered `Vec<SplitRouteEdge>` from `a` to `b`, each edge paired
/// with whether it's incident to this split tile's own point (`from`/`to` resolves to it) — lets a
/// repair strategy tell "the split's own connection" apart from "some other passage the route
/// happens to cross." Both directions (`a -> b` and `b -> a`) are checked independently and, when
/// both are found short, recorded as two separate routes — directed edges mean a short path one way
/// doesn't guarantee one the other way, and each route may need its own cut.
pub struct SplitNodeConnectionTraversalDistanceCheck {
    pub instance_id: String,
    /// Minimum number of steps a path between two of the same tile's split nodes must take —
    /// a path of `min_detour - 1` steps or fewer is flagged.
    pub min_detour: u32,
}

/// BFS from `source` over `maze.graph`'s outgoing edges, capped at `max_steps`, with early exit
/// once `target` is found. Returns the full ordered edge sequence of the shortest found path
/// (`source` to `target`), or `None` if no path within `max_steps` exists.
fn capped_path<T: Tessellation>(
    maze: &Maze<T>,
    source: NodeId,
    target: NodeId,
    max_steps: usize,
) -> Option<Vec<EdgeId>> {
    if max_steps == 0 {
        return None;
    }

    // parent[node] = (previous node, edge used to reach `node` from it).
    let mut parent: HashMap<NodeId, (NodeId, EdgeId)> = HashMap::new();
    let mut queue: VecDeque<(NodeId, usize)> = VecDeque::new();
    queue.push_back((source, 0));

    while let Some((node, steps)) = queue.pop_front() {
        if node == target {
            let mut path = Vec::new();
            let mut current = target;
            while current != source {
                let (prev, edge) = parent[&current];
                path.push(edge);
                current = prev;
            }
            path.reverse();
            return Some(path);
        }
        if steps == max_steps {
            continue;
        }
        for edge in maze.graph.outgoing_edges(node) {
            if edge.to == source || parent.contains_key(&edge.to) {
                continue;
            }
            parent.insert(edge.to, (node, edge.id));
            queue.push_back((edge.to, steps + 1));
        }
    }
    None
}

impl<T: Tessellation> Check<T, InvalidSplitRouteIssue>
    for SplitNodeConnectionTraversalDistanceCheck
{
    fn check_type_id(&self) -> &'static str {
        "split_node_connection_traversal_distance"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitRouteIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let max_steps = self.min_detour.saturating_sub(1) as usize;

        let mut seen_points = std::collections::HashSet::new();
        let split_points: Vec<(crate::space::LevelId, T::Point)> = maze
            .field
            .all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter(|&(level, point)| maze.field.nodes_at(level, point).len() >= 2)
            .collect();
        if split_points.is_empty() {
            return;
        }

        let mut routes: Vec<Vec<SplitRouteEdge>> = Vec::new();

        for &(level, point) in &split_points {
            let nodes = maze.field.nodes_at(level, point);
            for &a in nodes {
                for &b in nodes {
                    if a == b {
                        continue;
                    }
                    if let Some(path) = capped_path(maze, a, b, max_steps) {
                        let route: Vec<SplitRouteEdge> = path
                            .into_iter()
                            .map(|edge_id| {
                                let is_split_edge = maze.graph.edge(edge_id).is_some_and(|e| {
                                    maze.field.point_of(e.from) == Some(point)
                                        || maze.field.point_of(e.to) == Some(point)
                                });
                                (edge_id, is_split_edge)
                            })
                            .collect();
                        routes.push(route);
                    }
                }
            }
        }

        if routes.is_empty() {
            return;
        }
        let issue = InvalidSplitRouteIssue::new_from_check(&self.instance_id, routes).with_detail(
            &self.instance_id,
            "min_detour",
            self.min_detour.to_string(),
        );
        issues.push(issue);
    }
}

#[cfg(test)]
#[path = "split_node_connection_traversal_distance_tests.rs"]
mod tests;
