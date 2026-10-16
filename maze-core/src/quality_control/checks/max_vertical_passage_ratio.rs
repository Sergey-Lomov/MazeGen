use super::vertical_passage_count_core::{
    logical_vertical_passages_matching, logical_vertical_passages_per_floor,
};
use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::floor_group::floor_point_count;
use crate::quality_control::{FloorScope, InvalidVerticalPassageGroupIssue, VerticalPassageType};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;

pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT: f64 = 100.0;
pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;
pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;
pub const MAX_VERTICAL_PASSAGE_RATIO_DEFAULT_COUNT_INCOMING: bool = false;

/// Flags an excess against the share of logical `VerticalPassage` passages matching `passage_type`
/// relative to the field's size — see GitHub issue #343. Mirrors `MaxOneWayRatioCheck`: "passages
/// per 100 field cells", cross-multiplied excess gate, round-to-nearest `target_count`. Counts
/// logical passages, not edges — see `max_vertical_passage_count`'s doc comment for the double-count
/// fix this shares.
pub struct MaxVerticalPassageRatioCheck {
    pub instance_id: String,
    pub max_ratio: f64,
    pub floor_scope: FloorScope,
    pub passage_type: VerticalPassageType,
    pub count_incoming: bool,
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

        let (group, to_remove) = match self.floor_scope {
            FloorScope::WholeMaze => {
                let field_cells = maze.field.cell_count() as u64;
                if field_cells == 0 {
                    return;
                }
                let edges = logical_vertical_passages_matching(maze, self.passage_type);
                let count = edges.len() as u64;
                match Self::to_remove_for(count, field_cells, max_ratio) {
                    0 => return,
                    n => (edges, n),
                }
            }
            FloorScope::PerFloor => {
                let per_floor = logical_vertical_passages_per_floor(
                    maze,
                    self.passage_type,
                    self.count_incoming,
                );
                let mut over_budget: Vec<(LevelId, u32)> = Vec::new();
                for (&level, edges) in &per_floor {
                    let field_cells = floor_point_count(&maze.field, level) as u64;
                    let n = Self::to_remove_for(edges.len() as u64, field_cells, max_ratio);
                    if n > 0 {
                        over_budget.push((level, n));
                    }
                }
                if over_budget.is_empty() {
                    return;
                }
                over_budget.sort_by_key(|&(level, _)| level);
                let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();
                for (level, to_remove) in over_budget {
                    groups.push((per_floor[&level].clone(), to_remove));
                }
                let issue =
                    InvalidVerticalPassageGroupIssue::new_from_check(&self.instance_id, groups)
                        .with_detail(&self.instance_id, "max_ratio", self.max_ratio.to_string());
                issues.push(issue);
                return;
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "a single two-way passage must count as 1 logical passage, meeting a 10-per-20-cells maximum of 2"
        );
    }

    #[test]
    fn per_floor_groups_are_ordered_deterministically_by_level() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(10, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        for pair in floors.windows(2) {
            for x in 0..3 {
                let a = mf.node_at(pair[0], SquarePoint { x, y: 0 }).unwrap();
                let b = mf.node_at(pair[1], SquarePoint { x, y: 0 }).unwrap();
                g.add_edge(a, b, EdgeKind::VerticalPassage);
                g.add_edge(b, a, EdgeKind::VerticalPassage);
            }
        }
        let maze = Maze::new(mf, g);
        let check = MaxVerticalPassageRatioCheck {
            instance_id: TEST_ID.to_string(),
            max_ratio: 10.0,
            floor_scope: FloorScope::PerFloor,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            3,
            "all 3 floors are over the 10-per-10-cells maximum of 1"
        );
        let group_levels: Vec<LevelId> = issues[0]
            .groups
            .iter()
            .map(|(edges, _)| {
                maze.field
                    .level_of(maze.graph.edge(edges[0]).unwrap().from)
                    .unwrap()
            })
            .collect();
        let mut sorted_levels = group_levels.clone();
        sorted_levels.sort();
        assert_eq!(
            group_levels, sorted_levels,
            "groups must be emitted in ascending LevelId order, not HashMap iteration order"
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::OneWayUp,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "the existing passage goes down, not up, so the up-only maximum of 0 is not exceeded"
        );
    }
}
