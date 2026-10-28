use super::super::issue_kinds::{
    ElevatorNodes, SplitRouteEdge, SplitTileNodes, canonical_cycle_key,
};
use super::super::repair_area::RepairArea;
use super::types::{
    CrossElementPayloadEntry, IssueEdgeGroupPayload, IssueMissingElevatorStopsPayload,
    IssuePayload, IssueRegionPayload, IssueRouteEdge, IssueRoutePayload, IssueSplitGroupPayload,
    IssueSplitTilePayload, all_preset_locked,
};
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::graph::EdgeKind;
use crate::graph::{
    Graph,
    bisect::group_by_unremovable_edges,
    scc::{ComponentId, ConnectedComponents},
};
use crate::ids::{EdgeId, NodeId};
use crate::quality_control::cross_element::CrossElement;
use crate::space::{MultiLevelField, Tessellation};
use std::collections::HashMap;

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
        let edge_pairs: Vec<[u32; 2]> = loop_edges
            .iter()
            .filter_map(|&eid| edge_pair(graph, eid))
            .collect();
        let preset_locked = all_preset_locked(loop_edges, graph, preset_state);
        let key = canonical_cycle_key(loop_edges);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            edges
                .entry(source.clone())
                .or_default()
                .push(IssueEdgeGroupPayload {
                    edges: edge_pairs.clone(),
                    preset_locked,
                });
        }
    }
    if edges.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidLoop { edges })
    }
}

/// Resolves a single flagged edge (teleport or one-way) into a one-edge group, keyed by the
/// specific check(s) that flagged *that* edge (`invalid_sources`, not the issue's whole
/// `source_checks` list) — shared by `InvalidTeleportIssue`/`InvalidOneWayIssue`'s resolve paths
/// below. See GitHub issue #195's follow-up: without per-edge attribution, a merged issue
/// combining two checks' flagged edges would highlight every edge on every contributing check's
/// bubble, not just the edges that specific check actually flagged (the bug
/// `InvalidLoopIssue.invalid_sources` already avoids).
pub(super) fn resolve_single_edge_map(
    invalid: &[crate::ids::EdgeId],
    invalid_sources: &HashMap<crate::ids::EdgeId, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for &eid in invalid {
        let Some(pair) = edge_pair(graph, eid) else {
            continue;
        };
        let preset_locked = all_preset_locked(&[eid], graph, preset_state);
        for source in invalid_sources.get(&eid).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueEdgeGroupPayload {
                    edges: vec![pair],
                    preset_locked,
                });
        }
    }
    groups
}

/// Check ids whose `resolve_edge_group_map` "group" is actually an aggregate excess *batch*
/// (every over-budget teleport/one-way/vertical-passage on the maze or floor, bundled into one
/// group purely so a single repair strategy call can pick which ones to remove) rather than a
/// genuinely interdependent unit. For these, `preset_locked` must be computed per individual edge
/// — see GitHub issue #379's follow-up: reporting the whole batch as one all-or-nothing element
/// severely undercounts "instances set by presets" whenever a batch mixes preset and non-preset
/// edges (only fully-preset batches would ever count). Every other `resolve_edge_group_map`
/// consumer (proximity pairs, super-hub groups, `split_node_connection_per_neighbor`/`_per_face`
/// groups) is a small, semantically interdependent unit where "the whole group is unfixable" is
/// the intended, correct semantics (see `IssuesBlock.tsx`'s doc comment on `dedupTeleportGroups`)
/// — those must keep the original whole-group `all_preset_locked` behavior unchanged. Mirrors
/// `resolve_elevator_group_map`'s already-correct per-element iteration (`max_elevator_count`/
/// `max_elevator_density` never shared this bug, since elevator groups are always batches).
///
/// This list must agree with each check's own `Check::is_batch_edge_group()` (see its doc comment)
/// — a plain string match, not a live trait-method call, because callers here (and
/// `maze-wasm/src/analytics/snapshot.rs`, the more commonly exercised path) only ever have a type
/// id string, never a constructed check instance. `issue_payload::tests` pins every one of these
/// checks' own `is_batch_edge_group()` against this list so the two can't silently drift.
pub(super) fn is_batch_edge_group_type(type_id: &str) -> bool {
    matches!(
        type_id,
        "max_teleport_count"
            | "max_teleport_density"
            | "max_one_way_count"
            | "max_one_way_ratio"
            | "max_vertical_passage_count"
            | "max_vertical_passage_ratio"
    )
}

