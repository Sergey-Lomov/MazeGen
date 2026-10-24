use super::preset_setup_event::{PresetSetupEvent, emit};
use super::{
    ElementPlacementRules, GeneratedElementKind, LockedNode, NodeLockKind, PresetConnection,
    PresetConnectionState, PresetElevator, PresetEndpoint, PresetVerticalPassage,
    TeleportDirection, VerticalPassageDirection,
};
use crate::event_log::EventLog;
use crate::graph::{EdgeKind, Graph};
use crate::ids::{IdGenerator, NodeId};
use crate::space::{MultiLevelField, Tessellation};
use std::collections::{BTreeSet, HashMap, HashSet};

/// Slot map for preset split-tile teleports keyed by `(level, x, y)`, plus the set of nodes
/// already claimed by a preset split point.
type PresetTeleportBuild = (HashMap<(u32, i32, i32), Vec<u32>>, HashSet<NodeId>);

/// Resolved preset constraints in NodeId space, ready for use by generation algorithms.
#[derive(Debug)]
pub struct PresetState {
    /// Placement rules for endpoints selected automatically by a repair strategy. They live here
    /// because endpoint selection is part of quality-control repair, after initial generation.
    /// Explicit preset endpoints remain an intentional user choice and are never filtered.
    pub element_placement_rules: Option<ElementPlacementRules>,
    /// Edges the algorithm must not add (Wall presets).
    pub blocked: HashSet<(NodeId, NodeId)>,
    /// Nodes the algorithm must not add outgoing edges from.
    pub locked_out: HashSet<NodeId>,
    /// Nodes the algorithm must not add incoming edges to.
    pub locked_in: HashSet<NodeId>,
    /// Nodes already connected by preset Passage/OneWay edges — treated as visited at generation start.
    pub preset_connected: BTreeSet<NodeId>,
    /// Directed edges established by preset Passage/OneWay connections — must not be removed by repair.
    pub preset_edges: HashSet<(NodeId, NodeId)>,
    /// `EdgeId`s of every edge planted by a preset connection of any kind (Basic Passage/OneWay,
    /// Teleport, VerticalPassage, Elevator) — the exact edges repair must never remove, keyed by id
    /// so a *different* edge on the same node pair (e.g. a user Teleport parallel to a preset Basic
    /// passage) is still removable. `preset_edges` above is pair-keyed and kind-agnostic by design
    /// (generation algorithms and `is_preset_locked_node` need the pair-level view); this is the
    /// per-edge companion `try_remove_edge_by_id` consults so a preset Teleport / VerticalPassage /
    /// Elevator is protected too, not only preset `EdgeKind::Basic`.
    pub preset_edge_ids: HashSet<crate::ids::EdgeId>,
    /// Outgoing preset-Teleport destinations per source node — unlike `preset_connected`, a
    /// teleport pair isn't geometrically adjacent, so algorithms can't discover it via
    /// `field.neighbors`. Every generation algorithm must treat these as traversable extra
    /// neighbors of their source node (GitHub issue #226) so a preset teleport is followed into
    /// the algorithm's own visited/reachability tracking exactly like a dynamically-added one.
    pub preset_teleports: HashMap<NodeId, Vec<NodeId>>,
    /// Per-(level, point) sorted slot list built while applying `split_points` (GitHub issue #231;
    /// keyed by level too as of #340) — the same map `build_preset_state`'s own endpoint
    /// resolution uses internally. Exposed via `resolve_endpoint` so callers can resolve
    /// `preset_start`/`preset_finish`/`preset_gen_source` (markers outside
    /// `GenerationConfig.preset_connections`/`.locked_nodes`) against the exact same
    /// already-applied split nodes, without re-deriving the resolution logic. Empty when
    /// `for_repair`'s `qc_experiment` branch clears everything else too.
    pub(crate) slots_by_point: HashMap<(u32, i32, i32), Vec<u32>>,
    /// Nodes the preset snapshot currently declares as split nodes. On the generate path this is
    /// exactly the set `apply_split_points` minted in this call. On the post-edit path it's
    /// resolved fresh from the client's preset-split-points snapshot against the rebuilt field —
    /// "declared", not "minted here" — so this field must not be read as structural provenance,
    /// only as membership. Feeds `is_preset_locked_node`.
    pub preset_declared_nodes: HashSet<NodeId>,
    /// The node a `preset_start` marker resolves to, when the project pins the start explicitly
    /// (GitHub issue #376 follow-up). `None` when the start was chosen by the generator (farthest
    /// endpoints, a split reassignment, geometric default) rather than fixed by the user. Set by
    /// the runner after `build_preset_state`, since the marker is resolved outside this function;
    /// carried into repair by `for_repair`. Used only to flag a `start` element as `preset_locked`
    /// in issue payloads — a preset-pinned waypoint can't be moved by repair.
    pub preset_start: Option<NodeId>,
    /// The node a `preset_finish` marker resolves to — see `preset_start`.
    pub preset_finish: Option<NodeId>,
}

