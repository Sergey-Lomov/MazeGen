use std::collections::HashMap;
use crate::ids::NodeId;
use crate::graph::{Graph, bisect::group_by_unremovable_edges, scc::{ConnectedComponents, ComponentId}};
use crate::generation::PresetState;
use crate::generation::edge_ops::bidirectional_edge_feasible;
use crate::space::{MultiLevelField, Tessellation};
use super::issue::Issue;
use crate::graph::EdgeKind;
use super::issue_kinds::{canonical_cycle_key, InvalidLoopIssue, InvalidLoopGroupIssue, RegionNeedsExpansionIssue, RegionNeedsShrinkIssue, InvalidTeleportIssue, InvalidTeleportGroupIssue, InvalidOneWayIssue, InvalidOneWayGroupIssue, InvalidVerticalPassageIssue, InvalidVerticalPassageGroupIssue, InvalidSplitTileIssue, InvalidSplitTileGroupIssue, SplitTileNodes, InvalidSplitNodeIssue, InvalidSplitNodeGroupIssue, InvalidSplitNodeConnectionGroupIssue, InvalidSplitRouteIssue, SplitRouteEdge, ExcessiveSccCountIssue, InvalidElevatorIssue, ElevatorNodes};

/// One flagged edge-group element (a cycle, a one-way/teleport group, or a single flagged edge
/// treated as a size-one group) resolved for the web/tape wire boundary — pairs the group's
/// base-graph edges with whether every one of them is preset-protected (GitHub issue #245).
/// `preset_locked: true` means repair can never fix this specific element (every edge in it is a
/// user-placed Passage/OneWay connection `PresetState.preset_edges` forbids removing) — distinct
/// from the element simply not having been fixed yet. Named struct (not a bare tuple) so the
/// wasm/TS wire shape carries field names instead of positional indices.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueEdgeGroupPayload {
    pub edges: Vec<[u32; 2]>,
    pub preset_locked: bool,
}

/// One tile's own node list inside a flagged split-tile/split-node-group element — pairs the
/// tile's member node ids with whether the WHOLE tile is preset-locked: every node in it would be
/// declined by repair's `RemoveNode`/`ReplacePointNodes` machinery (`PresetState::is_node_locked_for_removal`
/// — the same predicate `remove_node_feasible`/`replace_point_nodes_feasible` use at apply time).
/// An empty tile is vacuously not locked, same convention as `all_preset_locked`'s empty guard.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueSplitTilePayload {
    pub nodes: Vec<u32>,
    pub preset_locked: bool,
}

/// One flagged split-tile "instance" resolved for the wire boundary — a single tile
/// (`InvalidSplitTileIssue`, `InvalidSplitNodeIssue`'s single node treated as a 1-node tile,
/// `InvalidSplitNodeGroupIssue`'s per-tile groups) or a genuine multi-tile group
/// (`InvalidSplitTileGroupIssue`'s proximity pairs / field-wide max-count-or-density bundle).
/// `preset_locked` is true iff every tile in `tiles` is itself preset-locked (GitHub issue #245's
/// split extension). Web-side counting of "how many preset instances" picks its own granularity
/// per check type — some checks (`max_split_count`/`max_split_density`) want one instance per
/// *tile*, others want one instance per *group* — see `issueRegistry.ts`'s `presetLockElementsFor`.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueSplitGroupPayload {
    pub tiles: Vec<IssueSplitTilePayload>,
    pub preset_locked: bool,
}

/// One edge of a flagged split route, in traversal order — `is_split_edge` mirrors the route's own
/// `SplitRouteEdge` flag (edge incident to the split tile the route was found for) and carries no
/// bearing on `IssueRoutePayload::preset_locked`, which depends only on preset protection.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRouteEdge {
    pub from: u32,
    pub to: u32,
    pub is_split_edge: bool,
}

/// One flagged split route resolved for the wire boundary — `preset_locked` is true when every
/// edge on the route is preset-protected (`all_preset_locked`), independent of each edge's own
/// `is_split_edge` flag.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRoutePayload {
    pub edges: Vec<IssueRouteEdge>,
    pub preset_locked: bool,
}

/// One flagged SCC region resolved for the wire boundary — pairs the region's member maze node
/// ids with whether repair can never fix it because of preset configuration (GitHub issue #245's
/// region extension). For `RegionNeedsShrink`, "locked" means the region's only possible cut-set
/// is entirely preset-protected edges. For `RegionNeedsExpansion`, "locked" means every geometric
/// boundary pair (a region node, a neighbor outside the region) is infeasible per `PresetState` —
/// see `region_preset_locked_for_expansion`'s doc comment for the underlying invariant this
/// relies on.
#[derive(Debug, Clone, PartialEq)]
pub struct IssueRegionPayload {
    pub region: Vec<u32>,
    pub preset_locked: bool,
}

/// Whether every edge in `edges` is preset-protected (`PresetState::is_preset_edge`) — an empty
/// list resolves `false`, not vacuously `true` via `Iterator::all`, since an element with no
/// edges can't meaningfully be "locked" by anything.
fn all_preset_locked(edges: &[crate::ids::EdgeId], graph: &Graph, preset_state: &PresetState) -> bool {
    !edges.is_empty() && edges.iter().all(|&eid| {
        graph.edge(eid).is_some_and(|e| preset_state.is_preset_edge(e.from, e.to))
    })
}

