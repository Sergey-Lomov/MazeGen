#[path = "edge_based_wire.rs"]
mod edge_based_wire;
#[path = "edge_based_event.rs"]
mod edge_based_event;

use std::collections::HashMap;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::NodeId;
use crate::graph::{Graph, EdgeKind};
use crate::space::{MultiLevelField, Tessellation};
use crate::event_log::{EventLog, ScopeGuard};
use super::{EdgeBasedParams, ElementsConfig, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index, add_edge_and_detect_direction};
pub use edge_based_event::{EdgeBasedEvent, debug_value_names};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeState { Unseen, Active, Visited }

struct NodeEntry {
    state:      NodeState,
    parent:     Option<NodeId>,
    tree_depth: u32,
    /// Whether `teleport_chance` has already been rolled for this node while it was `src`. A
    /// node may become `src` multiple times before exhausting its geometric neighbors (each
    /// `active`-lifetime pop is a separate connection opportunity), so without this guard the
    /// same node's effective teleport probability would compound with its degree instead of
    /// applying once per node.
    teleport_rolled: bool,
    /// Whether `cyclicity` has already been rolled for this node while it was `src`, mirroring
    /// `teleport_rolled` — see `CyclicAlreadyRolled` and `roll_cyclic`.
    cyclic_rolled: bool,
}

impl NodeEntry {
    fn unseen() -> Self {
        Self { state: NodeState::Unseen, parent: None, tree_depth: 0, teleport_rolled: false, cyclic_rolled: false }
    }
}

pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    seed: u64,
    start: NodeId,
    params: &EdgeBasedParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    mut event_log: Option<&mut EventLog<EdgeBasedEvent>>,
) {
    let mut rng = MazeRng::seed_from_u64(seed);

    let mut nodes: HashMap<NodeId, NodeEntry> = graph.nodes()
        .map(|n| (n.id, NodeEntry::unseen()))
        .collect();

    let mut active: Vec<NodeId> = Vec::new();
    let mut last_dst: Option<NodeId> = None;

    // preset_connected nodes stay Unseen so they remain visible as connection targets.
    // When an active node connects to one, it is marked Visited but NOT pushed to active.
    let preset_connected = &preset_state.preset_connected;

    // Ensure start is Active.
    if nodes.get(&start).map_or(true, |e| e.state == NodeState::Unseen) {
        nodes.insert(start, NodeEntry { state: NodeState::Active, parent: None, tree_depth: 0, teleport_rolled: false, cyclic_rolled: false });
        active.push(start);
        if let Some(log) = event_log.as_deref_mut() {
            log.emit(EdgeBasedEvent::NodeActivated { node: start, parent: None, tree_depth: 0 });
        }
    }

    loop {
        if active.is_empty() { break; }

        let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));

        let prev_last_dst = last_dst;
        let choice = choose_src(&active, last_dst, &nodes, params, preset_state, field, &mut rng);
        if let Some(g) = step_scope.as_mut() {
            let event = match choice {
                SrcChoice::NoCorridorAttempt { .. } => EdgeBasedEvent::CorridorRollSkipped,
                SrcChoice::CorridorContinued { prev, roll } =>
                    EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: true },
                SrcChoice::CorridorDeadFallthrough { prev, roll, .. } => {
                    g.emit(EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: true });
                    EdgeBasedEvent::CorridorDeadNoUnseen { prev }
                }
                SrcChoice::CorridorFailedFallthrough { prev, roll, .. } =>
                    EdgeBasedEvent::CorridorRolled { prev, roll, corridor_length: params.corridor_length, continued: false },
            };
            g.emit(event);
            match choice {
                SrcChoice::NoCorridorAttempt { src, active_len, position }
                | SrcChoice::CorridorDeadFallthrough { src, active_len, position, .. }
                | SrcChoice::CorridorFailedFallthrough { src, active_len, position, .. } => {
                    g.emit(EdgeBasedEvent::SrcChosenByDepthFirst { src, active_len, position, depth_first: params.depth_first });
                }
                SrcChoice::CorridorContinued { .. } => {}
            }
        }
        let src = choice.src();
        let corridor_fired = prev_last_dst == Some(src);

        // Teleport and cyclic are both rolled right after src is fixed, before any candidate
        // pool is built — the combination of the two decides which pool the normal dst-choice
        // step (below) draws from: teleport only takes over that pool when cyclic did NOT also
        // fire this step (see try_add_cyclic_edge for the "both fired" case, where teleport is
        // spent on the cyclic edge instead).
        let teleport_roll = roll_teleport(src, &mut nodes, elements, &mut rng);
        let teleport_flag = teleport_roll.map(|(_, fired)| fired).unwrap_or(false);
        if let Some(g) = step_scope.as_mut() {
            match teleport_roll {
                Some((roll, fired)) => {
                    g.emit(EdgeBasedEvent::TeleportRolled { src, roll, teleport_chance: elements.teleport_chance, fired });
                }
                None => {
                    g.emit(EdgeBasedEvent::TeleportAlreadyRolled { src });
                }
            }
        }

        let cyclic_roll = roll_cyclic(src, &mut nodes, params, &mut rng);
        let cyclic_flag = cyclic_roll.map(|(_, fired)| fired).unwrap_or(false);
        if let Some(g) = step_scope.as_mut() {
            match cyclic_roll {
                Some((roll, fired)) => {
                    g.emit(EdgeBasedEvent::CyclicRolled { src, roll, cyclicity: params.cyclicity, fired });
                }
                None => {
                    g.emit(EdgeBasedEvent::CyclicAlreadyRolled { src });
                }
            }
        }
        let use_geometric_pool = !teleport_flag || cyclic_flag;

        let candidates = build_candidate_pool(src, use_geometric_pool, &nodes, preset_connected, preset_state, field);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::CandidatePoolBuilt { src, geometric: use_geometric_pool, candidates: candidates.clone() });
        }
        if candidates.is_empty() {
            if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::SrcExhaustedEmptyPool { src });
            }
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            continue;
        }

        try_add_cyclic_edge(graph, field, src, cyclic_flag, teleport_flag, &nodes, elements, preset_state, &mut rng, step_scope.as_mut());

        let directionality_eligible = use_geometric_pool && !corridor_fired;
        let weights = dst_weights(src, &candidates, use_geometric_pool, corridor_fired, &nodes, params, field);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::DstWeightsComputed {
                candidates: candidates.clone(),
                weights: weights.clone(),
                branching: params.branching,
                directionality: params.directionality,
                directionality_eligible,
            });
        }
        let (dst_index, dst_roll, dst_total_weight) = weighted_sample_index(&weights, &mut rng);
        let dst = candidates[dst_index];
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::DstChosen { dst, roll: dst_roll, total_weight: dst_total_weight });
        }

        if use_geometric_pool {
            // Geometric pool only: a `src`-`dst` preset pair (both `preset_connected`, matched by
            // the `preset_connected.contains(&src) && preset_connected.contains(&n)` exception in
            // `build_candidate_pool`) already has its edge built by `build_preset_state` — skip
            // `try_add_edge` (and `last_dst`, so a preset-skipped step can't seed a corridor
            // chain) to avoid duplicating it. Doesn't apply to the teleport pool below: there,
            // `dst` being `preset_connected` says nothing about the specific src-dst pair (it's
            // any Unseen node in the whole graph, not a geometric neighbor of `src`), so no edge
            // exists yet and skipping would silently drop the teleport.
            let dst_is_preset_teleport = preset_state.preset_teleports.get(&src).is_some_and(|dsts| dsts.contains(&dst));
            if !preset_connected.contains(&dst) && !dst_is_preset_teleport {
                let added = add_edge_and_detect_direction(graph, src, dst, |g| try_add_edge(g, src, dst, elements, preset_state, &mut rng));
                if let Some(g) = step_scope.as_mut() {
                    g.emit(match added {
                        Some((from, to, bidirectional)) => EdgeBasedEvent::EdgeAdded { src: from, dst: to, teleport: false, bidirectional },
                        None => EdgeBasedEvent::EdgeRejected { src, dst, teleport: false },
                    });
                }
                last_dst = Some(dst);
            } else if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::PresetSkipped { src, dst });
            }
        } else {
            let added = add_edge_and_detect_direction(graph, src, dst, |g| {
                try_add_edge_kind(g, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut rng)
            });
            if let Some(g) = step_scope.as_mut() {
                g.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::EdgeAdded { src: from, dst: to, teleport: true, bidirectional },
                    None => EdgeBasedEvent::EdgeRejected { src, dst, teleport: true },
                });
            }
            last_dst = Some(dst);
        }

        let depth = nodes.get(&src).map(|e| e.tree_depth + 1).unwrap_or(1);
        nodes.insert(dst, NodeEntry { state: NodeState::Active, parent: Some(src), tree_depth: depth, teleport_rolled: false, cyclic_rolled: false });
        active.push(dst);
        if let Some(g) = step_scope.as_mut() {
            g.emit(EdgeBasedEvent::NodeActivated { node: dst, parent: Some(src), tree_depth: depth });
        }

        if is_src_exhausted(src, &nodes, preset_connected, preset_state, field) {
            remove_from_active(src, &mut active, &mut nodes);
            if last_dst == Some(src) { last_dst = None; }
            if let Some(g) = step_scope.as_mut() {
                g.emit(EdgeBasedEvent::SrcExhausted { src });
            }
        }
    }
}

