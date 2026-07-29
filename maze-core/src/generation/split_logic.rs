use std::collections::HashSet;
use rand::Rng;
use crate::ids::{IdGenerator, NodeId};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::ScopeGuard;
use super::{ElementsConfig, PresetState, GenerationParams};
use super::debug_state::DebugGenerationState;
use super::split_pattern::{SplitGenerationConfig, SplitPattern, SplitFaceRequirement, OneWayDirection};
use super::edge_ops::{try_add_edge, try_add_edge_kind};
use super::vertex_based::{VertexBasedEvent, GenState, run_ordinary_step_body_for_node, add_to_frontier, add_edge_and_detect_direction};

/// Result of a split attempt — a 3-way outcome (rather than a plain bool/`Option`) purely so unit
/// tests can assert *why* a split didn't happen without parsing the event log. Every variant other
/// than `Handled` means the caller must proceed exactly as it would have without this feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SplitOutcome {
    /// The split path fully handled `src` for this step — caller skips its own ordinary logic.
    Handled,
    /// The split roll missed.
    Miss,
    /// The roll hit, but `src`'s tile is not eligible for splitting at all (locked, or already
    /// pre-split via `split_points`).
    Ineligible,
    /// Pattern mode rolled a hit on an eligible node, but no pattern (or no adaptation of any
    /// pattern) could be found — falls back to ordinary handling exactly like a miss.
    NoAdaptation,
}

/// A run's start-node reassignment when the traversal-seed node itself gets split — `generate`
/// only ever receives a plain `start: NodeId` and has no notion of `Maze::meta`, so this is
/// threaded back out to the caller (`run_generate`/`run_generate_typed`) as an out-parameter,
/// applied only when there's no explicit `preset_start` pinning the original choice.
#[derive(Debug, Clone, Copy)]
pub struct StartReassignment {
    pub original: NodeId,
    pub reassigned_to: NodeId,
}

/// Whole-node eligibility gate, checked before any per-face logic: any lock at all disqualifies
/// splitting entirely (a lock pins down topology, a split shouldn't touch that tile at all), and a
/// point that already has more than one node (a pre-generation `split_points` declaration — the
/// only way a point could already be multi-node at generation time, post-edit splits happen after
/// generation) is never double-split.
pub(crate) fn split_is_eligible<T: Tessellation>(
    field: &Field<T>,
    preset_state: &PresetState,
    src: NodeId,
) -> bool {
    if preset_state.locked_out.contains(&src) || preset_state.locked_in.contains(&src) {
        return false;
    }
    let Some(point) = field.point_of(src) else { return false; };
    field.nodes_at(point).len() <= 1
}

/// Shared split-roll entry point, called from `step_from_frontier` and both `handle_empty_frontier`
/// branches. Rolls `split_chance` (always consumed, regardless of value — same RNG-parity
/// discipline as `teleport_chance`/`cyclicity`), then on a hit checks eligibility and dispatches to
/// the pattern or non-pattern path. `bridge` is the pre-existing already-visited node the ordinary
/// flow would unconditionally have connected `src` to this step (`None` from `step_from_frontier`,
/// `Some` from either `handle_empty_frontier` branch) — both split paths must honor that guarantee
/// instead of silently dropping it. `parent` is `src`'s real, already-in-graph incoming/outgoing
/// edge partner (`FrontierEntry.parent`, `Some` only from `step_from_frontier` — `handle_empty_frontier`'s
/// two branches pick `src` from `reserve`/a teleport-bridge pool, where no such edge exists yet)
/// — pattern mode's `enumerate_adaptations` treats a face resolving to `parent` specially: instead
/// of rejecting it as "targets an already-visited neighbor", it accepts the face only if its
/// requirement's direction matches the real edge already in `graph` (see that function's own doc
/// comment), and `apply_pattern_adaptation` then reuses the existing edge instead of adding a new
/// one.
#[allow(clippy::too_many_arguments)]
pub(super) fn try_split_src<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) -> SplitOutcome {
    let roll = state.rng.random::<f64>();
    let fired = roll < elements.split_chance;
    let eligible = fired && split_is_eligible(field, preset_state, src);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitRolled { src, roll, split_chance: elements.split_chance, fired, eligible });
    }
    if !fired {
        return SplitOutcome::Miss;
    }
    if !eligible {
        return SplitOutcome::Ineligible;
    }

    if split_config.pattern_mode {
        handle_pattern_split(
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, bridge, parent, start, start_reassignment, scope, debug_state,
        )
    } else {
        handle_non_pattern_split(
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, bridge, start, start_reassignment, scope, debug_state,
        );
        SplitOutcome::Handled
    }
}

