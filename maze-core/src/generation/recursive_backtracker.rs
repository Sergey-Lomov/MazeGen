use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::event_log::{CheckpointLog, DebugEvent, EncodeEventPayload, EventLog};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

/// Number of mutating events between intermediate snapshot checkpoints (GitHub issue #128) — a
/// tunable constant, not user-facing config, per the issue's pilot scope. Picked empirically:
/// frequent enough that a replay consumer never has to walk more than this many mutating events
/// from the nearest checkpoint, sparse enough that the checkpoint table itself stays small.
const CHECKPOINT_INTERVAL: u32 = 500;

/// Accumulates checkpoint state alongside `generate`'s event emission — kept separate from
/// `EventLog`/`CheckpointLog` themselves (see `Specs/event_log.md`'s #128 section) since neither
/// of those types knows what a "snapshot" is; that's this algorithm's concern.
///
/// Tracks the same reconstructable state `applyRecursiveBacktracker` (`maze-web/src/debug/eventTape.ts`)
/// builds from `EdgeAdded` events — an edge list, not the full graph — so a snapshot is a drop-in
/// stand-in for "replay from scratch up to this node index". Deliberately excludes preset edges
/// (already in `graph` before `generate` runs, never emitted as `EdgeAdded`), matching what a full
/// replay from an empty `edges: []` would reconstruct.
struct CheckpointTracker<'a> {
    log: &'a mut CheckpointLog,
    edges: Vec<(NodeId, NodeId)>,
    since_last_checkpoint: u32,
}

impl<'a> CheckpointTracker<'a> {
    fn new(log: &'a mut CheckpointLog) -> Self {
        Self { log, edges: Vec::new(), since_last_checkpoint: 0 }
    }

    /// Call after every mutating event emit. `edge_delta`, when present, is folded into the
    /// tracked edge list (both directions, mirroring `EdgeAdded`'s `bidirectional` flag handling
    /// in the TS replay engine). `node_index` is the arena index `emit` returned for this event —
    /// the checkpoint (if the interval is reached) is tagged with that index, not with whatever
    /// the arena's length happens to be later.
    fn record(&mut self, node_index: u32, edge_delta: Option<(NodeId, NodeId, bool)>) {
        if let Some((from, to, bidirectional)) = edge_delta {
            self.edges.push((from, to));
            if bidirectional {
                self.edges.push((to, from));
            }
        }
        self.since_last_checkpoint += 1;
        if self.since_last_checkpoint >= CHECKPOINT_INTERVAL {
            self.since_last_checkpoint = 0;
            let mut bytes = Vec::with_capacity(4 + self.edges.len() * 16);
            bytes.extend_from_slice(&(self.edges.len() as u32).to_le_bytes());
            for (from, to) in &self.edges {
                bytes.extend_from_slice(&from.to_le_bytes());
                bytes.extend_from_slice(&to.to_le_bytes());
            }
            self.log.push(node_index, &bytes);
        }
    }
}

/// Stable wire tags for [`RecursiveBacktrackerEvent`] (GitHub issue #124's binary encoding) —
/// manually assigned, never derived from Rust enum variant order/discriminant, so the wire
/// format doesn't silently shift when a variant is added/reordered. `0` is reserved for scope
/// nodes (`event_log::TAG_SCOPE`) and must never be assigned here.
mod wire_tags {
    pub const VERTEX_SELECTED: u16 = 1;
    pub const CANDIDATES_COMPUTED: u16 = 2;
    pub const DEAD_END: u16 = 3;
    pub const CANDIDATE_CHOSEN: u16 = 4;
    pub const EDGE_ADDED: u16 = 5;
    pub const VERTEX_VISITED: u16 = 6;
    pub const VERTEX_POPPED: u16 = 7;
    pub const VERTEX_PUSHED: u16 = 8;
}

/// Narration-level events for Recursive Backtracker (see GitHub issue #123). The algorithm has
/// no `corridor_chance`/`branching`-style params (unlike `CustomVertexBased`) — each processed
/// vertex makes exactly one connection choice among its unvisited candidates, so the event set
/// mirrors that: candidates computed, one picked (or none, causing a backtrack), and the
/// resulting mutations.
#[derive(Debug, Clone, PartialEq)]
pub enum RecursiveBacktrackerEvent {
    /// Vertex at the top of the stack selected for processing this step.
    VertexSelected(NodeId),
    /// Unvisited, connectable candidates computed for the selected vertex.
    CandidatesComputed(Vec<NodeId>),
    /// No candidates remained — the vertex will be popped (dead end).
    DeadEnd,
    /// A candidate was picked at random from the candidate list.
    CandidateChosen(NodeId),
    /// An edge was added between `from` and `to`. `bidirectional` records whether the passage
    /// opened in both directions (RB always adds both when `try_add_bidirectional_edge`
    /// succeeds) — carried explicitly so replay consumers (e.g. the web debug view, #125) don't
    /// have to rely on implicit knowledge that RB always double-adds.
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    /// A vertex was marked visited.
    VertexVisited(NodeId),
    /// A vertex was popped off the stack (dead end backtrack).
    VertexPopped(NodeId),
    /// A vertex was pushed onto the stack.
    VertexPushed(NodeId),
}

