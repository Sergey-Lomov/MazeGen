use super::vertical_passage_count_core::{
    logical_vertical_passages_matching, logical_vertical_passages_per_floor,
};
use crate::Maze;
use crate::ids::EdgeId;
use crate::quality_control::check::Check;
use crate::quality_control::{FloorScope, InvalidVerticalPassageGroupIssue, VerticalPassageType};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;

pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT: u32 = 1_000;
pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;
pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;
pub const MAX_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING: bool = false;

/// Flags an excess against a count of logical `VerticalPassage` passages matching `passage_type` —
/// see GitHub issue #343. Mirrors `MaxOneWayCountCheck`'s shape: the flagged passages (each
/// reported by its own canonical `EdgeId` — see `vertical_passage_count_core`'s doc comment) are
/// reported as a single group (or one group per over-budget floor under `PerFloor`) paired with the
/// excess count as `to_remove` — the strategy, not the check, decides which passages within the
/// group are actually removed (`VerticalPassageGroupSelectStrategy`). Counts logical passages, not
/// edges (a two-way passage's canonical edge is the only entry, never both directions) — this is
/// what fixes the earlier double-count bug and what lets `to_remove` map 1:1 onto
/// `RemoveVerticalPassageWithReverse` calls in `group_select_apply`.
pub struct MaxVerticalPassageCountCheck {
    pub instance_id: String,
    pub max_vertical_passages: u32,
    pub floor_scope: FloorScope,
    pub passage_type: VerticalPassageType,
    pub count_incoming: bool,
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
        let (group, to_remove) = match self.floor_scope {
            FloorScope::WholeMaze => {
                let edges = logical_vertical_passages_matching(maze, self.passage_type);
                let count = edges.len() as u32;
                if count <= self.max_vertical_passages {
                    return;
                }
                (edges, count - self.max_vertical_passages)
            }
            FloorScope::PerFloor => {
                let per_floor = logical_vertical_passages_per_floor(
                    maze,
                    self.passage_type,
                    self.count_incoming,
                );
                let mut over_budget: Vec<LevelId> = per_floor
                    .iter()
                    .filter(|&(_, edges)| edges.len() as u32 > self.max_vertical_passages)
                    .map(|(&level, _)| level)
                    .collect();
                if over_budget.is_empty() {
                    return;
                }
                over_budget.sort();
                let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();
                for level in over_budget {
                    let flagged = &per_floor[&level];
                    let excess = flagged.len() as u32 - self.max_vertical_passages;
                    groups.push((flagged.clone(), excess));
                }
                let issue =
                    InvalidVerticalPassageGroupIssue::new_from_check(&self.instance_id, groups)
                        .with_detail(
                            &self.instance_id,
                            "max_vertical_passages",
                            self.max_vertical_passages.to_string(),
                        );
                issues.push(issue);
                return;
            }
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
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
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
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "a single two-way passage must count as 1 logical passage, meeting a maximum of 1"
        );
    }

    #[test]
    fn per_floor_groups_are_ordered_deterministically_by_level() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        // Two two-way passages on each floor boundary put every floor at count 2, over a max of 1.
        for pair in floors.windows(2) {
            let a = mf.node_at(pair[0], SquarePoint { x: 0, y: 0 }).unwrap();
            let b = mf.node_at(pair[1], SquarePoint { x: 0, y: 0 }).unwrap();
            let c = mf.node_at(pair[0], SquarePoint { x: 1, y: 0 }).unwrap();
            let d = mf.node_at(pair[1], SquarePoint { x: 1, y: 0 }).unwrap();
            g.add_edge(a, b, EdgeKind::VerticalPassage);
            g.add_edge(b, a, EdgeKind::VerticalPassage);
            g.add_edge(c, d, EdgeKind::VerticalPassage);
            g.add_edge(d, c, EdgeKind::VerticalPassage);
        }
        let maze = Maze::new(mf, g);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 1,
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
            "all 3 floors are over the max of 1"
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
            "groups must be emitted in ascending LevelId order, not HashSet iteration order"
        );
    }

    #[test]
    fn passage_type_one_way_up_only_counts_matching_direction() {
        let (mut maze, b0, t0, _b1) = two_floor_maze();
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MaxVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            max_vertical_passages: 0,
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
