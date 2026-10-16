use super::elevator_core::{elevator_groups, stop_floors};
use crate::Maze;
use crate::quality_control::ExcessiveElevatorStopGapIssue;
use crate::quality_control::check::Check;
use crate::quality_control::issue_kinds::ElevatorNodes;
use crate::space::Tessellation;
use rand::RngCore;

pub const MAX_ELEVATOR_STOP_GAP_DEFAULT: u32 = 4;

/// Flags an *existing* elevator with a consecutive stop pair (adjacent after sorting by floor
/// index) whose gap -- the number of floors skipped between them, i.e. `hi_index - lo_index - 1`
/// -- exceeds a configured maximum -- see GitHub issue #402, part of epic #344. An elevator with
/// several over-large gaps produces one `missing` entry per gap. Deliberately reports only the
/// elevator and the gap's own bottom/top floor -- picking a floor strictly between them is
/// `AddElevatorStopForGapStrategy`'s job, not the check's.
pub struct MaxElevatorStopGapCheck {
    pub instance_id: String,
    pub max_stop_gap: u32,
}

impl<T: Tessellation> Check<T, ExcessiveElevatorStopGapIssue> for MaxElevatorStopGapCheck {
    fn check_type_id(&self) -> &'static str {
        "max_elevator_stop_gap"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<ExcessiveElevatorStopGapIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut missing = Vec::new();

        for elevator in elevator_groups(maze) {
            let floors = stop_floors(&elevator, maze);
            let Some(point) = elevator.stops.first().and_then(|&n| maze.field.cell_of(n)) else {
                continue;
            };
            let Some(levels_by_index) = levels_by_index(maze, point) else {
                continue;
            };

            for pair in floors.windows(2) {
                let (lo, hi) = (pair[0], pair[1]);
                let gap = (hi - lo - 1) as u32;
                if gap <= self.max_stop_gap {
                    continue;
                }
                let (Some(&lo_level), Some(&hi_level)) =
                    (levels_by_index.get(&lo), levels_by_index.get(&hi))
                else {
                    continue;
                };
                missing.push((
                    ElevatorNodes::new(elevator.stops.clone()),
                    lo_level,
                    hi_level,
                ));
            }
        }

        if missing.is_empty() {
            return;
        }
        missing.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = ExcessiveElevatorStopGapIssue::new_from_check(&self.instance_id, missing)
            .with_detail(
                &self.instance_id,
                "max_elevator_stop_gap",
                self.max_stop_gap.to_string(),
            );
        issues.push(issue);
    }
}

fn levels_by_index<T: Tessellation>(
    maze: &Maze<T>,
    point: T::CellId,
) -> Option<std::collections::HashMap<usize, crate::space::LevelId>> {
    Some(
        maze.field
            .levels_ordered()
            .filter_map(|level| {
                let node = maze.field.node_at(level, point)?;
                let idx = maze.field.level_index_of(node)?;
                Some((idx, level))
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "max_elevator_stop_gap";

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
        let (maze, _nodes) = maze_with_elevator(6, &[]);
        let check = MaxElevatorStopGapCheck {
            instance_id: TEST_ID.to_string(),
            max_stop_gap: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_when_every_gap_within_maximum() {
        let (maze, _nodes) = maze_with_elevator(6, &[0, 2, 4]);
        let check = MaxElevatorStopGapCheck {
            instance_id: TEST_ID.to_string(),
            max_stop_gap: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn fires_on_an_over_large_gap_reporting_its_bottom_and_top_floor() {
        let (maze, _nodes) = maze_with_elevator(6, &[0, 5]);
        let check = MaxElevatorStopGapCheck {
            instance_id: TEST_ID.to_string(),
            max_stop_gap: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].missing.len(), 1);
        let (_, lo, hi) = &issues[0].missing[0];
        let lo_idx = maze
            .field
            .node_at(*lo, SquarePoint { x: 0, y: 0 })
            .and_then(|n| maze.field.level_index_of(n));
        let hi_idx = maze
            .field
            .node_at(*hi, SquarePoint { x: 0, y: 0 })
            .and_then(|n| maze.field.level_index_of(n));
        assert_eq!(lo_idx, Some(0));
        assert_eq!(hi_idx, Some(5));
    }

    #[test]
    fn multiple_over_large_gaps_on_one_elevator_each_produce_their_own_entry() {
        let (maze, _nodes) = maze_with_elevator(10, &[0, 4, 9]);
        let check = MaxElevatorStopGapCheck {
            instance_id: TEST_ID.to_string(),
            max_stop_gap: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].missing.len(),
            2,
            "both (0,4) and (4,9) exceed the max gap of 2"
        );
    }
}
