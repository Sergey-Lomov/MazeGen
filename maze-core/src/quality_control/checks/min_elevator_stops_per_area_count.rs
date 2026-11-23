use super::elevator_core::elevator_stops_per_floor;
use crate::Maze;
use crate::quality_control::AreaMissingElevatorStopsIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_ELEVATOR_STOPS_PER_AREA_COUNT_DEFAULT: u32 = 1;

/// Flags a deficit against the count of elevator stops (distinct floor-touches across every
/// elevator, `elevator_core::elevator_stops_per_floor`) — see GitHub issue #408, part of epic
/// #344. Distinct from `MinElevatorCountCheck`: that check counts elevators (connected-component
/// groups); this one counts individual stops, so a single elevator can satisfy or fail this check
/// depending on how many floors it actually touches.
pub struct MinElevatorStopsPerAreaCountCheck {
    pub instance_id: String,
    pub min_stops: u32,
}

impl<T: Tessellation> Check<T, AreaMissingElevatorStopsIssue>
    for MinElevatorStopsPerAreaCountCheck
{
    fn check_type_id(&self) -> &'static str {
        "min_elevator_stops_per_area_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<AreaMissingElevatorStopsIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let per_floor = elevator_stops_per_floor(maze);

        let total: u32 = per_floor.values().map(|stops| stops.len() as u32).sum();
        let missing = self.min_stops.saturating_sub(total);
        if missing == 0 {
            return;
        }

        let issue = AreaMissingElevatorStopsIssue::new_from_check(&self.instance_id, missing)
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

    const TEST_ID: &str = "min_elevator_stops_per_area_count";

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
    fn silent_when_whole_maze_stop_count_meets_minimum() {
        let (mut maze, b0, t0) = two_floor_maze();
        maze.graph.add_edge(b0, t0, EdgeKind::Elevator);
        maze.graph.add_edge(t0, b0, EdgeKind::Elevator);
        let check = MinElevatorStopsPerAreaCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stops: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_missing_count_when_whole_maze_below_minimum() {
        let (maze, _b0, _t0) = two_floor_maze();
        let check = MinElevatorStopsPerAreaCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stops: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing, 2);
        assert_eq!(issues[0].source_checks(), vec![TEST_ID.to_string()]);
    }
}
