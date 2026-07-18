use std::collections::HashMap;
use crate::graph::{Graph, scc::ConnectedComponents};
use super::issue::Issue;
use super::issue_kinds::{canonical_cycle_key, InvalidLoopIssue, InvalidLoopGroupIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue};

/// Structural payload data for an `Issue`, resolved against the current `Graph`/`ConnectedComponents`
/// — one shared source of truth for both `maze-wasm`'s JSON `IssuePayloadDto` (via a thin
/// conversion, `maze-wasm/src/dto.rs`) and the narration-level QC event tape's binary
/// `RuleChecked` payload (`quality_control::event`). Only `InvalidLoopIssue`/
/// `InvalidLoopGroupIssue`/`RegionNeedsExpansionIssue`/`RegionNeedsShrinkIssue` carry structural
/// edge/node data today — every other concrete `Issue` type resolves to `None`, same as
/// `build_analytics_snapshot`'s pre-existing behavior. `InvalidLoopGroupIssue` reuses the
/// `InvalidLoop` payload variant (identical shape) rather than getting its own wire tag.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum IssuePayload {
    #[default]
    None,
    /// Keyed by source check id — each inner `Vec` is one invalid cycle flagged by that check,
    /// expressed as base-graph `[from, to]` maze node-id pairs. Mirrors `IssuePayloadDto::InvalidLoop`.
    InvalidLoop { edges: HashMap<String, Vec<Vec<[u32; 2]>>> },
    /// Keyed by source check id — each inner `Vec` is one flagged SCC region's member maze node
    /// ids. Mirrors `IssuePayloadDto::RegionNeedsExpansion`.
    RegionNeedsExpansion { nodes: HashMap<String, Vec<Vec<u32>>> },
    /// Keyed by source check id — same shape as `RegionNeedsExpansion`, but for an oversized
    /// region flagged for shrinking (see GitHub issue #177). Mirrors
    /// `IssuePayloadDto::RegionNeedsShrink`.
    RegionNeedsShrink { nodes: HashMap<String, Vec<Vec<u32>>> },
}

/// Resolves `issue`'s structural payload against `graph`/`scc` — extracted from
/// `maze-wasm/src/analytics.rs`'s `build_analytics_snapshot` (GitHub issue #147) so the same
/// downcast/resolve logic backs both the JSON analytics report and the binary QC event tape,
/// instead of two independently-maintained copies.
/// Shared payload-building logic for the `all`/`invalid`/`invalid_sources` cycle-set shape common
/// to `InvalidLoopIssue` and `InvalidLoopGroupIssue` — both resolve to the same
/// `IssuePayload::InvalidLoop` wire shape (see that variant's doc comment), just sourced from
/// different `Issue` types.
fn resolve_invalid_loop_payload(
    all: &[Vec<crate::ids::EdgeId>],
    invalid: &[usize],
    invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
    graph: &Graph,
) -> Option<IssuePayload> {
    let mut edges: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for &idx in invalid {
        let Some(loop_edges) = all.get(idx) else { continue };
        let edge_pairs: Vec<[u32; 2]> = loop_edges.iter().filter_map(|&eid| {
            let edge = graph.edge(eid)?;
            let from = u32::try_from(edge.from).ok()?;
            let to = u32::try_from(edge.to).ok()?;
            Some([from, to])
        }).collect();
        let key = canonical_cycle_key(loop_edges);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            edges.entry(source.clone()).or_default().push(edge_pairs.clone());
        }
    }
    if edges.is_empty() { None } else { Some(IssuePayload::InvalidLoop { edges }) }
}

