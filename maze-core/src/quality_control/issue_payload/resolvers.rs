use std::collections::HashMap;
use crate::ids::NodeId;
use crate::graph::{Graph, bisect::group_by_unremovable_edges, scc::{ConnectedComponents, ComponentId}};
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::space::{MultiLevelField, Tessellation};
use crate::graph::EdgeKind;
use super::super::issue_kinds::{canonical_cycle_key, SplitTileNodes, SplitRouteEdge, ElevatorNodes};
use super::types::{
    all_preset_locked, IssuePayload, IssueEdgeGroupPayload, IssueSplitTilePayload,
    IssueSplitGroupPayload, IssueRouteEdge, IssueRoutePayload, IssueRegionPayload,
};

/// Resolves one `EdgeId` into a base-graph `[from, to]` node-id pair, or `None` if the edge is
/// stale (already removed from `graph`) or either endpoint doesn't fit `u32` — shared by every
/// resolve fn below that turns a flagged edge/cycle/group into wire-shape node-id pairs.
pub(super) fn edge_pair(graph: &Graph, eid: crate::ids::EdgeId) -> Option<[u32; 2]> {
    let edge = graph.edge(eid)?;
    let from = u32::try_from(edge.from).ok()?;
    let to = u32::try_from(edge.to).ok()?;
    Some([from, to])
}

/// Shared payload-building logic for the `all`/`invalid`/`invalid_sources` cycle-set shape common
/// to `InvalidLoopIssue` and `InvalidLoopGroupIssue` — both resolve to the same
/// `IssuePayload::InvalidLoop` wire shape (see that variant's doc comment), just sourced from
/// different `Issue` types. `cycles` yields each flagged cycle's edges — for `InvalidLoopIssue`
/// that's `all[idx]` per `invalid` index, for `InvalidLoopGroupIssue` `invalid` already holds the
/// cycles directly (no index indirection).
pub(super) fn resolve_cycle_payload<'a>(
    cycles: impl Iterator<Item = &'a Vec<crate::ids::EdgeId>>,
    invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut edges: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for loop_edges in cycles {
        let edge_pairs: Vec<[u32; 2]> = loop_edges.iter().filter_map(|&eid| edge_pair(graph, eid)).collect();
        let preset_locked = all_preset_locked(loop_edges, graph, preset_state);
        let key = canonical_cycle_key(loop_edges);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            edges.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: edge_pairs.clone(), preset_locked });
        }
    }
    if edges.is_empty() { None } else { Some(IssuePayload::InvalidLoop { edges }) }
}

/// Resolves a single flagged edge (teleport or one-way) into a one-edge group, keyed by the
/// specific check(s) that flagged *that* edge (`invalid_sources`, not the issue's whole
/// `source_checks` list) — shared by `InvalidTeleportIssue`/`InvalidOneWayIssue`'s resolve paths
/// below. See GitHub issue #195's follow-up: without per-edge attribution, a merged issue
/// combining two checks' flagged edges would highlight every edge on every contributing check's
/// bubble, not just the edges that specific check actually flagged (the bug
/// `InvalidLoopIssue.invalid_sources` already avoids).
pub(super) fn resolve_single_edge_map(invalid: &[crate::ids::EdgeId], invalid_sources: &HashMap<crate::ids::EdgeId, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for &eid in invalid {
        let Some(pair) = edge_pair(graph, eid) else { continue };
        let preset_locked = all_preset_locked(&[eid], graph, preset_state);
        for source in invalid_sources.get(&eid).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: vec![pair], preset_locked });
        }
    }
    groups
}

