use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{AreaMissingElevatorStopsIssue, FloorScope, RepairArea};
use crate::quality_control::floor_group::floor_point_count;
use super::elevator_core::elevator_stops_per_floor;

pub const MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT: f64 = 10.0;
pub const MIN_ELEVATOR_STOPS_PER_AREA_DENSITY_DEFAULT_FLOOR_SCOPE: FloorScope = FloorScope::PerFloor;

/// Flags a deficit against the share of elevator stops relative to field size, expressed per 100
/// field cells — see GitHub issue #408, part of epic #344. Mirrors `MinElevatorStopsPerAreaCountCheck`
/// but ratio-based instead of absolute-count-based; cross-multiplied comparison (same pattern as
/// `MinVerticalPassageRatioCheck::missing_for`) to avoid floor-rounding a passing ratio into a
/// false negative.
pub struct MinElevatorStopsPerAreaDensityCheck {
    pub instance_id: String,
    pub min_stops_ratio: f64,
    pub floor_scope: FloorScope,
}

impl<T: Tessellation> Check<T, AreaMissingElevatorStopsIssue> for MinElevatorStopsPerAreaDensityCheck {
    fn check_type_id(&self) -> &'static str { "min_elevator_stops_per_area_density" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<AreaMissingElevatorStopsIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let min_ratio = self.min_stops_ratio;
        let per_floor = elevator_stops_per_floor(maze);

        let missing: Vec<(RepairArea, u32)> = match self.floor_scope {
            FloorScope::WholeMaze => {
                let total: u64 = per_floor.values().map(|stops| stops.len() as u64).sum();
                let field_cells = maze.field.point_count() as u64;
                let missing = Self::missing_for(total, field_cells, min_ratio);
                if missing == 0 { vec![] } else { vec![(RepairArea::WholeMaze, missing)] }
            }
            FloorScope::PerFloor => {
                let mut missing: Vec<(RepairArea, u32)> = maze.field.levels_ordered().into_iter()
                    .filter_map(|level| {
                        let count = per_floor.get(&level).map_or(0, |stops| stops.len() as u64);
                        let missing = Self::missing_for(count, floor_point_count(&maze.field, level) as u64, min_ratio);
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
        let issue = AreaMissingElevatorStopsIssue::new_from_check(&self.instance_id, missing)
            .with_detail(&self.instance_id, "missing", total.to_string());
        issues.push(issue);
    }
}

impl MinElevatorStopsPerAreaDensityCheck {
    fn missing_for(count: u64, field_cells: u64, min_ratio: f64) -> u32 {
        if field_cells == 0 || count as f64 * 100.0 >= min_ratio * field_cells as f64 {
            return 0;
        }
        let required = (min_ratio * field_cells as f64 / 100.0).round() as u64;
        required.saturating_sub(count) as u32
    }
}

#[cfg(test)]
mod tests {
    use crate::quality_control::Issue;
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "min_elevator_stops_per_area_density";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two 10-cell floors (20 field cells total), one elevator stopping on both -> 2 stops total,
    /// 10 per 100 cells maze-wide.
    fn maze_with_one_elevator_on_ten_cell_floors() -> (Maze<SquareTessellation>, crate::ids::NodeId, crate::ids::NodeId) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        (Maze::new(mf, g), b0, t0)
    }

    #[test]
    fn silent_when_ratio_meets_minimum() {
        let (mut maze, b0, t0) = maze_with_one_elevator_on_ten_cell_floors();
        maze.graph.add_edge(b0, t0, EdgeKind::Elevator);
        maze.graph.add_edge(t0, b0, EdgeKind::Elevator);
        let check = MinElevatorStopsPerAreaDensityCheck { instance_id: TEST_ID.to_string(), min_stops_ratio: 10.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_below_minimum() {
        let (mut maze, b0, t0) = maze_with_one_elevator_on_ten_cell_floors();
        maze.graph.add_edge(b0, t0, EdgeKind::Elevator);
        maze.graph.add_edge(t0, b0, EdgeKind::Elevator);
        let check = MinElevatorStopsPerAreaDensityCheck { instance_id: TEST_ID.to_string(), min_stops_ratio: 30.0, floor_scope: FloorScope::WholeMaze };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // required = round(30*20/100) = 6, missing = 6 - 2 = 4.
        assert_eq!(issues[0].missing, vec![(RepairArea::WholeMaze, 4)]);
        assert_eq!(
            issues[0].details().get(TEST_ID).and_then(|kv| kv.get("missing")),
            Some(&"4".to_string()),
        );
    }

    /// Cross-multiplication edge case: a genuinely fractional threshold (mirrors
    /// `min_elevator_density_accepts_a_genuinely_fractional_threshold`) -- 1 stop on 10 cells is
    /// exactly 10 per 100, which must pass a 10.0 threshold via `>=` cross-multiplication, not
    /// fail due to floating point rounding down to e.g. 9.999999.
    #[test]
    fn accepts_a_genuinely_fractional_threshold() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::Elevator);
        g.add_edge(t0, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);
        // 1 stop on the bottom floor's 10 cells is exactly 10 per 100 cells.
        let check = MinElevatorStopsPerAreaDensityCheck { instance_id: TEST_ID.to_string(), min_stops_ratio: 10.0, floor_scope: FloorScope::PerFloor };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "exactly meeting the ratio must not fire, even with floating point cross-multiplication");
    }

    #[test]
    fn per_floor_flags_each_deficient_floor_with_its_own_area() {
        let (mut maze, b0, t0) = maze_with_one_elevator_on_ten_cell_floors();
        maze.graph.add_edge(b0, t0, EdgeKind::Elevator);
        maze.graph.add_edge(t0, b0, EdgeKind::Elevator);
        let check = MinElevatorStopsPerAreaDensityCheck { instance_id: TEST_ID.to_string(), min_stops_ratio: 20.0, floor_scope: FloorScope::PerFloor };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing.len(), 2, "both floors have 1 stop on 10 cells (10 per 100), deficient against a 20 per 100 minimum");
    }
}
