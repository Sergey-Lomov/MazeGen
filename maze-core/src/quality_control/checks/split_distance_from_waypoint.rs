use crate::Maze;
use crate::graph::distance_map::min_optional_distance;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::{InvalidSplitTileIssue, SplitTileNodes};
use crate::space::Tessellation;
use rand::RngCore;

pub const SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT: u32 = 0;
pub const SPLIT_DISTANCE_FROM_WAYPOINT_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Which waypoint(s) a `SplitDistanceFromWaypointCheck` instance measures distance against —
/// same shape as `TeleportWaypoint`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitWaypoint {
    Start,
    Finish,
    /// Both — the check uses whichever of the two is closer (`min`), same "closest wins"
    /// reduction `TeleportWaypoint::Any` uses.
    Any,
}

/// Flags an extra split node (`Field::add_node_at`'s minted node, never a point's slot-0
/// original) whose point sits too close to/far from a waypoint (start/finish) in progression
/// space — part of GitHub epic #246 (issue #248). Mirrors `TeleportWaypointDistanceCheck`'s shape.
///
/// A point's distance to a waypoint is the **minimum** shortest-path distance (in tiles, directed
/// graph traversal via the shared distance maps — see `graph-analytics.md`) over *every* node at
/// that point (`Field::nodes_at`, slot-0 included) — a split point is one physical tile, so its
/// progression-space position is shared by all its nodes, not just the flagged one. A node absent
/// from the relevant distance map (unreachable, or compressed out of the nav graph as an interior
/// corridor node — see `NavGraph::nav_node_for`) contributes no distance for itself, same
/// "unreachable means no defined distance" rule `LoopDistanceFromStartCheck`/
/// `TeleportWaypointDistanceCheck` already follow; a point where every node is undefined is never
/// flagged.
///
/// Flags the whole tile (`SplitTileNodes`, every node at the point including slot-0 — GitHub
/// issue #260) once a point's minimum distance trips the threshold — the tile is the issue's unit
/// of work, not the bare extra node(s); the repair strategy for this issue still only ever
/// collapses the whole tile down to one surviving node, never emptying the point entirely (issue
/// #281: no node, slot-0 included, has any special standing here beyond that).
pub struct SplitDistanceFromWaypointCheck {
    pub instance_id: String,
    pub distance: u32,
    /// GitHub issue #177: `Lt` flags a split point too close to the waypoint; other operators
    /// let a user flag "too far" (`Gt`) or other relations instead.
    pub comparison: Comparison,
    pub waypoint: SplitWaypoint,
}

