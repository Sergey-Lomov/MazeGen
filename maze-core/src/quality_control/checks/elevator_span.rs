use super::elevator_core::{elevator_groups, stop_floors};
use crate::Maze;
use crate::quality_control::InvalidElevatorIssue;
use crate::quality_control::check::Check;
use crate::quality_control::comparison::Comparison;
use crate::quality_control::issue_kinds::ElevatorNodes;
use crate::space::Tessellation;
use rand::RngCore;

pub const ELEVATOR_SPAN_DEFAULT: u32 = 10;
pub const ELEVATOR_SPAN_DEFAULT_COMPARISON: Comparison = Comparison::Lt;

/// Flags an elevator whose inter-stop vertical distance — the floor-index gap between its
/// topmost and bottommost stop (`stop_floors(elevator, maze)`'s last minus first) — compares
/// against a configured threshold. See GitHub issue #397. Mirrors `ElevatorStopCountCheck`'s
/// `Comparison`-parametrized shape: `Lt` flags a too-tightly-clustered elevator (e.g. an elevator
/// spanning only adjacent floors, which a plain `VerticalPassage` could serve just as well), `Gt`
/// flags one spanning an implausibly tall stretch of the maze.
pub struct ElevatorSpanCheck {
    pub instance_id: String,
    pub comparison: Comparison,
    pub span: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorIssue> for ElevatorSpanCheck {
    fn check_type_id(&self) -> &'static str {
        "elevator_span"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut invalid: Vec<ElevatorNodes> = elevator_groups(maze)
            .into_iter()
            .filter_map(|elevator| {
                let floors = stop_floors(&elevator, maze);
                let (first, last) = (*floors.first()?, *floors.last()?);
                let span = (last - first) as u32;
                self.comparison
                    .compare(span, self.span)
                    .then(|| ElevatorNodes::new(elevator.stops))
            })
            .collect();
        if invalid.is_empty() {
            return;
        }
        invalid.sort();
        let issue = InvalidElevatorIssue::new_from_check(&self.instance_id, invalid).with_detail(
            &self.instance_id,
            "span",
            self.span.to_string(),
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

    const TEST_ID: &str = "elevator_span";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn floor_maze(count: usize) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..count)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids)
                        .unwrap(),
                )
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
        (Maze::new(mf, g), nodes)
    }

    fn connect(maze: &mut Maze<SquareTessellation>, a: crate::ids::NodeId, b: crate::ids::NodeId) {
        maze.graph.add_edge(a, b, EdgeKind::Elevator);
        maze.graph.add_edge(b, a, EdgeKind::Elevator);
    }

    #[test]
    fn silent_when_no_elevators() {
        let (maze, _nodes) = floor_maze(4);
        let check = ElevatorSpanCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            span: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn lt_flags_a_too_short_span() {
        let (mut maze, nodes) = floor_maze(4);
        connect(&mut maze, nodes[0], nodes[1]); // span 1
        let check = ElevatorSpanCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            span: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn lt_silent_when_span_meets_threshold() {
        let (mut maze, nodes) = floor_maze(4);
        connect(&mut maze, nodes[0], nodes[3]); // span 3
        let check = ElevatorSpanCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Lt,
            span: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn gt_flags_a_too_long_span() {
        let (mut maze, nodes) = floor_maze(4);
        connect(&mut maze, nodes[0], nodes[3]); // span 3
        let check = ElevatorSpanCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            span: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn span_is_topmost_minus_bottommost_stop_not_stop_count() {
        let (mut maze, nodes) = floor_maze(4);
        // 3 stops, but topmost/bottommost only 1 apart (nodes[0], nodes[1]); nodes[1] connects
        // both -- span must read 1, not stop_count-1 (2).
        connect(&mut maze, nodes[0], nodes[1]);
        connect(&mut maze, nodes[1], nodes[0]);
        let check = ElevatorSpanCheck {
            instance_id: TEST_ID.to_string(),
            comparison: Comparison::Gt,
            span: 1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "span of 1 must not exceed a Gt threshold of 1"
        );
    }
}