/// Mints `count - 1` new nodes at `src`'s point (total `count` including `src`), syncing
/// `state.all_nodes` immediately so later-in-event RNG pools (teleport-connect, cyclic-widened
/// pool) see them.
fn mint_split_nodes<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    src: NodeId,
    count: usize,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) -> Vec<NodeId> {
    let point = field.point_of(src).expect("src must be in field");
    let mut nodes = vec![src];
    for _ in 1..count {
        let node = field.add_node_at(point, ids);
        graph.add_node(node);
        if let Some(state) = debug_state.as_deref_mut() {
            state.note(node, point);
        }
        nodes.push(node);
    }
    nodes
}

/// Syncs newly minted nodes into `state.all_nodes`, re-sorted — must be called before this
/// event's own teleport-connect/cyclic-widened-pool candidates are built, otherwise a later "any
/// node in the graph" roll would never see them.
fn sync_all_nodes(state: &mut GenState, new_nodes: &[NodeId]) {
    state.all_nodes.extend_from_slice(new_nodes);
    state.all_nodes.sort_unstable();
}

/// Reassigns `start` to a uniformly random node among `src` and its newly minted siblings, if
/// `src == start` and no reassignment has happened yet (fires at most once per run). A no-op when
/// there's an explicit `preset_start` — the caller (`run_generate`/`run_generate_typed`) only
/// consults `start_reassignment` when `preset_start` was absent, so this always computes it
/// unconditionally; the caller decides whether to use it.
fn maybe_reassign_start(
    src: NodeId,
    all_split_nodes: &[NodeId],
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    state: &mut GenState,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    if src != start || start_reassignment.is_some() {
        return;
    }
    let idx = state.rng.random_range(0..all_split_nodes.len());
    let reassigned_to = all_split_nodes[idx];
    *start_reassignment = Some(StartReassignment { original: start, reassigned_to });
    if reassigned_to != start {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::SplitStartReassigned { original: start, reassigned_to });
        }
    }
}

