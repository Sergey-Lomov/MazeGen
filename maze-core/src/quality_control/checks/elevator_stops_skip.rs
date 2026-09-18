use super::elevator_core::elevator_groups;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;

pub const ELEVATOR_STOPS_SKIP_DEFAULT: u32 = 1;

/// Flags a pair of *consecutive* stops of the same elevator invalid when the floor-index gap
/// between them is strictly below `elevator_stops_skip` — see GitHub issue #400, part of epic
/// #344. "Consecutive" means adjacent after sorting the elevator's own stops by floor index (via
/// `elevator_core::stop_floors`'s ordering) — only neighboring pairs are ever checked, not every
/// pair (that is `ElevatorStopsSpanCheck`'s job). Reuses `InvalidElevatorStopGroupIssue`
/// (`ElevatorStopGroupKind`, `Element = NodeId`) with a two-stop group per flagged pair and
/// `to_remove: 1`, mirroring `VerticalPassageGroupGeometricProximityCheck`'s pair-group shape —
/// removing either stop of the pair resolves it, which stop is `ElevatorStopGroupSelectStrategy`'s
/// job, not this check's.
pub struct ElevatorStopsSkipCheck {
    pub instance_id: String,
    pub elevator_stops_skip: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for ElevatorStopsSkipCheck {
    fn check_type_id(&self) -> &'static str {
        "elevator_stops_skip"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorStopGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let mut groups: Vec<(Vec<NodeId>, u32)> = Vec::new();

        for elevator in elevator_groups(maze) {
            let mut stops: Vec<(usize, NodeId)> = elevator
                .stops
                .iter()
                .filter_map(|&n| maze.field.level_index_of(n).map(|level| (level, n)))
                .collect();
            stops.sort_unstable();

            for pair in stops.windows(2) {
                let (level_a, node_a) = pair[0];
                let (level_b, node_b) = pair[1];
                let gap = (level_b - level_a) as u32;
                if gap < self.elevator_stops_skip {
                    let mut group = vec![node_a, node_b];
                    group.sort_unstable();
                    groups.push((group, 1));
                }
            }
        }

        if groups.is_empty() {
            return;
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        let issue = InvalidElevatorStopGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(
                &self.instance_id,
                "elevator_stops_skip",
                self.elevator_stops_skip.to_string(),
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

    const TEST_ID: &str = "elevator_stops_skip";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn maze_with_elevator_at_floors(
        floor_count: usize,
        stop_floor_indices: &[usize],
    ) -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..floor_count)
            .map(|_| {
                mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap())
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let nodes: Vec<NodeId> = stop_floor_indices
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
    fn fires_on_a_consecutive_pair_below_the_minimum_skip() {
        let (maze, nodes) = maze_with_elevator_at_floors(3, &[0, 1, 2]);
        let check = ElevatorStopsSkipCheck {
            instance_id: TEST_ID.to_string(),
            elevator_stops_skip: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        // Every adjacent pair has gap 1 < 2, so floors (0,1) and (1,2) both flag.
        assert_eq!(
            issues[0].groups.len(),
            2,
            "both consecutive pairs are below the minimum skip"
        );
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2);
            assert_eq!(*to_remove, 1);
        }
        let _ = nodes;
    }

    #[test]
    fn silent_when_gap_at_or_above_minimum() {
        let (maze, _nodes) = maze_with_elevator_at_floors(4, &[0, 2]);
        let check = ElevatorStopsSkipCheck {
            instance_id: TEST_ID.to_string(),
            elevator_stops_skip: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "gap equal to the minimum must not fire");
    }

    #[test]
    fn non_consecutive_pair_is_never_checked() {
        // Stops at floors 0, 1, 5 -- (0,1) gap=1 fires, but (1,5) and (0,5) are never compared
        // directly since only adjacent-after-sort pairs are checked.
        let (maze, _nodes) = maze_with_elevator_at_floors(6, &[0, 1, 5]);
        let check = ElevatorStopsSkipCheck {
            instance_id: TEST_ID.to_string(),
            elevator_stops_skip: 2,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups.len(),
            1,
            "only the (0,1) adjacent pair is below the minimum; (1,5) has gap 4"
        );
    }

    #[test]
    fn silent_when_no_elevators() {
        let (maze, _nodes) = maze_with_elevator_at_floors(2, &[]);
        let check = ElevatorStopsSkipCheck {
            instance_id: TEST_ID.to_string(),
            elevator_stops_skip: 1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn two_stops_on_the_same_floor_flag_as_a_zero_gap_pair() {
        // Unlike `stop_floors` (which dedups by floor for stop-count purposes), this check
        // compares raw stop nodes -- two stops of the same elevator sharing a floor (currently
        // never generated, but not assumed impossible -- see `elevator_core::stop_floors`'s doc
        // comment) sort adjacent with gap 0, which is always below any elevator_stops_skip >= 1.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floor =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let a = mf.node_at(floor, SquarePoint { x: 0, y: 0 }).unwrap();
        let b = mf.node_at(floor, SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a, b, EdgeKind::Elevator);
        g.add_edge(b, a, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);

        let check = ElevatorStopsSkipCheck {
            instance_id: TEST_ID.to_string(),
            elevator_stops_skip: 1,
        };
        let mut issues = Vec::new();
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "a same-floor stop pair has gap 0, below any elevator_stops_skip >= 1"
        );
        assert_eq!(issues[0].groups.len(), 1);
    }
}
