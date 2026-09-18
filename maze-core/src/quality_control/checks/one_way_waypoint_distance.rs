use crate::Maze;
use crate::graph::distance_map::min_optional_distance;
use crate::graph::route_protection::is_edge_on_route;
use crate::quality_control::InvalidOneWayIssue;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edges_with_endpoints;
use crate::quality_control::comparison::Comparison;
use crate::space::Tessellation;
use rand::RngCore;

pub const ONE_WAY_WAYPOINT_DISTANCE_DEFAULT: u32 = 0;
pub const ONE_WAY_WAYPOINT_DISTANCE_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Which waypoint(s) an `OneWayWaypointDistanceCheck` instance measures distance against — mirrors
/// `TeleportWaypoint`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OneWayWaypoint {
    Start,
    Finish,
    /// Both — the check uses whichever of the two is closer (`min`).
    Any,
}

/// Flags a one-way passage edge (`EdgeKind::Basic`, single direction) placed too close to a
/// waypoint (start/finish) in progression space — see GitHub issue #198. Multiple instances may
/// be active at once (different `waypoint`/`distance`/`comparison` combinations are all
/// legitimate simultaneously).
///
/// Unlike `TeleportWaypointDistanceCheck`, there is no edge-role selector: a one-way edge is
/// flagged if *either* of its two endpoints (`from` or `to`, `min`) compares against the
/// threshold — there is no "entry"/"exit" distinction meaningful for a plain directed passage the
/// way there is for a teleport jump.
///
/// Distance is logical (tile count via the shared distance maps — see `graph-analytics.md`'s
/// "Distance Maps" section), never geometric. An endpoint unreachable from the relevant waypoint
/// (absent from the distance map) is treated as having no defined distance and is never flagged
/// for that waypoint — symmetric with `TeleportWaypointDistanceCheck`'s same rule.
pub struct OneWayWaypointDistanceCheck {
    pub instance_id: String,
    pub distance: u32,
    /// `Lt` flags "too close"; other operators let a user flag "too far" (`Gt`) or other relations.
    pub comparison: Comparison,
    pub waypoint: OneWayWaypoint,
    /// GitHub issue #198's path protection: a one-way edge lying on the maze's current
    /// start->finish route (`is_edge_on_route`) is never included in `invalid`, so the check never
    /// proposes repairing the only route through the maze.
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidOneWayIssue> for OneWayWaypointDistanceCheck {
    fn check_type_id(&self) -> &'static str {
        "one_way_waypoint_distance"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidOneWayIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let dist_from_start = maze.analysis.distance_from_start(&maze.graph, &maze.meta);
        let dist_from_finish = maze.analysis.distance_from_finish(&maze.graph, &maze.meta);
        let (need_start, need_finish) = match self.waypoint {
            OneWayWaypoint::Start => (true, false),
            OneWayWaypoint::Finish => (false, true),
            OneWayWaypoint::Any => (true, true),
        };
        // Silently skip if the maze doesn't have the waypoint(s) this instance needs set —
        // covered by MissingEndpointsCheck, same rationale as the teleport waypoint-distance check.
        if need_start && dist_from_start.is_none() {
            return;
        }
        if need_finish && dist_from_finish.is_none() {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let waypoint_distance = |node_id: crate::ids::NodeId| -> Option<usize> {
            let nav_id = nav.nav_node_for(node_id)?;
            let mut best: Option<usize> = None;
            if need_start {
                best = min_optional_distance(
                    best,
                    dist_from_start
                        .as_ref()
                        .and_then(|m| m.get(&nav_id))
                        .copied(),
                );
            }
            if need_finish {
                best = min_optional_distance(
                    best,
                    dist_from_finish
                        .as_ref()
                        .and_then(|m| m.get(&nav_id))
                        .copied(),
                );
            }
            best
        };

        let invalid: Vec<_> = one_way_edges_with_endpoints(maze)
            .into_iter()
            .filter(|&(_, from, to)| {
                let from_dist = waypoint_distance(from);
                let to_dist = waypoint_distance(to);
                min_optional_distance(from_dist, to_dist)
                    .is_some_and(|d| self.comparison.compare(d as u32, self.distance))
            })
            .filter(|&(id, ..)| !self.protect_route || !is_edge_on_route(maze, id))
            .map(|(id, ..)| id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidOneWayIssue::new_from_check(&self.instance_id, invalid).with_detail(
            &self.instance_id,
            "distance",
            self.distance.to_string(),
        );
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::meta::MazeMeta;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "one_way_waypoint_distance";

    /// start(0) -- 1 -- 2 -- ... -- corridor, with a one-way edge from `one_way_from` to
    /// `one_way_from + 1` (single direction only). `one_way_from` sits at `one_way_from` tiles
    /// from start along the bidirectional prefix.
    fn maze_with_one_way_at_distance(
        one_way_from: usize,
    ) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let width = one_way_from + 2;
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        let nodes: Vec<_> = (0..width as i32).map(p).collect();
        for x in 0..one_way_from as i32 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Single-direction edge -- the one-way under test.
        g.add_edge(
            p(one_way_from as i32),
            p(one_way_from as i32 + 1),
            EdgeKind::Basic,
        );

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(nodes[0]),
            finish: None,
        };
        (maze, nodes)
    }

    #[test]
    fn fires_when_one_way_closer_than_threshold_from_start() {
        let (maze, _) = maze_with_one_way_at_distance(2);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    }

    #[test]
    fn silent_when_one_way_farther_than_threshold_from_start() {
        let (maze, _) = maze_with_one_way_at_distance(10);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn gt_fires_when_one_way_farther_than_threshold_from_start() {
        let (maze, _) = maze_with_one_way_at_distance(10);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Gt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "one-way at distance 10 is > 5");
    }

    #[test]
    fn waypoint_finish_alone_fires_when_closer_than_threshold() {
        // Mirrors fires_when_one_way_closer_than_threshold_from_start but measures from finish
        // in isolation (need_start=false, need_finish=true) -- proves the Finish-only branch
        // uses distance_from_finish and correctly ignores distance_from_start, not just that
        // Any's "closer of both" reduction happens to also catch it.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        // finish(0) -- 1 -- 2(one_way_from) -> 3(one_way_to), one_way_from is 2 tiles from finish
        // via reverse edges. start is unset -- if the check wrongly consulted distance_from_start
        // it would find None and silently skip instead of firing.
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        let one_way_id = g.add_edge(p(2), p(3), EdgeKind::Basic);
        let finish_node = p(0);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: None,
            finish: Some(finish_node),
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Finish,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "one_way_from is 2 tiles from finish, closer than threshold 5"
        );
        assert_eq!(issues[0].invalid, vec![one_way_id]);
    }

