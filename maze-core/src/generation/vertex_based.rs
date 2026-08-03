#[path = "vertex_based_wire.rs"]
mod vertex_based_wire;
#[path = "vertex_based_event.rs"]
mod vertex_based_event;

use std::collections::HashSet;
use rand::{Rng, SeedableRng};
use crate::random::MazeRng;
use crate::ids::{NodeId, IdGenerator};
use crate::graph::{Graph, EdgeKind};
use crate::space::{Field, Tessellation};
use crate::event_log::{DebugEvent, EventLog, ScopeGuard};
use super::{ElementsConfig, GenerationParams, PresetState, try_add_edge, try_add_edge_kind, can_connect, gaussian_weighted_index};
pub(super) use super::add_edge_and_detect_direction;
use super::split_pattern::SplitGenerationConfig;
use super::split_logic::{try_split_src, SplitOutcome, StartReassignment};
use super::debug_state::DebugGenerationState;
pub use vertex_based_event::{VertexBasedEvent, debug_value_names};

pub(super) struct FrontierEntry {
    node:   NodeId,
    parent: Option<NodeId>,
}

/// Mutable traversal state threaded through one `generate` run — bundled so the per-step helper
/// functions don't each need a 6+ parameter list. `all_nodes` is sorted once at construction for
/// deterministic iteration order (candidate pool for teleport rolls: any node in the graph, not
/// restricted to geometric neighbors).
pub(super) struct GenState {
    pub(super) visited:     HashSet<NodeId>,
    pub(super) in_frontier: HashSet<NodeId>,
    pub(super) frontier:    Vec<FrontierEntry>,
    pub(super) reserve:     Vec<NodeId>,
    pub(super) in_reserve:  HashSet<NodeId>,
    pub(super) rng:         MazeRng,
    pub(super) all_nodes:   Vec<NodeId>,
}

impl GenState {
    pub(super) fn new(graph: &Graph, seed: u64, start: NodeId) -> Self {
        let mut all_nodes: Vec<NodeId> = graph.nodes().map(|n| n.id).collect();
        all_nodes.sort_unstable();
        let mut state = GenState {
            visited:     HashSet::new(),
            in_frontier: HashSet::new(),
            frontier:    Vec::new(),
            reserve:     Vec::new(),
            in_reserve:  HashSet::new(),
            rng:         MazeRng::seed_from_u64(seed),
            all_nodes,
        };
        // preset_connected nodes are NOT added to visited upfront — this keeps them visible
        // as connection targets for free_neighbors. Exception: start itself may be preset_connected
        // (e.g. gen_source inside a preset cluster) — it must enter the frontier regardless.
        state.visited.insert(start);
        add_to_frontier(start, None, &mut state.frontier, &mut state.in_frontier);
        state
    }
}

#[allow(clippy::too_many_arguments)]
pub fn generate<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    seed: u64,
    start: NodeId,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    start_reassignment: &mut Option<StartReassignment>,
    mut event_log: Option<&mut EventLog<VertexBasedEvent>>,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let mut state = GenState::new(graph, seed, start);
    if let Some(log) = event_log.as_deref_mut() {
        log.emit(VertexBasedEvent::StartVisited { node: start });
    }

    loop {
        if state.frontier.is_empty() {
            let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
            let keep_going = handle_empty_frontier(
                graph, field, ids, params, elements, split_config, preset_state, &mut state,
                start, start_reassignment, step_scope.as_mut(), debug_state.as_deref_mut(),
            );
            drop(step_scope);
            if !keep_going {
                break;
            }
            continue;
        }

        let mut step_scope = event_log.as_deref_mut().map(|log| log.enter_numbered("step"));
        step_from_frontier(
            graph, field, ids, params, elements, split_config, preset_state, &mut state,
            start, start_reassignment, step_scope.as_mut(), debug_state.as_deref_mut(),
        );
    }
}

