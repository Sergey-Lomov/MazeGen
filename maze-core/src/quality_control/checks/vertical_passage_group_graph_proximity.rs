use std::collections::HashSet;
use rand::RngCore;
use crate::Maze;
use crate::graph::EdgeKind;
use crate::graph::distance_map::{compute_distance_map_filtered_bounded, DistanceDirection};
use crate::graph::nav::NavEdge;
use crate::ids::{EdgeId, NodeId};
use crate::space::Tessellation;
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidVerticalPassageGroupIssue, VerticalPassageType};
use super::vertical_passage_count_core::vertical_passage_proximity_candidates;

pub const VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: u32 = 0;
pub const VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_TYPE: VerticalPassageType = VerticalPassageType::Any;

/// Flags a pair of `EdgeKind::VerticalPassage` entries too close to each other topologically
/// (tile-hops via the shared nav-graph distance map) — see GitHub issue #343. Mirrors
/// `TeleportGroupProximityCheck`'s pairwise-scan shape, one candidate per scan-worthy entry (see
/// `vertical_passage_proximity_candidates`) — a two-way passage's two ends both participate; a
/// one-way passage contributes only its `from` end. Unlike the geometric proximity check, there is
/// no `count_incoming` here: a one-way passage's `to` end is not a meaningfully different
/// topological position from its `from` end — whether or not it's itself a scan candidate, any
/// shortest path to a nearby passage still runs through it, so hiding it as a candidate would not
/// hide the proximity it represents.
///
/// Distance excludes hops through any `VerticalPassage` edge (own or otherwise) from the
/// traversal, same "measures pedestrian proximity, not by-passage reachability" rationale
/// `TeleportGroupProximityCheck` uses for teleport hops. Unlike `Teleport`, `NavEdge` carries no
/// dedicated `is_vertical_passage` flag (GitHub issue #197 only disambiguated `Teleport`), so the
/// exclusion set is built explicitly from every `VerticalPassage` edge's own `(from, to)` pair and
/// matched against each single-hop `NavEdge`'s `path`.
///
/// `passage_type`/`same_type_only` mirror `VerticalPassageGroupGeometricProximityCheck`'s own
/// parameters exactly.
pub struct VerticalPassageGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: u32,
    pub passage_type: VerticalPassageType,
    pub same_type_only: bool,
}

fn is_not_a_vertical_passage_hop(edge: &NavEdge, vertical_passage_pairs: &HashSet<(NodeId, NodeId)>) -> bool {
    !(edge.path.len() == 2 && vertical_passage_pairs.contains(&(edge.path[0], edge.path[1])))
}

impl<T: Tessellation> Check<T, InvalidVerticalPassageGroupIssue> for VerticalPassageGroupGraphProximityCheck {
    fn check_type_id(&self) -> &'static str { "vertical_passage_group_graph_proximity" }

