use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::{DistanceDirection, compute_distance_map_filtered_bounded};
use crate::graph::nav::NavEdge;
use crate::graph::route_protection::is_teleport_route_protected;
use crate::quality_control::InvalidTeleportIssue;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::space::Tessellation;
use rand::RngCore;

pub const TELEPORT_GRAPH_DISTANCE_DEFAULT: u32 = 0;
pub const TELEPORT_GRAPH_DISTANCE_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Flags a teleport edge whose logical (graph/tile-hop) distance between its entry and exit
/// compares against a configured threshold — see GitHub issue #191. Mirrors
/// `TeleportGeometricLengthCheck`'s shape (`comparison` + threshold, `protect_route`), but measures
/// topological distance via the shared nav-graph distance-map infrastructure instead of Euclidean
/// distance — a teleport can be geometrically short yet logically far apart (or unreachable without
/// it), and vice versa, and only the geometric case was previously covered.
///
/// Distance is a single directed forward pass (entry -> exit), never `min(forward, reverse)` —
/// unlike `TeleportWaypointDistanceCheck`/`TeleportGroupProximityCheck`, which reduce over both
/// directions because either direction is equally meaningful for their own questions. Here the
/// question is specifically "can a pedestrian walk from entry to exit without this edge", which is
/// inherently directional: a reverse-direction path (exit -> entry) says nothing about that,
/// including — for a two-way teleport — via its own opposite-direction edge, which trivially
/// connects exit -> entry in one hop but never contributes to an entry -> exit path.
pub struct TeleportGraphDistanceCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub distance: u32,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
}