/// Non-pattern split path: mints `max_split_nodes - 1` new nodes (total node count on the tile,
/// including `src`, is `max_split_nodes` — an exact count, `1` is a valid no-op), then processes
/// every one of the `max_split_nodes` nodes uniformly through `run_ordinary_step_body_for_node`
/// with `parent: None` (including `src` itself — a deliberate behavior change scoped to this split
/// event only, so every resulting node is treated identically instead of `src` being the odd one
/// out). Nodes are processed strictly in creation order (`src` first) — deterministic for a fixed
/// seed, each subsequent node sees every earlier one's connections as ordinary visited state.
/// `bridge`, when present, is connected to `src` (node 0) exactly as the ordinary flow would have,
/// out of band from `run_ordinary_step_body_for_node`'s own candidate pool. Teleport and cyclicity
/// are per-node (each node's own `run_ordinary_step_body_for_node` call rolls its own), matching
/// the ordinary flow's granularity — unlike pattern mode, which rolls both once per event.
#[allow(clippy::too_many_arguments)]
fn handle_non_pattern_split<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    bridge: Option<NodeId>,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let count = (split_config.max_split_nodes as usize).max(1);
    let nodes = mint_split_nodes(graph, field, ids, src, count, debug_state);
    sync_all_nodes(state, &nodes[1..]);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitNodesCreated { src, nodes: nodes.clone(), pattern: None });
    }
    maybe_reassign_start(src, &nodes, start, start_reassignment, state, scope.as_deref_mut());

    if let Some(bridge) = bridge {
        let added = add_edge_and_detect_direction(graph, bridge, src, |g| {
            try_add_edge(g, bridge, src, elements, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
        // `src` is processed synchronously by this same event's per-node loop below, not via a
        // later frontier pop — pushing it to `frontier` here (as the ordinary, non-split bridge
        // path does) would leave it stuck there permanently after that loop marks it visited,
        // causing a later `step_from_frontier` to pop and re-process it a second time (re-rolling
        // `split_chance` and re-running corridor/junction logic on an already-connected node).
        state.visited.insert(src);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
        }
    }

    // Every resulting node shares the same field point, so they'd all see the same geometric
    // neighbor pool — without partitioning, the first-processed node (`src`) could claim every
    // free neighbor via `choose_connect_targets`'s multi-candidate junction pick, leaving later
    // nodes with nothing left and no guaranteed connection at all (see GitHub issue #222's
    // non-pattern split, "isolated new node" follow-up). Instead, the pool is split up front,
    // round-robin by position, so each node only ever competes for its own share.
    let free_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|n| !state.visited.contains(n) && !state.in_frontier.contains(n))
        .collect();
    let mut allowed_per_node: Vec<HashSet<NodeId>> = vec![HashSet::new(); nodes.len()];
    for (i, n) in free_neighbors.into_iter().enumerate() {
        allowed_per_node[i % nodes.len()].insert(n);
    }

    for (i, &node) in nodes.iter().enumerate() {
        state.visited.insert(node);
        run_ordinary_step_body_for_node(graph, field, params, elements, preset_state, state, node, None, false, Some(&allowed_per_node[i]), scope.as_deref_mut());
    }

    // A node can still end up with zero free neighbors at all (the point simply didn't have
    // enough unvisited neighbors to go around) — partitioning the pool only prevents one node
    // from starving the others, it can't manufacture connections that don't exist. Guarantee
    // reachability by falling back to an already-visited geometric neighbor of the point (any
    // one, chosen at random) — preferring a neighbor no sibling of this same split event is
    // already connected to, so distinct split nodes don't all pile onto the same ordinary node
    // unless there's no other choice.
    for &node in &nodes {
        let has_edge = graph.outgoing_neighbors(node).next().is_some() || graph.incoming_neighbors(node).next().is_some();
        if has_edge {
            continue;
        }
        let visited_neighbors: Vec<NodeId> = field.neighbors(node)
            .into_iter()
            .filter(|n| state.visited.contains(n))
            .collect();
        if visited_neighbors.is_empty() {
            continue;
        }
        let sibling_targets: HashSet<NodeId> = nodes.iter()
            .flat_map(|&s| graph.outgoing_neighbors(s).chain(graph.incoming_neighbors(s)))
            .collect();
        let preferred: Vec<NodeId> = visited_neighbors.iter().copied().filter(|n| !sibling_targets.contains(n)).collect();
        let pool = if preferred.is_empty() { &visited_neighbors } else { &preferred };
        let dst = pool[state.rng.random_range(0..pool.len())];
        let added = add_edge_and_detect_direction(graph, node, dst, |g| {
            try_add_edge(g, node, dst, elements, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
    }

    apply_split_teleport(graph, elements, preset_state, state, &nodes, scope);
}

/// Rolls the split event's shared teleport connection once for the whole event (not per-node, in
/// either mode) — anchored to a uniformly random resulting node, added alongside whatever each
/// node's own corridor/junction/cyclic logic decided.
fn apply_split_teleport(
    graph: &mut Graph,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    nodes: &[NodeId],
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    let roll = state.rng.random::<f64>();
    let fired = roll < elements.teleport_chance;
    if !fired {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::SplitTeleportRolled { roll, teleport_chance: elements.teleport_chance, fired, anchor: None });
        }
        return;
    }
    let anchor = nodes[state.rng.random_range(0..nodes.len())];
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitTeleportRolled { roll, teleport_chance: elements.teleport_chance, fired, anchor: Some(anchor) });
    }
    let unvisited: Vec<NodeId> = state.all_nodes.iter().copied().filter(|n| !state.visited.contains(n)).collect();
    if unvisited.is_empty() {
        return;
    }
    let dst = unvisited[state.rng.random_range(0..unvisited.len())];
    let added = add_edge_and_detect_direction(graph, anchor, dst, |g| {
        try_add_edge_kind(g, anchor, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
    });
    if let Some((from, to, bidirectional)) = added {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::TeleportConnectAdded { src: from, dst: to, bidirectional });
        }
    }
    state.visited.insert(dst);
    state.in_reserve.remove(&dst);
    add_to_frontier(dst, Some(anchor), &mut state.frontier, &mut state.in_frontier);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: anchor });
    }
}