/// Bridges a new node into the maze when the frontier is empty — either via a teleport roll (a
/// hit replaces the step's entire mechanism: bridges via teleport instead of geometric adjacency)
/// or by popping a reachable candidate off `reserve`. Returns `false` when generation is done
/// (nothing left to bring in either way), `true` to keep looping.
#[allow(clippy::too_many_arguments)]
fn handle_empty_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    mut debug_state: Option<&mut DebugGenerationState<T>>,
) -> bool {
    // Teleport roll happens before any reserve lookup — a hit replaces this step's
    // entire mechanism (bridges via a teleport instead of a geometric-adjacency bridge).
    let teleport_roll = state.rng.random::<f64>();
    let teleport_fired = teleport_roll < elements.teleport_chance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::TeleportBridgeRolled { roll: teleport_roll, teleport_chance: elements.teleport_chance, fired: teleport_fired });
    }
    if teleport_fired {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if unvisited.is_empty() {
            // Nothing left to bring in via teleport either — generation is done.
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::ReserveExhausted);
            }
            return false;
        }
        let src = unvisited[state.rng.random_range(0..unvisited.len())];
        let visited_nodes: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| state.visited.contains(n))
            .collect();
        let bridge = visited_nodes[state.rng.random_range(0..visited_nodes.len())];

        let outcome = try_split_src(
            graph, field, ids, params, elements, split_config, preset_state, state,
            src, Some(bridge), None, start, start_reassignment, scope.as_deref_mut(), debug_state.as_deref_mut(),
        );
        if outcome == SplitOutcome::Handled {
            return true;
        }

        let added = add_edge_and_detect_direction(graph, bridge, src, |g| {
            try_add_edge_kind(g, bridge, src, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
        });
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::TeleportBridgeAdded { src: from, dst: to, bidirectional });
            }
        }
        state.visited.insert(src);
        add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
        }
        return true;
    }

    // Pop candidates from reserve until we find one with a visited neighbor.
    // Track seen candidates to avoid infinite cycling over nodes that are
    // not yet reachable (none of their neighbors are visited).
    let mut seen: HashSet<NodeId> = HashSet::new();
    let src = {
        let mut search_scope = scope.as_deref_mut().map(|log| log.enter("reserve_search"));
        let result = loop {
            let Some(candidate) = pop_reserve(&mut state.reserve, &mut state.in_reserve, params, &mut state.rng) else {
                break None;
            };
            if state.visited.contains(&candidate) {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: true });
                }
                continue;
            }
            if seen.contains(&candidate) { break None; }
            seen.insert(candidate);
            let has_visited_neighbor = field.neighbors(candidate)
                .into_iter()
                .any(|n| state.visited.contains(&n) && can_connect(n, candidate, preset_state));
            if has_visited_neighbor {
                if let Some(g) = search_scope.as_mut() {
                    g.emit(VertexBasedEvent::ReserveCandidateChosen { node: candidate });
                }
                break Some(candidate);
            }
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveCandidateRejected { node: candidate, already_visited: false });
            }
            state.reserve.push(candidate);
            state.in_reserve.insert(candidate);
        };
        if result.is_none() {
            if let Some(g) = search_scope.as_mut() {
                g.emit(VertexBasedEvent::ReserveExhausted);
            }
        }
        result
    };
    let Some(src) = src else { return false; };
    let visited_neighbors: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|&n| state.visited.contains(&n) && can_connect(n, src, preset_state))
        .collect();
    let bridge = visited_neighbors[state.rng.random_range(0..visited_neighbors.len())];

    let outcome = try_split_src(
        graph, field, ids, params, elements, split_config, preset_state, state,
        src, Some(bridge), None, start, start_reassignment, scope.as_deref_mut(), debug_state.as_deref_mut(),
    );
    if outcome == SplitOutcome::Handled {
        return true;
    }

    let added = add_edge_and_detect_direction(graph, bridge, src, |g| try_add_edge(g, bridge, src, elements, preset_state, &mut state.rng));
    if let Some((from, to, bidirectional)) = added {
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::BridgeAdded { src: from, dst: to, bidirectional });
        }
    }
    state.visited.insert(src);
    add_to_frontier(src, Some(bridge), &mut state.frontier, &mut state.in_frontier);
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::NodeVisited { node: src, parent: bridge });
    }
    true
}

