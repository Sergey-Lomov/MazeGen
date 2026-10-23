use super::vertical_passage_count_core::{
    count_logical_vertical_passages, logical_vertical_passages_per_floor,
};
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floor_point_count;
use crate::quality_control::{
    FloorScope, MissingVerticalPassagesIssue, RepairArea, VerticalPassageType,
};
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_VERTICAL_PASSAGE_RATIO_DEFAULT: f64 = 10.0;
pub const MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;
pub const MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;
pub const MIN_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING: bool = false;

/// Flags a deficit against the share of logical `VerticalPassage` passages matching `passage_type`
/// relative to the field's size — see GitHub issue #343. Mirrors `MinTeleportRatioCheck`: a count
/// expressed per 100 field cells, cross-multiplied comparison to avoid floor-rounding a passing
/// ratio into a false negative. Counts logical passages, not edges — see `min_vertical_passage_count`'s
/// doc comment for the double-count fix this shares.
pub struct MinVerticalPassageRatioCheck {
    pub instance_id: String,
    pub min_vertical_passage_ratio: f64,
    pub floor_scope: FloorScope,
    pub passage_type: VerticalPassageType,
    pub count_incoming: bool,
}

impl<T: Tessellation> Check<T, MissingVerticalPassagesIssue> for MinVerticalPassageRatioCheck {
    fn check_type_id(&self) -> &'static str {
        "min_vertical_passage_ratio"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingVerticalPassagesIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let min_ratio = self.min_vertical_passage_ratio;

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.cell_count() as u64;
                let missing = Self::missing_for(
                    count_logical_vertical_passages(maze, self.passage_type) as u64,
                    field_cells,
                    min_ratio,
                );
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let mut missing: Vec<(RepairArea, u32)> = logical_vertical_passages_per_floor(
                    maze,
                    self.passage_type,
                    self.count_incoming,
                )
                .into_iter()
                .filter_map(|(level, edges)| {
                    let missing = Self::missing_for(
                        edges.len() as u64,
                        floor_point_count(&maze.field, level) as u64,
                        min_ratio,
                    );
                    (missing > 0).then_some((RepairArea::Level(level), missing))
                })
                .collect();
                missing.sort_by_key(|&(area, _)| area);
                missing
            }
        };
        if missing.is_empty() {
            return;
        }
        let total: u32 = missing.iter().map(|(_, m)| m).sum();
        let issue = MissingVerticalPassagesIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", total.to_string());
        issues.push(issue);
    }
}

impl MinVerticalPassageRatioCheck {
    fn missing_for(count: u64, field_cells: u64, min_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 >= min_ratio * field_cells as f64 {
            return 0;
        }
        let required = (min_ratio * field_cells as f64 / 100.0).round() as u64;
        required.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_vertical_passage_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two 10-cell floors (20 field cells total), one vertical passage between them (0,0) -> 5
    /// per 100 cells maze-wide.
    fn maze_with_one_vertical_passage_on_ten_cells() -> (
        Maze<SquareTessellation>,
        crate::ids::NodeId,
        crate::ids::NodeId,
    ) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        (Maze::new(mf, g), b0, t0)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let (mut maze, b0, t0) = maze_with_one_vertical_passage_on_ten_cells();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passage_ratio: 5.0,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let (mut maze, b0, t0) = maze_with_one_vertical_passage_on_ten_cells();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passage_ratio: 30.0,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // required = round(30*20/100) = 6, missing = 6 - 1 = 5.
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 5)]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"5".to_string()),
        );
    }

    #[test]
    fn two_way_passage_counts_as_one_not_two() {
        let (mut maze, b0, t0) = maze_with_one_vertical_passage_on_ten_cells();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passage_ratio: 5.0,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "a single two-way passage must still count as 1 logical passage, meeting a ratio requiring only 1 per 20 cells"
        );
    }

    #[test]
    fn passage_type_one_way_up_ignores_a_downward_passage() {
        let (mut maze, b0, t0) = maze_with_one_vertical_passage_on_ten_cells();
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passage_ratio: 10.0,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::OneWayUp,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "the existing passage goes down, so the up-only ratio is still unmet"
        );
    }

    #[test]
    fn does_not_count_a_basic_edge() {
        let (mut maze, b0, t0) = maze_with_one_vertical_passage_on_ten_cells();
        maze.graph.add_edge(b0, t0, EdgeKind::Basic);
        let check = MinVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passage_ratio: 50.0,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "a Basic edge must not count toward the ratio"
        );
    }
}
