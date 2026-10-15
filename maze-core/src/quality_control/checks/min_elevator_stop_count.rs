use super::elevator_core::{elevator_groups, stop_floors};
use crate::Maze;
use crate::quality_control::MissingElevatorStopCountIssue;
use crate::quality_control::check::Check;
use crate::quality_control::issue_kinds::ElevatorNodes;
use crate::space::{LevelId, Tessellation};
use rand::RngCore;

pub const MIN_ELEVATOR_STOP_COUNT_DEFAULT: u32 = 2;

/// Flags an *existing* elevator whose own stop count (`stop_floors(elevator, maze).len()`,
/// distinct floors) is below a configured minimum — see GitHub issue #402, part of epic #344.
/// Distinct from `MinElevatorCountCheck`: that check flags a deficit in the overall *number* of
/// elevators (repaired by building brand-new ones); this one flags a deficit in one already-built
/// elevator's stop count (repaired by adding stops to it, `AddElevatorStopCountStrategy`). For each
/// under-count elevator, offers every floor the elevator's own `(x, y)` point has a node on but
/// isn't already stopping at as `available` — "all free floors", per the issue's own wording.
pub struct MinElevatorStopCountCheck {
    pub instance_id: String,
    pub min_stop_count: u32,
}

impl<T: Tessellation> Check<T, MissingElevatorStopCountIssue> for MinElevatorStopCountCheck {
    fn check_type_id(&self) -> &'static str {
        "min_elevator_stop_count"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<MissingElevatorStopCountIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut missing: Vec<(ElevatorNodes, u32, Vec<LevelId>)> = elevator_groups(maze)
            .into_iter()
            .filter_map(|elevator| {
                let stop_count = stop_floors(&elevator, maze).len() as u32;
                if stop_count >= self.min_stop_count {
                    return None;
                }
                let deficit = self.min_stop_count - stop_count;
                let available = free_floors(maze, &elevator.stops);
                Some((ElevatorNodes::new(elevator.stops), deficit, available))
            })
            .collect();
        if missing.is_empty() {
            return;
        }
        missing.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = MissingElevatorStopCountIssue::new_from_check(&self.instance_id, missing)
            .with_detail(
                &self.instance_id,
                "min_elevator_stop_count",
                self.min_stop_count.to_string(),
            );
        issues.push(issue);
    }
}

/// Every floor (`LevelId`) at the elevator's own `(x, y)` point that carries a node but isn't
/// already one of `stops` — "all free floors", per GitHub issue #402's wording for
/// `MinStopCountCheck`. Assumes every stop shares the same point (true by construction — an
/// elevator only ever grows along one point's own column of floors); the point is read from the
/// first stop.
fn free_floors<T: Tessellation>(maze: &Maze<T>, stops: &[crate::ids::NodeId]) -> Vec<LevelId> {
    let Some(&first) = stops.first() else {
        return Vec::new();
    };
    let Some(point) = maze.field.point_of(first) else {
        return Vec::new();
    };
    maze.field
        .levels_ordered()
        .filter(|&level| {
            maze.field
                .node_at(level, point)
                .is_some_and(|n| !stops.contains(&n))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "min_elevator_stop_count";

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
        let (maze, _nodes) = maze_with_elevator(3, &[]);
        let check = MinElevatorStopCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stop_count: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_stop_count_meets_minimum() {
        let (maze, _nodes) = maze_with_elevator(4, &[0, 1, 2]);
        let check = MinElevatorStopCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stop_count: 3,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_with_deficit_and_free_floors_when_below_minimum() {
        let (maze, nodes) = maze_with_elevator(5, &[0, 1]);
        let check = MinElevatorStopCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stop_count: 4,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing.len(), 1);
        let (elevator, deficit, available) = &issues[0].missing[0];
        assert_eq!(elevator.0, {
            let mut v = nodes.clone();
            v.sort_unstable();
            v
        });
        assert_eq!(*deficit, 2);
        assert_eq!(
            available.len(),
            3,
            "floors 2,3,4 are free (0,1 already stopped at)"
        );
    }

    #[test]
    fn only_under_count_elevators_are_flagged() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..4)
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
        // Elevator A (point x=0): 2 stops, below minimum 3.
        let a0 = mf.node_at(floors[0], SquarePoint { x: 0, y: 0 }).unwrap();
        let a1 = mf.node_at(floors[1], SquarePoint { x: 0, y: 0 }).unwrap();
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        // Elevator B (point x=1): 3 stops, at the minimum.
        let b0 = mf.node_at(floors[0], SquarePoint { x: 1, y: 0 }).unwrap();
        let b1 = mf.node_at(floors[1], SquarePoint { x: 1, y: 0 }).unwrap();
        let b2 = mf.node_at(floors[2], SquarePoint { x: 1, y: 0 }).unwrap();
        for (i, j) in [(b0, b1), (b1, b0), (b0, b2), (b2, b0), (b1, b2), (b2, b1)] {
            g.add_edge(i, j, EdgeKind::Elevator);
        }
        let maze = Maze::new(mf, g);

        let check = MinElevatorStopCountCheck {
            instance_id: TEST_ID.to_string(),
            min_stop_count: 3,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing.len(),
            1,
            "only elevator A is below the minimum"
        );
        assert_eq!(issues[0].missing[0].0.0, {
            let mut v = vec![a0, a1];
            v.sort_unstable();
            v
        });
    }
}