/// A nav-edge is traversable for this check's Dijkstra pass unless it's the single-hop transition
/// between the teleport's own `from`/`to` that can *only* be the teleport ride being measured
/// itself — the distance is computed "as if the teleport edge itself were absent" (GitHub issue
/// #191), so only that specific edge is excluded, not every teleport hop in the graph (unlike
/// `TeleportGroupProximityCheck`, which excludes all teleport hops since it measures purely
/// pedestrian proximity). `NavEdge::is_teleport` (GitHub issue #197) already disambiguates this
/// from a coexisting Basic-backed `NavEdge` over the same `path`, so no `Graph` lookup is needed.
fn is_not_this_teleport(edge: &NavEdge, from: crate::ids::NodeId, to: crate::ids::NodeId) -> bool {
    !(edge.is_teleport && edge.path[0] == from && edge.path[1] == to)
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportGraphDistanceCheck {
    fn check_type_id(&self) -> &'static str {
        "teleport_graph_distance"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let invalid: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .filter(|t| {
                let (Some(from_nav), Some(to_nav)) =
                    (nav.nav_node_for(t.from), nav.nav_node_for(t.to))
                else {
                    return false;
                };
                let filter = |edge: &NavEdge| is_not_this_teleport(edge, t.from, t.to);
                compute_distance_map_filtered_bounded(
                    &nav,
                    from_nav,
                    DistanceDirection::Forward,
                    filter,
                    usize::MAX,
                )
                .get(&to_nav)
                .copied()
                .is_some_and(|d| self.comparison.compare(d as u32, self.distance))
            })
            .filter(|t| !self.protect_route || !is_teleport_route_protected(maze, t.id))
            .map(|e| e.id)
            .collect();

        if invalid.is_empty() {
            return;
        }
        let issue = InvalidTeleportIssue::new_from_check(&self.instance_id, invalid).with_detail(
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
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "teleport_graph_distance";

    /// Line of `len` nodes connected by basic edges, plus a teleport from the last node back to
    /// the first — the teleport's own entry/exit sit `len - 1` tile-hops apart via the corridor,
    /// entirely independent of the teleport edge itself.
    fn maze_with_corridor_and_teleport(
        len: usize,
    ) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(len, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        let nodes: Vec<_> = (0..len as i32).map(p).collect();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        g.add_edge(nodes[len - 1], nodes[0], EdgeKind::Teleport);
        let maze = Maze::new(field, g);
        (maze, nodes)
    }

    #[test]
    fn lt_fires_when_graph_distance_shorter_than_threshold() {
        let (maze, _) = maze_with_corridor_and_teleport(3); // entry<->exit distance 2 via corridor
        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
        let teleport_id = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap()
            .id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
    }

    #[test]
    fn lt_silent_when_graph_distance_longer_than_threshold() {
        let (maze, _) = maze_with_corridor_and_teleport(10); // distance 9 via corridor
        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn gt_fires_when_graph_distance_longer_than_threshold() {
        let (maze, _) = maze_with_corridor_and_teleport(10); // distance 9 via corridor
        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn gt_silent_when_graph_distance_shorter_than_threshold() {
        let (maze, _) = maze_with_corridor_and_teleport(3); // distance 2 via corridor
        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn distance_ignores_the_teleport_edge_itself() {
        // Only edge between entry/exit is the teleport itself -- no pedestrian path exists, so
        // graph distance is undefined (unreachable), not 1 (which a naive "count this edge" bug
        // would report).
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .node_at(field_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let b = field
            .node_at(field_level, SquarePoint { x: 5, y: 5 })
            .unwrap();
        g.add_edge(a, b, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 1000,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "an unreachable pair (teleport is the only connection) must never be flagged"
        );
    }

    #[test]
    fn distance_ignores_a_two_way_teleport_with_no_other_connection() {
        // Two-way teleport (both directions), nothing else connects the pair -- graph distance
        // must stay undefined for both directions, not 1 via the opposite-direction edge.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .node_at(field_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let b = field
            .node_at(field_level, SquarePoint { x: 5, y: 5 })
            .unwrap();
        g.add_bidirectional_edge(a, b, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 1000,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "a two-way teleport with no other connection must never be flagged, whichever direction is scanned"
        );
    }

    #[test]
    fn silent_when_threshold_is_zero() {
        let (maze, _) = maze_with_corridor_and_teleport(3);
        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 0,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "a threshold of 0 should never flag any teleport"
        );
    }

    #[test]
    fn lt_protect_route_excludes_a_route_critical_short_teleport() {
        let (mut maze, nodes) = maze_with_corridor_and_teleport(3);
        let teleport = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);
        let _ = nodes;

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "route-critical teleport must not be flagged when protect_route is enabled"
        );
    }

    #[test]
    fn parallel_basic_edge_keeps_the_pair_reachable() {
        // A Basic edge runs parallel to the teleport (same pair, same direction) -- excluding the
        // teleport must not hide this genuine pedestrian passage, since the pair is one Basic hop
        // apart regardless of the teleport's presence.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .node_at(field_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let b = field
            .node_at(field_level, SquarePoint { x: 1, y: 0 })
            .unwrap();
        g.add_edge(a, b, EdgeKind::Basic);
        g.add_edge(a, b, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 1000,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "parallel Basic edge means the pair is 1 hop apart, which is < 1000"
        );
        let teleport_id = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap()
            .id;
        assert_eq!(issues[0].invalid, vec![teleport_id]);
    }

    #[test]
    fn ignores_basic_edges() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .node_at(field_level, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let b = field
            .node_at(field_level, SquarePoint { x: 1, y: 0 })
            .unwrap();
        g.add_edge(a, b, EdgeKind::Basic);
        let maze = Maze::new(field, g);

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 100,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_short_teleport() {
        let (mut maze, nodes) = maze_with_corridor_and_teleport(3);
        // Add the reverse teleport direction too.
        maze.graph
            .build_initial_edge(nodes[0], nodes[2], EdgeKind::Teleport);

        let check = TeleportGraphDistanceCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            distance: 5,
            protect_route: true,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());

        assert_eq!(
            issues.len(),
            1,
            "both directions merge into one issue from a single check call"
        );
        let mut teleport_ids: Vec<_> = maze
            .graph
            .edges()
            .filter(|e| e.kind == EdgeKind::Teleport)
            .map(|e| e.id)
            .collect();
        teleport_ids.sort_unstable();
        let mut flagged = issues[0].invalid.clone();
        flagged.sort_unstable();
        assert_eq!(
            flagged, teleport_ids,
            "both teleport directions must be flagged, not just one"
        );
    }
}