/// One "pop a frontier node and connect its free neighbors" step — the main-loop body once the
/// frontier is non-empty: teleport roll, cyclic-roll (possibly teleport-widened), corridor/
/// junction connect-choice, then applying every mutation this step decided on in order.
#[allow(clippy::too_many_arguments)]
fn step_from_frontier<T: Tessellation>(
    graph: &mut Graph,
    field: &mut Field<T>,
    ids: &mut IdGenerator,
    params: &GenerationParams,
    elements: &ElementsConfig,
    split_config: &SplitGenerationConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    start: NodeId,
    start_reassignment: &mut Option<StartReassignment>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
    debug_state: Option<&mut DebugGenerationState<T>>,
) {
    let fi = choose_from_frontier(&state.frontier, params, &mut state.rng);
    let src = state.frontier[fi].node;
    let parent = state.frontier[fi].parent;
    let frontier_len = state.frontier.len();
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::SrcChosenFromFrontier { src, frontier_len, position: fi, depth_first: params.depth_first });
    }

    state.frontier.remove(fi);
    state.in_frontier.remove(&src);

    let outcome = try_split_src(
        graph, field, ids, params, elements, split_config, preset_state, state,
        src, None, parent, start, start_reassignment, scope.as_deref_mut(), debug_state,
    );
    if outcome == SplitOutcome::Handled {
        return;
    }

    run_ordinary_step_body_for_node(graph, field, params, elements, preset_state, state, src, parent, true, None, scope);
}