/// Structural payload data for an `Issue`, resolved against the current `Graph`/`ConnectedComponents`
/// — one shared source of truth for both `maze-wasm`'s JSON `IssuePayloadDto` (via a thin
/// conversion, `maze-wasm/src/dto.rs`) and the narration-level QC event tape's binary
/// `RuleChecked` payload (`quality_control::event`). Only `InvalidLoopIssue`/
/// `InvalidLoopGroupIssue`/`RegionNeedsExpansionIssue`/`RegionNeedsShrinkIssue`/
/// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue`/`InvalidOneWayIssue`/
/// `InvalidOneWayGroupIssue`/`InvalidVerticalPassageIssue`/`InvalidVerticalPassageGroupIssue`/
/// `InvalidSplitNodeConnectionGroupIssue`/`InvalidSplitTileIssue`/
/// `InvalidSplitTileGroupIssue`/`InvalidSplitNodeIssue`/`InvalidSplitNodeGroupIssue`/
/// `InvalidSplitRouteIssue` carry structural edge/node data today — every other concrete `Issue`
/// type resolves to `None`, same as `build_analytics_snapshot`'s pre-existing behavior.
/// `InvalidLoopGroupIssue` reuses the `InvalidLoop` payload variant (identical shape) rather than
/// getting its own wire tag — `InvalidTeleportGroupIssue` reuses `InvalidTeleport` the same way,
/// and `InvalidOneWayGroupIssue` reuses `InvalidOneWay` the same way (see GitHub issue #205).
#[derive(Debug, Clone, PartialEq, Default)]
pub enum IssuePayload {
    #[default]
    None,
    /// Keyed by source check id — each inner `Vec` is one invalid cycle flagged by that check,
    /// paired with whether every edge in it is preset-protected (GitHub issue #245). Mirrors
    /// `IssuePayloadDto::InvalidLoop`.
    InvalidLoop { edges: HashMap<String, Vec<IssueEdgeGroupPayload>> },
    /// Keyed by source check id — each entry is one flagged SCC region, paired with its own
    /// `preset_locked` status (GitHub issue #245's region extension). Mirrors
    /// `IssuePayloadDto::RegionNeedsExpansion`.
    RegionNeedsExpansion { nodes: HashMap<String, Vec<IssueRegionPayload>> },
    /// Keyed by source check id — same shape as `RegionNeedsExpansion`, but for an oversized
    /// region flagged for shrinking (see GitHub issue #177). Mirrors
    /// `IssuePayloadDto::RegionNeedsShrink`.
    RegionNeedsShrink { nodes: HashMap<String, Vec<IssueRegionPayload>> },
    /// Keyed by source check id — each inner `Vec` is one flagged teleport "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per teleport edge in the group.
    /// `InvalidTeleportIssue` (a single flagged teleport is really a group of size one) and
    /// `InvalidTeleportGroupIssue` (a problematic pair) both resolve into this same shape rather
    /// than getting their own payload variant each — see GitHub issue #195, mirrors
    /// `InvalidLoop`'s reuse across `InvalidLoopIssue`/`InvalidLoopGroupIssue`. Mirrors
    /// `IssuePayloadDto::InvalidTeleport`.
    InvalidTeleport { groups: HashMap<String, Vec<IssueEdgeGroupPayload>> },
    /// Keyed by source check id — each inner `Vec` is one flagged one-way "group", expressed as
    /// base-graph `[from, to]` maze node-id pairs, one pair per one-way edge in the group.
    /// `InvalidOneWayIssue` (a single flagged one-way is a group of size one) and
    /// `InvalidOneWayGroupIssue` (a proximity/super-hub/count-excess group of any size) both
    /// resolve into this same shape — mirrors `InvalidTeleport`'s reuse across
    /// `InvalidTeleportIssue`/`InvalidTeleportGroupIssue` — see GitHub issue #205. Mirrors
    /// `IssuePayloadDto::InvalidOneWay`. Kept a distinct variant from `InvalidTeleport` (not
    /// reused) so `payload.kind` still mirrors `IssueKind::as_str()` (`invalid_one_way` vs.
    /// `invalid_teleport`), same rationale as every other variant here.
    InvalidOneWay { groups: HashMap<String, Vec<IssueEdgeGroupPayload>> },
    /// Keyed by source check id — each inner `Vec` is one flagged vertical-passage "group",
    /// expressed as base-graph `[from, to]` maze node-id pairs, one pair per `VerticalPassage`
    /// edge in the group. `InvalidVerticalPassageIssue` (a single flagged edge is a group of size
    /// one) and `InvalidVerticalPassageGroupIssue` (a proximity pair) both resolve into this same
    /// shape — mirrors `InvalidTeleport`'s reuse across `InvalidTeleportIssue`/
    /// `InvalidTeleportGroupIssue` — see GitHub issue #395. Mirrors
    /// `IssuePayloadDto::InvalidVerticalPassage`. Kept a distinct variant from `InvalidTeleport`
    /// (not reused) so `payload.kind` still mirrors `IssueKind::as_str()`.
    InvalidVerticalPassage { groups: HashMap<String, Vec<IssueEdgeGroupPayload>> },
    /// Keyed by source check id — each entry is one flagged "instance" (a single tile, or a
    /// genuine multi-tile group for proximity/count/density checks — see `IssueSplitGroupPayload`'s
    /// doc comment), each paired with its own `preset_locked` flag (GitHub issue #245's split-node
    /// extension). Shared wire variant for `invalid_split_tile`/`invalid_split_tile_group`/
    /// `invalid_split_node`/`invalid_split_node_group` — `source_checks`/`payload.kind` plus the
    /// check's own `type_id` is the only way to tell which check produced a given element, same
    /// contract as `InvalidSplitNodeConnectionGroupIssue`'s reuse of `InvalidOneWay` below. Mirrors
    /// `IssuePayloadDto::InvalidSplitTile`.
    InvalidSplitTile { groups: HashMap<String, Vec<IssueSplitGroupPayload>> },
    /// Keyed by source check id — each inner `Vec` is one flagged route, paired with its own
    /// `preset_locked` flag. Mirrors `IssuePayloadDto::InvalidSplitRoute`.
    InvalidSplitRoute { routes: HashMap<String, Vec<IssueRoutePayload>> },
    /// Keyed by source check id — whether repair can never reduce the SCC count at all because
    /// every single region on the field is preset-locked against expansion (GitHub issue #245's
    /// extension to `ExcessiveSccCountIssue`, which carries no specific region list of its own —
    /// `ReduceSccCountStrategy` picks its merge targets fresh from live component sizes, not from
    /// data on the issue). No per-element highlight data, unlike every variant above — this issue
    /// never highlights specific regions on the canvas. Mirrors `IssuePayloadDto::ExcessiveSccCount`.
    ExcessiveSccCount { preset_locked: HashMap<String, bool> },
    /// Keyed by source check id — each inner `Vec` is one flagged elevator, expressed as base-graph
    /// `[from, to]` pairs, one pair per `EdgeKind::Elevator` edge currently connecting its stops
    /// (re-resolved against `graph` at payload time, since `ElevatorNodes` names the elevator by its
    /// stop-node set, not by saved edge ids — see GitHub issue #397, mirrors `RemoveElevatorStrategy`'s
    /// own re-resolution). Mirrors `IssuePayloadDto::InvalidElevator`.
    InvalidElevator { groups: HashMap<String, Vec<IssueEdgeGroupPayload>> },
}

