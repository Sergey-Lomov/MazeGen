use super::proximity_scan_core::pairwise_geometric_scan;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::{GeometricFloorMode, InvalidSplitTileGroupIssue, SplitTileNodes};
use crate::space::{Tessellation, floor_aware_distance};
use rand::RngCore;

pub const SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

/// Flags a pair of split tiles (a `Field` point carrying extra split nodes beyond its slot-0
/// original) placed too close to each other in geometric (Euclidean, unit tile scale — see
/// `space::floor_aware_distance`) space — see GitHub issue #249/#342, part of epic #246. Mirrors
/// `OneWayGroupGeometricProximityCheck`'s role: no single-tile check
/// (`SplitDistanceFromWaypointCheck`) can catch a problem that only emerges from two tiles being
/// close to each other, which no single-tile check can detect.
///
/// For each pair of distinct split tiles closer than `distance`, both tiles enter the same group
/// as their own `SplitTileNodes` candidate, `to_remove: 1` — collapsing either tile alone already
/// breaks the pair, same "fixing either side resolves it" semantics
/// `OneWayGroupGeometricProximityCheck` uses. As soon as one problematic pair is found for a tile,
/// it's recorded and the scan moves to the next tile (no need to enumerate every pair for the
/// same tile).
///
/// Default `floor_mode` is `SameFloorOnly` (pre-#342 behavior: a cross-floor pair never counted as
/// close) — same default as the other two geometric checks (issue #342).
pub struct SplitGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    /// GitHub issue #342: how a cross-floor split-tile pair is treated by this geometric check.
    pub floor_mode: GeometricFloorMode,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for SplitGroupGeometricProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "split_group_geometric_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidSplitTileGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let level_indices: std::collections::HashMap<crate::space::LevelId, usize> = maze
            .field
            .levels_ordered()
            .enumerate()
            .map(|(i, l)| (l, i))
            .collect();
        let tiles: Vec<(crate::space::LevelId, usize, T::Point, Vec<NodeId>)> = maze
            .field
            .split_points()
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                let level_index = *level_indices.get(&level)?;
                Some((level, level_index, point, nodes.to_vec()))
            })
            .collect();
        if tiles.len() < 2 {
            return;
        }

        let groups = pairwise_geometric_scan(
            &tiles,
            self.distance,
            |&(own_level, _, own_point, _), &(other_level, _, other_point, _)| {
                (other_level == own_level && other_point == own_point)
                    || (self.floor_mode == GeometricFloorMode::SameFloorOnly
                        && other_level != own_level)
            },
            |&(_, own_level_index, own_point, _), &(_, other_level_index, other_point, _)| {
                floor_aware_distance::<T>(
                    own_level_index,
                    own_point,
                    other_level_index,
                    other_point,
                    self.floor_mode.include_height(),
                )
            },
            |(.., own_nodes), (.., other_nodes)| {
                (
                    vec![
                        SplitTileNodes::new(own_nodes.clone()),
                        SplitTileNodes::new(other_nodes.clone()),
                    ],
                    1,
                )
            },
        );

        if groups.is_empty() {
            return;
        }
        let issue = InvalidSplitTileGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "split_group_geometric_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_splits_at(xs: &[i32]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = xs.iter().copied().max().unwrap_or(0) as usize + 1;
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for &x in xs {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_two_split_tiles_closer_than_threshold() {
        let maze = maze_with_splits_at(&[0, 1]);
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5.0,
            floor_mode: SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // Each tile is scanned independently and finds the other -- own=tile0/other=tile1 and
        // own=tile1/other=tile0 both fire, same "symmetric pair recorded from both sides" shape
        // `OneWayGroupGeometricProximityCheck` produces (deduped later by `InvalidGroupIssue::merge`).
        assert_eq!(issues[0].groups.len(), 2);
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2, "both tiles must be candidates in the group");
            assert_eq!(
                *to_remove, 1,
                "fixing either tile alone already resolves the pair"
            );
        }
    }

    #[test]
    fn silent_when_split_tiles_farther_than_threshold() {
        let maze = maze_with_splits_at(&[0, 10]);
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5.0,
            floor_mode: SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_split_tiles() {
        let maze = maze_with_splits_at(&[0]);
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000.0,
            floor_mode: SPLIT_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    /// Two floors, same x-y point: a split tile at (0,0) on the bottom floor, another at (0,0) on
    /// the top floor -- isolates floor-mode behavior from x-y distance itself (both points have
    /// x-y distance 0.0 in their own floor's coordinate system).
    fn maze_with_cross_floor_splits() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut field: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let bottom = field.single_level_id();
        let top = field.add_level(
            crate::space::Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap(),
        );
        field.add_node_at(bottom, SquarePoint { x: 0, y: 0 }, &mut ids);
        field.add_node_at(top, SquarePoint { x: 0, y: 0 }, &mut ids);
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        Maze::new(field, g)
    }

    #[test]
    fn ignore_mode_measures_plain_xy_distance_across_floors() {
        let maze = maze_with_cross_floor_splits(); // same x-y point -> distance 0.0
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 0.5,
            floor_mode: GeometricFloorMode::Ignore,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "Ignore mode measures x-y distance only (0.0 < 0.5), floor difference has no effect"
        );
    }

    #[test]
    fn as_coordinate_mode_folds_floor_difference_into_the_distance() {
        let maze = maze_with_cross_floor_splits(); // x-y distance 0.0, one floor apart -> 1.0
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 0.5,
            floor_mode: GeometricFloorMode::AsCoordinate,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "floor-folded distance is 1.0, not < 0.5, unlike the plain x-y distance of 0.0"
        );

        issues.clear();
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1.5,
            floor_mode: GeometricFloorMode::AsCoordinate,
        };
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "floor-folded distance 1.0 < 1.5 must fire");
    }

    #[test]
    fn same_floor_only_mode_never_flags_a_cross_floor_pair() {
        let maze = maze_with_cross_floor_splits();
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 1000.0,
            floor_mode: GeometricFloorMode::SameFloorOnly,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "cross-floor pair must never be flagged under SameFloorOnly, regardless of threshold"
        );
    }

    #[test]
    fn same_floor_only_mode_still_flags_a_same_floor_pair() {
        let maze = maze_with_splits_at(&[0, 1]); // same floor, distance < 5.0
        let check = SplitGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5.0,
            floor_mode: GeometricFloorMode::SameFloorOnly,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "SameFloorOnly still evaluates same-floor pairs normally"
        );
    }
}