/// The corridor/junction/cyclic/frontier-push body for one node, factored out of
/// `step_from_frontier` so the split paths (GitHub issue #222) can invoke it once per resulting
/// split node instead of once per ordinary frontier pop. `roll_teleport` gates whether this call's
/// own teleport roll/connect-step runs at all — `step_from_frontier`'s own (non-split) call site
/// always passes `true`; the non-pattern split path passes `false` for every per-node call and
/// rolls teleport once for the whole split event instead (see `handle_non_pattern_split`).
pub(super) fn run_ordinary_step_body_for_node<T: Tessellation>(
    graph: &mut Graph,
    field: &Field<T>,
    params: &GenerationParams,
    elements: &ElementsConfig,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    parent: Option<NodeId>,
    roll_teleport: bool,
    allowed_neighbors: Option<&HashSet<NodeId>>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) {
    // Teleport roll happens immediately after src is fixed, before any geometric-neighbor
    // pool is built — a hit affects the cyclic-roll's candidate pool (below) and adds one
    // extra teleport connection alongside whatever the corridor/junction roll produces.
    let teleport_hit = if roll_teleport {
        let teleport_roll = state.rng.random::<f64>();
        let hit = teleport_roll < elements.teleport_chance;
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::TeleportRolled { src, roll: teleport_roll, teleport_chance: elements.teleport_chance, fired: hit });
        }
        hit
    } else {
        false
    };

    // free_regular: unvisited, non-frontier, non-preset neighbors — become frontier/reserve.
    // free_preset: preset-connected neighbors (geometric or teleport) not yet visited — connect to
    // them but skip frontier's own edge-adding step (their edge already exists in the graph).
    let preset_connected = &preset_state.preset_connected;
    let teleport_dsts = preset_state.preset_teleports.get(&src).map(Vec::as_slice).unwrap_or(&[]);
    let all_free: Vec<NodeId> = field.neighbors(src)
        .into_iter()
        .filter(|n| allowed_neighbors.is_none_or(|allowed| allowed.contains(n)))
        .chain(teleport_dsts.iter().copied())
        .filter(|&n| !state.visited.contains(&n) && !state.in_frontier.contains(&n)
            && (preset_connected.contains(&src) && preset_connected.contains(&n) || teleport_dsts.contains(&n) || can_connect(src, n, preset_state)))
        .collect();
    let (free_preset, free_regular): (Vec<NodeId>, Vec<NodeId>) =
        all_free.into_iter().partition(|n| preset_connected.contains(n) || teleport_dsts.contains(n));

    let (cyclic_dst, teleport_spent_on_cycle) =
        roll_cyclic_edge(graph, field, params, preset_state, state, src, teleport_hit, scope.as_deref_mut());
    // Teleport still available for the corridor/junction step below unless the cyclic
    // roll already consumed it (it fired and found a candidate).
    let teleport_for_connect = teleport_hit && !teleport_spent_on_cycle;

    let connected = choose_connect_targets(field, params, state, &free_regular, parent, src, teleport_for_connect, scope.as_deref_mut());

    if let Some(cyclic) = cyclic_dst {
        let added = if teleport_spent_on_cycle {
            add_edge_and_detect_direction(graph, src, cyclic, |g| {
                try_add_edge_kind(g, src, cyclic, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
            })
        } else {
            add_edge_and_detect_direction(graph, src, cyclic, |g| try_add_edge(g, src, cyclic, elements, preset_state, &mut state.rng))
        };
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::CyclicEdgeAdded { src: from, dst: to, teleport: teleport_spent_on_cycle, bidirectional });
            }
        }
    }

    // Preset neighbors: already connected by preset edges, so skip try_add_edge.
    // Just mark visited and push to frontier so the algorithm traverses through them.
    for &dst in &free_preset {
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::PresetNeighborVisited { src, dst });
            log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
        }
    }
    state.reserve.retain(|x| !free_preset.contains(x));

    let connected_set: HashSet<NodeId> = connected.iter().copied().collect();
    for &dst in &connected {
        let added = add_edge_and_detect_direction(graph, src, dst, |g| try_add_edge(g, src, dst, elements, preset_state, &mut state.rng));
        if let Some((from, to, bidirectional)) = added {
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::EdgeAdded { src: from, dst: to, bidirectional });
            }
        }
        state.visited.insert(dst);
        state.in_reserve.remove(&dst);
        add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
        }
    }
    state.reserve.retain(|x| !connected_set.contains(x));

    // Teleport connection: added alongside whatever corridor/junction chose above, to a
    // random unvisited node in the graph (not necessarily a geometric neighbor). Skipped if
    // the teleport roll was already spent on the cyclic edge, or if no unvisited node remains.
    if teleport_for_connect {
        let unvisited: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|n| !state.visited.contains(n))
            .collect();
        if !unvisited.is_empty() {
            let dst = unvisited[state.rng.random_range(0..unvisited.len())];
            let added = add_edge_and_detect_direction(graph, src, dst, |g| {
                try_add_edge_kind(g, src, dst, EdgeKind::Teleport, elements.teleport_one_way_chance, preset_state, &mut state.rng)
            });
            if let Some((from, to, bidirectional)) = added {
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::TeleportConnectAdded { src: from, dst: to, bidirectional });
                }
            }
            state.visited.insert(dst);
            state.in_reserve.remove(&dst);
            add_to_frontier(dst, Some(src), &mut state.frontier, &mut state.in_frontier);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeVisited { node: dst, parent: src });
            }
        }
    }

    for n in free_regular {
        // A node that just became the teleport destination is already `visited` (marked
        // above) by this point, so `!visited.contains(&n)` alone already keeps it out of
        // reserve — it went to the frontier instead, as intended.
        if !connected_set.contains(&n) && !state.in_reserve.contains(&n) && !state.visited.contains(&n) {
            state.reserve.push(n);
            state.in_reserve.insert(n);
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::NodeQueuedToReserve { node: n });
            }
        }
    }
}

/// Cyclic roll: if triggered, picks one visited neighbor and returns it as a cycle-edge target.
/// This happens regardless of free_neighbors availability. If a teleport was rolled for this src,
/// the candidate pool widens from "visited geometric neighbors" to "any visited node in the
/// graph" and the second return value is `true` (the teleport roll is considered "spent" on this
/// cyclic edge in that case, and must not also apply to the corridor/junction step).
fn roll_cyclic_edge<T: Tessellation>(
    graph: &Graph,
    field: &Field<T>,
    params: &GenerationParams,
    preset_state: &PresetState,
    state: &mut GenState,
    src: NodeId,
    teleport_hit: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (Option<NodeId>, bool) {
    let cyclic_roll = state.rng.random::<f64>();
    let cyclic_fired = cyclic_roll < params.cyclicity;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CyclicRolled { src, roll: cyclic_roll, cyclicity: params.cyclicity, fired: cyclic_fired });
    }
    if !cyclic_fired {
        return (None, false);
    }
    if teleport_hit {
        let candidates: Vec<NodeId> = state.all_nodes.iter().copied()
            .filter(|&n| n != src && state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed { src, geometric: false, candidates: candidates.clone() });
        }
        if candidates.is_empty() {
            (None, false)
        } else {
            (Some(candidates[state.rng.random_range(0..candidates.len())]), true)
        }
    } else {
        let visited_neighbors: Vec<NodeId> = field.neighbors(src)
            .into_iter()
            .filter(|&n| state.visited.contains(&n) && can_connect(src, n, preset_state)
                && graph.edge_between(src, n).is_none() && graph.edge_between(n, src).is_none())
            .collect();
        if let Some(log) = scope.as_deref_mut() {
            log.emit(VertexBasedEvent::CyclicCandidatesComputed { src, geometric: true, candidates: visited_neighbors.clone() });
        }
        if visited_neighbors.is_empty() {
            (None, false)
        } else {
            (Some(visited_neighbors[state.rng.random_range(0..visited_neighbors.len())]), false)
        }
    }
}

