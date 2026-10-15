use super::vertical_passage_count_core::{
    count_logical_vertical_passages, logical_vertical_passages_per_floor,
};
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{
    FloorScope, MissingVerticalPassagesIssue, RepairArea, VerticalPassageType,
};
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_VERTICAL_PASSAGE_COUNT_DEFAULT: u32 = 1;
pub const MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;
pub const MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;
pub const MIN_VERTICAL_PASSAGE_COUNT_DEFAULT_COUNT_INCOMING: bool = false;

/// Flags a deficit against a count of logical `VerticalPassage` passages matching `passage_type` —
/// see GitHub issue #343. Mirrors `MinTeleportCountCheck`. Counts logical passages (a two-way
/// passage is one unit, not two) via `vertical_passage_count_core`'s `LogicalVerticalPassage` —
/// fixes the earlier double-count bug where each direction of a two-way passage counted on its own.
///
/// `floor_scope` (GitHub issue #369): under `PerFloor`, evaluated independently per floor (an
/// edge crossing floors counts toward both) and the per-floor deficits are summed into `missing`.
/// `count_incoming` only affects one-way passages under `PerFloor` — see
/// `logical_vertical_passages_per_floor`'s doc comment; ignored under `WholeMaze`.
pub struct MinVerticalPassageCountCheck {
    pub instance_id: String,
    pub min_vertical_passages: u32,
    pub floor_scope: FloorScope,
    pub passage_type: VerticalPassageType,
    pub count_incoming: bool,
}

impl<T: Tessellation> Check<T, MissingVerticalPassagesIssue> for MinVerticalPassageCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_vertical_passage_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingVerticalPassagesIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let missing = self
                    .min_vertical_passages
                    .saturating_sub(count_logical_vertical_passages(maze, self.passage_type));
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
                    let missing = self
                        .min_vertical_passages
                        .saturating_sub(edges.len() as u32);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_vertical_passage_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn two_floor_maze() -> (
        Maze<SquareTessellation>,
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
        (Maze::new(mf, g), b0, t0)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 1,
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
        let (maze, _b0, _t0) = two_floor_maze();
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 2,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    }

    #[test]
    fn two_way_passage_counts_as_one_not_two() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 2,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "a single two-way passage must count as 1, leaving 1 missing against a minimum of 2"
        );
    }

    #[test]
    fn passage_type_one_way_up_ignores_a_downward_passage() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 1,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::OneWayUp,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "the existing passage goes down, not up, so the up-only minimum is still unmet"
        );
    }

    #[test]
    fn does_not_count_a_basic_edge() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::Basic);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 1,
            floor_scope: FloorScope::WholeMaze,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "a Basic edge must not count toward the vertical passage total"
        );
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        maze.graph.add_edge(t0, b0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 2,
            floor_scope: FloorScope::PerFloor,
            passage_type: VerticalPassageType::Any,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut missing = issues[0].missing.clone();
        missing.sort_by_key(|&(_, amount)| amount);
        assert_eq!(
            missing.len(),
            2,
            "each floor has 1 two-way vertical passage touching it, both deficient against a minimum of 2"
        );
        for (_, amount) in &missing {
            assert_eq!(*amount, 1);
        }
    }

    #[test]
    fn per_floor_one_way_without_count_incoming_only_flags_the_from_floor() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 1,
            floor_scope: FloorScope::PerFloor,
            passage_type: VerticalPassageType::OneWayUp,
            count_incoming: false,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "the from floor (bottom) already sees the passage, and the top floor is excluded -- it can never be a from for OneWayUp"
        );
    }

    #[test]
    fn per_floor_one_way_with_count_incoming_flags_neither_floor() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let check = MinVerticalPassageCountCheck {
            instance_id: TEST_ID.to_string(),
            min_vertical_passages: 1,
            floor_scope: FloorScope::PerFloor,
            passage_type: VerticalPassageType::OneWayUp,
            count_incoming: true,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "with count_incoming, both floors see the one-way passage, so neither is deficient"
        );
    }
}
