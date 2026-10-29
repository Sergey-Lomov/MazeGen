use super::elevator_core::elevator_groups;
use crate::Maze;
use crate::graph::cycles::rounded_excess_over_density;
use crate::quality_control::check::Check;
use crate::quality_control::{ElevatorNodes, InvalidElevatorGroupIssue};
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_ELEVATOR_DENSITY_DEFAULT: f64 = 30.0;

/// Flags every elevator in the maze invalid when their density (share of field cells, per 100 —
/// see `density_per_100`) exceeds `max_density` — see GitHub issue #398, part of epic #344.
/// Whole-maze scope only (no per-floor model — see `MaxElevatorCountCheck`'s doc comment for why).
/// Mirrors `MaxSplitDensityCheck`'s identical rationale: a field-wide/aggregate decision, which
/// elevators to actually remove is `ElevatorGroupSelectStrategy`'s job. `to_remove` computed the
/// same way as `MaxSplitDensityCheck::to_remove_for`: `target_count` rounds `max_density *
/// field_cells / 100` to the nearest integer, `to_remove = count - target_count`. `field_cells` is
/// the maze's total point count across every floor — an elevator has no single owning floor, so
/// this can't reuse `floor_point_count` the way per-floor checks do.
pub struct MaxElevatorDensityCheck {
    pub instance_id: String,
    pub max_density: f64,
}

impl<T: Tessellation> Check<T, InvalidElevatorGroupIssue> for MaxElevatorDensityCheck {
    fn check_type_id(&self) -> &'static str {
        "max_elevator_density"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let field_cells = maze.field.cell_count();
        if field_cells == 0 {
            return;
        }
        let elevators: Vec<ElevatorNodes> = elevator_groups(maze)
            .into_iter()
            .map(|e| ElevatorNodes::new(e.stops))
            .collect();
        let to_remove = Self::to_remove_for(elevators.len(), field_cells, self.max_density);
        if to_remove == 0 {
            return;
        }
        let issue = InvalidElevatorGroupIssue::new_from_check(
            &self.instance_id,
            vec![(elevators, to_remove)],
        )
        .with_detail(
            &self.instance_id,
            "max_elevator_density",
            self.max_density.to_string(),
        );
        issues.push(issue);
    }
}

impl MaxElevatorDensityCheck {
    fn to_remove_for(count: usize, field_cells: usize, max_density: f64) -> u32 {
        rounded_excess_over_density(count, field_cells, max_density)
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

    const TEST_ID: &str = "max_elevator_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 20 field cells total (10 per floor), `count` of them carrying an elevator.
    fn maze_with_elevators(count: usize) -> Maze<SquareTessellation> {
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
        for x in 0..count as i32 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn fires_and_flags_every_elevator_when_density_exceeds_max() {
        // 3 elevators / 20 cells = 15% density.
        let maze = maze_with_elevators(3);
        let check = MaxElevatorDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups[0].0.len(), 3);
        assert_eq!(
            issues[0].groups[0].1, 1,
            "collapsing 1 elevator brings density to 10%, at the max"
        );
    }

    #[test]
    fn silent_when_density_at_or_below_max() {
        let maze = maze_with_elevators(2);
        let check = MaxElevatorDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 10.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "10% density must not fire against a max of 10"
        );
    }

    #[test]
    fn silent_when_no_elevators() {
        let maze = maze_with_elevators(0);
        let check = MaxElevatorDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 0.0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    /// 1000 field cells total (500 per floor), 300 of them carrying an elevator -- 30% density.
    fn maze_with_300_of_1000_elevators() -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(500, 1), &mut ids)
                .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(500, 1), &mut ids)
                .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        for x in 0..300 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn max_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density. max_density 30.1 must stay silent (density clears it); 29.9
        // must fire (density exceeds it fractionally) -- pins that the gate compares the true
        // density, not one rounded to a whole percentage first.
        let maze = maze_with_300_of_1000_elevators();
        let check = MaxElevatorDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 30.1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "30% density must not exceed a fractional maximum of 30.1"
        );

        let check = MaxElevatorDensityCheck {
            instance_id: TEST_ID.to_string(),
            max_density: 29.9,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "30% density must exceed a fractional maximum of 29.9"
        );
        assert_eq!(
            issues[0].groups[0].1, 1,
            "target_count=round(29.9*1000/100)=299, to_remove=300-299=1"
        );
    }
}