/// Corridor/junction connect-choice: picks which of `free_regular` to connect `src` to this step.
/// When `teleport_for_connect` is set, `junction_count` is rolled against one extra virtual slot
/// so the teleport doesn't add branching *beyond* what junction already decided for this src —
/// count-1 geometric connections are taken, leaving exactly one slot for the teleport connection
/// `step_from_frontier` adds afterward.
fn choose_connect_targets<T: Tessellation>(
    field: &Field<T>,
    params: &GenerationParams,
    state: &mut GenState,
    free_regular: &[NodeId],
    parent: Option<NodeId>,
    src: NodeId,
    teleport_for_connect: bool,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let corridor_roll = state.rng.random::<f64>();
    let is_corridor = corridor_roll < params.corridor_chance;
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::CorridorRolled { roll: corridor_roll, corridor_chance: params.corridor_chance, is_corridor });
    }

    if is_corridor {
        if free_regular.is_empty() {
            vec![]
        } else {
            let mut ctx = PickContext { parent, src, params, rng: &mut state.rng, field };
            let (dst, used_directionality) = choose_candidate(free_regular, &mut ctx, scope.as_deref_mut());
            if let Some(log) = scope.as_deref_mut() {
                log.emit(VertexBasedEvent::CandidateChosen { src, dst, used_directionality });
            }
            vec![dst]
        }
    } else {
        let max = free_regular.len();
        let virtual_max = if teleport_for_connect { max + 1 } else { max };
        if virtual_max == 0 {
            vec![]
        } else if virtual_max == 1 {
            if max == 0 { vec![] } else { vec![free_regular[0]] }
        } else {
            let count = junction_count(virtual_max, params, &mut state.rng, scope.as_deref_mut());
            let geometric_count = if teleport_for_connect { count.saturating_sub(1) } else { count };
            if geometric_count == 0 {
                vec![]
            } else {
                let mut ctx = PickContext { parent, src, params, rng: &mut state.rng, field };
                let chosen = choose_junction_candidates(free_regular, geometric_count, &mut ctx, scope.as_deref_mut());
                if let Some(log) = scope.as_deref_mut() {
                    log.emit(VertexBasedEvent::JunctionCandidatesChosen { src, candidates: chosen.clone() });
                }
                chosen
            }
        }
    }
}

pub(super) fn add_to_frontier(node: NodeId, parent: Option<NodeId>, frontier: &mut Vec<FrontierEntry>, in_frontier: &mut HashSet<NodeId>) {
    if in_frontier.insert(node) {
        frontier.push(FrontierEntry { node, parent });
    }
}

fn pop_reserve(
    reserve: &mut Vec<NodeId>,
    in_reserve: &mut HashSet<NodeId>,
    params: &GenerationParams,
    rng: &mut MazeRng,
) -> Option<NodeId> {
    if reserve.is_empty() { return None; }
    let idx = gaussian_weighted_index(reserve.len(), params.depth_first, rng);
    let node = reserve.remove(idx);
    in_reserve.remove(&node);
    Some(node)
}

fn choose_from_frontier(frontier: &[FrontierEntry], params: &GenerationParams, rng: &mut MazeRng) -> usize {
    if frontier.len() == 1 { return 0; }
    gaussian_weighted_index(frontier.len(), params.depth_first, rng)
}