pub fn resolve_issue_payload(issue: &dyn Issue, graph: &Graph, scc: &ConnectedComponents) -> IssuePayload {
    if let Some(InvalidLoopIssue { all, invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopIssue>() {
        if let Some(payload) = resolve_invalid_loop_payload(all, invalid, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidLoopGroupIssue { all, invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopGroupIssue>() {
        if let Some(payload) = resolve_invalid_loop_payload(all, invalid, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(RegionNeedsExpansionIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<RegionNeedsExpansionIssue>() {
        let mut nodes: HashMap<String, Vec<Vec<u32>>> = HashMap::new();
        for &idx in invalid {
            let Some(region) = scc.components.get(idx) else { continue };
            let node_ids: Vec<u32> = region.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            for source in invalid_sources.get(&idx).into_iter().flatten() {
                nodes.entry(source.clone()).or_default().push(node_ids.clone());
            }
        }
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsExpansion { nodes };
        }
    }

    if let Some(RegionNeedsShrinkIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<RegionNeedsShrinkIssue>() {
        let mut nodes: HashMap<String, Vec<Vec<u32>>> = HashMap::new();
        for &idx in invalid {
            let Some(region) = scc.components.get(idx) else { continue };
            let node_ids: Vec<u32> = region.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
            for source in invalid_sources.get(&idx).into_iter().flatten() {
                nodes.entry(source.clone()).or_default().push(node_ids.clone());
            }
        }
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsShrink { nodes };
        }
    }

    IssuePayload::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_graph_and_scc() -> (Graph, ConnectedComponents) {
        let graph = Graph::new();
        let scc = ConnectedComponents { components: Vec::new(), node_component: HashMap::new() };
        (graph, scc)
    }

    #[test]
    fn missing_endpoints_issue_resolves_to_none() {
        use crate::quality_control::MissingEndpointsIssue;
        let (graph, scc) = empty_graph_and_scc();
        let issue = MissingEndpointsIssue::new_from_check("check");
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_issue_with_no_flagged_cycles_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidLoopIssue::new_from_check("check", vec![], vec![], HashMap::new());
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_group_issue_with_no_flagged_cycles_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidLoopGroupIssue::new_from_check("check", vec![], vec![], HashMap::new());
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_group_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let cycle = vec![e1, e2, e3];
        let key = canonical_cycle_key(&cycle);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(key, vec!["max_loop_density".to_string()]);
        let issue = InvalidLoopGroupIssue::new_from_check("max_loop_density", vec![cycle], vec![0], invalid_sources);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert_eq!(edges.len(), 1);
        let check1_cycles = &edges["max_loop_density"];
        assert_eq!(check1_cycles.len(), 1);
        let mut pairs = check1_cycles[0].clone();
        pairs.sort();
        assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
    }

    #[test]
    fn region_needs_expansion_issue_with_no_flagged_regions_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = RegionNeedsExpansionIssue::new_from_check("check", vec![], HashMap::new());
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_issue_resolves_flagged_cycle_edges_keyed_by_source_check() {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let cycle = vec![e1, e2, e3];
        let key = canonical_cycle_key(&cycle);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(key, vec!["check1".to_string()]);
        let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert_eq!(edges.len(), 1);
        let check1_cycles = &edges["check1"];
        assert_eq!(check1_cycles.len(), 1);
        let mut pairs = check1_cycles[0].clone();
        pairs.sort();
        assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
    }

    #[test]
    fn invalid_loop_issue_fans_a_shared_cycle_out_to_every_source_check() {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 1, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let cycle = vec![e1, e2];
        let key = canonical_cycle_key(&cycle);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(key, vec!["check1".to_string(), "check2".to_string()]);
        let issue = InvalidLoopIssue::new_from_check("check1", vec![cycle], vec![0], invalid_sources);

        let IssuePayload::InvalidLoop { edges } = resolve_issue_payload(&issue, &graph, &scc) else { panic!("expected InvalidLoop") };
        assert_eq!(edges.len(), 2);
        assert!(edges.contains_key("check1"));
        assert!(edges.contains_key("check2"));
    }

    #[test]
    fn region_needs_expansion_issue_resolves_flagged_region_node_ids_keyed_by_source_check() {
        let (graph, _) = empty_graph_and_scc();
        let scc = ConnectedComponents {
            components: vec![vec![1, 2, 3]],
            node_component: HashMap::from([(1, 0), (2, 0), (3, 0)]),
        };
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert_eq!(nodes.len(), 1);
        let check1_regions = &nodes["check1"];
        assert_eq!(check1_regions.len(), 1);
        let mut region = check1_regions[0].clone();
        region.sort();
        assert_eq!(region, vec![1, 2, 3]);
    }

    #[test]
    fn region_needs_shrink_issue_with_no_flagged_regions_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = RegionNeedsShrinkIssue::new_from_check("check", vec![], HashMap::new());
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn region_needs_shrink_issue_resolves_flagged_region_node_ids_keyed_by_source_check() {
        let (graph, _) = empty_graph_and_scc();
        let scc = ConnectedComponents {
            components: vec![vec![1, 2, 3]],
            node_component: HashMap::from([(1, 0), (2, 0), (3, 0)]),
        };
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::RegionNeedsShrink { nodes } = payload else { panic!("expected RegionNeedsShrink, got {payload:?}") };
        assert_eq!(nodes.len(), 1);
        let check1_regions = &nodes["check1"];
        assert_eq!(check1_regions.len(), 1);
        let mut region = check1_regions[0].clone();
        region.sort();
        assert_eq!(region, vec![1, 2, 3]);
    }
}
