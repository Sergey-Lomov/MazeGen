use crate::ids::NodeId;
use crate::graph::EdgeKind;
use crate::repair::command::{SplitNodeEdge, SplitNodeEdgeDirection};
use crate::quality_control::issue::IssueKind;
use crate::quality_control::issue_kinds::RepairLimitKind;
use crate::quality_control::issue_payload::IssuePayload;

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
        IssuePayload::InvalidSplitTile { nodes } => {
            out.push(6);
            write_str_keyed_flat_node_lists(out, nodes);
        }
        IssuePayload::InvalidSplitRoute { routes } => {
            out.push(7);
            write_str_keyed_routes(out, routes);
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

fn write_str_keyed_edge_pairs(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<Vec<[u32; 2]>>>) {
    write_str_keyed_lists(out, map, |out, cycle| write_edge_pairs(out, cycle));
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

fn write_str_keyed_node_lists(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<Vec<u32>>>) {
    write_str_keyed_lists(out, map, |out, region: &Vec<u32>| {
        out.extend_from_slice(&(region.len() as u32).to_le_bytes());
        for &node in region {
            out.extend_from_slice(&node.to_le_bytes());
        }
    });
}

/// Flat variant of `write_str_keyed_node_lists` — one node list per key, no region-grouping level
/// (`IssuePayload::InvalidSplitTile` has no group structure to preserve, unlike `RegionNeedsExpansion`).
fn write_str_keyed_flat_node_lists(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<u32>>) {
    write_str_keyed_lists(out, map, |out, &node: &u32| {
        out.extend_from_slice(&node.to_le_bytes());
    });
}

/// Encodes `IssuePayload::InvalidSplitRoute`'s `routes` field — one ordered edge-triple sequence
/// per route, each edge as `from`/`to` (both `u32` LE) followed by a 1-byte `is_split_edge` flag
/// (0/1). Order is preserved exactly as stored (a route is a path, not a set — unlike every other
/// `write_str_keyed_*` helper here, which encodes unordered cycles/groups).
fn write_str_keyed_routes(out: &mut Vec<u8>, map: &std::collections::HashMap<String, Vec<Vec<(u32, u32, bool)>>>) {
    write_str_keyed_lists(out, map, |out, route: &Vec<(u32, u32, bool)>| {
        out.extend_from_slice(&(route.len() as u32).to_le_bytes());
        for &(from, to, is_split) in route {
            out.extend_from_slice(&from.to_le_bytes());
            out.extend_from_slice(&to.to_le_bytes());
            out.push(is_split as u8);
        }
    });
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