/// One face resolved against `src`'s actual field position for one candidate adaptation —
/// intermediate representation `enumerate_adaptations` builds and `adaptation_respects_presets`/
/// `apply_pattern_adaptation` consume.
#[derive(Debug, Clone)]
struct ResolvedFace {
    node_index: usize,
    requirement: SplitFaceRequirement,
    sibling_target: Option<usize>,
    /// `None` for a `Wall` face pointing off-field, or for a `sibling_target` face (no outside
    /// neighbor involved at all). `Some(neighbor)` otherwise.
    neighbor: Option<NodeId>,
}

#[derive(Debug, Clone)]
struct Adaptation {
    rotation: usize,
    mirror: bool,
    faces: Vec<ResolvedFace>,
}

/// Pattern path (GitHub issue #222): rolls cyclicity once for the whole event, then loops picking
/// a pattern by weight (excluding already-rejected ones), enumerating every rotation/mirror
/// adaptation, and retrying another pattern when none validate. Returns `SplitOutcome::NoAdaptation`
/// when every pattern is exhausted — same fallback as a missed roll.
#[allow(clippy::too_many_arguments)]
fn handle_pattern_split<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) -> SplitOutcome {
    let cyclic_roll = state.rng.random::<f64>();
    let cyclic_fired = cyclic_roll < params.cyclicity;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitCyclicRolled { src, roll: cyclic_roll, cyclicity: params.cyclicity, fired: cyclic_fired });
    }

    let mut remaining: Vec<usize> = (0..split_config.patterns.len()).collect();
    while !remaining.is_empty() {
        let total_weight: f64 = remaining.iter().map(|&i| split_config.patterns[i].weight.max(0.0)).sum();
        let pattern_idx = if total_weight <= 0.0 {
            remaining[state.rng.random_range(0..remaining.len())]
        } else {
            let mut pick = state.rng.random::<f64>() * total_weight;
            let mut chosen = remaining[0];
            for &i in &remaining {
                let w = split_config.patterns[i].weight.max(0.0);
                if pick < w {
                    chosen = i;
                    break;
                }
                pick -= w;
            }
            chosen
        };
        let pattern = &split_config.patterns[pattern_idx];

        let adaptations = enumerate_adaptations(graph, field, preset_state, &state.visited, pattern, src, bridge, parent, cyclic_fired);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PatternAdaptationsComputed { src, pattern: pattern_idx, count: adaptations.len() });
        }
        if adaptations.is_empty() {
            remaining.retain(|&i| i != pattern_idx);
            continue;
        }

        let chosen = &adaptations[state.rng.random_range(0..adaptations.len())];
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PatternAdaptationChosen { src, pattern: pattern_idx, rotation: chosen.rotation, mirror: chosen.mirror });
        }
        let node_count = pattern.node_count;
        let faces = chosen.faces.clone();
        apply_pattern_adaptation(
            graph, field, ids, elements, preset_state, state,
            src, parent, node_count, &faces, pattern_idx, start, start_reassignment, scope, debug_state,
        );
        return SplitOutcome::Handled;
    }

    SplitOutcome::NoAdaptation
}

