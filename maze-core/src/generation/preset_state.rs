use std::collections::{BTreeSet, HashSet};
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::EventLog;
use super::{PresetConnection, PresetConnectionState, TeleportDirection, LockedNode, NodeLockKind};
use super::preset_setup_event::{emit, PresetSetupEvent};

/// Resolved preset constraints in NodeId space, ready for use by generation algorithms.
pub struct PresetState {
    /// Edges the algorithm must not add (Wall presets).
    pub blocked:    HashSet<(NodeId, NodeId)>,
    /// Nodes the algorithm must not add outgoing edges from.
    pub locked_out: HashSet<NodeId>,
    /// Nodes the algorithm must not add incoming edges to.
    pub locked_in:  HashSet<NodeId>,
    /// Nodes already connected by preset Passage/OneWay edges — treated as visited at generation start.
    pub preset_connected: BTreeSet<NodeId>,
    /// Directed edges established by preset Passage/OneWay connections — must not be removed by repair.
    pub preset_edges: HashSet<(NodeId, NodeId)>,
}

impl PresetState {
    pub fn empty() -> Self {
        Self {
            blocked:         HashSet::new(),
            locked_out:      HashSet::new(),
            locked_in:       HashSet::new(),
            preset_connected: BTreeSet::new(),
            preset_edges:    HashSet::new(),
        }
    }

    /// Resolves which `PresetState` `build_maze`'s repair pass should actually see — QC
    /// experiment mode has no preset protection at all (the graph already reflects the preset
    /// setup; only the repair-time constraints are dropped), a normal run keeps `self` as-is.
    /// Shared by `maze-wasm` and `maze-runner` so both stay in sync — see `Specs/generation.md`.
    pub fn for_repair(self, qc_experiment: bool) -> Self {
        if qc_experiment { Self::empty() } else { self }
    }
}

/// Build PresetState and apply Passage/OneWay edges to the graph before generation.
///
/// `log`, when given, receives one [`PresetSetupEvent`] per preset connection that actually
/// establishes an edge (`Wall` blocks a pair without adding anything, so it emits nothing) —
/// narration for the "preset setup" debug-tape source (GitHub issue #225), built inline here since
/// this is the only place that still has each connection's resolved `from`/`to`/direction.
pub fn build_preset_state<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    preset_connections: &[PresetConnection],
    locked_nodes: &[LockedNode],
    xy_to_point: impl Fn(i32, i32) -> T::Point,
    mut log: Option<&mut EventLog<PresetSetupEvent>>,
) -> PresetState {
    let mut blocked:          HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut locked_out:       HashSet<NodeId> = HashSet::new();
    let mut locked_in:        HashSet<NodeId> = HashSet::new();
    let mut preset_connected: BTreeSet<NodeId> = BTreeSet::new();
    let mut preset_edges: HashSet<(NodeId, NodeId)> = HashSet::new();

    for preset in preset_connections {
        let from_pt = xy_to_point(preset.from.0, preset.from.1);
        let to_pt   = xy_to_point(preset.to.0,   preset.to.1);
        // `Field` has no notion of which of a multi-node point's several nodes belongs to which
        // face (GitHub issue #219 — face/group ownership is deliberately not tracked at all), so
        // there's no face-aware resolution possible here; this takes the first node, same as an
        // unsplit point's only node today. An explicit per-node choice for presets on split tiles
        // is #221 (editor UI) territory, once presets can target a specific node.
        let Some(from_id) = field.nodes_at(from_pt).first().copied() else { continue; };
        let Some(to_id)   = field.nodes_at(to_pt).first().copied()   else { continue; };

        match preset.state {
            PresetConnectionState::Wall => {
                blocked.insert((from_id, to_id));
                blocked.insert((to_id, from_id));
            }
            PresetConnectionState::Passage => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(log, PresetSetupEvent::PassageEstablished { from: from_id, to: to_id });
                }
            }
            PresetConnectionState::OneWayForward => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                blocked.insert((to_id, from_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(log, PresetSetupEvent::OneWayEstablished { from: from_id, to: to_id });
                }
            }
            PresetConnectionState::OneWayBackward => {
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
                blocked.insert((from_id, to_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(log, PresetSetupEvent::OneWayEstablished { from: to_id, to: from_id });
                }
            }
            PresetConnectionState::Teleport(direction) => {
                match direction {
                    TeleportDirection::Forward => {
                        graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
                        preset_edges.insert((from_id, to_id));
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: from_id, to: to_id, two_way: false });
                        }
                    }
                    TeleportDirection::Backward => {
                        graph.build_initial_edge(to_id, from_id, EdgeKind::Teleport);
                        preset_edges.insert((to_id, from_id));
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: to_id, to: from_id, two_way: false });
                        }
                    }
                    TeleportDirection::TwoWay => {
                        graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
                        graph.build_initial_edge(to_id, from_id, EdgeKind::Teleport);
                        preset_edges.insert((from_id, to_id));
                        preset_edges.insert((to_id, from_id));
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: from_id, to: to_id, two_way: true });
                        }
                    }
                }
                // Not added to `preset_connected` — that set exists only to short-circuit the
                // geometric-adjacency generation loop for adjacent preset pairs (see
                // edge_based.rs). A teleport pair is not geometrically adjacent, so the endpoints
                // must still go through normal generation to get their regular connectivity.
            }
        }
    }

    for lock in locked_nodes {
        let pt = xy_to_point(lock.point.0, lock.point.1);
        // Locks every node of the point (GitHub issue #219) — "no incoming/outgoing edges at this
        // point" naturally extends to all of a split point's routing passages.
        for &id in field.nodes_at(pt) {
            match lock.kind {
                NodeLockKind::In   => { locked_in.insert(id); }
                NodeLockKind::Out  => { locked_out.insert(id); }
                NodeLockKind::Both => { locked_in.insert(id); locked_out.insert(id); }
            }
        }
    }

    PresetState { blocked, locked_out, locked_in, preset_connected, preset_edges }
}

#[cfg(test)]
#[path = "preset_state_tests.rs"]
mod tests;
