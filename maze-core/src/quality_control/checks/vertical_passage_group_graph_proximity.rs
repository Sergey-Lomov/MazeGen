use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use super::vertical_passage_count_core::vertical_passage_proximity_candidates;
use crate::Maze;
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::check::Check;
use crate::quality_control::{InvalidVerticalPassageGroupIssue, VerticalPassageType};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

pub const VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DISTANCE_DEFAULT: u32 = 0;
pub const VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_TYPE: VerticalPassageType =
    VerticalPassageType::Any;
pub const VERTICAL_PASSAGE_GROUP_GRAPH_PROXIMITY_DEFAULT_COUNT_INCOMING: bool = true;

/// Flags a pair of `EdgeKind::VerticalPassage` entries too close to each other topologically
/// (tile-hops via the shared nav-graph distance map) — see GitHub issue #343. Mirrors
/// `TeleportGroupProximityCheck`'s pairwise-scan shape, one candidate per scan-worthy entry (see
/// `vertical_passage_proximity_candidates`) — a two-way passage's two ends always both participate;
/// a one-way passage's `to` end joins its `from` end as a second candidate only when
/// `count_incoming` is set, same as the geometric proximity check.
///
/// A one-way passage's `to` end is topologically its own distinct position, not merely a detour
/// through its `from` end — two one-way passages whose *entries* sit far apart but whose *exits*
/// sit close together (e.g. two `OneWayDown` passages descending to nearby tiles on the lower
/// floor from unrelated, distant entries) are only caught by measuring from the `to` end, which
/// `count_incoming: false` never scans (GitHub issue #619 regression report — this could never fire
/// against such a pair).
///
/// Distance excludes hops through the scanned entry's *own* passage only (GitHub issue #512) — an
/// unrelated vertical passage elsewhere in the maze is traversed like an ordinary nav hop, so a
/// genuinely close pair on its far side is still reported as close, rather than the whole
/// `VerticalPassage` kind being a traversal blind spot. Unlike `Teleport`, `NavEdge` carries no
/// dedicated `is_vertical_passage` flag (GitHub issue #197 only disambiguated `Teleport`), so the
/// exclusion set is built explicitly from the scanned entry's own passage `(from, to)` pair (both
/// directions) and matched against each single-hop `NavEdge`'s `path`.
///
/// `passage_type`/`same_type_only`/`count_incoming` mirror
/// `VerticalPassageGroupGeometricProximityCheck`'s own parameters exactly.
pub struct VerticalPassageGroupGraphProximityCheck {
    pub instance_id: String,
    pub distance: u32,
    pub passage_type: VerticalPassageType,
    pub same_type_only: bool,
    pub count_incoming: bool,
}

