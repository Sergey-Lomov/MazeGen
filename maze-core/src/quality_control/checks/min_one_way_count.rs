use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::checks::one_way_core::one_way_edge_ids;
use crate::quality_control::floor_group::floors_of_edge;
use crate::quality_control::{FloorScope, MissingOneWaysIssue, RepairArea};
use crate::space::{LevelId, Tessellation};
use rand::RngCore;
use std::collections::HashMap;

pub const MIN_ONE_WAY_COUNT_DEFAULT: u32 = 1;
pub const MIN_ONE_WAY_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags a deficit against a raw count of one-way passage edges (`EdgeKind::Basic`, single
/// direction) — see GitHub issue #201, part of the one-way management epic (#92). Mirrors
/// `MinLoopsCountCheck`'s role for loops.
///
/// `floor_scope` (GitHub issue #369): under `PerFloor`, `min_one_ways` is evaluated independently
/// per floor (a one-way crossing floors counts toward both) and the per-floor deficits are summed
/// into one `missing` total.
pub struct MinOneWayCountCheck {
    pub instance_id: String,
    pub min_one_ways: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingOneWaysIssue> for MinOneWayCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_one_way_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingOneWaysIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let one_ways = one_way_edge_ids(maze);

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let missing = self.min_one_ways.saturating_sub(one_ways.len() as u32);
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let mut per_floor_count: HashMap<LevelId, u32> =
                    maze.field.levels_ordered().map(|l| (l, 0)).collect();
                for &id in &one_ways {
                    for level in floors_of_edge(&maze.field, &maze.graph, id) {
                        *per_floor_count.entry(level).or_insert(0) += 1;
                    }
                }
                let mut missing: Vec<(RepairArea, u32)> = per_floor_count
                    .into_iter()
                    .filter_map(|(level, count)| {
                        let missing = self.min_one_ways.saturating_sub(count);
                        (missing > 0).then_some((RepairArea::Level(level), missing))
                    })
                    .collect();
                // `HashMap` iteration order is randomized per run -- sort by level so repair
                // strategies that loop over `issue.missing` consume RNG in a deterministic order.
                missing.sort_by_key(|&(area, _)| area);
                missing
            }
        };
        if missing.is_empty() {
            return;
        }
        let total: u32 = missing.iter().map(|(_, m)| m).sum();
        let issue = MissingOneWaysIssue::new_from_check(&self.instance_id, missing).with_detail(
            &self.instance_id,
            "missing",
            total.to_string(),
        );
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::quality_control::Issue;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "min_one_way_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4-tile corridor with one one-way edge (0->1) and one bidirectional passage (1<->2<->3).
    fn maze_with_one_one_way() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_one_one_way();
        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_one_one_way();
        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 3,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn does_not_count_bidirectional_passage_as_one_way() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "bidirectional passage must not count toward the one-way total"
        );
    }

    #[test]
    fn does_not_count_a_teleport_edge() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "a Teleport edge must not count toward the Basic one-way total"
        );
    }

    #[test]
    fn flags_a_basic_one_way_paired_with_a_parallel_reverse_teleport() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "the parallel reverse Teleport must not mask the Basic one-way"
        );
    }

    /// Bottom floor: 1 one-way (0->1). Top floor: 0 one-ways.
    fn maze_with_one_ways_on_two_floors() -> Maze<SquareTessellation> {
        use crate::space::Field;
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(4, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(4, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let pb = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(pb(0), pb(1), EdgeKind::Basic);
        let _ = top;
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        let maze = maze_with_one_ways_on_two_floors();
        let check = MinOneWayCountCheck {
            instance_id: TEST_ID.to_string(),
            min_one_ways: 2,
            floor_scope: FloorScope::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let mut missing = issues[0].missing.clone();
        missing.sort_by_key(|&(_, amount)| amount);
        assert_eq!(
            missing.len(),
            2,
            "each deficient floor gets its own RepairArea::Level entry"
        );
        assert_eq!(missing[0].1, 1, "bottom floor: 1 one-way, needs 1 more");
        assert_eq!(missing[1].1, 2, "top floor: 0 one-ways, needs 2 more");
    }
}
