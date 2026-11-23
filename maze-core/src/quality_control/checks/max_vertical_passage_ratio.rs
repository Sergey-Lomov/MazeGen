use super::vertical_passage_count_core::logical_vertical_passages_matching;
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidVerticalPassageGroupIssue, VerticalPassageType};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT: f64 = 100.0;
pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;

/// Flags an excess against the share of logical `VerticalPassage` passages matching `passage_type`
/// relative to the field's size — see GitHub issue #343. Mirrors `MaxOneWayRatioCheck`: "passages
/// per 100 field cells", cross-multiplied excess gate, round-to-nearest `target_count`. Counts
/// logical passages, not edges — see `max_vertical_passage_count`'s doc comment for the double-count
/// fix this shares.
pub struct MaxVerticalPassageRatioCheck {
    pub instance_id: String,
    pub max_ratio: f64,
    pub passage_type: VerticalPassageType,
}

impl<T: Tessellation> Check<T, InvalidVerticalPassageGroupIssue> for MaxVerticalPassageRatioCheck {
    fn check_type_id(&self) -> &'static str {
        "max_vertical_passage_ratio"
    }
    fn is_batch_edge_group(&self) -> bool {
        true
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidVerticalPassageGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let max_ratio = self.max_ratio;

        let (group, to_remove) = {
            let field_cells = maze.scoped_cell_count() as u64;
            if field_cells == 0 {
                return;
            }
            let edges = logical_vertical_passages_matching(maze, self.passage_type);
            let count = edges.len() as u64;
            match Self::to_remove_for(count, field_cells, max_ratio) {
                0 => return,
                n => (edges, n),
            }
        };

        let issue = InvalidVerticalPassageGroupIssue::new_from_check(
            &self.instance_id,
            vec![(group, to_remove)],
        )
        .with_detail(&self.instance_id, "max_ratio", self.max_ratio.to_string());
        issues.push(issue);
    }
}

impl MaxVerticalPassageRatioCheck {
    fn to_remove_for(count: u64, field_cells: u64, max_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 <= max_ratio * field_cells as f64 {
            return 0;
        }
        let target_count = (max_ratio * field_cells as f64 / 100.0).round() as u64;
        count.saturating_sub(target_count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::LevelId;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "max_vertical_passage_ratio";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_ten_cell_floors() -> (Maze<SquareTessellation>, LevelId, LevelId) {
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
        (Maze::new(mf, g), bottom, top)
    }

    #[test]
    fn silent_when_ratio_meets_maximum() {
        let (mut maze, bottom, top) = maze_with_ten_cell_floors();
        let b0 = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let t0 = maze.field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            max_ratio: 10.0,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_to_remove_when_above_maximum() {
        let (mut maze, bottom, top) = maze_with_ten_cell_floors();
        for x in 0..3 {
            let b = maze.field.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = maze.field.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            maze.graph.add_edge(b, t, EdgeKind::VerticalPassage);
        }
        let check = MaxVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            max_ratio: 10.0,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3);
        assert_eq!(
            issues[0].groups[0].1, 1,
            "3 edges over 20 total cells vs target round(10*20/100)=2 -> 1 to remove"
        );
    }

    #[test]
    fn two_way_passage_counts_as_one_not_two() {
        let (mut maze, bottom, top) = maze_with_ten_cell_floors();
        let b0 = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let t0 = maze.field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            max_ratio: 10.0,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "a single two-way passage must count as 1 logical passage, meeting a 10-per-20-cells maximum of 2"
        );
    }

    #[test]
    fn passage_type_one_way_up_only_counts_matching_direction() {
        let (mut maze, bottom, top) = maze_with_ten_cell_floors();
        let b0 = maze
            .field
            .node_at(bottom, SquarePoint { x: 0, y: 0 })
            .unwrap();
        let t0 = maze.field.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            max_ratio: 0.0,
            passage_type: VerticalPassageType::OneWayUp,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "the existing passage goes down, not up, so the up-only maximum of 0 is not exceeded"
        );
    }
}
