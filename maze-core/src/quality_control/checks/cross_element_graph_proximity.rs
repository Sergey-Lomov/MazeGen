use super::cross_element_geometric_proximity::{
    RawClosePair, aggregate_pairs, elevator_of_stop, route_protected_elements, same_elevator_pair,
};
use super::proximity_scan_core::{ScanAnchor, pairwise_graph_proximity_scan};
use crate::Maze;
use crate::ids::NodeId;
use crate::quality_control::InvalidCrossElementGroupIssue;
use crate::quality_control::check::Check;
use crate::quality_control::cross_element::{
    CrossElement, CrossElementSet, cross_element_edges, cross_element_occurrences,
};
use crate::space::Tessellation;
use rand::RngCore;
use std::collections::HashSet;

pub const CROSS_ELEMENT_GRAPH_PROXIMITY_DISTANCE_DEFAULT: u32 = 1;

/// Flags two special maze elements of a user-selected type set placed closer than a configured
/// minimum number of tile-hops apart, measured on the shared nav graph — see GitHub issue #376.
/// The graph counterpart of [`CrossElementGeometricProximityCheck`](super::cross_element_geometric_proximity::CrossElementGeometricProximityCheck);
/// same complete-graph-over-the-enabled-types semantics, same occurrence model, same silent
/// no-op only when zero types are enabled (one type is a valid same-type scan).
///
/// Distance excludes hops through the scanned occurrence's *own* element only (GitHub issue
/// #512) — a `Teleport`/`VerticalPassage`/`Elevator` edge belonging to some *other* element is
/// traversed like an ordinary nav hop, so a genuinely close pair on its far side is still reported
/// as close. `cross_element_edges` already gives each element's own owned edges (both directions
/// for a two-way teleport/passage, every fan edge for an elevator stop, the single directed edge
/// for a one-way); `Split`/`Start`/`Finish` own no edge at all, so their exclusion set is empty.
/// Each occurrence carries one maze `NodeId`; a pair is flagged if any of one element's occurrence
/// nodes is within the threshold of any of the other's. Distance is measured via
/// `pairwise_graph_proximity_scan`, which correctly resolves a corridor-interior occurrence node
/// with no `NavNodeId` of its own — a `Split`
/// occurrence sitting on an otherwise-plain 2-degree tile is the common case — instead of silently
/// dropping it from the scan (GitHub issue #512 follow-up).
///
/// `protect_route` behaves as on [`CrossElementGeometricProximityCheck`](super::cross_element_geometric_proximity::CrossElementGeometricProximityCheck):
/// a pair whose both elements are route-protected is not flagged.
pub struct CrossElementGraphProximityCheck {
    pub instance_id: String,
    pub distance: u32,
    pub set: CrossElementSet,
    pub protect_route: bool,
}