/// Rolls `teleport_chance` for `src`, guarded to at most once per node (`NodeEntry.teleport_rolled`).
/// A node may become `src` multiple times before exhausting its geometric neighbors (each
/// `active`-lifetime pop is a separate connection opportunity), so without this guard the same
/// node's effective teleport probability would compound with its degree instead of applying once
/// per node.
/// Returns `None` when the roll was skipped (already rolled for this node — see
/// `EdgeBasedEvent::TeleportAlreadyRolled`), or `Some((roll, fired))` when a fresh roll happened,
/// carrying the raw sample alongside the outcome so `EdgeBasedEvent::TeleportRolled` (GitHub
/// issue #144) can narrate the exact draw.
fn roll_teleport(
    src: NodeId,
    nodes: &mut HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    rng: &mut MazeRng,
) -> Option<(f64, bool)> {
    let already_rolled = nodes.get(&src).map_or(false, |e| e.teleport_rolled);
    if already_rolled { return None; }
    let roll = rng.random::<f64>();
    let hit = roll < elements.teleport_chance;
    if let Some(entry) = nodes.get_mut(&src) { entry.teleport_rolled = true; }
    Some((roll, hit))
}

/// Rolls `cyclicity` for `src`, guarded to at most once per node (`NodeEntry.cyclic_rolled`),
/// mirroring `roll_teleport` — a node may become `src` multiple times before exhausting its
/// geometric neighbors, so without this guard the same node's effective cyclic-edge probability
/// would compound with its degree instead of applying once per node.
/// Returns `None` when the roll was skipped (already rolled for this node — see
/// `EdgeBasedEvent::CyclicAlreadyRolled`), or `Some((roll, fired))` when a fresh roll happened.
fn roll_cyclic(
    src: NodeId,
    nodes: &mut HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    rng: &mut MazeRng,
) -> Option<(f64, bool)> {
    let already_rolled = nodes.get(&src).map_or(false, |e| e.cyclic_rolled);
    if already_rolled { return None; }
    let roll = rng.random::<f64>();
    let hit = roll < params.cyclicity;
    if let Some(entry) = nodes.get_mut(&src) { entry.cyclic_rolled = true; }
    Some((roll, hit))
}

/// Whether `n` is a geometric neighbor of `src` that a normal (non-teleport) connection could
/// still reach: Unseen, and either both nodes are preset_connected (a geometrically-adjacent
/// preset pair) or the pair isn't blocked/locked. Shared by `build_candidate_pool`'s geometric
/// branch and `is_src_exhausted`, which is exactly this predicate's negation over all neighbors.
fn is_reachable_unseen_neighbor(
    src: NodeId,
    n: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
) -> bool {
    nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen)
        && (preset_connected.contains(&src) && preset_connected.contains(&n) || can_connect(src, n, preset_state))
}

