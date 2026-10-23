use super::proximity_scan_core::pairwise_geometric_scan;
use super::vertical_passage_count_core::vertical_passage_proximity_candidates;
use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::{
    GeometricFloorMode, InvalidVerticalPassageGroupIssue, VerticalPassageType,
};
use crate::space::{Tessellation, floor_aware_distance};
use rand::RngCore;

pub const VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_TYPE: VerticalPassageType =
    VerticalPassageType::Any;
pub const VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_COUNT_INCOMING: bool = true;
pub const VERTICAL_PASSAGE_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

/// Flags a pair of `EdgeKind::VerticalPassage` entries placed too close to each other in geometric
/// (Euclidean) space — see GitHub issue #343/#342. Distance is measured between each candidate's
/// own scan point, folded across floors per `floor_mode` (see `GeometricFloorMode`), mirroring
/// `SplitGroupGeometricProximityCheck`'s "either tile removes the pair" group shape:
/// `InvalidVerticalPassageGroupIssue` with `to_remove: 1` per problematic pair.
///
/// `passage_type` restricts which logical passages enter the scan at all (GitHub issue #343's
/// follow-up — shared with the min/max count/ratio checks). `count_incoming` decides whether a
/// one-way passage's `to` end joins its `from` end as a second candidate (a two-way passage's two
/// ends always both participate — see `vertical_passage_proximity_candidates`). `same_type_only`,
/// when true, additionally requires both candidates' own passages to share the same concrete type
/// (`TwoWay`/`OneWayDown`/`OneWayUp`) for the pair to be flagged.
pub struct VerticalPassageGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    pub passage_type: VerticalPassageType,
    pub same_type_only: bool,
    pub count_incoming: bool,
    pub floor_mode: GeometricFloorMode,
}