/// Resolves every flagged edge group (teleport or one-way proximity/super-hub/count-excess) into
/// base-graph edge pairs, keyed by the specific check(s) that flagged *that* group
/// (`invalid_sources`, canonical-group-key-keyed) — shared by `InvalidTeleportGroupIssue`/
/// `InvalidOneWayGroupIssue`/`InvalidSplitNodeConnectionGroupIssue`'s resolve paths below.
/// `to_remove` (the group's fix-count) carries no highlight meaning and is dropped here — every
/// edge in the group is highlighted regardless. For a source whose `check_types`-resolved type id
/// is batch-shaped per `is_batch_edge_group_type`, the group is split into one payload per edge
/// (each with its own `preset_locked`); every other source keeps the original one-payload-per-group
/// whole-group `preset_locked`. `source` here is a check *instance* id (e.g. `"rule_1:0"`), not the
/// type id `is_batch_edge_group_type` expects — `check_types` (`None` in most tests, always `Some`
/// from real rule/analytics callers) resolves instance to type.
pub(super) fn resolve_edge_group_map(
    groups: &[(Vec<crate::ids::EdgeId>, u32)],
    invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
    check_types: Option<&HashMap<String, String>>,
) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
    let mut out: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            let type_id = check_types
                .and_then(|m| m.get(source))
                .map(String::as_str)
                .unwrap_or(source.as_str());
            let is_batch = is_batch_edge_group_type(type_id);
            if is_batch {
                for &eid in group {
                    let Some(pair) = edge_pair(graph, eid) else {
                        continue;
                    };
                    let edge_locked = all_preset_locked(&[eid], graph, preset_state);
                    out.entry(source.clone())
                        .or_default()
                        .push(IssueEdgeGroupPayload {
                            edges: vec![pair],
                            preset_locked: edge_locked,
                        });
                }
            } else {
                let edge_pairs: Vec<[u32; 2]> = group
                    .iter()
                    .filter_map(|&eid| edge_pair(graph, eid))
                    .collect();
                // `preset_locked` ignores `to_remove` — even a group whose fix only requires
                // removing some of its edges is truly unfixable if every edge is
                // preset-protected, since each individual removal attempt refuses regardless of
                // how many total removals were needed.
                let preset_locked = all_preset_locked(group, graph, preset_state);
                out.entry(source.clone())
                    .or_default()
                    .push(IssueEdgeGroupPayload {
                        edges: edge_pairs,
                        preset_locked,
                    });
            }
        }
    }
    out
}

/// Resolves one tile's raw `NodeId` list into its wire-boundary `IssueSplitTilePayload` — pairs
/// the (sorted, `u32`-fittable-only) node ids with whether the whole tile is preset-locked (every
/// node in it is `is_node_locked_for_removal`). Shared by every resolver below that emits tiles.
pub(super) fn tile_payload(nodes: &[NodeId], preset_state: &PresetState) -> IssueSplitTilePayload {
    let ids: Vec<u32> = nodes
        .iter()
        .filter_map(|&id| u32::try_from(id).ok())
        .collect();
    let preset_locked = !ids.is_empty()
        && nodes
            .iter()
            .all(|&id| preset_state.is_node_locked_for_removal(id));
    IssueSplitTilePayload {
        nodes: ids,
        preset_locked,
    }
}

/// Resolves flagged split tiles into one `IssueSplitGroupPayload` (a single tile) per flagged
/// tile, keyed by the specific check(s) that flagged *that* tile (`invalid_sources`) — mirrors
/// `resolve_invalid_teleport_payload`'s per-element attribution rationale.
pub(super) fn resolve_invalid_split_tile_payload(
    invalid: &[SplitTileNodes],
    invalid_sources: &HashMap<SplitTileNodes, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for tile in invalid {
        let payload = tile_payload(&tile.0, preset_state);
        for source in invalid_sources.get(tile).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueSplitGroupPayload {
                    preset_locked: payload.preset_locked,
                    tiles: vec![payload.clone()],
                });
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidSplitTile { groups })
    }
}

/// Resolves every flagged split-tile group into one `IssueSplitGroupPayload` per `groups[i]`
/// entry — preserves the group's own tile membership (a proximity pair's two tiles, or every
/// split tile on the field for a `max_split_count`/`max_split_density` bundle) instead of
/// flattening across groups (GitHub issue #245 review fix: web-side counting needs the real
/// tile/group boundaries to pick the right "how many instances" granularity per check type — see
/// `issueRegistry.ts`). `to_remove` carries no highlight meaning and is dropped here, same
/// rationale as `resolve_invalid_one_way_group_payload`.
pub(super) fn resolve_invalid_split_tile_group_payload(
    groups: &[(Vec<SplitTileNodes>, u32)],
    invalid_sources: &HashMap<Vec<SplitTileNodes>, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let tiles: Vec<IssueSplitTilePayload> = group
            .iter()
            .map(|tile| tile_payload(&tile.0, preset_state))
            .collect();
        let preset_locked = !tiles.is_empty() && tiles.iter().all(|t| t.preset_locked);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone())
                .or_default()
                .push(IssueSplitGroupPayload {
                    tiles: tiles.clone(),
                    preset_locked,
                });
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidSplitTile { groups: out })
    }
}