fn build_candidate_pool<T: Tessellation>(
    src: NodeId,
    use_geometric_pool: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &MultiLevelField<T>,
) -> Vec<NodeId> {
    if use_geometric_pool {
        // Preset-teleport destinations of `src` are traversable extra neighbors (GitHub issue
        // #226) — their edge already exists in the graph regardless of this step's teleport roll,
        // so they join the geometric pool unconditionally (only gated on Unseen, not
        // `can_connect` — that governs adding a *new* edge, which doesn't apply here).
        let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
        let reachable_teleport_dsts = teleport_dsts.iter().copied()
            .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen));
        field.neighbors(src).into_iter()
            .filter(|&n| is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
            .chain(reachable_teleport_dsts)
            .collect()
    } else {
        // Teleport candidate pool: every Unseen node in the graph, not just geometric neighbors
        // of src. No preset_connected exception here — that exception exists only to handle
        // geometrically-adjacent preset pairs, which doesn't apply to teleport.
        sorted_nodes_in_state(nodes, NodeState::Unseen, |n| n != src && can_connect(src, n, preset_state))
    }
}

/// Cyclic roll (already decided by the caller): adds an extra edge to a visited node, independent
/// of the normal dst selection. If teleport also fired this step, the cyclic candidate pool
/// widens from "visited geometric neighbors" to "any visited node in the graph", and the added
/// edge is a Teleport rather than a Basic connection — teleport is considered spent on this
/// cyclic edge in that case (the caller's dst-choice step then always uses the geometric pool).
///
/// Emits `CyclicCandidatesComputed` always (even for an empty pool, so a narration reader sees
/// the attempt was made and why it stopped), and `CyclicEdgeAdded`/`CyclicEdgeRejected` — the
/// latter detected by comparing `graph.edge_between` before/after the attempt, since
/// `try_add_edge`/`try_add_edge_kind` return `()` and silently decline on a preset conflict
/// (GitHub issue #144).
fn try_add_cyclic_edge<T: Tessellation>(
    graph: &mut Graph,
    field: &MultiLevelField<T>,
    src: NodeId,
    cyclic_flag: bool,
    teleport_flag: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    rng: &mut MazeRng,
    mut scope: Option<&mut ScopeGuard<EdgeBasedEvent>>,
) {
    if !cyclic_flag { return; }

    if teleport_flag {
        let visited_nodes = sorted_nodes_in_state(nodes, NodeState::Visited, |n| {
            n != src && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none()
        });
        if let Some(log) = scope.as_deref_mut() {
            log.emit(EdgeBasedEvent::CyclicCandidatesComputed { src, geometric: false, candidates: visited_nodes.clone() });
        }
        if !visited_nodes.is_empty() {
            let cyclic_dst = visited_nodes[rng.random_range(0..visited_nodes.len())];
            // Pool filter above already guarantees neither direction exists yet.
            let added = add_edge_and_detect_direction(graph, src, cyclic_dst, |g| {
                try_add_edge_kind(g, src, cyclic_dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, rng)
            });
            // last_dst not updated: visited node cannot seed a corridor chain
            if let Some(log) = scope.as_deref_mut() {
                log.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: true, bidirectional },
                    None => EdgeBasedEvent::CyclicEdgeRejected { src, dst: cyclic_dst, teleport: true },
                });
            }
        }
    } else {
        let visited_neighbors: Vec<NodeId> = field.neighbors(src).into_iter()
            .filter(|&n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Visited)
                && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(EdgeBasedEvent::CyclicCandidatesComputed { src, geometric: true, candidates: visited_neighbors.clone() });
        }
        if !visited_neighbors.is_empty() {
            let cyclic_dst = visited_neighbors[rng.random_range(0..visited_neighbors.len())];
            // Filter above already guarantees neither direction exists yet.
            let added = add_edge_and_detect_direction(graph, src, cyclic_dst, |g| try_add_edge(g, src, cyclic_dst, elements, preset_state, rng));
            // last_dst not updated: visited node cannot seed a corridor chain
            if let Some(log) = scope.as_deref_mut() {
                log.emit(match added {
                    Some((from, to, bidirectional)) => EdgeBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: false, bidirectional },
                    None => EdgeBasedEvent::CyclicEdgeRejected { src, dst: cyclic_dst, teleport: false },
                });
            }
        }
    }
}

