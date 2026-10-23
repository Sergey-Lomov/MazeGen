use super::elevator_core::elevator_groups;
use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::InvalidElevatorStopGroupIssue;
use crate::quality_control::check::Check;
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

pub const ELEVATOR_STOP_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: u32 = 0;

/// Flags a pair of `EdgeKind::Elevator` stops too close to each other topologically (tile-hops via
/// the shared nav-graph distance map) — see GitHub issue #409, part of epic #344. Mirrors
/// `VerticalPassageGroupGraphProximityCheck`'s pairwise-scan shape, one candidate per elevator
/// stop across every elevator in the maze, but never a pair of stops belonging to the *same*
/// elevator — those stops are already connected by an `Elevator` edge, so their topological
/// closeness is by design, not a proximity problem, same rationale
/// `ElevatorStopGroupGeometricProximityCheck` uses for its own same-elevator exclusion.
///
/// Distance excludes hops through `own`'s *own* elevator group only (GitHub issue #512) — every
/// other elevator's stops are traversed like ordinary nav hops, so a genuinely close pair on the
/// far side of an unrelated elevator ride is still reported as close, rather than the whole
/// elevator kind being a traversal blind spot. Elevators have no type/direction concept (unlike
/// vertical passages' `TwoWay`/`OneWayUp`/`OneWayDown`), so there is no `same_type_only`-equivalent
/// parameter here.
pub struct ElevatorStopGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: u32,
}

impl<T: Tessellation> Check<T, InvalidElevatorStopGroupIssue>
    for ElevatorStopGroupGraphProximityCheck
{
    fn check_type_id(&self) -> &'static str {
        "elevator_stop_group_graph_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidElevatorStopGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        // Per-elevator hop-exclusion set (GitHub issue #512): only the scanned stop's *own*
        // elevator's hops are excluded from its traversal, built from that elevator's own
        // `Elevator`-kind edges rather than every `Elevator` edge in the maze.
        let elevators = elevator_groups(maze);
        let elevator_hop_pairs: Vec<HashSet<(NodeId, NodeId)>> = elevators
            .iter()
            .map(|elevator| {
                elevator
                    .edges
                    .iter()
                    .filter_map(|&eid| maze.graph.edge(eid))
                    .flat_map(|e| [(e.from, e.to), (e.to, e.from)])
                    .collect()
            })
            .collect();

        let candidates: Vec<(NodeId, usize)> = elevators
            .into_iter()
            .enumerate()
            .flat_map(|(elevator_index, elevator)| {
                elevator
                    .stops
                    .into_iter()
                    .map(move |node| (node, elevator_index))
            })
            .collect();
        if candidates.len() < 2 {
            return;
        }

        let mut groups = pairwise_graph_proximity_scan(
            &nav,
            &candidates,
            self.distance as usize,
            false,
            |&(_, own_elevator)| elevator_hop_pairs[own_elevator].clone(),
            |_, _| true,
            |&(node, _)| ScanAnchor::Single(node),
            |&(node, _)| ScanAnchor::Single(node),
            |dist| (dist as u32) < self.distance,
            |&(_, own_elevator), &(_, other_elevator)| own_elevator == other_elevator,
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

    const TEST_ID: &str = "elevator_stop_group_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two floors, `len`-tile corridor on the bottom floor connecting two elevator stops (x=0 and
    /// x=len-1), each going up to the top floor.
    fn maze_with_two_elevators(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(len, 1), &mut ids)
                .unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(len, 1), &mut ids)
                .unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
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
        ElevatorStopGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance,
        }
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
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
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
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let floors: Vec<_> = (0..3)
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
        let nodes: Vec<_> = floors
            .iter()
            .map(|&l| mf.node_at(l, SquarePoint { x: 0, y: 0 }).unwrap())
            .collect();
        for i in 0..nodes.len() {
            for j in (i + 1)..nodes.len() {
                g.add_edge(nodes[i], nodes[j], EdgeKind::Elevator);
                g.add_edge(nodes[j], nodes[i], EdgeKind::Elevator);
            }
        }
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "all three stops belong to the same elevator -- same-elevator pairs are never compared"
        );
    }

    #[test]
    fn only_own_elevator_hops_are_excluded_a_foreign_elevator_hop_is_traversed() {
        // Elevator A (a0 bottom / a1 top) and elevator B (b0 bottom / b1 top), with a1 and b1 one
        // Basic hop apart on the top floor. GitHub issue #512: only the scanned stop's *own*
        // elevator hop is excluded from its traversal, not every elevator's -- but that still
        // means a0's only edge (its own a0<->a1 hop) is excluded, stranding it, and b0's only edge
        // (its own b0<->b1 hop) strands it the same way. So the only pair either endpoint can
        // actually reach is the direct a1<->b1 Basic hop.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::new(Arc::default(), std::iter::empty());
        let bottom = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let top = mf.add_level(
            Field::<SquareTessellation>::new(Arc::default(), square_rect(2, 1), &mut ids).unwrap(),
        );
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let bot = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let top_n = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        let a0 = bot(0);
        let b0 = bot(1);
        let a1 = top_n(0);
        let b1 = top_n(1);
        g.add_edge(a0, a1, EdgeKind::Elevator);
        g.add_edge(a1, a0, EdgeKind::Elevator);
        g.add_edge(b0, b1, EdgeKind::Elevator);
        g.add_edge(b1, b0, EdgeKind::Elevator);
        g.add_bidirectional_edge(a1, b1, EdgeKind::Basic);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5).repair_check(&maze, &mut issues, &mut rng(), ());
        let pairs: usize = issues.iter().map(|i| i.groups.len()).sum();
        assert_eq!(
            pairs, 1,
            "only a1<->b1 (direct Basic hop) flags -- a0 is stranded by its own excluded hop, \
             b0's own excluded hop (b0<->b1) also blocks it from reaching a1 through b1"
        );
    }
}
