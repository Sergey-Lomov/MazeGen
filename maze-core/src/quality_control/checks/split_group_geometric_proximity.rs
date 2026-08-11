use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::{Tessellation, geometric_distance};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidSplitTileGroupIssue, SplitTileNodes};

pub const SPLIT_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;

/// Flags a pair of split tiles (a `Field` point carrying extra split nodes beyond its slot-0
/// original) placed too close to each other in geometric (Euclidean, unit tile scale) space — see
/// GitHub issue #249, part of epic #246. Mirrors `OneWayGroupGeometricProximityCheck`'s role: no
/// single-tile check (`SplitDistanceFromWaypointCheck`) can catch a problem that only emerges from
/// two tiles being close to each other, which no single-tile check can detect.
///
/// For each pair of distinct split tiles closer than `distance`, both tiles enter the same group
/// as their own `SplitTileNodes` candidate, `to_remove: 1` — collapsing either tile alone already
/// breaks the pair, same "fixing either side resolves it" semantics
/// `OneWayGroupGeometricProximityCheck` uses. As soon as one problematic pair is found for a tile,
/// it's recorded and the scan moves to the next tile (no need to enumerate every pair for the
/// same tile).
pub struct SplitGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
}

impl<T: Tessellation> Check<T, InvalidSplitTileGroupIssue> for SplitGroupGeometricProximityCheck {
    fn check_type_id(&self) -> &'static str { "split_group_geometric_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidSplitTileGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut seen_points = std::collections::HashSet::new();
        let tiles: Vec<(crate::space::LevelId, T::Point, Vec<NodeId>)> = maze.field.all_points_with_level()
            .filter(|&(level, point)| seen_points.insert((level, point)))
            .filter_map(|(level, point)| {
                let nodes = maze.field.nodes_at(level, point);
                if nodes.len() < 2 { None } else { Some((level, point, nodes.to_vec())) }
            })
            .collect();
        if tiles.len() < 2 {
            return;
        }

        let mut groups: Vec<(Vec<SplitTileNodes>, u32)> = Vec::new();

        for &(own_level, own_point, ref own_nodes) in &tiles {
            for &(other_level, other_point, ref other_nodes) in &tiles {
                if other_level == own_level && other_point == own_point {
                    continue;
                }
                // Geometric proximity is only meaningful within the same level — cross-level tiles
                // never count as "close" here (GitHub issue #334: geometric distance is undefined
                // between levels).
                if other_level != own_level {
                    continue;
                }
                if geometric_distance::<T>(own_point, other_point) < self.distance {
                    groups.push((vec![SplitTileNodes::new(own_nodes.clone()), SplitTileNodes::new(other_nodes.clone())], 1));
                    break;
                }
            }
        }

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
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::space::{MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "split_group_geometric_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_splits_at(xs: &[i32]) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let width = xs.iter().copied().max().unwrap_or(0) as usize + 1;
        let mut field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(width, 1), &mut ids).unwrap();
        let level = field.single_level_id();
        for &x in xs {
            field.add_node_at(level, SquarePoint { x, y: 0 }, &mut ids);
        }
        let mut g = Graph::new();
        for node in field.all_node_ids() { g.add_node(node); }
        Maze::new(field, g)
    }

    #[test]
    fn fires_when_two_split_tiles_closer_than_threshold() {
        let maze = maze_with_splits_at(&[0, 1]);
        let check = SplitGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 5.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // Each tile is scanned independently and finds the other -- own=tile0/other=tile1 and
        // own=tile1/other=tile0 both fire, same "symmetric pair recorded from both sides" shape
        // `OneWayGroupGeometricProximityCheck` produces (deduped later by `InvalidGroupIssue::merge`).
        assert_eq!(issues[0].groups.len(), 2);
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2, "both tiles must be candidates in the group");
            assert_eq!(*to_remove, 1, "fixing either tile alone already resolves the pair");
        }
    }

    #[test]
    fn silent_when_split_tiles_farther_than_threshold() {
        let maze = maze_with_splits_at(&[0, 10]);
        let check = SplitGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 5.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_split_tiles() {
        let maze = maze_with_splits_at(&[0]);
        let check = SplitGroupGeometricProximityCheck { instance_id: TEST_ID.to_string(), distance: 1000.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
