use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{MissingElevatorsIssue, RepairArea};
use super::elevator_core::elevator_groups;

pub const MIN_ELEVATOR_DENSITY_DEFAULT: f64 = 5.0;

/// Flags a deficit against a minimum elevator density (elevators per 100 field cells) — see
/// GitHub issue #401, part of epic #344. Whole-maze scope only, same rationale as
/// `MinElevatorCountCheck`/`MaxElevatorDensityCheck`. Compares `count * 100` against
/// `min_density * field_cells` directly (cross-multiplied, no intermediate rounding), mirroring
/// `MinTeleportRatioCheck`'s own exact-comparison approach.
pub struct MinElevatorDensityCheck {
    pub instance_id: String,
    pub min_density: f64,
}

impl<T: Tessellation> Check<T, MissingElevatorsIssue> for MinElevatorDensityCheck {
    fn check_type_id(&self) -> &'static str { "min_elevator_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<MissingElevatorsIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let field_cells = maze.field.point_count() as u64;
        let count = elevator_groups(maze).len() as u64;
        let missing = Self::missing_for(count, field_cells, self.min_density);
        if missing == 0 {
            return;
        }
        let issue = MissingElevatorsIssue::new_from_check(&self.instance_id, vec![(RepairArea::WholeMaze, missing)])
            .with_detail(&self.instance_id, "missing", missing.to_string());
        issues.push(issue);
    }
}

impl MinElevatorDensityCheck {
    fn missing_for(count: u64, field_cells: u64, min_density: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 >= min_density * field_cells as f64 {
            return 0;
        }
        let required = (min_density * field_cells as f64 / 100.0).round() as u64;
        required.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_control::Issue;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_elevator_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// 20 field cells total (10 per floor), `count` of them carrying an elevator.
    fn maze_with_elevators(count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        for x in 0..count as i32 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn silent_when_density_meets_minimum() {
        let maze = maze_with_elevators(2);
        let check = MinElevatorDensityCheck { instance_id: TEST_ID.to_string(), min_density: 10.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "10 per 100 cells meets a minimum of 10");
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        // 1/20 = 5 per 100 cells, min_density 30 -> required = round(30*20/100) = 6, missing = 5.
        let maze = maze_with_elevators(1);
        let check = MinElevatorDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 5)]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"5".to_string()),
        );
    }

    #[test]
    fn silent_when_no_field_cells() {
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let g = Graph::new();
        let _ = &mut ids;
        let maze: Maze<SquareTessellation> = Maze::new(mf, g);

        let check = MinElevatorDensityCheck { instance_id: TEST_ID.to_string(), min_density: 10.0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn min_elevator_density_accepts_a_genuinely_fractional_threshold() {
        // 300/1000 = 30% density. min_density 29.9 must fire (density falls fractionally short);
        // 30.1 must not fire (density clears it) -- pins the exact cross-multiplied comparison.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(500, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(500, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        for x in 0..300 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        let maze = Maze::new(mf, g);

        let check = MinElevatorDensityCheck { instance_id: TEST_ID.to_string(), min_density: 30.1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "30% density must fall short of a fractional minimum of 30.1");
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 1)], "required=round(30.1*1000/100)=301, missing=1");

        let check = MinElevatorDensityCheck { instance_id: TEST_ID.to_string(), min_density: 29.9 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "30% density must clear a fractional minimum of 29.9");
    }
}
