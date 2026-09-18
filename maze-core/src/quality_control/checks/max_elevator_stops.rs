use super::elevator_core::elevator_groups;
use crate::Maze;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_ELEVATOR_STOPS_DEFAULT: u32 = 6;

/// Flags an elevator's own stop set invalid when it has more stops than `max_elevator_stops` —
/// see GitHub issue #399, part of epic #344. Scans every `elevator_groups(maze)` entry
/// independently: an elevator whose stop count exceeds the maximum becomes its own group (all of
/// its stops), paired with `to_remove = count - max_elevator_stops` — mirrors
/// `MaxElevatorCountCheck`'s whole-maze shape, but per-elevator instead of aggregating every
/// elevator into one group. Which stops within an over-budget elevator are actually removed is
/// `ElevatorStopGroupSelectStrategy`'s job, not this check's.
pub struct MaxElevatorStopsCheck {
    pub instance_id: String,
    pub max_elevator_stops: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for MaxElevatorStopsCheck {
    fn check_type_id(&self) -> &'static str {
        "max_elevator_stops"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorStopGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut groups: Vec<(Vec<crate::ids::NodeId>, u32)> = Vec::new();
        for elevator in elevator_groups(maze) {
            let count = elevator.stops.len() as u32;
            if count <= self.max_elevator_stops {
                continue;
            }
            let mut stops = elevator.stops;
            stops.sort_unstable();
            groups.push((stops, count - self.max_elevator_stops));
        }
        if groups.is_empty() {
            return;
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = InvalidElevatorStopGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(
                &self.instance_id,
                "max_elevator_stops",
                self.max_elevator_stops.to_string(),
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

    const TEST_ID: &str = "max_elevator_stops";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_one_elevator(
        stop_count: usize,
    ) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..stop_count)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        (Maze::new(mf, g), nodes)
    }

    #[test]
    fn fires_and_flags_every_stop_of_an_over_budget_elevator() {
        let (maze, nodes) = maze_with_one_elevator(4);
        let check = MaxElevatorStopsCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        let mut flagged = issues[0].groups[0].0.clone();
        flagged.sort_unstable();
        let mut expected = nodes;
        expected.sort_unstable();
        assert_eq!(
            flagged, expected,
            "every stop of the elevator must be offered to the repair strategy"
        );
        assert_eq!(
            issues[0].groups[0].1, 2,
            "to_remove must equal the excess stop count over the max"
        );
    }

    #[test]
    fn silent_when_stop_count_at_or_below_max() {
        let (maze, _nodes) = maze_with_one_elevator(2);
        let check = MaxElevatorStopsCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "stop count equal to the max must not fire"
        );
    }

    #[test]
    fn silent_when_no_elevators() {
        let (maze, _nodes) = maze_with_one_elevator(0);
        let check = MaxElevatorStopsCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops: 0,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn each_over_budget_elevator_becomes_its_own_group() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..4)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let a: Vec<_> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        let b: Vec<_> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 1, y: 0 }).unwrap())
            .collect();
        for nodes in [&a, &b] {
            for i in 0..nodes.len() {
                for j in (i + 1)..nodes.len() {
                    g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                    g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
                }
            }
        }
        let maze = Maze::new(mf, g);
        let check = MaxElevatorStopsCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            2,
            "both 4-stop elevators are over budget, each its own group"
        );
    }
}
