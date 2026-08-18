use std::collections::HashMap;
use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::{LevelId, Tessellation};
use crate::quality_control::check::Check;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use super::elevator_core::elevator_groups;

pub const MAX_ELEVATOR_STOPS_PER_FLOOR_DEFAULT: u32 = 3;

/// Flags a floor's elevator stops jointly invalid when their count exceeds
/// `max_elevator_stops_per_floor` — see GitHub issue #399, part of epic #344. Any elevator stop on
/// the floor counts, from any elevator (an elevator contributes one stop per floor it touches, by
/// construction — `elevator_core`'s `stops` never puts two of the same elevator's stops on one
/// floor). Groups every over-budget floor's stops into its own group, paired with
/// `to_remove = count - max_elevator_stops_per_floor` — mirrors
/// `MaxVerticalPassageCountCheck`'s `FloorScope::PerFloor` shape, sorted by `LevelId` for
/// determinism. Which stops on an over-budget floor are actually removed is
/// `ElevatorStopGroupSelectStrategy`'s job, not this check's.
pub struct MaxElevatorStopsPerFloorCheck {
    pub instance_id: String,
    pub max_elevator_stops_per_floor: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for MaxElevatorStopsPerFloorCheck {
    fn check_type_id(&self) -> &'static str { "max_elevator_stops_per_floor" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidElevatorStopGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut per_floor: HashMap<LevelId, Vec<NodeId>> = HashMap::new();
        for elevator in elevator_groups(maze) {
            for stop in elevator.stops {
                if let Some(level) = maze.field.level_of(stop) {
                    per_floor.entry(level).or_default().push(stop);
                }
            }
        }

        let mut over_budget: Vec<LevelId> = per_floor.iter()
            .filter(|&(_, stops)| stops.len() as u32 > self.max_elevator_stops_per_floor)
            .map(|(&level, _)| level)
            .collect();
        if over_budget.is_empty() {
            return;
        }
        over_budget.sort();

        let mut groups: Vec<(Vec<NodeId>, u32)> = Vec::new();
        for level in over_budget {
            let mut stops = per_floor[&level].clone();
            stops.sort_unstable();
            let excess = stops.len() as u32 - self.max_elevator_stops_per_floor;
            groups.push((stops, excess));
        }
        let issue = InvalidElevatorStopGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "max_elevator_stops_per_floor", self.max_elevator_stops_per_floor.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "max_elevator_stops_per_floor";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// `elevator_count` separate elevators, each spanning the same 2 floors, at distinct x
    /// positions -- puts `elevator_count` stops on each floor.
    fn maze_with_elevators_sharing_floors(elevator_count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(elevator_count.max(1), 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(elevator_count.max(1), 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        for x in 0..elevator_count as i32 {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
        }
        Maze::new(mf, g)
    }

    #[test]
    fn fires_and_flags_every_stop_on_an_over_budget_floor() {
        let maze = maze_with_elevators_sharing_floors(3);
        let check = MaxElevatorStopsPerFloorCheck { instance_id: TEST_ID.to_string(), max_elevator_stops_per_floor: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 2, "both floors (bottom and top) are over budget");
        for (stops, to_remove) in &issues[0].groups {
            assert_eq!(stops.len(), 3, "every stop on the floor must be offered to the repair strategy");
            assert_eq!(*to_remove, 2, "to_remove must equal the excess stop count over the max");
        }
    }

    #[test]
    fn silent_when_stops_per_floor_at_or_below_max() {
        let maze = maze_with_elevators_sharing_floors(2);
        let check = MaxElevatorStopsPerFloorCheck { instance_id: TEST_ID.to_string(), max_elevator_stops_per_floor: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn silent_when_no_elevators() {
        let maze = maze_with_elevators_sharing_floors(0);
        let check = MaxElevatorStopsPerFloorCheck { instance_id: TEST_ID.to_string(), max_elevator_stops_per_floor: 0 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn groups_are_ordered_deterministically_by_level() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        // Two elevators between floor 0-1, two between floor 1-2 -> floor 1 sees 4 stops, floors 0 and 2 see 2 each.
        for pair in floors.windows(2) {
            let a = mf.node_at(pair[0], SquarePoint { x: 0, y: 0 }).unwrap();
            let b = mf.node_at(pair[1], SquarePoint { x: 0, y: 0 }).unwrap();
            let c = mf.node_at(pair[0], SquarePoint { x: 1, y: 0 }).unwrap();
            let d = mf.node_at(pair[1], SquarePoint { x: 1, y: 0 }).unwrap();
            g.add_edge(a, b, EdgeKind::Elevator);
            g.add_edge(b, a, EdgeKind::Elevator);
            g.add_edge(c, d, EdgeKind::Elevator);
            g.add_edge(d, c, EdgeKind::Elevator);
        }
        let maze = Maze::new(mf, g);
        let check = MaxElevatorStopsPerFloorCheck { instance_id: TEST_ID.to_string(), max_elevator_stops_per_floor: 1 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 3, "all 3 floors are over the max of 1");
        let group_levels: Vec<LevelId> = issues[0].groups.iter()
            .map(|(stops, _)| maze.field.level_of(stops[0]).unwrap())
            .collect();
        let mut sorted_levels = group_levels.clone();
        sorted_levels.sort();
        assert_eq!(group_levels, sorted_levels, "groups must be emitted in ascending LevelId order, not HashMap iteration order");
    }
}