/// Resolves flagged single split nodes into one `IssueSplitGroupPayload` (a degenerate single
/// 1-node "tile") per flagged node — reused across `INVALID_SPLIT_TILE`/`INVALID_SPLIT_NODE`
/// (mirrors `InvalidOneWay`'s reuse across `invalid_one_way`/`invalid_one_way_group`). A single
/// flagged node has no tile grouping of its own — wrapping it as a 1-node tile keeps the wire
/// shape uniform while still counting one instance per node, which is the correct granularity for
/// this genuinely per-node check (`split_node_connection_count`).
pub(super) fn resolve_invalid_split_node_payload(
    invalid: &[NodeId],
    invalid_sources: &HashMap<NodeId, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for &id in invalid {
        let payload = tile_payload(std::slice::from_ref(&id), preset_state);
        for source in invalid_sources.get(&id).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueSplitGroupPayload {
                    preset_locked: payload.preset_locked,
                    tiles: vec![payload.clone()],
                });
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidSplitTile { groups })
    }
}

/// New `invalid_split_node_group` resolver — reuses the `InvalidSplitTile` wire shape (see that
/// variant's doc comment), one `IssueSplitGroupPayload` per `groups[i]` entry. Each entry is
/// already exactly one overflowing tile's node list (`max_split_tile_node_count`'s own shape), so
/// this wraps it as a single-tile group — group-as-instance and tile-as-instance coincide here.
/// `to_remove` carries no highlight meaning and is dropped, same rationale as
/// `resolve_invalid_one_way_group_payload`/`resolve_invalid_split_tile_group_payload`.
pub(super) fn resolve_invalid_split_node_group_payload(
    groups: &[(Vec<NodeId>, u32)],
    invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueSplitGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let payload = tile_payload(group, preset_state);
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone())
                .or_default()
                .push(IssueSplitGroupPayload {
                    preset_locked: payload.preset_locked,
                    tiles: vec![payload.clone()],
                });
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidSplitTile { groups: out })
    }
}