/// dst-choice weight: directionality only makes sense for the geometric pool (it needs
/// `field.is_straight`, which is meaningless for a non-adjacent teleport candidate) — the
/// teleport pool (`!use_geometric_pool`) uses branching alone. The geometric pool itself can still
/// contain a non-adjacent candidate (a preset-teleport destination of `src`, GitHub issue #226) —
/// `field.is_straight` safely returns `false` for it (its `via`/`to` aren't geometrically adjacent,
/// so `Field::face_between` returns `None`), so it simply never gets the directionality bonus,
/// exactly as intended for a teleport jump.
fn dst_weights<T: Tessellation>(
    src: NodeId,
    candidates: &[NodeId],
    use_geometric_pool: bool,
    corridor_fired: bool,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    field: &MultiLevelField<T>,
) -> Vec<f64> {
    candidates.iter().map(|&dst| {
        let free = field.neighbors(dst).iter()
            .filter(|n| nodes.get(n).map_or(false, |e| e.state == NodeState::Unseen))
            .count();
        let mut w = 1.0 + params.branching * (free as f64).sqrt();
        if use_geometric_pool && !corridor_fired {
            if let Some(entry) = nodes.get(&src) {
                if let Some(p) = entry.parent {
                    if field.is_straight(p, src, dst) {
                        w *= 1.0 + params.directionality * 3.0;
                    }
                }
            }
        }
        w
    }).collect()
}

fn is_src_exhausted<T: Tessellation>(
    src: NodeId,
    nodes: &HashMap<NodeId, NodeEntry>,
    preset_connected: &std::collections::BTreeSet<NodeId>,
    preset_state: &PresetState,
    field: &MultiLevelField<T>,
) -> bool {
    let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
    let no_reachable_teleport_dst = teleport_dsts.iter()
        .all(|n| nodes.get(n).map_or(true, |e| e.state != NodeState::Unseen));
    no_reachable_teleport_dst
        && field.neighbors(src).into_iter().all(|n| !is_reachable_unseen_neighbor(src, n, nodes, preset_connected, preset_state))
}

/// How `choose_src` arrived at its result — carries the narration-relevant detail
/// (`EdgeBasedEvent::CorridorRollSkipped`/`CorridorRolled`/`CorridorDeadNoUnseen`/
/// `SrcChosenByDepthFirst`, GitHub issue #144) each caller needs to emit, so `generate` doesn't
/// have to reimplement `choose_src`'s corridor/depth-first branching a second time just to
/// narrate it.
enum SrcChoice {
    /// No `last_dst` yet — no corridor roll was attempted this call.
    NoCorridorAttempt { src: NodeId, active_len: usize, position: usize },
    /// Corridor roll attempted and succeeded (`roll < corridor_length`), and `prev` had a
    /// reachable unseen neighbor — `prev` became `src` directly, no depth-first sampling ran.
    CorridorContinued { prev: NodeId, roll: f64 },
    /// Corridor roll attempted and succeeded, but `prev` had no reachable unseen neighbor left —
    /// fell through to depth-first sampling.
    CorridorDeadFallthrough { prev: NodeId, roll: f64, src: NodeId, active_len: usize, position: usize },
    /// Corridor roll attempted and failed (`roll >= corridor_length`) — fell through to
    /// depth-first sampling.
    CorridorFailedFallthrough { prev: NodeId, roll: f64, src: NodeId, active_len: usize, position: usize },
}

