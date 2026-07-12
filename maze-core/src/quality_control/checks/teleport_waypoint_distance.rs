use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::min_optional_distance;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{Issue, InvalidTeleportIssue};

pub const TELEPORT_WAYPOINT_DISTANCE_DEFAULT: u32 = 0;

/// Which waypoint(s) a `TeleportWaypointDistanceCheck` instance measures distance against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportWaypoint {
    Start,
    Finish,
    /// Both — the check uses whichever of the two is closer (`min`), so a teleport too close to
    /// *either* waypoint is flagged, same "closest wins" reduction `Any` scoring uses elsewhere.
    Any,
}

/// Which end(s) of a teleport edge a `TeleportWaypointDistanceCheck` instance measures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeleportEdgeSelector {
    EntryOnly,
    /// Both ends — flags the teleport if *either* end (`min`) is too close.
    EntryOrExit,
}

/// Flags a teleport edge placed too close to a waypoint (start/finish) in progression space —
/// see GitHub issue #74. Multiple instances may be active at once (different `waypoint`/`edge`/
/// `distance` combinations are all legitimate simultaneously, e.g. "entry must be far from start"
/// AND separately "exit must be far from finish").
///
/// Distance is logical (tile count via the shared distance maps — see `graph-analytics.md`'s
/// "Distance Maps" section), never geometric. A teleport endpoint unreachable from the relevant
/// waypoint (absent from the distance map) is treated as having no defined distance and is never
/// flagged for that waypoint — symmetric with `LoopDistanceFromStartCheck`'s "cycle has no
/// defined distance" rule for unreachable touched nodes.
pub struct TeleportWaypointDistanceCheck {
    pub instance_id: String,
    pub distance: u32,
    pub waypoint: TeleportWaypoint,
    pub edge: TeleportEdgeSelector,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportWaypointDistanceCheck {
    fn check_type_id(&self) -> &'static str { "teleport_waypoint_distance" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidTeleportIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let dist_from_start = maze.analysis.distance_from_start(&maze.graph, &maze.meta);
        let dist_from_finish = maze.analysis.distance_from_finish(&maze.graph, &maze.meta);
        let (need_start, need_finish) = match self.waypoint {
            TeleportWaypoint::Start => (true, false),
            TeleportWaypoint::Finish => (false, true),
            TeleportWaypoint::Any => (true, true),
        };
        // Silently skip if the maze doesn't have the waypoint(s) this instance needs set —
        // covered by MissingEndpointsCheck, same rationale as the loop-distance checks.
        if need_start && dist_from_start.is_none() { return; }
        if need_finish && dist_from_finish.is_none() { return; }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        // A node's distance to the closest relevant waypoint, or None if unreachable from every
        // waypoint this instance cares about.
        let waypoint_distance = |node_id: crate::ids::NodeId| -> Option<usize> {
            let nav_id = nav.nav_node_for(node_id)?;
            let mut best: Option<usize> = None;
            if need_start {
                best = min_optional_distance(best, dist_from_start.as_ref().and_then(|m| m.get(&nav_id)).copied());
            }
            if need_finish {
                best = min_optional_distance(best, dist_from_finish.as_ref().and_then(|m| m.get(&nav_id)).copied());
            }
            best
        };

        let invalid: Vec<_> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|t| {
                let entry_dist = waypoint_distance(t.from);
                let exit_dist = match self.edge {
                    TeleportEdgeSelector::EntryOnly => None,
                    TeleportEdgeSelector::EntryOrExit => waypoint_distance(t.to),
                };
                min_optional_distance(entry_dist, exit_dist).is_some_and(|d| d < self.distance as usize)
            })
            .filter(|t| !self.protect_route || !is_teleport_route_protected(maze, t.id))
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidTeleportIssue::new_from_check(&self.instance_id, invalid)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::meta::MazeMeta;

    const TEST_ID: &str = "teleport_waypoint_distance";

