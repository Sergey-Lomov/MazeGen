use std::collections::HashMap;
use crate::ids::NodeId;
use crate::graph::{Graph, scc::ConnectedComponents};
use super::issue::Issue;
use super::issue_kinds::{canonical_cycle_key, InvalidLoopIssue, InvalidLoopGroupIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue, InvalidSplitTileIssue, InvalidSplitTileGroupIssue, SplitTileNodes, InvalidSplitNodeIssue, InvalidSplitNodeConnectionGroupIssue, InvalidSplitRouteIssue, SplitRouteEdge};

/// Structural payload data for an `Issue`, resolved against the current `Graph`/`ConnectedComponents`
/// — one shared source of truth for both `maze-wasm`'s JSON `IssuePayloadDto` (via a thin
/// conversion, `maze-wasm/src/dto.rs`) and the narration-level QC event tape's binary
/// `RuleChecked` payload (`quality_control::event`). Only `InvalidLoopIssue`/
/// `InvalidLoopGroupIssue`/`RegionNeedsExpansionIssue`/`RegionNeedsShrinkIssue`/
/// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue`/`InvalidOneWayIssue`/
/// `InvalidOneWayGroupIssue`/`InvalidSplitNodeConnectionGroupIssue` carry structural edge/node
/// data today — every other concrete `Issue` type resolves to `None`, same as
/// `build_analytics_snapshot`'s pre-existing behavior.
/// `InvalidLoopGroupIssue` reuses the `InvalidLoop` payload variant (identical shape) rather than
/// getting its own wire tag — `InvalidTeleportGroupIssue` reuses `InvalidTeleport` the same way,
/// and `InvalidOneWayGroupIssue` reuses `InvalidOneWay` the same way (see GitHub issue #205).
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
    /// Keyed by source check id — each inner `Vec` is one flagged teleport "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per teleport edge in the group.
    /// `InvalidTeleportIssue` (a single flagged teleport is really a group of size one) and
    /// `InvalidTeleportGroupIssue` (a problematic pair) both resolve into this same shape rather
    /// than getting their own payload variant each — see GitHub issue #195, mirrors
    /// `InvalidLoop`'s reuse across `InvalidLoopIssue`/`InvalidLoopGroupIssue`. Mirrors
    /// `IssuePayloadDto::InvalidTeleport`.
    InvalidTeleport { groups: HashMap<String, Vec<Vec<[u32; 2]>>> },
    /// Keyed by source check id — each inner `Vec` is one flagged one-way "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per one-way edge in the group.
    /// `InvalidOneWayIssue` (a single flagged one-way is a group of size one) and
    /// `InvalidOneWayGroupIssue` (a proximity/super-hub/count-excess group of any size) both
    /// resolve into this same shape — mirrors `InvalidTeleport`'s reuse across
    /// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue` — see GitHub issue #205. Mirrors
    /// `IssuePayloadDto::InvalidOneWay`. Kept a distinct variant from `InvalidTeleport` (not
    /// reused) so `payload.kind` still mirrors `IssueKind::as_str()` (`invalid_one_way` vs.
    /// `invalid_teleport`), same rationale as every other variant here.
    InvalidOneWay { groups: HashMap<String, Vec<Vec<[u32; 2]>>> },
    /// Keyed by source check id — each entry is the flat list of maze node ids flagged by that
    /// check (every node of each flagged tile, slot-0 included — see `InvalidSplitTileIssue`'s
    /// doc comment). Flat rather than list-of-lists (unlike `RegionNeedsExpansion`'s per-region
    /// grouping) since the payload has no group/tile structure to preserve — every flagged node
    /// highlights independently. Mirrors `IssuePayloadDto::InvalidSplitTile`.
    InvalidSplitTile { nodes: HashMap<String, Vec<u32>> },
    /// Keyed by source check id — each inner `Vec` is one flagged route: an ordered sequence of
    /// `(from, to, is_split_edge)` triples, one per edge on the path, in traversal order.
    /// `is_split_edge` mirrors `SplitRouteEdge`'s own flag (edge incident to the split tile the
    /// route was found for). Mirrors `IssuePayloadDto::InvalidSplitRoute`.
    InvalidSplitRoute { routes: HashMap<String, Vec<Vec<(u32, u32, bool)>>> },
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