impl PresetState {
    /// Whether an automatically selected endpoint may occupy `node`. Unknown nodes are never
    /// candidates, so treating them as disallowed avoids a silent fallback outside the field.
    pub fn allows_generated_endpoint<T: Tessellation>(
        &self,
        field: &MultiLevelField<T>,
        kind: GeneratedElementKind,
        node: NodeId,
    ) -> bool {
        self.element_placement_rules.as_ref().is_none_or(|rules| {
            field
                .cell_of(node)
                .is_some_and(|cell| rules.allows(field.tessellation(), kind, cell))
        })
    }

    /// Whether the directed edge `from -> to` is a preset Passage/OneWay connection — the exact
    /// predicate `preset_edges` is keyed by, no sorting/canonicalization: a one-way preset only
    /// ever occupies one direction, and its reverse direction (`blocked`, not `preset_edges`) must
    /// never test positive here.
    pub fn is_preset_edge(&self, from: NodeId, to: NodeId) -> bool {
        self.preset_edges.contains(&(from, to))
    }

    /// Whether the edge with this exact `EdgeId` was planted by a preset connection — the per-edge,
    /// kind-agnostic protection `try_remove_edge_by_id` uses. See `preset_edge_ids`.
    pub fn is_preset_edge_id(&self, id: crate::ids::EdgeId) -> bool {
        self.preset_edge_ids.contains(&id)
    }

    /// Whether `node` is preset-locked for repair purposes: declared by the preset snapshot
    /// (`preset_declared_nodes`) and every incident directed edge (in either direction, any
    /// `EdgeKind` — Basic and Teleport both count uniformly, matching `is_preset_edge`'s own
    /// contract elsewhere) is preset-protected. A declared node with no incident edges is not
    /// locked (vacuous-truth guard, same pattern as `all_preset_locked`).
    ///
    /// Distinct from `is_node_locked_for_removal`: this predicate is about a node's own connection
    /// set (used by `InvalidSplitNodeIssue`-style per-node checks like
    /// `split_node_connection_count`, which flag a node for *its own* edges); the other is about
    /// whether repair's `RemoveNode`/`ReplacePointNodes` machinery can touch the node at all.
    pub fn is_preset_locked_node(&self, node: NodeId, graph: &Graph) -> bool {
        if !self.preset_declared_nodes.contains(&node) {
            return false;
        }
        let incident: Vec<_> = graph
            .edges()
            .filter(|e| e.from == node || e.to == node)
            .collect();
        !incident.is_empty() && incident.iter().all(|e| self.is_preset_edge(e.from, e.to))
    }

    /// Whether `node` is preset-protected against removal — the pure-preset slice of
    /// `generation::node_ops::node_removal_allowed` (its `locked_out`/`locked_in`/`preset_edges`/
    /// pinned-endpoint checks only, not the structural "last node at its point" check, which isn't a preset fact).
    /// This is the actual criterion `remove_node_feasible`/`replace_point_nodes_feasible` use to
    /// decline a repair command — the correct "can repair ever touch this node" predicate for
    /// split-tile/split-node issue payloads' `preset_locked` flag (GitHub issue #245), unlike
    /// `is_preset_locked_node` above, which only applies to preset-*declared* (minted) nodes and
    /// says nothing about a pre-existing tile node whose own preset edge still blocks its removal.
    /// A pinned `preset_start`/`preset_finish` node is locked too: it is the user's explicit
    /// choice, and removing it would silently move the endpoint (GitHub issue #753).
    pub fn is_node_locked_for_removal(&self, node: NodeId) -> bool {
        self.locked_out.contains(&node)
            || self.locked_in.contains(&node)
            || self.preset_start == Some(node)
            || self.preset_finish == Some(node)
            || self
                .preset_edges
                .iter()
                .any(|&(from, to)| from == node || to == node)
    }

