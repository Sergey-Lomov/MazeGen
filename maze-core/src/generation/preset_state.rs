use std::collections::{BTreeSet, HashSet};
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use super::{PresetConnection, PresetConnectionState, LockedNode, NodeLockKind};

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
}

/// Build PresetState and apply Passage/OneWay edges to the graph before generation.
pub fn build_preset_state<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    preset_connections: &[PresetConnection],
    locked_nodes: &[LockedNode],
    xy_to_point: impl Fn(i32, i32) -> T::Point,
) -> PresetState {
    let mut blocked:          HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut locked_out:       HashSet<NodeId> = HashSet::new();
    let mut locked_in:        HashSet<NodeId> = HashSet::new();
    let mut preset_connected: BTreeSet<NodeId> = BTreeSet::new();
    let mut preset_edges: HashSet<(NodeId, NodeId)> = HashSet::new();

    for preset in preset_connections {
        let from_pt = xy_to_point(preset.from.0, preset.from.1);
        let to_pt   = xy_to_point(preset.to.0,   preset.to.1);
        let Some(from_id) = field.node_at(from_pt) else { continue; };
        let Some(to_id)   = field.node_at(to_pt)   else { continue; };

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
            }
            PresetConnectionState::OneWayForward => {
                graph.build_initial_edge(from_id, to_id, EdgeKind::Basic);
                blocked.insert((to_id, from_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
            }
            PresetConnectionState::OneWayBackward => {
                graph.build_initial_edge(to_id, from_id, EdgeKind::Basic);
                blocked.insert((from_id, to_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((to_id, from_id));
            }
        }
    }

    for lock in locked_nodes {
        let pt = xy_to_point(lock.point.0, lock.point.1);
        let Some(id) = field.node_at(pt) else { continue; };
        match lock.kind {
            NodeLockKind::In   => { locked_in.insert(id); }
            NodeLockKind::Out  => { locked_out.insert(id); }
            NodeLockKind::Both => { locked_in.insert(id); locked_out.insert(id); }
        }
    }

    PresetState { blocked, locked_out, locked_in, preset_connected, preset_edges }
}

#[cfg(test)]
#[path = "preset_state_tests.rs"]
mod tests;
