use std::collections::{BTreeSet, HashMap, HashSet};
use crate::ids::{IdGenerator, NodeId};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::EventLog;
use super::{PresetConnection, PresetConnectionState, PresetEndpoint, TeleportDirection, LockedNode, NodeLockKind};
use super::preset_setup_event::{emit, PresetSetupEvent};

/// Resolved preset constraints in NodeId space, ready for use by generation algorithms.
#[derive(Debug)]
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
    /// Outgoing preset-Teleport destinations per source node — unlike `preset_connected`, a
    /// teleport pair isn't geometrically adjacent, so algorithms can't discover it via
    /// `field.neighbors`. Every generation algorithm must treat these as traversable extra
    /// neighbors of their source node (GitHub issue #226) so a preset teleport is followed into
    /// the algorithm's own visited/reachability tracking exactly like a dynamically-added one.
    pub preset_teleports: HashMap<NodeId, Vec<NodeId>>,
    /// Per-point sorted slot list built while applying `split_points` (GitHub issue #231) — the
    /// same map `build_preset_state`'s own endpoint resolution uses internally. Exposed via
    /// `resolve_endpoint` so callers can resolve `preset_start`/`preset_finish`/
    /// `preset_gen_source` (markers outside `GenerationConfig.preset_connections`/`.locked_nodes`)
    /// against the exact same already-applied split nodes, without re-deriving the resolution
    /// logic. Empty when `for_repair`'s `qc_experiment` branch clears everything else too.
    pub(crate) slots_by_point: HashMap<(i32, i32), Vec<u32>>,
}

impl PresetState {
    pub fn empty() -> Self {
        Self {
            blocked:         HashSet::new(),
            locked_out:      HashSet::new(),
            locked_in:       HashSet::new(),
            preset_connected: BTreeSet::new(),
            preset_edges:    HashSet::new(),
            preset_teleports: HashMap::new(),
            slots_by_point:  HashMap::new(),
        }
    }

    /// Resolves which `PresetState` `build_maze`'s repair pass should actually see — QC
    /// experiment mode has no preset protection at all (the graph already reflects the preset
    /// setup; only the repair-time constraints are dropped), a normal run keeps `self` as-is.
    /// Shared by `maze-wasm` and `maze-runner` so both stay in sync — see `Specs/generation.md`.
    pub fn for_repair(self, qc_experiment: bool) -> Self {
        if qc_experiment { Self::empty() } else { self }
    }

    /// Resolves a `PresetEndpoint` (e.g. `preset_start`/`preset_finish`/`preset_gen_source`) to a
    /// real `NodeId` on `field`, against the same split nodes `build_preset_state` already
    /// applied to it — must be called with the same `field`/`xy_to_point` used to build this
    /// `PresetState`. Returns `None` for an unresolvable endpoint (unknown point, or an
    /// undeclared slot), same "silently unresolved" contract `build_preset_state` uses internally.
    pub fn resolve_endpoint<T: Tessellation>(
        &self,
        field: &Field<T>,
        xy_to_point: impl Fn(i32, i32) -> T::Point,
        endpoint: PresetEndpoint,
    ) -> Option<NodeId> {
        resolve_preset_endpoint(field, &self.slots_by_point, &xy_to_point, endpoint)
    }
}

/// Applies `split_points` to `field` via `Field::add_node_at`, in `(point, slot)`-sorted order
/// (mirrors `apply_split_points` in `maze-wasm/src/analytics.rs` for post-edit's split nodes —
/// same rationale: a deterministic order so `(point, slot) -> NodeId` doesn't depend on input
/// order). Returns a resolver mapping `PresetEndpoint` to a real `NodeId`: `slot: None` resolves
/// to the point's original node (`nodes_at(point)[0]`); `slot: Some(s)` resolves to whichever node
/// `add_node_at` created for `s` (`nodes_at(point)[1 + index]`, where `index` is `s`'s position in
/// the sorted slot list for that point — see `Field::nodes_at`'s creation-order contract).
///
/// Returns `Err` (never panics) if `split_points` references a point outside `field` — the caller
/// is expected to have already filtered these client-side (see `Specs/preset-connections.md`'s
/// "Split nodes" section), but this is not assumed; `Field::add_node_at` panics on an unknown
/// point, so this guards against it explicitly, same defense-in-depth `apply_split_points` uses.
fn apply_split_points<T: Tessellation>(
    field: &mut Field<T>,
    graph: &mut Graph,
    ids: &mut IdGenerator,
    split_points: &[((i32, i32), u32)],
    xy_to_point: &impl Fn(i32, i32) -> T::Point,
) -> Result<HashMap<(i32, i32), Vec<u32>>, String> {
    let mut sorted: Vec<((i32, i32), u32)> = split_points.to_vec();
    sorted.sort_unstable();

    let mut slots_by_point: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    for (xy, slot_id) in sorted {
        let point = xy_to_point(xy.0, xy.1);
        if !field.contains(point) {
            return Err(format!("split_points references unknown point {xy:?}"));
        }
        let node = field.add_node_at(point, ids);
        graph.add_node(node);
        slots_by_point.entry(xy).or_default().push(slot_id);
    }
    Ok(slots_by_point)
}