/// Resolves every flagged edge group (teleport or one-way proximity/super-hub/count-excess) into
/// base-graph edge pairs, keyed by the specific check(s) that flagged *that* group
/// (`invalid_sources`, canonical-group-key-keyed) — shared by `InvalidTeleportGroupIssue`/
/// `InvalidOneWayGroupIssue`/`InvalidSplitNodeConnectionGroupIssue`'s resolve paths below.
/// `to_remove` (the group's fix-count) carries no highlight meaning and is dropped here — every
/// edge in the group is highlighted regardless.
pub(super) fn resolve_edge_group_map(groups: &[(Vec<crate::ids::EdgeId>, u32)], invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
    let mut out: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let edge_pairs: Vec<[u32; 2]> = group.iter().filter_map(|&eid| edge_pair(graph, eid)).collect();
        // `preset_locked` ignores `to_remove` — even a group whose fix only requires removing
        // some of its edges is truly unfixable if every edge is preset-protected, since each
        // individual removal attempt refuses regardless of how many total removals were needed.
        let preset_locked = all_preset_locked(group, graph, preset_state);
        let mut key = group.clone();
        key.sort_unstable();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: edge_pairs.clone(), preset_locked });
        }
    }
    out
}

/// Resolves one tile's raw `NodeId` list into its wire-boundary `IssueSplitTilePayload` — pairs
/// the (sorted, `u32`-fittable-only) node ids with whether the whole tile is preset-locked (every
/// node in it is `is_node_locked_for_removal`). Shared by every resolver below that emits tiles.
pub(super) fn tile_payload(nodes: &[NodeId], preset_state: &PresetState) -> IssueSplitTilePayload {
    let ids: Vec<u32> = nodes.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
    let preset_locked = !ids.is_empty() && nodes.iter().all(|&id| preset_state.is_node_locked_for_removal(id));
    IssueSplitTilePayload { nodes: ids, preset_locked }
}

/// Resolves flagged split tiles into one `IssueSplitGroupPayload` (a single tile) per flagged
/// tile, keyed by the specific check(s) that flagged *that* tile (`invalid_sources`) — mirrors
/// `resolve_invalid_teleport_payload`'s per-element attribution rationale.
pub(super) fn resolve_invalid_split_tile_payload(invalid: &[SplitTileNodes], invalid_sources: &HashMap<SplitTileNodes, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for tile in invalid {
        let payload = tile_payload(&tile.0, preset_state);
        for source in invalid_sources.get(tile).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(IssueSplitGroupPayload { preset_locked: payload.preset_locked, tiles: vec![payload.clone()] });
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { groups }) }
}

/// Resolves every flagged split-tile group into one `IssueSplitGroupPayload` per `groups[i]`
/// entry — preserves the group's own tile membership (a proximity pair's two tiles, or every
/// split tile on the field for a `max_split_count`/`max_split_density` bundle) instead of
/// flattening across groups (GitHub issue #245 review fix: web-side counting needs the real
/// tile/group boundaries to pick the right "how many instances" granularity per check type — see
/// `issueRegistry.ts`). `to_remove` carries no highlight meaning and is dropped here, same
/// rationale as `resolve_invalid_one_way_group_payload`.
pub(super) fn resolve_invalid_split_tile_group_payload(groups: &[(Vec<SplitTileNodes>, u32)], invalid_sources: &HashMap<Vec<SplitTileNodes>, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let tiles: Vec<IssueSplitTilePayload> = group.iter().map(|tile| tile_payload(&tile.0, preset_state)).collect();
        let preset_locked = !tiles.is_empty() && tiles.iter().all(|t| t.preset_locked);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(IssueSplitGroupPayload { tiles: tiles.clone(), preset_locked });
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { groups: out }) }
}

/// Resolves flagged single split nodes into one `IssueSplitGroupPayload` (a degenerate single
/// 1-node "tile") per flagged node — reused across `INVALID_SPLIT_TILE`/`INVALID_SPLIT_NODE`
/// (mirrors `InvalidOneWay`'s reuse across `invalid_one_way`/`invalid_one_way_group`). A single
/// flagged node has no tile grouping of its own — wrapping it as a 1-node tile keeps the wire
/// shape uniform while still counting one instance per node, which is the correct granularity for
/// this genuinely per-node check (`split_node_connection_count`).
pub(super) fn resolve_invalid_split_node_payload(invalid: &[NodeId], invalid_sources: &HashMap<NodeId, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for &id in invalid {
        let payload = tile_payload(std::slice::from_ref(&id), preset_state);
        for source in invalid_sources.get(&id).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(IssueSplitGroupPayload { preset_locked: payload.preset_locked, tiles: vec![payload.clone()] });
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { groups }) }
}