impl SrcChoice {
    fn src(&self) -> NodeId {
        match *self {
            SrcChoice::NoCorridorAttempt { src, .. } => src,
            SrcChoice::CorridorContinued { prev, .. } => prev,
            SrcChoice::CorridorDeadFallthrough { src, .. } => src,
            SrcChoice::CorridorFailedFallthrough { src, .. } => src,
        }
    }
}

fn choose_src<T: Tessellation>(
    active: &[NodeId],
    last_dst: Option<NodeId>,
    nodes: &HashMap<NodeId, NodeEntry>,
    params: &EdgeBasedParams,
    preset_state: &PresetState,
    field: &MultiLevelField<T>,
    rng: &mut MazeRng,
) -> SrcChoice {
    let depth_first_pick = |rng: &mut MazeRng| {
        let position = gaussian_weighted_index(active.len(), params.depth_first, rng);
        (active[position], position)
    };

    // Corridor attempt — continue from last dst (chain: A→B→C→...)
    if let Some(prev) = last_dst {
        let roll = rng.random::<f64>();
        if roll < params.corridor_length {
            let has_unseen = field.neighbors(prev).into_iter()
                .any(|n| nodes.get(&n).map_or(false, |e| e.state == NodeState::Unseen) && can_connect(prev, n, preset_state));
            if has_unseen {
                return SrcChoice::CorridorContinued { prev, roll };
            }
            let (src, position) = depth_first_pick(rng);
            return SrcChoice::CorridorDeadFallthrough { prev, roll, src, active_len: active.len(), position };
        }
        let (src, position) = depth_first_pick(rng);
        return SrcChoice::CorridorFailedFallthrough { prev, roll, src, active_len: active.len(), position };
    }

    // depth_first weighted sampling by position in active (oldest=0.0, newest=1.0)
    let (src, position) = depth_first_pick(rng);
    SrcChoice::NoCorridorAttempt { src, active_len: active.len(), position }
}

/// Returns `(chosen_index, roll, total_weight)` — `roll` is the pre-scaled sample
/// (`rng.random::<f64>() * total_weight`), carried out alongside the index so
/// `EdgeBasedEvent::DstChosen` (GitHub issue #144) can narrate the exact draw without
/// re-deriving it (the RNG sample can't be reproduced after the fact).
fn weighted_sample_index(weights: &[f64], rng: &mut MazeRng) -> (usize, f64, f64) {
    let total: f64 = weights.iter().sum();
    let roll = rng.random::<f64>() * total;
    let mut r = roll;
    for (i, &w) in weights.iter().enumerate() {
        r -= w;
        if r <= 0.0 { return (i, roll, total); }
    }
    (weights.len() - 1, roll, total)
}

/// Collects every node in the given `state` (besides `n != src`-style exclusions folded into
/// `extra_filter`) into a `Vec`, sorted for determinism. `nodes` is a `HashMap`, whose iteration
/// order is randomized per-process — without sorting, the same seed could pick a different node
/// on a different run. Shared by every "scan the whole graph for nodes in state X" pool used by
/// the teleport model (candidate pool, cyclic-partner pool), so the sort is applied exactly once.
fn sorted_nodes_in_state(
    nodes: &HashMap<NodeId, NodeEntry>,
    state: NodeState,
    extra_filter: impl Fn(NodeId) -> bool,
) -> Vec<NodeId> {
    let mut pool: Vec<NodeId> = nodes.iter()
        .filter(|&(&n, e)| e.state == state && extra_filter(n))
        .map(|(&n, _)| n)
        .collect();
    pool.sort_unstable();
    pool
}

fn remove_from_active(node: NodeId, active: &mut Vec<NodeId>, nodes: &mut HashMap<NodeId, NodeEntry>) {
    if let Some(pos) = active.iter().position(|&n| n == node) {
        active.remove(pos); // preserve insertion order for gaussian_weighted_index
    }
    if let Some(entry) = nodes.get_mut(&node) {
        entry.state = NodeState::Visited;
    }
}

#[cfg(test)]
#[path = "edge_based_tests.rs"]
mod tests;
