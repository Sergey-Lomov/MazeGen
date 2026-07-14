use std::collections::{HashSet, HashMap};
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, EncodeEventPayload, EventLog};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

/// Stable wire tags for [`WilsonEvent`] (see `Specs/event_log.md`'s #124 binary encoding) —
/// manually assigned, never derived from Rust enum variant order/discriminant. `0` is reserved
/// for scope nodes (`event_log::TAG_SCOPE`) and must never be assigned here.
mod wire_tags {
    pub const WALK_START_PICKED: u16 = 1;
    pub const STEP_TAKEN: u16 = 2;
    pub const LOOP_ERASED: u16 = 3;
    pub const WALK_DEAD_END: u16 = 4;
    pub const EDGE_ADDED: u16 = 5;
    pub const NODE_VISITED: u16 = 6;
}

/// Narration-level events for Wilson's algorithm (see GitHub issue #145). Wilson's decision shape
/// is a two-level loop — an outer "pick an unvisited node and loop-erased-random-walk from it"
/// iteration, and an inner per-step random walk that can erase its own loops — so the event set
/// mirrors both levels, unlike Kruskal's single-level per-edge decision.
#[derive(Debug, Clone, PartialEq)]
pub enum WilsonEvent {
    /// The unvisited node a new loop-erased random walk starts from, chosen uniformly at random
    /// from the current unvisited set. Emitted first in every `"walk N"` scope, before any `"step
    /// M"` sub-scope, so a narration reader knows the walk's origin without inferring it from the
    /// first `StepTaken`'s `from`.
    WalkStartPicked(NodeId),
    /// One step of the walk: the RNG chose `to` as the next cell from `from`'s connectable
    /// neighbors. Emitted first in every `"step M"` scope.
    StepTaken { from: NodeId, to: NodeId },
    /// The walk stepped onto a node it had already visited earlier in this same walk (before
    /// reaching a node already part of the maze) — the loop between the earlier visit and now is
    /// erased by overwriting `next[node]` with the new outgoing step. Carries no fields beyond
    /// `node`: the preceding `StepTaken` in the same `"step M"` scope already states which node
    /// was re-entered (`StepTaken.to`), so duplicating `from`/`to` here would be redundant.
    LoopErased { node: NodeId },
    /// The walk's current node has no connectable neighbors — the walk stops here without
    /// reaching an already-visited node. The last `"step M"` scope in a `"walk N"` scope ends with
    /// this instead of a further `StepTaken`. The commit phase below still runs against whatever
    /// partial path was recorded before the dead end.
    WalkDeadEnd,
    /// An edge was added between `from` and `to` while committing the loop-erased path into the
    /// maze. `bidirectional` records whether the passage opened in both directions (Wilson always
    /// adds both when `try_add_bidirectional_edge` succeeds) — carried explicitly so replay
    /// consumers don't have to assume it.
    EdgeAdded { from: NodeId, to: NodeId, bidirectional: bool },
    /// A node was marked as part of the maze while committing the loop-erased path.
    NodeVisited(NodeId),
}

impl DebugEvent for WilsonEvent {
    fn is_mutating(&self) -> bool {
        matches!(self, WilsonEvent::EdgeAdded { .. } | WilsonEvent::NodeVisited(_))
    }
}

/// Binary encoding for the WASM boundary (GitHub issue #124's format). `NodeId` is `u64` — every
/// single-id payload is 8 little-endian bytes; `StepTaken`/`EdgeAdded` (minus its flag byte) are
/// two back-to-back `NodeId`s; `WalkDeadEnd` carries no payload (0 bytes).
impl EncodeEventPayload for WilsonEvent {
    fn type_id(&self) -> u16 {
        match self {
            WilsonEvent::WalkStartPicked(_) => wire_tags::WALK_START_PICKED,
            WilsonEvent::StepTaken { .. } => wire_tags::STEP_TAKEN,
            WilsonEvent::LoopErased { .. } => wire_tags::LOOP_ERASED,
            WilsonEvent::WalkDeadEnd => wire_tags::WALK_DEAD_END,
            WilsonEvent::EdgeAdded { .. } => wire_tags::EDGE_ADDED,
            WilsonEvent::NodeVisited(_) => wire_tags::NODE_VISITED,
        }
    }

    fn encode_payload(&self, out: &mut Vec<u8>) {
        match self {
            WilsonEvent::WalkStartPicked(node) => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            WilsonEvent::StepTaken { from, to } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
            }
            WilsonEvent::LoopErased { node } => {
                out.extend_from_slice(&node.to_le_bytes());
            }
            WilsonEvent::WalkDeadEnd => {}
            WilsonEvent::EdgeAdded { from, to, bidirectional } => {
                out.extend_from_slice(&from.to_le_bytes());
                out.extend_from_slice(&to.to_le_bytes());
                out.push(if *bidirectional { 1 } else { 0 });
            }
            WilsonEvent::NodeVisited(node) => {
                out.extend_from_slice(&node.to_le_bytes());
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
    mut event_log: Option<&mut EventLog<WilsonEvent>>,
) {
    let all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);

    for &pc in &preset_state.preset_connected {
        visited.insert(pc);
    }
    visited.insert(start);

    let mut unvisited: Vec<NodeId> = all_nodes.iter().copied().filter(|&n| !visited.contains(&n)).collect();

    while !unvisited.is_empty() {
        // Pick a random unvisited node to start a random walk from.
        let pick_idx = rng.random_range(0..unvisited.len());
        let walk_start = unvisited[pick_idx];

        let mut walk_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("walk"));
        if let Some(g) = walk_scope.as_mut() {
            g.emit(WilsonEvent::WalkStartPicked(walk_start));
        }

        // Loop-erased random walk until we hit a visited node.
        // next[node] = the node we stepped to from node during the walk.
        let mut next: HashMap<NodeId, NodeId> = HashMap::new();
        let mut current = walk_start;
        loop {
            let neighbors: Vec<NodeId> = field.neighbors(current)
                .into_iter()
                .filter(|&n| can_connect(current, n, preset_state))
                .collect();

            if neighbors.is_empty() {
                if let Some(g) = walk_scope.as_mut() {
                    g.emit(WilsonEvent::WalkDeadEnd);
                }
                break;
            }
            let chosen = neighbors[rng.random_range(0..neighbors.len())];
            if let Some(g) = walk_scope.as_mut() {
                g.emit(WilsonEvent::StepTaken { from: current, to: chosen });
            }
            let erased_loop = next.contains_key(&chosen);
            next.insert(current, chosen);
            if erased_loop {
                if let Some(g) = walk_scope.as_mut() {
                    g.emit(WilsonEvent::LoopErased { node: chosen });
                }
            }
            if visited.contains(&chosen) {
                break;
            }
            current = chosen;
        }

        // Commit the loop-erased path: walk from walk_start following next[] until visited.
        let mut node = walk_start;
        while !visited.contains(&node) {
            let Some(&dst) = next.get(&node) else { break; };
            try_add_bidirectional_edge(graph, node, dst, preset_state);
            visited.insert(node);
            if let Some(g) = walk_scope.as_mut() {
                g.emit(WilsonEvent::EdgeAdded { from: node, to: dst, bidirectional: true });
                g.emit(WilsonEvent::NodeVisited(node));
            }
            node = dst;
        }

        unvisited.retain(|n| !visited.contains(n));
    }
}
