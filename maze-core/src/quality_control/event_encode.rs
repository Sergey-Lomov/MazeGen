use crate::ids::NodeId;
use crate::graph::EdgeKind;
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::quality_control::issue::IssueKind;
use crate::quality_control::issue_kinds::RepairLimitKind;
use crate::quality_control::issue_payload::{IssuePayload, IssueEdgeGroupPayload, IssueSplitTilePayload, IssueSplitGroupPayload, IssueRoutePayload, IssueRegionPayload};

/// Binary wire-encoding helpers for `QcEvent`'s custom-codec fields (`qc_wire.rs`'s
/// `use super::write_*` imports these) — split out of `event.rs` (GitHub issue #147's
/// instrumentation) so the enum's own narration-level doc comments aren't interleaved with this
/// serialization concern.
fn write_node_id(out: &mut Vec<u8>, id: NodeId) {
    out.extend_from_slice(&id.to_le_bytes());
}

/// Encodes `PointNodesReplaceProposed`/`PointNodesReplaced`/`PointNodesReplaceDeclined`'s shared
/// `nodes` field —
/// one sibling's edge list per entry, each edge as one byte for `direction` (0=Forward,
/// 1=Backward, 2=Passage), one byte for `kind` (0=Basic, 1=Teleport — issue #281), followed by
/// the `target` node.
pub(crate) fn write_split_nodes(out: &mut Vec<u8>, nodes: &[Vec<SplitNodeEdge>]) {
    out.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    for edges in nodes {
        out.extend_from_slice(&(edges.len() as u32).to_le_bytes());
        for edge in edges {
            out.push(match edge.direction {
                SplitNodeEdgeDirection::Forward => 0,
                SplitNodeEdgeDirection::Backward => 1,
                SplitNodeEdgeDirection::Passage => 2,
            });
            out.push(match edge.kind {
                EdgeKind::Basic => 0,
                EdgeKind::Teleport => 1,
                EdgeKind::VerticalPassage => 2,
                EdgeKind::Elevator => 3,
            });
            write_node_id(out, edge.target);
        }
    }
}

/// Encodes a length-prefixed `HashMap<String, Vec<T>>` where each `T` is itself a length-prefixed
/// list of leaves — the shape common to `write_str_keyed_edge_pairs`/`write_str_keyed_node_lists`/
/// `write_str_keyed_flat_node_lists`/`write_str_keyed_routes` below, which differ only in how one
/// leaf value is encoded.
fn write_str_keyed_lists<T>(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<T>>, mut write_item: impl FnMut(&mut Vec<u8>, &T)) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (key, items) in map {
        write_str(out, key);
        out.extend_from_slice(&(items.len() as u32).to_le_bytes());
        for item in items {
            write_item(out, item);
        }
    }
}

pub(crate) fn write_issue_payload(out: &mut Vec<u8>, payload: &IssuePayload) {
    match payload {
        IssuePayload::None => out.push(0),
        IssuePayload::InvalidLoop { edges } => {
            out.push(1);
            write_str_keyed_edge_pairs(out, edges);
        }
        IssuePayload::RegionNeedsExpansion { nodes } => {
            out.push(2);
            write_str_keyed_node_lists(out, nodes);
        }
        IssuePayload::RegionNeedsShrink { nodes } => {
            out.push(3);
            write_str_keyed_node_lists(out, nodes);
        }
        IssuePayload::InvalidTeleport { groups } => {
            out.push(4);
            write_str_keyed_edge_pairs(out, groups);
        }
        IssuePayload::InvalidOneWay { groups } => {
            out.push(5);
            write_str_keyed_edge_pairs(out, groups);
        }
        IssuePayload::InvalidSplitTile { groups } => {
            out.push(6);
            write_str_keyed_split_groups(out, groups);
        }
        IssuePayload::InvalidSplitRoute { routes } => {
            out.push(7);
            write_str_keyed_routes(out, routes);
        }
        IssuePayload::ExcessiveSccCount { preset_locked } => {
            out.push(8);
            write_str_keyed_bools(out, preset_locked);
        }
        IssuePayload::InvalidVerticalPassage { groups } => {
            out.push(9);
            write_str_keyed_edge_pairs(out, groups);
        }
    }
}

pub(crate) fn write_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn write_edge_pairs(out: &mut Vec<u8>, cycle: &[[u32; 2]]) {
    out.extend_from_slice(&(cycle.len() as u32).to_le_bytes());
    for [from, to] in cycle {
        out.extend_from_slice(&from.to_le_bytes());
        out.extend_from_slice(&to.to_le_bytes());
    }
}

/// Encodes one `IssueEdgeGroupPayload` — its edges (`write_edge_pairs`'s existing shape) followed
/// by one trailing byte for `preset_locked` (GitHub issue #245: 0 = false, 1 = true).
fn write_edge_group_payload(out: &mut Vec<u8>, group: &IssueEdgeGroupPayload) {
    write_edge_pairs(out, &group.edges);
    out.push(group.preset_locked as u8);
}

fn write_str_keyed_edge_pairs(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<IssueEdgeGroupPayload>>) {
    write_str_keyed_lists(out, map, |out, group| write_edge_group_payload(out, group));
}

/// Encodes one check's own raw display details (GitHub issue #171) — `Issue::details()`'s
/// per-check value, e.g. `{"threshold" -> "10"}`.
fn write_details(out: &mut Vec<u8>, details: &std::collections::HashMap<&'static str, String>) {
    out.extend_from_slice(&(details.len() as u32).to_le_bytes());
    for (key, value) in details {
        write_str(out, key);
        write_str(out, value);
    }
}

