use crate::ids::EdgeId;
use crate::quality_control::issue::{
    INVALID_SPLIT_ROUTE, IssueKind, IssueKindConst, IssueMerge, IssueMeta, IssueRequirement,
};
use std::collections::HashMap;

/// One flagged edge along a route, paired with whether it is incident to the split tile the route
/// was found for (`from` or `to` resolves to that tile's own `Field::point_of`) — a repair
/// strategy needs this distinction to tell "cutting the split's own connection to the outside"
/// apart from "cutting some other passage the route happens to pass through" when deciding which
/// edge along the route to actually remove.
pub type SplitRouteEdge = (EdgeId, bool);

/// Produced by `SplitNodeConnectionTraversalDistanceCheck` — see GitHub issue #277, part of epic
/// #246. Each entry in `routes` is one flagged traversal: an ordered sequence of edges forming a
/// path shorter than the configured minimum detour between two nodes of the same split tile.
/// Order matters (it's a path, not a set) and is preserved exactly as found by the check's BFS,
/// first edge to last. Unlike `InvalidLoopIssue`'s cycles, routes are never deduplicated by their
/// edge *set* — two different routes between the same pair of nodes (or the reverse-direction
/// pair) are kept as distinct entries even if they happen to share edges, since a repair strategy
/// picks one edge per route, not per edge-set.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct InvalidSplitRouteIssue {
    meta: IssueMeta,
    pub routes: Vec<Vec<SplitRouteEdge>>,
    /// Per-route check provenance, keyed by the route's own edge sequence (order-sensitive, unlike
    /// `canonical_cycle_key`) — a route absent here was flagged by no check directly tracked.
    pub invalid_sources: HashMap<Vec<SplitRouteEdge>, Vec<String>>,
}

impl InvalidSplitRouteIssue {
    pub fn new_from_check(source_check: &str, routes: Vec<Vec<SplitRouteEdge>>) -> Self {
        let invalid_sources = routes
            .iter()
            .map(|route| (route.clone(), vec![source_check.to_string()]))
            .collect();
        Self {
            meta: IssueMeta::new_from_check(source_check),
            routes,
            invalid_sources,
        }
    }

    pub fn with_detail(mut self, source_check: &str, key: &'static str, value: String) -> Self {
        self.meta = self.meta.with_detail(source_check, key, value);
        self
    }
}

impl IssueKindConst for InvalidSplitRouteIssue {
    const KIND: IssueKind = INVALID_SPLIT_ROUTE;
}

impl IssueRequirement for InvalidSplitRouteIssue {
    type Requirement = ();
}

crate::impl_issue!(InvalidSplitRouteIssue);

impl IssueMerge for InvalidSplitRouteIssue {
    /// Dedups by exact route identity (the full ordered `SplitRouteEdge` sequence) — not by edge
    /// set, unlike `InvalidLoopIssue::merge`. Two checks flagging the literal same route (same
    /// edges, same order) collapse into one entry; anything else (different order, different
    /// edges, even a partial overlap) is kept distinct.
    fn merge(&mut self, other: Self) {
        self.meta.merge_from(other.meta);

        let mut seen: std::collections::HashSet<Vec<SplitRouteEdge>> =
            self.routes.iter().cloned().collect();
        for route in other.routes {
            if seen.insert(route.clone()) {
                self.routes.push(route);
            }
        }

        for (key, sources) in other.invalid_sources {
            let entry = self.invalid_sources.entry(key).or_default();
            for source in sources {
                if !entry.contains(&source) {
                    entry.push(source);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_unions_disjoint_routes() {
        let mut a =
            InvalidSplitRouteIssue::new_from_check("check_a", vec![vec![(0, true), (1, false)]]);
        let b =
            InvalidSplitRouteIssue::new_from_check("check_b", vec![vec![(2, false), (3, true)]]);
        a.merge(b);

        assert_eq!(a.routes.len(), 2);
        assert!(a.routes.contains(&vec![(0, true), (1, false)]));
        assert!(a.routes.contains(&vec![(2, false), (3, true)]));
    }

    #[test]
    fn merge_deduplicates_identical_route() {
        let mut a =
            InvalidSplitRouteIssue::new_from_check("check_a", vec![vec![(0, true), (1, false)]]);
        let b =
            InvalidSplitRouteIssue::new_from_check("check_b", vec![vec![(0, true), (1, false)]]);
        a.merge(b);

        assert_eq!(a.routes, vec![vec![(0, true), (1, false)]]);
    }

    #[test]
    fn merge_keeps_reordered_edges_as_a_distinct_route() {
        // Same edge set, different order -- a route is a path, not a set, so this must NOT collapse
        // the way InvalidLoopIssue's canonical_cycle_key-based merge would.
        let mut a =
            InvalidSplitRouteIssue::new_from_check("check_a", vec![vec![(0, true), (1, false)]]);
        let b =
            InvalidSplitRouteIssue::new_from_check("check_b", vec![vec![(1, false), (0, true)]]);
        a.merge(b);

        assert_eq!(
            a.routes.len(),
            2,
            "reordered edge sequence must be kept as a distinct route"
        );
    }

    #[test]
    fn merge_unions_invalid_sources_for_identical_route() {
        let mut a = InvalidSplitRouteIssue::new_from_check("check_a", vec![vec![(0, true)]]);
        let b = InvalidSplitRouteIssue::new_from_check("check_b", vec![vec![(0, true)]]);
        a.merge(b);

        let sources = a
            .invalid_sources
            .get(&vec![(0, true)])
            .expect("merged route must have recorded sources");
        assert_eq!(sources.len(), 2);
        assert!(sources.contains(&"check_a".to_string()));
        assert!(sources.contains(&"check_b".to_string()));
    }
}