/// New `invalid_split_node_group` resolver — reuses the `InvalidSplitTile` wire shape (see that
/// variant's doc comment), one `IssueSplitGroupPayload` per `groups[i]` entry. Each entry is
/// already exactly one overflowing tile's node list (`max_split_tile_node_count`'s own shape), so
/// this wraps it as a single-tile group — group-as-instance and tile-as-instance coincide here.
/// `to_remove` carries no highlight meaning and is dropped, same rationale as
/// `resolve_invalid_one_way_group_payload`/`resolve_invalid_split_tile_group_payload`.
pub(super) fn resolve_invalid_split_node_group_payload(groups: &[(Vec<NodeId>, u32)], invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let payload = tile_payload(group, preset_state);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(IssueSplitGroupPayload { preset_locked: payload.preset_locked, tiles: vec![payload.clone()] });
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidSplitTile { groups: out }) }
}

/// Resolves every flagged route's edges into `(from, to, is_split_edge)` triples, keyed by the
/// specific check(s) that flagged *that* route (`invalid_sources`, keyed by the route's own exact
/// `SplitRouteEdge` sequence — see `InvalidSplitRouteIssue::merge`'s doc comment for why no
/// canonicalization applies here, unlike every cycle/group payload above).
pub(super) fn resolve_invalid_split_route_payload(routes: &[Vec<SplitRouteEdge>], invalid_sources: &HashMap<Vec<SplitRouteEdge>, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueRoutePayload>> = HashMap::new();
    for route in routes {
        if route.is_empty() {
            continue;
        }
        let edge_ids: Vec<crate::ids::EdgeId> = route.iter().map(|&(eid, _)| eid).collect();
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        let resolved: Vec<IssueRouteEdge> = route.iter().filter_map(|&(eid, is_split_edge)| {
            let edge = graph.edge(eid)?;
            let from = u32::try_from(edge.from).ok()?;
            let to = u32::try_from(edge.to).ok()?;
            Some(IssueRouteEdge { from, to, is_split_edge })
        }).collect();
        for source in invalid_sources.get(route).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(IssueRoutePayload { edges: resolved.clone(), preset_locked });
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidSplitRoute { routes: out }) }
}

/// Resolves flagged SCC regions' `NodeId`s into the shared `nodes: HashMap<String, Vec<IssueRegionPayload>>`
/// shape used by both `RegionNeedsExpansion`/`RegionNeedsShrink` — shared by `resolve_issue_payload`'s
/// two region-issue downcast arms below, which differ only in which `IssuePayload` variant wraps
/// the result and which `is_locked` predicate they pass (the two kinds have genuinely different
/// preset_locked criteria — see `region_preset_locked_for_shrink`/`_for_expansion`).
pub(super) fn resolve_region_map(
    invalid: &[ComponentId],
    invalid_sources: &HashMap<ComponentId, Vec<String>>,
    scc: &ConnectedComponents,
    is_locked: impl Fn(ComponentId, &[NodeId]) -> bool,
) -> HashMap<String, Vec<IssueRegionPayload>> {
    let mut nodes: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for &idx in invalid {
        let Some(region) = scc.components.get(idx) else { continue };
        let node_ids: Vec<u32> = region.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
        let preset_locked = is_locked(idx, region);
        for source in invalid_sources.get(&idx).into_iter().flatten() {
            nodes.entry(source.clone()).or_default().push(IssueRegionPayload { region: node_ids.clone(), preset_locked });
        }
    }
    nodes
}

/// `preset_locked` for `RegionNeedsShrink` (GitHub issue #245): the region cannot be split at all
/// because its only unremovable-edges group spans the whole region — i.e. every possible cut-set
/// consists entirely of preset-protected edges. Mirrors exactly the condition
/// `region_shrink_split::split_region` uses for its own `None`/Failed return (see that function's
/// doc comment) — deliberately not `protect_route`-aware, since "preset_locked" here means
/// "blocked by user-placed presets", not "temporarily protected by the current route".
pub(super) fn region_preset_locked_for_shrink(graph: &Graph, region: &[NodeId], preset_state: &PresetState) -> bool {
    group_by_unremovable_edges(graph, region, |a, b| preset_state.is_preset_edge(a, b)).len() < 2
}