/// Deterministically enumerates every `rotation x mirror` combination of `pattern` against `src`'s
/// actual field position, filtering out invalid ones. **Pure, RNG-free** — the only RNG draw in
/// the whole pattern path is the single pick from this function's result, in `handle_pattern_split`.
/// A face is valid only if it lands on a real neighbor or is itself `Wall`; every `Passage`/
/// `OneWay` face must resolve to an unvisited neighbor, except at most one face (when
/// `cyclic_fired`) may target an already-visited one — and when `bridge` is `Some`, at least one
/// face must resolve specifically to `bridge` (the pre-existing connection the ordinary flow would
/// have made). Two faces claiming the same physical neighbor invalidates the adaptation. The whole
/// adaptation must also pass `adaptation_respects_presets`.
///
/// `parent`, when `Some`, is `src`'s real, already-in-`graph` edge partner (see `try_split_src`'s
/// doc comment) — exactly one face across every one of this event's resulting nodes must resolve to
/// it (same "must be targeted" requirement as `bridge`, checked independently), and that face's
/// requirement must match the *existing* edge's actual direction/kind exactly: `Passage` only if
/// both `src->parent` and `parent->src` already exist, `OneWay(Forward)` only if `src->parent`
/// exists and `parent->src` doesn't, `OneWay(Backward)` the reverse. A face resolving to `parent`
/// with a mismatching requirement invalidates the whole adaptation outright (no silent
/// reinterpretation) rather than falling through to the ordinary visited-neighbor check.
#[allow(clippy::too_many_arguments)]
fn enumerate_adaptations<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    preset_state: &PresetState,
    visited: &HashSet<NodeId>,
    pattern: &SplitPattern,
    src: NodeId,
    bridge: Option<NodeId>,
    parent: Option<NodeId>,
    cyclic_fired: bool,
) -> Vec<Adaptation> {
    let Some(point) = field.point_of(src) else { return Vec::new(); };
    let degree = T::faces().len();
    if degree == 0 {
        return Vec::new();
    }

    let parent_fwd = parent.is_some_and(|p| graph.edge_between(src, p).is_some());
    let parent_bwd = parent.is_some_and(|p| graph.edge_between(p, src).is_some());

    let mut results = Vec::new();
    for rotation in 0..degree {
        for mirror in [false, true] {
            let mut faces: Vec<ResolvedFace> = Vec::new();
            let mut used_neighbors: HashSet<NodeId> = HashSet::new();
            let mut visited_face_used = false;
            let mut bridge_targeted = bridge.is_none();
            let mut parent_targeted = parent.is_none();
            let mut valid = true;

            'nodes: for (node_index, node_faces) in pattern.faces.iter().enumerate() {
                for face in node_faces {
                    let Some(resolved_index) = transform_face_index(face.face_index, rotation, mirror, degree) else {
                        valid = false;
                        break 'nodes;
                    };
                    let Some(tess_face) = T::face_at(resolved_index) else {
                        valid = false;
                        break 'nodes;
                    };

                    if face.sibling_target.is_some() {
                        faces.push(ResolvedFace {
                            node_index,
                            requirement: face.requirement,
                            sibling_target: face.sibling_target,
                            neighbor: None,
                        });
                        continue;
                    }

                    let neighbor_point = T::step(point, tess_face);
                    let neighbor = field.nodes_at(neighbor_point).first().copied();

                    match face.requirement {
                        SplitFaceRequirement::Wall => {
                            faces.push(ResolvedFace { node_index, requirement: face.requirement, sibling_target: None, neighbor: None });
                        }
                        SplitFaceRequirement::Unspecified => {
                            faces.push(ResolvedFace { node_index, requirement: face.requirement, sibling_target: None, neighbor });
                        }
                        SplitFaceRequirement::Passage | SplitFaceRequirement::OneWay(_) => {
                            let Some(neighbor) = neighbor else {
                                valid = false;
                                break 'nodes;
                            };
                            if !used_neighbors.insert(neighbor) {
                                valid = false;
                                break 'nodes;
                            }
                            let is_bridge = bridge == Some(neighbor);
                            if is_bridge {
                                bridge_targeted = true;
                            }
                            let is_parent = parent == Some(neighbor);
                            if is_parent {
                                // The existing src<->parent edge's direction/kind must match this
                                // face's requirement exactly, or this adaptation is invalid — never
                                // silently reinterpreted as a fresh connection.
                                let matches = match face.requirement {
                                    SplitFaceRequirement::Passage => parent_fwd && parent_bwd,
                                    SplitFaceRequirement::OneWay(OneWayDirection::Forward) => parent_fwd && !parent_bwd,
                                    SplitFaceRequirement::OneWay(OneWayDirection::Backward) => parent_bwd && !parent_fwd,
                                    SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => false,
                                };
                                if !matches {
                                    valid = false;
                                    break 'nodes;
                                }
                                parent_targeted = true;
                            }
                            // Every Passage/OneWay face must resolve to an unvisited neighbor,
                            // except at most one (when cyclic_fired) may target an already-visited
                            // one — the bridge/parent targets are exempt from this check entirely,
                            // since both are by definition already visited.
                            if !is_bridge && !is_parent && visited.contains(&neighbor) {
                                if !cyclic_fired || visited_face_used {
                                    valid = false;
                                    break 'nodes;
                                }
                                visited_face_used = true;
                            }
                            faces.push(ResolvedFace { node_index, requirement: face.requirement, sibling_target: None, neighbor: Some(neighbor) });
                        }
                    }
                }
            }

            if !valid {
                continue;
            }
            if !bridge_targeted {
                continue;
            }
            if !parent_targeted {
                continue;
            }
            if !adaptation_respects_presets(src, &faces, preset_state) {
                continue;
            }

            results.push(Adaptation { rotation, mirror, faces });
        }
    }
    results
}