/// Resolves `issue`'s structural payload against `graph`/`scc` — extracted from
/// `maze-wasm/src/analytics.rs`'s `build_analytics_snapshot` (GitHub issue #147) so the same
/// downcast/resolve logic backs both the JSON analytics report and the binary QC event tape,
/// instead of two independently-maintained copies.
/// Resolves one `EdgeId` into a base-graph `[from, to]` node-id pair, or `None` if the edge is
/// stale (already removed from `graph`) or either endpoint doesn't fit `u32` — shared by every
/// resolve fn below that turns a flagged edge/cycle/group into wire-shape node-id pairs.
fn edge_pair(graph: &Graph, eid: crate::ids::EdgeId) -> Option<[u32; 2]> {
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
fn resolve_cycle_payload<'a>(
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
fn resolve_single_edge_map(invalid: &[crate::ids::EdgeId], invalid_sources: &HashMap<crate::ids::EdgeId, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
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
fn resolve_edge_group_map(groups: &[(Vec<crate::ids::EdgeId>, u32)], invalid_sources: &HashMap<Vec<crate::ids::EdgeId>, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> HashMap<String, Vec<IssueEdgeGroupPayload>> {
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
fn tile_payload(nodes: &[NodeId], preset_state: &PresetState) -> IssueSplitTilePayload {
    let ids: Vec<u32> = nodes.iter().filter_map(|&id| u32::try_from(id).ok()).collect();
    let preset_locked = !ids.is_empty() && nodes.iter().all(|&id| preset_state.is_node_locked_for_removal(id));
    IssueSplitTilePayload { nodes: ids, preset_locked }
}

/// Resolves flagged split tiles into one `IssueSplitGroupPayload` (a single tile) per flagged
/// tile, keyed by the specific check(s) that flagged *that* tile (`invalid_sources`) — mirrors
/// `resolve_invalid_teleport_payload`'s per-element attribution rationale.
fn resolve_invalid_split_tile_payload(invalid: &[SplitTileNodes], invalid_sources: &HashMap<SplitTileNodes, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
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
fn resolve_invalid_split_tile_group_payload(groups: &[(Vec<SplitTileNodes>, u32)], invalid_sources: &HashMap<Vec<SplitTileNodes>, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
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
fn resolve_invalid_split_node_payload(invalid: &[NodeId], invalid_sources: &HashMap<NodeId, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
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
fn resolve_invalid_split_node_group_payload(groups: &[(Vec<NodeId>, u32)], invalid_sources: &HashMap<Vec<NodeId>, Vec<String>>, preset_state: &PresetState) -> Option<IssuePayload> {
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
fn resolve_invalid_split_route_payload(routes: &[Vec<SplitRouteEdge>], invalid_sources: &HashMap<Vec<SplitRouteEdge>, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> Option<IssuePayload> {
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
fn resolve_region_map(
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
fn region_preset_locked_for_shrink(graph: &Graph, region: &[NodeId], preset_state: &PresetState) -> bool {
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
fn region_preset_locked_for_expansion<T: Tessellation>(
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
fn excessive_scc_count_preset_locked<T: Tessellation>(field: &MultiLevelField<T>, scc: &ConnectedComponents, preset_state: &PresetState) -> bool {
    !scc.components.is_empty() && scc.components.iter().enumerate().all(|(idx, region)| {
        region_preset_locked_for_expansion(field, region, idx, scc, preset_state)
    })
}

/// Resolves every flagged elevator's stop-node set into its currently-live fan of
/// `EdgeKind::Elevator` edges, keyed by the specific check(s) that flagged *that* elevator
/// (`invalid_sources`) — mirrors `resolve_invalid_split_tile_payload`'s per-element attribution.
/// An elevator whose fan has already been fully removed by an earlier repair pass resolves to an
/// empty edge list rather than being skipped, same convention as `edge_pair`'s stale-edge handling
/// elsewhere in this file.
fn resolve_invalid_elevator_payload(invalid: &[ElevatorNodes], invalid_sources: &HashMap<ElevatorNodes, Vec<String>>, graph: &Graph, preset_state: &PresetState) -> Option<IssuePayload> {
    let mut groups: HashMap<String, Vec<IssueEdgeGroupPayload>> = HashMap::new();
    for elevator in invalid {
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
        let preset_locked = all_preset_locked(&edge_ids, graph, preset_state);
        for source in invalid_sources.get(elevator).into_iter().flatten() {
            groups.entry(source.clone()).or_default().push(IssueEdgeGroupPayload { edges: edges.clone(), preset_locked });
        }
    }
    if groups.is_empty() { None } else { Some(IssuePayload::InvalidElevator { groups }) }
}

pub fn resolve_issue_payload<T: Tessellation>(issue: &dyn Issue, graph: &Graph, field: &MultiLevelField<T>, scc: &ConnectedComponents, preset_state: &PresetState) -> IssuePayload {
    if let Some(InvalidLoopIssue { all, invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopIssue>() {
        let cycles = invalid.iter().filter_map(|&idx| all.get(idx));
        if let Some(payload) = resolve_cycle_payload(cycles, invalid_sources, graph, preset_state) {
            return payload;
        }
    }

    if let Some(InvalidLoopGroupIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidLoopGroupIssue>() {
        if let Some(payload) = resolve_cycle_payload(invalid.iter(), invalid_sources, graph, preset_state) {
            return payload;
        }
    }

    if let Some(RegionNeedsExpansionIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<RegionNeedsExpansionIssue>() {
        let nodes = resolve_region_map(invalid, invalid_sources, scc,
            |idx, region| region_preset_locked_for_expansion(field, region, idx, scc, preset_state));
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsExpansion { nodes };
        }
    }

    if let Some(RegionNeedsShrinkIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<RegionNeedsShrinkIssue>() {
        let nodes = resolve_region_map(invalid, invalid_sources, scc,
            |_, region| region_preset_locked_for_shrink(graph, region, preset_state));
        if !nodes.is_empty() {
            return IssuePayload::RegionNeedsShrink { nodes };
        }
    }

    if let Some(InvalidTeleportIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidTeleportIssue>() {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidTeleport { groups };
        }
    }

    if let Some(InvalidTeleportGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidTeleportGroupIssue>() {
        let groups = resolve_edge_group_map(groups, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidTeleport { groups };
        }
    }

    if let Some(InvalidOneWayIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidOneWayIssue>() {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidOneWayGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidOneWayGroupIssue>() {
        let groups = resolve_edge_group_map(groups, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidVerticalPassageIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidVerticalPassageIssue>() {
        let groups = resolve_single_edge_map(invalid, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidVerticalPassage { groups };
        }
    }

    if let Some(InvalidVerticalPassageGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidVerticalPassageGroupIssue>() {
        let groups = resolve_edge_group_map(groups, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidVerticalPassage { groups };
        }
    }

    if let Some(InvalidSplitTileIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitTileIssue>() {
        if let Some(payload) = resolve_invalid_split_tile_payload(invalid, invalid_sources, preset_state) {
            return payload;
        }
    }

    if let Some(InvalidSplitTileGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitTileGroupIssue>() {
        if let Some(payload) = resolve_invalid_split_tile_group_payload(groups, invalid_sources, preset_state) {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitNodeIssue>() {
        if let Some(payload) = resolve_invalid_split_node_payload(invalid, invalid_sources, preset_state) {
            return payload;
        }
    }

    if let Some(InvalidSplitNodeGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitNodeGroupIssue>() {
        if let Some(payload) = resolve_invalid_split_node_group_payload(groups, invalid_sources, preset_state) {
            return payload;
        }
    }

    // `InvalidSplitNodeConnectionGroupIssue` reuses the `InvalidOneWay` payload variant (identical
    // shape: a group of edges) rather than getting its own wire tag, same rationale as
    // `InvalidLoopGroupIssue`→`InvalidLoop`/`InvalidTeleportGroupIssue`→`InvalidTeleport` above —
    // the web side already narrows on `payload.kind === "invalid_one_way"` for this reused kind,
    // not on `issue.kind` (which stays `"invalid_split_node_connection_group"`).
    if let Some(InvalidSplitNodeConnectionGroupIssue { groups, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitNodeConnectionGroupIssue>() {
        let groups = resolve_edge_group_map(groups, invalid_sources, graph, preset_state);
        if !groups.is_empty() {
            return IssuePayload::InvalidOneWay { groups };
        }
    }

    if let Some(InvalidSplitRouteIssue { routes, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidSplitRouteIssue>() {
        if let Some(payload) = resolve_invalid_split_route_payload(routes, invalid_sources, graph, preset_state) {
            return payload;
        }
    }

    if let Some(issue) = issue.as_any().downcast_ref::<ExcessiveSccCountIssue>() {
        let locked = excessive_scc_count_preset_locked(field, scc, preset_state);
        let preset_locked = issue.source_checks().iter().map(|s| (s.clone(), locked)).collect();
        return IssuePayload::ExcessiveSccCount { preset_locked };
    }

    if let Some(InvalidElevatorIssue { invalid, invalid_sources, .. }) = issue.as_any().downcast_ref::<InvalidElevatorIssue>() {
        if let Some(payload) = resolve_invalid_elevator_payload(invalid, invalid_sources, graph, preset_state) {
            return payload;
        }
    }

    IssuePayload::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::space::{SquareTessellation, square_rect};
    use crate::ids::IdGenerator;

    fn empty_graph_and_scc() -> (Graph, ConnectedComponents) {
        let graph = Graph::new();
        let scc = ConnectedComponents { components: Vec::new(), node_component: HashMap::new() };
        (graph, scc)
    }

    /// A `Field` big enough for every hand-built test graph's node ids to be meaningless within it
    /// (tests that don't exercise `RegionNeedsExpansion` never call `Field::neighbors` on ids
    /// outside it, so an arbitrary small field is a safe stand-in) — only region-expansion tests
    /// build a field whose points actually correspond to their graph's nodes.
    fn dummy_field() -> MultiLevelField<SquareTessellation> {
        let mut ids = IdGenerator::new();
        MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap()
    }

    fn resolve(issue: &dyn Issue, graph: &Graph, scc: &ConnectedComponents) -> IssuePayload {
        resolve_issue_payload(issue, graph, &dummy_field(), scc, &PresetState::empty())
    }

    #[test]
    fn missing_endpoints_issue_resolves_to_none() {
        use crate::quality_control::MissingEndpointsIssue;
        let (graph, scc) = empty_graph_and_scc();
        let issue = MissingEndpointsIssue::new_from_check("check", true, true);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_issue_with_no_flagged_cycles_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidLoopIssue::new_from_check("check", vec![], vec![], HashMap::new());
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_loop_group_issue_with_no_flagged_cycles_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidLoopGroupIssue::new_from_check("check", vec![], vec![], HashMap::new());
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert_eq!(edges.len(), 1);
        let check1_cycles = &edges["max_loop_density"];
        assert_eq!(check1_cycles.len(), 1);
        let mut pairs = check1_cycles[0].edges.clone();
        pairs.sort();
        assert_eq!(pairs, vec![[1, 2], [2, 3], [3, 1]]);
        assert!(!check1_cycles[0].preset_locked, "no preset state given -- must not be locked");
    }

    #[test]
    fn region_needs_expansion_issue_with_no_flagged_regions_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = RegionNeedsExpansionIssue::new_from_check("check", vec![], HashMap::new());
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert_eq!(edges.len(), 1);
        let check1_cycles = &edges["check1"];
        assert_eq!(check1_cycles.len(), 1);
        let mut pairs = check1_cycles[0].edges.clone();
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

        let IssuePayload::InvalidLoop { edges } = resolve(&issue, &graph, &scc) else { panic!("expected InvalidLoop") };
        assert_eq!(edges.len(), 2);
        assert!(edges.contains_key("check1"));
        assert!(edges.contains_key("check2"));
    }

    #[test]
    fn invalid_loop_issue_marks_cycle_preset_locked_when_every_edge_is_preset_protected() {
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

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        preset_state.preset_edges.insert((2, 3));
        preset_state.preset_edges.insert((3, 1));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert!(edges["check1"][0].preset_locked, "every edge in the cycle is preset-protected");
    }

    #[test]
    fn invalid_loop_issue_not_preset_locked_when_only_part_of_the_cycle_is_protected() {
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

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        preset_state.preset_edges.insert((2, 3));
        // (3, 1) intentionally left unprotected.

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        assert!(!edges["check1"][0].preset_locked, "one unprotected edge is enough to keep the whole cycle fixable");
    }

    #[test]
    fn invalid_loop_issue_reports_preset_locked_per_element_not_per_issue() {
        // One issue, two flagged cycles -- one fully preset-locked, the other not. Both elements
        // must appear in the resolved payload with their own independent flag (GitHub issue #245:
        // granularity is per-element, not a single bool for the whole issue).
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        graph.add_node(4);
        graph.add_node(5);
        graph.add_node(6);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        let e3 = graph.add_edge(3, 1, EdgeKind::Basic);
        let e4 = graph.add_edge(4, 5, EdgeKind::Basic);
        let e5 = graph.add_edge(5, 6, EdgeKind::Basic);
        let e6 = graph.add_edge(6, 4, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let locked_cycle = vec![e1, e2, e3];
        let unlocked_cycle = vec![e4, e5, e6];
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(canonical_cycle_key(&locked_cycle), vec!["check1".to_string()]);
        invalid_sources.insert(canonical_cycle_key(&unlocked_cycle), vec!["check1".to_string()]);
        let issue = InvalidLoopIssue::new_from_check("check1", vec![locked_cycle, unlocked_cycle], vec![0, 1], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        preset_state.preset_edges.insert((2, 3));
        preset_state.preset_edges.insert((3, 1));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidLoop { edges } = payload else { panic!("expected InvalidLoop, got {payload:?}") };
        let elements = &edges["check1"];
        assert_eq!(elements.len(), 2);
        let locked_count = elements.iter().filter(|e| e.preset_locked).count();
        assert_eq!(locked_count, 1, "exactly one of the two cycles must be preset_locked");
    }

    #[test]
    fn resolve_edge_group_map_treats_empty_group_as_not_preset_locked() {
        // `Iterator::all` on an empty iterator is vacuously true -- `all_preset_locked` must guard
        // against that explicitly, since an element with zero edges can't meaningfully be "locked".
        let (graph, _) = empty_graph_and_scc();
        let preset_state = PresetState::empty();
        assert!(!all_preset_locked(&[], &graph, &preset_state));
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert_eq!(nodes.len(), 1);
        let check1_regions = &nodes["check1"];
        assert_eq!(check1_regions.len(), 1);
        let mut region = check1_regions[0].region.clone();
        region.sort();
        assert_eq!(region, vec![1, 2, 3]);
        assert!(!check1_regions[0].preset_locked, "no preset state given -- must not be locked");
    }

    #[test]
    fn region_needs_shrink_issue_with_no_flagged_regions_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = RegionNeedsShrinkIssue::new_from_check("check", vec![], HashMap::new());
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::RegionNeedsShrink { nodes } = payload else { panic!("expected RegionNeedsShrink, got {payload:?}") };
        assert_eq!(nodes.len(), 1);
        let check1_regions = &nodes["check1"];
        assert_eq!(check1_regions.len(), 1);
        let mut region = check1_regions[0].region.clone();
        region.sort();
        assert_eq!(region, vec![1, 2, 3]);
        assert!(!check1_regions[0].preset_locked, "no preset edges anywhere -- must not be locked (empty region has no edges to group)");
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
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_teleport_issue_resolves_flagged_edge_as_one_element_group() {
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["teleport_duplicates_connection"];
        assert_eq!(check1_groups.len(), 1);
        assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
    }

    #[test]
    fn invalid_teleport_group_issue_with_no_flagged_pairs_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportGroupIssue::new_from_check("check", vec![]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_teleport_group_issue_resolves_flagged_pair_as_two_element_group() {
        let (graph, e1, e2) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidTeleportGroupIssue::new_from_check("teleport_group_proximity", vec![(vec![e1, e2], 1)]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["teleport_group_proximity"];
        assert_eq!(check1_groups.len(), 1);
        assert_eq!(check1_groups[0].edges, vec![[1, 2], [2, 3]]);
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_duplicates_connection"][0].edges, vec![[1, 2]], "must not include e2");
        assert_eq!(groups["teleport_waypoint_distance"][0].edges, vec![[2, 3]], "must not include e1");
    }

    #[test]
    fn invalid_teleport_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
        // A flagged EdgeId that no longer resolves in `graph` (e.g. removed by a repair mutation
        // between the check running and the payload being resolved) must be dropped, not panic.
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidTeleportIssue::new_from_check("teleport_duplicates_connection", vec![e1, stale_id]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_duplicates_connection"][0].edges, vec![[1, 2]], "stale edge id must be dropped, not panic");
    }

    #[test]
    fn invalid_teleport_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
        let (graph, e1, _) = teleport_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidTeleportGroupIssue::new_from_check("teleport_group_proximity", vec![(vec![e1, stale_id], 1)]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidTeleport { groups } = payload else { panic!("expected InvalidTeleport, got {payload:?}") };
        assert_eq!(groups["teleport_group_proximity"][0].edges, vec![[1, 2]], "the stale edge id must be dropped, not panic, leaving only the resolvable edge");
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
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_one_way_issue_resolves_flagged_edge_as_one_element_group() {
        let (graph, e1, _) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        assert_eq!(groups["one_way_waypoint_distance"][0].edges, vec![[1, 2]]);
    }

    #[test]
    fn invalid_one_way_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
        let (graph, e1, _) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1, stale_id]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups["one_way_waypoint_distance"][0].edges, vec![[1, 2]], "stale edge id must be dropped, not panic");
    }

    #[test]
    fn invalid_one_way_issue_preset_locked_only_when_forward_direction_is_the_actual_preset_direction() {
        // GitHub issue #245: a one-way preset only ever occupies one direction (`preset_edges`
        // stores the exact directed pair, `blocked` covers the reverse) -- the resolver must not
        // treat the flagged forward edge as locked when the "protection" it's checking against is
        // actually the reverse direction's `blocked` entry, not a `preset_edges` membership.
        let (graph, e1, _) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayIssue::new_from_check("one_way_waypoint_distance", vec![e1]);

        // Only the reverse direction is "protected" (as `blocked`, mirroring a real OneWayForward
        // preset's own bookkeeping) -- the forward edge itself (1 -> 2) is not in `preset_edges`.
        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((2, 1));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert!(!groups["one_way_waypoint_distance"][0].preset_locked, "reverse-direction blocked must not count as this edge being preset-protected");

        // Now actually protect the flagged direction -- must become locked.
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert!(groups["one_way_waypoint_distance"][0].preset_locked, "the actual preset direction must be reported locked");
    }

    #[test]
    fn invalid_one_way_group_issue_with_no_flagged_groups_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayGroupIssue::new_from_check("check", vec![]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_one_way_group_issue_resolves_flagged_group_edges() {
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayGroupIssue::new_from_check("one_way_group_graph_proximity", vec![(vec![e1, e2], 1)]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let group_edges = &groups["one_way_group_graph_proximity"];
        assert_eq!(group_edges.len(), 1);
        let mut pairs = group_edges[0].edges.clone();
        pairs.sort();
        assert_eq!(pairs, vec![[1, 2], [2, 3]]);
    }

    #[test]
    fn invalid_one_way_group_issue_silently_skips_a_group_with_a_stale_edge_id() {
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e2 + 1000;
        let issue = InvalidOneWayGroupIssue::new_from_check("one_way_group_graph_proximity", vec![(vec![e1, stale_id], 1)]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert_eq!(groups["one_way_group_graph_proximity"][0].edges, vec![[1, 2]], "the stale edge id must be dropped, not panic, leaving only the resolvable edge");
    }

    #[test]
    fn invalid_one_way_group_issue_preset_locked_ignores_to_remove_count() {
        // GitHub issue #245: confirmed with the user -- `preset_locked` for a partial-fix group
        // (`to_remove < group size`) still means "every edge in the group is preset-protected",
        // ignoring `to_remove`. Every individual removal attempt refuses on a preset edge
        // regardless of how many total removals were needed, so a fully-protected group is truly
        // unfixable even though its nominal fix only demanded removing one of its two edges.
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidOneWayGroupIssue::new_from_check("one_way_group_graph_proximity", vec![(vec![e1, e2], 1)]);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        preset_state.preset_edges.insert((2, 3));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay, got {payload:?}") };
        assert!(groups["one_way_group_graph_proximity"][0].preset_locked, "to_remove=1 must not exempt the group from being fully locked when both edges are protected");
    }

    #[test]
    fn invalid_split_node_connection_group_issue_carries_preset_locked_through_the_invalid_one_way_reuse() {
        // GitHub issue #245: `InvalidSplitNodeConnectionGroupIssue` reuses the `InvalidOneWay`
        // wire variant (see `resolve_issue_payload`'s doc comment on that arm) -- confirms the
        // preset_locked migration wasn't silently dropped for this reused kind.
        use crate::quality_control::issue_kinds::InvalidSplitNodeConnectionGroupIssue;
        let (graph, e1, e2) = one_way_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidSplitNodeConnectionGroupIssue::new_from_check("split_node_connection_per_neighbor", vec![(vec![e1, e2], 1)]);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));
        preset_state.preset_edges.insert((2, 3));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidOneWay { groups } = payload else { panic!("expected InvalidOneWay (reused wire shape), got {payload:?}") };
        assert!(groups["split_node_connection_per_neighbor"][0].preset_locked);
    }

    #[test]
    fn invalid_split_route_issue_with_no_flagged_routes_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidSplitRouteIssue::new_from_check("check", vec![]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        assert_eq!(routes.len(), 1);
        let check_routes = &routes["split_node_connection_traversal_distance"];
        assert_eq!(check_routes.len(), 1);
        assert_eq!(
            check_routes[0].edges,
            vec![
                IssueRouteEdge { from: 1, to: 2, is_split_edge: true },
                IssueRouteEdge { from: 2, to: 3, is_split_edge: false },
            ],
            "edge order and the is_split_edge flag must be preserved exactly, not sorted or dropped"
        );
        assert!(!check_routes[0].preset_locked, "no preset state given -- must not be locked");
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

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        assert_eq!(routes["check"].len(), 1);
        assert_eq!(
            routes["check"][0].edges,
            vec![
                IssueRouteEdge { from: 1, to: 2, is_split_edge: true },
                IssueRouteEdge { from: 2, to: 3, is_split_edge: true },
            ],
            "the stale edge id must be dropped, not panic, leaving the two resolvable edges"
        );
    }

    // --- Split node/route preset_locked support (extends GitHub issue #245 to node/route-based
    // split issue kinds: invalid_split_node, invalid_split_node_group, invalid_split_route,
    // invalid_split_tile, invalid_split_tile_group) ---

    fn split_node_graph() -> (Graph, NodeId, NodeId) {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_edge(1, 2, EdgeKind::Basic);
        (graph, 1, 2)
    }

    #[test]
    fn invalid_split_node_issue_marks_node_preset_locked_via_is_node_locked_for_removal() {
        let (graph, split_node, _other) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

        // `preset_locked` now mirrors `remove_node_feasible`'s own predicate (GitHub issue #245's
        // review fix) -- a preset edge touching the node blocks removal regardless of whether the
        // node is also `preset_declared` (minted by a preset `split_points` entry).
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile (reused shape), got {payload:?}") };
        let entry = &groups["split_node_connection_count"][0];
        assert!(entry.preset_locked);
        assert_eq!(entry.tiles.len(), 1, "a single flagged node wraps as its own 1-tile group");
        assert!(entry.tiles[0].preset_locked);
    }

    #[test]
    fn invalid_split_node_issue_not_preset_locked_when_no_incident_edge_is_preset_protected() {
        let (graph, split_node, _other) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidSplitNodeIssue::new_from_check("split_node_connection_count", vec![split_node]);

        // No preset edge touches the node, and it isn't locked_out/locked_in either -- repair can
        // freely remove it.
        let preset_state = PresetState::empty();

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile (reused shape), got {payload:?}") };
        assert!(!groups["split_node_connection_count"][0].preset_locked);
    }

    #[test]
    fn invalid_split_node_group_issue_resolves_via_the_new_arm_and_carries_preset_locked() {
        // `InvalidSplitNodeGroupIssue` previously had no resolve arm at all -- confirms it now
        // resolves (reusing the `InvalidSplitTile` wire shape) and carries `preset_locked`. Its
        // `groups[i]` is already exactly one overflowing tile's node list, so this resolves to one
        // single-tile group per entry (GitHub issue #245's review fix: group-as-instance and
        // tile-as-instance coincide here, unlike the multi-tile proximity case below).
        let (graph, split_node, other) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidSplitNodeGroupIssue::new_from_check("split_tile_node_count", vec![(vec![split_node, other], 1)]);

        // Only the (1, 2) direction is preset-protected -- both endpoints of that directed edge
        // are touched by `preset_edges`, so the whole tile is locked.
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile (reused shape), got {payload:?}") };
        let entries = &groups["split_tile_node_count"];
        assert_eq!(entries.len(), 1, "one group entry -- the check's whole node list is one overflowing tile");
        assert!(entries[0].preset_locked, "both nodes of the tile are locked for removal");
        assert_eq!(entries[0].tiles.len(), 1);
        let mut tile_nodes = entries[0].tiles[0].nodes.clone();
        tile_nodes.sort_unstable();
        assert_eq!(tile_nodes, vec![split_node as u32, other as u32]);
    }

    #[test]
    fn invalid_split_tile_issue_locks_the_whole_tile_when_a_non_declared_base_node_has_a_preset_edge() {
        // Regression: a split tile's base node (never `preset_declared` -- only `add_node_at`-
        // minted nodes are) still blocks the whole tile's `remove_split` collapse if its own edge
        // is preset-protected (`replace_point_nodes_feasible` checks every node at the point, base
        // included). `preset_locked` must reflect that, not `is_preset_locked_node`'s
        // declared-only criterion.
        let (graph, base, _other) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let tile = SplitTileNodes::new(vec![base]);
        let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2)); // touches `base` (id 1), never declared

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile, got {payload:?}") };
        assert!(groups["split_distance_from_waypoint"][0].preset_locked);
    }

    #[test]
    fn invalid_split_tile_issue_not_preset_locked_when_no_node_is_removal_locked() {
        let (graph, base, _other) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let tile = SplitTileNodes::new(vec![base]);
        let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile]);

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &PresetState::empty());
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile, got {payload:?}") };
        assert!(!groups["split_distance_from_waypoint"][0].preset_locked);
    }

    #[test]
    fn invalid_split_tile_issue_resolves_one_group_per_flagged_tile_each_a_single_tile() {
        // Two independently-flagged tiles must resolve as two separate single-tile
        // `IssueSplitGroupPayload` entries, not merged into one.
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        graph.add_node(4);
        let (_, scc) = empty_graph_and_scc();
        let tile_a = SplitTileNodes::new(vec![1, 2]);
        let tile_b = SplitTileNodes::new(vec![3, 4]);
        let issue = InvalidSplitTileIssue::new_from_check("split_distance_from_waypoint", vec![tile_a, tile_b]);

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &PresetState::empty());
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile, got {payload:?}") };
        let entries = &groups["split_distance_from_waypoint"];
        assert_eq!(entries.len(), 2, "each flagged tile resolves as its own group entry");
        assert!(entries.iter().all(|e| e.tiles.len() == 1));
    }

    #[test]
    fn invalid_split_tile_group_issue_preserves_a_multi_tile_group_and_locks_only_when_every_tile_is_locked() {
        // A proximity pair's group must resolve as ONE entry carrying BOTH tiles (not flattened
        // into 2 separate entries) -- GitHub issue #245's review fix: web-side needs the real group
        // boundary to count "1 instance" for a pair, not "2 instances" (one per node/tile).
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        graph.add_node(4);
        graph.add_edge(1, 3, crate::graph::EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();
        let tile_a = SplitTileNodes::new(vec![1, 2]);
        let tile_b = SplitTileNodes::new(vec![3, 4]);
        let issue = InvalidSplitTileGroupIssue::new_from_check("split_group_geometric_proximity", vec![(vec![tile_a.clone(), tile_b.clone()], 1)]);

        // Only node 1 is preset-locked (touches a preset edge) -- tile_a is NOT fully locked (node
        // 2 isn't), so the whole group must not be locked either, even though it contains a locked
        // node.
        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 3));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile, got {payload:?}") };
        let entries = &groups["split_group_geometric_proximity"];
        assert_eq!(entries.len(), 1, "the pair resolves as one group entry, not two");
        assert_eq!(entries[0].tiles.len(), 2, "both tiles of the pair are preserved in the group");
        assert!(!entries[0].preset_locked, "tile_a has an unlocked node, so the group as a whole is not locked");
    }

    #[test]
    fn invalid_split_tile_group_issue_locks_the_group_when_every_tile_is_fully_locked() {
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_edge(1, 2, crate::graph::EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();
        let tile_a = SplitTileNodes::new(vec![1]);
        let tile_b = SplitTileNodes::new(vec![2]);
        let issue = InvalidSplitTileGroupIssue::new_from_check("split_group_geometric_proximity", vec![(vec![tile_a, tile_b], 1)]);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((1, 2));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitTile { groups } = payload else { panic!("expected InvalidSplitTile, got {payload:?}") };
        assert!(groups["split_group_geometric_proximity"][0].preset_locked);
    }

    #[test]
    fn invalid_split_route_issue_preset_locked_when_every_route_edge_is_protected() {
        let (graph, a, b) = split_node_graph();
        let (_, scc) = empty_graph_and_scc();
        let eid = graph.edge_between(a, b).unwrap();
        let route: Vec<SplitRouteEdge> = vec![(eid, true)];
        let issue = InvalidSplitRouteIssue::new_from_check("split_node_connection_traversal_distance", vec![route]);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        assert!(routes["split_node_connection_traversal_distance"][0].preset_locked);
    }

    #[test]
    fn invalid_split_route_issue_preset_locked_is_independent_of_is_split_edge() {
        // GitHub issue #245's split-route extension: `is_split_edge` is purely a render flag and
        // must not influence `preset_locked` -- an edge flagged `is_split_edge: true` that is NOT
        // preset-protected, mixed with other protected edges, must still resolve `preset_locked`
        // to false for the whole route, and `is_split_edge` must survive unmodified in the output.
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::Basic);
        let e2 = graph.add_edge(2, 3, EdgeKind::Basic);
        let (_, scc) = empty_graph_and_scc();

        let route: Vec<SplitRouteEdge> = vec![(e1, true), (e2, false)];
        let issue = InvalidSplitRouteIssue::new_from_check("check", vec![route]);

        let mut preset_state = PresetState::empty();
        // Only e2 (1,2)->(2,3) is protected; e1 (is_split_edge: true) is not.
        preset_state.preset_edges.insert((2, 3));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::InvalidSplitRoute { routes } = payload else { panic!("expected InvalidSplitRoute, got {payload:?}") };
        let resolved = &routes["check"][0];
        assert!(!resolved.preset_locked, "one unprotected edge is enough to keep the whole route fixable");
        assert_eq!(
            resolved.edges,
            vec![
                IssueRouteEdge { from: 1, to: 2, is_split_edge: true },
                IssueRouteEdge { from: 2, to: 3, is_split_edge: false },
            ],
            "is_split_edge must be preserved as-is, independent of preset protection"
        );
    }

    #[test]
    fn invalid_split_route_issue_empty_route_is_not_preset_locked_and_is_skipped() {
        // Explicit vacuous-truth guard, same rationale as `resolve_edge_group_map_treats_empty_group_as_not_preset_locked`.
        let (graph, scc) = empty_graph_and_scc();
        let empty_route: Vec<SplitRouteEdge> = vec![];
        let issue = InvalidSplitRouteIssue::new_from_check("check", vec![empty_route]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None, "an empty route carries nothing to resolve or highlight");
    }

    // --- Region preset_locked support (extends GitHub issue #245 to region-based issue kinds:
    // region_needs_expansion, region_needs_shrink) ---

    fn region_scc(region: Vec<NodeId>) -> ConnectedComponents {
        let node_component = region.iter().map(|&id| (id, 0)).collect();
        ConnectedComponents { components: vec![region], node_component }
    }

    /// Like `region_scc`, but also registers `external` nodes in a second component — a real SCC
    /// maps every graph node to *some* component, and `region_preset_locked_for_expansion` skips
    /// any neighbor missing from `node_component` entirely (treats it as "outside the graph"), so
    /// expansion tests need their boundary neighbor actually registered, not just the region itself.
    fn region_scc_with_external(region: Vec<NodeId>, external: &[NodeId]) -> ConnectedComponents {
        let mut node_component: HashMap<NodeId, ComponentId> = region.iter().map(|&id| (id, 0)).collect();
        for &id in external {
            node_component.insert(id, 1);
        }
        ConnectedComponents { components: vec![region, external.to_vec()], node_component }
    }

    fn triangle_graph() -> (Graph, [NodeId; 3]) {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        graph.add_edge(1, 2, EdgeKind::Basic);
        graph.add_edge(2, 1, EdgeKind::Basic);
        graph.add_edge(2, 3, EdgeKind::Basic);
        graph.add_edge(3, 2, EdgeKind::Basic);
        graph.add_edge(3, 1, EdgeKind::Basic);
        graph.add_edge(1, 3, EdgeKind::Basic);
        (graph, [1, 2, 3])
    }

    #[test]
    fn region_needs_shrink_locked_when_the_only_cut_set_is_entirely_preset_protected() {
        // Every edge preset-protected -> group_by_unremovable_edges collapses the whole region into
        // one group (len < 2) -- mirrors region_shrink_split::split_region's own None/Failed signal.
        let (graph, [a, b, c]) = triangle_graph();
        let scc = region_scc(vec![a, b, c]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        for &(x, y) in &[(a, b), (b, a), (b, c), (c, b), (c, a), (a, c)] {
            preset_state.preset_edges.insert((x, y));
        }

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::RegionNeedsShrink { nodes } = payload else { panic!("expected RegionNeedsShrink, got {payload:?}") };
        assert!(nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_shrink_not_locked_when_a_one_directional_preset_pair_leaves_the_reverse_cuttable() {
        // `(A,B)` preset-protected, but `(B,A)` (the same physical passage's reverse direction) is
        // NOT -- `is_preset_edge` is directed-only, so `group_by_unremovable_edges` (which walks
        // `graph.outgoing_neighbors` and calls the predicate in that exact direction) must still see
        // this edge as removable via its un-protected direction, keeping the region splittable.
        let (graph, [a, b, c]) = triangle_graph();
        let scc = region_scc(vec![a, b, c]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));
        // (b, a), (b, c)/(c, b), (c, a)/(a, c) intentionally left unprotected.

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::RegionNeedsShrink { nodes } = payload else { panic!("expected RegionNeedsShrink, got {payload:?}") };
        assert!(!nodes["check1"][0].preset_locked, "the unprotected (b,a) direction keeps a cut available");
    }

    #[test]
    fn region_needs_shrink_not_locked_when_a_cut_through_a_non_preset_edge_exists() {
        // Only one of the triangle's three passages is preset-protected -- group_by_unremovable_edges
        // still finds >= 2 groups (the other two passages are cuttable), so the region is NOT locked.
        let (graph, [a, b, c]) = triangle_graph();
        let scc = region_scc(vec![a, b, c]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsShrinkIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.preset_edges.insert((a, b));
        preset_state.preset_edges.insert((b, a));

        let payload = resolve_issue_payload(&issue, &graph, &dummy_field(), &scc, &preset_state);
        let IssuePayload::RegionNeedsShrink { nodes } = payload else { panic!("expected RegionNeedsShrink, got {payload:?}") };
        assert!(!nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_shrink_criterion_matches_split_region_s_own_none_condition() {
        // Regression: `region_preset_locked_for_shrink`'s `groups.len() < 2` must stay identical to
        // `region_shrink_split::split_region`'s own None/Failed condition -- both evaluated on the
        // same graph/region/preset_state here and compared directly.
        use crate::space::{MultiLevelField, SquareTessellation, square_rect};
        use crate::Maze;
        let (graph, [a, b, c]) = triangle_graph();
        let region = vec![a, b, c];

        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let maze = Maze::new(field, graph.clone());

        let mut preset_state = PresetState::empty();
        for &(x, y) in &[(a, b), (b, a), (b, c), (c, b), (c, a), (a, c)] {
            preset_state.preset_edges.insert((x, y));
        }

        let resolver_locked = region_preset_locked_for_shrink(&graph, &region, &preset_state);
        let split_region_failed = crate::repair::strategies::region_shrink_split::split_region(&maze, &region, &preset_state, false).is_none();
        assert_eq!(resolver_locked, split_region_failed, "resolver's preset_locked must agree with split_region's None/Failed signal");
        assert!(resolver_locked, "sanity: this fixture is fully preset-protected");
    }

    /// 2x1 field: two adjacent points, each with one node -- the region is just node `a`, its only
    /// geometric neighbor is `b` (outside the region). Used by every expansion test below.
    fn two_point_field_and_region() -> (MultiLevelField<crate::space::SquareTessellation>, Graph, NodeId, NodeId) {
        use crate::space::{MultiLevelField, SquareTessellation, square_rect};
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(2, 1), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        let level = field.single_level_id();
        let a = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(level, crate::space::SquarePoint { x: 1, y: 0 }).unwrap();
        (field, graph, a, b)
    }

    #[test]
    fn region_needs_expansion_not_locked_when_region_has_no_external_geometric_boundary() {
        // A region spanning the whole field has no neighbor outside itself -- has_boundary stays
        // false, so it must NOT be reported preset_locked (a different, non-preset problem).
        use crate::space::{MultiLevelField, SquareTessellation, square_rect};
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(1, 1), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        let level = field.single_level_id();
        let a = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let scc = region_scc(vec![a]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty());
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert!(!nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_expansion_not_locked_when_at_least_one_boundary_is_free() {
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        // No preset at all -- the boundary to b is free.
        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty());
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert!(!nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_expansion_locked_when_every_boundary_is_wall_blocked() {
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((a, b));
        preset_state.blocked.insert((b, a));

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state);
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert!(nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_expansion_locked_when_every_boundary_is_locked_out_or_in_not_wall() {
        // Confirms the criterion is `PresetState` as a whole, not just `blocked`/Wall.
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(a);
        preset_state.locked_in.insert(a);

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state);
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert!(nodes["check1"][0].preset_locked);
    }

    #[test]
    fn region_needs_expansion_locked_via_asymmetric_locked_out_in_across_both_directions() {
        // `locked_out` on the region side, `locked_in` on the external side (different directions,
        // different nodes) -- confirms `bidirectional_edge_feasible`'s symmetry: both fwd_blocked
        // and bwd_blocked are evaluated regardless of which side each lock sits on.
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let mut invalid_sources = HashMap::new();
        invalid_sources.insert(0usize, vec!["check1".to_string()]);
        let issue = RegionNeedsExpansionIssue::new_from_check("check1", vec![0], invalid_sources);

        let mut preset_state = PresetState::empty();
        preset_state.locked_out.insert(a);
        preset_state.locked_in.insert(b);

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state);
        let IssuePayload::RegionNeedsExpansion { nodes } = payload else { panic!("expected RegionNeedsExpansion, got {payload:?}") };
        assert!(nodes["check1"][0].preset_locked);
    }

    fn excessive_scc_count_issue(check: &str, max_scc_count: u32) -> ExcessiveSccCountIssue {
        ExcessiveSccCountIssue::new_from_check(check, max_scc_count)
    }

    #[test]
    fn excessive_scc_count_not_locked_with_no_preset_state() {
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let issue = excessive_scc_count_issue("check1", 1);

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &PresetState::empty());
        let IssuePayload::ExcessiveSccCount { preset_locked } = payload else { panic!("expected ExcessiveSccCount, got {payload:?}") };
        assert!(!preset_locked["check1"]);
    }

    #[test]
    fn excessive_scc_count_not_locked_when_only_one_region_is_preset_locked() {
        // Both regions must be locked for the whole issue to be locked -- `ReduceSccCountStrategy`
        // can pick either region as a merge target, so one free region is enough to unstick repair.
        // 3x1 field, one node per point: three separate regions a/b/c in a row. Only the a<->b
        // boundary is blocked -- b's other boundary (to c) stays free, so b (and c) remain unlocked
        // even though a is fully locked.
        use crate::space::{MultiLevelField, SquareTessellation, square_rect};
        let mut ids = IdGenerator::new();
        let field: MultiLevelField<SquareTessellation> = MultiLevelField::single_level(square_rect(3, 1), &mut ids).unwrap();
        let mut graph = Graph::new();
        for node in field.all_node_ids() { graph.add_node(node); }
        let level = field.single_level_id();
        let a = field.node_at(level, crate::space::SquarePoint { x: 0, y: 0 }).unwrap();
        let b = field.node_at(level, crate::space::SquarePoint { x: 1, y: 0 }).unwrap();
        let c = field.node_at(level, crate::space::SquarePoint { x: 2, y: 0 }).unwrap();
        let node_component = HashMap::from([(a, 0), (b, 1), (c, 2)]);
        let scc = ConnectedComponents { components: vec![vec![a], vec![b], vec![c]], node_component };
        let issue = excessive_scc_count_issue("check1", 1);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((a, b));
        preset_state.blocked.insert((b, a));

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state);
        let IssuePayload::ExcessiveSccCount { preset_locked } = payload else { panic!("expected ExcessiveSccCount, got {payload:?}") };
        assert!(!preset_locked["check1"]);
    }

    #[test]
    fn excessive_scc_count_locked_when_every_region_is_preset_locked() {
        let (field, graph, a, b) = two_point_field_and_region();
        let scc = region_scc_with_external(vec![a], &[b]);
        let issue = excessive_scc_count_issue("check1", 1);

        let mut preset_state = PresetState::empty();
        preset_state.blocked.insert((a, b));
        preset_state.blocked.insert((b, a));
        // `field.neighbors(b)` also sees `a` as its only neighbor, and it's blocked both ways too,
        // so `b`'s region is equally locked -- both of the field's two regions are stuck.

        let payload = resolve_issue_payload(&issue, &graph, &field, &scc, &preset_state);
        let IssuePayload::ExcessiveSccCount { preset_locked } = payload else { panic!("expected ExcessiveSccCount, got {payload:?}") };
        assert!(preset_locked["check1"]);
    }

    fn vertical_passage_graph() -> (Graph, crate::ids::EdgeId, crate::ids::EdgeId) {
        use crate::graph::EdgeKind;
        let mut graph = Graph::new();
        graph.add_node(1);
        graph.add_node(2);
        graph.add_node(3);
        let e1 = graph.add_edge(1, 2, EdgeKind::VerticalPassage);
        let e2 = graph.add_edge(2, 3, EdgeKind::VerticalPassage);
        (graph, e1, e2)
    }

    #[test]
    fn invalid_vertical_passage_issue_with_no_flagged_edges_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidVerticalPassageIssue::new_from_check("check", vec![]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_vertical_passage_issue_resolves_flagged_edge_as_one_element_group() {
        let (graph, e1, _) = vertical_passage_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidVerticalPassageIssue::new_from_check("vertical_passage_group_geometric_proximity", vec![e1]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidVerticalPassage { groups } = payload else { panic!("expected InvalidVerticalPassage, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["vertical_passage_group_geometric_proximity"];
        assert_eq!(check1_groups.len(), 1);
        assert_eq!(check1_groups[0].edges, vec![[1, 2]]);
    }

    #[test]
    fn invalid_vertical_passage_group_issue_with_no_flagged_pairs_resolves_to_none() {
        let (graph, scc) = empty_graph_and_scc();
        let issue = InvalidVerticalPassageGroupIssue::new_from_check("check", vec![]);
        assert_eq!(resolve(&issue, &graph, &scc), IssuePayload::None);
    }

    #[test]
    fn invalid_vertical_passage_group_issue_resolves_flagged_pair_as_two_element_group() {
        let (graph, e1, e2) = vertical_passage_graph();
        let (_, scc) = empty_graph_and_scc();
        let issue = InvalidVerticalPassageGroupIssue::new_from_check("vertical_passage_group_graph_proximity", vec![(vec![e1, e2], 1)]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidVerticalPassage { groups } = payload else { panic!("expected InvalidVerticalPassage, got {payload:?}") };
        assert_eq!(groups.len(), 1);
        let check1_groups = &groups["vertical_passage_group_graph_proximity"];
        assert_eq!(check1_groups.len(), 1);
        assert_eq!(check1_groups[0].edges, vec![[1, 2], [2, 3]]);
    }

    #[test]
    fn invalid_vertical_passage_issue_merged_from_two_checks_attributes_each_edge_to_only_its_own_check() {
        use crate::quality_control::issue::IssueMerge;
        let (graph, e1, e2) = vertical_passage_graph();
        let (_, scc) = empty_graph_and_scc();
        let mut issue = InvalidVerticalPassageIssue::new_from_check("vertical_passage_group_geometric_proximity", vec![e1]);
        issue.merge(InvalidVerticalPassageIssue::new_from_check("vertical_passage_group_graph_proximity", vec![e2]));

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidVerticalPassage { groups } = payload else { panic!("expected InvalidVerticalPassage, got {payload:?}") };
        assert_eq!(groups["vertical_passage_group_geometric_proximity"][0].edges, vec![[1, 2]], "must not include e2");
        assert_eq!(groups["vertical_passage_group_graph_proximity"][0].edges, vec![[2, 3]], "must not include e1");
    }

    #[test]
    fn invalid_vertical_passage_issue_silently_skips_a_stale_edge_id_absent_from_the_graph() {
        let (graph, e1, _) = vertical_passage_graph();
        let (_, scc) = empty_graph_and_scc();
        let stale_id = e1 + 1000;
        let issue = InvalidVerticalPassageIssue::new_from_check("vertical_passage_group_geometric_proximity", vec![e1, stale_id]);

        let payload = resolve(&issue, &graph, &scc);
        let IssuePayload::InvalidVerticalPassage { groups } = payload else { panic!("expected InvalidVerticalPassage, got {payload:?}") };
        assert_eq!(groups["vertical_passage_group_geometric_proximity"][0].edges, vec![[1, 2]], "stale edge id must be dropped, not panic");
    }
}