impl<T: Tessellation> Check<T, InvalidVerticalPassageGroupIssue>
    for VerticalPassageGroupGeometricProximityCheck
{
    fn check_type_id(&self) -> &'static str {
        "vertical_passage_group_geometric_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidVerticalPassageGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let candidates: Vec<(EdgeId, usize, T::CellId, VerticalPassageType)> =
            vertical_passage_proximity_candidates(maze, self.passage_type, self.count_incoming)
                .into_iter()
                .filter_map(|c| {
                    let level = maze.field.level_index_of(c.node)?;
                    let point = maze.field.cell_of(c.node)?;
                    Some((c.canonical_edge, level, point, c.passage_type))
                })
                .collect();
        if candidates.len() < 2 {
            return;
        }

        let groups = pairwise_geometric_scan(
            &candidates,
            self.distance,
            |&(own_id, own_level, _, own_type), &(other_id, other_level, _, other_type)| {
                other_id == own_id
                    || (self.same_type_only && own_type != other_type)
                    || (self.floor_mode == GeometricFloorMode::SameFloorOnly
                        && own_level != other_level)
            },
            |&(_, own_level, own_point, _), &(_, other_level, other_point, _)| {
                floor_aware_distance(
                    maze.field.tessellation(),
                    own_level,
                    own_point,
                    other_level,
                    other_point,
                    self.floor_mode.include_height(),
                )
            },
            |&(own_id, ..), &(other_id, ..)| (vec![own_id, other_id], 1),
        );

        if groups.is_empty() {
            return;
        }
        let issue = InvalidVerticalPassageGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "vertical_passage_group_geometric_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn three_floor_maze_with_passages_at(xs: &[i32]) -> (Maze<SquareTessellation>, Vec<EdgeId>) {
        let mut ids = IdGenerator::new();
        let width = xs.iter().copied().max().unwrap_or(0) as usize + 1;
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(width, 1), &mut ids)
                .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(width, 1), &mut ids)
                .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let mut ids_out = Vec::new();
        for &x in xs {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            ids_out.push(g.add_edge(b, t, EdgeKind::VerticalPassage));
        }
        (Maze::new(mf, g), ids_out)
    }

    fn check(
        distance: f64,
        passage_type: VerticalPassageType,
        same_type_only: bool,
        count_incoming: bool,
    ) -> VerticalPassageGroupGeometricProximityCheck {
        VerticalPassageGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance,
            passage_type,
            same_type_only,
            count_incoming,
            floor_mode: GeometricFloorMode::AsCoordinate,
        }
    }

    #[test]
    fn fires_when_two_vertical_passages_closer_than_threshold() {
        let (maze, _ids) = three_floor_maze_with_passages_at(&[0, 1]);
        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::Any, false, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            2,
            "each edge scans and finds the other -- symmetric pair recorded from both sides"
        );
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2);
            assert_eq!(*to_remove, 1);
        }
    }

    #[test]
    fn silent_when_farther_than_threshold() {
        let (maze, _ids) = three_floor_maze_with_passages_at(&[0, 10]);
        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::Any, false, true).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_edges() {
        let (maze, _ids) = three_floor_maze_with_passages_at(&[0]);
        let mut issues = Vec::new();
        check(1000.0, VerticalPassageType::Any, false, true).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn same_type_only_ignores_a_mixed_up_down_pair() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up
        g.add_edge(t1, b1, EdgeKind::VerticalPassage); // down
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::Any, true, true).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(
            issues.is_empty(),
            "one edge goes up, the other down -- same_type_only must exclude this pair"
        );
    }

    #[test]
    fn same_type_only_still_flags_a_matching_pair() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up
        g.add_edge(b1, t1, EdgeKind::VerticalPassage); // up
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::Any, true, true).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(
            issues.len(),
            1,
            "both edges go up -- same_type_only must still flag this pair"
        );
    }

    #[test]
    fn passage_type_scope_excludes_a_non_matching_edge_from_the_scan_entirely() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up
        g.add_edge(t1, b1, EdgeKind::VerticalPassage); // down
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::OneWayUp, false, true).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(
            issues.is_empty(),
            "passage_type: OneWayUp excludes the downward edge from the scan, leaving fewer than 2 candidates"
        );
    }

    #[test]
    fn count_incoming_off_excludes_a_one_way_passages_to_end() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up: from b0, to t0
        g.add_edge(b1, t1, EdgeKind::VerticalPassage); // up: from b1, to t1
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5.0, VerticalPassageType::Any, false, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(
            issues.len(),
            1,
            "both from-ends (b0, b1) still scan and are close -- count_incoming only drops the to-ends"
        );
    }

    #[test]
    fn two_way_passage_scans_both_ends_regardless_of_count_incoming() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_bidirectional_edge(b0, t0, EdgeKind::VerticalPassage);
        g.add_bidirectional_edge(b1, t1, EdgeKind::VerticalPassage);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(1000.0, VerticalPassageType::Any, false, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(
            issues.len(),
            1,
            "each two-way passage's own two ends both scan even with count_incoming off, so all 4 candidates see each other as close"
        );
        assert_eq!(
            issues[0].groups.len(),
            4,
            "b0/t0 from the first passage and b1/t1 from the second all participate -- count_incoming only affects one-way to-ends"
        );
    }

    #[test]
    fn same_floor_only_ignores_a_pair_whose_from_ends_sit_on_different_floors() {
        // Up-passage at x=0 (from = bottom), down-passage at x=1 (from = top) -- x=0/x=1 are
        // close in plain x/y, but the two from-ends live on different floors.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up: from b0 (bottom)
        g.add_edge(t1, b1, EdgeKind::VerticalPassage); // down: from t1 (top)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        let mut c = check(5.0, VerticalPassageType::Any, false, false);
        c.floor_mode = GeometricFloorMode::SameFloorOnly;
        c.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "same_floor_only must never pair candidates on different floors, even when close in plain x/y"
        );
    }

    #[test]
    fn as_coordinate_and_ignore_disagree_when_the_floor_gap_alone_exceeds_the_threshold() {
        // dx = 1 between the two from-ends, but they sit 3 floors apart: dz = 3.
        // Ignore sees only dx = 1.0 (< 2.0, flags). AsCoordinate sees sqrt(1^2 + 3^2) = 3.16 (> 2.0, silent).
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..4)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(floors[0], SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(floors[1], SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(floors[3], SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(floors[2], SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage); // up: from b0 (floor 0)
        g.add_edge(b1, t1, EdgeKind::VerticalPassage); // down: from b1 (floor 3)
        let maze = Maze::new(mf, g);

        let mut ignore_issues = Vec::new();
        let mut ignore_check = check(2.0, VerticalPassageType::Any, false, false);
        ignore_check.floor_mode = GeometricFloorMode::Ignore;
        ignore_check.repair_check(&maze, &mut ignore_issues, &mut rng(), ());
        assert_eq!(
            ignore_issues.len(),
            1,
            "Ignore drops the floor gap entirely, sees only dx = 1.0 < 2.0"
        );

        let mut coordinate_issues = Vec::new();
        let coordinate_check = check(2.0, VerticalPassageType::Any, false, false);
        coordinate_check.repair_check(&maze, &mut coordinate_issues, &mut rng(), ());
        assert!(
            coordinate_issues.is_empty(),
            "AsCoordinate folds the floor gap in, sqrt(1^2 + 3^2) = 3.16 > 2.0"
        );
    }
}
