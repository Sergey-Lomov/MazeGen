use crate::Maze;
use crate::graph::distance_map::min_optional_distance;
use crate::graph::nav::{NavGraph, NavNodeId};
use crate::ids::NodeId;
use crate::quality_control::comparison::Comparison;
use crate::space::Tessellation;
use std::collections::HashMap;

/// Which waypoint(s) a waypoint-distance check instance measures distance against — shared shape
/// for `TeleportWaypointDistanceCheck`, `OneWayWaypointDistanceCheck`, and
/// `SplitDistanceFromWaypointCheck` (see GitHub issue #616).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waypoint {
    Start,
    Finish,
    /// Both — the check uses whichever of the two is closer (`min`), so a candidate too close to
    /// *either* waypoint is flagged, same "closest wins" reduction `Any` scoring uses elsewhere.
    Any,
}

/// Resolved distance-to-waypoint context for one `repair_check` call — builds the distance map(s)
/// `waypoint` needs once (via `MazeAnalysis::distance_from_start`/`distance_from_finish`), then
/// exposes `distance_to`/`distance_to_with_corridor_fallback` to reduce any node to its distance
/// from the relevant waypoint(s). Mirrors the identical `waypoint_distance` closure previously
/// duplicated across `TeleportWaypointDistanceCheck`, `OneWayWaypointDistanceCheck`, and
/// `SplitDistanceFromWaypointCheck`.
///
/// `new` returns `None` when the maze doesn't have the waypoint(s) this instance needs set
/// (`meta.start` for `Start`/`Any`, `meta.finish` for `Finish`/`Any`) — covered by
/// `MissingEndpointsCheck`; every caller should `return` early on `None`, same as before.
pub struct WaypointDistances {
    nav: NavGraph,
    dist_from_start: Option<HashMap<NavNodeId, usize>>,
    dist_from_finish: Option<HashMap<NavNodeId, usize>>,
}

impl WaypointDistances {
    pub fn new<T: Tessellation>(maze: &Maze<T>, waypoint: Waypoint) -> Option<Self> {
        let dist_from_start = maze.analysis.distance_from_start(&maze.graph, &maze.meta);
        let dist_from_finish = maze.analysis.distance_from_finish(&maze.graph, &maze.meta);
        let (need_start, need_finish) = match waypoint {
            Waypoint::Start => (true, false),
            Waypoint::Finish => (false, true),
            Waypoint::Any => (true, true),
        };
        if need_start && dist_from_start.is_none() {
            return None;
        }
        if need_finish && dist_from_finish.is_none() {
            return None;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        Some(Self {
            nav,
            dist_from_start: if need_start { dist_from_start } else { None },
            dist_from_finish: if need_finish { dist_from_finish } else { None },
        })
    }

    /// A node's distance to the closest relevant waypoint, or `None` if unreachable from every
    /// waypoint this instance cares about. Resolves `node_id` via `nav_node_for` only — a
    /// corridor-interior node has no `NavNodeId` and is never resolved here (see
    /// `distance_to_with_corridor_fallback` for the split-check variant that does fall back).
    pub fn distance_to(&self, node_id: NodeId) -> Option<usize> {
        let nav_id = self.nav.nav_node_for(node_id)?;
        self.distance_to_nav_node(nav_id)
    }

    /// Like `distance_to`, but falls back to `NavGraph::corridor_index` when `node_id` has no
    /// `NavNodeId` of its own — needed by `SplitDistanceFromWaypointCheck`, whose extra split node
    /// very often sits on a plain-corridor tile compressed into some other nav-edge's interior
    /// `path` (see GitHub issue #248's original bug report: without this fallback, the check
    /// silently never fired for the common split-node shape). This resolves to the nav node at the
    /// *end* of the corridor segment the node sits on — an approximation (off by however many
    /// tiles remain in that segment) accepted here for the same progression-space-proximity
    /// purpose `routing::resolve_nav_node` already uses it for, not an exact tile count.
    pub fn distance_to_with_corridor_fallback(&self, node_id: NodeId) -> Option<usize> {
        let nav_id = self
            .nav
            .nav_node_for(node_id)
            .or_else(|| self.nav.corridor_index.get(&node_id).copied())?;
        self.distance_to_nav_node(nav_id)
    }

    fn distance_to_nav_node(&self, nav_id: NavNodeId) -> Option<usize> {
        let mut best: Option<usize> = None;
        if let Some(map) = &self.dist_from_start {
            best = min_optional_distance(best, map.get(&nav_id).copied());
        }
        if let Some(map) = &self.dist_from_finish {
            best = min_optional_distance(best, map.get(&nav_id).copied());
        }
        best
    }
}

/// Reduces a candidate's own distance(s) (e.g. a two-ended element's `from`/`to`, or a split
/// point's every node) to the single closest one, then applies `comparison` against `threshold` —
/// the common "min of the candidate's own distances, then compare" step shared by every
/// waypoint-distance check.
pub fn waypoint_distance_matches(
    distances: impl IntoIterator<Item = Option<usize>>,
    comparison: Comparison,
    threshold: u32,
) -> bool {
    distances
        .into_iter()
        .fold(None, min_optional_distance)
        .is_some_and(|d| comparison.compare(d as u32, threshold))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::meta::MazeMeta;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use std::sync::Arc;

    /// start(0) -- 1 -- ... -- (width-1) along y=0, with `finish` set at the far end (so both
    /// `distance_from_start` and `distance_from_finish` are always defined), plus a branch off
    /// node 3 down to y=1 -- this makes node 3 an actual junction (degree 3, a real `NavNodeId`),
    /// while every other interior node stays a plain 2-degree corridor node with none of its own.
    fn maze_with_corridor(width: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(width, 2), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        let nodes: Vec<_> = (0..width as i32).map(p).collect();
        for x in 0..width as i32 - 1 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        let branch = field
            .node_at(field_level, SquarePoint { x: 3, y: 1 })
            .unwrap();
        g.add_bidirectional_edge(p(3), branch, EdgeKind::Basic);
        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(nodes[0]),
            finish: Some(*nodes.last().unwrap()),
        };
        (maze, nodes)
    }

