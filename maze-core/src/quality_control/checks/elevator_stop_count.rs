use rand::RngCore;
use crate::Maze;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::InvalidElevatorIssue;
use crate::quality_control::issue_kinds::ElevatorNodes;
use super::elevator_core::{elevator_groups, stop_floors};

pub const ELEVATOR_STOP_COUNT_DEFAULT: u32 = 2;
pub const ELEVATOR_STOP_COUNT_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Flags an elevator whose stop count (distinct floors it connects — see `stop_floors`) compares
/// against a configured threshold — see GitHub issue #397. `comparison: Lt` flags an elevator with
/// too few stops, `Gt` one with too many; both are the same "this elevator is invalid" problem on
/// the same entity, so they share one check type parametrized by `Comparison` rather than a
/// min/max pair (see `Comparison`'s own doc comment for the merge rule).
pub struct ElevatorStopCountCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub count: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorIssue> for ElevatorStopCountCheck {
    fn check_type_id(&self) -> &'static str { "elevator_stop_count" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidElevatorIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let mut invalid: Vec<ElevatorNodes> = elevator_groups(maze).into_iter()
            .filter(|elevator| self.comparison.compare(stop_floors(elevator, maze).len() as u32, self.count))
            .map(|elevator| ElevatorNodes::new(elevator.stops))
            .collect();
        if invalid.is_empty() {
            return;
        }
        invalid.sort();
        let issue = InvalidElevatorIssue::new_from_check(&self.instance_id, invalid)
            .with_detail(&self.instance_id, "count", self.count.to_string());
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

    const TEST_ID: &str = "elevator_stop_count";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn three_floor_maze() -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        (Maze::new(mf, g), nodes)
    }

    fn connect_fan(maze: &mut Maze<SquareTessellation>, nodes: &[crate::ids::NodeId]) {
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                maze.graph.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                maze.graph.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
    }

    #[test]
    fn silent_when_no_elevators() {
        let (maze, _nodes) = three_floor_maze();
        let check = ElevatorStopCountCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, count: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn lt_flags_an_elevator_with_too_few_stops() {
        let (mut maze, nodes) = three_floor_maze();
        connect_fan(&mut maze, &nodes[0..2]);
        let check = ElevatorStopCountCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, count: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
    }

    #[test]
    fn lt_silent_when_stop_count_meets_threshold() {
        let (mut maze, nodes) = three_floor_maze();
        connect_fan(&mut maze, &nodes);
        let check = ElevatorStopCountCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, count: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn gt_flags_an_elevator_with_too_many_stops() {
        let (mut maze, nodes) = three_floor_maze();
        connect_fan(&mut maze, &nodes);
        let check = ElevatorStopCountCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Gt, count: 2 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn flags_only_the_offending_elevator_among_several() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let a: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        let b: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 1, y: 0 }).unwrap()).collect();
        let mut maze: Maze<SquareTessellation> = Maze::new(mf, g.clone());
        connect_fan(&mut maze, &a);
        // b only gets 2 stops, a gets all 3.
        maze.graph.add_edge(b[0], b[1], EdgeKind::Elevator);
        maze.graph.add_edge(b[1], b[0], EdgeKind::Elevator);

        let check = ElevatorStopCountCheck { instance_id: TEST_ID.to_string(), comparison: Comparison::Lt, count: 3 };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].invalid.len(), 1);
        let mut expected_b = vec![b[0], b[1]];
        expected_b.sort_unstable();
        assert_eq!(issues[0].invalid[0].0, expected_b);
        let _ = g;
    }
}