impl DebugEvent for RecursiveBacktrackerEvent {
    fn is_mutating(&self) -> bool {
        matches!(
            self,
            RecursiveBacktrackerEvent::EdgeAdded { .. }
                | RecursiveBacktrackerEvent::VertexVisited(_)
                | RecursiveBacktrackerEvent::VertexPopped(_)
                | RecursiveBacktrackerEvent::VertexPushed(_)
        )
    }
}

/// Binary encoding for the WASM boundary (GitHub issue #124). `NodeId` is `u64` — every
/// single-id payload is 8 little-endian bytes; `EdgeAdded` is two back-to-back `NodeId`s plus a
/// 1-byte `bidirectional` flag (17 bytes, GitHub issue #135); `CandidatesComputed` (the only
/// variable-length variant) is a `u32` LE length prefix followed by that many `NodeId`s;
/// `DeadEnd` carries no data (0-byte payload).
impl EncodeEventPayload for RecursiveBacktrackerEvent {
    fn type_id(&self) -> u16 {
        match self {
            RecursiveBacktrackerEvent::VertexSelected(_) => wire_tags::VERTEX_SELECTED,
            RecursiveBacktrackerEvent::CandidatesComputed(_) => wire_tags::CANDIDATES_COMPUTED,
            RecursiveBacktrackerEvent::DeadEnd => wire_tags::DEAD_END,
            RecursiveBacktrackerEvent::CandidateChosen(_) => wire_tags::CANDIDATE_CHOSEN,
            RecursiveBacktrackerEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            RecursiveBacktrackerEvent::VertexVisited(_) => wire_tags::VERTEX_VISITED,
            RecursiveBacktrackerEvent::VertexPopped(_) => wire_tags::VERTEX_POPPED,
            RecursiveBacktrackerEvent::VertexPushed(_) => wire_tags::VERTEX_PUSHED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            RecursiveBacktrackerEvent::VertexSelected(id)
            | RecursiveBacktrackerEvent::CandidateChosen(id)
            | RecursiveBacktrackerEvent::VertexVisited(id)
            | RecursiveBacktrackerEvent::VertexPopped(id)
            | RecursiveBacktrackerEvent::VertexPushed(id) => {
                out.extend_from_slice(&id.to_le_bytes());
            }
            RecursiveBacktrackerEvent::CandidatesComputed(ids) => {
                out.extend_from_slice(&(ids.len() as u32).to_le_bytes());
                for id in ids {
                    out.extend_from_slice(&id.to_le_bytes());
                }
            }
            RecursiveBacktrackerEvent::DeadEnd => {}
            RecursiveBacktrackerEvent::EdgeAdded { from, to, bidirectional } => {
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
    start: NodeId,
    preset_state: &PresetState,
    mut event_log: Option<&mut EventLog<RecursiveBacktrackerEvent>>,
    checkpoint_log: Option<&mut CheckpointLog>,
) {
    debug_assert!(
        checkpoint_log.is_none() || event_log.is_some(),
        "recursive_backtracker::generate: checkpoint_log requires event_log — a checkpoint is tagged with an \
         arena node index from event_log's emit(), so checkpointing without an event tree has nothing to \
         attach a snapshot to (see CheckpointTracker::record's node_index parameter)"
    );

    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);
    let mut checkpoints = checkpoint_log.map(CheckpointTracker::new);

    let preset_connected = &preset_state.preset_connected;
    visited.insert(start);

    let mut stack: Vec<NodeId> = vec![start];

    while let Some(&current) = stack.last() {
        let mut step_guard = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
        if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexSelected(current)); }

        let unvisited: Vec<NodeId> = field
            .neighbors(current)
            .into_iter()
            .filter(|&n| !visited.contains(&n)
                && (preset_connected.contains(&current) && preset_connected.contains(&n) || can_connect(current, n, preset_state)))
            .collect();
        if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::CandidatesComputed(unvisited.clone())); }

        if unvisited.is_empty() {
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::DeadEnd); }
            stack.pop();
            if let Some(g) = step_guard.as_mut() {
                let idx = g.emit(RecursiveBacktrackerEvent::VertexPopped(current));
                if let Some(t) = checkpoints.as_mut() { t.record(idx, None); }
            }
        } else {
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::CandidateChosen(chosen)); }
            // Preset nodes already have their edge in the graph — skip adding it again.
            if !preset_connected.contains(&chosen) {
                try_add_bidirectional_edge(graph, current, chosen, preset_state);
                if let Some(g) = step_guard.as_mut() {
                    let idx = g.emit(RecursiveBacktrackerEvent::EdgeAdded { from: current, to: chosen, bidirectional: true });
                    if let Some(t) = checkpoints.as_mut() { t.record(idx, Some((current, chosen, true))); }
                }
            }
            visited.insert(chosen);
            if let Some(g) = step_guard.as_mut() {
                let idx = g.emit(RecursiveBacktrackerEvent::VertexVisited(chosen));
                if let Some(t) = checkpoints.as_mut() { t.record(idx, None); }
            }
            stack.push(chosen);
            if let Some(g) = step_guard.as_mut() {
                let idx = g.emit(RecursiveBacktrackerEvent::VertexPushed(chosen));
                if let Some(t) = checkpoints.as_mut() { t.record(idx, None); }
            }
        }
    }
}
