use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, DebugValueDelta, DebugValueKind, DebugValueOp, EncodeEventPayload, EventLog};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

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

/// Debug value: `"recursion_stack"` — vertices currently on the DFS stack (pushed but not yet
/// popped). Named for the actual data structure it tracks, not "frontier" — in graph-traversal
/// terminology frontier usually means unvisited-but-reachable candidate vertices (closer to this
/// algorithm's own `unvisited`/`CandidatesComputed`), not the recursion/backtrack stack itself, so
/// that name would have been misleading. Derived from the existing `VertexPushed`/`VertexPopped`
/// mutating events rather than a separate event (see `DebugValueDelta`'s doc comment for why) —
/// introduced for issue #131.
const RECURSION_STACK: &str = "recursion_stack";

/// Debug value: `"visited"` — every vertex the algorithm has marked visited so far. Derived from
/// the existing `VertexVisited` mutating event; monotonic (RB never unvisits a vertex), so this
/// is `Insert`-only, unlike `RECURSION_STACK`.
const VISITED: &str = "visited";

impl DebugValueDelta<NodeId> for RecursiveBacktrackerEvent {
    fn debug_value_deltas(&self) -> Vec<(&'static str, DebugValueOp, NodeId)> {
        match self {
            RecursiveBacktrackerEvent::VertexPushed(id) => vec![(RECURSION_STACK, DebugValueOp::Insert, *id)],
            RecursiveBacktrackerEvent::VertexPopped(id) => vec![(RECURSION_STACK, DebugValueOp::Remove, *id)],
            RecursiveBacktrackerEvent::VertexVisited(id) => vec![(VISITED, DebugValueOp::Insert, *id)],
            _ => Vec::new(),
        }
    }
}

/// Static declaration of every debug-value name (and its rendering `DebugValueKind`) this
/// algorithm's events can produce (GitHub issue #131) — the canonical source the web-side toggle
/// list is built from. Deliberately not derived from scanning a run's actual emitted deltas
/// (`resolveDebugArenaMetadata` on the web side used to do that): a trivial run that never
/// pushes/pops (e.g. a single-node field) would then silently omit `"recursion_stack"` even
/// though the algorithm declares it. References the same `RECURSION_STACK`/`VISITED` constants
/// `debug_value_deltas` emits, so the declared names and the emitted names cannot drift apart.
///
/// `"recursion_stack"` is `Sequence` — insertion order matters (it's the actual DFS stack).
/// `"visited"` is `Region` — an unordered set with no relationship between members.
pub fn debug_value_names() -> &'static [(&'static str, DebugValueKind)] {
    &[(RECURSION_STACK, DebugValueKind::Sequence), (VISITED, DebugValueKind::Region)]
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
) {
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);

    let preset_connected = &preset_state.preset_connected;
    visited.insert(start);

    let mut stack: Vec<NodeId> = vec![start];

    while let Some(&current) = stack.last() {
        let mut step_guard = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
        if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexSelected(current)); }

        let teleport_dsts = preset_state.preset_teleports.get(&current).map(Vec::as_slice).unwrap_or(&[]);
        let unvisited: Vec<NodeId> = field
            .neighbors(current)
            .into_iter()
            .filter(|&n| !visited.contains(&n)
                && (preset_connected.contains(&current) && preset_connected.contains(&n) || can_connect(current, n, preset_state)))
            // Preset-teleport destinations already have their edge in the graph — traversable
            // regardless of `can_connect` (that check governs whether a *new* edge may be added,
            // which doesn't apply here — see GitHub issue #226).
            .chain(teleport_dsts.iter().copied().filter(|n| !visited.contains(n)))
            .collect();
        if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::CandidatesComputed(unvisited.clone())); }

        if unvisited.is_empty() {
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::DeadEnd); }
            stack.pop();
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexPopped(current)); }
        } else {
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::CandidateChosen(chosen)); }
            // Preset nodes (adjacency or teleport) already have their edge in the graph — skip adding it again.
            if !preset_connected.contains(&chosen) && !teleport_dsts.contains(&chosen) {
                try_add_bidirectional_edge(graph, current, chosen, preset_state);
                if let Some(g) = step_guard.as_mut() {
                    g.emit(RecursiveBacktrackerEvent::EdgeAdded { from: current, to: chosen, bidirectional: true });
                }
            }
            visited.insert(chosen);
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexVisited(chosen)); }
            stack.push(chosen);
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexPushed(chosen)); }
        }
    }
}

