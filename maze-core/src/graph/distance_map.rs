use std::collections::HashMap;
use super::nav::{NavGraph, NavNodeId};
use super::pathfinding::{dijkstra_forward, dijkstra_reverse};

/// Direction of traversal relative to `source`, following directed nav-edge semantics
/// (never treated as undirected).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistanceDirection {
    /// Distance FROM `source` (follows outgoing edges) — used for distance-from-start.
    Forward,
    /// Distance TO `source` (follows incoming edges) — used for distance-to-finish.
    Reverse,
}

/// Maps every `NavNodeId` reachable from (or to, depending on `direction`) `source` to its
/// shortest-path distance in tiles. Distance is purely tile count along the field graph —
/// each nav-edge already carries its own tile length (`path.len() - 1`, see `pathfinding.rs`),
/// so a neighboring nav-node four tiles away via one corridor has distance 4, not 1.
///
/// Nav-domain only (junction/start/finish nodes) — corridor-interior maze nodes compressed
/// out of the nav graph have no entry here, callers needing those go through `path` on the
/// relevant nav-edge instead.
///
/// Unreachable nodes are absent from the map (no key), rather than represented by a sentinel
/// value — query with `.get()`.
pub(crate) fn compute_distance_map(nav: &NavGraph, source: NavNodeId, direction: DistanceDirection) -> HashMap<NavNodeId, usize> {
    let nav_dist = match direction {
        DistanceDirection::Forward => dijkstra_forward(nav, source),
        DistanceDirection::Reverse => dijkstra_reverse(nav, source),
    };

    nav_dist.into_iter()
        .enumerate()
        .filter(|&(_, dist)| dist != usize::MAX)
        .collect()
}

/// Minimum distance (tiles) among all nav-nodes touched by `cycle` (a list of nav-edge
/// indices), per `dist_map` (the output of `compute_distance_map`). A nav-node absent from
/// `dist_map` (unreachable) is skipped; if every touched nav-node is unreachable, returns
/// `usize::MAX` — the cycle has no defined distance.
///
/// Shared by `LoopDistanceFromStartCheck`/`LoopDistanceFromFinishCheck` — both need the same
/// "closest point of the cycle" reduction, just over a different `dist_map`.
pub(crate) fn cycle_min_distance(nav: &NavGraph, cycle: &[usize], dist_map: &HashMap<NavNodeId, usize>) -> usize {
    cycle.iter()
        .flat_map(|&idx| {
            let edge = nav.edge_by_idx(idx);
            [edge.from, edge.to]
        })
        .filter_map(|node| dist_map.get(&node).copied())
        .min()
        .unwrap_or(usize::MAX)
}