/// `InvalidLoopGroupIssue`-specific variant of `resolve_invalid_loop_payload` — its `invalid`
/// field is already the direct list of flagged cycles (no `all`/index indirection), so there's no
/// index to resolve through.
fn resolve_invalid_loop_group_payload(
    invalid: &[Vec<crate::ids::EdgeId>],
    invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
    graph: &Graph,
) -> Option<IssuePayload> {
    let mut edges: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for loop_edges in invalid {
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

/// Resolves a single flagged teleport `EdgeId` into a one-edge group, keyed by the specific
/// check(s) that flagged *that* edge (`invalid_sources`, not the issue's whole `source_checks`
/// list) — shared by `InvalidTeleportIssue`'s resolve path below. See GitHub issue #195's
/// follow-up: without per-edge attribution, a merged issue combining two checks' flagged edges
/// would highlight every edge on every contributing check's bubble, not just the edges that
/// specific check actually flagged (the bug `InvalidLoopIssue.invalid_sources` already avoids).
fn resolve_invalid_teleport_payload(invalid: &[crate::ids::EdgeId], invalid_sources: &HashMap<crate::ids::EdgeId, Vec<String>>, graph: &Graph) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for &eid in invalid {
        let Some(edge) = graph.edge(eid) else { continue };
        let (Ok(from), Ok(to)) = (u32::try_from(edge.from), u32::try_from(edge.to)) else { continue };
        for source in invalid_sources.get(&eid).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(vec![[from, to]]);
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidTeleport { groups }) }
}

/// Resolves every flagged teleport group's edge set into base-graph edge pairs, keyed by the
/// specific check(s) that flagged *that* group (`invalid_sources`, canonical-group-key-keyed) —
/// shared by `InvalidTeleportGroupIssue`'s resolve path below. Same per-group attribution
/// rationale as `resolve_invalid_one_way_group_payload`; `to_remove` (the group's fix-count)
/// carries no highlight meaning and is dropped here — every edge in the group is highlighted
/// regardless.
fn resolve_invalid_teleport_group_payload(groups: &[(Vec<crate::ids::EdgeId>, u32)], invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>, graph: &Graph) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for (group, _to_remove) in groups {
        let edge_pairs: Vec<[u32; 2]> = group.iter().filter_map(|&eid| {
            let edge = graph.edge(eid)?;
            let from = u32::try_from(edge.from).ok()?;
            let to = u32::try_from(edge.to).ok()?;
            Some([from, to])
        }).collect();
        let mut key = group.clone();
        key.sort_unstable();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(edge_pairs.clone());
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidTeleport { groups: out }) }
}

/// Resolves a single flagged one-way edge into a one-edge group, keyed by the specific check(s)
/// that flagged *that* edge — same per-edge attribution rationale as
/// `resolve_invalid_teleport_payload`, shared by `InvalidOneWayIssue`'s resolve path below.
fn resolve_invalid_one_way_payload(invalid: &[crate::ids::EdgeId], invalid_sources: &HashMap<crate::ids::EdgeId, Vec<String>>, graph: &Graph) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for &eid in invalid {
        let Some(edge) = graph.edge(eid) else { continue };
        let (Ok(from), Ok(to)) = (u32::try_from(edge.from), u32::try_from(edge.to)) else { continue };
        for source in invalid_sources.get(&eid).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(vec![[from, to]]);
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidOneWay { groups }) }
}