/// `preset_locked` for `RegionNeedsExpansion` (GitHub issue #245): every geometric boundary pair
/// (a region node, a neighbor outside the region, via `Field::neighbors`) is infeasible per
/// `PresetState`. Relies on `bidirectional_edge_feasible`'s infeasibility being entirely
/// preset-sourced: `PresetState`'s `blocked`/`locked_out`/`locked_in` are populated only by
/// `build_preset_state`, so "infeasible" and "blocked by preset" coincide as an invariant of that
/// type today — if `PresetState` ever gains a non-preset infeasibility source, this function must
/// be revisited. A region with no external geometric boundary at all (e.g. it already spans the
/// whole field) is NOT preset_locked — that's a different, non-preset reason repair can't expand
/// it. Teleport-based expansion (`teleport_region_merge`) never goes through `Field::neighbors`,
/// so it's unaffected by this criterion by construction.
pub(super) fn region_preset_locked_for_expansion<T: Tessellation>(
    field: &MultiLevelField<T>,
    region: &[NodeId],
    region_idx: ComponentId,
    scc: &ConnectedComponents,
    preset_state: &PresetState,
) -> bool {
    let mut has_boundary = false;
    for &node in region {
        for neighbor in field.neighbors(node) {
            let Some(neighbor_idx) = scc.component_of(neighbor) else { continue };
            if neighbor_idx == region_idx {
                continue;
            }
            has_boundary = true;
            if bidirectional_edge_feasible(preset_state, node, neighbor) {
                return false;
            }
        }
    }
    has_boundary
}

/// `preset_locked` for `ExcessiveSccCount` (GitHub issue #245's extension): true iff *every*
/// region on the field is `region_preset_locked_for_expansion`-locked — `ReduceSccCountStrategy`
/// can pick any subset of regions to merge (by size priority), so repair is only genuinely stuck
/// when there is nowhere left to merge anything into, anywhere on the field. A field with zero
/// regions (never happens once the check has fired, since firing requires at least 2 components)
/// is vacuously not locked.
pub(super) fn excessive_scc_count_preset_locked<T: Tessellation>(field: &MultiLevelField<T>, scc: &ConnectedComponents, preset_state: &PresetState) -> bool {
    !scc.components.is_empty() && scc.components.iter().enumerate().all(|(idx, region)| {
        region_preset_locked_for_expansion(field, region, idx, scc, preset_state)
    })
}

/// Resolves one elevator's stop-node set into its currently-live fan of `EdgeKind::Elevator`
/// edges, both as base-graph `[from, to]` pairs and as raw `EdgeId`s (for `preset_locked`) —
/// shared by `resolve_invalid_elevator_payload`/`resolve_elevator_group_map`, which differ only in
/// how they key the result into `groups` (per-elevator vs. per-flagged-group). An elevator whose
/// fan has already been fully removed by an earlier repair pass resolves to an empty edge list
/// rather than being skipped, same convention as `edge_pair`'s stale-edge handling elsewhere in
/// this file.
pub(super) fn elevator_edges(elevator: &ElevatorNodes, graph: &Graph) -> (Vec<[u32; 2]>, Vec<crate::ids::EdgeId>) {
    let mut edges = Vec::new();
    let mut edge_ids = Vec::new();
    for &a in &elevator.0 {
        for &b in &elevator.0 {
            if a >= b {
                continue;
            }
            for (from, to) in [(a, b), (b, a)] {
                if let Some(eid) = graph.edge_between(from, to) {
                    if graph.edge(eid).is_some_and(|e| e.kind == EdgeKind::Elevator) {
                        if let Some(pair) = edge_pair(graph, eid) {
                            edges.push(pair);
                            edge_ids.push(eid);
                        }
                    }
                }
            }
        }
    }
    (edges, edge_ids)
}

