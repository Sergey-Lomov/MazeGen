use super::teleport_geometric_length_core::{build_issue, find_invalid_teleports};
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::{GeometricFloorMode, InvalidTeleportIssue};
use crate::space::Tessellation;
use rand::RngCore;

pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT: f64 = 0.0;
pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT_COMPARISON: Comparison = Comparison::Lt;
pub const TELEPORT_GEOMETRIC_LENGTH_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

/// Flags a teleport edge whose geometric (Euclidean, unit tile scale — see
/// `space::floor_aware_distance`) distance between its entry and exit compares against a
/// configured threshold — see GitHub issue #74/#177/#342. Merges the former
/// `TeleportMinGeometricLengthCheck`/`TeleportMaxGeometricLengthCheck` (a min/max pair validating
/// the same single-teleport property, both flagging `INVALID_TELEPORT`) into one check type
/// parametrized by `Comparison` — `comparison: Lt` reproduces the old "shorter than minimum"
/// behavior, `Gt` reproduces "longer than maximum".
pub struct TeleportGeometricLengthCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub length: f64,
    /// GitHub issue #78, default `true`: a teleport lying on the maze's current start->finish
    /// route (`is_teleport_route_protected`) is never included in `invalid`.
    pub protect_route: bool,
    /// GitHub issue #342: how a cross-floor teleport is treated by this geometric check.
    pub floor_mode: GeometricFloorMode,
}

impl<T: Tessellation> Check<T, InvalidTeleportIssue> for TeleportGeometricLengthCheck {
    fn check_type_id(&self) -> &'static str {
        "teleport_geometric_length"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidTeleportIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let invalid = find_invalid_teleports(
            maze,
            self.protect_route,
            self.comparison,
            self.length,
            self.floor_mode,
        );
        if let Some(issue) = build_issue(invalid, &self.instance_id, self.length) {
            issues.push(issue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "teleport_geometric_length";

    fn maze_with_teleport(from: (i32, i32), to: (i32, i32)) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(20, 20), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field
            .node_at(
                field_level,
                SquarePoint {
                    x: from.0,
                    y: from.1,
                },
            )
            .unwrap();
        let b = field
            .node_at(field_level, SquarePoint { x: to.0, y: to.1 })
            .unwrap();
        g.add_edge(a, b, EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn lt_fires_when_shorter_than_minimum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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
    fn lt_protect_route_excludes_a_route_critical_short_teleport() {
        let mut maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let teleport = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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
    fn lt_silent_when_longer_than_minimum() {
        let maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn lt_silent_when_threshold_is_zero() {
        let maze = maze_with_teleport((0, 0), (1, 0));
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 0.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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
    fn gt_fires_when_longer_than_maximum() {
        let maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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
    fn gt_protect_route_excludes_a_route_critical_long_teleport() {
        let mut maze = maze_with_teleport((0, 0), (10, 0)); // distance 10.0
        let teleport = maze
            .graph
            .edges()
            .find(|e| e.kind == EdgeKind::Teleport)
            .unwrap();
        let (start, finish) = (teleport.from, teleport.to);
        maze.meta.start = Some(start);
        maze.meta.finish = Some(finish);

        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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
    fn gt_silent_when_shorter_than_maximum() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // distance 1.0
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn ignores_basic_edges() {
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(20, 20), &mut ids).unwrap();
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

        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 100.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_for_both_directions_of_a_two_way_short_teleport() {
        // Each direction of a two-way teleport is its own Teleport edge and must be flagged
        // independently, since the check operates per-edge, not per-pair.
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(20, 20), &mut ids).unwrap();
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
            .unwrap(); // distance 1.0
        g.add_edge(a, b, EdgeKind::Teleport);
        g.add_edge(b, a, EdgeKind::Teleport);
        let maze = Maze::new(field, g);

        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
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

    /// Two floors, same x-y coordinates (0,0) and (1,0) on each — a teleport crosses from floor 0
    /// to floor 1 at the same coordinates a same-floor length-1.0 teleport would use, isolating
    /// the floor-mode behavior from x-y distance itself.
    fn maze_with_cross_floor_teleport() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(20, 20), &mut ids).unwrap();
        let bottom = field.single_level_id();
        let top = field.add_level(
            crate::space::Field::<SquareTessellation>::new(
                Arc::default(),
                square_rect(20, 20),
                &mut ids,
            )
            .unwrap(),
        );
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let a = field.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a, b, EdgeKind::Teleport);
        Maze::new(field, g)
    }

    #[test]
    fn ignore_mode_measures_plain_xy_distance_across_floors() {
        let maze = maze_with_cross_floor_teleport(); // x-y distance 1.0, floors differ
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::Ignore,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "Ignore mode measures x-y only (1.0 < 5.0), floor difference has no effect"
        );
    }

    #[test]
    fn as_coordinate_mode_folds_floor_difference_into_the_distance() {
        let maze = maze_with_cross_floor_teleport(); // x-y distance 1.0, one floor apart -> sqrt(2)
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 1.1,
            protect_route: true,
            floor_mode: GeometricFloorMode::AsCoordinate,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "sqrt(1^2+1^2) = 1.41 is not < 1.1, unlike the plain x-y distance of 1.0"
        );

        issues.clear();
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 1.5,
            protect_route: true,
            floor_mode: GeometricFloorMode::AsCoordinate,
        };
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(issues.len(), 1, "sqrt(2) = 1.41 < 1.5 must fire");
    }

    #[test]
    fn same_floor_only_mode_never_flags_a_cross_floor_teleport() {
        let maze = maze_with_cross_floor_teleport();
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 1000.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::SameFloorOnly,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert!(
            issues.is_empty(),
            "cross-floor pair must never be flagged under SameFloorOnly, regardless of threshold"
        );
    }

    #[test]
    fn same_floor_only_mode_still_flags_a_same_floor_teleport() {
        let maze = maze_with_teleport((0, 0), (1, 0)); // same floor, distance 1.0
        let check = TeleportGeometricLengthCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            length: 5.0,
            protect_route: true,
            floor_mode: GeometricFloorMode::SameFloorOnly,
        };
        let mut issues = Vec::new();
        let mut rng = crate::random::MazeRng::seed_from_u64(0);
        check.repair_check(&maze, &mut issues, &mut rng, ());
        assert_eq!(
            issues.len(),
            1,
            "SameFloorOnly still evaluates same-floor pairs normally"
        );
    }
}