/// Rolls how many junction slots beyond the mandatory first two are taken — every roll is nested
/// under its own `"junction_count"` scope (GitHub issue #143's follow-up) so a narration reader
/// sees the whole per-slot roll series (and the caller-computed final count, see
/// `JunctionCandidatesChosen`) grouped under one collapsible header instead of flattened directly
/// into the parent `"step N"` scope alongside every other decision that step makes.
pub(super) fn junction_count(
    max: usize,
    params: &GenerationParams,
    rng: &mut MazeRng,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> usize {
    debug_assert!(max >= 2, "junction_count requires max >= 2, got {max}");
    let mut count = 2;
    let mut inner = scope.map(|s| s.enter("junction_count"));
    if let Some(log) = inner.as_mut() {
        log.emit(VertexBasedEvent::JunctionRollSetup { max });
    }
    for slot in 1..=max.saturating_sub(2) {
        let roll = rng.random::<f64>();
        let taken = roll < params.branching;
        if let Some(log) = inner.as_mut() {
            log.emit(VertexBasedEvent::JunctionSlotRolled { slot, roll, branching: params.branching, taken });
        }
        if taken {
            count += 1;
        }
    }
    count
}

/// Bundles the parameters `choose_candidate`/`choose_junction_candidates` both need but never
/// mutate except through `rng` — mirrors why `GenState` exists (see its own doc comment): keeps
/// either function's own parameter list to just what varies per call (`candidates`/`count`),
/// instead of repeating `parent`/`src`/`params`/`rng`/`field` at every call site.
struct PickContext<'a, T: Tessellation> {
    parent: Option<NodeId>,
    src: NodeId,
    params: &'a GenerationParams,
    rng: &'a mut MazeRng,
    field: &'a Field<T>,
}

/// Returns the chosen candidate and whether the directionality shortcut (continue straight from
/// `parent`) was actually taken, rather than falling back to a uniform pick — narrated by
/// `VertexBasedEvent::CandidateChosen`'s `used_directionality` field (GitHub issue #143).
fn choose_candidate<T: Tessellation>(
    candidates: &[NodeId],
    ctx: &mut PickContext<T>,
    mut scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> (NodeId, bool) {
    if candidates.len() == 1 {
        if ctx.parent.is_some() {
            if let Some(log) = scope {
                log.emit(VertexBasedEvent::SingleCandidateSkipsDirectionality { node: candidates[0] });
            }
        }
        return (candidates[0], false);
    }
    let Some(p) = ctx.parent else {
        if let Some(log) = scope {
            log.emit(VertexBasedEvent::NoParentSkipsDirectionality { node: ctx.src });
        }
        return (candidates[ctx.rng.random_range(0..candidates.len())], false);
    };
    let roll = ctx.rng.random::<f64>();
    let fired = roll < ctx.params.directionality;
    let straight = fired.then(|| candidates.iter().copied().find(|&n| ctx.field.is_straight(p, ctx.src, n))).flatten();
    if let Some(log) = scope.as_deref_mut() {
        log.emit(VertexBasedEvent::DirectionalityRolled { roll, directionality: ctx.params.directionality, fired, straight_found: straight.is_some() });
    }
    if let Some(straight) = straight {
        return (straight, true);
    }
    (candidates[ctx.rng.random_range(0..candidates.len())], false)
}

fn choose_junction_candidates<T: Tessellation>(
    candidates: &[NodeId],
    count: usize,
    ctx: &mut PickContext<T>,
    scope: Option<&mut ScopeGuard<VertexBasedEvent>>,
) -> Vec<NodeId> {
    let mut pool: Vec<NodeId> = candidates.to_vec();
    let mut chosen = Vec::with_capacity(count);

    let (first, _) = choose_candidate(&pool, ctx, scope);
    chosen.push(first);
    pool.retain(|&n| n != first);

    while chosen.len() < count && !pool.is_empty() {
        let idx = ctx.rng.random_range(0..pool.len());
        chosen.push(pool.swap_remove(idx));
    }

    chosen
}

#[cfg(test)]
#[path = "vertex_based_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "vertex_based_teleport_tests.rs"]
mod teleport_tests;

#[cfg(test)]
#[path = "vertex_based_golden_tests.rs"]
mod golden_tests;