/// Resolves every flagged route's edges into `(from, to, is_split_edge)` triples, keyed by the
/// specific check(s) that flagged *that* route (`invalid_sources`, keyed by the route's own exact
/// `SplitRouteEdge` sequence — see `InvalidSplitRouteIssue::merge`'s doc comment for why no
/// canonicalization applies here, unlike every cycle/group payload above).
pub(super) fn resolve_invalid_split_route_payload(
    routes: &[Vec<SplitRouteEdge>],
    invalid_sources: &HashMap<Vec<SplitRouteEdge>, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueRoutePayload>> = HashMap::new();
    for route in routes {
        if route.is_empty() {
            continue;
        }
        let edge_ids: Vec<crate::ids::EdgeId> = route.iter().map(|&(eid, _)| eid).collect();
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        let resolved: Vec<IssueRouteEdge> = route
            .iter()
            .filter_map(|&(eid, is_split_edge)| {
                let edge = graph.edge(eid)?;
                let from = u32::try_from(edge.from).ok()?;
                let to = u32::try_from(edge.to).ok()?;
                Some(IssueRouteEdge {
                    from,
                    to,
                    is_split_edge,
                })
            })
            .collect();
        for source in invalid_sources.get(route).into_iter().flatten() {
            out.entry(source.clone())
                .or_default()
                .push(IssueRoutePayload {
                    edges: resolved.clone(),
                    preset_locked,
                });
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidSplitRoute { routes: out })
    }
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
        let Some(region) = scc.components.get(idx) else {
            continue;
        };
        let node_ids: Vec<u32> = region
            .iter()
            .filter_map(|&id| u32::try_from(id).ok())
            .collect();
        let preset_locked = is_locked(idx, region);
        for source in invalid_sources.get(&idx).into_iter().flatten() {
            nodes
                .entry(source.clone())
                .or_default()
                .push(IssueRegionPayload {
                    region: node_ids.clone(),
                    preset_locked,
                });
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
pub(super) fn region_preset_locked_for_shrink(
    graph: &Graph,
    region: &[NodeId],
    preset_state: &PresetState,
) -> bool {
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
            let Some(neighbor_idx) = scc.component_of(neighbor) else {
                continue;
            };
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
pub(super) fn excessive_scc_count_preset_locked<T: Tessellation>(
    field: &MultiLevelField<T>,
    scc: &ConnectedComponents,
    preset_state: &PresetState,
) -> bool {
    !scc.components.is_empty()
        && scc.components.iter().enumerate().all(|(idx, region)| {
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
pub(super) fn elevator_edges(
    elevator: &ElevatorNodes,
    graph: &Graph,
) -> (Vec<[u32; 2]>, Vec<crate::ids::EdgeId>) {
    let mut edges = Vec::new();
    let mut edge_ids = Vec::new();
    for &a in &elevator.0 {
        for &b in &elevator.0 {
            if a >= b {
                continue;
            }
            for (from, to) in [(a, b), (b, a)] {
                if let Some(eid) = graph.edge_between(from, to)
                    && graph
                        .edge(eid)
                        .is_some_and(|e| e.kind == EdgeKind::Elevator)
                    && let Some(pair) = edge_pair(graph, eid)
                {
                    edges.push(pair);
                    edge_ids.push(eid);
                }
            }
        }
    }
    (edges, edge_ids)
}

/// Resolves every flagged elevator's stop-node set into its currently-live fan of
/// `EdgeKind::Elevator` edges, keyed by the specific check(s) that flagged *that* elevator
/// (`invalid_sources`) — mirrors `resolve_invalid_split_tile_payload`'s per-element attribution.
pub(super) fn resolve_invalid_elevator_payload(
    invalid: &[ElevatorNodes],
    invalid_sources: &HashMap<ElevatorNodes, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for elevator in invalid {
        let (edges, edge_ids) = elevator_edges(elevator, graph);
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        for source in invalid_sources.get(elevator).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueEdgeGroupPayload {
                    edges: edges.clone(),
                    preset_locked,
                });
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevator { groups })
    }
}

/// Resolves every flagged elevator group (excess count/density, whole-maze scope — see GitHub
/// issue #398) into one `IssueEdgeGroupPayload` per flagged elevator, keyed by the specific
/// check(s) that flagged *that group* (`invalid_sources`, canonical-group-key-keyed) — mirrors
/// `resolve_edge_group_map`'s per-group attribution, but each payload entry is still one elevator
/// (not the whole group merged into one edge list), since `IssueBubble`'s hover highlight expects
/// one entry per flagged instance the same way `resolve_invalid_elevator_payload` already
/// produces for `INVALID_ELEVATOR`. Reuses the same `IssuePayload::InvalidElevator` wire shape as
/// `INVALID_ELEVATOR` — mirrors `InvalidOneWayGroupIssue` reusing `InvalidOneWay`.
pub(super) fn resolve_elevator_group_map(
    groups: &[(Vec<ElevatorNodes>, u32)],
    invalid_sources: &HashMap<Vec<ElevatorNodes>, Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let sources = invalid_sources.get(&key);
        for elevator in group {
            let (edges, edge_ids) = elevator_edges(elevator, graph);
            let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
            for source in sources.into_iter().flatten() {
                out.entry(source.clone())
                    .or_default()
                    .push(IssueEdgeGroupPayload {
                        edges: edges.clone(),
                        preset_locked,
                    });
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevator { groups: out })
    }
}

/// Resolves flagged single elevator stops into one `IssueRegionPayload` (a single-node "region")
/// per flagged stop, keyed by the specific check(s) that flagged *that* stop (`invalid_sources`)
/// — mirrors `resolve_invalid_split_node_payload`'s per-node attribution. `preset_locked` uses the
/// same node-removal-lock predicate as split nodes (`is_node_locked_for_removal`), since a flagged
/// stop is fixed the same way — removing it from its elevator's edge fan (`RemoveElevatorStopStrategy`).
pub(super) fn resolve_invalid_elevator_stop_payload(
    invalid: &[NodeId],
    invalid_sources: &HashMap<NodeId, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut nodes: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for &id in invalid {
        let Some(id32) = u32::try_from(id).ok() else {
            continue;
        };
        let preset_locked = preset_state.is_node_locked_for_removal(id);
        for source in invalid_sources.get(&id).into_iter().flatten() {
            nodes
                .entry(source.clone())
                .or_default()
                .push(IssueRegionPayload {
                    region: vec![id32],
                    preset_locked,
                });
        }
    }
    if nodes.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevatorStop { nodes })
    }
}

/// Resolves every flagged elevator-stop group (excess count/density — see GitHub issue #399) into
/// one `IssueRegionPayload` per stop in the group, keyed by the specific check(s) that flagged
/// *that group* (`invalid_sources`, canonical-group-key-keyed) — mirrors `resolve_elevator_group_map`'s
/// per-group attribution, but emits one entry per stop (not one entry per whole group) since each
/// stop highlights as its own independent single-node region, unlike a whole elevator's edge fan.
pub(super) fn resolve_elevator_stop_group_map(
    groups: &[(Vec<NodeId>, u32)],
    invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for (group, _to_remove) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        let sources = invalid_sources.get(&key);
        for &id in group {
            let Some(id32) = u32::try_from(id).ok() else {
                continue;
            };
            let preset_locked = preset_state.is_node_locked_for_removal(id);
            for source in sources.into_iter().flatten() {
                out.entry(source.clone())
                    .or_default()
                    .push(IssueRegionPayload {
                        region: vec![id32],
                        preset_locked,
                    });
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevatorStop { nodes: out })
    }
}

/// Resolves a grouped dead-end issue into one highlightable single-node region per dead end.
/// Preset locks do not affect visibility; they only constrain any later repair.
pub(super) fn resolve_dead_end_group_map(
    groups: &[(Vec<NodeId>, u32)],
    invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<IssueRegionPayload>> = HashMap::new();
    for (group, _excess) in groups {
        let mut key = group.clone();
        key.sort_unstable();
        for &id in group {
            let Some(id32) = u32::try_from(id).ok() else {
                continue;
            };
            for source in invalid_sources.get(&key).into_iter().flatten() {
                out.entry(source.clone())
                    .or_default()
                    .push(IssueRegionPayload {
                        region: vec![id32],
                        preset_locked: false,
                    });
            }
        }
    }
    (!out.is_empty()).then_some(IssuePayload::InvalidDeadEnd { nodes: out })
}

/// Resolves a deficit issue's `missing: Vec<(RepairArea, u32)>` (shared shape of
/// `MissingVerticalPassagesIssue`/`MissingTeleportsIssue`/`MissingElevatorsIssue`/
/// `AreaMissingElevatorStopsIssue`) into the `AreaDeficit` wire shape — `RepairArea::Level` becomes
/// `Some(index)` via `levels_ordered()` position (same convention `NodeDto.level` uses), and
/// `RepairArea::WholeMaze` becomes `None` (nothing to highlight). None of these four issue types
/// track which specific check flagged which entry (unlike `InvalidLoopIssue`'s `invalid_sources`),
/// so the full area list is attributed uniformly to every one of `source_checks`. The `u32` count
/// half of each pair carries no highlight meaning and is dropped here.
pub(super) fn resolve_area_deficit_map<T: Tessellation>(
    missing: &[(RepairArea, u32)],
    source_checks: &[String],
    field: &MultiLevelField<T>,
) -> HashMap<String, Vec<Option<u32>>> {
    let mut out: HashMap<String, Vec<Option<u32>>> = HashMap::new();
    if missing.is_empty() || source_checks.is_empty() {
        return out;
    }
    let areas: Vec<Option<u32>> = missing
        .iter()
        .map(|&(area, _count)| match area {
            RepairArea::WholeMaze => None,
            RepairArea::Level(level) => field
                .levels_ordered()
                .position(|l| l == level)
                .and_then(|idx| u32::try_from(idx).ok()),
        })
        .collect();
    for check in source_checks {
        out.insert(check.clone(), areas.clone());
    }
    out
}

/// Resolves every flagged elevator stop-count-deficit entry (GitHub issue #402) into one
/// `IssueMissingElevatorStopsPayload`, keyed by the specific check(s) that flagged *that entry*
/// (`invalid_sources`, keyed by the entry's exact `(ElevatorNodes, u32, Vec<LevelId>)` tuple —
/// mirrors `MissingElevatorStopCountIssue::merge`'s deliberate non-dedup: two checks flagging the
/// same elevator produce two distinct entries, each attributed to its own source). An elevator
/// whose point can no longer be resolved (all stops already removed by an earlier repair pass) is
/// skipped — mirrors `find_elevator_by_stop`'s stale-elevator handling in
/// `AddElevatorStopCountStrategy`.
pub(super) fn resolve_missing_elevator_stop_count_payload<T: Tessellation>(
    missing: &[(ElevatorNodes, u32, Vec<crate::space::LevelId>)],
    invalid_sources: &HashMap<(ElevatorNodes, u32, Vec<crate::space::LevelId>), Vec<String>>,
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueMissingElevatorStopsPayload>> = HashMap::new();
    for entry @ (elevator, count, levels) in missing {
        let Some(point) = elevator.0.first().and_then(|&n| field.cell_of(n)) else {
            continue;
        };
        let (edges, edge_ids) = elevator_edges(elevator, graph);
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        let available: Vec<u32> = levels
            .iter()
            .filter_map(|&level| field.node_at(level, point))
            .filter_map(|node| u32::try_from(node).ok())
            .collect();
        let payload = IssueMissingElevatorStopsPayload {
            edges,
            missing: *count,
            available,
            preset_locked,
        };
        for source in invalid_sources.get(entry).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(payload.clone());
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::MissingElevatorStopCount { groups })
    }
}

/// Resolves every flagged elevator height-deficit entry (GitHub issue #402) into the shared
/// `InvalidElevator` edge-group wire shape — reuses `elevator_edges`/`all_preset_locked` the same
/// way `resolve_invalid_elevator_payload` does. No candidate-floor data: growing the stop interval
/// is `AddElevatorHeightStopStrategy`'s job, so there's nothing to offer as a hover candidate.
pub(super) fn resolve_missing_elevator_height_payload(
    missing: &[(ElevatorNodes, u32)],
    invalid_sources: &HashMap<(ElevatorNodes, u32), Vec<String>>,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for entry @ (elevator, _) in missing {
        let (edges, edge_ids) = elevator_edges(elevator, graph);
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        for source in invalid_sources.get(entry).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueEdgeGroupPayload {
                    edges: edges.clone(),
                    preset_locked,
                });
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevator { groups })
    }
}

