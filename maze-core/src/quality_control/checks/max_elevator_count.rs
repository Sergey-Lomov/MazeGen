use super::elevator_core::elevator_groups;
use crate::Maze;
use crate::quality_control::check::Check;
use crate::quality_control::{ElevatorNodes, InvalidElevatorGroupIssue};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_ELEVATOR_COUNT_DEFAULT: u32 = 20;

/// Flags every elevator in the maze invalid when their total count exceeds `max_elevator_count` —
/// see GitHub issue #398, part of epic #344. Whole-maze scope only (no per-floor model, unlike
/// `MaxVerticalPassageCountCheck` — an elevator inherently spans several floors, so there is no
/// single "checked floor" to attribute it to). A field-wide/aggregate decision (mirrors
/// `MaxSplitCountCheck`'s identical rationale): which elevators to actually remove is
/// `ElevatorGroupSelectStrategy`'s job, not this check's. One group covering every elevator on the
/// maze, `to_remove` equal to the excess count over the maximum.
pub struct MaxElevatorCountCheck {
    pub instance_id: String,
    pub max_elevator_count: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorGroupIssue> for MaxElevatorCountCheck {
    fn check_type_id(&self) -> &'static str {
        "max_elevator_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let elevators: Vec<ElevatorNodes> = elevator_groups(maze)
            .into_iter()
            .map(|e| ElevatorNodes::new(e.stops))
            .collect();
        let count = elevators.len() as u32;
        if count <= self.max_elevator_count {
            return;
        }
        let to_remove = count - self.max_elevator_count;
        let issue = InvalidElevatorGroupIssue::new_from_check(
            &self.instance_id,
            vec![(elevators, to_remove)],
        )
        .with_detail(
            &self.instance_id,
            "max_elevator_count",
            self.max_elevator_count.to_string(),
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

    const TEST_ID: &str = "max_elevator_count";

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
    fn fires_and_flags_every_elevator_when_count_exceeds_max() {
        let maze = maze_with_elevators(3);
        let check = MaxElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_count: 1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(
            issues[0].groups[0].0.len(),
            3,
            "every elevator must be offered to the repair strategy"
        );
        assert_eq!(
            issues[0].groups[0].1, 2,
            "to_remove must equal the excess elevator count over the max"
        );
    }

    #[test]
    fn silent_when_count_at_or_below_max() {
        let maze = maze_with_elevators(2);
        let check = MaxElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_count: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn silent_when_no_elevators() {
        let maze = maze_with_elevators(0);
        let check = MaxElevatorCountCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_count: 0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
