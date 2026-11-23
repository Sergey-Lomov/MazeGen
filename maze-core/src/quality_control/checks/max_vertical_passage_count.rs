use super::vertical_passage_count_core::logical_vertical_passages_matching;
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidVerticalPassageGroupIssue, VerticalPassageType};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT: u32 = 1_000;
pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;

/// Flags an excess against a count of logical `VerticalPassage` passages matching `passage_type` —
/// see GitHub issue #343. Mirrors `MaxOneWayCountCheck`'s shape: the flagged passages (each
/// reported by its own canonical `EdgeId` — see `vertical_passage_count_core`'s doc comment) are
/// reported as a single group paired with the
/// excess count as `to_remove` — the strategy, not the check, decides which passages within the
/// group are actually removed (`VerticalPassageGroupSelectStrategy`). Counts logical passages, not
/// edges (a two-way passage's canonical edge is the only entry, never both directions) — this is
/// what fixes the earlier double-count bug and what lets `to_remove` map 1:1 onto
/// `RemoveVerticalPassageWithReverse` calls in `group_select_apply`.
pub struct MaxVerticalPassageCountCheck {
    pub instance_id: String,
    pub max_vertical_passages: u32,
    pub passage_type: VerticalPassageType,
}

impl<T: Tessellation> Check<T, InvalidVerticalPassageGroupIssue> for MaxVerticalPassageCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_vertical_passage_count"
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
        let (group, to_remove) = {
            let edges = logical_vertical_passages_matching(maze, self.passage_type);
            let count = edges.len() as u32;
            if count <= self.max_vertical_passages {
                return;
            }
            (edges, count - self.max_vertical_passages)
        };

        let issue = InvalidVerticalPassageGroupIssue::new_from_check(
            &self.instance_id,
            vec![(group, to_remove)],
        )
        .with_detail(
            &self.instance_id,
            "max_vertical_passages",
            self.max_vertical_passages.to_string(),
        );
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

    const TEST_ID: &str = "max_vertical_passage_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn two_floor_maze() -> (
        Maze<SquareTessellation>,
        crate::ids::NodeId,
        crate::ids::NodeId,
        crate::ids::NodeId,
    ) {
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
        let maze = Maze::new(mf, g);
        let _ = t1;
        (maze, b0, t0, b1)
    }

    #[test]
    fn silent_when_count_meets_maximum() {
        let (mut maze, b0, t0, b1) = two_floor_maze();
        let t1 = maze
            .field
            .node_at(maze.field.level_of(t0).unwrap(), SquarePoint { x: 1, y: 0 })
            .unwrap();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(b1, t1, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 2,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_all_edges_as_single_group_when_above_maximum() {
        let (mut maze, b0, t0, b1) = two_floor_maze();
        let t1 = maze
            .field
            .node_at(maze.field.level_of(t0).unwrap(), SquarePoint { x: 1, y: 0 })
            .unwrap();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(b1, t1, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 1,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 2);
        assert_eq!(issues[0].groups[0].1, 1);
    }

    #[test]
    fn two_way_passage_counts_as_one_not_two() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 1,
            passage_type: VerticalPassageType::Any,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "a single two-way passage must count as 1 logical passage, meeting a maximum of 1"
        );
    }

    #[test]
    fn passage_type_one_way_up_only_counts_matching_direction() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 0,
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