    #[test]
    fn new_is_none_when_the_required_waypoint_is_missing() {
        let (mut maze, _) = maze_with_corridor(4);
        maze.meta.start = None;
        assert!(WaypointDistances::new(&maze, Waypoint::Start).is_none());
        assert!(
            WaypointDistances::new(&maze, Waypoint::Finish).is_some(),
            "Finish alone doesn't need start"
        );
        assert!(
            WaypointDistances::new(&maze, Waypoint::Any).is_none(),
            "Any needs both"
        );
    }

    #[test]
    fn distance_to_measures_from_the_selected_waypoint_only() {
        let (maze, nodes) = maze_with_corridor(6);
        let start_only = WaypointDistances::new(&maze, Waypoint::Start).unwrap();
        assert_eq!(start_only.distance_to(nodes[3]), Some(3));

        let finish_only = WaypointDistances::new(&maze, Waypoint::Finish).unwrap();
        assert_eq!(finish_only.distance_to(nodes[3]), Some(2));
    }

    #[test]
    fn any_takes_the_minimum_of_start_and_finish() {
        let (maze, nodes) = maze_with_corridor(6);
        let any = WaypointDistances::new(&maze, Waypoint::Any).unwrap();
        // width 6: node 3 is 3 tiles from start (node 0), 2 tiles from finish (node 5).
        assert_eq!(
            any.distance_to(nodes[3]),
            Some(2),
            "closer of the two must win"
        );
    }

    #[test]
    fn distance_to_is_none_for_an_unreachable_node() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        // Isolated pair, disconnected from start's component.
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        let (start_node, isolated_node) = (p(0), p(2));
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start_node),
            finish: None,
        };

        let distances = WaypointDistances::new(&maze, Waypoint::Start).unwrap();
        assert_eq!(distances.distance_to(isolated_node), None);
    }

    #[test]
    fn distance_to_with_corridor_fallback_resolves_a_corridor_interior_node() {
        // Node 1 is a plain 2-degree corridor node (no branch, unlike node 3) -- it has no
        // NavNodeId of its own, so distance_to (nav_node_for only) must fail to resolve it, while
        // the corridor-fallback variant must still succeed.
        let (maze, nodes) = maze_with_corridor(6);
        let distances = WaypointDistances::new(&maze, Waypoint::Start).unwrap();
        let interior = nodes[1];
        assert_eq!(
            distances.distance_to(interior),
            None,
            "a plain corridor-interior node has no NavNodeId of its own"
        );
        assert_eq!(
            distances.distance_to_with_corridor_fallback(interior),
            Some(3),
            "corridor fallback resolves to the nav node at the END of node 1's corridor segment \
             (node 3, the nearest junction), not node 1's own exact tile distance -- see this \
             method's own doc comment on the approximation"
        );
    }

    #[test]
    fn waypoint_distance_matches_takes_the_min_across_candidates_then_compares() {
        assert!(waypoint_distance_matches(
            [Some(5), Some(2)],
            Comparison::Lt,
            3
        ));
        assert!(!waypoint_distance_matches(
            [Some(5), Some(4)],
            Comparison::Lt,
            3
        ));
    }

    #[test]
    fn waypoint_distance_matches_is_false_when_every_candidate_is_unreachable() {
        assert!(!waypoint_distance_matches(
            [None, None],
            Comparison::Lt,
            1000
        ));
    }
}