/// `(face_index + rotation) mod degree`, mirrored first via `(degree - face_index) % degree` when
/// `mirror` is set — spot-checked against each tessellation's actual `faces()` order via
/// dedicated unit tests (see `split_generation_test.rs`).
fn transform_face_index(face_index: usize, rotation: usize, mirror: bool, degree: usize) -> Option<usize> {
    if face_index >= degree {
        return None;
    }
    let base = if mirror { (degree - face_index) % degree } else { face_index };
    Some((base + rotation) % degree)
}

/// Only pattern-local node 0 (= `src`) is subject to any preset constraint — every newly minted
/// node is unconstrained, since `PresetState` physically can't know about a node that doesn't
/// exist yet at preset-resolution time. `locked_out`/`locked_in` on `src` forbids node 0 from an
/// outgoing/incoming `Passage`/`OneWay` face; a `blocked` pair forbids node 0's face toward that
/// specific neighbor in that direction.
fn adaptation_respects_presets(src: NodeId, faces: &[ResolvedFace], preset_state: &PresetState) -> bool {
    for face in faces {
        if face.node_index != 0 {
            continue;
        }
        let Some(neighbor) = face.neighbor else { continue; };
        match face.requirement {
            SplitFaceRequirement::Passage => {
                // A Passage needs both directions free — unlike `can_connect`'s "at least one
                // direction" semantics (used elsewhere for a coin-flip one-way pick), either lock
                // or a one-directional `blocked` pair forbids a bidirectional face entirely.
                let fwd_blocked = preset_state.blocked.contains(&(src, neighbor))
                    || preset_state.locked_out.contains(&src)
                    || preset_state.locked_in.contains(&neighbor);
                let bwd_blocked = preset_state.blocked.contains(&(neighbor, src))
                    || preset_state.locked_out.contains(&neighbor)
                    || preset_state.locked_in.contains(&src);
                if fwd_blocked || bwd_blocked {
                    return false;
                }
            }
            SplitFaceRequirement::OneWay(OneWayDirection::Forward) => {
                if preset_state.locked_out.contains(&src) || preset_state.blocked.contains(&(src, neighbor)) || preset_state.locked_in.contains(&neighbor) {
                    return false;
                }
            }
            SplitFaceRequirement::OneWay(OneWayDirection::Backward) => {
                if preset_state.locked_in.contains(&src) || preset_state.blocked.contains(&(neighbor, src)) || preset_state.locked_out.contains(&neighbor) {
                    return false;
                }
            }
            SplitFaceRequirement::Wall | SplitFaceRequirement::Unspecified => {}
        }
    }
    true
}