/// The canonical-group-key of a cross-element group — sorted, deduped clone, mirroring
/// `group_issue::canonical_group_key` (private there). `InvalidGroupIssue<CrossElementGroupKind>`
/// keys `invalid_sources` by exactly this.
fn cross_element_group_key(group: &[CrossElement]) -> Vec<CrossElement> {
    let mut key = group.to_vec();
    key.sort_unstable();
    key.dedup();
    key
}

/// Both live `EdgeKind::Teleport` directions of the portal `(a, b)`, as base-graph pairs plus raw
/// ids (for `preset_locked`). A one-directional teleport yields a single edge.
fn teleport_portal_edges(graph: &Graph, a: NodeId, b: NodeId) -> (Vec<[u32; 2]>, Vec<EdgeId>) {
    let mut pairs = Vec::new();
    let mut ids = Vec::new();
    for (from, to) in [(a, b), (b, a)] {
        if let Some(eid) = graph.edge_between(from, to)
            && graph
                .edge(eid)
                .is_some_and(|e| e.kind == EdgeKind::Teleport)
            && let Some(pair) = edge_pair(graph, eid)
        {
            pairs.push(pair);
            ids.push(eid);
        }
    }
    (pairs, ids)
}

/// Classifies one logical `CrossElement` into its wire-boundary `CrossElementPayloadEntry` —
/// re-resolving all geometry against the live `graph`/`field` (never trusting an id cached in the
/// element), computing per-element `preset_locked`, and marking `start`/`finish` unremovable.
///
/// `close_nodes` (GitHub issue #376's follow-up points 4/5) is the set of this element's own
/// occurrence nodes that were actually within the proximity threshold. When non-empty it narrows
/// the highlight geometry: a teleport with several endpoints keeps only the edges that
/// touch a close node, a split tile keeps only its close nodes. An empty slice means "no narrowing
/// data, highlight the whole element" — the correct fallback for single-location elements and for
/// tape-decoded payloads with no occurrence info.
fn cross_element_entry<T: Tessellation>(
    element: &CrossElement,
    close_nodes: &[NodeId],
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
) -> CrossElementPayloadEntry {
    let node_u32 = |n: NodeId| u32::try_from(n).ok();
    match element {
        CrossElement::Teleport((a, b)) => {
            let (all_edges, all_ids) = teleport_portal_edges(graph, *a, *b);
            // Both portal directions run between the same two nodes, so an edge-touches-close
            // filter can never separate the near end from the far one (issue #376 follow-up: the
            // bubble was still lighting up both teleport endpoints). When the scan pinned the close
            // occurrence node(s), highlight just those nodes and drop the portal line entirely; the
            // renderer fills the close cell as a region square. With no narrowing info, keep the
            // full portal.
            let close_u32: Vec<u32> = close_nodes.iter().filter_map(|&n| node_u32(n)).collect();
            if !close_u32.is_empty() {
                return CrossElementPayloadEntry {
                    kind: "teleport",
                    edges: vec![],
                    nodes: close_u32,
                    tile: None,
                    removable: true,
                    preset_locked: all_preset_locked(&all_ids, graph, preset_state),
                };
            }
            CrossElementPayloadEntry {
                kind: "teleport",
                edges: all_edges,
                nodes: vec![],
                tile: None,
                removable: true,
                preset_locked: all_preset_locked(&all_ids, graph, preset_state),
            }
        }
        CrossElement::OneWay(id) => {
            let edges: Vec<[u32; 2]> = edge_pair(graph, *id).into_iter().collect();
            CrossElementPayloadEntry {
                kind: "one_way",
                edges,
                nodes: vec![],
                tile: None,
                removable: true,
                preset_locked: all_preset_locked(&[*id], graph, preset_state),
            }
        }
        CrossElement::VerticalPassage(id) => {
            let mut edge_ids = vec![*id];
            if let Some(edge) = graph.edge(*id)
                && edge.kind == EdgeKind::VerticalPassage
                && let Some(rev) = graph.edge_between(edge.to, edge.from)
                && graph
                    .edge(rev)
                    .is_some_and(|e| e.kind == EdgeKind::VerticalPassage)
            {
                edge_ids.push(rev);
            }
            // A vertical passage connects one x-y point across two floors; its two endpoints share
            // that point, so the highlight is a region square either way. When the scan pinned the
            // close endpoint(s), highlight just those nodes; otherwise both endpoints.
            let close_u32: Vec<u32> = close_nodes.iter().filter_map(|&n| node_u32(n)).collect();
            if !close_u32.is_empty() {
                return CrossElementPayloadEntry {
                    kind: "vertical_passage",
                    edges: vec![],
                    nodes: close_u32,
                    tile: None,
                    removable: true,
                    preset_locked: all_preset_locked(&edge_ids, graph, preset_state),
                };
            }
            let edges: Vec<[u32; 2]> = edge_ids
                .iter()
                .filter_map(|&e| edge_pair(graph, e))
                .collect();
            CrossElementPayloadEntry {
                kind: "vertical_passage",
                edges,
                nodes: vec![],
                tile: None,
                removable: true,
                preset_locked: all_preset_locked(&edge_ids, graph, preset_state),
            }
        }
        CrossElement::ElevatorStop(stop) => {
            // The problem element is this one stop, not the whole elevator. Highlight only the stop
            // cell on its own floor (a region square). The fan edges incident to the stop reach the
            // stops on every other floor, so emitting them here would light up cells on all floors;
            // they are only used to compute the preset lock, not the highlight. `close_nodes` cannot
            // narrow further (a stop is a single occurrence), so it is ignored here.
            let stop_u32 = u32::try_from(*stop).ok();
            let ids: Vec<EdgeId> = graph
                .edges()
                .filter(|e| e.kind == EdgeKind::Elevator && (e.from == *stop || e.to == *stop))
                .map(|e| e.id)
                .collect();
            CrossElementPayloadEntry {
                kind: "elevator_stop",
                edges: vec![],
                nodes: stop_u32.into_iter().collect(),
                tile: None,
                removable: true,
                preset_locked: all_preset_locked(&ids, graph, preset_state),
            }
        }
        CrossElement::Split(tile) => {
            // Re-resolve the tile's live node set by whichever cached node still maps to a point.
            let nodes: Vec<NodeId> = tile
                .0
                .iter()
                .find_map(|&anchor| {
                    let level = field.level_of(anchor)?;
                    let point = field.cell_of(anchor)?;
                    let live = field.nodes_at(level, point);
                    (live.len() >= 2).then(|| live.to_vec())
                })
                .unwrap_or_default();
            // Narrow to just the close nodes when the scan pinned them down (all split
            // occurrences share one point, so this is rarely a strict subset — but honor it).
            let narrowed: Vec<NodeId> = if close_nodes.is_empty() {
                nodes.clone()
            } else {
                let kept: Vec<NodeId> = nodes
                    .iter()
                    .copied()
                    .filter(|n| close_nodes.contains(n))
                    .collect();
                if kept.is_empty() { nodes.clone() } else { kept }
            };
            let payload = tile_payload(&narrowed, preset_state);
            CrossElementPayloadEntry {
                kind: "split",
                edges: vec![],
                nodes: vec![],
                tile: Some(payload.clone()),
                removable: true,
                preset_locked: payload.preset_locked,
            }
        }
        CrossElement::Start(node) => CrossElementPayloadEntry {
            kind: "start",
            edges: vec![],
            nodes: node_u32(*node).into_iter().collect(),
            tile: None,
            removable: false,
            // A start pinned by a `preset_start` marker can't be moved by repair, so the whole
            // pair it belongs to is preset-locked (GitHub issue #376 follow-up). A generator-chosen
            // start (farthest endpoints, split reassignment, geometric default) is not.
            preset_locked: preset_state.preset_start == Some(*node),
        },
        CrossElement::Finish(node) => CrossElementPayloadEntry {
            kind: "finish",
            edges: vec![],
            nodes: node_u32(*node).into_iter().collect(),
            tile: None,
            removable: false,
            preset_locked: preset_state.preset_finish == Some(*node),
        },
    }
}

