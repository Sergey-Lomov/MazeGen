use super::elevator_core::{elevator_groups, stop_floors};
use crate::Maze;
use crate::quality_control::MissingElevatorHeightIssue;
use crate::quality_control::check::Check;
use crate::quality_control::issue_kinds::ElevatorNodes;
use crate::space::Tessellation;
use rand::RngCore;

pub const MIN_ELEVATOR_HEIGHT_DEFAULT: u32 = 3;

/// Flags an *existing* elevator whose vertical span (inclusive floor count between topmost and
/// bottommost stop) is below a configured minimum -- see GitHub issue #402, part of epic #344.
/// Distinct from `ElevatorSpanCheck` (`INVALID_ELEVATOR`, `Lt`): that check condemns the whole
/// elevator for removal/conversion; this one requests growing it instead. Deliberately reports
/// only the elevator and `min_height` -- growing the stop interval (possibly on both ends, since a
/// single added stop can't always close the gap) is `AddElevatorHeightStopStrategy`'s job.
pub struct MinElevatorHeightCheck {
    pub instance_id: String,
    pub min_height: u32,
}

impl<T: Tessellation> Check<T, MissingElevatorHeightIssue> for MinElevatorHeightCheck {
    fn check_type_id(&self) -> &'static str {
        "min_elevator_height"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingElevatorHeightIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut missing: Vec<(ElevatorNodes, u32)> = elevator_groups(maze)
            .into_iter()
            .filter_map(|elevator| {
                let floors = stop_floors(&elevator, maze);
                let (&bottom, &top) = (floors.first()?, floors.last()?);
                let span = (top - bottom + 1) as u32;
                if span >= self.min_height {
                    return None;
                }
                Some((ElevatorNodes::new(elevator.stops), self.min_height))
            })
            .collect();
        if missing.is_empty() {
            return;
        }
        missing.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = MissingElevatorHeightIssue::new_from_check(&self.instance_id, missing)
            .with_detail(
                &self.instance_id,
                "min_elevator_height",
                self.min_height.to_string(),
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

    const TEST_ID: &str = "min_elevator_height";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_elevator(
        floor_count: usize,
        stop_floor_indices: &[usize],
    ) -> (Maze<SquareTessellation>, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..floor_count)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(1, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<_> = stop_floor_indices
            .iter()
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
    fn silent_when_no_elevators() {
        let (maze, _nodes) = maze_with_elevator(4, &[]);
        let check = MinElevatorHeightCheck {
            instance_id: TEST_ID.to_string(),
            min_height: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_span_meets_minimum() {
        let (maze, _nodes) = maze_with_elevator(4, &[0, 3]);
        let check = MinElevatorHeightCheck {
            instance_id: TEST_ID.to_string(),
            min_height: 4,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_reporting_min_height_when_span_too_small() {
        let (maze, _nodes) = maze_with_elevator(6, &[0, 1]);
        let check = MinElevatorHeightCheck {
            instance_id: TEST_ID.to_string(),
            min_height: 3,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing.len(), 1);
        assert_eq!(issues[0].missing[0].1, 3);
    }

    #[test]
    fn fires_even_when_no_single_added_stop_could_close_the_gap() {
        // Stops at 3,5 out of 7 floors (0..=6), min_height 6 -- unreachable via one endpoint move,
        // but the check no longer tries to prove that; it just reports the deficit.
        let (maze, _nodes) = maze_with_elevator(7, &[3, 5]);
        let check = MinElevatorHeightCheck {
            instance_id: TEST_ID.to_string(),
            min_height: 6,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing.len(), 1);
        assert_eq!(issues[0].missing[0].1, 6);
    }
}