/// Applies a chosen, already-validated adaptation: mints `node_count - 1` new nodes (node 0 reuses
/// `src`), adds edges per requirement (`Passage` unconditionally bidirectional, bypassing
/// `one_way_chance`; `OneWay` a single directed edge; `Wall`/`Unspecified` no edge — an
/// unvisited-resolving `Unspecified` face is queued into `reserve` like any undecided free
/// neighbor), marks every connected node visited/frontier'd, then rolls the event's shared
/// teleport connection. Node 0 never runs through `run_ordinary_step_body_for_node` — every one of
/// its connections is already fully decided by the chosen faces.
#[allow(clippy::too_many_arguments)]
fn apply_pattern_adaptation<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    parent: Option<NodeId>,
    node_count: usize,
    faces: &[ResolvedFace],
    pattern_idx: usize,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let nodes = mint_split_nodes(graph, field, ids, src, node_count, debug_state);
    sync_all_nodes(state, &nodes[1..]);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SplitNodesCreated { src, nodes: nodes.clone(), pattern: Some(pattern_idx) });
    }
    maybe_reassign_start(src, &nodes, start, start_reassignment, state, scope.as_deref_mut());

    // Every node this pattern mints is fully resolved by this same event — every one of its faces
    // (Passage/OneWay/Wall/Unspecified) is already decided by the chosen adaptation, unlike an
    // ordinary frontier node whose connections are discovered incrementally. All of them become
    // `visited` right away, before any face is applied below, so a sibling_target face connecting
    // two of this event's own nodes (`dst` resolved from `nodes[sib]`) is never mistaken for an
    // unvisited node by the `Unspecified` branch's reserve check, and `mark_connected` never pushes
    // a sibling into `frontier` (only a genuine outside neighbor may enter `frontier` from here —
    // see this function's own doc comment).
    for &node in &nodes {
        state.visited.insert(node);
    }

    for face in faces {
        let node = nodes[face.node_index];
        let dst = match (face.sibling_target, face.neighbor) {
            (Some(sib), _) => Some(nodes[sib]),
            (None, Some(n)) => Some(n),
            (None, None) => None,
        };

        // `enumerate_adaptations` already validated that a face resolving to `parent` matches the
        // existing `src<->parent` edge's exact direction/kind — apply that match by relocating the
        // real edge (remove old, recreate on `node`) instead of adding a brand-new one, which would
        // either duplicate it (if `node == src`, `add_edge`'s own dedup makes this a no-op) or leave
        // the stale `src<->parent` edge behind entirely (if `node != src`). `dst.is_some()` guards
        // against `parent: None` spuriously matching a Wall/sibling_target face's `dst: None`.
        if dst.is_some() && parent == dst {
            let parent = dst.unwrap();
            // Replace every existing edge endpoint equal to `src` with `node` — `(src, parent)`
            // becomes `(node, parent)`, `(parent, src)` becomes `(parent, node)`, each only if that
            // direction actually existed.
            for (a, b) in [(src, parent), (parent, src)] {
                if let Some(id) = graph.edge_between(a, b) {
                    graph.remove_edge(id);
                    let new_a = if a == src { node } else { a };
                    let new_b = if b == src { node } else { b };
                    graph.add_edge(new_a, new_b, EdgeKind::Basic);
                }
            }
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::SplitParentEdgeRelocated { parent, src, taken_by: node });
            }
            mark_connected(state, parent, node, &nodes, scope.as_deref_mut());
            continue;
        }

        match face.requirement {
            SplitFaceRequirement::Passage => {
                let Some(dst) = dst else { continue; };
                graph.add_bidirectional_edge(node, dst, EdgeKind::Basic);
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::EdgeAdded { src: node, dst, bidirectional: true });
                }
                mark_connected(state, dst, node, &nodes, scope.as_deref_mut());
            }
            SplitFaceRequirement::OneWay(dir) => {
                let Some(dst) = dst else { continue; };
                let (from, to) = match dir {
                    OneWayDirection::Forward => (node, dst),
                    OneWayDirection::Backward => (dst, node),
                };
                graph.add_edge(from, to, EdgeKind::Basic);
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional: false });
                }
                let other = if from == node { dst } else { from };
                mark_connected(state, other, node, &nodes, scope.as_deref_mut());
            }
            SplitFaceRequirement::Wall => {}
            SplitFaceRequirement::Unspecified => {
                if let Some(dst) = dst {
                    if !state.visited.contains(&dst) && !state.in_reserve.contains(&dst) {
                        state.reserve.push(dst);
                        state.in_reserve.insert(dst);
                        if let Some(log) = scope.as_deref_mut() {
                            log.emit(VertexBasedEvent::NodeQueuedToReserve { node: dst });
                        }
                    }
                }
            }
        }
    }

    // Neither `src` nor any sibling ever enters `frontier` directly (GitHub issue #222 follow-up)
    // — the whole point's nodes are fully processed by this one event, so none of them is a
    // pending traversal step the way an ordinary frontier entry is. Only their outside neighbors
    // (already pushed above, by `mark_connected`) continue the traversal from here.
    apply_split_teleport(graph, elements, preset_state, state, &nodes, scope);
}

/// Marks an outside neighbor `dst` reached by one of this split event's nodes as visited and
/// pushes it to `frontier` to continue the traversal — but never for `dst` that is itself one of
/// `split_nodes` (a `sibling_target` face connecting two of this event's own nodes): those are
/// already fully resolved by the event that created them and must never re-enter `frontier` (see
/// `apply_pattern_adaptation`'s own doc comment).
fn mark_connected(state: &mut GenState, dst: NodeId, src: NodeId, split_nodes: &[NodeId], mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>) {
    state.visited.insert(dst);
    state.in_reserve.remove(&dst);
    if !split_nodes.contains(&dst) {
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
    }
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
    }
}

#[cfg(test)]
#[path = "split_generation_test.rs"]
mod tests;
