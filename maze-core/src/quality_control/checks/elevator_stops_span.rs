use rand::RngCore;
use crate::Maze;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use super::elevator_core::elevator_groups;

pub const ELEVATOR_STOPS_SPAN_DEFAULT: u32 = 10;

/// Flags a pair of *any* two stops of the same elevator invalid when the floor-index gap between
/// them exceeds `elevator_stops_span` — see GitHub issue #400, part of epic #344. Unlike
/// `ElevatorStopsSkipCheck` (adjacent pairs only), every pair within an elevator is scanned — an
/// elevator's own topmost/bottommost span is just the pair with the largest gap, so scanning all
/// pairs also catches it without a separate topmost/bottommost special case. Reuses
/// `InvalidElevatorStopGroupIssue` (`ElevatorStopGroupKind`, `Element = NodeId`) with a two-stop
/// group per flagged pair and `to_remove: 1`, same shape `ElevatorStopsSkipCheck` uses — removing
/// either stop of the pair resolves it, which stop is `ElevatorStopGroupSelectStrategy`'s job, not
/// this check's.
pub struct ElevatorStopsSpanCheck {
    pub instance_id: String,
    pub elevator_stops_span: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for ElevatorStopsSpanCheck {
    fn check_type_id(&self) -> &'static str { "elevator_stops_span" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidElevatorStopGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut groups: Vec<(Vec<NodeId>, u32)> = Vec::new();

        for elevator in elevator_groups(maze) {
            let stops: Vec<(usize, NodeId)> = elevator.stops.iter()
                .filter_map(|&n| maze.field.level_index_of(n).map(|level| (level, n)))
                .collect();

            for i in 0..stops.len() {
                for j in (i + 1)..stops.len() {
                    let (level_a, node_a) = stops[i];
                    let (level_b, node_b) = stops[j];
                    let gap = level_a.abs_diff(level_b) as u32;
                    if gap > self.elevator_stops_span {
                        let mut group = vec![node_a, node_b];
                        group.sort_unstable();
                        groups.push((group, 1));
                    }
                }
            }
        }

        if groups.is_empty() {
            return;
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = InvalidElevatorStopGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "elevator_stops_span", self.elevator_stops_span.to_string());
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

    const TEST_ID: &str = "elevator_stops_span";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_elevator_at_floors(floor_count: usize, stop_floor_indices: &[usize]) -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..floor_count)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<NodeId> = stop_floor_indices.iter()
            .map(|&i| mf.node_at(floors[i], SquarePoint { x: 0, y: 0 }).unwrap())
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
    fn fires_on_a_pair_above_the_maximum_span() {
        let (maze, _nodes) = maze_with_elevator_at_floors(6, &[0, 5]);
        let check = ElevatorStopsSpanCheck { instance_id: TEST_ID.to_string(), elevator_stops_span: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        assert_eq!(issues[0].groups[0].1, 1);
    }

    #[test]
    fn silent_when_span_at_or_below_maximum() {
        let (maze, _nodes) = maze_with_elevator_at_floors(4, &[0, 3]);
        let check = ElevatorStopsSpanCheck { instance_id: TEST_ID.to_string(), elevator_stops_span: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "span equal to the max must not fire");
    }

    #[test]
    fn checks_every_pair_not_just_adjacent() {
        // Stops at floors 0, 1, 10 -- (0,1) gap=1 ok, (1,10) gap=9 and (0,10) gap=10 both exceed 3.
        let (maze, _nodes) = maze_with_elevator_at_floors(11, &[0, 1, 10]);
        let check = ElevatorStopsSpanCheck { instance_id: TEST_ID.to_string(), elevator_stops_span: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 2, "both (0,10) and (1,10) exceed the max span, not just the topmost/bottommost pair alone");
    }

    #[test]
    fn silent_when_no_elevators() {
        let (maze, _nodes) = maze_with_elevator_at_floors(2, &[]);
        let check = ElevatorStopsSpanCheck { instance_id: TEST_ID.to_string(), elevator_stops_span: 10 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
