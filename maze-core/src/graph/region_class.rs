use std::collections::{HashMap, HashSet};
use crate::ids::NodeId;
use crate::graph::routing::RouteInfo;
use crate::graph::scc::{ComponentId, ConnectedComponents};
use super::Graph;

/// Classification of an SCC region relative to `start`/`finish`. Every region gets exactly one
/// class — see `Specs/graph-analytics.md`'s "Region Classes" section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RegionClass {
    /// On the shortest start→finish route (`RouteInfo::path`), or contains `start`/`finish`.
    Path,
    /// Reachable from `start` and can reach `finish`, but not on the shortest path itself.
    Alternative,
    /// Not reachable from `start` at all.
    Unreachable,
    /// Reachable from `start`, but cannot reach `finish`.
    Trap,
}

/// Every `RegionClass` variant — the "All" selection of a per-class filter (e.g.
/// `MinRegionSizeCheck::region_classes`) expands to this, not a sentinel value, so filtering code
/// stays uniform between "all classes" and "some classes" (see GitHub issue #54).
pub const ALL_REGION_CLASSES: [RegionClass; 4] = [
    RegionClass::Path,
    RegionClass::Alternative,
    RegionClass::Unreachable,
    RegionClass::Trap,
];

impl RegionClass {
    pub fn as_str(self) -> &'static str {
        match self {
            RegionClass::Path => "path",
            RegionClass::Alternative => "alternative",
            RegionClass::Unreachable => "unreachable",
            RegionClass::Trap => "trap",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "path" => Some(RegionClass::Path),
            "alternative" => Some(RegionClass::Alternative),
            "unreachable" => Some(RegionClass::Unreachable),
            "trap" => Some(RegionClass::Trap),
            _ => None,
        }
    }
}

impl std::fmt::Display for RegionClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Classifies every SCC region in `scc` relative to `start`/`finish`. `route` is the
/// already-computed shortest path between them (`MazeAnalysis::route_info`) — `None` is
/// treated the same as "no region is on the path" (every reachable-and-reaching region becomes
/// `Alternative` instead of `Path`), which cannot actually happen when `start`/`finish` are both
/// set and connected, but is handled rather than unwrapped for robustness against a disconnected
/// graph.
pub fn classify_regions(
    graph: &Graph,
    scc: &ConnectedComponents,
    route: Option<&RouteInfo>,
    start: NodeId,
    finish: NodeId,
) -> HashMap<ComponentId, RegionClass> {
    let reachable_from_start: HashSet<NodeId> = graph.reachable_from(start).into_iter().collect();
    let can_reach_finish: HashSet<NodeId> = graph.reachable_to(finish).into_iter().collect();

    let path_components: HashSet<ComponentId> = route
        .map(|r| r.path.iter().filter_map(|n| scc.component_of(*n)).collect())
        .unwrap_or_default();

    let start_component = scc.component_of(start);
    let finish_component = scc.component_of(finish);

    scc.components.iter().enumerate().map(|(comp_id, members)| {
        let is_path = path_components.contains(&comp_id)
            || Some(comp_id) == start_component
            || Some(comp_id) == finish_component;

        let class = if is_path {
            RegionClass::Path
        } else {
            let reachable = members.iter().any(|n| reachable_from_start.contains(n));
            if !reachable {
                RegionClass::Unreachable
            } else if members.iter().any(|n| can_reach_finish.contains(n)) {
                RegionClass::Alternative
            } else {
                RegionClass::Trap
            }
        };
        (comp_id, class)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{Field, SquareTessellation, SquarePoint, square_rect};
    use crate::{Graph, IdGenerator};
    use crate::graph::EdgeKind;
    use crate::graph::nav::build_nav_graph_pinned;
    use crate::graph::routing::compute_route_info;
    use crate::graph::scc::build_scc;

    /// Layout (all one-way, left to right unless noted):
    /// start(0) -> 1 -> finish(2)   (the shortest path, each node its own SCC)
    /// 1 -> 3 -> 2                  (alternative route back into finish's SCC via 3)
    /// 4 -> 5 -> 4                  (isolated cyclic region, unreachable from start)
    /// 1 -> 6                       (trap: reachable from start, dead end, can't reach finish)
    fn layout() -> (Graph, Vec<NodeId>) {
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(7, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let nodes: Vec<NodeId> = (0..7)
            .map(|x| field.node_at(SquarePoint { x, y: 0 }).unwrap())
            .collect();
        g.add_edge(nodes[0], nodes[1], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[3], EdgeKind::Basic);
        g.add_edge(nodes[3], nodes[2], EdgeKind::Basic);
        g.add_edge(nodes[4], nodes[5], EdgeKind::Basic);
        g.add_edge(nodes[5], nodes[4], EdgeKind::Basic);
        g.add_edge(nodes[1], nodes[6], EdgeKind::Basic);
        (g, nodes)
    }

    #[test]
    fn classifies_all_four_kinds() {
        let (g, nodes) = layout();
        let start = nodes[0];
        let finish = nodes[2];
        let pinned: HashSet<NodeId> = [start, finish].into_iter().collect();
        let nav = build_nav_graph_pinned(&g, &pinned);
        let route = compute_route_info(&nav, start, finish).unwrap();
        let scc = build_scc(&g);

        let classes = classify_regions(&g, &scc, Some(&route), start, finish);

        let class_of = |node: NodeId| classes[&scc.component_of(node).unwrap()];

        assert_eq!(class_of(start), RegionClass::Path);
        assert_eq!(class_of(nodes[1]), RegionClass::Path);
        assert_eq!(class_of(finish), RegionClass::Path);
        assert_eq!(class_of(nodes[3]), RegionClass::Alternative);
        assert_eq!(class_of(nodes[4]), RegionClass::Unreachable);
        assert_eq!(class_of(nodes[5]), RegionClass::Unreachable);
        assert_eq!(class_of(nodes[6]), RegionClass::Trap);
    }

    #[test]
    fn start_and_finish_regions_are_always_path_even_without_route() {
        // Disconnected: start and finish exist but no path between them — route is None.
        let mut ids = IdGenerator::new();
        let field: Field<SquareTessellation> = Field::new(square_rect(2, 1), &mut ids).unwrap();
        let mut g = Graph::new();
        field.build_nodes(&mut g);
        let a = field.node_at(SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(SquarePoint { x: 1, y: 0 }).unwrap();
        let scc = build_scc(&g);

        let classes = classify_regions(&g, &scc, None, a, b);

        assert_eq!(classes[&scc.component_of(a).unwrap()], RegionClass::Path);
        assert_eq!(classes[&scc.component_of(b).unwrap()], RegionClass::Path);
    }
}