/// Resolves every flagged cross-element proximity group (GitHub issue #376) into a two-entry
/// `Vec<CrossElementPayloadEntry>` per group, keyed by the specific check instance(s) that flagged
/// *that pair* (`invalid_sources`, canonical-group-key-keyed — instances are not merged). Shared
/// by `CrossElementGeometricProximityCheck` / `CrossElementGraphProximityCheck`. `to_remove`
/// (always 1) carries no highlight meaning and is dropped.
pub(super) fn resolve_cross_element_group_payload<T: Tessellation>(
    groups: &[(Vec<CrossElement>, u32)],
    invalid_sources: &HashMap<Vec<CrossElement>, Vec<String>>,
    close_nodes: &HashMap<Vec<CrossElement>, HashMap<CrossElement, Vec<NodeId>>>,
    graph: &Graph,
    field: &MultiLevelField<T>,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut out: HashMap<String, Vec<Vec<CrossElementPayloadEntry>>> = HashMap::new();
    for (group, _to_remove) in groups {
        let key = cross_element_group_key(group);
        let per_element = close_nodes.get(&key);
        let entries: Vec<CrossElementPayloadEntry> = group
            .iter()
            .map(|element| {
                let close = per_element
                    .and_then(|m| m.get(element))
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                cross_element_entry(element, close, graph, field, preset_state)
            })
            .collect();
        for source in invalid_sources.get(&key).into_iter().flatten() {
            out.entry(source.clone()).or_default().push(entries.clone());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidCrossElementGroup { groups: out })
    }
}