/// Resolves every flagged elevator's stop-node set into its currently-live fan of
/// `EdgeKind::Elevator` edges, keyed by the specific check(s) that flagged *that* elevator
/// (`invalid_sources`) — mirrors `resolve_invalid_split_tile_payload`'s per-element attribution.
pub(super) fn resolve_invalid_elevator_payload(invalid: &[ElevatorNodes], invalid_sources: &HashMap<ElevatorNodes, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for elevator in invalid {
        let (edges, edge_ids) = elevator_edges(elevator, graph);
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        for source in invalid_sources.get(elevator).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: edges.clone(), preset_locked });
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidElevator { groups }) }
}

/// Resolves every flagged elevator group (excess count/density, whole-maze scope — see GitHub
/// issue #398) into one `IssueEdgeGroupPayload` per flagged elevator, keyed by the specific
/// check(s) that flagged *that group* (`invalid_sources`, canonical-group-key-keyed) — mirrors
/// `resolve_edge_group_map`'s per-group attribution, but each payload entry is still one elevator
/// (not the whole group merged into one edge list), since `IssueBubble`'s hover highlight expects
/// one entry per flagged instance the same way `resolve_invalid_elevator_payload` already
/// produces for `INVALID_ELEVATOR`. Reuses the same `IssuePayload::InvalidElevator` wire shape as
/// `INVALID_ELEVATOR` — mirrors `InvalidOneWayGroupIssue` reusing `InvalidOneWay`.
pub(super) fn resolve_elevator_group_map(groups: &[(Vec<ElevatorNodes>, u32)], invalid_sources: &HashMap<Vec<ElevatorNodes>, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let sources = invalid_sources.get(&key);
        for elevator in group {
            let (edges, edge_ids) = elevator_edges(elevator, graph);
            let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
            for source in sources.into_iter().flatten() {
                out.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: edges.clone(), preset_locked });
            }
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidElevator { groups: out }) }
}

/// Resolves flagged single elevator stops into one `IssueRegionPayload` (a single-node "region")
/// per flagged stop, keyed by the specific check(s) that flagged *that* stop (`invalid_sources`)
/// — mirrors `resolve_invalid_split_node_payload`'s per-node attribution. `preset_locked` uses the
/// same node-removal-lock predicate as split nodes (`is_node_locked_for_removal`), since a flagged
/// stop is fixed the same way — removing it from its elevator's edge fan (`RemoveElevatorStopStrategy`).
pub(super) fn resolve_invalid_elevator_stop_payload(invalid: &[NodeId], invalid_sources: &HashMap<NodeId, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut nodes: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for &id in invalid {
        let Some(id32) = u32::try_from(id).ok() else { continue };
        let preset_locked = preset_state.is_node_locked_for_removal(id);
        for source in invalid_sources.get(&id).into_iter().flatten() {
            nodes.entry(source.clone()).or_default().push(IssueRegionPayload { region: vec![id32], preset_locked });
        }
    }
    if nodes.is_empty() { None } else { Some(IssuePayload::InvalidElevatorStop { nodes }) }
}

/// Resolves every flagged elevator-stop group (excess count/density — see GitHub issue #399) into
/// one `IssueRegionPayload` per stop in the group, keyed by the specific check(s) that flagged
/// *that group* (`invalid_sources`, canonical-group-key-keyed) — mirrors `resolve_elevator_group_map`'s
/// per-group attribution, but emits one entry per stop (not one entry per whole group) since each
/// stop highlights as its own independent single-node region, unlike a whole elevator's edge fan.
pub(super) fn resolve_elevator_stop_group_map(groups: &[(Vec<NodeId>, u32)], invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let sources = invalid_sources.get(&key);
        for &id in group {
            let Some(id32) = u32::try_from(id).ok() else { continue };
            let preset_locked = preset_state.is_node_locked_for_removal(id);
            for source in sources.into_iter().flatten() {
                out.entry(source.clone()).or_default().push(IssueRegionPayload { region: vec![id32], preset_locked });
            }
        }
    }
    if out.is_empty() { None } else { Some(IssuePayload::InvalidElevatorStop { nodes: out }) }
}