impl<T: Tessellation> Check<T, InvalidSplitTileIssue> for SplitDistanceFromWaypointCheck {
    fn check_type_id(&self) -> &'static str {
        "split_distance_from_waypoint"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let dist_from_start = maze.analysis.distance_from_start(&maze.graph, &maze.meta);
        let dist_from_finish = maze.analysis.distance_from_finish(&maze.graph, &maze.meta);
        let (need_start, need_finish) = match self.waypoint {
            SplitWaypoint::Start => (true, false),
            SplitWaypoint::Finish => (false, true),
            SplitWaypoint::Any => (true, true),
        };
        // Silently skip if the maze doesn't have the waypoint(s) this instance needs set —
        // covered by MissingEndpointsCheck, same rationale as the loop/teleport distance checks.
        if need_start && dist_from_start.is_none() {
            return;
        }
        if need_finish && dist_from_finish.is_none() {
            return;
        }

        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let waypoint_distance = |node_id: crate::ids::NodeId| -> Option<usize> {
            // A split node is very often exactly the plain-corridor shape (one edge in, one edge
            // out) `NavGraph` compresses into some other nav-edge's interior `path` — `nav_node_for`
            // alone returns `None` for it (see GitHub issue #248's original bug report: this made
            // the check silently never fire for the common split-node shape). Falls back to
            // `corridor_index`, same resolution `routing::resolve_nav_node` already uses for a
            // route's own interior nodes — this is the nav node at the *end* of the corridor
            // segment the node sits on, an approximation (off by however many tiles remain in that
            // segment) accepted here for the same progression-space-proximity purpose routing.rs
            // already uses it for, not an exact tile count.
            let nav_id = nav
                .nav_node_for(node_id)
                .or_else(|| nav.corridor_index.get(&node_id).copied())?;
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

        // `Field::all_points()` yields one entry per `NodeId` (sorted, then mapped back to its
        // point) — a split point's several nodes all resolve to the same point, so iterating it
        // directly would visit that point once per extra node instead of once overall. Dedup via
        // a seen-points set instead (order doesn't matter here — every point is only ever
        // resolved into `invalid` via its own `nodes_at`, never compared across points).
        let mut seen_points = std::collections::HashSet::new();
        let invalid: Vec<SplitTileNodes> = maze
            .field
            .all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 {
                    return None;
                }
                let point_distance = nodes.iter().filter_map(|&n| waypoint_distance(n)).min()?;
                if !self
                    .comparison
                    .compare(point_distance as u32, self.distance)
                {
                    return None;
                }
                Some(SplitTileNodes::new(nodes.to_vec()))
            })
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidSplitTileIssue::new_from_check(&self.instance_id, invalid).with_detail(
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
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "split_distance_from_waypoint";

    /// start(0) -- 1 -- ... -- split_point (at `split_distance` tiles from start), with an extra
    /// split node minted on top of the corridor's last point. Returns the whole tile (slot-0 +
    /// extra) as the expected `SplitTileNodes` alongside the maze.
    fn maze_with_split_at_distance(
        split_distance: usize,
    ) -> (Maze<SquareTessellation>, SplitTileNodes) {
        let mut ids = IdGenerator::new();
        let width = split_distance + 1;
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let split_point = SquarePoint {
            x: split_distance as i32,
            y: 0,
        };
        let slot0 = field.node_at(level, split_point).unwrap();
        let extra = field.add_node_at(level, split_point, &mut ids);

        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..split_distance as i32 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Give the extra node its own edge so it's a real junction (not compressed out of the
        // nav graph as an unreachable/degree-0 node).
        g.add_bidirectional_edge(p(split_distance as i32), extra, EdgeKind::Basic);

        let start = p(0);
        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: None,
        };
        (maze, SplitTileNodes::new(vec![slot0, extra]))
    }

    #[test]
    fn fires_when_split_point_closer_than_threshold() {
        let (maze, tile) = maze_with_split_at_distance(3);
        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].invalid,
            vec![tile],
            "the whole tile (slot-0 + extra) is flagged as one unit"
        );
    }

    #[test]
    fn silent_when_split_point_farther_than_threshold() {
        let (maze, _) = maze_with_split_at_distance(10);
        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn gt_fires_when_split_point_farther_than_threshold() {
        let (maze, tile) = maze_with_split_at_distance(10);
        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Gt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid, vec![tile]);
    }

    #[test]
    fn never_flags_a_point_with_no_extra_split_node() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        let start = p(0);
        let mut maze: Maze<SquareTessellation> = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: None,
        };

        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty(), "no split points exist, nothing to flag");
    }

    #[test]
    fn waypoint_finish_measures_only_against_finish() {
        // SplitWaypoint::Finish alone (need_finish only, not Any) — a split point far from start
        // but close to finish must still fire, and a check instance with only Start set (finish
        // missing) must silently skip rather than measuring against start by mistake.
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(12, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let split_point = SquarePoint { x: 0, y: 0 };
        let slot0 = field.node_at(level, split_point).unwrap();
        let extra = field.add_node_at(level, split_point, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(0), extra, EdgeKind::Basic);
        g.add_bidirectional_edge(p(10), p(11), EdgeKind::Basic);
        let (start, finish) = (p(10), p(0));

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: Some(finish),
        };

        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Finish,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "split point is 0 tiles from finish");
        assert_eq!(
            issues[0].invalid,
            vec![SplitTileNodes::new(vec![slot0, extra])]
        );
    }

    #[test]
    fn waypoint_any_uses_the_closer_of_start_and_finish() {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(12, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        let split_point = SquarePoint { x: 0, y: 0 };
        let slot0 = field.node_at(level, split_point).unwrap();
        let extra = field.add_node_at(level, split_point, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        // finish(0) -- 1 -- 2, extra split node hanging off finish (distance 0 from finish).
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(0), extra, EdgeKind::Basic);
        // far start, unrelated to this corridor.
        g.add_bidirectional_edge(p(10), p(11), EdgeKind::Basic);
        let (start, finish) = (p(10), p(0));

        let mut maze = Maze::new(field, g);
        maze.meta = MazeMeta {
            start: Some(start),
            finish: Some(finish),
        };

        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Any,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "split point is 0 tiles from finish even though far from start"
        );
        assert_eq!(
            issues[0].invalid,
            vec![SplitTileNodes::new(vec![slot0, extra])]
        );
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let (maze, _) = maze_with_split_at_distance(0);
        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 0,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "a threshold of 0 should never flag any split point"
        );
    }

    #[test]
    fn silent_when_required_waypoint_is_missing() {
        let (mut maze, _) = maze_with_split_at_distance(0);
        maze.meta.start = None;
        let check = SplitDistanceFromWaypointCheck {
            instance_id: TEST_ID.to_string(),
            distance: 100,
            comparison: Comparison::Lt,
            waypoint: SplitWaypoint::Start,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "missing start is MissingEndpointsCheck's job"
        );
    }
}
