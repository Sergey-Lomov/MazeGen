use std::collections::{BTreeSet, HashMap};
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::dsu::Dsu;
use crate::event_log::{DebugEvent, EncodeEventPayload, EventLog};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

/// Stable wire tags for [`KruskalEvent`] (see `Specs/event_log.md`'s #124 binary encoding) —
/// manually assigned, never derived from Rust enum variant order/discriminant. `0` is reserved
/// for scope nodes (`event_log::TAG_SCOPE`) and must never be assigned here.
mod wire_tags {
    pub const EDGES_SHUFFLED: u16 = 1;
    pub const ROOTS_COMPARED: u16 = 2;
    pub const EDGE_REJECTED: u16 = 3;
    pub const EDGE_ADDED: u16 = 4;
    pub const SETS_MERGED: u16 = 5;
}

/// Narration-level events for Kruskal's algorithm (see GitHub issue #146). Unlike Recursive
/// Backtracker's stack-driven step loop, Kruskal's single decision per iteration is a union-find
/// lookup on a shuffled edge list — the event set mirrors that: candidate edges computed once,
/// then per-edge a root comparison followed by either a rejection (would create a cycle) or the
/// resulting mutations.
#[derive(Debug, Clone, PartialEq)]
pub enum KruskalEvent {
    /// Candidate edges (deduplicated, preset-feasible) shuffled into processing order.
    EdgesShuffled(Vec<(NodeId, NodeId)>),
    /// Union-find roots looked up for the current edge's endpoints.
    RootsCompared { root_a: NodeId, root_b: NodeId },
    /// The edge was rejected — its endpoints already share a root (would create a cycle).
    EdgeRejected { from: NodeId, to: NodeId },
    /// An edge was added between `from` and `to`. `bidirectional` records whether the passage
    /// opened in both directions (Kruskal always adds both when `try_add_bidirectional_edge`
    /// succeeds) — carried explicitly so replay consumers don't have to assume it.
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    /// The two disjoint sets containing the edge's endpoints were merged.
    SetsMerged { root_a: NodeId, root_b: NodeId },
}

impl DebugEvent for KruskalEvent {
    fn is_mutating(&self) -> bool {
        matches!(self, KruskalEvent::EdgeAdded { .. } | KruskalEvent::SetsMerged { .. })
    }
}

/// Binary encoding for the WASM boundary (GitHub issue #124's format). `NodeId` is `u64` — every
/// single-id payload is 8 little-endian bytes; `RootsCompared`/`SetsMerged` are two back-to-back
/// `NodeId`s (16 bytes); `EdgeRejected` is two back-to-back `NodeId`s (16 bytes); `EdgeAdded` is
/// two back-to-back `NodeId`s plus a 1-byte `bidirectional` flag (17 bytes); `EdgesShuffled` (the
/// only variable-length variant) is a `u32` LE length prefix followed by that many `(NodeId,
/// NodeId)` pairs.
impl EncodeEventPayload for KruskalEvent {
    fn type_id(&self) -> u16 {
        match self {
            KruskalEvent::EdgesShuffled(_) => wire_tags::EDGES_SHUFFLED,
            KruskalEvent::RootsCompared { .. } => wire_tags::ROOTS_COMPARED,
            KruskalEvent::EdgeRejected { .. } => wire_tags::EDGE_REJECTED,
            KruskalEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            KruskalEvent::SetsMerged { .. } => wire_tags::SETS_MERGED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            KruskalEvent::EdgesShuffled(edges) => {
                out.extend_from_slice(&(edges.len() as u32).to_le_bytes());
                for (a, b) in edges {
                    out.extend_from_slice(&a.to_le_bytes());
                    out.extend_from_slice(&b.to_le_bytes());
                }
            }
            KruskalEvent::RootsCompared { root_a, root_b } | KruskalEvent::SetsMerged { root_a, root_b } => {
                out.extend_from_slice(&root_a.to_le_bytes());
                out.extend_from_slice(&root_b.to_le_bytes());
            }
            KruskalEvent::EdgeRejected { from, to } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
            }
            KruskalEvent::EdgeAdded { from, to, bidirectional } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
        }
    }
}

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    preset_state: &PresetState,
    mut event_log: Option<&mut EventLog<KruskalEvent>>,
) {
    let mut rng = MazeRng::seed_from_u64(seed);

    // Collect all unique undirected edges in sorted order for determinism.
    let mut edge_set: BTreeSet<(NodeId, NodeId)> = BTreeSet::new();
    for node in graph.nodes().map(|n| n.id).collect::<Vec<_>>() {
        for neighbor in field.neighbors(node) {
            if !can_connect(node, neighbor, preset_state) { continue; }
            let pair = if node < neighbor { (node, neighbor) } else { (neighbor, node) };
            edge_set.insert(pair);
        }
    }

    // Shuffle edges for randomness.
    let mut edges: Vec<(NodeId, NodeId)> = edge_set.into_iter().collect();
    for i in (1..edges.len()).rev() {
        let j = rng.random_range(0..=i);
        edges.swap(i, j);
    }

    if let Some(log) = event_log.as_deref_mut() {
        log.emit(KruskalEvent::EdgesShuffled(edges.clone()));
    }

    // Union-Find over a dense 0..n index, since NodeId (u64) need not be contiguous.
    // Indices are assigned in NodeId order so `union_by_min` on indices matches the
    // original "lowest NodeId wins as root" determinism.
    let mut sorted_ids: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    sorted_ids.sort_unstable();
    let node_index: HashMap<NodeId, usize> = sorted_ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let mut dsu = Dsu::new(node_index.len());

    // Pre-union nodes already connected by preset edges so Kruskal doesn't add duplicate edges.
    let preset_edges: Vec<(NodeId, NodeId)> = graph.edges()
        .map(|e| (e.from.min(e.to), e.from.max(e.to)))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for (a, b) in preset_edges {
        dsu.union_by_min(node_index[&a], node_index[&b]);
    }

    for (a, b) in edges {
        let mut scope_guard = event_log.as_deref_mut().map(|log| log.enter_numbered("edge"));

        let ra = dsu.find(node_index[&a]);
        let rb = dsu.find(node_index[&b]);
        let root_a = sorted_ids[ra];
        let root_b = sorted_ids[rb];
        if let Some(g) = scope_guard.as_mut() {
            g.emit(KruskalEvent::RootsCompared { root_a, root_b });
        }

        if ra == rb {
            if let Some(g) = scope_guard.as_mut() {
                g.emit(KruskalEvent::EdgeRejected { from: a, to: b });
            }
            continue;
        }

        dsu.union_by_min(ra, rb);
        try_add_bidirectional_edge(graph, a, b, preset_state);
        if let Some(g) = scope_guard.as_mut() {
            g.emit(KruskalEvent::EdgeAdded { from: a, to: b, bidirectional: true });
            g.emit(KruskalEvent::SetsMerged { root_a, root_b });
        }
    }
}