impl<T: Tessellation> Check<T, InvalidCrossElementGroupIssue> for CrossElementGraphProximityCheck {
    fn check_type_id(&self) -> &'static str {
        "cross_element_graph_proximity"
    }

    fn repair_check(
        &self,
        maze: &Maze<T>,
        issues: &mut Vec<InvalidCrossElementGroupIssue>,
        _rng: &mut dyn RngCore,
        _requirement: (),
    ) {
        if self.set.enabled_count() < 1 {
            return;
        }
        let nav = maze.analysis.nav_graph(&maze.graph, &maze.meta);

        let occurrences = cross_element_occurrences(maze, &self.set, &nav);
        let route_protected = route_protected_elements(maze, &occurrences, self.protect_route);
        let elevator_of_stop = elevator_of_stop(maze, &occurrences);

        let candidates: Vec<(CrossElement, NodeId)> = occurrences
            .into_iter()
            .map(|o| (o.element, o.node))
            .collect();
        if candidates.len() < 2 {
            return;
        }

        // Per-element hop-exclusion set (GitHub issue #512): only the scanned occurrence's own
        // element's own edges are excluded from its traversal.
        let own_hop_pairs = |own: &(CrossElement, NodeId)| -> HashSet<(NodeId, NodeId)> {
            cross_element_edges(maze, &own.0)
                .into_iter()
                .filter_map(|id| maze.graph.edge(id))
                .flat_map(|e| [(e.from, e.to), (e.to, e.from)])
                .collect()
        };
        let raw = pairwise_graph_proximity_scan(
            &nav,
            &candidates,
            self.distance as usize,
            false,
            own_hop_pairs,
            |_, _| true,
            |&(_, node)| ScanAnchor::Single(node),
            |&(_, node)| ScanAnchor::Single(node),
            |dist| (dist as u32) < self.distance,
            |(own_el, _), (other_el, _)| {
                own_el == other_el
                    || (route_protected.contains(own_el) && route_protected.contains(other_el))
                    || same_elevator_pair(&elevator_of_stop, own_el, other_el)
            },
            |(own_el, own_node), (other_el, other_node)| {
                (
                    vec![RawClosePair {
                        own_element: own_el.clone(),
                        own_node: *own_node,
                        other_element: other_el.clone(),
                        other_node: *other_node,
                    }],
                    1,
                )
            },
        );

        let (groups, close_nodes) = aggregate_pairs(raw.into_iter().flat_map(|(v, _)| v).collect());
        if groups.is_empty() {
            return;
        }
        let issue =
            InvalidCrossElementGroupIssue::new_from_check(&self.instance_id, groups, close_nodes)
                .with_detail(&self.instance_id, "distance", self.distance.to_string());
        issues.push(issue);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::EdgeKind;
    use crate::space::{MultiLevelField, SquarePoint, SquareTessellation, square_rect};
    use crate::{Graph, IdGenerator};
    use rand::SeedableRng;
    use std::sync::Arc;

    const TEST_ID: &str = "cross_element_graph_proximity";

    fn rng() -> crate::random::MazeRng {
        crate::random::MazeRng::seed_from_u64(0)
    }

    fn set_teleport_one_way() -> CrossElementSet {
        CrossElementSet {
            teleport: true,
            one_way: true,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start: false,
            finish: false,
        }
    }

    fn check(distance: u32, set: CrossElementSet) -> CrossElementGraphProximityCheck {
        CrossElementGraphProximityCheck {
            instance_id: TEST_ID.to_string(),
            distance,
            set,
            protect_route: false,
        }
    }

    /// Single floor corridor of width `w`. A teleport portal between x=0 and x=`w-1`, and a
    /// one-way (single-direction Basic) edge from x=`ow` to x=`ow+1`; every other adjacent pair
    /// is a two-way Basic passage.
    fn corridor_with_teleport_and_one_way(w: usize, ow: i32) -> Maze<SquareTessellation> {
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(w, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..w as i32 - 1 {
            if x == ow {
                g.add_edge(p(x), p(x + 1), EdgeKind::Basic); // one-way
            } else {
                g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
            }
        }
        g.add_edge(p(0), p(w as i32 - 1), EdgeKind::Teleport);
        g.add_edge(p(w as i32 - 1), p(0), EdgeKind::Teleport);
        Maze::new(mf, g)
    }

    #[test]
    fn fires_when_a_teleport_end_and_a_one_way_are_within_the_hop_threshold() {
        // one-way between x=1 and x=2, teleport end at x=0 -> ~1 hop away.
        let maze = corridor_with_teleport_and_one_way(7, 1);
        let mut issues = Vec::new();
        check(3, set_teleport_one_way()).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            issues[0].groups().len(),
            1,
            "one logical pair despite the teleport having two ends and the one-way two endpoints"
        );
    }

    #[test]
    fn silent_when_farther_than_threshold() {
        let maze = corridor_with_teleport_and_one_way(12, 5);
        let mut issues = Vec::new();
        check(2, set_teleport_one_way()).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn teleport_hop_does_not_shorten_the_path() {
        // one-way at x=5..6 in a width-8 corridor. Near teleport end x=7 is ~2 hops from the
        // one-way; far end x=0 is ~5. Without hop exclusion the far end would look 1 hop away
        // (teleport to x=7, then walk). With exclusion it stays far.
        let maze = corridor_with_teleport_and_one_way(8, 5);
        let mut issues = Vec::new();
        check(3, set_teleport_one_way()).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "still one logical pair — the near end is close, aggregation keeps it to one group"
        );
        assert_eq!(issues[0].groups().len(), 1);
    }

    #[test]
    fn silent_when_no_type_is_enabled() {
        let maze = corridor_with_teleport_and_one_way(7, 1);
        let mut issues = Vec::new();
        let set = CrossElementSet {
            teleport: false,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start: false,
            finish: false,
        };
        check(100, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(issues.is_empty());
    }

    #[test]
    fn a_single_enabled_type_runs_a_same_type_scan() {
        // Two one-ways one hop apart, only `one_way` enabled -> a valid same-type scan (subsumes
        // the old `one_way_group_graph_proximity`).
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way x=0->x=1
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_edge(p(2), p(3), EdgeKind::Basic); // one-way x=2->x=3
        g.add_bidirectional_edge(p(3), p(4), EdgeKind::Basic);
        g.add_bidirectional_edge(p(4), p(5), EdgeKind::Basic);
        let maze = Maze::new(mf, g);

        let set = CrossElementSet {
            teleport: false,
            one_way: true,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start: false,
            finish: false,
        };
        let mut issues = Vec::new();
        check(3, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "two distinct one-ways within the hop threshold -> one same-type pair"
        );
        assert_eq!(issues[0].groups().len(), 1);
    }

    #[test]
    fn start_and_finish_pair_is_flagged() {
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(4, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..3 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        let (s, f) = (p(0), p(1));
        let mut maze = Maze::new(mf, g);
        maze.meta.start = Some(s);
        maze.meta.finish = Some(f);

        let set = CrossElementSet {
            teleport: false,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start: true,
            finish: true,
        };
        let mut issues = Vec::new();
        check(3, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1);
        let group = &issues[0].groups()[0].0;
        assert!(group.iter().any(|e| matches!(e, CrossElement::Start(_))));
        assert!(group.iter().any(|e| matches!(e, CrossElement::Finish(_))));
    }

    #[test]
    fn protect_route_excludes_a_pair_with_both_elements_on_the_route() {
        // Width-6 corridor. Route: x=0 ->(one-way) x=1 -> x=2 ->(teleport) x=5. Both the one-way
        // and the teleport lie on it. Their occurrences are ~1 hop apart.
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(6, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic); // one-way
        g.add_bidirectional_edge(p(1), p(2), EdgeKind::Basic);
        g.add_bidirectional_edge(p(2), p(3), EdgeKind::Basic);
        g.add_bidirectional_edge(p(3), p(4), EdgeKind::Basic);
        g.add_edge(p(2), p(5), EdgeKind::Teleport);
        g.add_edge(p(5), p(2), EdgeKind::Teleport);
        let (s, f) = (p(0), p(5));
        let mut maze = Maze::new(mf, g);
        maze.meta.start = Some(s);
        maze.meta.finish = Some(f);

        let set = set_teleport_one_way();

        let mut c = check(5, set);
        c.protect_route = true;
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "both elements on the protected route -> pair excluded"
        );

        let mut c = check(5, set);
        c.protect_route = false;
        let mut issues = Vec::new();
        c.repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(issues.len(), 1, "without protection the close pair fires");
    }

    #[test]
    fn a_corridor_interior_split_node_still_participates_in_the_graph_scan() {
        // A split tile at x=2 whose *only* node (p(2)) is a plain 2-degree corridor-interior node
        // (neighbors p(1)/p(3), nothing else) -- unlike `a_split_tile_occurrence_participates_in_the_graph_scan`,
        // there is no junction-shaped alternate node to fall back on, so the scan only succeeds if
        // a corridor-interior occurrence node with no `NavNodeId` of its own is still resolved by
        // `pairwise_graph_proximity_scan` (GitHub issue #512 follow-up), not silently dropped.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        mf.add_node_at(level, SquarePoint { x: 2, y: 0 }, &mut ids); // second node at the split tile
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..4 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // The second split node is a dead end (no edges at all) -- it never resolves to a
        // NavNodeId either, but it also never matters here: p(2) itself is the corridor-interior
        // node under test.
        g.add_edge(p(0), p(4), EdgeKind::Teleport);
        g.add_edge(p(4), p(0), EdgeKind::Teleport);
        let maze = Maze::new(mf, g);

        let set = CrossElementSet {
            teleport: true,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: true,
            start: false,
            finish: false,
        };
        let mut issues = Vec::new();
        check(3, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "the teleport end at x=0 is within 3 hops of the corridor-interior split tile at x=2"
        );
        assert_eq!(issues[0].groups().len(), 1);
    }

    #[test]
    fn silent_with_a_single_occurrence() {
        let mut ids = IdGenerator::new();
        let mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(3, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        g.add_bidirectional_edge(p(0), p(1), EdgeKind::Basic);
        let s = p(0);
        let mut maze = Maze::new(mf, g);
        maze.meta.start = Some(s);

        let set = CrossElementSet {
            teleport: false,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: false,
            start: true,
            finish: true,
        };
        let mut issues = Vec::new();
        check(100, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert!(
            issues.is_empty(),
            "only start is set, finish is None -> one occurrence -> nothing to pair"
        );
    }

    #[test]
    fn a_split_tile_occurrence_participates_in_the_graph_scan() {
        // A non-edge occurrence (split tile) paired with an edge element (teleport) on the graph
        // path -- the split contributes nav occurrences at its tile nodes, and the teleport's far
        // end is one walk-hop away.
        let mut ids = IdGenerator::new();
        let mut mf: MultiLevelField<SquareTessellation> =
            MultiLevelField::single_level(Arc::default(), square_rect(5, 1), &mut ids).unwrap();
        let level = mf.single_level_id();
        mf.add_node_at(level, SquarePoint { x: 2, y: 0 }, &mut ids); // second node at the split tile
        let mut g = Graph::new();
        for n in mf.all_node_ids() {
            g.add_node(n);
        }
        let p = |x: i32| mf.node_at(level, SquarePoint { x, y: 0 }).unwrap();
        for x in 0..4 {
            g.add_bidirectional_edge(p(x), p(x + 1), EdgeKind::Basic);
        }
        // Wire the second split node into the walk graph so it has a nav occurrence.
        let extra = mf.nodes_at(level, SquarePoint { x: 2, y: 0 })[1];
        g.add_bidirectional_edge(p(1), extra, EdgeKind::Basic);
        g.add_edge(p(0), p(4), EdgeKind::Teleport);
        g.add_edge(p(4), p(0), EdgeKind::Teleport);
        let maze = Maze::new(mf, g);

        let set = CrossElementSet {
            teleport: true,
            one_way: false,
            vertical_passage: false,
            elevator_stop: false,
            split: true,
            start: false,
            finish: false,
        };
        let mut issues = Vec::new();
        check(3, set).repair_check(&maze, &mut issues, &mut rng(), ());
        assert_eq!(
            issues.len(),
            1,
            "the teleport end at x=0 is within 3 hops of the split tile at x=2"
        );
        assert_eq!(issues[0].groups().len(), 1);
    }
}