    #[test]
    fn does_not_flag_bidirectional_passage() {
        // Same corridor but the tested edge is bidirectional (both directions present) -- must
        // never be flagged, regardless of distance, since it isn't a one-way.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        let start_node = p(0);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start_node),
            finish: None,
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "bidirectional passages must never be flagged as one-way"
        );
    }

    #[test]
    fn flags_a_basic_one_way_paired_with_a_parallel_reverse_teleport() {
        // A Basic edge A->B with a separate Teleport edge B->A is a legitimate parallel
        // configuration (Graph::add_edge's kind-aware dedup) -- the Teleport must never be
        // mistaken for the Basic edge's own reverse, or a genuine one-way silently escapes
        // detection.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        let one_way_id = g.add_edge(p(0), p(2), EdgeKind::Basic);
        g.add_edge(p(2), p(0), EdgeKind::Teleport);
        let start_node = p(0);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start_node),
            finish: None,
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "the parallel reverse Teleport must not mask the Basic one-way"
        );
        assert_eq!(issues[0].invalid, vec![one_way_id]);
    }

    #[test]
    fn flags_via_the_far_endpoint_when_the_near_endpoint_is_far() {
        // one_way_from(9)->one_way_from+1(10) sits at distance 9 from start via `from`, but `to`
        // is only 1 hop further -- min(from,to) = 9, still far. Build a case where `to` is
        // reachable at a much closer distance via a separate path, so the min catches it via `to`.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(12, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        // start -- 1 -- 2 (close to start)
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        // one-way from a far node (10) into node 2 (close to start)
        g.add_edge(p(10), p(2), EdgeKind::Basic);
        let start = p(0);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: None,
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "the `to` endpoint at distance 2 from start must be caught even though `from` is far"
        );
    }

    #[test]
    fn waypoint_any_uses_the_closer_of_start_and_finish() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(12, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        // finish(0) -- 1 -- 2 (one-way `from`, distance 2 from finish, reverse-reachable)
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        // far start, unrelated to this corridor
        g.add_bidirectional_edge(p(10), p(11), EdgeKind::Basic);
        let one_way_from = p(2);
        g.add_edge(one_way_from, p(11), EdgeKind::Basic);
        let (start, finish) = (p(10), p(0));

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: Some(finish),
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Any,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "from is 2 tiles from finish even though far from start"
        );
    }

    #[test]
    fn protect_route_excludes_a_route_critical_one_way() {
        // finish set at the far node -- the one-way is the maze's only route from start to
        // finish. With protect_route enabled it must not be flagged even though it's otherwise
        // close enough to start.
        let (mut maze, nodes) = maze_with_one_way_at_distance(2);
        let far = *nodes.last().unwrap();
        maze.meta.finish = Some(far);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "route-critical one-way must not be flagged when protect_route is enabled"
        );
    }

    #[test]
    fn protect_route_disabled_flags_the_route_one_way_as_before() {
        let (mut maze, nodes) = maze_with_one_way_at_distance(2);
        let far = *nodes.last().unwrap();
        maze.meta.finish = Some(far);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: false,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "protect_route disabled must flag the one-way exactly like before"
        );
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let (maze, _) = maze_with_one_way_at_distance(0);
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 0,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "a threshold of 0 should never flag any one-way"
        );
    }

    #[test]
    fn silent_when_required_waypoint_is_missing() {
        let (mut maze, _) = maze_with_one_way_at_distance(0);
        maze.meta.start = None;
        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 100,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "missing start is MissingEndpointsCheck's job"
        );
    }

    #[test]
    fn silent_when_one_way_endpoint_unreachable_from_waypoint() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        // Isolated pair -- no edge at all connects it to start's component.
        g.add_edge(p(2), p(3), EdgeKind::Basic);
        let start = p(0);

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: None,
        };

        let check = OneWayWaypointDistanceCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000,
            comparison: Comparison::Lt,
            waypoint: OneWayWaypoint::Start,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "unreachable one-way must not be treated as distance 0"
        );
    }
}
