use super::elevator_core::elevator_groups;
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{MissingElevatorsIssue, RepairArea};
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_ELEVATOR_COUNT_DEFAULT: u32 = 1;

/// Flags a deficit against a minimum count of elevators (`elevator_core::elevator_groups`) — see
/// GitHub issue #401, part of epic #344. Whole-maze scope only (no per-floor model — an elevator
/// inherently spans several floors, so there is no single "checked floor" to attribute it to, same
/// rationale as `MaxElevatorCountCheck`). Mirrors `MinTeleportCountCheck`'s role for teleports.
pub struct MinElevatorCountCheck {
    pub instance_id: String,
    pub min_elevators: u32,
}

impl<T: Tessellation> Check<T, MissingElevatorsIssue> for MinElevatorCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_elevator_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingElevatorsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let count = elevator_groups(maze).len() as u32;
        let missing = self.min_elevators.saturating_sub(count);
        if missing == 0 {
            return;
        }
        let issue = MissingElevatorsIssue::new_from_check(
            &self.instance_id,
            vec![(RepairArea::WholeMaze, missing)],
        )
        .with_detail(&self.instance_id, "missing", missing.to_string());
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

    const TEST_ID: &str = "min_elevator_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_elevators(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(
                Arc::default(),
                square_rect(count.max(1), 1),
                &mut ids,
            )
            .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(
                Arc::default(),
                square_rect(count.max(1), 1),
                &mut ids,
            )
            .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        for x in 0..count as i32 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn silent_when_count_meets_minimum() {
        let maze = maze_with_elevators(2);
        let check = MinElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            min_elevators: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let maze = maze_with_elevators(1);
        let check = MinElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            min_elevators: 3,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
        assert_eq!(
            issues[0]
                .details()
                .get(TEST_ID)
                .and_then(|kv| kv.get("missing")),
            Some(&"2".to_string()),
        );
    }

    #[test]
    fn fires_with_full_minimum_when_no_elevators_exist() {
        let maze = maze_with_elevators(0);
        let check = MinElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            min_elevators: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 2)]);
    }
}