/// `a.min(b)` treating `None` as absent rather than infinite — `None` only when both are `None`.
/// Shared by every check that reduces two independently-optional tile distances (e.g. distance
/// to each of two waypoints, or forward/reverse distance between two nav-nodes) to their closest.
pub(crate) fn min_optional_distance(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::graph::nav::build_nav_graph;
    use crate::graph::cycles::{find_all_simple_cycles, CycleSearchResult};

    /// Triangle a->b->c->a, with `a` also pinned (degree-2 corridor exemption is irrelevant
    /// here since every node in a 3-cycle has exactly one outgoing/incoming edge, already a
    /// nav-node). Returns the nav graph and the (single) cycle's nav-edge indices.
    fn triangle_cycle() -> (NavGraph, Vec<usize>) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(3, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let p = |x: i32| field.node_at(SquarePoint { x, y: 0 }).unwrap();
        g.add_edge(p(0), p(1), EdgeKind::Basic);
        g.add_edge(p(1), p(2), EdgeKind::Basic);
        g.add_edge(p(2), p(0), EdgeKind::Basic);
        let nav = build_nav_graph(&g);
        let cycle = match find_all_simple_cycles(&nav) {
            CycleSearchResult::Cycles(cycles) => cycles.into_iter().next().unwrap(),
            CycleSearchResult::TooManyCycles => panic!("triangle must not overflow"),
        };
        (nav, cycle)
    }

    #[test]
    fn cycle_min_distance_picks_closest_touched_node() {
        let (nav, cycle) = triangle_cycle();
        // Build dist_map by hand: every nav-node in the triangle gets a distinct distance,
        // the minimum among them must win regardless of which edge order the cycle visits.
        let mut dist_map = HashMap::new();
        for &idx in &cycle {
            let edge = nav.edge_by_idx(idx);
            dist_map.entry(edge.from).or_insert(100);
            dist_map.entry(edge.to).or_insert(100);
        }
        let nodes: Vec<NavNodeId> = dist_map.keys().copied().collect();
        for (i, &node) in nodes.iter().enumerate() {
            dist_map.insert(node, (i as usize) * 10);
        }
        let expected = *dist_map.values().min().unwrap();
        assert_eq!(cycle_min_distance(&nav, &cycle, &dist_map), expected);
    }

    #[test]
    fn cycle_min_distance_skips_unreachable_nodes_in_mix() {
        let (nav, cycle) = triangle_cycle();
        // Only one touched nav-node has a recorded distance; the others (absent from
        // dist_map, i.e. unreachable) must be skipped rather than treated as distance 0.
        let any_node = nav.edge_by_idx(cycle[0]).from;
        let mut dist_map = HashMap::new();
        dist_map.insert(any_node, 7);
        assert_eq!(cycle_min_distance(&nav, &cycle, &dist_map), 7);
    }

    #[test]
    fn cycle_min_distance_is_max_when_all_touched_nodes_unreachable() {
        let (nav, cycle) = triangle_cycle();
        let dist_map: HashMap<NavNodeId, usize> = HashMap::new(); // nothing reachable
        assert_eq!(cycle_min_distance(&nav, &cycle, &dist_map), usize::MAX);
    }

    fn line_graph(len: usize) -> (Graph, Vec<crate::ids::NodeId>) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(len, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<crate::ids::NodeId> = (0..len)
            .map(|x| field.node_at(SquarePoint { x: x as i32, y: 0 }).unwrap())
            .collect();
        for i in 0..len - 1 {
            g.add_bidirectional_edge(nodes[i], nodes[i + 1], EdgeKind::Basic);
        }
        (g, nodes)
    }

    #[test]
    fn forward_distance_in_tiles() {
        let (g, nodes) = line_graph(4);
        let nav = build_nav_graph(&g);
        let source = nav.nav_node_for(nodes[0]).unwrap();
        let last = nav.nav_node_for(nodes[3]).unwrap();
        let dist = compute_distance_map(&nav, source, DistanceDirection::Forward);
        assert_eq!(dist.get(&source), Some(&0));
        assert_eq!(dist.get(&last), Some(&3)); // 3 tile-hops, even though it's a single nav-edge
    }

    #[test]
    fn reverse_distance_to_target() {
        let (g, nodes) = line_graph(4);
        let nav = build_nav_graph(&g);
        let first = nav.nav_node_for(nodes[0]).unwrap();
        let target = nav.nav_node_for(nodes[3]).unwrap();
        let dist = compute_distance_map(&nav, target, DistanceDirection::Reverse);
        assert_eq!(dist.get(&first), Some(&3));
        assert_eq!(dist.get(&target), Some(&0));
    }

    #[test]
    fn unreachable_node_absent_from_map() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(4, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let c = field.node_at(SquarePoint { x: 2, y: 0 }).unwrap();
        let d = field.node_at(SquarePoint { x: 3, y: 0 }).unwrap();
        g.add_bidirectional_edge(a, b, EdgeKind::Basic);
        g.add_bidirectional_edge(c, d, EdgeKind::Basic);
        let nav = build_nav_graph(&g);

        let source = nav.nav_node_for(a).unwrap();
        let nav_c = nav.nav_node_for(c).unwrap();
        let dist = compute_distance_map(&nav, source, DistanceDirection::Forward);
        assert_eq!(dist.get(&source), Some(&0));
        assert_eq!(dist.get(&nav_c), None);
    }

    #[test]
    fn directed_only_one_way_edge_blocks_reverse_distance() {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        g.add_edge(a, b, EdgeKind::Basic); // one-way a -> b only

        let nav = build_nav_graph(&g);
        let nav_a = nav.nav_node_for(a).unwrap();
        let nav_b = nav.nav_node_for(b).unwrap();

        let forward = compute_distance_map(&nav, nav_a, DistanceDirection::Forward);
        assert_eq!(forward.get(&nav_b), Some(&1));

        let reverse = compute_distance_map(&nav, nav_a, DistanceDirection::Reverse);
        assert_eq!(reverse.get(&nav_b), None); // no directed path b -> a
    }
}