/// Resolves every flagged one-way group's edge set into base-graph edge pairs, keyed by the
/// specific check(s) that flagged *that* group (`invalid_sources`, canonical-group-key-keyed) —
/// shared by `InvalidOneWayGroupIssue`'s resolve path below. Same per-group attribution rationale
/// as `resolve_invalid_teleport_group_payload`; `to_remove` (the group's fix-count) carries no
/// highlight meaning and is dropped here — every edge in the group is highlighted regardless.
fn resolve_invalid_one_way_group_payload(groups: &[(Vec<crate::ids::EdgeId>, u32)], invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>, graph: &Graph) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<Vec<[u32; 2]>>> = HashMap::new();
    for (group, _to_remove) in groups {
        let edge_pairs: Vec<[u32; 2]> = group.iter().filter_map(|&eid| {
            let edge = graph.edge(eid)?;
            let from = u32::try_from(edge.from).ok()?;
            let to = u32::try_from(edge.to).ok()?;
            Some([from, to])
        }).collect();
        let mut key = group.clone();
        key.sort_unstable();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(edge_pairs.clone());
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidOneWay { groups: out }) }
}

/// Resolves flagged split tiles' `NodeId`s into a flat per-check list, keyed by the specific
/// check(s) that flagged *that* tile (`invalid_sources`) — mirrors `resolve_invalid_teleport_payload`'s
/// per-element attribution rationale. A tile's several nodes (slot-0 included, GitHub issue #260)
/// all flatten into the same per-check list — the payload has no group/tile structure to
/// preserve, every flagged node highlights independently regardless of which tile it came from,
/// same rationale as `resolve_invalid_split_tile_group_payload`.
fn resolve_invalid_split_tile_payload(invalid: &[SplitTileNodes], invalid_sources: &HashMap<SplitTileNodes, Vec<String>>) -> Option<IssuePayload> {
    let mut nodes: HashMap<String, Vec<u32>> = HashMap::new();
    for tile in invalid {
        for source in invalid_sources.get(tile).into_iter().flatten() {
            let entry = nodes.entry(source.clone()).or_default();
            for &id in &tile.0 {
                if let Ok(id32) = u32::try_from(id) {
                    entry.push(id32);
                }
            }
        }
    }
    if nodes.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { nodes }) }
}

/// Resolves every flagged split-tile group's `NodeId`s into the same flat per-check shape
/// `resolve_invalid_split_tile_payload` uses — reused across `INVALID_SPLIT_TILE`/
/// `INVALID_SPLIT_TILE_GROUP` (mirrors `InvalidOneWay`'s reuse across `invalid_one_way`/
/// `invalid_one_way_group`), since a split-tile flag has no group structure worth preserving in
/// the payload — every flagged node highlights independently regardless of which group it came
/// from. `to_remove` carries no highlight meaning and is dropped here, same rationale as
/// `resolve_invalid_one_way_group_payload`.
fn resolve_invalid_split_tile_group_payload(groups: &[(Vec<SplitTileNodes>, u32)], invalid_sources: &HashMap<Vec<SplitTileNodes>, Vec<String>>) -> Option<IssuePayload> {
    let mut nodes: HashMap<String, Vec<u32>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            let entry = nodes.entry(source.clone()).or_default();
            for tile in group {
                for &id in &tile.0 {
                    if let Ok(id32) = u32::try_from(id) {
                        entry.push(id32);
                    }
                }
            }
        }
    }
    if nodes.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { nodes }) }
}

/// Resolves flagged single split nodes' `NodeId`s into the same flat per-check shape
/// `resolve_invalid_split_tile_payload` uses — reused across `INVALID_SPLIT_TILE`/
/// `INVALID_SPLIT_NODE` (mirrors `InvalidOneWay`'s reuse across `invalid_one_way`/
/// `invalid_one_way_group`), since a single flagged node is just a one-node tile for highlighting
/// purposes — no group/tile structure to preserve either way.
fn resolve_invalid_split_node_payload(invalid: &[NodeId], invalid_sources: &HashMap<NodeId, Vec<String>>) -> Option<IssuePayload> {
    let mut nodes: HashMap<String, Vec<u32>> = HashMap::new();
    for &id in invalid {
        let Ok(id32) = u32::try_from(id) else { continue };
        for source in invalid_sources.get(&id).into_iter().flatten() {
            nodes.entry(source.clone()).or_default().push(id32);
        }
    }
    if nodes.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { nodes }) }
}