/// Resolves every flagged excessive-stop-gap entry (GitHub issue #402) into the shared
/// `InvalidElevator` edge-group wire shape — same rationale as
/// `resolve_missing_elevator_height_payload`: picking the fill-in floor is
/// `AddElevatorStopForGapStrategy`'s job, not something to highlight as a candidate.
pub(super) fn resolve_excessive_elevator_stop_gap_payload(
    missing: &[(ElevatorNodes, crate::space::LevelId, crate::space::LevelId)],
    invalid_sources: &HashMap<
        (ElevatorNodes, crate::space::LevelId, crate::space::LevelId),
        Vec<String>,
    >,
    graph: &Graph,
    preset_state: &PresetState,
) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for entry @ (elevator, _, _) in missing {
        let (edges, edge_ids) = elevator_edges(elevator, graph);
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        for source in invalid_sources.get(entry).into_iter().flatten() {
            groups
                .entry(source.clone())
                .or_default()
                .push(IssueEdgeGroupPayload {
                    edges: edges.clone(),
                    preset_locked,
                });
        }
    }
    if groups.is_empty() {
        None
    } else {
        Some(IssuePayload::InvalidElevator { groups })
    }
}

#[cfg(test)]
mod cross_element_preset_tests {
    use super::*;
    use crate::ids::IdGenerator;
    use crate::space::{SquareTessellation, square_rect};
    use std::sync::Arc;