impl<T: Tessellation> Check<T, InvalidVerticalPassageGroupIssue>
    for VerticalPassageGroupGraphProximityCheck
{
    fn check_type_id(&self) -> &'static str {
        "vertical_passage_group_graph_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidVerticalPassageGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let candidates: Vec<(EdgeId, NodeId, VerticalPassageType)> =
            vertical_passage_proximity_candidates(maze, self.passage_type, self.count_incoming)
                .into_iter()
                .map(|c| (c.canonical_edge, c.node, c.passage_type))
                .collect();
        if candidates.len() < 2 {
            return;
        }

        // Per-entry hop-exclusion set (GitHub issue #512): only the scanned entry's own passage
        // (both directions) is excluded from its traversal. `NavEdge` carries no dedicated
        // `is_vertical_passage` flag (unlike `Teleport`'s `is_teleport` — see the check's own doc
        // comment), so this matches on `path` alone, same as before (no `own_hop_kind_guard`).
        let own_hop_pairs = |&(canonical_edge, ..): &(EdgeId, NodeId, VerticalPassageType)| -> HashSet<(NodeId, NodeId)> {
            maze.graph
                .edge(canonical_edge)
                .map(|e| HashSet::from([(e.from, e.to), (e.to, e.from)]))
                .unwrap_or_default()
        };

        let groups = pairwise_graph_proximity_scan(
            &nav,
            &candidates,
            self.distance as usize,
            false,
            own_hop_pairs,
            |_, _| true,
            |&(_, node, _)| ScanAnchor::Single(node),
            |&(_, node, _)| ScanAnchor::Single(node),
            |dist| (dist as u32) < self.distance,
            |&(own_id, _, own_type), &(other_id, _, other_type)| {
                other_id == own_id || (self.same_type_only && own_type != other_type)
            },
            |&(own_id, ..), &(other_id, ..)| (vec![own_id, other_id], 1),
        );

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
    use crate::graph::EdgeKind;
    use crate::space::{Field, MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;

    const TEST_ID: &str = "vertical_passage_group_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    /// Two floors, `len`-tile corridor on the bottom floor connecting two vertical passage
    /// entries (x=0 and x=len-1), each going up to the top floor.
    fn maze_with_two_entries(len: usize) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(len, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(len, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(b(i as i32), b(i as i32 + 1), EdgeKind::Basic);
        }
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage);
        g.add_edge(
            b(len as i32 - 1),
            t(len as i32 - 1),
            EdgeKind::VerticalPassage,
        );
        Maze::new(mf, g)
    }

    fn check(
        distance: u32,
        passage_type: VerticalPassageType,
        same_type_only: bool,
    ) -> VerticalPassageGroupGraphProximityCheck {
        VerticalPassageGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance,
            passage_type,
            same_type_only,
            count_incoming: false,
        }
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
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let middle =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let m = |x: i32| mf.node_at(middle, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(m(0), m(1), EdgeKind::Basic);
        g.add_edge(m(0), t(0), EdgeKind::VerticalPassage); // up, from-end m(0) (middle)
        g.add_edge(m(1), b(1), EdgeKind::VerticalPassage); // down, from-end m(1) (middle)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, true).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "one passage is OneWayUp, the other OneWayDown -- same_type_only must exclude this pair even though their from-ends (m0, m1) are close on the middle floor"
        );
    }

    #[test]
    fn same_type_only_still_flags_a_matching_pair() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(b(0), b(1), EdgeKind::Basic);
        g.add_bidirectional_edge(b(1), b(2), EdgeKind::Basic);
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage); // up, entry b(0)
        g.add_edge(b(2), t(2), EdgeKind::VerticalPassage); // up too, entry b(2)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, true).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "both passages are OneWayUp -- same_type_only must still flag this close pair"
        );
    }

    #[test]
    fn passage_type_scope_excludes_a_non_matching_edge_from_the_scan_entirely() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(3, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(b(0), b(1), EdgeKind::Basic);
        g.add_bidirectional_edge(b(1), b(2), EdgeKind::Basic);
        g.add_edge(b(0), t(0), EdgeKind::VerticalPassage); // up
        g.add_edge(t(2), b(2), EdgeKind::VerticalPassage); // down
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::OneWayUp, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(
            issues.is_empty(),
            "passage_type: OneWayUp excludes the downward passage from the scan, leaving fewer than 2 candidates"
        );
    }

    #[test]
    fn one_way_passage_scans_only_its_from_end() {
        let maze = maze_with_two_entries(3);
        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "both from-ends are close and scan -- a one-way passage's to-end never contributes a separate candidate"
        );
    }

    #[test]
    fn count_incoming_off_ignores_a_close_pair_of_to_ends() {
        // Two OneWayDown passages descending from unrelated, far-apart entries (t0, t9) on the top
        // floor into two adjacent tiles (b0, b1) on the bottom floor -- the *entries* are far apart,
        // only the *exits* are close (GitHub issue #619 regression report). With count_incoming off,
        // neither to-end is ever a scan candidate, so this close pair goes undetected.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..9 {
            g.add_bidirectional_edge(t(i), t(i + 1), EdgeKind::Basic);
        }
        g.add_edge(t(0), b(0), EdgeKind::VerticalPassage); // down, far entry, exit b(0)
        g.add_edge(t(9), b(1), EdgeKind::VerticalPassage); // down, far entry, exit b(1)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(5, VerticalPassageType::Any, false).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "count_incoming off never scans the to-ends, so the close exits go unseen"
        );
    }

    #[test]
    fn count_incoming_on_flags_a_close_pair_of_to_ends() {
        // Same maze as `count_incoming_off_ignores_a_close_pair_of_to_ends`, but with
        // count_incoming on -- the to-ends (b0, b1, 1 tile-hop apart) now scan as their own
        // candidates and must be caught.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(10, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b = |x: i32| mf.node_at(bottom, SquarePoint { x, y: 0 }).unwrap();
        let t = |x: i32| mf.node_at(top, SquarePoint { x, y: 0 }).unwrap();
        for i in 0..9 {
            g.add_bidirectional_edge(t(i), t(i + 1), EdgeKind::Basic);
        }
        g.add_bidirectional_edge(b(0), b(1), EdgeKind::Basic);
        g.add_edge(t(0), b(0), EdgeKind::VerticalPassage); // down, far entry, exit b(0)
        g.add_edge(t(9), b(1), EdgeKind::VerticalPassage); // down, far entry, exit b(1)
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        let check = VerticalPassageGroupGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance: 5,
            passage_type: VerticalPassageType::Any,
            same_type_only: false,
            count_incoming: true,
        };
        check.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "count_incoming on scans the to-ends too, catching the close exits"
        );
    }

    #[test]
    fn two_way_passage_scans_both_ends() {
        // Each vertical-passage node (b0/t0/b1/t1) additionally connects to a dead-end spur node,
        // giving it 3 neighbors of mixed kind so the nav-graph builder treats it as a junction
        // rather than compressing it into a straight-through corridor node (`is_corridor_node`
        // requires exactly 2 in/2 out).
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 2), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
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
        check(1000, VerticalPassageType::Any, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert_eq!(
            issues.len(),
            1,
            "b0 and b1 (same floor) plus t0 and t1 (same floor) are all still close"
        );
        assert_eq!(
            issues[0].groups.len(),
            4,
            "a two-way passage's both ends always participate, unlike a one-way passage's from-only end"
        );
    }

    #[test]
    fn silent_with_fewer_than_two_edges() {
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> = MultiLevelField::new(std::iter::empty());
        let bottom =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let top =
            mf.add_level(Field::<SquareTessellation>::new(square_rect(2, 1), &mut ids).unwrap());
        let mut g = Graph::new();
        for node in mf.all_node_ids() {
            g.add_node(node);
        }
        let b0 = mf.node_at(bottom, SquarePoint { x: 0, y: 0 }).unwrap();
        let t0 = mf.node_at(top, SquarePoint { x: 0, y: 0 }).unwrap();
        g.add_edge(b0, t0, EdgeKind::VerticalPassage);
        let maze = Maze::new(mf, g);

        let mut issues = Vec::new();
        check(1000, VerticalPassageType::Any, false).repair_check(
            &maze,
            &mut issues,
            &mut rng(),
            (),
        );
        assert!(issues.is_empty());
    }
}