/// Resolves every flagged route's edges into `(from, to, is_split_edge)` triples, keyed by the
/// specific check(s) that flagged *that* route (`invalid_sources`, keyed by the route's own exact
/// `SplitRouteEdge` sequence — see `InvalidSplitRouteIssue::merge`'s doc comment for why no
/// canonicalization applies here, unlike every cycle/group payload above).
fn resolve_invalid_split_route_payload(routes: &[Vec<SplitRouteEdge>], invalid_sources: &HashMap<Vec<SplitRouteEdge>, Vec<String>>, graph: &Graph) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<Vec<(u32, u32, bool)>>> = HashMap::new();
    for route in routes {
        let resolved: Vec<(u32, u32, bool)> = route.iter().filter_map(|&(eid, is_split)| {
            let edge = graph.edge(eid)?;
            let from = u32::try_from(edge.from).ok()?;
            let to = u32::try_from(edge.to).ok()?;
            Some((from, to, is_split))
        }).collect();
        for source in invalid_sources.get(route).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(resolved.clone());
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidSplitRoute { routes: out }) }
}

pub fn resolve_issue_payload(issue: &dyn Issue, graph: &Graph, scc: &ConnectedComponents) -> IssuePayload {
    if let Some(InvalidLoopIssue { all, invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopIssue>() {
        if let Some(payload) = resolve_invalid_loop_payload(all, invalid, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidLoopGroupIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopGroupIssue>() {
        if let Some(payload) = resolve_invalid_loop_group_payload(invalid, invalid_sources, graph) {
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

    if let Some(InvalidTeleportIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidTeleportIssue>() {
        if let Some(payload) = resolve_invalid_teleport_payload(invalid, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidTeleportGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidTeleportGroupIssue>() {
        if let Some(payload) = resolve_invalid_teleport_group_payload(groups, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidOneWayIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidOneWayIssue>() {
        if let Some(payload) = resolve_invalid_one_way_payload(invalid, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidOneWayGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidOneWayGroupIssue>() {
        if let Some(payload) = resolve_invalid_one_way_group_payload(groups, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidSplitTileIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitTileIssue>() {
        if let Some(payload) = resolve_invalid_split_tile_payload(invalid, invalid_sources) {
            return payload;
        }
    }

    if let Some(InvalidSplitTileGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitTileGroupIssue>() {
        if let Some(payload) = resolve_invalid_split_tile_group_payload(groups, invalid_sources) {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitNodeIssue>() {
        if let Some(payload) = resolve_invalid_split_node_payload(invalid, invalid_sources) {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeConnectionGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitNodeConnectionGroupIssue>() {
        if let Some(payload) = resolve_invalid_one_way_group_payload(groups, invalid_sources, graph) {
            return payload;
        }
    }

    if let Some(InvalidSplitRouteIssue { routes, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitRouteIssue>() {
        if let Some(payload) = resolve_invalid_split_route_payload(routes, invalid_sources, graph) {
            return payload;
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
        let issue = MissingEndpointsIssue::new_from_check("check", true, true);
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
        let issue = InvalidLoopGroupIssue::new_from_check("max_loop_density", vec![cycle], vec![], invalid_sources);

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

    fn teleport_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::Teleport);
        let e2 = graph.add_edge(2, 3, EdgeKind::Teleport);
        (graph, e1, e2)
    }

    #[test]
    fn invalid_teleport_issue_with_no_flagged_edges_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportIssue::new_from_check("check", vec![]);
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_teleport_issue_resolves_flagged_edge_as_one_element_group() {
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["teleport_duplicates_connection"];
        assert_eq!(check1_groups, &vec![vec![[1, 2]]]);
    }

    #[test]
    fn invalid_teleport_group_issue_with_no_flagged_pairs_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportGroupIssue::new_from_check("check", vec![]);
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_teleport_group_issue_resolves_flagged_pair_as_two_element_group() {
        let (graph, e1, e2) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportGroupIssue::new_from_check("teleport_group_proximity", vec![(vec![e1, e2], 1)]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["teleport_group_proximity"];
        assert_eq!(check1_groups, &vec![vec![[1, 2], [2, 3]]]);
    }

    #[test]
    fn invalid_teleport_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check() {
        // GitHub issue #195's follow-up: teleport_duplicates_connection flags e1,
        // teleport_waypoint_distance flags e2 -- after merge, hovering one check's bubble must
        // highlight only the edge that check actually flagged, not both.
        use crate::quality_control::issue::IssueMerge;
        let (graph, e1, e2) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let mut issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);
        issue.merge(InvalidTeleportIssue::new_from_check("teleport_waypoint_distance", vec![e2]));

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_duplicates_connection"], vec![vec![[1, 2]]], "must not include e2");
        assert_eq!(groups["teleport_waypoint_distance"], vec![vec![[2, 3]]], "must not include e1");
    }

    #[test]
    fn invalid_teleport_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
        // A flagged EdgeId that no longer resolves in `graph` (e.g. removed by a repair mutation
        // between the check running and the payload being resolved) must be dropped, not panic.
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1, stale_id]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_duplicates_connection"], vec![vec![[1, 2]]], "stale edge id must be dropped, not panic");
    }

    #[test]
    fn invalid_teleport_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidTeleportGroupIssue::new_from_check("teleport_group_proximity", vec![(vec![e1, stale_id], 1)]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_group_proximity"], vec![vec![[1, 2]]], "the stale edge id must be dropped, not panic, leaving only the resolvable edge");
    }

    fn one_way_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        (graph, e1, e2)
    }

    #[test]
    fn invalid_one_way_issue_with_no_flagged_edges_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayIssue::new_from_check("check", vec![]);
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_one_way_issue_resolves_flagged_edge_as_one_element_group() {
        let (graph, e1, _) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        assert_eq!(groups["one_way_waypoint_distance"], vec![vec![[1, 2]]]);
    }

    #[test]
    fn invalid_one_way_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
        let (graph, e1, _) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1, stale_id]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups["one_way_waypoint_distance"], vec![vec![[1, 2]]], "stale edge id must be dropped, not panic");
    }

    #[test]
    fn invalid_one_way_group_issue_with_no_flagged_groups_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayGroupIssue::new_from_check("check", vec![]);
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_one_way_group_issue_resolves_flagged_group_edges() {
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayGroupIssue::new_from_check("one_way_group_graph_proximity", vec![(vec![e1, e2], 1)]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let group_edges = &groups["one_way_group_graph_proximity"];
        assert_eq!(group_edges.len(), 1);
        let mut pairs = group_edges[0].clone();
        pairs.sort();
        assert_eq!(pairs, vec![[1, 2], [2, 3]]);
    }

    #[test]
    fn invalid_one_way_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e2 + 1000;
        let issue = InvalidOneWayGroupIssue::new_from_check("one_way_group_graph_proximity", vec![(vec![e1, stale_id], 1)]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups["one_way_group_graph_proximity"], vec![vec![[1, 2]]], "the stale edge id must be dropped, not panic, leaving only the resolvable edge");
    }

    #[test]
    fn invalid_split_route_issue_with_no_flagged_routes_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidSplitRouteIssue::new_from_check("check", vec![]);
        assert_eq!(resolve_issue_payload(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_split_route_issue_resolves_flagged_route_edges_keyed_by_source_check() {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e1 = graph.add_edge(2, 3, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let route: Vec<SplitRouteEdge> = vec![(e0, true), (e1, false)];
        let issue = InvalidSplitRouteIssue::new_from_check("split_node_connection_traversal_distance", vec![route]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        assert_eq!(routes.len(), 1);
        let check_routes = &routes["split_node_connection_traversal_distance"];
        assert_eq!(check_routes, &vec![vec![(1, 2, true), (2, 3, false)]], "edge order and the is_split_edge flag must be preserved exactly, not sorted or dropped");
    }

    #[test]
    fn invalid_split_route_issue_silently_drops_a_stale_edge_id_from_the_middle_of_a_route() {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e0 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e2 + 1000;

        let route: Vec<SplitRouteEdge> = vec![(e0, true), (stale_id, false), (e2, true)];
        let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

        let payload = resolve_issue_payload(&issue, &graph, &scc);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        assert_eq!(routes["check"], vec![vec![(1, 2, true), (2, 3, true)]], "the stale edge id must be dropped, not panic, leaving the two resolvable edges");
    }
}