    pub fn empty() -> Self {
        Self {
            element_placement_rules: None,
            blocked: HashSet::new(),
            locked_out: HashSet::new(),
            locked_in: HashSet::new(),
            preset_connected: BTreeSet::new(),
            preset_edges: HashSet::new(),
            preset_edge_ids: HashSet::new(),
            preset_teleports: HashMap::new(),
            slots_by_point: HashMap::new(),
            preset_declared_nodes: HashSet::new(),
            preset_start: None,
            preset_finish: None,
        }
    }

    /// Resolves which `PresetState` `build_maze`'s repair pass should actually see — QC
    /// experiment mode has no preset protection at all (the graph already reflects the preset
    /// setup; only the repair-time constraints are dropped), a normal run keeps `self` as-is.
    /// Shared by `maze-wasm` and `maze-runner` so both stay in sync — see `Specs/generation.md`.
    pub fn for_repair(self, qc_experiment: bool) -> Self {
        if qc_experiment {
            // QC experiment mode deliberately drops preset protections, but endpoint placement
            // remains a generator setting and must still constrain automatic endpoint repair.
            Self {
                element_placement_rules: self.element_placement_rules,
                ..Self::empty()
            }
        } else {
            self
        }
    }

    /// Resolves a `PresetEndpoint` (e.g. `preset_start`/`preset_finish`/`preset_gen_source`) to a
    /// real `NodeId` on `field`, against the same split nodes `build_preset_state` already
    /// applied to it — must be called with the same `field`/`xy_to_cell` used to build this
    /// `PresetState`. Returns `Err` naming the endpoint when it is unresolvable (unknown
    /// point/level, or an undeclared slot), the same error `build_preset_state` reports.
    pub fn resolve_endpoint<T: Tessellation>(
        &self,
        field: &MultiLevelField<T>,
        xy_to_cell: impl Fn(i32, i32) -> T::CellId,
        endpoint: PresetEndpoint,
    ) -> Result<NodeId, String> {
        resolve_preset_endpoint(field, &self.slots_by_point, &xy_to_cell, endpoint)
    }
}

/// Resolves a 0-based `levels_ordered()` index to a real `LevelId`, `None` for an out-of-range
/// index. `field.levels_ordered()` yields levels in stable, deterministic order (level list is
/// fixed for the duration of a generation run), so this is a pure lookup.
fn level_id_at<T: Tessellation>(
    field: &MultiLevelField<T>,
    level_index: u32,
) -> Option<crate::space::LevelId> {
    field.levels_ordered().nth(level_index as usize)
}

