use super::elevator_core::elevator_groups;
use super::proximity_scan_core::pairwise_geometric_scan;
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::check::Check;
use crate::quality_control::{GeometricFloorMode, InvalidElevatorStopGroupIssue};
use crate::space::{Tessellation, floor_aware_distance};
use rand::RngCore;

pub const ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DISTANCE_DEFAULT: f64 = 0.0;
pub const ELEVATOR_STOP_GROUP_GEOMETRIC_PROXIMITY_DEFAULT_FLOOR_MODE: GeometricFloorMode =
    GeometricFloorMode::SameFloorOnly;

/// Flags a pair of `EdgeKind::Elevator` stops placed too close to each other in geometric
/// (Euclidean) space — see GitHub issue #409, part of epic #344. Distance is measured between
/// each candidate stop's own point, folded across floors per `floor_mode` (see
/// `GeometricFloorMode`), mirroring `VerticalPassageGroupGeometricProximityCheck`'s "either stop
/// removes the pair" group shape: `InvalidElevatorStopGroupIssue` with `to_remove: 1` per
/// problematic pair.
///
/// Every stop of every elevator in the maze is a candidate, but a pair of stops belonging to the
/// *same* elevator is never compared — those stops are already connected by an `Elevator` edge, so
/// their geometric closeness is by design, not a proximity problem (`ElevatorStopsSkipCheck`
/// already covers a same-elevator pair sitting too close together on the floor axis). Only pairs
/// spanning two distinct elevators are scanned.
pub struct ElevatorStopGroupGeometricProximityCheck {
    pub instance_id: String,
    pub distance: f64,
    pub floor_mode: GeometricFloorMode,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue>
    for ElevatorStopGroupGeometricProximityCheck
{
    fn check_type_id(&self) -> &'static str {
        "elevator_stop_group_geometric_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorStopGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let candidates: Vec<(NodeId, usize, usize, T::Point)> = elevator_groups(maze)
            .into_iter()
            .enumerate()
            .flat_map(|(elevator_index, elevator)| {
                elevator
                    .stops
                    .into_iter()
                    .map(move |node| (elevator_index, node))
            })
            .filter_map(|(elevator_index, node)| {
                let level = maze.field.level_index_of(node)?;
                let point = maze.field.point_of(node)?;
                Some((node, elevator_index, level, point))
            })
            .collect();
        if candidates.len() < 2 {
            return;
        }

        let mut groups = pairwise_geometric_scan(
            &candidates,
            self.distance,
            |&(_, own_elevator, own_level, _), &(_, other_elevator, other_level, _)| {
                own_elevator == other_elevator
                    || (self.floor_mode == GeometricFloorMode::SameFloorOnly
                        && own_level != other_level)
            },
            |&(_, _, own_level, own_point), &(_, _, other_level, other_point)| {
                floor_aware_distance(
                    maze.field.tessellation(),
                    own_level,
                    own_point,
                    other_level,
                    other_point,
                    self.floor_mode.include_height(),
                )
            },
            |&(own_node, ..), &(other_node, ..)| {
                let mut group = vec![own_node, other_node];
                group.sort_unstable();
                (group, 1)
            },
        );

        if groups.is_empty() {
            return;
        }
        groups.sort_by(|a, b| a.0.cmp(&b.0));
        groups.dedup();
        let issue = InvalidElevatorStopGroupIssue::new_from_check(&self.instance_id, groups)
            .with_detail(&self.instance_id, "distance", self.distance.to_string());
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

    const TEST_ID: &str = "elevator_stop_group_geometric_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn two_elevators_at(xs: &[i32]) -> (Maze<SquareTessellation>, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let width = xs.iter().copied().max().unwrap_or(0) as usize + 1;
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(width, 1), &mut ids)
                .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(width, 1), &mut ids)
                .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let mut ids_out = Vec::new();
        for &x in xs {
            let b = mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
            let t = mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
            g.add_edge(b, t, EdgeKind::Elevator);
            g.add_edge(t, b, EdgeKind::Elevator);
            ids_out.push(b);
            ids_out.push(t);
        }
        (Maze::new(mf, g), ids_out)
    }

    fn check(
        distance: f64,
        floor_mode: GeometricFloorMode,
    ) -> ElevatorStopGroupGeometricProximityCheck {
        ElevatorStopGroupGeometricProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance,
            floor_mode,
        }
    }

    #[test]
    fn fires_when_two_elevators_closer_than_threshold() {
        let (maze, _nodes) = two_elevators_at(&[0, 1]);
        let mut issues = Vec::new();
        check(5.0, GeometricFloorMode::AsCoordinate).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(issues.len(), 1);
        for (group, to_remove) in &issues[0].groups {
            assert_eq!(group.len(), 2);
            assert_eq!(*to_remove, 1);
        }
    }

    #[test]
    fn silent_when_farther_than_threshold() {
        let (maze, _nodes) = two_elevators_at(&[0, 10]);
        let mut issues = Vec::new();
        check(5.0, GeometricFloorMode::AsCoordinate).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_stops() {
        let (maze, _nodes) = two_elevators_at(&[0]);
        let mut issues = Vec::new();
        check(1000.0, GeometricFloorMode::AsCoordinate).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(issues.is_empty());
    }

    #[test]
    fn same_floor_only_ignores_a_pair_on_different_floors() {
        // Elevator A spans floors 0-1 at x=0, elevator B spans floors 2-3 at x=1 -- no shared
        // floor between the two elevators' own stops, so SameFloorOnly must find nothing.
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
        let a0 = mf.node_at(floors[0], SquarePoint { x: 0, y: 0 }).unwrap();
        let a1 = mf.node_at(floors[1], SquarePoint { x: 0, y: 0 }).unwrap();
        let b0 = mf.node_at(floors[2], SquarePoint { x: 1, y: 0 }).unwrap();
        let b1 = mf.node_at(floors[3], SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5.0, GeometricFloorMode::SameFloorOnly).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(
            issues.is_empty(),
            "elevator A's stops (floors 0,1) and elevator B's stops (floors 2,3) never share a floor -- SameFloorOnly must never pair them"
        );
    }

    #[test]
    fn as_coordinate_and_ignore_disagree_when_the_floor_gap_alone_exceeds_the_threshold() {
        // Elevator A's stops sit far apart in x (0 and 20) so neither is ever the closest cross-
        // elevator candidate. Elevator B has a single close-in-x stop (x=1, floor 3) plus a second
        // stop far away in x (x=40, distinct from A's far stop) to keep the elevator's own two
        // floors distinct without introducing a second close pair. The one relevant comparison is
        // A's floor-0 stop (x=0) against B's floor-3 stop (x=1): dx=1, dz=3.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..4)
            .map(|_| {
                mf.add_level(
                    Field::<SquareTessellation>::new(Arc::default(), square_rect(41, 1), &mut ids)
                        .unwrap(),
                )
            })
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let a0 = mf.node_at(floors[0], SquarePoint { x: 0, y: 0 }).unwrap();
        let a1 = mf.node_at(floors[1], SquarePoint { x: 20, y: 0 }).unwrap();
        let b0 = mf.node_at(floors[3], SquarePoint { x: 1, y: 0 }).unwrap();
        let b1 = mf.node_at(floors[2], SquarePoint { x: 40, y: 0 }).unwrap();
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);

        let mut ignore_issues = Vec::new();
        check(2.0, GeometricFloorMode::Ignore).repair_check(
            &maze,
            &mut ignore_issues,
            &mut rng(),
            (),
        );
        assert!(
            !ignore_issues.is_empty(),
            "Ignore drops the floor gap entirely, sees only dx = 1.0 < 2.0"
        );

        let mut coordinate_issues = Vec::new();
        check(2.0, GeometricFloorMode::AsCoordinate).repair_check(
            &maze,
            &mut coordinate_issues,
            &mut rng(),
            (),
        );
        assert!(
            coordinate_issues.is_empty(),
            "AsCoordinate folds the floor gap in, sqrt(1^2 + 3^2) = 3.16 > 2.0"
        );
    }
}