    fn field() -> MultiLevelField<SquareTessellation> {
        let mut ids = IdGenerator::new();
        MultiLevelField::single_level(Arc::default(), square_rect(2, 1), &mut ids).unwrap()
    }

    #[test]
    fn start_element_is_preset_locked_only_when_a_preset_start_marker_pins_it() {
        let field = field();
        let graph = Graph::new();
        let nodes: Vec<NodeId> = field.all_node_ids().collect();
        let node = nodes[0];

        let mut pinned = PresetState::empty();
        pinned.preset_start = Some(node);
        let entry = cross_element_entry(&CrossElement::Start(node), &[], &graph, &field, &pinned);
        assert_eq!(entry.kind, "start");
        assert!(
            entry.preset_locked,
            "a preset-pinned start must be preset_locked"
        );
        assert!(!entry.removable);

        let free = PresetState::empty();
        let entry = cross_element_entry(&CrossElement::Start(node), &[], &graph, &field, &free);
        assert!(
            !entry.preset_locked,
            "a generator-chosen start must not be preset_locked"
        );
    }

    #[test]
    fn finish_element_preset_lock_tracks_the_preset_finish_marker() {
        let field = field();
        let graph = Graph::new();
        let nodes: Vec<NodeId> = field.all_node_ids().collect();
        let node = nodes[1];

        let mut pinned = PresetState::empty();
        pinned.preset_finish = Some(node);
        assert!(
            cross_element_entry(&CrossElement::Finish(node), &[], &graph, &field, &pinned)
                .preset_locked
        );

        // A `preset_finish` pinning a *different* node leaves this finish movable.
        let mut other = PresetState::empty();
        other.preset_finish = Some(nodes[0]);
        assert!(
            !cross_element_entry(&CrossElement::Finish(node), &[], &graph, &field, &other)
                .preset_locked
        );
    }
}