    fn repair_check(&self, maze: &Maze<T>, issues: &mut Vec<InvalidVerticalPassageGroupIssue>, _rng: &mut dyn RngCore, _requirement: ()) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);
        let vertical_passage_pairs: HashSet<(NodeId, NodeId)> = maze.graph.edges()
            .filter(|e| e.kind == EdgeKind::VerticalPassage)
            .map(|e| (e.from, e.to))
            .collect();

        let candidates: Vec<(EdgeId, crate::graph::nav::NavNodeId, VerticalPassageType)> = vertical_passage_proximity_candidates(maze, self.passage_type, false)
            .into_iter()
            .filter_map(|c| {
                let nav_node = nav.nav_node_for(c.node)?;
                Some((c.canonical_edge, nav_node, c.passage_type))
            })
            .collect();
        if candidates.len() < 2 {
            return;
        }

        let max_dist = self.distance as usize;
        let mut groups: Vec<(Vec<EdgeId>, u32)> = Vec::new();

        for &(own_id, own_nav_node, own_type) in &candidates {
            let dist_map = compute_distance_map_filtered_bounded(
                &nav, own_nav_node, DistanceDirection::Forward,
                |e| is_not_a_vertical_passage_hop(e, &vertical_passage_pairs), max_dist,
            );
            for &(other_id, other_nav_node, other_type) in &candidates {
                if other_id == own_id {
                    continue;
                }
                if self.same_type_only && own_type != other_type {
                    continue;
                }
                if dist_map.get(&other_nav_node).is_some_and(|&d| (d as u32) < self.distance) {
                    groups.push((vec![own_id, other_id], 1));
                    break;
                }
            }
        }

        if groups.is_empty() {
            return;
        }
        let issue = InvalidVerticalPassageGroupIssue::new_from_check(&self.instance_id, groups)
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
    use crate::space::{Field, MultiLevelField, SquareTessellation, SquarePoint, square_rect};

    const TEST_ID: &str = "vertical_passage_group_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two floors, `len`-tile corridor on the bottom floor connecting two vertical passage
    /// entries (x=0 and x=len-1), each going up to the top floor.
    fn maze_with_two_entries(len: usize) -> Maze<SquareTessellation> {
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
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage);
        g.add_edge(b(len as i32 - 1), t(len as i32 - 1), EdgeKind::VerticalPassage);
        Maze::new(mf, g)
    }

    fn check(distance: u32, passage_type: VerticalPassageType, same_type_only: bool) -> VerticalPassageGroupGraphProximityCheck {
        VerticalPassageGroupGraphProximityCheck { instance_id: TEST_ID.to_string(), distance, passage_type, same_type_only }
    }

    #[test]
    fn fires_when_entries_closer_than_threshold() {
        let maze = maze_with_two_entries(3); // entries 2 tile-hops apart
        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].groups.len(), 2);
    }

    #[test]
    fn silent_when_entries_farther_than_threshold() {
        let maze = maze_with_two_entries(10); // entries 9 tile-hops apart
        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn same_type_only_ignores_a_mixed_up_down_pair() {
        // 3 floors, all sharing a corridor on the MIDDLE floor. An up passage entering from the
        // middle floor and a down passage entering from the middle floor both have their from-end
        // on that shared floor, close together -- a genuine mixed-direction close pair.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let middle = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let m = |x: i32| mf.node_at(middle, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(m(0), m(1), EdgeKind::Basic);
        g.add_edge(m(0), t(0), EdgeKind::VerticalPassage); // up, from-end m(0) (middle)
        g.add_edge(m(1), b(1), EdgeKind::VerticalPassage); // down, from-end m(1) (middle)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, true).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "one passage is OneWayUp, the other OneWayDown -- same_type_only must exclude this pair even though their from-ends (m0, m1) are close on the middle floor");
    }

    #[test]
    fn same_type_only_still_flags_a_matching_pair() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(b(0), b(1), EdgeKind::Basic);
        g.add_bidirectional_edge(b(1), b(2), EdgeKind::Basic);
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage); // up, entry b(0)
        g.add_edge(b(2), t(2), EdgeKind::VerticalPassage); // up too, entry b(2)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, true).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "both passages are OneWayUp -- same_type_only must still flag this close pair");
    }

    #[test]
    fn passage_type_scope_excludes_a_non_matching_edge_from_the_scan_entirely() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(b(0), b(1), EdgeKind::Basic);
        g.add_bidirectional_edge(b(1), b(2), EdgeKind::Basic);
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage); // up
        g.add_edge(t(2), b(2), EdgeKind::VerticalPassage); // down
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::OneWayUp, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty(), "passage_type: OneWayUp excludes the downward passage from the scan, leaving fewer than 2 candidates");
    }

    #[test]
    fn one_way_passage_scans_only_its_from_end() {
        let maze = maze_with_two_entries(3);
        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "both from-ends are close and scan -- a one-way passage's to-end never contributes a separate candidate");
    }

    #[test]
    fn two_way_passage_scans_both_ends() {
        // Each vertical-passage node (b0/t0/b1/t1) additionally connects to a dead-end spur node,
        // giving it 3 neighbors of mixed kind so the nav-graph builder treats it as a junction
        // rather than compressing it into a straight-through corridor node (`is_corridor_node`
        // requires exactly 2 in/2 out).
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        let b1 = mf.node_at(bottom, SquarePoint { x: 1, y: 0 }).unwrap();
        let t1 = mf.node_at(top, SquarePoint { x: 1, y: 0 }).unwrap();
        let b0_spur = mf.node_at(bottom, SquarePoint { x: 0, y: 1 }).unwrap();
        let t0_spur = mf.node_at(top, SquarePoint { x: 0, y: 1 }).unwrap();
        let b1_spur = mf.node_at(bottom, SquarePoint { x: 1, y: 1 }).unwrap();
        let t1_spur = mf.node_at(top, SquarePoint { x: 1, y: 1 }).unwrap();
        g.add_bidirectional_edge(b0, b1, EdgeKind::Basic);
        g.add_bidirectional_edge(t0, t1, EdgeKind::Basic);
        g.add_bidirectional_edge(b0, b0_spur, EdgeKind::Basic);
        g.add_bidirectional_edge(t0, t0_spur, EdgeKind::Basic);
        g.add_bidirectional_edge(b1, b1_spur, EdgeKind::Basic);
        g.add_bidirectional_edge(t1, t1_spur, EdgeKind::Basic);
        g.add_bidirectional_edge(b0, t0, EdgeKind::VerticalPassage);
        g.add_bidirectional_edge(b1, t1, EdgeKind::VerticalPassage);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(1000, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "b0 and b1 (same floor) plus t0 and t1 (same floor) are all still close");
        assert_eq!(issues[0].groups.len(), 4, "a two-way passage's both ends always participate, unlike a one-way passage's from-only end");
    }

    #[test]
    fn silent_with_fewer_than_two_edges() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top = mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() { g.add_node(node); }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(1000, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }
}
