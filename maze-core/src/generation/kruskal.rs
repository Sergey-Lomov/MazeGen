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
    pub const PRESET_UNIONS_APPLIED: u16 = 6;
    pub const EDGE_SELECTED: u16 = 7;
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
    /// The current edge being processed this iteration — emitted first in every `"edge N"` scope,
    /// before the union-find lookup, so a narration reader sees which edge `RootsCompared`'s roots
    /// belong to without having to infer it from a later `EdgeAdded`/`EdgeRejected`.
    EdgeSelected { from: NodeId, to: NodeId },
    /// Union-find roots looked up for the current edge's endpoints. Carries `from`/`to` alongside
    /// the roots (duplicating `EdgeSelected`'s pair) rather than requiring a narration consumer to
    /// remember the preceding sibling event — this event is self-sufficient: "root of `from` is
    /// `root_of_from`, root of `to` is `root_of_to`" reads directly off one payload.
    RootsCompared { from: NodeId, to: NodeId, root_of_from: NodeId, root_of_to: NodeId },
    /// The edge was rejected — its endpoints already share a root (would create a cycle). Carries
    /// no fields: the rejected pair is already fully stated by the preceding `RootsCompared` event
    /// in the same `"edge N"` scope (`from`/`to`, plus the equal roots that caused the rejection),
    /// so duplicating `from`/`to` here again would be redundant payload with no new information.
    EdgeRejected,
    /// An edge was added between `from` and `to`. `bidirectional` records whether the passage
    /// opened in both directions (Kruskal always adds both when `try_add_bidirectional_edge`
    /// succeeds) — carried explicitly so replay consumers don't have to assume it.
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    /// The two disjoint sets containing the edge's endpoints were merged. `root_a`/`root_b` are
    /// the two pre-merge roots (same values `RootsCompared` reported); the merged set's new root
    /// is `min(root_a, root_b)` by construction (`Dsu::union_by_min`) — not carried explicitly to
    /// avoid duplicating a value a replay consumer can derive itself.
    SetsMerged { root_a: NodeId, root_b: NodeId },
    /// Preset-connected node pairs pre-unioned into the union-find structure before the main
    /// edge loop starts (see `generate`'s pre-union step) — emitted once, first, so a replay
    /// consumer's own DSU reconstruction (see `Specs/event_log.md`'s Kruskal DSU groups section)
    /// starts from the same initial state the algorithm itself did, rather than every node
    /// starting in its own singleton set. Trace-only: these unions already happened before any
    /// event-log scope opens, so there is no corresponding `SetsMerged` per pair to replay from.
    PresetUnionsApplied(Vec<(NodeId, NodeId)>),
}

impl DebugEvent for KruskalEvent {
    fn is_mutating(&self) -> bool {
        matches!(self, KruskalEvent::EdgeAdded { .. } | KruskalEvent::SetsMerged { .. })
    }
}

impl KruskalEvent {
    /// The merged set's new root after a `SetsMerged` event — `min(root_a, root_b)`, mirroring
    /// `Dsu::union_by_min`'s own rule. A method on the event itself (not carried as a field) so
    /// core and every replay consumer (web narration, tests) derive it identically from the same
    /// two values rather than risking a third, independently-computed copy drifting out of sync.
    ///
    /// Correctness depends on `generate`'s `node_index` being built by sorting `NodeId`s and
    /// assigning dense indices in that sorted order (see `sorted_ids`/`node_index` below):
    /// `Dsu::union_by_min` picks the new root by comparing dense `usize` indices, not `NodeId`s
    /// directly, but since `node_index` is monotonic in `NodeId` order, `min(index_a, index_b)`
    /// and `min(NodeId_a, NodeId_b)` always agree — this is what lets `min` on `NodeId`s here
    /// reproduce the same answer `union_by_min` computed on indices. If `node_index` is ever built
    /// some other way (e.g. insertion order), this method silently stops matching the real merged
    /// root.
    pub fn merged_root(root_a: NodeId, root_b: NodeId) -> NodeId {
        root_a.min(root_b)
    }
}

/// Binary encoding for the WASM boundary (GitHub issue #124's format). `NodeId` is `u64` — every
/// single-id payload is 8 little-endian bytes; `EdgeSelected`/`SetsMerged` are two back-to-back
/// `NodeId`s (16 bytes); `RootsCompared` is four back-to-back `NodeId`s, in order `from, to,
/// root_of_from, root_of_to` (32 bytes); `EdgeAdded` is two back-to-back `NodeId`s plus a 1-byte
/// `bidirectional` flag (17 bytes); `EdgeRejected` carries no payload (0 bytes — see its variant
/// doc comment); `EdgesShuffled`/`PresetUnionsApplied` (the variable-length variants) are a `u32`
/// LE length prefix followed by that many `(NodeId, NodeId)` pairs.
impl EncodeEventPayload for KruskalEvent {
    fn type_id(&self) -> u16 {
        match self {
            KruskalEvent::EdgesShuffled(_) => wire_tags::EDGES_SHUFFLED,
            KruskalEvent::EdgeSelected { .. } => wire_tags::EDGE_SELECTED,
            KruskalEvent::RootsCompared { .. } => wire_tags::ROOTS_COMPARED,
            KruskalEvent::EdgeRejected => wire_tags::EDGE_REJECTED,
            KruskalEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            KruskalEvent::SetsMerged { .. } => wire_tags::SETS_MERGED,
            KruskalEvent::PresetUnionsApplied(_) => wire_tags::PRESET_UNIONS_APPLIED,
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
            KruskalEvent::EdgeSelected { from, to } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
            }
            KruskalEvent::RootsCompared { from, to, root_of_from, root_of_to } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.extend_from_slice(&root_of_from.to_le_bytes());
                out.extend_from_slice(&root_of_to.to_le_bytes());
            }
            KruskalEvent::SetsMerged { root_a, root_b } => {
                out.extend_from_slice(&root_a.to_le_bytes());
                out.extend_from_slice(&root_b.to_le_bytes());
            }
            KruskalEvent::EdgeRejected => {}
            KruskalEvent::EdgeAdded { from, to, bidirectional } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            KruskalEvent::PresetUnionsApplied(pairs) => {
                out.extend_from_slice(&(pairs.len() as u32).to_le_bytes());
                for (a, b) in pairs {
                    out.extend_from_slice(&a.to_le_bytes());
                    out.extend_from_slice(&b.to_le_bytes());
                }
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
    for (a, b) in &preset_edges {
        dsu.union_by_min(node_index[a], node_index[b]);
    }
    if let Some(log) = event_log.as_deref_mut() {
        if !preset_edges.is_empty() {
            log.emit(KruskalEvent::PresetUnionsApplied(preset_edges));
        }
    }

    for (a, b) in edges {
        let mut scope_guard = event_log.as_deref_mut().map(|log| log.enter_numbered("edge"));
        if let Some(g) = scope_guard.as_mut() {
            g.emit(KruskalEvent::EdgeSelected { from: a, to: b });
        }

        let ra = dsu.find(node_index[&a]);
        let rb = dsu.find(node_index[&b]);
        let root_a = sorted_ids[ra];
        let root_b = sorted_ids[rb];
        if let Some(g) = scope_guard.as_mut() {
            g.emit(KruskalEvent::RootsCompared { from: a, to: b, root_of_from: root_a, root_of_to: root_b });
        }

        if ra == rb {
            if let Some(g) = scope_guard.as_mut() {
                g.emit(KruskalEvent::EdgeRejected);
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
