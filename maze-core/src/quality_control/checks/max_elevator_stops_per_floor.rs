use super::elevator_core::elevator_stops_per_floor;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use crate::quality_control::check::Check;
use crate::space::{LevelId, Tessellation};
use rand::RngCore;

pub const MAX_ELEVATOR_STOPS_PER_FLOOR_DEFAULT: u32 = 3;

/// Flags elevator stops jointly invalid when their count exceeds
/// `max_elevator_stops_per_floor` (per floor by default, see `count_unit` below) — see GitHub
/// issue #399, part of epic #344. In the `PerFloor` unit, any elevator stop on
/// the floor counts, from any elevator (an elevator contributes one stop per floor it touches, by
/// construction — `elevator_core`'s `stops` never puts two of the same elevator's stops on one
/// floor). Groups every over-budget floor's stops into its own group, paired with
/// `to_remove = count - max_elevator_stops_per_floor`, sorted by `LevelId` for
/// determinism. Which stops on an over-budget floor are actually removed is
/// `ElevatorStopGroupSelectStrategy`'s job, not this check's.
///
/// `count_unit` picks what the limit counts (GitHub issue #1080): every floor separately
/// (`PerFloor`, the default) or all stops of the visible scope together (`WholeScope`). The scope
/// is the whole maze, or the rule's zone when the graph mask is raised (`elevator_groups` reads the
/// masked graph), so with an Iteration group each zone is counted on its own. `WholeScope` emits a
/// single group with every stop of the scope and `to_remove = total - max`.
pub struct MaxElevatorStopsPerFloorCheck {
    pub instance_id: String,
    pub max_elevator_stops_per_floor: u32,
    pub count_unit: ElevatorStopsCountUnit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ElevatorStopsCountUnit {
    #[default]
    PerFloor,
    WholeScope,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for MaxElevatorStopsPerFloorCheck {
    fn check_type_id(&self) -> &'static str {
        "max_elevator_stops_per_floor"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorStopGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let per_floor = elevator_stops_per_floor(maze);

        if self.count_unit == ElevatorStopsCountUnit::WholeScope {
            let mut stops: Vec<NodeId> = per_floor.into_values().flatten().collect();
            let total = stops.len() as u32;
            if total <= self.max_elevator_stops_per_floor {
                return;
            }
            stops.sort_unstable();
            let excess = total - self.max_elevator_stops_per_floor;
            let issue = InvalidElevatorStopGroupIssue::new_from_check(
                &self.instance_id,
                vec![(stops, excess)],
            )
            .with_detail(
                &self.instance_id,
                "max_elevator_stops_per_floor",
                self.max_elevator_stops_per_floor.to_string(),
            );
            issues.push(issue);
            return;
        }

        let mut over_budget: Vec<LevelId> = per_floor
            .iter()
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
            .with_detail(
                &self.instance_id,
                "max_elevator_stops_per_floor",
                self.max_elevator_stops_per_floor.to_string(),
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

    const TEST_ID: &str = "max_elevator_stops_per_floor";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// `elevator_count` separate elevators, each spanning the same 2 floors, at distinct x
    /// positions -- puts `elevator_count` stops on each floor.
    fn maze_with_elevators_sharing_floors(elevator_count: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(
                Arc::default(),
                square_rect(elevator_count.max(1), 1),
                &mut ids,
            )
            .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(
                Arc::default(),
                square_rect(elevator_count.max(1), 1),
                &mut ids,
            )
            .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
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
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 1,
            count_unit: ElevatorStopsCountUnit::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            2,
            "both floors (bottom and top) are over budget"
        );
        for (stops, to_remove) in &issues[0].groups {
            assert_eq!(
                stops.len(),
                3,
                "every stop on the floor must be offered to the repair strategy"
            );
            assert_eq!(
                *to_remove, 2,
                "to_remove must equal the excess stop count over the max"
            );
        }
    }

    #[test]
    fn silent_when_stops_per_floor_at_or_below_max() {
        let maze = maze_with_elevators_sharing_floors(2);
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 2,
            count_unit: ElevatorStopsCountUnit::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "count equal to the max must not fire");
    }

    #[test]
    fn whole_scope_counts_all_stops_in_one_group() {
        // 3 elevators over 2 floors = 6 stops in total, 3 per floor.
        let maze = maze_with_elevators_sharing_floors(3);
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 4,
            count_unit: ElevatorStopsCountUnit::WholeScope,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 1);
        let (stops, to_remove) = &issues[0].groups[0];
        assert_eq!(stops.len(), 6);
        assert_eq!(*to_remove, 2);
    }

    #[test]
    fn whole_scope_silent_at_or_below_max_while_per_floor_would_fire() {
        let maze = maze_with_elevators_sharing_floors(3);
        let whole = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 6,
            count_unit: ElevatorStopsCountUnit::WholeScope,
        };
        let mut issues = Vec::new();
        whole.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "total equal to the max must not fire");

        let per_floor = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 2,
            count_unit: ElevatorStopsCountUnit::PerFloor,
        };
        per_floor.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "per-floor unit still counts each floor");
    }

    #[test]
    fn whole_scope_counts_only_the_raised_scope() {
        // 3 elevators (6 stops); the scope keeps the first two columns, so 4 stops.
        let maze = maze_with_elevators_sharing_floors(3);
        let inner: std::collections::HashSet<NodeId> = maze
            .field
            .all_node_ids()
            .filter(|&n| maze.field.cell_of(n).is_some_and(|p| p.x < 2))
            .collect();
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 3,
            count_unit: ElevatorStopsCountUnit::WholeScope,
        };
        let mut issues = Vec::new();
        maze.with_scope(inner, |m| {
            check.repair_check(m, &mut issues, &mut rng(), ());
        });
        assert_eq!(issues.len(), 1);
        let (stops, to_remove) = &issues[0].groups[0];
        assert_eq!(
            stops.len(),
            4,
            "stops outside the scope must not be counted"
        );
        assert_eq!(*to_remove, 1);
    }

    #[test]
    fn silent_when_no_elevators() {
        let maze = maze_with_elevators_sharing_floors(0);
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 0,
            count_unit: ElevatorStopsCountUnit::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn groups_are_ordered_deterministically_by_level() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
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
        let check = MaxElevatorStopsPerFloorCheck {
            instance_id: TEST_ID.to_string(),
            max_elevator_stops_per_floor: 1,
            count_unit: ElevatorStopsCountUnit::PerFloor,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            3,
            "all 3 floors are over the max of 1"
        );
        let group_levels: Vec<LevelId> = issues[0]
            .groups
            .iter()
            .map(|(stops, _)| maze.field.level_of(stops[0]).unwrap())
            .collect();
        let mut sorted_levels = group_levels.clone();
        sorted_levels.sort();
        assert_eq!(
            group_levels, sorted_levels,
            "groups must be emitted in ascending LevelId order, not HashMap iteration order"
        );
    }
}
