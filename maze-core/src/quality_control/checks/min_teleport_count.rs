use super::teleport_count_core::{count_distinct_teleports, count_distinct_teleports_per_floor};
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{FloorScope, MissingTeleportsIssue, RepairArea};
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_TELEPORT_COUNT_DEFAULT: u32 = 1;
pub const MIN_TELEPORT_COUNT_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::WholeMaze;

/// Flags a deficit against a count of distinct teleports — see GitHub issue #211. Mirrors
/// `MinOneWayCountCheck`'s role for one-ways, but counts via `count_distinct_teleports` (a
/// bidirectional teleport is one portal, not two) rather than a reverse-lookup filter — see that
/// function's doc comment for why `EdgeKind::Teleport` needs different dedup than one-ways.
///
/// `floor_scope` (GitHub issue #369): under `PerFloor`, `min_teleports` is evaluated
/// independently per floor (a teleport crossing floors counts toward both) and the per-floor
/// deficits are summed into one `missing` total.
pub struct MinTeleportCountCheck {
    pub instance_id: String,
    pub min_teleports: u32,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, MissingTeleportsIssue> for MinTeleportCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_teleport_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingTeleportsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let missing = self
                    .min_teleports
                    .saturating_sub(count_distinct_teleports(maze));
                if missing == 0 {
                    vec![]
                } else {
                    vec![(RepairArea::WholeMaze, missing)]
                }
            }
            FloorScope::PerFloor => {
                let mut missing: Vec<(RepairArea, u32)> = count_distinct_teleports_per_floor(maze)
                    .into_iter()
                    .filter_map(|(level, count)| {
                        let missing = self.min_teleports.saturating_sub(count);
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
        let issue = MissingTeleportsIssue::new_from_check(&self.instance_id, missing).with_detail(
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

    const TEST_ID: &str = "min_teleport_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 4-tile corridor with one teleport edge (0->1) and one bidirectional passage (1<->2<->3).
    fn maze_with_one_teleport() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(4, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        Maze::new(field, g)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_one_teleport();
        let check = MinTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            min_teleports: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_one_teleport();
        let check = MinTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            min_teleports: 3,
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
    fn does_not_count_a_basic_edge() {
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

        let check = MinTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            min_teleports: 1,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "a Basic edge must not count toward the teleport total"
        );
    }

    #[test]
    fn a_bidirectional_teleport_pair_counts_as_one() {
        let mut ids = IdGenerator::new();
        let field = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let field_level = field.single_level_id();
        let mut g = Graph::new();
        for node in field.all_node_ids() {
            g.add_node(node);
        }
        let p = |x: i32| field.node_at(field_level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Teleport);
        g.add_edge(p(1), p(0), EdgeKind::Teleport);
        let maze: Maze<SquareTessellation> = Maze::new(field, g);

        let check = MinTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            min_teleports: 2,
            floor_scope: FloorScope::WholeMaze,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing,
            vec![(RepairArea::WholeMaze, 1)],
            "A<->B is one logical portal, not two"
        );
    }

    /// Bottom floor: 1 teleport (0->1). Top floor: 0 teleports.
    fn maze_with_teleports_on_two_floors() -> Maze<SquareTessellation> {
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
        g.add_edge(pb(0), pb(1), EdgeKind::Teleport);
        let _ = top;
        Maze::new(mf, g)
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area_and_amount() {
        let maze = maze_with_teleports_on_two_floors();
        let check = MinTeleportCountCheck {
            instance_id: TEST_ID.to_string(),
            min_teleports: 2,
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
        assert_eq!(missing[0].1, 1, "bottom floor: 1 teleport, needs 1 more");
        assert_eq!(missing[1].1, 2, "top floor: 0 teleports, needs 2 more");
    }
}
