use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::Graph;
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, EventLog};
use super::{PresetState, try_add_bidirectional_edge, can_connect};

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
    /// An edge was added between `from` and `to`.
    EdgeAdded { from: NodeId, to: NodeId },
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

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    seed: u64,
    start: NodeId,
    preset_state: &PresetState,
    mut on_step: Option<&mut super::StepCallback<'_>>,
    mut event_log: Option<&mut EventLog<RecursiveBacktrackerEvent>>,
) {
    let mut visited: HashSet<NodeId> = HashSet::new();
    let mut rng = MazeRng::seed_from_u64(seed);

    let preset_connected = &preset_state.preset_connected;
    visited.insert(start);

    let mut stack: Vec<NodeId> = vec![start];

    while let Some(&current) = stack.last() {
        let mut step_guard = event_log.as_deref_mut().map(|log| log.enter("step"));
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
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexPopped(current)); }
        } else {
            let chosen = unvisited[rng.random_range(0..unvisited.len())];
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::CandidateChosen(chosen)); }
            // Preset nodes already have their edge in the graph — skip adding it again.
            if !preset_connected.contains(&chosen) {
                try_add_bidirectional_edge(graph, current, chosen, preset_state);
                if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::EdgeAdded { from: current, to: chosen }); }
            }
            visited.insert(chosen);
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexVisited(chosen)); }
            stack.push(chosen);
            if let Some(g) = step_guard.as_mut() { g.emit(RecursiveBacktrackerEvent::VertexPushed(chosen)); }
            if let Some(ref mut cb) = on_step { cb(graph, current, &stack); }
        }
    }
}