    /// start(0) -- 1 -- 2 -- ... -- (teleport_from) ... teleport to a far node, independent
    /// of the corridor. `teleport_from` sits at `entry_distance` tiles from start.
    fn maze_with_teleport_entry_at_distance(entry_distance: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let width = entry_distance + 2;
        let field: Field<SquareTessellation> = Field::new(square_rect(width, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        let nodes: Vec<_> = (0..width as i32).map(p).collect();
        for x in 0..entry_distance as i32 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Teleport from the last corridor node to some other node (last one in the field).
        let far = p(width as i32 - 1);
        let entry = p(entry_distance as i32);
        g.add_edge(entry, far, EdgeKind::Teleport);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(nodes[0]), finish: None, route_score: None };
        (maze, nodes)
    }

    #[test]
    fn fires_when_entry_closer_than_threshold_from_start() {
        let (maze, _) = maze_with_teleport_entry_at_distance(2);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    }

    #[test]
    fn silent_when_entry_farther_than_threshold_from_start() {
        let (maze, _) = maze_with_teleport_entry_at_distance(10);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn entry_only_ignores_exit_distance() {
        // Entry is far from start (10 tiles), exit is the teleport target which happens to be
        // geometrically far too (no path back) -- with EntryOnly, only entry's distance matters,
        // and entry is far, so no issue even though exit is technically "closer" in this setup
        // (unreachable, so it wouldn't count anyway -- this asserts EntryOnly never looks at exit).
        let (maze, _) = maze_with_teleport_entry_at_distance(10);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn entry_or_exit_flags_when_only_exit_is_close() {
        // Build so the teleport's exit is close to start via a separate path, even though entry
        // is far -- EntryOrExit must catch it via the exit side.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(12, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        // start -- 1 -- 2 (exit, distance 2 from start)
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        // entry is far out at node 10, teleport entry(10) -> exit(2)
        g.add_edge(p(10), p(2), EdgeKind::Teleport);
        let start = p(0);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(start), finish: None, route_score: None };

        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOrExit,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "exit at distance 2 from start must be caught even though entry is unreachable/far");
    }

    #[test]
    fn waypoint_any_uses_the_closer_of_start_and_finish() {
        // finish is very close to the teleport entry, start is far -- Any must catch it via finish.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(12, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        // finish(0) -- 1 -- 2 (entry, distance 2 from finish, following reverse edges)
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        // far start, unrelated to this corridor
        g.add_bidirectional_edge(p(10), p(11), EdgeKind::Basic);
        let entry = p(2);
        g.add_edge(entry, p(11), EdgeKind::Teleport);
        let (start, finish) = (p(10), p(0));

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(start), finish: Some(finish), route_score: None };

        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Any,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "entry is 2 tiles from finish (reverse-reachable) even though far from start");
    }

    #[test]
    fn protect_route_excludes_a_route_critical_teleport() {
        // finish set at the far node -- the teleport entry->far is the maze's only route from
        // start to finish (no corridor connects entry to far otherwise). With protect_route
        // enabled it must not be flagged even though it's otherwise close enough to start.
        let (mut maze, nodes) = maze_with_teleport_entry_at_distance(2);
        let far = *nodes.last().unwrap();
        maze.meta.finish = Some(far);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "route-critical teleport must not be flagged when protect_route is enabled");
    }

    #[test]
    fn protect_route_disabled_flags_the_route_teleport_as_before() {
        let (mut maze, nodes) = maze_with_teleport_entry_at_distance(2);
        let far = *nodes.last().unwrap();
        maze.meta.finish = Some(far);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: false,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "protect_route disabled must flag the teleport exactly like before #78");
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let (maze, _) = maze_with_teleport_entry_at_distance(0);
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 0,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "a threshold of 0 should never flag any teleport");
    }

    #[test]
    fn silent_when_required_waypoint_is_missing() {
        let (mut maze, _) = maze_with_teleport_entry_at_distance(0);
        maze.meta.start = None;
        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 100,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "missing start is MissingEndpointsCheck's job");
    }

    #[test]
    fn silent_when_teleport_endpoint_unreachable_from_waypoint() {
        // Entry node has no path back to/from start at all (one-way corridor away from start,
        // teleport starts past a one-way wall) -- distance map has no entry for it.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        // Isolated pair -- no edge at all connects it to start's component.
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        g.add_edge(p(2), p(3), EdgeKind::Teleport);
        let start = p(0);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta { start: Some(start), finish: None, route_score: None };

        let check = TeleportWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000,
            waypoint: TeleportWaypoint::Start,
            edge: TeleportEdgeSelector::EntryOnly,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "unreachable entry must not be treated as distance 0");
    }
}