/// Resolves one `PresetEndpoint` to a real `NodeId`. `slots_by_point` is the per-point sorted
/// slot list `apply_split_points` just built (already sorted — insertion order there is the sort
/// order). Returns `None` if the point isn't in the field, or if `slot: Some(s)` names a slot not
/// present in `slots_by_point` for that point.
fn resolve_preset_endpoint<T: Tessellation>(
    field: &Field<T>,
    slots_by_point: &HashMap<(i32, i32), Vec<u32>>,
    xy_to_point: &impl Fn(i32, i32) -> T::Point,
    endpoint: PresetEndpoint,
) -> Option<NodeId> {
    let point = xy_to_point(endpoint.point.0, endpoint.point.1);
    let nodes = field.nodes_at(point);
    match endpoint.slot {
        None => nodes.first().copied(),
        Some(slot) => {
            let slots = slots_by_point.get(&endpoint.point)?;
            let index = slots.iter().position(|&s| s == slot)?;
            nodes.get(1 + index).copied()
        }
    }
}

/// Build PresetState and apply Passage/OneWay edges to the graph before generation.
///
/// `log`, when given, receives one [`PresetSetupEvent`] per preset connection that actually
/// establishes an edge (`Wall` blocks a pair without adding anything, so it emits nothing) —
/// narration for the "preset setup" debug-tape source (GitHub issue #225), built inline here since
/// this is the only place that still has each connection's resolved `from`/`to`/direction.
///
/// Every `PresetConnection`/`LockedNode` endpoint resolves to exactly one `NodeId` (GitHub issue
/// #231) — `slot: None` means the point's original node, `slot: Some(s)` means that specific split
/// node. This replaced the earlier #219/#220 broadcast behavior (applying a preset to every node
/// at a point, since presets couldn't address a specific one yet) — an unresolvable endpoint
/// (unknown point, or a `slot` not declared in `split_points`) is silently skipped, same as the
/// old "point out of bounds" skip.
///
/// `split_points` (declared extra nodes) is applied to `field` before any preset/lock is resolved
/// — see `apply_split_points` above.
pub fn build_preset_state<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    preset_connections: &[PresetConnection],
    locked_nodes: &[LockedNode],
    split_points: &[((i32, i32), u32)],
    xy_to_point: impl Fn(i32, i32) -> T::Point,
    mut log: Option<&mut EventLog<PresetSetupEvent>>,
) -> Result<PresetState, String> {
    let mut blocked:          HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut locked_out:       HashSet<NodeId> = HashSet::new();
    let mut locked_in:        HashSet<NodeId> = HashSet::new();
    let mut preset_connected: BTreeSet<NodeId> = BTreeSet::new();
    let mut preset_edges: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut preset_teleports: HashMap<NodeId, Vec<NodeId>> = HashMap::new();

    let slots_by_point = apply_split_points(field, graph, ids, split_points, &xy_to_point)?;
    let resolve = |ep: PresetEndpoint| resolve_preset_endpoint(field, &slots_by_point, &xy_to_point, ep);

    for preset in preset_connections {
        let (Some(from_id), Some(to_id)) = (resolve(preset.from), resolve(preset.to)) else { continue };
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
                        preset_teleports.entry(from_id).or_default().push(to_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: from_id, to: to_id, two_way: false });
                        }
                    }
                    TeleportDirection::Backward => {
                        graph.build_initial_edge(to_id, from_id, EdgeKind::Teleport);
                        preset_edges.insert((to_id, from_id));
                        preset_teleports.entry(to_id).or_default().push(from_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: to_id, to: from_id, two_way: false });
                        }
                    }
                    TeleportDirection::TwoWay => {
                        graph.build_initial_edge(from_id, to_id, EdgeKind::Teleport);
                        graph.build_initial_edge(to_id, from_id, EdgeKind::Teleport);
                        preset_edges.insert((from_id, to_id));
                        preset_edges.insert((to_id, from_id));
                        preset_teleports.entry(from_id).or_default().push(to_id);
                        preset_teleports.entry(to_id).or_default().push(from_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(log, PresetSetupEvent::TeleportEstablished { from: from_id, to: to_id, two_way: true });
                        }
                    }
                }
                // Not added to `preset_connected` — that set exists only to short-circuit
                // the geometric-adjacency generation loop for adjacent preset pairs (see
                // edge_based.rs). A teleport pair is not geometrically adjacent, so the
                // endpoints must still go through normal generation for their regular
                // connectivity.
            }
        }
    }

    for lock in locked_nodes {
        let Some(id) = resolve(lock.point) else { continue };
        match lock.kind {
            NodeLockKind::In   => { locked_in.insert(id); }
            NodeLockKind::Out  => { locked_out.insert(id); }
            NodeLockKind::Both => { locked_in.insert(id); locked_out.insert(id); }
        }
    }

    Ok(PresetState { blocked, locked_out, locked_in, preset_connected, preset_edges, preset_teleports, slots_by_point })
}

#[cfg(test)]
#[path = "preset_state_tests.rs"]
mod tests;
