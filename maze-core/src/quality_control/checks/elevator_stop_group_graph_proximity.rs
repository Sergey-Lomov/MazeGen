use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::ids::NodeId;
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use super::elevator_core::elevator_groups;
use super::proximity_scan_core::pairwise_graph_proximity_scan;

pub const ELEVATOR_STOP_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: u32 = 0;

/// Flags a pair of `EdgeKind::Elevator` stops too close to each other topologically (tile-hops via
/// the shared nav-graph distance map) — see GitHub issue #409, part of epic #344. Mirrors
/// `VerticalPassageGroupGraphProximityCheck`'s pairwise-scan shape, one candidate per elevator
/// stop across every elevator in the maze, but never a pair of stops belonging to the *same*
/// elevator — those stops are already connected by an `Elevator` edge, so their topological
/// closeness is by design, not a proximity problem, same rationale
/// `ElevatorStopGroupGeometricProximityCheck` uses for its own same-elevator exclusion.
///
/// Distance excludes hops through any `Elevator` edge (own or otherwise) from the traversal, same
/// "measures pedestrian proximity, not by-elevator reachability" rationale
/// `VerticalPassageGroupGraphProximityCheck` uses for its own vertical-passage hops. Elevators have
/// no type/direction concept (unlike vertical passages' `TwoWay`/`OneWayUp`/`OneWayDown`), so there
/// is no `same_type_only`-equivalent parameter here.
pub struct ElevatorStopGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue> for ElevatorStopGroupGraphProximityCheck {
    fn check_type_id(&self) -> &'static str { "elevator_stop_group_graph_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidElevatorStopGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let elevator_pairs: HashSet<(NodeId, NodeId)> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::Elevator)
            .map(|e| (e.from, e.to))
            .collect();

        let candidates: Vec<(NodeId, usize, crate::graph::nav::NavNodeId)> = elevator_groups(maze)
            .into_iter()
            .enumerate()
            .flat_map(|(elevator_index, elevator)| {
                elevator.stops.into_iter().map(move |node| (elevator_index, node))
            })
            .filter_map(|(elevator_index, node)| {
                let nav_node = nav.nav_node_for(node)?;
                Some((node, elevator_index, nav_node))
            })
            .collect();
        if candidates.len() < 2 {
            return;
        }

        let mut groups = pairwise_graph_proximity_scan(
            &nav,
            &candidates,
            self.distance,
            &elevator_pairs,
            |&(_, _, nav_node)| nav_node,
            |&(_, own_elevator, _), &(_, other_elevator, _)| own_elevator == other_elevator,
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
    use rand::SeedableRng;
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::graph::distance_map::{compute_distance_map_filtered_bounded, DistanceDirection};
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "elevator_stop_group_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two floors, `len`-tile corridor on the bottom floor connecting two elevator stops (x=0 and
    /// x=len-1), each going up to the top floor.
    fn maze_with_two_elevators(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(len, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(len, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(b(i as i32), b(i as i32 + 1), EdgeKind::Basic);
        }
        g.add_edge(b(0), t(0), EdgeKind::Elevator);
        g.add_edge(t(0), b(0), EdgeKind::Elevator);
        g.add_edge(b(len as i32 - 1), t(len as i32 - 1), EdgeKind::Elevator);
        g.add_edge(t(len as i32 - 1), b(len as i32 - 1), EdgeKind::Elevator);
        Maze::new(mf, g)
    }

    fn check(distance: u32) -> ElevatorStopGroupGraphProximityCheck {
        ElevatorStopGroupGraphProximityCheck { instance_id: TEST_ID.to_string(), distance }
    }

    #[test]
    fn fires_when_stops_closer_than_threshold() {
        let maze = maze_with_two_elevators(3); // stops 2 tile-hops apart
        let mut issues = Vec::new();
        check(5).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
    }

    #[test]
    fn silent_when_stops_farther_than_threshold() {
        let maze = maze_with_two_elevators(10); // stops 9 tile-hops apart
        let mut issues = Vec::new();
        check(5).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn silent_with_fewer_than_two_stops() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::Elevator);
        g.add_edge(t0, b0, EdgeKind::Elevator);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(1000).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn same_elevator_pairs_are_never_compared() {
        // A single 3-stop elevator fan connecting three floors directly -- own-elevator pairs are
        // excluded outright (their closeness is by design, an Elevator edge already connects
        // them), regardless of what the nav-graph distance would otherwise say.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let floors: Vec<_> = (0..3)
            .map(|_| mf.add_level(Field::<SquareTessellation>::new(square_rect(1, 1), &mut ids).unwrap()))
            .collect();
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let nodes: Vec<_> = floors.iter().map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap()).collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "all three stops belong to the same elevator -- same-elevator pairs are never compared");
    }

    #[test]
    fn own_elevator_hops_are_excluded_from_cross_elevator_distance() {
        // Elevator A (a0 bottom / a1 top) and elevator B (b0 bottom / b1 top) sit 6 Basic hops
        // apart on both floors, with a1 and b1 additionally joined by a single direct Basic edge
        // (representing a corridor between the two elevator landings on the top floor). At
        // threshold 5: a1-b1 (1 Basic hop) is the only pair close enough to flag when elevator
        // hops are excluded from the traversal. Without exclusion, a0 and b0 also gain a
        // 3-hop route each to the opposite landing (a0-a1-b1 and a1-b1-b0) via their own elevator
        // edge, pulling more pairs under the threshold -- proving the exclusion filter, not some
        // unrelated bug, is what keeps those extra pairs from flagging in the filtered check.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(7, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(7, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let bot = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let top_n = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        let a0 = bot(0);
        let b0 = bot(6);
        let a1 = top_n(0);
        let b1 = top_n(1);
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        g.add_bidirectional_edge(a1, b1, EdgeKind::Basic);
        let maze = Maze::new(mf, g);

        let mut filtered_issues = Vec::new();
        check(5).repair_check(&maze, &mut filtered_issues, &mut rng(), ());
        let filtered_pairs: usize = filtered_issues.iter().map(|i| i.groups.len()).sum();
        assert_eq!(filtered_pairs, 1, "with elevator hops excluded, only the direct a1-b1 Basic hop is close enough to flag");

        // Control: run the same pairwise scan but with elevator hops left in the traversal
        // (mirrors repair_check's own loop, minus the hop filter) -- more pairs must flag once
        // a0/b0 also gain a short route via their own elevator edge, proving the filter in
        // repair_check is doing real work rather than the empty-vs-nonempty result being
        // coincidental.
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let candidates = [a0, a1, b0, b1];
        let mut unfiltered_pairs = 0;
        for &own in &candidates {
            let own_nav = nav.nav_node_for(own).unwrap();
            let dist_map = compute_distance_map_filtered_bounded(&nav, own_nav, DistanceDirection::Forward, |_| true, 5);
            for &other in &candidates {
                if other == own { continue; }
                let other_nav = nav.nav_node_for(other).unwrap();
                if dist_map.get(&other_nav).is_some_and(|&d| (d as u32) < 5) {
                    unfiltered_pairs += 1;
                }
            }
        }
        assert!(unfiltered_pairs > 2, "without hop exclusion, a0/b0 must also come within distance 5 of the opposite landing, flagging more directed pairs than the a1<->b1 pair alone (2, one per direction)");
    }
}