/// Applies `split_points` to `field` via `MultiLevelField::add_node_at`, in
/// `(level, point, slot)`-sorted order (mirrors `apply_split_points` in
/// `maze-wasm/src/analytics.rs` for post-edit's split nodes — same rationale: a deterministic
/// order so `(level, point, slot) -> NodeId` doesn't depend on input order). Returns a resolver
/// mapping `PresetEndpoint` to a real `NodeId`: `slot: None` resolves to the point's original node
/// (`nodes_at(level, point)[0]`); `slot: Some(s)` resolves to whichever node `add_node_at` created
/// for `s` (`nodes_at(level, point)[1 + index]`, where `index` is `s`'s position in the sorted
/// slot list for that `(level, point)` — see `Field::nodes_at`'s creation-order contract). Also
/// returns the set of `NodeId`s actually minted by `add_node_at` in this call — feeds
/// `PresetState.preset_declared_nodes`.
///
/// Returns `Err` (never panics) if `split_points` references a point outside `field` or a level
/// index outside `levels_ordered()` — the caller is expected to have already filtered these
/// client-side (see `Specs/preset-connections.md`'s "Split nodes" section), but this is not
/// assumed; `MultiLevelField::add_node_at` panics on an unknown level/point, so this guards
/// against it explicitly, same defense-in-depth `apply_split_points` uses.
fn apply_split_points<T: Tessellation>(
    field: &mut MultiLevelField<T>,
    graph: &mut Graph,
    ids: &mut IdGenerator,
    split_points: &[((i32, i32), u32, u32)],
    xy_to_cell: &impl Fn(i32, i32) -> T::CellId,
    mut debug_state: Option<&mut super::DebugGenerationState<T>>,
) -> Result<PresetTeleportBuild, String> {
    // Sort by (level, point, slot) — `((i32,i32), u32, u32)`'s natural tuple order sorts by point
    // first, so re-key to (level_index, point, slot) before sorting.
    let mut sorted: Vec<(u32, (i32, i32), u32)> = split_points
        .iter()
        .map(|&(xy, slot_id, level_index)| (level_index, xy, slot_id))
        .collect();
    sorted.sort_unstable();

    let mut slots_by_point: HashMap<(u32, i32, i32), Vec<u32>> = HashMap::new();
    let mut minted_nodes: HashSet<NodeId> = HashSet::new();
    for (level_index, xy, slot_id) in sorted {
        let level = level_id_at(field, level_index)
            .ok_or_else(|| format!("split_points references unknown level {level_index}"))?;
        let point = xy_to_cell(xy.0, xy.1);
        if field.field_of(level).is_none_or(|f| !f.contains(point)) {
            return Err(format!(
                "split_points references unknown point {xy:?} on level {level_index}"
            ));
        }
        let node = field.add_node_at(level, point, ids);
        graph.add_node(node);
        minted_nodes.insert(node);
        if let Some(state) = debug_state.as_deref_mut() {
            state.note(node, point);
        }
        slots_by_point
            .entry((level_index, xy.0, xy.1))
            .or_default()
            .push(slot_id);
    }
    Ok((slots_by_point, minted_nodes))
}