/// Encodes a merged issue's full details map, keyed by contributing check instance id (GitHub
/// issue #171) — mirrors `Issue::details()`'s own shape one level up.
pub(crate) fn write_details_map(out: &mut Vec<u8>, map: &std::collections::HashMap<String, std::collections::HashMap<&'static str, String>>) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (check_id, details) in map {
        write_str(out, check_id);
        write_details(out, details);
    }
}

/// Encodes `IssuePayload::RegionNeedsExpansion`/`RegionNeedsShrink`'s `nodes` field — this binary
/// QC event tape is intentionally build-coupled (produced and consumed by the same wasm+web build,
/// never persisted across builds via `wasm-rebuild.ps1`), so no backward-compatibility/versioning
/// is attempted here; a wire-shape change like this one is a normal, unversioned edit. Wire order
/// per region: the `region` node list, then a trailing 1-byte `preset_locked` flag (0/1 — GitHub
/// issue #245's region extension), mirroring `write_edge_group_payload`'s own trailing flag.
fn write_str_keyed_node_lists(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<IssueRegionPayload>>) {
    write_str_keyed_lists(out, map, |out, region: &IssueRegionPayload| {
        out.extend_from_slice(&(region.region.len() as u32).to_le_bytes());
        for &node in &region.region {
            out.extend_from_slice(&node.to_le_bytes());
        }
        out.push(region.preset_locked as u8);
    });
}

/// Encodes one `IssueSplitTilePayload` — its node-id list (length-prefixed `u32`s) followed by a
/// trailing 1-byte `preset_locked` flag (0/1), mirroring `write_edge_group_payload`'s own trailing
/// flag.
fn write_split_tile_payload(out: &mut Vec<u8>, tile: &IssueSplitTilePayload) {
    out.extend_from_slice(&(tile.nodes.len() as u32).to_le_bytes());
    for &node in &tile.nodes {
        out.extend_from_slice(&node.to_le_bytes());
    }
    out.push(tile.preset_locked as u8);
}

/// Encodes `IssuePayload::InvalidSplitTile`'s `groups` field — one flagged "instance" (a single
/// tile, or a genuine multi-tile group) per entry: a length-prefixed list of `IssueSplitTilePayload`
/// (`write_split_tile_payload`'s shape), then a trailing 1-byte group-level `preset_locked` flag
/// (0/1 — GitHub issue #245's split extension, review fix preserving tile/group boundaries instead
/// of flattening).
fn write_str_keyed_split_groups(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<IssueSplitGroupPayload>>) {
    write_str_keyed_lists(out, map, |out, group: &IssueSplitGroupPayload| {
        out.extend_from_slice(&(group.tiles.len() as u32).to_le_bytes());
        for tile in &group.tiles {
            write_split_tile_payload(out, tile);
        }
        out.push(group.preset_locked as u8);
    });
}

/// Encodes `IssuePayload::InvalidSplitRoute`'s `routes` field — one ordered edge triple sequence
/// per route, each edge as `from`/`to` (both `u32` LE) followed by a 1-byte `is_split_edge` flag
/// (0/1), then a trailing 1-byte `preset_locked` flag (0/1) for the whole route. Edge order is
/// preserved exactly as stored (a route is a path, not a set — unlike every other
/// `write_str_keyed_*` helper here, which encodes unordered cycles/groups).
fn write_str_keyed_routes(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<IssueRoutePayload>>) {
    write_str_keyed_lists(out, map, |out, route: &IssueRoutePayload| {
        out.extend_from_slice(&(route.edges.len() as u32).to_le_bytes());
        for edge in &route.edges {
            out.extend_from_slice(&edge.from.to_le_bytes());
            out.extend_from_slice(&edge.to.to_le_bytes());
            out.push(edge.is_split_edge as u8);
        }
        out.push(route.preset_locked as u8);
    });
}

/// Encodes `IssuePayload::ExcessiveSccCount`'s `preset_locked` field (GitHub issue #245's SCC-count
/// extension) — a plain `HashMap<String, bool>`, one 1-byte flag per key, no nested lists since this
/// issue carries no per-region highlight data of its own (`ReduceSccCountStrategy` picks merge
/// targets dynamically from live component sizes, not from data recorded on the issue).
fn write_str_keyed_bools(out: &mut Vec<u8>, map: &std::collections::HashMap<String, bool>) {
    out.extend_from_slice(&(map.len() as u32).to_le_bytes());
    for (key, value) in map {
        write_str(out, key);
        out.push(*value as u8);
    }
}

pub(crate) fn write_issue_kind(out: &mut Vec<u8>, kind: &IssueKind) {
    write_str(out, kind.as_str());
}

pub(crate) fn write_repair_limit_kind(out: &mut Vec<u8>, kind: &RepairLimitKind) {
    out.push(match kind {
        RepairLimitKind::MaxIterations => 0,
        RepairLimitKind::TimeBudget => 1,
    });
}

/// Encodes `CheckRan`'s `issue` field — a presence byte, then (if present) the check's issue
/// `kind`/`payload`/per-check `details` as one atomic unit. Not split into 3 separate standard
/// fields: `codegen`'s whitelist has no shape for "one `Option` wrapping 3 heterogeneous values",
/// so this single named codec covers the whole field (see `CheckIssueCodec` in
/// `codegen/src/codecs.rs`).
pub(crate) fn write_check_issue(out: &mut Vec<u8>, issue: &Option<(IssueKind, IssuePayload, std::collections::HashMap<&'static str, String>)>) {
    match issue {
        None => out.push(0),
        Some((kind, payload, details)) => {
            out.push(1);
            write_issue_kind(out, kind);
            write_issue_payload(out, payload);
            write_details(out, details);
        }
    }
}