/// Resolves one `PresetEndpoint` to a real `NodeId`. `slots_by_point` is the per-(level, point)
/// sorted slot list `apply_split_points` just built (already sorted — insertion order there is
/// the sort order). Returns `Err` naming the endpoint if the level index is out of range, the point
/// isn't in the field, or `slot: Some(s)` names a slot not present in `slots_by_point` for that
/// (level, point).
fn resolve_preset_endpoint<T: Tessellation>(
    field: &MultiLevelField<T>,
    slots_by_point: &HashMap<(u32, i32, i32), Vec<u32>>,
    xy_to_cell: &impl Fn(i32, i32) -> T::CellId,
    endpoint: PresetEndpoint,
) -> Result<NodeId, String> {
    let level_index = endpoint.level.unwrap_or(0);
    let (x, y) = endpoint.point;
    let level = level_id_at(field, level_index)
        .ok_or_else(|| format!("preset endpoint references unknown level {level_index}"))?;
    let point = xy_to_cell(x, y);
    let nodes = field.nodes_at(level, point);
    let original = nodes.first().copied().ok_or_else(|| {
        format!("preset endpoint references unknown point [{x}, {y}] on level {level_index}")
    })?;
    match endpoint.slot {
        None => Ok(original),
        Some(slot) => slots_by_point
            .get(&(level_index, x, y))
            .and_then(|slots| slots.iter().position(|&s| s == slot))
            .and_then(|index| nodes.get(1 + index).copied())
            .ok_or_else(|| {
                format!(
                    "preset endpoint references undeclared slot {slot} at [{x}, {y}] on level {level_index}"
                )
            }),
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
/// node; `level: None` means level 0 (GitHub issue #340), `level: Some(i)` means the level at
/// position `i` in `levels_ordered()`. This replaced the earlier #219/#220 broadcast behavior
/// (applying a preset to every node at a point, since presets couldn't address a specific one
/// yet) — an unresolvable endpoint (unknown point/level, or a `slot` not declared in
/// `split_points` for that level) makes the whole call return `Err` naming the endpoint.
///
/// `split_points` (declared extra nodes) is applied to `field` before any preset/lock is resolved
/// — see `apply_split_points` above.
#[allow(clippy::too_many_arguments)]
pub fn build_preset_state<T: Tessellation>(
    graph: &mut Graph,
    field: &mut MultiLevelField<T>,
    ids: &mut IdGenerator,
    preset_connections: &[PresetConnection],
    preset_vertical_passages: &[PresetVerticalPassage],
    preset_elevators: &[PresetElevator],
    locked_nodes: &[LockedNode],
    split_points: &[((i32, i32), u32, u32)],
    xy_to_cell: impl Fn(i32, i32) -> T::CellId,
    mut log: Option<&mut EventLog<PresetSetupEvent>>,
    debug_state: Option<&mut super::DebugGenerationState<T>>,
) -> Result<PresetState, String> {
    let mut blocked: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut locked_out: HashSet<NodeId> = HashSet::new();
    let mut locked_in: HashSet<NodeId> = HashSet::new();
    let mut preset_connected: BTreeSet<NodeId> = BTreeSet::new();
    let mut preset_edges: HashSet<(NodeId, NodeId)> = HashSet::new();
    let mut preset_edge_ids: HashSet<crate::ids::EdgeId> = HashSet::new();
    let mut preset_teleports: HashMap<NodeId, Vec<NodeId>> = HashMap::new();

    let (slots_by_point, preset_declared_nodes) =
        apply_split_points(field, graph, ids, split_points, &xy_to_cell, debug_state)?;
    let resolve =
        |ep: PresetEndpoint| resolve_preset_endpoint(field, &slots_by_point, &xy_to_cell, ep);

    for preset in preset_connections {
        let (from_id, to_id) = (resolve(preset.from)?, resolve(preset.to)?);
        match preset.state {
            PresetConnectionState::Wall => {
                blocked.insert((from_id, to_id));
                blocked.insert((to_id, from_id));
            }
            PresetConnectionState::Passage => {
                preset_edge_ids.insert(graph.build_initial_edge(from_id, to_id, EdgeKind::Basic));
                preset_edge_ids.insert(graph.build_initial_edge(to_id, from_id, EdgeKind::Basic));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::PassageEstablished {
                            from: from_id,
                            to: to_id,
                        },
                    );
                }
            }
            PresetConnectionState::OneWayForward => {
                preset_edge_ids.insert(graph.build_initial_edge(from_id, to_id, EdgeKind::Basic));
                blocked.insert((to_id, from_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::OneWayEstablished {
                            from: from_id,
                            to: to_id,
                        },
                    );
                }
            }
            PresetConnectionState::OneWayBackward => {
                preset_edge_ids.insert(graph.build_initial_edge(to_id, from_id, EdgeKind::Basic));
                blocked.insert((from_id, to_id));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::OneWayEstablished {
                            from: to_id,
                            to: from_id,
                        },
                    );
                }
            }
            PresetConnectionState::Teleport(direction) => {
                match direction {
                    TeleportDirection::Forward => {
                        preset_edge_ids.insert(graph.build_initial_edge(
                            from_id,
                            to_id,
                            EdgeKind::Teleport,
                        ));
                        preset_edges.insert((from_id, to_id));
                        preset_teleports.entry(from_id).or_default().push(to_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(
                                log,
                                PresetSetupEvent::TeleportEstablished {
                                    from: from_id,
                                    to: to_id,
                                    two_way: false,
                                },
                            );
                        }
                    }
                    TeleportDirection::Backward => {
                        preset_edge_ids.insert(graph.build_initial_edge(
                            to_id,
                            from_id,
                            EdgeKind::Teleport,
                        ));
                        preset_edges.insert((to_id, from_id));
                        preset_teleports.entry(to_id).or_default().push(from_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(
                                log,
                                PresetSetupEvent::TeleportEstablished {
                                    from: to_id,
                                    to: from_id,
                                    two_way: false,
                                },
                            );
                        }
                    }
                    TeleportDirection::TwoWay => {
                        preset_edge_ids.insert(graph.build_initial_edge(
                            from_id,
                            to_id,
                            EdgeKind::Teleport,
                        ));
                        preset_edge_ids.insert(graph.build_initial_edge(
                            to_id,
                            from_id,
                            EdgeKind::Teleport,
                        ));
                        preset_edges.insert((from_id, to_id));
                        preset_edges.insert((to_id, from_id));
                        preset_teleports.entry(from_id).or_default().push(to_id);
                        preset_teleports.entry(to_id).or_default().push(from_id);
                        if let Some(log) = log.as_deref_mut() {
                            emit(
                                log,
                                PresetSetupEvent::TeleportEstablished {
                                    from: from_id,
                                    to: to_id,
                                    two_way: true,
                                },
                            );
                        }
                    }
                }
                // Not added to `preset_connected` — that set exists only to short-circuit
                // the geometric-adjacency generation loop for adjacent preset pairs. A
                // teleport pair is not geometrically adjacent, so the endpoints must still
                // go through normal generation for their regular connectivity.
            }
        }
    }

    // Preset `VerticalPassage`/`Elevator` (GitHub issue #357) — planted directly into the graph
    // exactly like preset `Passage`/`OneWay` (guaranteed structural connections, added to
    // `preset_connected`/`preset_edges` so repair must not remove them), never added to
    // `preset_teleports` — unlike a preset teleport, these aren't an *optional* extra-traversable
    // shortcut; every generation algorithm already discovers a planted edge through the graph
    // itself, the same way it discovers any other pre-existing edge at start.
    for passage in preset_vertical_passages {
        let (from_id, to_id) = (resolve(passage.from)?, resolve(passage.to)?);
        match passage.one_way {
            None => {
                preset_edge_ids.insert(graph.build_initial_edge(
                    from_id,
                    to_id,
                    EdgeKind::VerticalPassage,
                ));
                preset_edge_ids.insert(graph.build_initial_edge(
                    to_id,
                    from_id,
                    EdgeKind::VerticalPassage,
                ));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::VerticalPassageEstablished {
                            from: from_id,
                            to: to_id,
                            two_way: true,
                        },
                    );
                }
            }
            Some(VerticalPassageDirection::Forward) => {
                preset_edge_ids.insert(graph.build_initial_edge(
                    from_id,
                    to_id,
                    EdgeKind::VerticalPassage,
                ));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((from_id, to_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::VerticalPassageEstablished {
                            from: from_id,
                            to: to_id,
                            two_way: false,
                        },
                    );
                }
            }
            Some(VerticalPassageDirection::Backward) => {
                preset_edge_ids.insert(graph.build_initial_edge(
                    to_id,
                    from_id,
                    EdgeKind::VerticalPassage,
                ));
                preset_connected.insert(from_id);
                preset_connected.insert(to_id);
                preset_edges.insert((to_id, from_id));
                if let Some(log) = log.as_deref_mut() {
                    emit(
                        log,
                        PresetSetupEvent::VerticalPassageEstablished {
                            from: to_id,
                            to: from_id,
                            two_way: false,
                        },
                    );
                }
            }
        }
    }

    for elevator in preset_elevators {
        let node_ids: Vec<NodeId> = elevator
            .floors
            .iter()
            .map(|&ep| resolve(ep))
            .collect::<Result<_, _>>()?;
        // Fewer than 2 floors means no fan to connect.
        if node_ids.len() < 2 {
            continue;
        }
        for i in 0..node_ids.len() {
            for j in (i + 1)..node_ids.len() {
                let (a, b) = (node_ids[i], node_ids[j]);
                let (fwd, bwd) = graph.build_initial_bidirectional_edge(a, b, EdgeKind::Elevator);
                preset_edge_ids.insert(fwd);
                preset_edge_ids.insert(bwd);
                preset_connected.insert(a);
                preset_connected.insert(b);
                preset_edges.insert((a, b));
                preset_edges.insert((b, a));
            }
        }
        if let Some(log) = log.as_deref_mut() {
            emit(
                log,
                PresetSetupEvent::ElevatorEstablished { nodes: node_ids },
            );
        }
    }

    for lock in locked_nodes {
        let id = resolve(lock.point)?;
        match lock.kind {
            NodeLockKind::In => {
                locked_in.insert(id);
            }
            NodeLockKind::Out => {
                locked_out.insert(id);
            }
            NodeLockKind::Both => {
                locked_in.insert(id);
                locked_out.insert(id);
            }
        }
    }

    Ok(PresetState {
        element_placement_rules: None,
        blocked,
        locked_out,
        locked_in,
        preset_connected,
        preset_edges,
        preset_edge_ids,
        preset_teleports,
        slots_by_point,
        preset_declared_nodes,
        preset_start: None,
        preset_finish: None,
    })
}

#[cfg(test)]
#[path = "preset_state_tests.rs"]
mod tests;
